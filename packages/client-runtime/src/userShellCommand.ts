import type {
  MessageId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  isShellCommandPrompt,
  shellCommandFromCodeBlock,
  shellCommandFromMessageText,
  shellCommandPrompt,
  userShellCommandItemId,
} from "@t3tools/shared/shellCommand";
import * as DateTime from "effect/DateTime";

import type { ThreadStructureTurnItem } from "./state/models.ts";

/** The result item of a person's `! cmd` message. */
export type UserShellCommandItem = Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;

/** Full projection items and the streamed-text-free ones the thread structure holds. */
type AnyTurnItem = OrchestrationV2TurnItem | ThreadStructureTurnItem;

export function isUserShellCommandItem(
  item: AnyTurnItem,
): item is UserShellCommandItem & { readonly userShellMessageId: MessageId } {
  return item.type === "command_execution" && item.userShellMessageId !== undefined;
}

/**
 * Shell mode after the prompt changes. Only a `!` typed or pasted into an empty composer enters
 * it, and it ends once the prompt stops starting with `!`; leaving with Backspace on a lone `!`
 * sticks. Where shell commands are unavailable `!` is prose, but a draft already in shell mode
 * stays a command so it never reaches the agent as prose.
 */
export function nextComposerShellMode(input: {
  readonly previousPrompt: string;
  readonly previousShellMode: boolean;
  readonly nextPrompt: string;
  /** Terminal access and the environment's shell-command setting, for this composer. */
  readonly available: boolean;
}): boolean {
  if (!isShellCommandPrompt(input.nextPrompt)) return false;
  if (isShellCommandPrompt(input.previousPrompt)) return input.previousShellMode;
  return input.available && input.previousPrompt.trim().length === 0;
}

/** Whether a stored draft is in shell mode; a stale flag on a prompt without `!` is not. */
export function composerDraftIsShellCommand(draft: {
  readonly prompt: string;
  readonly shellMode?: boolean | undefined;
}): boolean {
  return draft.shellMode === true && isShellCommandPrompt(draft.prompt);
}

/** The composer text and mode that bring a sent or queued message back for editing. */
export function composerPromptForMessage(message: {
  readonly text: string;
  readonly shellCommand?: boolean | undefined;
}): { readonly prompt: string; readonly shellMode: boolean } {
  return message.shellCommand === true
    ? { prompt: shellCommandPrompt(shellCommandFromMessageText(message.text)), shellMode: true }
    : { prompt: message.text, shellMode: false };
}

/**
 * `waiting` is a command queued behind another; a thread runs its commands one at a time. A
 * stopped command has no status: it disappears.
 */
export type UserShellCommandStatus = "waiting" | "running" | "completed" | "failed" | "skipped";

export interface UserShellCommandPresentation {
  readonly status: UserShellCommandStatus;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  /** One line, such as "Exited 1 in 2.3s"; read out when the command finishes. */
  readonly summary: string;
}

function userShellCommandStatus(item: UserShellCommandItem): UserShellCommandStatus {
  if (item.userShellSkipped === true) return "skipped";
  switch (item.status) {
    case "completed":
      return item.exitCode === undefined || item.exitCode === 0 ? "completed" : "failed";
    case "failed":
    case "interrupted":
    case "cancelled":
      return "failed";
    case "pending":
      return "waiting";
    default:
      return "running";
  }
}

/** Not finished yet: running, or waiting for an earlier command. Either can be stopped. */
export function userShellCommandIsActive(
  status: UserShellCommandStatus,
): status is "waiting" | "running" {
  return status === "waiting" || status === "running";
}

export function userShellCommandPresentation(
  item: UserShellCommandItem,
): UserShellCommandPresentation {
  const status = userShellCommandStatus(item);
  const exitCode = item.exitCode ?? null;
  const durationMs =
    item.startedAt !== null && item.completedAt !== null
      ? Math.max(
          0,
          DateTime.toEpochMillis(item.completedAt) - DateTime.toEpochMillis(item.startedAt),
        )
      : null;
  const duration = durationMs === null ? "" : ` in ${formatDuration(durationMs)}`;
  const summary =
    status === "waiting"
      ? "Waiting…"
      : status === "running"
        ? "Running…"
        : status === "skipped"
          ? "Skipped: an earlier command failed"
          : exitCode === null
            ? `${status === "failed" ? "Failed" : "Finished"}${duration}`
            : `Exited ${exitCode}${duration}`;
  return { status, exitCode, durationMs, summary };
}

