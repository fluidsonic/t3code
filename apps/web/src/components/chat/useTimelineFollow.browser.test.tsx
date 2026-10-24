import "../../index.css";

import { EnvironmentId, MessageId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import * as DateTime from "effect/DateTime";
import type { ThreadRunSummary } from "@t3tools/client-runtime/state/models";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import type { TimelineEntry } from "../../session-logic";
import { MessagesTimeline } from "./MessagesTimeline";
import { useTimelineFollow } from "./useTimelineFollow";

vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));

const AT = "2026-10-24T10:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-follow");
const EARLIER_RUN = RunId.make("run-earlier");
const WORKING_RUN = RunId.make("run-working");
const COMMANDS_RUN = RunId.make("run-commands");

const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  runId: RunId,
  extra: Partial<Extract<TimelineEntry, { kind: "message" }>["message"]> = {},
): TimelineEntry => ({
  id,
  kind: "message",
  createdAt: AT,
  message: {
    id: MessageId.make(id),
    role,
    text,
    runId,
    createdAt: AT,
    updatedAt: AT,
    streaming: false,
    ...extra,
  },
});

const shellCommand = (id: string, command: string): TimelineEntry =>
  message(id, "user", `! ${command}`, COMMANDS_RUN, {
    shellCommand: true,
    shellCommandResult: {
      id: TurnItemId.make(`user-shell:${id}`),
      threadId: THREAD_ID,
      runId: COMMANDS_RUN,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: DateTime.makeUnsafe(AT),
      completedAt: DateTime.makeUnsafe(AT),
      updatedAt: DateTime.makeUnsafe(AT),
      type: "command_execution",
      input: command,
      exitCode: 0,
      userShellMessageId: MessageId.make(id),
      userShellDelivered: true,
    },
  });

const workingTurn: TimelineEntry[] = [
  message("earlier", "user", "Look around", EARLIER_RUN),
  ...Array.from({ length: 6 }, (_, index) =>
    message(`earlier-reply-${index}`, "assistant", "Earlier reply. ".repeat(40), EARLIER_RUN),
  ),
  message("prompt", "user", "Sleep for 20s", WORKING_RUN),
  ...Array.from({ length: 8 }, (_, index): TimelineEntry => ({
    id: `work-${index}`,
    kind: "work",
    createdAt: AT,
    entry: {
      id: `work-${index}`,
      createdAt: AT,
      runId: WORKING_RUN,
      label: `Ran sleep ${index}`,
      tone: "tool",
      itemType: "command_execution",
      command: `sleep ${index}`,
    },
  })),
];

interface Thread {
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly runId: RunId;
  /** Height of the composer, with the shell command panel above it. */
  readonly composerInset: number;
  /** Whether the shell command panel shows above the composer. */
  readonly shellCommandPanel?: true;
  /** The server's visible user messages; a new run's first one is what a sent turn anchors to. */
  readonly serverUserMessages?: ReadonlyArray<{
    readonly messageId: MessageId;
    readonly runId: RunId;
    readonly shellCommand?: true;
  }>;
}

const serverProjection = (thread: Thread): ThreadStructure | null =>
  thread.serverUserMessages === undefined
    ? null
    : ({
        visibleTurnItems: thread.serverUserMessages.map((item) => ({
          item: { type: "user_message", ...item },
        })),
      } as never);

