import {
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2RunStatus,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { shellCommandMessageText, userShellCommandItemId } from "@t3tools/shared/shellCommand";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  type UserShellCommandItem,
  composerDraftIsShellCommand,
  composerPromptForMessage,
  isRunningUserShellCommand,
  liveUserShellCommands,
  nextComposerShellMode,
  shellCommandBlockFromInlineCodeParagraph,
  stopComposerShellCommands,
  userShellCommandAnnouncement,
  shellCommandsFromUntaggedCodeBlock,
  userShellCommandFromCodeBlock,
  userShellCommandModeNote,
  userShellCommandOutcomeLine,
  userShellCommandOutputView,
  userShellCommandOwnsWorkingSlot,
  userShellCommandPresentation,
  userShellCommandStatusText,
} from "./userShellCommand.ts";

/** The thread of a test's commands, which has run one like any thread that shows them. */
const shellThread = { hasShellCommands: true };

function commandItem(overrides: Partial<UserShellCommandItem> = {}): UserShellCommandItem {
  return {
    id: TurnItemId.make("item-shell"),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: DateTime.makeUnsafe("2026-10-23T10:00:00.000Z"),
    completedAt: DateTime.makeUnsafe("2026-10-23T10:00:02.300Z"),
    updatedAt: DateTime.makeUnsafe("2026-10-23T10:00:02.300Z"),
    type: "command_execution",
    input: "npm test",
    exitCode: 0,
    userShellMessageId: MessageId.make("message-shell"),
    ...overrides,
  };
}

describe("nextComposerShellMode", () => {
  const shellMode = (previousPrompt: string, nextPrompt: string, previousShellMode = false) =>
    nextComposerShellMode({ previousPrompt, previousShellMode, nextPrompt, available: true });

  it("enters only on a `!` typed or pasted into an empty composer", () => {
    expect(shellMode("", "!")).toBe(true);
    expect(shellMode("", "!git status")).toBe(true);
    expect(shellMode("  ", "! git status")).toBe(true);
  });

  it("keeps a `!` typed or pasted in front of existing text as prose", () => {
    expect(shellMode("hello", "!hello")).toBe(false);
    expect(shellMode("hello", "!git status hello")).toBe(false);
    expect(shellMode("hello", "!git status")).toBe(false);
  });

  it("keeps the Backspace opt-out while the `!` stays, and resets it once the `!` goes", () => {
    // Backspace on a lone `!` stored the prompt with shell mode off.
    expect(shellMode("!", "!!", false)).toBe(false);
    expect(shellMode("!!", "!important", false)).toBe(false);
    expect(shellMode("!important", "important", false)).toBe(false);
    expect(shellMode("!", "", false)).toBe(false);
    expect(shellMode("", "!", false)).toBe(true);
  });

  it("stays while the prompt keeps its `!` and leaves once it is gone", () => {
    expect(shellMode("! ls", "! ls -la", true)).toBe(true);
    expect(shellMode("! ls", " ls", true)).toBe(false);
    expect(shellMode("! ls", "", true)).toBe(false);
  });

  it("never starts where shell commands are unavailable, so `!` stays prose", () => {
    const unavailable = (previousPrompt: string, nextPrompt: string, previousShellMode = false) =>
      nextComposerShellMode({ previousPrompt, previousShellMode, nextPrompt, available: false });
    expect(unavailable("", "!")).toBe(false);
    expect(unavailable("urgent", "! urgent")).toBe(false);
    expect(unavailable("!", "!ls")).toBe(false);
  });

  it("keeps a command a command where shell commands became unavailable, until its `!` goes", () => {
    const unavailable = (previousPrompt: string, nextPrompt: string, previousShellMode = false) =>
      nextComposerShellMode({ previousPrompt, previousShellMode, nextPrompt, available: false });
    expect(unavailable("!ls", "!ls -la", true)).toBe(true);
    expect(unavailable("!ls", "ls", true)).toBe(false);
  });
});

describe("composerDraftIsShellCommand", () => {
  it("ignores a stale flag once the prompt lost its `!`", () => {
    expect(composerDraftIsShellCommand({ prompt: "! ls", shellMode: true })).toBe(true);
    expect(composerDraftIsShellCommand({ prompt: "", shellMode: true })).toBe(false);
    expect(composerDraftIsShellCommand({ prompt: "! ls" })).toBe(false);
  });
});

