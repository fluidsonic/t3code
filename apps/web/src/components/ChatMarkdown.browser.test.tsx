import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import "../index.css";

import { filesystemEnvironment } from "../state/filesystem";
import { useRightPanelStore } from "../rightPanelStore";
import { setMarkdownTaskChecked } from "./files/filePreviewMode";
import { HostImageUrlContext } from "./chat/hostImageUrl";

const { workspaceSearch, filesystemMetadata } = vi.hoisted(() => ({
  workspaceSearch: vi.fn(),
  filesystemMetadata: vi.fn(),
}));
vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: ((family: unknown) =>
    family === filesystemEnvironment.getMetadata ? filesystemMetadata : workspaceSearch) as never,
}));

// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("../state/session"), async (original) => {
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
const { renderDiagram } = vi.hoisted(() => ({
  renderDiagram: vi.fn<(source: string) => Promise<string> | undefined>(),
}));
// Control rendering latency without running Mermaid layout.
vi.mock(import("./chat/MermaidDiagram"), async (original) => {
  const { use } = await import("react");
  return {
    ...(await original()),
    MermaidDiagram: ({ source }: { source: string }) => {
      const pending = renderDiagram(source);
      return <svg role="img" aria-label={pending ? use(pending) : "Diagram"} />;
    },
  };
});

const settingsOverrides = vi.hoisted(() => ({ mathRenderingEnabled: false }));
vi.mock(import("../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), ...settingsOverrides };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

import ChatMarkdown from "./ChatMarkdown";
import { AudioPreview } from "./files/AudioPreview";

it("keeps compact audio playback loaded across signed URL renewals", async () => {
  const original =
    "data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA";
  const renewed = `${original}#renewed`;
  const preview = (src: string, revision = "clip-v1") => (
    <AudioPreview compact name="clip.wav" src={src} revision={revision} />
  );
  await using screen = await render(preview(original));
  const audio = screen.container.querySelector("audio")!;
  await act(() => {
    audio.dispatchEvent(new Event("loadedmetadata"));
    audio.dispatchEvent(new Event("play"));
  });
  await screen.rerender(preview(renewed));
  expect(screen.container.querySelector("audio")).toBe(audio);
  expect(audio.getAttribute("src")).toBe(original);
  await expect.element(screen.getByRole("button", { name: "Pause clip.wav" })).toBeEnabled();
  await screen.rerender(preview(renewed, "clip-v2"));
  expect(screen.container.querySelector("audio")).not.toBe(audio);
  expect(screen.container.querySelector("audio")?.getAttribute("src")).toBe(renewed);
});

function setup() {
  settingsOverrides.mathRenderingEnabled = false;
  renderDiagram.mockReset();
  workspaceSearch.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
}

function renderText(text: string, props: Partial<Parameters<typeof ChatMarkdown>[0]> = {}) {
  return render(<ChatMarkdown cwd="/tmp/project" text={text} {...props} />);
}

function buttonsLabelled(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.getAttribute("aria-label") === label,
  );
}

it("shows unavailable audio when a workspace embed has no thread", async () => {
  setup();
  await using screen = await renderText("![recording](clip.wav)");
  expect(screen.container.textContent).toContain("Audio unavailable");
  expect(screen.container.textContent).not.toContain("Loading audio");
  expect(screen.container.querySelector("audio")).toBeNull();
});

it("loads a host image through the page's own route when there is no environment", async () => {
  setup();
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const hostImageUrl = vi.fn((_path: string) => pixel);
  await using screen = await render(
    <HostImageUrlContext value={hostImageUrl}>
      <ChatMarkdown cwd={undefined} text="![Shot](</work/my shot.png>)" />
    </HostImageUrlContext>,
  );
  await expect.element(screen.getByAltText("Shot")).toHaveAttribute("src", pixel);
  expect(new Set(hostImageUrl.mock.calls.map(([path]) => path))).toEqual(
    new Set(["/work/my shot.png"]),
  );
});

/** The Run buttons, whether named for the block or, in a block of several, for their command. */
function runButtons(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.textContent === "Run",
  );
}