/** A person's command not finished yet; the thread shows as working, not connecting, meanwhile. */
export function isRunningUserShellCommand(item: AnyTurnItem): boolean {
  return isUserShellCommandItem(item) && userShellCommandIsActive(userShellCommandStatus(item));
}

/** A command shown above the composer; see `liveUserShellCommands`. */
export type LiveUserShellCommand = UserShellCommandItem & {
  readonly userShellMessageId: MessageId;
  /**
   * A new thread's first command, waiting for its workspace. Its item doesn't exist yet, so it
   * can't be stopped on its own; stopping the thread ends the preparation and it with it.
   */
  readonly awaitsWorkspace?: true;
};

/**
 * Commands shown above the composer, in run order, until their result reaches the agent and
 * joins the transcript. A stopped one is gone; a batch held by a usage limit shows as its queued
 * message. A new thread's first command shows from its message until the workspace is ready.
 */
export function liveUserShellCommands(projection: {
  readonly thread: Pick<OrchestrationV2AppThread, "hasShellCommands">;
  readonly turnItems: ReadonlyArray<AnyTurnItem>;
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "id" | "status" | "userMessageId" | "requestedAt">
  >;
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "id" | "threadId" | "text" | "shellCommand">
  >;
}): ReadonlyArray<LiveUserShellCommand> {
  // Every thread's composer asks; only a thread that has run a command can have any.
  if (projection.thread.hasShellCommands !== true) return [];
  const live: Array<LiveUserShellCommand> = [];
  for (const item of projection.turnItems) {
    if (!isUserShellCommandItem(item) || item.userShellDelivered === true) continue;
    const active =
      item.status === "pending" || item.status === "running" || item.status === "waiting";
    const finished = item.status === "completed" || item.status === "failed";
    if (
      active ||
      (finished &&
        projection.runs.some(
          (run) => run.id === item.runId && (run.status === "starting" || run.status === "running"),
        ))
    ) {
      live.push(item);
    }
  }
  for (const run of projection.runs) {
    if (run.status !== "preparing") continue;
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    if (message?.shellCommand !== true) continue;
    // The id its item will have, so the row stays put when the item replaces it.
    const id = userShellCommandItemId(message.id);
    if (live.some((item) => item.id === id)) continue;
    live.push({
      id,
      threadId: message.threadId,
      runId: run.id,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      // After every item there is: its own will follow the workspace preparation's.
      ordinal: Number.MAX_SAFE_INTEGER,
      status: "pending",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: run.requestedAt,
      type: "command_execution",
      input: shellCommandFromMessageText(message.text),
      userShellMessageId: message.id,
      awaitsWorkspace: true,
    });
  }
  return live.sort((left, right) => left.ordinal - right.ordinal);
}

/**
 * Whether a person's `! cmd` work is all the thread is doing, from send until its result reaches
 * the agent, with no agent turn running. The timeline then shows no working row for it. A command
 * steered into a running turn leaves the slot to the agent until the agent pauses for it.
 */
export function userShellCommandOwnsWorkingSlot(input: {
  readonly projection:
    | (Omit<Parameters<typeof liveUserShellCommands>[0], "runs"> & {
        readonly runs: ReadonlyArray<
          Pick<
            OrchestrationV2Run,
            "id" | "status" | "userMessageId" | "requestedAt" | "userShellHold"
          >
        >;
      })
    | null;
  /**
   * The client's `! cmd` sends, except ones queued behind a turn, which wait with the queued
   * messages instead. Any the server has recorded are left to the projection.
   */
  readonly sendingShellMessageIds: ReadonlyArray<MessageId>;
}): boolean {
  const { projection } = input;
  const sending = input.sendingShellMessageIds.some(
    (id) => !projection?.messages.some((candidate) => candidate.id === id),
  );
  if (!sending && (projection === null || liveUserShellCommands(projection).length === 0)) {
    return false;
  }
  return !(projection?.runs ?? []).some(
    (run) => run.status === "running" && run.userShellHold?.status !== "paused",
  );
}

