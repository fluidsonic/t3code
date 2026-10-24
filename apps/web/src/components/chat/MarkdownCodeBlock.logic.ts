import { Children, isValidElement, type ReactNode } from "react";
import type { ExtraProps as ReactMarkdownExtraProps } from "react-markdown";

import { fnv1a32, type DiffThemeName } from "../../lib/diffRendering";

/**
 * What a closed assistant code block can do with the command it shows. Which blocks offer the
 * command actions is `userShellCommandFromCodeBlock`'s rule, and for untagged blocks
 * `shellCommandsFromUntaggedCodeBlock`'s.
 */
export interface CodeBlockShellActions {
  /** Runs a one-line command in the terminal drawer. */
  readonly runInTerminal?: ((command: string) => void) | undefined;
  /** Runs the block's command as a shell command message, as if sent from the composer. */
  readonly runCommand?: ((command: string) => void) | undefined;
  /**
   * Runs several in order, each as its own command message, each after the one before succeeds.
   * When one fails, the agent hears which did not run.
   */
  readonly runCommands?: ((commands: ReadonlyArray<string>) => void) | undefined;
  /** Puts the command into the composer in shell mode. */
  readonly editCommand?: ((command: string) => void) | undefined;
  /** Puts the command on the prompt of the terminal Run in terminal uses, without running it. */
  readonly editInTerminal?: ((command: string) => void) | undefined;
  /** Types the command at the cursor of the terminal on screen, without running it. */
  readonly copyToTerminal?: ((command: string) => void) | undefined;
  /** Whether a terminal is on screen to copy to; read when the actions menu opens. */
  readonly canCopyToTerminal?: (() => boolean) | undefined;
}

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;

/** The fence's own language tag, or null for an untagged fence. */
export function extractFenceLanguageTag(className: string | undefined): string | null {
  return className?.match(CODE_FENCE_LANGUAGE_REGEX)?.[1] ?? null;
}

export function extractFenceLanguage(className: string | undefined): string {
  const raw = extractFenceLanguageTag(className) ?? "text";
  // Shiki doesn't bundle a gitignore grammar; ini is a close match.
  return raw === "gitignore" ? "ini" : raw;
}

const FENCE_TITLE_ATTR_REGEX = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const FENCE_FILENAME_TOKEN_REGEX = /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/;

export function extractFenceTitle(meta: string | undefined): string | null {
  if (!meta) return null;
  const attrMatch = FENCE_TITLE_ATTR_REGEX.exec(meta);
  const attrTitle = attrMatch?.[1] ?? attrMatch?.[2] ?? attrMatch?.[3];
  if (attrTitle) return attrTitle;
  return meta.split(/\s+/).find((candidate) => FENCE_FILENAME_TOKEN_REGEX.test(candidate)) ?? null;
}

export function extractPreCodeMeta(node: unknown): string | undefined {
  const children = (
    node as
      | {
          children?: Array<{
            type?: string;
            tagName?: string;
            data?: { meta?: unknown };
            properties?: { dataCodeMeta?: unknown };
          }>;
        }
      | undefined
  )?.children;
  const codeNode = children?.find((child) => child?.type === "element" && child.tagName === "code");
  const meta = codeNode?.properties?.dataCodeMeta ?? codeNode?.data?.meta;
  return typeof meta === "string" && meta.trim().length > 0 ? meta.trim() : undefined;
}

export function isClosedCodeFence(
  node: ReactMarkdownExtraProps["node"],
  text: string,
  code: string,
): boolean {
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  if (start === undefined || end === undefined) return false;
  const source = text.slice(start, end);
  const opening = /^(?:`{3,}|~{3,})/.exec(source)?.[0];
  // One class for the blockquote prefix: nested quantifiers here backtrack
  // exponentially on code lines that start with many `> ` markers.
  const closing = /(?:^|\n)[ \t>]*(`{3,}|~{3,})[ \t\r]*$/.exec(source)?.[1];
  return (
    opening !== undefined &&
    closing !== undefined &&
    opening[0] === closing[0] &&
    closing.length >= opening.length &&
    // Only a real closer is omitted from parsed code. A CRLF stream cut after
    // CR must not count as an extra source line.
    source.replace(/\r$/, "").split(/\r\n|\r|\n/).length > code.split(/\r\n|\r|\n/).length
  );
}

export function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

export function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  if (
    !isValidElement<{ className?: string; children?: ReactNode; node?: { tagName?: string } }>(
      onlyChild,
    )
  ) {
    return null;
  }
  // With a custom `code` component the child's type is that component, not
  // the "code" tag — the hast node react-markdown attaches still names it.
  if (onlyChild.type !== "code" && onlyChild.props.node?.tagName !== "code") {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

export function createHighlightCacheKey(
  code: string,
  language: string,
  themeName: DiffThemeName,
): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

export function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}
