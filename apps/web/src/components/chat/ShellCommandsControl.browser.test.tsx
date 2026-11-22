import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { composerDraftIsShellCommand } from "@t3tools/client-runtime/user-shell-command";
import {
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  stops: [] as Array<unknown>,
  /** Thread interrupts the composer's Stop fell back to. */
  interrupts: 0,
  /** Settles the stops; a test holds it to act while one is in flight. */
  stopSettled: Promise.resolve(),
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useQuietThreadProjection: (() => state.projection) as never,
}));

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => async (input: unknown) => {
    state.stops.push(input);
    await state.stopSettled;
    return { _tag: "Success" };
  }) as never,
}));

vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: (() => true) as never,
}));

import { render } from "../../../test/render";
import {
  type ComposerThreadTarget,
  composerTargetKey,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import type { ChatMessage } from "../../types";
import { useQuietThreadProjection } from "../../state/entities";
import {
  ShellCommandsAnnouncer,
  ShellCommandsControl,
  shellCommandRows,
} from "./ShellCommandsControl";
import { useStoppedShellCommands } from "./useStoppedShellCommands";

const environmentId = EnvironmentId.make("environment:shell-panel");
const runId = RunId.make("run:shell-panel");
const now = DateTime.makeUnsafe("2026-10-24T10:00:00.000Z");

function command(
  id: string,
  input: string,
  status: "pending" | "running",
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(`turn-item:user-shell:${id}`),
    threadId: ThreadId.make("thread:shell-panel"),
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: id === "first" ? 1 : 2,
    status,
    title: null,
    startedAt: status === "running" ? now : null,
    completedAt: null,
    updatedAt: now,
    type: "command_execution",
    input,
    userShellMessageId: MessageId.make(`message:${id}`),
  };
}

function setup(threadId: ThreadId) {
  state.stops = [];
  state.interrupts = 0;
  state.stopSettled = Promise.resolve();
  state.projection = {
    projection: {
      thread: { hasShellCommands: true },
      turnItems: [
        command("first", "npm test", "running"),
        command("second", "npm run lint", "pending"),
      ],
      runs: [{ id: runId, status: "running" }],
      messages: [],
    },
  };
  return scopeThreadRef(environmentId, threadId);
}

/** The panel, with a stopped command returned the way ChatView returns it. */
function Harness(props: {
  readonly threadId: ThreadId;
  /** The thread whose composer the view shows; ChatView keeps one instance across threads. */
  readonly composerThreadId?: ThreadId;
  readonly optimisticMessages?: ReadonlyArray<ChatMessage>;
}) {
  const target = scopeThreadRef(environmentId, props.composerThreadId ?? props.threadId);
  const draft = useComposerThreadDraft(target);
  const stopped = useStoppedShellCommands({
    environmentId,
    composerDraftTarget: target,
    composerAvailable: true,
    canStopCommands: true,
    placeInComposer: (stoppedFrom: ComposerThreadTarget, text) => {
      if (composerTargetKey(stoppedFrom) !== composerTargetKey(target)) return false;
      useComposerDraftStore.getState().setPrompt(target, `!${text}`, { shellMode: true });
      return true;
    },
  });
  const returnStoppedCommand = useStableCallback(stopped.returnStoppedCommand);
  const rows = shellCommandRows(
    useQuietThreadProjection(scopeThreadRef(environmentId, props.threadId))?.projection ?? null,
    props.optimisticMessages ?? [],
  );
  return (
    <>
      <ShellCommandsAnnouncer commands={rows.commands} />
      <ShellCommandsControl
        environmentId={environmentId}
        rows={rows}
        composerDraftTarget={target}
        onStoppedRunningCommand={returnStoppedCommand}
      />
      <button
        type="button"
        onClick={() => {
          const projection = (state.projection as { projection: never } | null)?.projection;
          if (!stopped.stopCommandsInsteadOfThread(projection ?? null)) state.interrupts += 1;
        }}
      >
        Stop
      </button>
      <output aria-label="Composer">{draft.prompt}</output>
      <ul aria-label="Prompt history">
        {stopped.withStoppedCommands([]).map((message) => (
          <li key={message.id}>{message.text}</li>
        ))}
      </ul>
    </>
  );
}

