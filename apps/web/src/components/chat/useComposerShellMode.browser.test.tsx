import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { composerDraftIsShellCommand } from "@t3tools/client-runtime/user-shell-command";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useComposerDraftStore, useComposerThreadDraft } from "../../composerDraftStore";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { isMacPlatform } from "../../lib/utils";
import { shellCommandsUnavailableReason, useComposerShellMode } from "./useComposerShellMode";
import "../../index.css";

const MOD = isMacPlatform(navigator.platform) ? "Meta" : "Control";
const UNDO = `{${MOD}>}z{/${MOD}}`;
const REDO = `{${MOD}>}{Shift>}z{/Shift}{/${MOD}}`;

/** The composer's editor, draft and shell mode, wired as the chat composer wires them. */
function ShellComposer(props: {
  readonly target: ScopedThreadRef;
  readonly unavailableReason: string | null;
  readonly onTrigger: (suppressed: boolean) => void;
}) {
  const promptRef = useRef("");
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const prompt = useComposerThreadDraft(props.target).prompt;
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const [cursor, setCursor] = useState(0);
  const shellMode = useComposerShellMode({
    composerDraftTarget: props.target,
    unavailableReason: props.unavailableReason,
    answeringQuestion: false,
    editingQueuedShellCommand: null,
    promptRef,
    editorRef,
  });
  return (
    <>
      <ComposerPromptEditor
        editorRef={editorRef}
        ariaLabel="Message"
        value={prompt}
        cursor={cursor}
        richTextEnabled
        literalText={shellMode.isShellMode}
        shellFeatureActive={shellMode.active}
        shellCommand={shellMode.isShellMode}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder={shellMode.isShellMode ? "Run in shell…" : "Ask anything"}
        onChange={(value, nextCursor, _expandedCursor, suppressTrigger, _contextIds, restored) => {
          promptRef.current = value;
          if (shellMode.active) {
            setPrompt(props.target, value, {
              ...(restored === undefined ? {} : { shellMode: restored }),
              shellCommandsAvailable: shellMode.canEnterShellMode,
            });
          } else {
            setPrompt(props.target, value);
          }
          setCursor(nextCursor);
          props.onTrigger(suppressTrigger);
        }}
        onCommandKeyDown={(key, event) => shellMode.leaveOnBackspace(key, event)}
        onPaste={() => {}}
      />
      {shellMode.sendBlockedReason === null ? null : <p>{shellMode.sendBlockedReason}</p>}
    </>
  );
}

async function mountComposer(
  name: string,
  options?: {
    readonly canRunShellCommands: boolean;
    readonly canOperateTerminal?: boolean;
    readonly shellDraft?: string;
  },
) {
  const target = scopeThreadRef(EnvironmentId.make("environment-shell"), ThreadId.make(name));
  if (options?.shellDraft !== undefined) {
    useComposerDraftStore.getState().setPrompt(target, options.shellDraft, { shellMode: true });
  }
  const onTrigger = vi.fn<(suppressed: boolean) => void>();
  const screen = await render(
    <ShellComposer
      target={target}
      unavailableReason={
        options?.canRunShellCommands === false
          ? // Without `canOperateTerminal: false`, the setting is what's off.
            shellCommandsUnavailableReason({
              enabled: options.canOperateTerminal === false,
              canOperateTerminal: options.canOperateTerminal ?? true,
            })
          : null
      }
      onTrigger={onTrigger}
    />,
  );
  const draft = () => useComposerDraftStore.getState().getComposerDraft(target);
  return Object.assign(screen, {
    onTrigger,
    prompt: () => draft()?.prompt ?? "",
    isShellCommand: () => composerDraftIsShellCommand(draft() ?? { prompt: "" }),
    editor: () => screen.getByRole("textbox", { name: "Message" }),
  });
}

it("enters shell mode on a leading `!` and keeps the command literal", async () => {
  await using composer = await mountComposer("shell-enter");
  await userEvent.click(composer.editor());
  await userEvent.keyboard("!");
  expect(composer.isShellCommand()).toBe(true);
  await expect.element(composer.getByText("Run in shell…", { exact: false })).toBeVisible();

  // Rich text would make `_build_` italic and `/` would open the command menu. The space after
  // the `!` is drawn, not stored.
  await userEvent.keyboard(" cd /tmp && echo _build_");
  expect(composer.prompt()).toBe("!cd /tmp && echo _build_");
  expect(composer.isShellCommand()).toBe(true);
  expect(composer.onTrigger).toHaveBeenLastCalledWith(true);
  expect(composer.container.querySelector("em")).toBeNull();
});

it("keeps `!` as prose, space and all, where shell commands are unavailable", async () => {
  await using composer = await mountComposer("shell-unavailable", { canRunShellCommands: false });
  await userEvent.click(composer.editor());
  await userEvent.keyboard("! urgent");
  expect(composer.prompt()).toBe("! urgent");
  expect(composer.isShellCommand()).toBe(false);
  await expect.element(composer.editor()).toHaveTextContent("! urgent");
  expect(composer.container.querySelector(".shell-command-text")).toBeNull();
});

it("runs the editor from before shell commands while they are off", async () => {
  await using composer = await mountComposer("shell-off-editor", { canRunShellCommands: false });
  await userEvent.click(composer.editor());
  // Markdown and menus work on a leading `!` as on any other text.
  await userEvent.keyboard("!  *note* /");
  expect(composer.prompt()).toBe("!  *note* /");
  expect(composer.isShellCommand()).toBe(false);
  expect(composer.container.querySelector("em")).not.toBeNull();
  expect(composer.onTrigger).toHaveBeenLastCalledWith(false);
  expect(composer.container.querySelector(".shell-command-prefix")).toBeNull();
});

