import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  TurnItemId,
  type ChatAttachment,
  type MessageId,
} from "@t3tools/contracts";

const SHELL_COMMAND_PREFIX = "!";

export function isShellCommandPrompt(prompt: string): boolean {
  return prompt.startsWith(SHELL_COMMAND_PREFIX);
}

/** The command a `! cmd` prompt runs, or null when there is nothing to run. */
export function shellCommandFromPrompt(prompt: string): string | null {
  if (!isShellCommandPrompt(prompt)) return null;
  const command = prompt.slice(SHELL_COMMAND_PREFIX.length).trim();
  return command.length === 0 ? null : command;
}

/**
 * The stored text of a shell command message, `! <command>`. Clients that predate shell commands
 * show it as an ordinary message, so the `! ` tells their readers it was a command. Clients send
 * this form too: a command that itself starts with `!` (shell negation) stays unambiguous.
 */
export function shellCommandMessageText(command: string): string {
  return `${SHELL_COMMAND_PREFIX} ${command}`;
}

/**
 * The command a shell command message runs, from its stored `! <command>` text. Text without the
 * `!` is read as the bare command, so messages stored before the prefix still read correctly.
 */
export function shellCommandFromMessageText(text: string): string {
  const trimmed = text.trim();
  return isShellCommandPrompt(trimmed)
    ? trimmed.slice(SHELL_COMMAND_PREFIX.length).trim()
    : trimmed;
}

/** `text` a client sent for a shell command message, in its stored `! <command>` form. */
export function normalizeShellCommandMessageText(text: string): string {
  return shellCommandMessageText(shellCommandFromMessageText(text));
}

/**
 * The composer prompt for `command`, without a space after the `!`: drafts keep it that way
 * because the composers draw the gap, so a recalled command matches what the draft holds.
 */
export function shellCommandPrompt(command: string): string {
  return `${SHELL_COMMAND_PREFIX}${command}`;
}

/** A shell-mode prompt without spaces after its `!`; the composers draw that gap themselves. */
export function withoutSpaceAfterShellPrefix(prompt: string): string {
  return prompt.replace(/^!(?:[ \t]+)/, SHELL_COMMAND_PREFIX);
}

/**
 * How many spaces the draft dropped after a command's `!` (see `withoutSpaceAfterShellPrefix`):
 * the editors draw that gap, so a typed or pasted space there is not kept.
 */
export function droppedShellPrefixSpaces(input: {
  readonly typedText: string;
  readonly storedText: string;
}): number {
  const removed = input.typedText.length - input.storedText.length;
  return removed > 0 && withoutSpaceAfterShellPrefix(input.typedText) === input.storedText
    ? removed
    : 0;
}

/** The editor's caret once `dropped` spaces after the leading `!` are gone. */
export function selectionAfterDroppedShellPrefixSpaces(
  selection: { readonly start: number; readonly end: number },
  dropped: number,
): { readonly start: number; readonly end: number } {
  const shift = (offset: number) => (offset <= 1 ? offset : Math.max(1, offset - dropped));
  return { start: shift(selection.start), end: shift(selection.end) };
}

/**
 * The command in an assistant code block written as `! cmd`, or null when the block isn't one.
 * Comment and blank lines aside, agents write either one `!` before a multi-line script or one
 * per line. A block that mixes them isn't one: a later line's `!` could be shell negation.
 */
export function shellCommandFromCodeBlock(code: string): string | null {
  const lines = code.replace(/\n$/, "").split("\n");
  const prefixed = (line: string) => line.trimStart().startsWith(SHELL_COMMAND_PREFIX);
  const neutral = (line: string) => line.trim().length === 0 || line.trimStart().startsWith("#");
  const firstLine = lines.findIndex((line) => !neutral(line));
  if (firstLine === -1 || !prefixed(lines[firstLine]!)) return null;
  const body = lines.slice(firstLine);
  const later = body.slice(1).filter((line) => !neutral(line));
  const everyLinePrefixed = later.every(prefixed);
  if (!everyLinePrefixed && later.some(prefixed)) return null;
  // With a `!` on every line each line is a command, and a bare `!` is none.
  const lineCommands = later.length > 0 && everyLinePrefixed;
  if (lineCommands && body.some((line) => line.trim() === SHELL_COMMAND_PREFIX)) return null;
  const stripped = body.map((line, index) =>
    index === 0 || (lineCommands && prefixed(line))
      ? line.trimStart().slice(SHELL_COMMAND_PREFIX.length).replace(/^ /, "")
      : line,
  );
  const command = stripped.join("\n").trim();
  return command.length === 0 ? null : command;
}

/** One command per message, so its result item is found from the message alone. */
export function userShellCommandItemId(messageId: MessageId): TurnItemId {
  return TurnItemId.make(`turn-item:user-shell:${messageId}`);
}

/** Output a `! cmd` saves to a file stops here, so an endless log cannot fill the disk. */
export const SHELL_COMMAND_SAVED_OUTPUT_MAX_BYTES = PROVIDER_SEND_TURN_MAX_FILE_BYTES;
export const SHELL_COMMAND_OUTPUT_FILE_NAME = "command-output.log";
/**
 * The saved output's name once the output outgrew the cap. The name carries it, so every client
 * that shows the file, and the agent's prompt, says the file is not the whole output.
 */
export const SHELL_COMMAND_PARTIAL_OUTPUT_FILE_NAME = "command-output-first-50MB.log";

export function isPartialShellCommandOutput(attachment: Pick<ChatAttachment, "name">): boolean {
  return attachment.name === SHELL_COMMAND_PARTIAL_OUTPUT_FILE_NAME;
}