/** The actions menu triggers, named for the block or for their command. */
function menuButtons(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
    /^More (command actions|actions for )/.test(button.getAttribute("aria-label") ?? ""),
  );
}

describe("ChatMarkdown favicon privacy", () => {
  it("suppresses private link images while preserving public links across updates", async () => {
    setup();
    const markdown = (url: string) => <ChatMarkdown cwd="/tmp/project" text={`[Link](${url})`} />;
    await using screen = await render(markdown("https://example.com"));
    const { container, rerender } = screen;
    expect([...container.querySelectorAll("img")].map((image) => image.src)).toEqual([
      "https://www.google.com/s2/favicons?domain=example.com&sz=32",
    ]);
    for (const url of ["http://192.168.1.10:8080", "http://localhost:3000", "http://home.arpa"]) {
      await rerender(markdown(url));
      expect(container.querySelectorAll("img")).toHaveLength(0);
    }
    await rerender(markdown("https://example.com"));
    expect(container.querySelectorAll("img")).toHaveLength(1);
    await rerender(markdown("https://github.com/pingdotgg/t3code/pull/1"));
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelector("a svg")).not.toBeNull();
  });
});

describe("ChatMarkdown streaming", () => {
  it("runs only a complete single-line shell block after a click", async () => {
    setup();
    const onRunShellCommand = vi.fn();
    const message = (text: string, isStreaming = false) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming={isStreaming}
        codeBlockShellActions={{ runInTerminal: onRunShellCommand }}
      />
    );
    await using screen = await render(message("```bash\necho hello\n```", true));
    const { container, rerender } = screen;
    const runButtons = () => buttonsLabelled(container, "Run in terminal");
    expect(runButtons()).toHaveLength(0);

    await rerender(message("```bash\necho hello\n```"));
    await act(async () => runButtons()[0]!.click());
    expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");
    // Without shell commands the toolbar is the one from before them: the terminal's play button
    // after the wrap toggle, and no command actions, even on a `! cmd` block.
    const toolbarLabels = () =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')].map((button) =>
        button.getAttribute("aria-label"),
      );
    expect(toolbarLabels().slice(1)).toEqual(["Run in terminal", "Copy code"]);
    await rerender(message("```\n! npm test\n```"));
    expect(toolbarLabels().slice(1)).toEqual(["Copy code"]);

    for (const text of [
      "~~~bash\necho tilde\n~~~",
      "> ```bash\n> echo quote\n> ```",
      "````bash\necho four\n````",
      "- Command\n\n  ```bash\n  echo list\n  ```",
      "```bash\r\necho crlf\r\n```\r",
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(1);
    }

    for (const text of [
      "```bash\necho one\necho two\n```",
      "```typescript\necho hello\n```",
      "```bash\n\n```",
      "```bash\necho hello\n\n```",
      "```bash\necho hello\\\n```",
      "```bash\necho safe \u202e#\n```",
      "```bash\necho incomplete",
      "~~~bash\necho incomplete",
      "````bash\necho incomplete\n```",
      '<pre><code class="language-bash">echo html</code></pre>',
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(0);
    }
  });

  it("offers the command actions on untagged `! cmd` blocks and shell blocks only", async () => {
    setup();
    const actions = {
      runCommand: vi.fn(),
      editCommand: vi.fn(),
      runInTerminal: vi.fn(),
      editInTerminal: vi.fn(),
      copyToTerminal: vi.fn(),
      canCopyToTerminal: vi.fn(() => false),
    };
    using copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const message = (text: string, isStreaming = false) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming={isStreaming}
        codeBlockShellActions={actions}
      />
    );
    await using screen = await render(message("```\n! npm test\n", true));
    const { container, rerender } = screen;
    const runCommandButtons = () => runButtons(container);
    expect(runCommandButtons()).toHaveLength(0);

    await rerender(message("```\n! npm test\n```"));
    expect(buttonsLabelled(container, "Run in terminal")).toHaveLength(0);
    await act(async () => runCommandButtons()[0]!.click());
    expect(actions.runCommand).toHaveBeenCalledExactlyOnceWith("npm test");

    const menuAction = async (name: string) => {
      await userEvent.click(menuButtons(container)[0]!);
      await userEvent.click(page.getByRole("menuitem", { name }));
    };
    await menuAction("Edit in the composer");
    expect(actions.editCommand).toHaveBeenCalledExactlyOnceWith("npm test");
    await menuAction("Copy command");
    expect(copy).toHaveBeenCalledExactlyOnceWith("npm test");
    await menuAction("Edit in terminal");
    expect(actions.editInTerminal).toHaveBeenCalledExactlyOnceWith("npm test");
    await menuAction("Run in terminal");
    expect(actions.runInTerminal).toHaveBeenCalledExactlyOnceWith("npm test");
    // Copying to a terminal is offered only while one is on screen when the menu opens.
    await userEvent.click(menuButtons(container)[0]!);
    await expect.element(page.getByRole("menuitem", { name: "Copy command" })).toBeVisible();
    expect(page.getByRole("menuitem", { name: "Copy to active terminal" }).query()).toBeNull();
    await userEvent.keyboard("{Escape}");
    actions.canCopyToTerminal.mockReturnValue(true);
    await menuAction("Copy to active terminal");
    expect(actions.copyToTerminal).toHaveBeenCalledExactlyOnceWith("npm test");

    // A shell block runs as written: its `!` is negation.
    await rerender(message("```bash\n! grep -q x f && echo missing\n```"));
    await act(async () => runCommandButtons()[0]!.click());
    expect(actions.runCommand).toHaveBeenLastCalledWith("! grep -q x f && echo missing");
    await menuAction("Run in terminal");
    expect(actions.runInTerminal).toHaveBeenLastCalledWith("! grep -q x f && echo missing");

    // A multi-line script would run line by line as it reached a terminal's prompt.
    await rerender(message("```sh\ncd web\nnpm run build\n```"));
    await act(async () => runCommandButtons()[0]!.click());
    expect(actions.runCommand).toHaveBeenLastCalledWith("cd web\nnpm run build");
    await userEvent.click(menuButtons(container)[0]!);
    await expect.element(page.getByRole("menuitem", { name: "Copy command" })).toBeVisible();
    expect(page.getByRole("menuitem", { name: "Run in terminal" }).query()).toBeNull();
    await userEvent.keyboard("{Escape}");

    for (const text of [
      "```text\n! npm test\n```",
      "```fish\n! npm test\n```",
      "```powershell\nnpm test\n```",
      "```bash\n$ npm test\nok\n```",
      "```\n! npm test\n> ok\n```",
      "```\nnpm test\n```",
      "```\n!\n```",
      "```\n! echo safe \u202e#\n```",
      "```\n! npm test",
    ]) {
      await rerender(message(text));
      expect(runCommandButtons()).toHaveLength(0);
    }
  });

  it("offers each line of a block of `! cmd` lines as its own command", async () => {
    setup();
    const actions = { runCommand: vi.fn(), runCommands: vi.fn(), editCommand: vi.fn() };
    const text =
      "Clean up:\n\n```\n! cf dns records delete 7da2 -z 7d85\n! cf dns records delete f90f -z e060\n! pnpm redirects-worker:deploy\n```";
    const message = (
      markdown: string,
      shellActions: typeof actions | null = actions,
      isStreaming = false,
    ) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={markdown}
        isStreaming={isStreaming}
        codeBlockShellActions={shellActions ?? undefined}
      />
    );
    await using screen = await render(message(text));
    const { container, rerender } = screen;
    const runCommandButtons = () => runButtons(container);
    expect(runCommandButtons()).toHaveLength(3);
    for (const button of runCommandButtons()) await act(async () => button.click());
    expect(actions.runCommand.mock.calls).toEqual([
      ["cf dns records delete 7da2 -z 7d85"],
      ["cf dns records delete f90f -z e060"],
      ["pnpm redirects-worker:deploy"],
    ]);
    await userEvent.click(menuButtons(container)[2]!);
    await userEvent.click(page.getByRole("menuitem", { name: "Edit in the composer" }));
    expect(actions.editCommand).toHaveBeenCalledExactlyOnceWith("pnpm redirects-worker:deploy");
    // Still one block, which copies as written and runs all of them in order.
    expect(buttonsLabelled(container, "Copy code")).toHaveLength(1);
    await act(async () => buttonsLabelled(container, "Run all")[0]!.click());
    expect(actions.runCommands).toHaveBeenCalledExactlyOnceWith([
      "cf dns records delete 7da2 -z 7d85",
      "cf dns records delete f90f -z e060",
      "pnpm redirects-worker:deploy",
    ]);

    // A `!` script whose later lines go on without one is one command.
    await rerender(message("```\n! cd web\nnpm run build\n```"));
    expect(runCommandButtons()).toHaveLength(1);
    expect(buttonsLabelled(container, "Run all")).toHaveLength(0);
    // Without shell commands, or while streaming, the block stays whole.
    for (const element of [message(text, null), message(text, actions, true)]) {
      await rerender(element);
      expect(runCommandButtons()).toHaveLength(0);
      expect(buttonsLabelled(container, "Copy code")).toHaveLength(1);
    }
  });

  it("runs an inline `! cmd` in prose from its own buttons", async () => {
    setup();
    const actions = { runCommand: vi.fn(), editCommand: vi.fn() };
    const text = "Then run `! git -C /repo push origin\n  a:production` once staging is green.";
    const message = (
      markdown: string,
      shellActions: typeof actions | null = actions,
      isStreaming = false,
    ) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={markdown}
        isStreaming={isStreaming}
        codeBlockShellActions={shellActions ?? undefined}
      />
    );
    await using screen = await render(message(text));
    const { container, rerender } = screen;
    const inlineRunButtons = () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
        button.getAttribute("aria-label")?.startsWith("Run "),
      );
    await act(async () => inlineRunButtons()[0]!.click());
    expect(actions.runCommand).toHaveBeenCalledExactlyOnceWith(
      "git -C /repo push origin a:production",
    );
    await userEvent.click(menuButtons(container)[0]!);
    await userEvent.click(page.getByRole("menuitem", { name: "Edit in the composer" }));
    expect(actions.editCommand).toHaveBeenCalledExactlyOnceWith(
      "git -C /repo push origin a:production",
    );

    // Without shell commands, or while streaming, it stays inline code.
    for (const element of [message(text, null), message(text, actions, true)]) {
      await rerender(element);
      expect(inlineRunButtons()).toHaveLength(0);
      expect(container.querySelector("p code")?.textContent).toMatch(/^! git -C \/repo push/);
    }
    // Code that only starts with `!`, and a command that is a link's text, stay as written.
    for (const markdown of ["`!isReady`", "`!=`", "[`! npm test`](https://example.com)"]) {
      await rerender(message(markdown));
      expect(inlineRunButtons()).toHaveLength(0);
    }
  });

  it("edits the current task text and marker after reusing a renderer", async () => {
    setup();
    let editedText: string | undefined;
    let rerender: (next: ReactElement) => Promise<void> = async () => {};
    const message = (text: string): ReactElement => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        onTaskListChange={({ markerOffset, checked }) => {
          editedText = setMarkdownTaskChecked(text, markerOffset, checked);
          void rerender(message(editedText));
        }}
      />
    );
    await using rendered = await render(message("- [ ] First\n- [ ] Second"));
    rerender = rendered.rerender;
    const { container } = rendered;
    const checkboxes = () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const original = checkboxes()[1]!;
    await rerender(message("- [ ] A longer first task\n- [ ] Second"));
    expect(checkboxes()[1]).toBe(original);

    await act(async () => original.click());
    expect(editedText).toBe("- [ ] A longer first task\n- [x] Second");
    await vi.waitFor(() => expect(checkboxes()[1]!.checked).toBe(true));
  });
});

