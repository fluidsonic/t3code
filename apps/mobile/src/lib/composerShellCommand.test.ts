import { describe, expect, it } from "vite-plus/test";

import {
  SHELL_COMMAND_CONTENT_BLOCKED,
  SHELL_COMMANDS_OFF,
  deletesLoneShellPrefix,
  keepQueuedCommandPrefix,
  pasteStartsShellCommand,
  queuedShellCommandEditText,
  resolveComposerShellSend,
  shellCommandsDisabledReason,
} from "./composerShellCommand";

const draft = (
  text: string,
  overrides: Partial<Parameters<typeof resolveComposerShellSend>[0]["draft"]> = {},
) => ({
  text,
  shellMode: true,
  attachments: [],
  ...overrides,
});

describe("resolveComposerShellSend", () => {
  it("sends a shell-mode draft as its command", () => {
    expect(
      resolveComposerShellSend({ draft: draft("!  npm test "), canRunShellCommands: true }),
    ).toEqual({ kind: "command", command: "npm test" });
  });

  it("refuses a shell-mode draft without terminal access or the environment's setting", () => {
    expect(resolveComposerShellSend({ draft: draft("!ls"), canRunShellCommands: false })).toEqual({
      kind: "blocked",
      reason: SHELL_COMMANDS_OFF,
    });
  });

  it("treats `!` as prose when typed as prose or after leaving shell mode", () => {
    expect(
      resolveComposerShellSend({
        draft: draft("! ls", { shellMode: undefined }),
        canRunShellCommands: false,
      }),
    ).toEqual({ kind: "message" });
    expect(
      resolveComposerShellSend({
        draft: draft("!", { shellMode: false }),
        canRunShellCommands: false,
      }),
    ).toEqual({ kind: "message" });
    expect(
      resolveComposerShellSend({
        draft: draft("!important", { shellMode: false }),
        canRunShellCommands: true,
      }),
    ).toEqual({ kind: "message" });
  });

  it("refuses a command with attachments or context, and an empty one", () => {
    expect(
      resolveComposerShellSend({
        draft: draft("! ls", { attachments: [{}] }),
        canRunShellCommands: true,
      }),
    ).toEqual({ kind: "blocked", reason: SHELL_COMMAND_CONTENT_BLOCKED });
    expect(
      resolveComposerShellSend({
        draft: draft("! ls", { context: { records: [{}] } }),
        canRunShellCommands: true,
      }),
    ).toEqual({ kind: "blocked", reason: SHELL_COMMAND_CONTENT_BLOCKED });
    expect(resolveComposerShellSend({ draft: draft("!  "), canRunShellCommands: true })).toEqual({
      kind: "empty",
    });
  });
});

describe("queuedShellCommandEditText", () => {
  it("keeps a queued command a command even when its `!` was deleted", () => {
    expect(queuedShellCommandEditText("! npm run lint")).toBe("npm run lint");
    expect(queuedShellCommandEditText(" npm run lint ")).toBe("npm run lint");
  });
});

describe("keepQueuedCommandPrefix", () => {
  it("gives a queued command's edit its `!` back, with the caret after it", () => {
    expect(keepQueuedCommandPrefix("!ls")).toEqual({ text: "!ls", shift: 0 });
    // Backspace on the `!`, or replacing all the text.
    expect(keepQueuedCommandPrefix("ls")).toEqual({ text: "!ls", shift: 1 });
    expect(keepQueuedCommandPrefix("")).toEqual({ text: "!", shift: 1 });
  });
});

describe("deletesLoneShellPrefix", () => {
  it("only matches deleting the lone `!` of a command", () => {
    expect(deletesLoneShellPrefix({ previousText: "!", shellMode: true, nextText: "" })).toBe(true);
    expect(deletesLoneShellPrefix({ previousText: "!", shellMode: false, nextText: "" })).toBe(
      false,
    );
    expect(deletesLoneShellPrefix({ previousText: "! l", shellMode: true, nextText: "! " })).toBe(
      false,
    );
  });
});

describe("pasteStartsShellCommand", () => {
  const paste = (value: string, start: number, end: number, text: string) =>
    pasteStartsShellCommand({ value, selection: { start, end }, text });

  it("matches a `!` paste into an empty composer", () => {
    expect(paste("", 0, 0, "!git status")).toBe(true);
    expect(paste("", 0, 0, "git status")).toBe(false);
  });

  it("keeps a `!` paste into a non-empty composer as prose", () => {
    expect(paste("hello", 0, 0, "!git status ")).toBe(false);
    expect(paste("hello", 0, 5, "!git status")).toBe(false);
    expect(paste("hello", 3, 3, "!git status")).toBe(false);
  });
});

describe("shellCommandsDisabledReason", () => {
  it("recognizes the server's refusal once shell commands are turned off", () => {
    const message =
      "Shell commands are turned off for this environment. Turn on Shell commands in Settings to run them.";
    expect(shellCommandsDisabledReason(new Error(message))).toBe(message);
    expect(shellCommandsDisabledReason({ _tag: "ShellCommandsDisabledError", message })).toBe(
      message,
    );
  });

  it("ignores any other failure", () => {
    expect(shellCommandsDisabledReason(new Error("Run is no longer queued"))).toBeNull();
    expect(shellCommandsDisabledReason("Shell commands are turned off")).toBeNull();
    expect(shellCommandsDisabledReason(undefined)).toBeNull();
  });
});
