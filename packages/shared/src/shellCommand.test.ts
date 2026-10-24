import { describe, expect, it } from "vite-plus/test";

import {
  droppedShellPrefixSpaces,
  normalizeShellCommandMessageText,
  selectionAfterDroppedShellPrefixSpaces,
  shellCommandFromCodeBlock,
  shellCommandFromMessageText,
  shellCommandFromPrompt,
  shellCommandMessageText,
  shellCommandPrompt,
  withoutSpaceAfterShellPrefix,
} from "./shellCommand.ts";

describe("shell command message text", () => {
  it("stores a command behind `! ` and reads it back bare", () => {
    expect(shellCommandMessageText("git status")).toBe("! git status");
    expect(shellCommandFromMessageText("! git status")).toBe("git status");
    expect(shellCommandFromMessageText("!git status\n")).toBe("git status");
    expect(shellCommandFromMessageText("! cd app\nvp i")).toBe("cd app\nvp i");
  });

  it("strips only the message's own `!`, so shell negation survives", () => {
    expect(shellCommandFromMessageText(shellCommandMessageText("! grep -q x f"))).toBe(
      "! grep -q x f",
    );
  });

  it("reads text stored without the prefix as the bare command", () => {
    expect(shellCommandFromMessageText("npm test")).toBe("npm test");
  });

  it("normalizes what a client sends to the stored form, idempotently", () => {
    expect(normalizeShellCommandMessageText("git status")).toBe("! git status");
    expect(normalizeShellCommandMessageText("  !   git status ")).toBe("! git status");
    expect(normalizeShellCommandMessageText("! git status")).toBe("! git status");
    expect(normalizeShellCommandMessageText(normalizeShellCommandMessageText("!ls"))).toBe("! ls");
  });
});

describe("shellCommandPrompt", () => {
  it("writes the stored form, which the draft keeps as is", () => {
    expect(shellCommandPrompt("npm test")).toBe("!npm test");
    expect(withoutSpaceAfterShellPrefix(shellCommandPrompt("npm test"))).toBe("!npm test");
    expect(shellCommandFromPrompt(shellCommandPrompt("! grep -q x f"))).toBe("! grep -q x f");
  });
});

describe("shellCommandFromPrompt", () => {
  it("returns the command without the prefix", () => {
    expect(shellCommandFromPrompt("! git push")).toBe("git push");
    expect(shellCommandFromPrompt("!ls -la")).toBe("ls -la");
    expect(shellCommandFromPrompt("! cd app\nvp i\n")).toBe("cd app\nvp i");
  });

  it("ignores prompts without a command", () => {
    expect(shellCommandFromPrompt("!")).toBeNull();
    expect(shellCommandFromPrompt("!  \n")).toBeNull();
    expect(shellCommandFromPrompt("run ! git push")).toBeNull();
  });
});

describe("withoutSpaceAfterShellPrefix", () => {
  it("drops spaces right after the prefix only", () => {
    expect(withoutSpaceAfterShellPrefix("! git status")).toBe("!git status");
    expect(withoutSpaceAfterShellPrefix("!\t ls  -la")).toBe("!ls  -la");
    expect(withoutSpaceAfterShellPrefix("!\nls")).toBe("!\nls");
    expect(withoutSpaceAfterShellPrefix("ls ! x")).toBe("ls ! x");
  });
});

describe("spaces dropped after a command's `!`", () => {
  it("moves the editor's caret back over a space the draft did not keep", () => {
    const dropped = droppedShellPrefixSpaces({ typedText: "! ls", storedText: "!ls" });
    expect(dropped).toBe(1);
    // A space typed between `!` and `ls` leaves the caret before `l`.
    expect(selectionAfterDroppedShellPrefixSpaces({ start: 2, end: 2 }, dropped)).toEqual({
      start: 1,
      end: 1,
    });
    expect(selectionAfterDroppedShellPrefixSpaces({ start: 4, end: 4 }, dropped)).toEqual({
      start: 3,
      end: 3,
    });
  });

  it("ignores edits the draft kept as typed or changed otherwise", () => {
    expect(droppedShellPrefixSpaces({ typedText: "! wow", storedText: "! wow" })).toBe(0);
    expect(droppedShellPrefixSpaces({ typedText: "!ls ", storedText: "" })).toBe(0);
  });
});

describe("shellCommandFromCodeBlock", () => {
  it("reads a single-line block", () => {
    expect(shellCommandFromCodeBlock("! git push origin main\n")).toBe("git push origin main");
  });

  it("strips the prefix from every line when every line has one", () => {
    expect(shellCommandFromCodeBlock("! git add -A\n! git commit -m wip\n")).toBe(
      "git add -A\ngit commit -m wip",
    );
  });

  it("keeps a script's later lines as written, and rejects one that mixes in `!` lines", () => {
    expect(shellCommandFromCodeBlock("# build\n! cd web\n# then\nnpm run build\n")).toBe(
      "cd web\n# then\nnpm run build",
    );
    expect(
      shellCommandFromCodeBlock("! set -e\n! grep -q x file || echo missing\nls\n"),
    ).toBeNull();
  });

  it("rejects blocks that don't start with the prefix", () => {
    expect(shellCommandFromCodeBlock("git push\n")).toBeNull();
    expect(shellCommandFromCodeBlock("echo hi\n! false\n")).toBeNull();
    expect(shellCommandFromCodeBlock("!\n")).toBeNull();
  });
});