describe("ChatMarkdown workspace file opens", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("workspace"),
    threadId: ThreadId.make("thread"),
  };

  it("keeps a newer absolute file open when an earlier repo-relative lookup finishes", async () => {
    setup();
    const result = AsyncResult.success({
      entries: [{ path: "notes/a.md", kind: "file" }],
      truncated: false,
    });
    let resolvePending!: (value: typeof result) => void;
    const pending = new Promise<typeof result>((resolve) => {
      resolvePending = resolve;
    });
    workspaceSearch.mockReturnValueOnce(pending);
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    await using screen = await renderText(
      "[Notes](physics/notes/a.md) and [Other](/elsewhere/b.md:9)",
      {
        cwd: "/school/physics",
        threadRef,
      },
    );
    const { container } = screen;
    const [notes, other] = container.querySelectorAll("a");
    await act(async () => notes!.click());
    expect(workspaceSearch).toHaveBeenCalledOnce();
    expect(openFile).not.toHaveBeenCalled();

    await act(async () => other!.click());
    await act(async () => resolvePending(result));

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/elsewhere/b.md", 9);
    expect(workspaceSearch).toHaveBeenCalledOnce();
  });
});

describe("ChatMarkdown skill chips", () => {
  it("shows the skill's details and opens its instructions", async () => {
    setup();
    const threadRef = {
      environmentId: EnvironmentId.make("workspace"),
      threadId: ThreadId.make("thread"),
    };
    await using screen = await renderText("Run $review now", {
      threadRef,
      skills: [
        {
          name: "review",
          displayName: "Review",
          description: "Reviews the current branch.",
          path: "/skills/review/SKILL.md",
          enabled: true,
        },
      ],
    });
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});

    await userEvent.click(screen.getByRole("button", { name: "Skill Review. Show details" }));
    await expect.element(page.getByText("Reviews the current branch.")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "View instructions" }));

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/skills/review/SKILL.md");
  });
});