describe("composerPromptForMessage", () => {
  it("brings a command back in shell mode as the draft stores it, and prose as typed", () => {
    expect(composerPromptForMessage({ text: "! npm test", shellCommand: true })).toEqual({
      prompt: "!npm test",
      shellMode: true,
    });
    // Shell negation stays part of the command.
    expect(composerPromptForMessage({ text: "! ! grep -q x f", shellCommand: true })).toEqual({
      prompt: "!! grep -q x f",
      shellMode: true,
    });
    expect(composerPromptForMessage({ text: "!important" })).toEqual({
      prompt: "!important",
      shellMode: false,
    });
  });
});

describe("userShellCommandPresentation", () => {
  it("reports exit code and duration, and calls a non-zero exit failed", () => {
    expect(userShellCommandPresentation(commandItem())).toEqual({
      status: "completed",
      exitCode: 0,
      durationMs: 2300,
      summary: "Exited 0 in 2.3s",
    });
    expect(userShellCommandPresentation(commandItem({ exitCode: 1 }))).toMatchObject({
      status: "failed",
      summary: "Exited 1 in 2.3s",
    });
  });

  it("shows a running command without a duration", () => {
    expect(
      userShellCommandPresentation(
        commandItem({ status: "running", completedAt: null, exitCode: undefined }),
      ),
    ).toEqual({ status: "running", exitCode: null, durationMs: null, summary: "Running…" });
  });

  it("shows a command queued behind another as waiting, not running", () => {
    expect(
      userShellCommandPresentation(
        commandItem({ status: "pending", startedAt: null, completedAt: null, exitCode: undefined }),
      ),
    ).toEqual({ status: "waiting", exitCode: null, durationMs: null, summary: "Waiting…" });
  });

  it("shows an unfinished command's state and a finished command's duration", () => {
    const text = (item: UserShellCommandItem) =>
      userShellCommandStatusText(userShellCommandPresentation(item));
    expect(text(commandItem({ status: "pending", completedAt: null }))).toBe("Waiting…");
    expect(text(commandItem({ status: "running", completedAt: null }))).toBe("Running…");
    const failed = commandItem({ status: "completed", exitCode: 128 });
    expect(text(failed)).toBe("2.3s");
    expect(userShellCommandPresentation(failed).summary).toBe("Exited 128 in 2.3s");
  });

  it("notes a failing exit code under the output", () => {
    const outcome = (item: UserShellCommandItem) =>
      userShellCommandOutcomeLine(userShellCommandPresentation(item));
    expect(outcome(commandItem())).toBeNull();
    expect(outcome(commandItem({ exitCode: 2 }))).toBe("exit 2");
  });
});

describe("userShellCommandOutputView", () => {
  it("opens a finished command only once its omitted output has loaded", () => {
    const finished = { running: false, wantsOutput: true, fetchesOutput: true, hasOutput: false };
    expect(userShellCommandOutputView({ ...finished, outputSettled: false })).toEqual({
      loading: true,
      expanded: false,
      showOutput: false,
    });
    // Nothing printed still opens, to say so.
    expect(userShellCommandOutputView({ ...finished, outputSettled: true })).toEqual({
      loading: false,
      expanded: true,
      showOutput: true,
    });
    expect(
      userShellCommandOutputView({ ...finished, fetchesOutput: false, outputSettled: false }),
    ).toMatchObject({ loading: false, showOutput: true });
  });

  it("shows an unfinished command's output box only once it prints", () => {
    const running = { running: true, wantsOutput: false, fetchesOutput: true, outputSettled: true };
    expect(userShellCommandOutputView({ ...running, hasOutput: false }).showOutput).toBe(false);
    expect(userShellCommandOutputView({ ...running, hasOutput: true }).showOutput).toBe(true);
  });
});

describe("userShellCommandAnnouncement", () => {
  it("announces a start and a finish once, never a remounted state", () => {
    const done = userShellCommandPresentation(commandItem({ status: "failed", exitCode: 1 }));
    expect(userShellCommandAnnouncement(null, { status: "running", summary: "Running…" })).toBe(
      "Command started",
    );
    expect(userShellCommandAnnouncement("running", done)).toBe("Command exited 1 in 2.3s");
    expect(userShellCommandAnnouncement("failed", done)).toBeNull();
  });

  it("stays quiet while a command waits and announces when it starts", () => {
    expect(userShellCommandAnnouncement(null, { status: "waiting", summary: "Waiting…" })).toBe(
      null,
    );
    expect(
      userShellCommandAnnouncement("waiting", { status: "running", summary: "Running…" }),
    ).toBe("Command started");
  });
});