it("shows commands until delivered, with their status and Stop", async () => {
  const threadId = ThreadId.make("thread:shell-panel-status");
  setup(threadId);
  using _now = vi.spyOn(Date, "now").mockReturnValue(DateTime.toEpochMillis(now) + 12_000);
  await using screen = await render(<Harness threadId={threadId} />);

  const rows = screen.getByRole("listitem");
  await expect.element(rows.nth(0)).toHaveTextContent("! npm testRunning for 12s");
  await expect.element(rows.nth(1)).toHaveTextContent("! npm run lintWaiting…");
  await expect
    .element(page.getByRole("button", { name: "Stop command", exact: true }).nth(1))
    .toBeVisible();
});

it("returns a stopped running command to an empty composer in shell mode", async () => {
  const threadId = ThreadId.make("thread:shell-panel-empty");
  const target = setup(threadId);
  await using screen = await render(<Harness threadId={threadId} />);

  await page.getByRole("button", { name: "Stop command", exact: true }).first().click();
  await expect.element(screen.getByLabelText("Composer")).toHaveTextContent("!npm test");
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  expect(draft === null ? false : composerDraftIsShellCommand(draft)).toBe(true);
  expect(state.stops).toEqual([
    {
      environmentId,
      input: {
        threadId: ThreadId.make("thread:shell-panel"),
        turnItemId: command("first", "", "running").id,
      },
    },
  ]);
});

it("keeps a draft and puts a stopped command into the prompt history", async () => {
  const threadId = ThreadId.make("thread:shell-panel-draft");
  const target = setup(threadId);
  useComposerDraftStore.getState().setPrompt(target, "half-written thought");
  await using screen = await render(<Harness threadId={threadId} />);

  await page.getByRole("button", { name: "Stop command", exact: true }).first().click();
  await expect.element(screen.getByLabelText("Prompt history")).toHaveTextContent("! npm test");
  await expect.element(screen.getByLabelText("Composer")).toHaveTextContent("half-written thought");
});

it("removes a waiting command without returning it, like a cancelled queued message", async () => {
  const threadId = ThreadId.make("thread:shell-panel-waiting");
  setup(threadId);
  await using screen = await render(<Harness threadId={threadId} />);

  await page.getByRole("button", { name: "Stop command", exact: true }).nth(1).click();
  await vi.waitFor(() => expect(state.stops).toHaveLength(1));
  await expect.element(screen.getByLabelText("Composer")).toHaveTextContent("");
  await expect.element(screen.getByLabelText("Prompt history")).toHaveTextContent("");
});

it("composer Stop with only commands running stops them like their own Stop, not the thread", async () => {
  const threadId = ThreadId.make("thread:shell-panel-composer-stop");
  setup(threadId);
  state.projection = {
    projection: {
      thread: { hasShellCommands: true },
      turnItems: [
        command("first", "npm test", "running"),
        command("second", "npm run lint", "pending"),
      ],
      runs: [{ id: runId, status: "starting" }],
      messages: [],
    },
  };
  await using screen = await render(<Harness threadId={threadId} />);

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.element(screen.getByLabelText("Composer")).toHaveTextContent("!npm test");
  expect(state.interrupts).toBe(0);
  const stoppedIds = state.stops.map(
    (stop) => (stop as { input: { turnItemId: TurnItemId } }).input.turnItemId,
  );
  // The waiting one is removed first, so stopping the running one starts nothing.
  expect(stoppedIds).toEqual([
    command("second", "", "pending").id,
    command("first", "", "running").id,
  ]);
  await expect.element(screen.getByLabelText("Prompt history")).toHaveTextContent("");
});

it("composer Stop interrupts the thread while the agent's turn runs", async () => {
  const threadId = ThreadId.make("thread:shell-panel-agent-stop");
  setup(threadId);
  await using screen = await render(<Harness threadId={threadId} />);

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  expect(state.interrupts).toBe(1);
  expect(state.stops).toEqual([]);
  await expect.element(screen.getByLabelText("Composer")).toHaveTextContent("");
});

