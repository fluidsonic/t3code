import {
  composerDraftIsShellCommand,
  nextComposerShellMode,
} from "@t3tools/client-runtime/user-shell-command";
import { isShellCommandPrompt, shellCommandFromPrompt } from "@t3tools/shared/shellCommand";

export const SHELL_COMMAND_CONTENT_BLOCKED = "Remove attachments and context to run a command.";

/** A command drafted before shell commands became unavailable stays one, and can't be sent. */
export const SHELL_COMMANDS_OFF = "Shell commands are off for this environment.";

export const SHELL_COMMAND_PLACEHOLDER = "Run in shell…";

export type ComposerShellSend =
  | { readonly kind: "message" }
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "empty" }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * What sending a draft does. A command carries nothing but its text, and without terminal access
 * and the environment's shell-command setting it can't be sent. The draft's shell flag decides,
 * so a `!` typed as prose stays prose.
 */
export function resolveComposerShellSend(input: {
  readonly draft: {
    readonly text: string;
    readonly shellMode?: boolean | undefined;
    readonly attachments: ReadonlyArray<unknown>;
    readonly context?: { readonly records: ReadonlyArray<unknown> } | undefined;
  };
  readonly canRunShellCommands: boolean;
}): ComposerShellSend {
  const { draft } = input;
  if (!composerDraftIsShellCommand({ prompt: draft.text, shellMode: draft.shellMode })) {
    return { kind: "message" };
  }
  if (!input.canRunShellCommands) return { kind: "blocked", reason: SHELL_COMMANDS_OFF };
  if (draft.attachments.length > 0 || (draft.context?.records.length ?? 0) > 0) {
    return { kind: "blocked", reason: SHELL_COMMAND_CONTENT_BLOCKED };
  }
  const command = shellCommandFromPrompt(draft.text);
  return command === null ? { kind: "empty" } : { kind: "command", command };
}

/**
 * A queued command's edit keeps its `!`: the kind of a queued message can't change, so an edit
 * that deletes it, by Backspace or by replacing all the text, gets it back. `shift` moves the
 * caret past the restored `!`.
 */
export function keepQueuedCommandPrefix(text: string): {
  readonly text: string;
  readonly shift: number;
} {
  return isShellCommandPrompt(text) ? { text, shift: 0 } : { text: `!${text}`, shift: 1 };
}

/** The text a queued-command edit saves. It stays a command even if its `!` was deleted. */
export function queuedShellCommandEditText(text: string): string {
  return isShellCommandPrompt(text) ? (shellCommandFromPrompt(text) ?? "") : text.trim();
}

/**
 * Backspace on a lone `!` leaves shell mode and keeps the `!` as prose. The native editors report
 * only the resulting text, so the deletion of that `!` stands in for the key.
 */
export function deletesLoneShellPrefix(input: {
  readonly previousText: string;
  readonly shellMode: boolean;
  readonly nextText: string;
}): boolean {
  return input.shellMode && input.previousText === "!" && input.nextText === "";
}

/**
 * Whether pasting `text` over `selection` of `value` makes the prompt a command, so it must land as
 * typed. Only a `!` paste into an empty composer does (see `nextComposerShellMode`).
 */
export function pasteStartsShellCommand(input: {
  readonly value: string;
  readonly selection: { readonly start: number; readonly end: number };
  readonly text: string;
}): boolean {
  const { value, selection, text } = input;
  return nextComposerShellMode({
    previousPrompt: value,
    previousShellMode: false,
    nextPrompt: value.slice(0, selection.start) + text + value.slice(selection.end),
    available: true,
  });
}

const SHELL_COMMANDS_DISABLED_PREFIX = "Shell commands are turned off";

/** The server's refusal of a command once the environment turned shell commands off, if it is one. */
export function shellCommandsDisabledReason(error: unknown): string | null {
  const message =
    typeof error === "object" && error !== null && "message" in error ? error.message : null;
  return typeof message === "string" && message.startsWith(SHELL_COMMANDS_DISABLED_PREFIX)
    ? message
    : null;
}