describe("userShellCommandModeNote", () => {
  it("names the modes recorded on the command, not the thread's current ones", () => {
    expect(userShellCommandModeNote({ bypassedModes: ["supervised"] })).toBe(
      "Ran on this machine outside Supervised mode.",
    );
    expect(userShellCommandModeNote({ bypassedModes: ["plan"] })).toBe(
      "Ran on this machine outside Plan mode.",
    );
    expect(userShellCommandModeNote({ bypassedModes: ["supervised", "plan"] })).toBe(
      "Ran on this machine outside Supervised and Plan mode.",
    );
    expect(userShellCommandModeNote({})).toBeNull();
    expect(userShellCommandModeNote({ bypassedModes: [] })).toBeNull();
  });
});

describe("isRunningUserShellCommand", () => {
  it("counts only a person's command that has not finished", () => {
    expect(isRunningUserShellCommand(commandItem({ status: "running" }))).toBe(true);
    expect(isRunningUserShellCommand(commandItem({ status: "pending" }))).toBe(true);
    expect(isRunningUserShellCommand(commandItem())).toBe(false);
    const { userShellMessageId: _messageId, ...agentCommand } = commandItem({ status: "running" });
    expect(isRunningUserShellCommand(agentCommand)).toBe(false);
  });
});

describe("userShellCommandOwnsWorkingSlot", () => {
  const messageId = MessageId.make("message-shell");
  const message = {
    id: messageId,
    threadId: ThreadId.make("thread-1"),
    text: shellCommandMessageText("npm test"),
    shellCommand: true,
  };
  const run = (
    status: OrchestrationV2RunStatus,
    hold?: NonNullable<OrchestrationV2Run["userShellHold"]>["status"],
  ) => ({
    id: RunId.make("run-1"),
    status,
    userMessageId: messageId,
    requestedAt: DateTime.makeUnsafe("2026-10-23T10:00:00.000Z"),
    ...(hold
      ? { userShellHold: { providerTurnId: ProviderTurnId.make("turn-1"), status: hold } }
      : {}),
  });
  const owns = (
    projection: Parameters<typeof userShellCommandOwnsWorkingSlot>[0]["projection"],
    sendingShellMessageIds: ReadonlyArray<MessageId> = [],
  ) => userShellCommandOwnsWorkingSlot({ projection, sendingShellMessageIds });

  it("holds the slot from the send until the result reaches the agent", () => {
    // Sent, before the server has it.
    expect(owns(null, [messageId])).toBe(true);
    expect(owns({ thread: shellThread, turnItems: [], runs: [], messages: [] }, [messageId])).toBe(
      true,
    );
    // Waiting, running, and finished while its run has yet to start the agent's turn.
    for (const item of [
      commandItem({ status: "pending", startedAt: null, completedAt: null }),
      commandItem({ status: "running", completedAt: null }),
      commandItem(),
    ]) {
      expect(
        owns(
          { thread: shellThread, turnItems: [item], runs: [run("starting")], messages: [message] },
          [messageId],
        ),
      ).toBe(true);
    }
    // A new thread's first command, waiting for its workspace.
    expect(
      owns({ thread: shellThread, turnItems: [], runs: [run("preparing")], messages: [message] }),
    ).toBe(true);
  });

  it("leaves the slot to the agent once the result is delivered", () => {
    const delivered = commandItem({ userShellDelivered: true });
    // A recorded send is the projection's to judge, even while the client still holds it.
    expect(
      owns(
        {
          thread: shellThread,
          turnItems: [delivered],
          runs: [run("starting")],
          messages: [message],
        },
        [messageId],
      ),
    ).toBe(false);
    expect(
      owns({
        thread: shellThread,
        turnItems: [delivered],
        runs: [run("running")],
        messages: [message],
      }),
    ).toBe(false);
    expect(owns(null)).toBe(false);
  });

  it("leaves a steered command's slot to the agent until the agent pauses for it", () => {
    const steered = (hold: NonNullable<OrchestrationV2Run["userShellHold"]>["status"]) =>
      owns({
        thread: shellThread,
        turnItems: [commandItem({ status: "pending", startedAt: null, completedAt: null })],
        runs: [run("running", hold)],
        messages: [message],
      });
    expect(steered("pausing")).toBe(false);
    expect(steered("paused")).toBe(true);
  });
});