/**
 * The composer's Stop while `! cmd` work is all the thread does: stops each command as its own
 * Stop would and sends nothing to the agent. Null where Stop interrupts the thread instead: an
 * agent turn runs, or a new thread's first command waits for its workspace.
 */
export function stopComposerShellCommands(input: {
  readonly projection: Parameters<typeof liveUserShellCommands>[0] | null;
  /** Whether the stop went through. */
  readonly stop: (command: LiveUserShellCommand) => Promise<boolean>;
  readonly onStoppedRunning: (command: LiveUserShellCommand) => void;
}): Promise<void> | null {
  const { projection } = input;
  if (projection === null || projection.runs.some((run) => run.status === "running")) {
    return null;
  }
  const active = liveUserShellCommands(projection).filter((command) =>
    userShellCommandIsActive(userShellCommandStatus(command)),
  );
  if (active.length === 0 || active.some((command) => command.awaitsWorkspace === true)) {
    return null;
  }
  // Waiting ones first: stopping the running one first would start the next, to be stopped and
  // returned as though it had been running.
  const ordered = [...active].sort(
    (left, right) => Number(left.status === "running") - Number(right.status === "running"),
  );
  return (async () => {
    for (const command of ordered) {
      if ((await input.stop(command)) && command.status === "running") {
        input.onStoppedRunning(command);
      }
    }
  })();
}

/**
 * The status line's text. A finished command shows only its duration; its icon carries the
 * outcome, and the full summary ("Exited 1 in 2.3s") is the line's accessible label.
 */
export function userShellCommandStatusText(
  presentation: Pick<UserShellCommandPresentation, "status" | "summary" | "durationMs">,
): string {
  if (userShellCommandIsActive(presentation.status)) return presentation.summary;
  if (presentation.status === "skipped") return "Skipped";
  return presentation.durationMs === null ? "" : formatDuration(presentation.durationMs);
}

/** The line under a finished command's output when it did not succeed. */
export function userShellCommandOutcomeLine(
  presentation: Pick<UserShellCommandPresentation, "exitCode">,
): string | null {
  return presentation.exitCode !== null && presentation.exitCode !== 0
    ? `exit ${presentation.exitCode}`
    : null;
}

/**
 * What the bubble shows of a command's output. The thread omits output, so a finished command
 * opens only once its fetched output arrives: one resize instead of a loading box and then the
 * output. An unfinished command shows its box once it prints.
 */
export function userShellCommandOutputView(input: {
  /** Running or waiting; see `userShellCommandIsActive`. */
  readonly running: boolean;
  readonly wantsOutput: boolean;
  /** The environment streams output; without it the item's own output is all there is. */
  readonly fetchesOutput: boolean;
  /** The fetch returned output or failed. */
  readonly outputSettled: boolean;
  /** Whether there is any output yet; only an unfinished command reads it. */
  readonly hasOutput: boolean;
}): { readonly loading: boolean; readonly expanded: boolean; readonly showOutput: boolean } {
  const loading =
    input.wantsOutput && !input.running && input.fetchesOutput && !input.outputSettled;
  const expanded = input.wantsOutput && !loading;
  return {
    loading,
    expanded,
    showOutput: input.running ? input.hasOutput : expanded,
  };
}

const BYPASSED_MODE_LABEL = { supervised: "Supervised", plan: "Plan" } as const;

/**
 * The note under a sent command when it ran outside the thread's Supervised or Plan mode, from
 * the modes recorded when it was sent, so a later mode change never relabels it.
 */
export function userShellCommandModeNote(
  item: Pick<UserShellCommandItem, "bypassedModes">,
): string | null {
  const modes = item.bypassedModes ?? [];
  return modes.length === 0
    ? null
    : `Ran on this machine outside ${modes.map((mode) => BYPASSED_MODE_LABEL[mode]).join(" and ")} mode.`;
}

