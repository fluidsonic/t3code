import { assert, describe, it } from "@effect/vitest";
import { MessageId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { historicalMessage } from "./handoffBudget.ts";
import {
  formatUserShellCommandPrompt,
  formatUserShellCommandResult,
  userShellCommandFormatForDriver,
  utf8Tail,
  type UserShellCommandResult,
} from "./userShellCommand.ts";

const ok: UserShellCommandResult = {
  command: "ls",
  exitCode: 0,
  durationMs: 1234,
  output: "\u001b[32ma.txt\u001b[0m\r\nb.txt\n",
};
const failed: UserShellCommandResult = {
  command: "false",
  exitCode: 1,
  durationMs: 50,
  output: "boom\n",
};
const spilled: UserShellCommandResult = {
  command: "cat big.log",
  exitCode: 0,
  durationMs: 2000,
  output: `${"x".repeat(3000)}\nlast line\n`,
  fullOutput: { path: "/attachments/thread-big.log", sizeBytes: 40 * 1024 },
};

describe("formatUserShellCommandResult", () => {
  it("selects the format per driver", () => {
    assert.equal(userShellCommandFormatForDriver("claudeAgent"), "claude");
    assert.equal(userShellCommandFormatForDriver("codex"), "codex");
    assert.equal(userShellCommandFormatForDriver("pi"), "pi");
    assert.equal(userShellCommandFormatForDriver("opencode"), "opencode");
    assert.equal(userShellCommandFormatForDriver("cursor"), "generic");
    assert.equal(userShellCommandFormatForDriver("grok"), "generic");
  });

  it("formats Claude's bash tags, with the combined output in stdout whatever the exit code", () => {
    assert.equal(
      formatUserShellCommandResult("claude", ok),
      "<bash-input>ls</bash-input>\n<bash-stdout>a.txt\nb.txt</bash-stdout><bash-stderr></bash-stderr>\n<bash-exit-code>0</bash-exit-code><bash-wall-time>1.2s</bash-wall-time>",
    );
    assert.equal(
      formatUserShellCommandResult("claude", failed),
      "<bash-input>false</bash-input>\n<bash-stdout>boom</bash-stdout><bash-stderr></bash-stderr>\n<bash-exit-code>1</bash-exit-code><bash-wall-time>0.1s</bash-wall-time>",
    );
  });

  it("points Claude at saved output with a 2KB preview", () => {
    const text = formatUserShellCommandResult("claude", spilled);
    assert.include(
      text,
      "<bash-stdout><persisted-output>\nOutput too large (40.0KB). Full output saved to: /attachments/thread-big.log\n\nPreview (last 2KB):\n",
    );
    assert.include(text, "last line\n</persisted-output></bash-stdout>");
    assert.isBelow(text.length, 2600);
  });

  it("says when the saved output stops at the cap instead of calling it the full output", () => {
    const partial: UserShellCommandResult = {
      ...spilled,
      fullOutput: {
        path: "/attachments/thread-big.log",
        sizeBytes: 50 * 1024 * 1024,
        partial: true,
      },
    };
    assert.include(
      formatUserShellCommandResult("claude", partial),
      "Output too large. Only its first 50.0MB were saved to: /attachments/thread-big.log",
    );
    for (const format of ["codex", "pi", "opencode", "generic"] as const) {
      const text = formatUserShellCommandResult(format, partial);
      assert.include(
        text,
        "[Output truncated. Only its first 50.0MB were saved: /attachments/thread-big.log]",
      );
      assert.notInclude(text, "Full output");
    }
  });

  it("formats Codex's user_shell_command block", () => {
    assert.equal(
      formatUserShellCommandResult("codex", ok),
      [
        "<user_shell_command>",
        "<command>",
        "ls",
        "</command>",
        "<result>",
        "Exit code: 0",
        "Duration: 1.2340 seconds",
        "Output:",
        "a.txt\nb.txt",
        "</result>",
        "</user_shell_command>",
      ].join("\n"),
    );
    assert.include(
      formatUserShellCommandResult("codex", spilled),
      "last line\n[Output truncated. Full output: /attachments/thread-big.log]\n</result>",
    );
  });

  it("formats Pi's bash message", () => {
    assert.equal(
      formatUserShellCommandResult("pi", ok),
      "Ran `ls`\n```\na.txt\nb.txt\n```\n\nTook 1.2s",
    );
    assert.equal(
      formatUserShellCommandResult("pi", { ...failed, output: "" }),
      "Ran `false`\n(no output)\n\nCommand exited with code 1\n\nTook 0.1s",
    );
    assert.equal(
      formatUserShellCommandResult("pi", { ...ok, output: "```js\nx\n```" }),
      "Ran `ls`\n````\n```js\nx\n```\n````\n\nTook 1.2s",
    );
    assert.match(
      formatUserShellCommandResult("pi", spilled),
      /Took 2\.0s\n\n\[Output truncated\. Full output: \/attachments\/thread-big\.log\]$/,
    );
  });

  it("formats OpenCode's shell message", () => {
    assert.equal(
      formatUserShellCommandResult("opencode", failed),
      "The following shell command was executed by the user:\n\nCommand:\nfalse\n\nOutput:\nboom\n\nExit code: 1\nDuration: 0.1s",
    );
  });

  it("tells other agents the person already ran it", () => {
    const text = formatUserShellCommandResult("generic", ok);
    assert.isTrue(
      text.startsWith(
        "The user ran this shell command themselves in the workspace. Do not run it again unless asked.\n<user_shell_command>",
      ),
    );
  });
});

describe("formatUserShellCommandPrompt", () => {
  it("puts results first and the following message last", () => {
    const prompt = formatUserShellCommandPrompt({
      driver: "codex",
      results: [ok, failed],
      message: "why did that fail?",
    });
    assert.isBelow(prompt.indexOf("<command>\nls"), prompt.indexOf("<command>\nfalse"));
    assert.isTrue(prompt.endsWith("</user_shell_command>\n\nwhy did that fail?"));
  });
});

describe("utf8Tail", () => {
  it("never starts inside a character", () => {
    assert.equal(utf8Tail("aé", 1), "");
    assert.equal(utf8Tail("aé", 2), "é");
    assert.equal(utf8Tail("abc", 10), "abc");
  });
});

describe("historicalMessage", () => {
  const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const base = {
    threadId: ThreadId.make("thread"),
    runId: RunId.make("run"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  } as const;
  const messageId = MessageId.make("message:shell");

  it("renders a person's command as their input and drops the command message", () => {
    assert.isNull(
      historicalMessage({
        ...base,
        id: TurnItemId.make("item:message"),
        status: "completed",
        type: "user_message",
        messageId,
        shellCommand: true,
        inputIntent: "turn_start",
        text: "ls",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      }),
    );
    const result = historicalMessage({
      ...base,
      id: TurnItemId.make("item:command"),
      status: "failed",
      type: "command_execution",
      input: "ls",
      output: "\u001b[31mnope\u001b[0m\n",
      exitCode: 2,
      userShellMessageId: messageId,
      userShellDelivered: true,
    });
    assert.equal(result?.role, "user");
    assert.equal(result?.text, "The user ran a shell command: ! ls\nExit code: 2\nnope");
  });

  it("drops a command whose result never reached the agent, finished or not", () => {
    for (const status of ["running", "interrupted", "completed"] as const) {
      assert.isNull(
        historicalMessage({
          ...base,
          id: TurnItemId.make("item:command"),
          status,
          type: "command_execution",
          input: "sleep 100",
          exitCode: 0,
          userShellMessageId: messageId,
        }),
      );
    }
  });
});
