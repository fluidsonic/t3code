import type { MessageId, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { normalizeTerminalOutput, terminalOutputPlainText } from "@t3tools/shared/terminalOutput";

/** The most output a `! cmd` result keeps inline; more is saved to a file. */
export const USER_SHELL_OUTPUT_TAIL_BYTES = 32 * 1024;
/** How much of saved output the agent sees inline. */
const USER_SHELL_OUTPUT_PREVIEW_BYTES = 2 * 1024;

export type UserShellCommandItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "command_execution" }
> & { readonly userShellMessageId: MessageId };

export function isUserShellCommandItem(
  item: OrchestrationV2TurnItem,
): item is UserShellCommandItem {
  return item.type === "command_execution" && item.userShellMessageId !== undefined;
}

export interface UserShellCommandResult {
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  /** The output tail as the command wrote it, terminal escapes included. */
  readonly output: string;
  /** Set when the output was too large to keep inline. */
  readonly fullOutput?:
    | {
        readonly path: string;
        readonly sizeBytes: number;
        /** The output outgrew what a file keeps, so the file holds only its start. */
        readonly partial?: boolean | undefined;
      }
    | undefined;
  /** The command never ran: an earlier one the user sent with it failed. */
  readonly skipped?: boolean | undefined;
}

/**
 * The prompt shape each harness's own `!` mode produces, so its model reads the result the way it
 * was trained to. Harnesses without one get Codex's block with a note saying who ran it.
 */
export type UserShellCommandFormat = "claude" | "codex" | "pi" | "opencode" | "generic";

export function userShellCommandFormatForDriver(driver: string): UserShellCommandFormat {
  switch (driver) {
    case "claudeAgent":
      return "claude";
    case "codex":
      return "codex";
    case "pi":
      return "pi";
    case "opencode":
      return "opencode";
    default:
      return "generic";
  }
}

/** The last `maxBytes` of `text` in UTF-8, without a split character at the start. */
export function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  let start = bytes.byteLength - maxBytes;
  // Skip continuation bytes so the cut lands on a character boundary.
  while (start < bytes.byteLength && (bytes[start]! & 0b1100_0000) === 0b1000_0000) start += 1;
  return bytes.subarray(start).toString("utf8");
}

/** What a terminal would show, without colours or cursor movement. */
function plainShellOutput(output: string): string {
  return terminalOutputPlainText(normalizeTerminalOutput(output, Number.MAX_SAFE_INTEGER).text);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function seconds(durationMs: number, digits: number): string {
  return (Math.max(0, durationMs) / 1000).toFixed(digits);
}

function fence(text: string): string {
  let ticks = "```";
  while (text.includes(ticks)) ticks += "`";
  return `${ticks}\n${text}\n${ticks}`;
}

type SavedOutput = NonNullable<UserShellCommandResult["fullOutput"]>;

const truncationNote = (saved: SavedOutput) =>
  saved.partial === true
    ? `[Output truncated. Only its first ${formatBytes(saved.sizeBytes)} were saved: ${saved.path}]`
    : `[Output truncated. Full output: ${saved.path}]`;

function claude(result: UserShellCommandResult, output: string): string {
  const saved = result.fullOutput;
  const stream =
    saved === undefined
      ? output
      : saved.partial === true
        ? `<persisted-output>\nOutput too large. Only its first ${formatBytes(saved.sizeBytes)} were saved to: ${saved.path}\n\nPreview (last 2KB):\n${output}\n</persisted-output>`
        : `<persisted-output>\nOutput too large (${formatBytes(saved.sizeBytes)}). Full output saved to: ${saved.path}\n\nPreview (last 2KB):\n${output}\n</persisted-output>`;
  // stdout and stderr arrive as one stream, in the order a terminal shows them, so the output
  // cannot be split. It all goes in stdout, where an exit code alone does not move it.
  return [
    `<bash-input>${result.command}</bash-input>`,
    `<bash-stdout>${stream}</bash-stdout><bash-stderr></bash-stderr>`,
    `<bash-exit-code>${result.exitCode}</bash-exit-code><bash-wall-time>${seconds(result.durationMs, 1)}s</bash-wall-time>`,
  ].join("\n");
}

// Mirrors codex-rs/core/src/context/user_shell_command.rs.
function codex(result: UserShellCommandResult, output: string): string {
  const body =
    result.fullOutput === undefined ? output : `${output}\n${truncationNote(result.fullOutput)}`;
  return [
    "<user_shell_command>",
    "<command>",
    result.command,
    "</command>",
    "<result>",
    `Exit code: ${result.exitCode}`,
    `Duration: ${seconds(result.durationMs, 4)} seconds`,
    "Output:",
    body,
    "</result>",
    "</user_shell_command>",
  ].join("\n");
}

function pi(result: UserShellCommandResult, output: string): string {
  return [
    `Ran \`${result.command}\`\n${output.length === 0 ? "(no output)" : fence(output)}`,
    ...(result.exitCode === 0 ? [] : [`Command exited with code ${result.exitCode}`]),
    `Took ${seconds(result.durationMs, 1)}s`,
    ...(result.fullOutput === undefined ? [] : [truncationNote(result.fullOutput)]),
  ].join("\n\n");
}

function opencode(result: UserShellCommandResult, output: string): string {
  return [
    "The following shell command was executed by the user:",
    `Command:\n${result.command}`,
    `Output:\n${output}`,
    `Exit code: ${result.exitCode}\nDuration: ${seconds(result.durationMs, 1)}s`,
    ...(result.fullOutput === undefined ? [] : [truncationNote(result.fullOutput)]),
  ].join("\n\n");
}

export function formatUserShellCommandResult(
  format: UserShellCommandFormat,
  result: UserShellCommandResult,
): string {
  const tail =
    result.fullOutput === undefined
      ? result.output
      : utf8Tail(result.output, USER_SHELL_OUTPUT_PREVIEW_BYTES);
  const output = plainShellOutput(tail).replace(/\n+$/, "");
  switch (format) {
    case "claude":
      return claude(result, output);
    case "codex":
      return codex(result, output);
    case "pi":
      return pi(result, output);
    case "opencode":
      return opencode(result, output);
    case "generic":
      return `The user ran this shell command themselves in the workspace. Do not run it again unless asked.\n${codex(result, output)}`;
  }
}

/** Results first, in the order they ran, then the message that followed them, if any. */
export function formatUserShellCommandPrompt(input: {
  readonly driver: string;
  readonly results: ReadonlyArray<UserShellCommandResult>;
  readonly message?: string | undefined;
}): string {
  const format = userShellCommandFormatForDriver(input.driver);
  return [
    ...input.results.map((result) =>
      result.skipped === true
        ? skippedCommandNote(result.command)
        : formatUserShellCommandResult(format, result),
    ),
    ...(input.message === undefined || input.message.trim().length === 0 ? [] : [input.message]),
  ].join("\n\n");
}

function skippedCommandNote(command: string): string {
  // The command goes last, as written: in backticks, one holding a backtick or a newline would break.
  return `A shell command the user sent did not run because an earlier one failed: ! ${command}`;
}

/** How a finished `! cmd` reads in history the agent did not see live, as the person's input. */
export function userShellCommandHistoryText(item: UserShellCommandItem): string {
  if (item.userShellSkipped === true) return skippedCommandNote(item.input);
  const output = plainShellOutput(item.output ?? "").replace(/\n+$/, "");
  return [
    `The user ran a shell command: ! ${item.input}`,
    `Exit code: ${item.exitCode ?? "unknown"}`,
    ...(output.length === 0 ? [] : [output]),
  ].join("\n");
}