/**
 * Spoken when a command seen while mounted starts or ends; streamed output is never read.
 * `previous` is null when the command had no result yet.
 */
export function userShellCommandAnnouncement(
  previous: UserShellCommandStatus | null,
  next: Pick<UserShellCommandPresentation, "status" | "summary">,
): string | null {
  if (previous === next.status || next.status === "waiting") return null;
  if (next.status === "running") {
    return previous === null || previous === "waiting" ? "Command started" : null;
  }
  return `Command ${next.summary.charAt(0).toLowerCase()}${next.summary.slice(1)}`;
}

// Control and invisible format characters (bidi overrides, zero-width) can make the rendered
// command differ from what would run. Line breaks and tabs are the only ones a script needs.
const HIDDEN_CHARACTER = /(?![\n\t])[\p{Cc}\p{Cf}]/u;

// A block in one of these is a script as written; its leading `!` is shell negation, not ours.
const SHELL_FENCE_LANGUAGES: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "shell"]);

// A `$ ` or `> ` line is a prompt shown with its output: an example to read, not a command.
const TRANSCRIPT_LINE = /^[$>] /m;

/**
 * The command a closed assistant code block runs as a `! cmd` message, or null when it offers
 * none. An untagged block runs when written as `! cmd`, without the prefix; an sh, bash, zsh or
 * shell block runs verbatim; any other language never does.
 */
export function userShellCommandFromCodeBlock(
  code: string,
  language: string | null | undefined,
): string | null {
  if (HIDDEN_CHARACTER.test(code) || TRANSCRIPT_LINE.test(code)) return null;
  const fenceLanguage = language?.trim().split(/\s/, 1)[0]?.toLowerCase() ?? "";
  if (fenceLanguage.length === 0) return shellCommandFromCodeBlock(code);
  if (!SHELL_FENCE_LANGUAGES.has(fenceLanguage)) return null;
  const command = code.trim();
  return command.length === 0 ? null : command;
}

/**
 * The commands an untagged `! cmd` block runs, or null when it isn't one. With a `!` on every
 * line, comments aside, each line is a command of its own: run as one script, a failed line would
 * not stop the next. A `!` only before the first line makes one command of the whole block.
 */
export function shellCommandsFromUntaggedCodeBlock(code: string): ReadonlyArray<string> | null {
  const lines = code
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length > 1 && lines.every((line) => line.startsWith("!"))) {
    const commands = lines.map((line) => userShellCommandFromCodeBlock(line, null));
    return commands.every((command) => command !== null) ? commands : null;
  }
  const command = userShellCommandFromCodeBlock(code.replace(/\r\n?/g, "\n"), null);
  return command === null ? null : [command];
}

// One single-backtick span and nothing else; a paragraph can't hold a blank line.
const INLINE_CODE_PARAGRAPH = /^ {0,3}`([^`]+)`[ \t]*$/;
// A soft wrap with the next line's indentation and, inside a blockquote, its markers.
const SOFT_WRAP = /[ \t]*(?:\r\n|\r|\n)[ \t>]*/g;

/**
 * Agents sometimes give a command as a paragraph of one inline `! cmd` span. That paragraph
 * stands for an untagged `! cmd` block: this is the block's code, on one line as markdown renders
 * the span, and the command `userShellCommandFromCodeBlock` runs for it. Null for any other
 * paragraph. `paragraph` is the paragraph's markdown source.
 */
export function shellCommandBlockFromInlineCodeParagraph(
  paragraph: string,
): { readonly code: string; readonly command: string } | null {
  const span = INLINE_CODE_PARAGRAPH.exec(paragraph.replace(/\s+$/, ""))?.[1];
  if (span === undefined) return null;
  const code = span.replace(SOFT_WRAP, " ").trim();
  if (!code.startsWith("!")) return null;
  const command = userShellCommandFromCodeBlock(code, null);
  return command === null ? null : { code, command };
}
