import { describe, expect, it } from "vite-plus/test";

import {
  codeBlockRunnableCommand,
  markdownMayHaveShellCodeBlock,
  splitShellCommandMarkdown,
} from "./threadShellCommandPresentation";

describe("code block commands", () => {
  it("offers only finished blocks the shared rule runs", () => {
    const command = (code: string, language: string, streaming = false) =>
      codeBlockRunnableCommand({
        code,
        language,
        streaming,
        markdown: `\`\`\`${language}\n${code}\`\`\``,
      });
    expect(command("! npm test\n", "")).toBe("npm test");
    expect(command("! npm test\n", "", true)).toBeNull();
    expect(command("! npm test\n", "text")).toBeNull();
    expect(command("! grep -q x f\n", "bash")).toBe("! grep -q x f");
    expect(command("$ npm test\nok\n", "sh")).toBeNull();
    expect(command("npm test\n", "")).toBeNull();
    expect(command("! rm -rf \u202e/\n", "")).toBeNull();
  });

  it("offers no block an interrupted reply left open, as the web does", () => {
    const interrupted = "Run this:\n\n```bash\nnpm test\n```\n\nThen:\n\n```bash\nnpm run deploy";
    const command = (code: string, markdown: string) =>
      codeBlockRunnableCommand({ code, language: "bash", streaming: false, markdown });
    expect(command("npm run deploy\n", interrupted)).toBeNull();
    expect(command("npm test\n", interrupted)).toBe("npm test");
    expect(command("npm test\n", "```bash\nnpm test\n````")).toBe("npm test");
    // A shorter or different closer is code, so the block runs to the end, open.
    expect(command("npm test\n```\n", "````bash\nnpm test\n```")).toBeNull();
    expect(command("npm test\n```\n", "~~~bash\nnpm test\n```")).toBeNull();
    expect(command("npm test\n", "> ```bash\n> npm test\n> ```")).toBe("npm test");
  });

  it("arms block taps only on markdown that may hold a runnable fence", () => {
    expect(markdownMayHaveShellCodeBlock("Try:\n\n```\n! npm test\n```")).toBe(true);
    expect(markdownMayHaveShellCodeBlock("~~~\n\n  !ls\n~~~")).toBe(true);
    expect(markdownMayHaveShellCodeBlock("```\n# clean\n! pnpm build\n```")).toBe(true);
    expect(markdownMayHaveShellCodeBlock("> ```\n> ! npm i\n> ```")).toBe(true);
    expect(markdownMayHaveShellCodeBlock("```bash\nnpm test\n```")).toBe(true);
    expect(markdownMayHaveShellCodeBlock("  ~~~ Zsh\nls\n~~~")).toBe(true);
    expect(markdownMayHaveShellCodeBlock("```fish\n! npm test\n```")).toBe(false);
    expect(markdownMayHaveShellCodeBlock("```ts\nconst x = 1;\n```\nDone!")).toBe(false);
    expect(markdownMayHaveShellCodeBlock("Push:\n\n`! git push`")).toBe(true);
    expect(markdownMayHaveShellCodeBlock("Run `! git push` now.")).toBe(false);
  });

  it("takes a block of `! cmd` lines out as one command block, a command per line", () => {
    const markdown =
      "Clean up:\n\n```\n! cf dns records delete 7da2\n! cf dns records delete f90f\n! pnpm deploy\n```\n\nDone.";
    expect(splitShellCommandMarkdown(markdown)).toEqual([
      { kind: "markdown", markdown: "Clean up:\n" },
      {
        kind: "commands",
        code: "! cf dns records delete 7da2\n! cf dns records delete f90f\n! pnpm deploy",
        commands: ["cf dns records delete 7da2", "cf dns records delete f90f", "pnpm deploy"],
      },
      { kind: "markdown", markdown: "\nDone." },
    ]);
    // A `!` script whose later lines go on without one is one command.
    expect(splitShellCommandMarkdown("```\n! cd web\nnpm run build\n```")).toEqual([
      { kind: "commands", code: "! cd web\nnpm run build", commands: ["cd web\nnpm run build"] },
    ]);
    for (const unchanged of [
      "```bash\n! npm test\n! npm run lint\n```",
      "> ```\n> ! npm test\n> ! npm run lint\n> ```",
      "1. Install:\n\n   ```\n   ! npm install\n   ```\n\n2. Test:",
      "- Install:\n  ```\n  ! npm install\n  ```",
      "```\n! npm test\n! npm run lint",
    ]) {
      expect(splitShellCommandMarkdown(unchanged)).toEqual([
        { kind: "markdown", markdown: unchanged },
      ]);
    }
  });

  it("takes a paragraph of one inline `! cmd` span out as the command block it stands for", () => {
    expect(
      splitShellCommandMarkdown(
        "Push it:\n\n`! git -C /repo push origin\n  a:production b:staging`\n\nDone.",
      ),
    ).toEqual([
      { kind: "markdown", markdown: "Push it:\n" },
      {
        kind: "commands",
        code: "! git -C /repo push origin a:production b:staging",
        commands: ["git -C /repo push origin a:production b:staging"],
      },
      { kind: "markdown", markdown: "\nDone." },
    ]);
    for (const markdown of [
      "Run:\n`! npm test`",
      "`! npm test` now",
      "`npm test`",
      "- `! npm test`",
      "> `! npm test`",
      "```\n`! npm test`\n```",
      "~~~\n```\n\n`! npm test`\n~~~",
    ]) {
      expect(splitShellCommandMarkdown(markdown)).toEqual([{ kind: "markdown", markdown }]);
    }
    const tapped = codeBlockRunnableCommand({
      code: "! npm test\n",
      language: "",
      streaming: false,
      markdown: "`! npm test`",
    });
    expect(tapped).toBe("npm test");
  });
});