describe("stopComposerShellCommands", () => {
  const messageId = MessageId.make("message-shell");
  const message = {
    id: messageId,
    threadId: ThreadId.make("thread-1"),
    text: shellCommandMessageText("npm test"),
    shellCommand: true,
  };
  const run = (
    status: OrchestrationV2RunStatus,
    hold?: NonNullable<OrchestrationV2Run["userShellHold"]>["status"],
  ) => ({
    id: RunId.make("run-1"),
    status,
    userMessageId: messageId,
    requestedAt: DateTime.makeUnsafe("2026-10-23T10:00:00.000Z"),
    ...(hold
      ? { userShellHold: { providerTurnId: ProviderTurnId.make("turn-1"), status: hold } }
      : {}),
  });
  const running = commandItem({ id: TurnItemId.make("running"), status: "running" });
  const waiting = commandItem({
    id: TurnItemId.make("waiting"),
    ordinal: 2,
    input: "npm run lint",
    status: "pending",
    startedAt: null,
    completedAt: null,
  });
  const stopFrom = (
    projection: Parameters<typeof stopComposerShellCommands>[0]["projection"],
    stopped = true,
  ) => {
    const stops: Array<string> = [];
    const returned: Array<string> = [];
    const result = stopComposerShellCommands({
      projection,
      stop: async (command) => {
        stops.push(command.id);
        return stopped;
      },
      onStoppedRunning: (command) => returned.push(command.input),
    });
    return { result, stops, returned };
  };

  it("stops every command, waiting ones first, and returns only the running one", async () => {
    const { result, stops, returned } = stopFrom({
      thread: shellThread,
      turnItems: [running, waiting],
      runs: [run("starting")],
      messages: [message],
    });
    await result;
    expect(stops).toEqual(["waiting", "running"]);
    expect(returned).toEqual(["npm test"]);
  });

  it("returns nothing whose stop failed", async () => {
    const { result, returned } = stopFrom(
      { thread: shellThread, turnItems: [running], runs: [run("starting")], messages: [message] },
      false,
    );
    await result;
    expect(returned).toEqual([]);
  });

  it("leaves Stop to the thread while there is agent work or no command to stop", () => {
    // An agent turn, paused for a steered command or not.
    for (const hold of [undefined, "paused"] as const) {
      expect(
        stopFrom({
          thread: shellThread,
          turnItems: [waiting],
          runs: [run("running", hold)],
          messages: [message],
        }).result,
      ).toBeNull();
    }
    // Finished, its result about to start the agent's turn.
    expect(
      stopFrom({
        thread: shellThread,
        turnItems: [commandItem()],
        runs: [run("starting")],
        messages: [message],
      }).result,
    ).toBeNull();
    // A new thread's first command, waiting for its workspace.
    expect(
      stopFrom({
        thread: shellThread,
        turnItems: [],
        runs: [run("preparing")],
        messages: [message],
      }).result,
    ).toBeNull();
    expect(stopFrom(null).result).toBeNull();
  });
});