describe("ChatMarkdown headings", () => {
  it("never gives two headings the same id, even when a suffix matches another heading", async () => {
    setup();
    await using screen = await renderText(
      '## Setup\n\n## Setup\n\n## Setup-1\n\n<h2 id="install-1">Pinned</h2>\n\n## Install\n\n## Install',
      { parseRawHtml: true },
    );
    const { container } = screen;
    expect([...container.querySelectorAll("h2")].map((heading) => heading.id)).toEqual([
      "user-content-setup",
      "user-content-setup-1",
      "user-content-setup-1-1",
      "user-content-install-1",
      "user-content-install",
      "user-content-install-2",
    ]);
  });
});

describe("ChatMarkdown inline code selection", () => {
  it("selects the whole inline code span on double-click, but only a word in fenced code", async () => {
    setup();
    await using screen = await renderText(
      "Run `migration-gate --dry-run` first.\n\n```txt\nfenced-block word\n```",
    );
    await userEvent.dblClick(screen.getByText("migration-gate --dry-run"));
    expect(window.getSelection()?.toString()).toBe("migration-gate --dry-run");

    window.getSelection()?.removeAllRanges();
    const fenced = screen.container.querySelector("pre code")!;
    await userEvent.dblClick(fenced, { position: { x: 4, y: 4 } });
    expect(window.getSelection()?.toString()).toBe("fenced");
  });
});

describe("ChatMarkdown Windows file links", () => {
  const environmentId = EnvironmentId.make("env-windows");
  const renderWindows = (text: string, parseRawHtml: boolean) =>
    renderText(text, {
      cwd: "C:/Users/shawn/project",
      environmentId,
      lineBreaks: !parseRawHtml,
      parseRawHtml,
    });
  const fileHrefs = (container: HTMLElement) =>
    [...container.querySelectorAll(".chat-markdown-file-link")].map((chip) =>
      chip.getAttribute("href"),
    );

  it("still rejects unsafe schemes", async () => {
    setup();
    for (const parseRawHtml of [true, false]) {
      await using screen = await renderWindows(
        "[unsafe](javascript:alert(1)) and [unknown](d:alert(1))",
        parseRawHtml,
      );
      const { container } = screen;
      expect(container.innerHTML).not.toContain("javascript:");
      expect(container.innerHTML).not.toContain("d:alert");
      expect(fileHrefs(container)).toEqual([]);
    }
  });
});