it("shows a new thread's first command waiting while its workspace is prepared", async () => {
  const threadId = ThreadId.make("thread:shell-panel-preparing");
  setup(threadId);
  const messageId = MessageId.make("message:first-in-thread");
  state.projection = {
    projection: {
      thread: { hasShellCommands: true },
      turnItems: [],
      runs: [{ id: runId, status: "preparing", userMessageId: messageId, requestedAt: now }],
      messages: [{ id: messageId, threadId, text: "! npm install", shellCommand: true }],
    },
  };
  await using screen = await render(<Harness threadId={threadId} />);

  await expect.element(screen.getByRole("listitem")).toHaveTextContent("! npm installWaiting…");
  // It has no item to stop yet; stopping the thread ends the preparation instead.
  await expect
    .element(page.getByRole("button", { name: "Stop command", exact: true }))
    .not.toBeInTheDocument();
});

it("returns a command stopped before switching threads to its own thread, not the one shown", async () => {
  const threadId = ThreadId.make("thread:shell-panel-switch");
  const otherThreadId = ThreadId.make("thread:shell-panel-switch-other");
  setup(threadId);
  let settle = () => {};
  state.stopSettled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  await using screen = await render(<Harness threadId={threadId} />);

  await page.getByRole("button", { name: "Stop command", exact: true }).first().click();
  await vi.waitFor(() => expect(state.stops).toHaveLength(1));
  await screen.rerender(<Harness threadId={threadId} composerThreadId={otherThreadId} />);
  settle();

  await screen.rerender(<Harness threadId={threadId} />);
  await expect.element(screen.getByLabelText("Prompt history")).toHaveTextContent("! npm test");
  expect(
    useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(environmentId, otherThreadId))
      ?.prompt ?? "",
  ).toBe("");
});

it("shows a command just sent as waiting, without a transcript entry, until the server has it", async () => {
  const threadId = ThreadId.make("thread:shell-panel-sending");
  setup(threadId);
  state.projection = { projection: { thread: {}, turnItems: [], runs: [], messages: [] } };
  const sentAt = "2026-10-24T10:00:01.000Z";
  const sent: ChatMessage = {
    id: MessageId.make("message:sending"),
    role: "user",
    text: "! npm run build",
    shellCommand: true,
    runId: null,
    streaming: false,
    createdAt: sentAt,
    updatedAt: sentAt,
  };
  await using screen = await render(<Harness threadId={threadId} optimisticMessages={[sent]} />);

  await expect.element(screen.getByRole("listitem")).toHaveTextContent("! npm run buildWaiting…");
  // Its own item replaces it, keeping one row.
  state.projection = {
    projection: {
      thread: { hasShellCommands: true },
      turnItems: [{ ...command("first", "npm run build", "running"), userShellMessageId: sent.id }],
      runs: [{ id: runId, status: "running" }],
      messages: [],
    },
  };
  await screen.rerender(<Harness threadId={threadId} optimisticMessages={[sent]} />);
  await expect
    .element(screen.getByRole("listitem"))
    .toMatchTextContent("! npm run buildRunning for");
});

it("keeps announcing a command's result after it leaves for the transcript", async () => {
  const threadId = ThreadId.make("thread:shell-panel-announce");
  setup(threadId);
  state.projection = {
    projection: {
      thread: { hasShellCommands: true },
      turnItems: [command("first", "npm test", "running")],
      runs: [{ id: runId, status: "running" }],
      messages: [],
    },
  };
  // A fresh `optimisticMessages` re-renders the panel, which reads the mocked projection.
  await using screen = await render(<Harness threadId={threadId} optimisticMessages={[]} />);
  await expect.element(screen.getByRole("listitem")).toBeVisible();

  state.projection = {
    projection: {
      thread: { hasShellCommands: true },
      turnItems: [
        {
          ...command("first", "npm test", "running"),
          status: "completed",
          completedAt: now,
          exitCode: 0,
        },
      ],
      runs: [{ id: runId, status: "starting" }],
      messages: [],
    },
  };
  await screen.rerender(<Harness threadId={threadId} optimisticMessages={[]} />);
  await expect
    .element(page.getByRole("status").filter({ hasText: "Command exited 0" }))
    .toBeInTheDocument();

  state.projection = { projection: { thread: {}, turnItems: [], runs: [], messages: [] } };
  await screen.rerender(<Harness threadId={threadId} optimisticMessages={[]} />);
  await expect.element(screen.getByRole("listitem")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("status").filter({ hasText: "Command exited 0" }))
    .toBeInTheDocument();
});