describe("liveUserShellCommands", () => {
  it("finds none in a thread that never ran a command", () => {
    expect(
      liveUserShellCommands({
        thread: {},
        turnItems: [commandItem({ status: "running" })],
        runs: [],
        messages: [],
      }),
    ).toEqual([]);
  });

  const item = (id: string, ordinal: number, overrides: Partial<UserShellCommandItem> = {}) =>
    commandItem({ id: TurnItemId.make(id), ordinal, ...overrides });
  const requestedAt = DateTime.makeUnsafe("2026-10-23T10:00:00.000Z");
  const run = (id: string, status: OrchestrationV2RunStatus, userMessageId = "message-other") => ({
    id: RunId.make(id),
    status,
    userMessageId: MessageId.make(userMessageId),
    requestedAt,
  });

  it("lists commands until their result reaches the agent, in the order they run", () => {
    const running = item("running", 3, { status: "running", completedAt: null });
    const waiting = item("waiting", 4, { status: "pending", startedAt: null, completedAt: null });
    // Done, with its batch's turn yet to start.
    const ranBefore = item("ran", 2);
    const delivered = item("delivered", 1, { userShellDelivered: true });
    const stopped = item("stopped", 5, { status: "interrupted" });
    const { userShellMessageId: _messageId, ...agentCommand } = item("agent", 6, {
      status: "running",
    });
    const live = liveUserShellCommands({
      thread: shellThread,
      turnItems: [waiting, stopped, running, delivered, ranBefore, agentCommand],
      runs: [run("run-1", "starting")],
      messages: [],
    });
    expect(live.map((entry) => entry.id)).toEqual(["ran", "running", "waiting"]);
  });

  it("keeps finished commands while the turn they steer waits for the rest", () => {
    // Held at its steering window while another command runs, or being released with them.
    const finished = commandItem();
    const stopped = item("stopped", 2, { status: "interrupted" });
    expect(
      liveUserShellCommands({
        thread: shellThread,
        turnItems: [finished, stopped],
        runs: [run("run-1", "running")],
        messages: [],
      }).map((entry) => entry.id),
    ).toEqual([finished.id]);
  });

  it("drops finished commands of a run that is not starting its turn", () => {
    const finished = commandItem();
    // A thread Stop ended the run; a usage limit put it back in the queue.
    for (const status of ["interrupted", "queued"] as const) {
      expect(
        liveUserShellCommands({
          thread: shellThread,
          turnItems: [finished],
          runs: [run("run-1", status)],
          messages: [],
        }),
      ).toEqual([]);
    }
  });

  it("shows a new thread's first command waiting while its workspace is prepared", () => {
    const messageId = MessageId.make("message-first");
    const messages = [
      {
        id: messageId,
        threadId: ThreadId.make("thread-1"),
        text: shellCommandMessageText("npm test"),
        shellCommand: true as const,
      },
      // A prose first message stays in the transcript, not here.
      { id: MessageId.make("message-prose"), threadId: ThreadId.make("thread-1"), text: "hi" },
    ];
    const preparing = liveUserShellCommands({
      thread: shellThread,
      turnItems: [],
      runs: [
        run("run-first", "preparing", messageId),
        run("run-prose", "preparing", "message-prose"),
      ],
      messages,
    });
    expect(preparing).toHaveLength(1);
    expect(preparing[0]).toMatchObject({
      id: userShellCommandItemId(messageId),
      runId: RunId.make("run-first"),
      input: "npm test",
      userShellMessageId: messageId,
      awaitsWorkspace: true,
    });
    expect(userShellCommandPresentation(preparing[0]!).status).toBe("waiting");

    // Once the workspace is ready the command's own item takes its place, under the same id.
    const started = item(userShellCommandItemId(messageId), 3, {
      status: "running",
      runId: RunId.make("run-first"),
      userShellMessageId: messageId,
      completedAt: null,
    });
    const ready = liveUserShellCommands({
      thread: shellThread,
      turnItems: [started],
      runs: [run("run-first", "starting", messageId)],
      messages,
    });
    expect(ready).toEqual([started]);
  });
});

describe("shellCommandsFromUntaggedCodeBlock", () => {
  it("runs each `!` line on its own, comments aside", () => {
    expect(
      shellCommandsFromUntaggedCodeBlock(
        "! cf dns records delete 7da2 -z 7d85\n\n# then\n  ! cf dns records delete f90f -z e060\n!pnpm deploy\n",
      ),
    ).toEqual([
      "cf dns records delete 7da2 -z 7d85",
      "cf dns records delete f90f -z e060",
      "pnpm deploy",
    ]);
  });

  it("runs a block with only its first `!` as one command, and offers no run otherwise", () => {
    for (const [code, commands] of [
      ["! npm test\n", ["npm test"]],
      ["# install\n! cd app\nnpm test\n", ["cd app\nnpm test"]],
      ["! cd app\nnpm test\n! ls\n", null],
      ["! npm test\n!\n", null],
      ["!\n! npm test\n", null],
      ["! npm test\n! rm -rf \u202e/\n", null],
      ["npm test\nnpm run lint\n", null],
    ] as const) {
      expect(shellCommandsFromUntaggedCodeBlock(code)).toEqual(commands);
    }
  });
});