it("keeps a drafted command a command, but unsendable, once shell commands are off", async () => {
  await using composer = await mountComposer("shell-turned-off", {
    canRunShellCommands: false,
    shellDraft: "!",
  });
  const note = composer.getByText("Shell commands are off for this environment.");
  await expect.element(note).toBeVisible();
  await userEvent.click(composer.editor());
  await userEvent.keyboard("ls");
  expect(composer.prompt()).toBe("!ls");
  expect(composer.isShellCommand()).toBe(true);
  await expect.element(note).toBeVisible();

  // Backspace on the lone `!` makes it an ordinary message, which can be sent.
  await userEvent.keyboard("{Backspace}{Backspace}{Backspace}");
  expect(composer.prompt()).toBe("!");
  expect(composer.isShellCommand()).toBe(false);
  await expect.element(note).not.toBeInTheDocument();
});

it("says the connection can't run commands when shell commands are on but terminal access is missing", async () => {
  await using composer = await mountComposer("shell-no-terminal", {
    canRunShellCommands: false,
    canOperateTerminal: false,
    shellDraft: "!ls",
  });
  await expect
    .element(composer.getByText("This connection can't run shell commands."))
    .toBeVisible();
  await expect
    .element(composer.getByText("Shell commands are off for this environment."))
    .not.toBeInTheDocument();
});

it("leaves shell mode on Backspace after the `!` and keeps it as prose", async () => {
  await using composer = await mountComposer("shell-leave");
  await userEvent.click(composer.editor());
  await userEvent.keyboard("!");
  expect(composer.isShellCommand()).toBe(true);

  await userEvent.keyboard("{Backspace}");
  expect(composer.prompt()).toBe("!");
  expect(composer.isShellCommand()).toBe(false);

  // Typing on after the kept `!` stays prose, and the mode flip kept focus and caret.
  await userEvent.keyboard("important");
  expect(composer.prompt()).toBe("!important");
  expect(composer.isShellCommand()).toBe(false);
  await userEvent.keyboard("{Backspace>10/}");
  expect(composer.prompt()).toBe("");
});

it("keeps a `!` typed in front of prose as prose", async () => {
  await using composer = await mountComposer("shell-prose");
  await userEvent.click(composer.editor());
  await userEvent.keyboard("echo hi{Home}!");
  expect(composer.prompt()).toBe("!echo hi");
  expect(composer.isShellCommand()).toBe(false);
  expect(composer.container.querySelector(".shell-command-prefix")).toBeNull();
});

it("undoes and redoes entering shell mode", async () => {
  await using composer = await mountComposer("shell-undo-enter");
  await userEvent.click(composer.editor());
  await userEvent.keyboard("!");
  expect(composer.isShellCommand()).toBe(true);

  await userEvent.keyboard(UNDO);
  expect(composer.prompt()).toBe("");
  expect(composer.isShellCommand()).toBe(false);

  await userEvent.keyboard(REDO);
  expect(composer.prompt()).toBe("!");
  expect(composer.isShellCommand()).toBe(true);
});

it("keeps the same editor and its history across the switch", async () => {
  await using composer = await mountComposer("shell-undo-history");
  await userEvent.click(composer.editor());
  await userEvent.keyboard("abc{Backspace>3/}");
  const element = composer.editor().element();
  await userEvent.keyboard("!");
  expect(composer.isShellCommand()).toBe(true);
  expect(composer.editor().element()).toBe(element);

  await userEvent.keyboard(UNDO);
  expect(composer.prompt()).toBe("");
  expect(composer.isShellCommand()).toBe(false);
  await userEvent.keyboard(UNDO);
  expect(composer.prompt()).toBe("abc");
  expect(composer.editor().element()).toBe(element);
});

it("undoes leaving shell mode with Backspace", async () => {
  await using composer = await mountComposer("shell-undo-leave");
  await userEvent.click(composer.editor());
  await userEvent.keyboard("!{Backspace}");
  expect(composer.prompt()).toBe("!");
  expect(composer.isShellCommand()).toBe(false);

  await userEvent.keyboard(UNDO);
  expect(composer.prompt()).toBe("!");
  expect(composer.isShellCommand()).toBe(true);
  await expect.element(composer.getByText("Run in shell…", { exact: false })).toBeVisible();

  await userEvent.keyboard(REDO);
  expect(composer.prompt()).toBe("!");
  expect(composer.isShellCommand()).toBe(false);
});

it("brings earlier formatting back on undoing out of shell mode", async () => {
  await using composer = await mountComposer("shell-undo-rich");
  await userEvent.click(composer.editor());
  await userEvent.keyboard("a **b**");
  expect(composer.prompt()).toBe("a **b**");
  expect(composer.container.querySelector("strong")).not.toBeNull();

  await userEvent.keyboard(`{${MOD}>}a{/${MOD}}{Backspace}!`);
  expect(composer.isShellCommand()).toBe(true);
  expect(composer.prompt()).toBe("!");

  await userEvent.keyboard(UNDO);
  expect(composer.prompt()).toBe("");
  expect(composer.isShellCommand()).toBe(false);
  await userEvent.keyboard(UNDO);
  expect(composer.prompt()).toBe("a **b**");
  expect(composer.container.querySelector("strong")).not.toBeNull();
});

it("keeps Markdown-looking command text byte for byte", async () => {
  await using composer = await mountComposer("shell-literal");
  await userEvent.click(composer.editor());
  await userEvent.keyboard("!echo _build_ && cd /tmp # **done** `x`");
  expect(composer.prompt()).toBe("!echo _build_ && cd /tmp # **done** `x`");
  expect(composer.container.querySelector("strong, em, code")).toBeNull();
});
