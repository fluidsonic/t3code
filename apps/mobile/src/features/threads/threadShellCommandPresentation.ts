import {
  shellCommandFromInlineCode,
  shellCommandsFromUntaggedCodeBlock,
  userShellCommandFromCodeBlock,
} from "@t3tools/client-runtime/user-shell-command";

/**
 * What a closed assistant code block can do with its command. Which blocks have one is
 * `userShellCommandFromCodeBlock`'s rule: untagged `! cmd` blocks and sh/bash/zsh/shell blocks.
 */
export interface CodeBlockShellActions {
  /** Runs it as a `! cmd` message, as if sent from the composer. */
  readonly runCommand?: ((command: string) => void) | undefined;
  /** Runs several in order as one group: each after the one before succeeds. */
  readonly runCommands?: ((commands: ReadonlyArray<string>) => void) | undefined;
  /** Puts it into the composer in shell mode. */
  readonly editCommand?: ((command: string) => void) | undefined;
  /** Puts it on a thread terminal's prompt without running it. */
  readonly editInTerminal?: ((command: string) => void) | undefined;
}

// A shell-language fence, or an untagged fence followed by a `!` line. A coarse prefilter (a
// closing fence matches too) that only decides whether to arm block taps; the tapped block's own
// code and language decide what runs.
const SHELL_LANGUAGE_FENCE = /^[ \t>]*(?:`{3,}|~{3,})[ \t]*(?:sh|bash|zsh|shell)\b/im;
const UNTAGGED_COMMAND_FENCE =
  /^[ \t>]*(?:`{3,}|~{3,})[ \t]*\r?\n(?:[ \t>]*(?:#.*)?\r?\n)*[ \t>]*!/m;

// An inline `! cmd` span; see `linkInlineShellCommands`.
const INLINE_COMMAND = /`! \S/;

export function markdownMayHaveShellCommand(markdown: string): boolean {
  return (
    SHELL_LANGUAGE_FENCE.test(markdown) ||
    UNTAGGED_COMMAND_FENCE.test(markdown) ||
    INLINE_COMMAND.test(markdown)
  );
}

// A fence line, after any blockquote markers: its marker run and what follows on the line.
const FENCE_LINE = /^[ \t>]*(`{3,}|~{3,})(.*)$/;

// A fence that opens at the top level, untagged: one that may hold `! cmd` lines. Only one at the
// line's start: an indented fence is usually a list item's, which must stay in its list.
const TOP_LEVEL_UNTAGGED_FENCE = /^(`{3,}|~{3,})[ \t]*$/;

export type ShellCommandMarkdownSegment =
  | { readonly kind: "markdown"; readonly markdown: string }
  | {
      readonly kind: "commands";
      /** The block as written, for Copy. */
      readonly code: string;
      /** What each row runs, without its `!`. */
      readonly commands: ReadonlyArray<string>;
    };

/**
 * `markdown` with its command blocks taken out, to render as on the web: each closed top-level
 * untagged `! cmd` block becomes a command block of its own; the rest stays markdown. Blocks in
 * lists and blockquotes, which are indented or quoted, stay as written: taking them out would
 * break the list or quote apart.
 */
export function splitShellCommandMarkdown(
  markdown: string,
): ReadonlyArray<ShellCommandMarkdownSegment> {
  const segments: Array<ShellCommandMarkdownSegment> = [];
  let output: string[] = [];
  let fence: string | null = null;
  // Where an untagged top-level fence's lines start in `output`, while it is open.
  let untaggedFenceStart: number | null = null;
  const pushCommands = (code: string, commands: ReadonlyArray<string>) => {
    if (output.some((line) => line.trim().length > 0)) {
      segments.push({ kind: "markdown", markdown: output.join("\n") });
    }
    output = [];
    segments.push({ kind: "commands", code, commands });
  };
  for (const line of markdown.split(/\r\n|\r|\n/)) {
    const fenceLine = FENCE_LINE.exec(line);
    if (fence !== null) {
      if (
        fenceLine &&
        fenceLine[1]![0] === fence[0] &&
        fenceLine[1]!.length >= fence.length &&
        fenceLine[2]!.trim().length === 0
      ) {
        const code =
          untaggedFenceStart === null ? null : output.slice(untaggedFenceStart + 1).join("\n");
        const commands = code === null ? null : shellCommandsFromUntaggedCodeBlock(code);
        if (code !== null && commands !== null && untaggedFenceStart !== null) {
          output.length = untaggedFenceStart;
          pushCommands(code, commands);
        } else {
          output.push(line);
        }
        fence = null;
        untaggedFenceStart = null;
        continue;
      }
      output.push(line);
      continue;
    }
    // A backtick fence's info string can't contain a backtick; that line is inline code.
    if (fenceLine && !(fenceLine[1]!.startsWith("`") && fenceLine[2]!.includes("`"))) {
      untaggedFenceStart = TOP_LEVEL_UNTAGGED_FENCE.test(line) ? output.length : null;
      output.push(line);
      fence = fenceLine[1]!;
      continue;
    }
    output.push(line);
  }
  if (output.some((line) => line.trim().length > 0)) {
    segments.push({ kind: "markdown", markdown: output.join("\n") });
  }
  return segments;
}

const SHELL_COMMAND_LINK = "t3-shell-command://v1/";
// A single-backtick `! cmd` span: not part of a longer backtick run, escaped, or a link's text.
const INLINE_COMMAND_SPAN = /(^|[^`\\[])(`(! [^`]+)`)(?!`|\]\()/g;