describe("userShellCommandFromCodeBlock", () => {
  it("runs an untagged `! cmd` block without its prefix", () => {
    expect(userShellCommandFromCodeBlock("! npm test\n", "")).toBe("npm test");
    expect(userShellCommandFromCodeBlock("\n! git add -A\n! git commit\n", null)).toBe(
      "git add -A\ngit commit",
    );
    // A later `!` line in a script could be shell negation.
    expect(userShellCommandFromCodeBlock("! set -e\n! grep -q x f\nls\n", undefined)).toBeNull();
    expect(userShellCommandFromCodeBlock("npm test\n", "")).toBeNull();
  });

  it("runs a shell-language block verbatim, keeping a leading `!`", () => {
    for (const language of ["sh", "bash", "zsh", "shell", "Bash", "bash title=setup.sh"]) {
      expect(userShellCommandFromCodeBlock("npm test\n", language)).toBe("npm test");
    }
    expect(userShellCommandFromCodeBlock("! grep -q x f && echo missing\n", "bash")).toBe(
      "! grep -q x f && echo missing",
    );
    expect(userShellCommandFromCodeBlock("cd web\nnpm run build\n", "sh")).toBe(
      "cd web\nnpm run build",
    );
  });

  it("never runs a block in another language, even written as `! cmd`", () => {
    for (const language of ["fish", "powershell", "pwsh", "console", "text", "ts"]) {
      expect(userShellCommandFromCodeBlock("! npm test\n", language)).toBeNull();
    }
  });

  it("treats a block with prompt lines as an example transcript", () => {
    expect(userShellCommandFromCodeBlock("$ npm test\nok\n", "bash")).toBeNull();
    expect(userShellCommandFromCodeBlock("ls\n> output\n", "sh")).toBeNull();
    expect(userShellCommandFromCodeBlock("! npm test\n$ ls\n", "")).toBeNull();
    // Only a prompt marker followed by a space reads as a transcript.
    expect(userShellCommandFromCodeBlock("echo $HOME>out.txt\n", "bash")).toBe(
      "echo $HOME>out.txt",
    );
  });

  it("refuses blocks hiding characters or with nothing to run", () => {
    expect(userShellCommandFromCodeBlock("! echo ok\u200b && rm -rf ~\n", "")).toBeNull();
    expect(userShellCommandFromCodeBlock("echo safe \u202e#\n", "bash")).toBeNull();
    expect(userShellCommandFromCodeBlock("!\n", "")).toBeNull();
    expect(userShellCommandFromCodeBlock("\n  \n", "bash")).toBeNull();
  });
});

describe("shellCommandBlockFromInlineCodeParagraph", () => {
  it("reads a paragraph of only an inline `! cmd` span as an untagged command block", () => {
    expect(shellCommandBlockFromInlineCodeParagraph("`! npm test`")).toEqual({
      code: "! npm test",
      command: "npm test",
    });
    expect(shellCommandBlockFromInlineCodeParagraph("`!git status` \n")).toEqual({
      code: "!git status",
      command: "git status",
    });
  });

  it("joins a soft-wrapped span into one line", () => {
    // A blockquote's or list item's paragraph, sliced from its message, keeps the markers.
    expect(
      shellCommandBlockFromInlineCodeParagraph("`! git push origin\n> \t a:production`"),
    ).toEqual({
      code: "! git push origin a:production",
      command: "git push origin a:production",
    });
    expect(
      shellCommandBlockFromInlineCodeParagraph(
        "`! git -C /repo push origin\n  a:production b:staging`",
      ),
    ).toEqual({
      code: "! git -C /repo push origin a:production b:staging",
      command: "git -C /repo push origin a:production b:staging",
    });
  });

  it("ignores spans with other text, several spans, or no `!`", () => {
    expect(shellCommandBlockFromInlineCodeParagraph("Run `! npm test`")).toBeNull();
    expect(shellCommandBlockFromInlineCodeParagraph("`! npm test` to check.")).toBeNull();
    expect(shellCommandBlockFromInlineCodeParagraph("`! npm test` `! npm run lint`")).toBeNull();
    expect(shellCommandBlockFromInlineCodeParagraph("`npm test`")).toBeNull();
    expect(shellCommandBlockFromInlineCodeParagraph("`!`")).toBeNull();
    expect(shellCommandBlockFromInlineCodeParagraph("**`! npm test`**")).toBeNull();
    expect(shellCommandBlockFromInlineCodeParagraph("    `! npm test`")).toBeNull();
  });
});