function Timeline({ thread }: { thread: Thread }) {
  const listRef = useRef<LegendListRef | null>(null);
  const [anchor, setAnchor] = useState<{ threadKey: string | null; messageId: MessageId | null }>({
    threadKey: "thread",
    messageId: null,
  });
  const latestRun: ThreadRunSummary = {
    runId: thread.runId,
    status: "running",
    requestedAt: AT,
    startedAt: AT,
    completedAt: null,
    assistantMessageId: null,
  };
  const {
    attachComposerOverlay,
    attachTimelineViewport,
    onTimelineAnchorReadyStable,
    onTimelineAnchorSizeChangedStable,
    timelineLiveFollowEnabled,
    onIsAtEndChangeStable,
  } = useTimelineFollow({
    legendListRef: listRef,
    composerTimelineInset: thread.composerInset,
    routeThreadKey: "environment-local:thread-follow",
    activeThreadKey: "thread",
    isServerThread: thread.serverUserMessages !== undefined,
    serverProjection: serverProjection(thread),
    threadStatus: "live",
    activeActivityRun: latestRun,
    activeRunningTurnId: thread.runId,
    timelineEntries: thread.entries,
    timelineAnchorMessageId: anchor.messageId,
    setTimelineAnchor: setAnchor,
  });
  return (
    // Exposes the anchor a newly sent turn sets: it holds that turn's message near the top.
    <div data-anchor={anchor.messageId ?? ""} className="flex min-h-0 flex-1 flex-col">
      <div ref={attachComposerOverlay} hidden>
        {thread.shellCommandPanel ? <div data-shell-command-panel="true" /> : null}
      </div>
      <MessagesTimeline
        isWorking
        listRef={listRef}
        latestRun={latestRun}
        runningRunId={thread.runId}
        activeTurnStartedAt={AT}
        turnDiffSummaries={[]}
        runs={[]}
        routeThreadKey="environment-local:thread-follow"
        onOpenTurnDiff={() => {}}
        onOpenThread={() => {}}
        onForkFromRun={async () => {}}
        supportsConversationRollback={false}
        onRevertToTurnCount={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        activeThreadEnvironmentId={EnvironmentId.make("environment-local")}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        anchorMessageId={anchor.messageId}
        onAnchorReady={onTimelineAnchorReadyStable}
        onAnchorSizeChanged={onTimelineAnchorSizeChangedStable}
        contentInsetEndAdjustment={thread.composerInset}
        emptyPlaceholderInset={0}
        liveFollowEnabled={timelineLiveFollowEnabled}
        onIsAtEndChange={onIsAtEndChangeStable}
        onViewportAttach={attachTimelineViewport}
        timelineEntries={[...thread.entries]}
      />
    </div>
  );
}

it("keeps following the end when delivered commands leave the panel above the composer", async () => {
  const container = document.createElement("div");
  container.style.cssText = "height: 600px; width: 900px; display: flex; flex-direction: column;";
  // Two commands wait in the panel above the composer while the agent works.
  await using screen = await render(
    <Timeline
      thread={{
        entries: workingTurn,
        runId: WORKING_RUN,
        composerInset: 200,
        shellCommandPanel: true,
      }}
    />,
    { container },
  );
  const viewport = () => container.querySelector<HTMLElement>(".messages-timeline-scroll")!;
  const distanceFromEnd = () => {
    const node = viewport();
    return node.scrollHeight - node.scrollTop - node.clientHeight;
  };
  await vi.waitFor(() => expect(distanceFromEnd()).toBeLessThanOrEqual(1));

  // The turn ends, and the commands' run delivers them in the same update that empties the panel.
  await act(() =>
    screen.rerender(
      <Timeline
        thread={{
          entries: [
            ...workingTurn,
            message("done", "assistant", "Slept for 20s. ".repeat(10), WORKING_RUN),
            shellCommand("command-1", "echo one"),
            shellCommand("command-2", "echo two"),
          ],
          runId: COMMANDS_RUN,
          composerInset: 100,
        }}
      />,
    ),
  );

  await vi.waitFor(() => expect(distanceFromEnd()).toBeLessThanOrEqual(1));
  expect(screen.container.textContent).toContain("echo two");
});

it("ends at the bottom after a sent command is delivered and the agent replies", async () => {
  const container = document.createElement("div");
  container.style.cssText = "height: 600px; width: 900px; display: flex; flex-direction: column;";
  const settled = [
    ...workingTurn,
    message("done", "assistant", "Slept for 20s. ".repeat(10), WORKING_RUN),
  ];
  const serverUserMessages = [
    { messageId: MessageId.make("earlier"), runId: EARLIER_RUN },
    { messageId: MessageId.make("prompt"), runId: WORKING_RUN },
  ];
  await using screen = await render(
    <Timeline
      thread={{ entries: settled, runId: WORKING_RUN, composerInset: 100, serverUserMessages }}
    />,
    { container },
  );
  const viewport = () => container.querySelector<HTMLElement>(".messages-timeline-scroll")!;
  const distanceFromEnd = () => {
    const node = viewport();
    return node.scrollHeight - node.scrollTop - node.clientHeight;
  };
  // Space between the reply's last line and the composer: none to speak of when at the end, a
  // screenful when the delivered command is anchored near the top instead.
  const gapUnderReply = (composerInset: number) =>
    viewport().getBoundingClientRect().bottom -
    composerInset -
    screen.getByText("Running the tests now.").element().getBoundingClientRect().bottom;
  await vi.waitFor(() => expect(distanceFromEnd()).toBeLessThanOrEqual(1));

  // Sent: the command's run starts and the command waits in the panel above the composer.
  await act(() =>
    screen.rerender(
      <Timeline
        thread={{
          entries: settled,
          runId: COMMANDS_RUN,
          composerInset: 160,
          serverUserMessages,
          shellCommandPanel: true,
        }}
      />,
    ),
  );
  // Delivered: the command joins the transcript as the panel empties.
  const delivered = [...settled, shellCommand("command-1", "echo one")];
  const deliveredServerUserMessages = [
    ...serverUserMessages,
    { messageId: MessageId.make("command-1"), runId: COMMANDS_RUN, shellCommand: true as const },
  ];
  await act(() =>
    screen.rerender(
      <Timeline
        thread={{
          entries: delivered,
          runId: COMMANDS_RUN,
          composerInset: 100,
          serverUserMessages: deliveredServerUserMessages,
        }}
      />,
    ),
  );
  // A command is not a turn the person wrote, so nothing holds it at the top.
  expect(container.querySelector("[data-anchor]")?.getAttribute("data-anchor")).toBe("");
  // The agent's reply starts.
  await act(() =>
    screen.rerender(
      <Timeline
        thread={{
          entries: [
            ...delivered,
            message("reply", "assistant", "Running the tests now.", COMMANDS_RUN),
          ],
          runId: COMMANDS_RUN,
          composerInset: 100,
          serverUserMessages: deliveredServerUserMessages,
        }}
      />,
    ),
  );

  await vi.waitFor(() => {
    expect(distanceFromEnd()).toBeLessThanOrEqual(1);
    expect(gapUnderReply(100)).toBeLessThan(120);
  });
});