/**
 * `markdown` with each inline `! cmd` span outside code blocks made a link to its command, so the
 * native text, which can't hold buttons, opens the command's actions where it is tapped.
 */
export function linkInlineShellCommands(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const fenceLine = FENCE_LINE.exec(line);
      if (fence !== null) {
        const closes =
          fenceLine &&
          fenceLine[1]![0] === fence[0] &&
          fenceLine[1]!.length >= fence.length &&
          fenceLine[2]!.trim().length === 0;
        if (closes) fence = null;
        return line;
      }
      if (fenceLine && !(fenceLine[1]!.startsWith("`") && fenceLine[2]!.includes("`"))) {
        fence = fenceLine[1]!;
        return line;
      }
      return line.replace(
        INLINE_COMMAND_SPAN,
        (match, before: string, span: string, code: string) => {
          const command = shellCommandFromInlineCode(code);
          if (command === null) return match;
          // Parentheses would end the link's destination.
          const href = encodeURIComponent(command).replace(/[()]/g, (paren) =>
            paren === "(" ? "%28" : "%29",
          );
          return `${before}[${span}](${SHELL_COMMAND_LINK}${href})`;
        },
      );
    })
    .join("\n");
}

/** The command a link from `linkInlineShellCommands` stands for, or null for any other link. */
export function shellCommandFromLink(href: string): string | null {
  if (!href.startsWith(SHELL_COMMAND_LINK)) return null;
  try {
    return decodeURIComponent(href.slice(SHELL_COMMAND_LINK.length));
  } catch {
    return null;
  }
}

/** The code of a fence `markdown` leaves open at its end, as an interrupted reply does. */
function trailingOpenFenceCode(markdown: string): string | null {
  let open: { readonly marker: string; readonly lines: string[] } | null = null;
  for (const line of markdown.split(/\r\n|\r|\n/)) {
    const fence = FENCE_LINE.exec(line);
    if (open === null) {
      // A backtick fence's info string can't contain a backtick; that line is inline code.
      if (fence && !(fence[1]!.startsWith("`") && fence[2]!.includes("`"))) {
        open = { marker: fence[1]!, lines: [] };
      }
      continue;
    }
    if (
      fence &&
      fence[1]![0] === open.marker[0] &&
      fence[1]!.length >= open.marker.length &&
      fence[2]!.trim().length === 0
    ) {
      open = null;
      continue;
    }
    open.lines.push(line);
  }
  return open === null ? null : open.lines.join("\n");
}

/**
 * The command a tapped code block runs. Like the web, only a closed fence runs: a block still
 * streaming, or one an interrupted reply left open, may be missing the rest of its command.
 */
export function codeBlockRunnableCommand(input: {
  readonly code: string;
  /** The fence's language, empty for an untagged fence. */
  readonly language: string;
  readonly streaming: boolean;
  /** The message the block is in. */
  readonly markdown: string;
}): string | null {
  if (input.streaming) return null;
  // Only the last block can be open, and the renderer doesn't say which block was tapped.
  const openCode = trailingOpenFenceCode(input.markdown);
  if (openCode !== null && openCode.trim() === input.code.trim()) return null;
  return userShellCommandFromCodeBlock(input.code.replace(/\r\n?/g, "\n"), input.language);
}
