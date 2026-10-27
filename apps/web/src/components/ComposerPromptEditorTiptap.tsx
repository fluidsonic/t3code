import { documentIconColorForFileName } from "~/pierre-icons";
import { isProviderSkillUserInvocable } from "@t3tools/client-runtime/providerSkills";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import {
  Extension,
  findChildren,
  InputRule,
  Node,
  wrappingInputRule,
  type JSONContent,
  type TiptapEditorHTMLElement,
} from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { newlineInCode, splitBlockKeepMarks } from "@tiptap/pm/commands";
import { closeHistory, isHistoryTransaction } from "@tiptap/pm/history";
import {
  type EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { DocAttrStep, ReplaceStep } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { NodeType, ResolvedPos, Slice } from "@tiptap/pm/model";
import type {
  AssistantCitation,
  ComposerContextClipboardFragment,
  ServerProviderSkill,
} from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { EditorContent, useEditor } from "@tiptap/react";

import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  expandCollapsedComposerCursor,
  pastedPathQueryLength,
} from "~/composer-logic";
import { useStableCallback } from "~/hooks/useStableCallback";
import { caretLineDirection, ComposerTextDirectionExtension } from "~/composer-text-direction";
import {
  collectComposerPromptInlineTokens,
  selectionTouchesMentionBoundary,
} from "~/composer-editor-mentions";
import {
  buildDocJson,
  ComposerBlockExtensions,
  ComposerCodeBlockExtension,
  ComposerListExtensions,
  buildTiptapContent,
  caretTakesMarksBefore,
  ComposerBoldSelectionOnlyExtension,
  convertBulletItemToTask,
  ComposerCodeExtension,
  ComposerItalicExtension,
  ComposerTaskItemExtension,
  ComposerTaskListExtension,
  flatToMarkdown,
  flatToPm,
  markdownToFlat,
  pmToFlat,
  serializeEditorDoc,
  serializeSelection,
  skillChipReplacements,
  splitOrLiftListItem,
  stepCaretAcrossStyledEdge,
  type SkillMeta,
} from "~/composer-rich-text-doc";
import {
  convertCodeFenceOnEnter,
  exitCodeBlockOnClosingFence,
  exitCodeBlockOnTrailingBlankLines,
  indentCodeBlock,
  indentedNewlineInCodeBlock,
  selectionInOneCodeBlock,
} from "~/composer-code-block";
import {
  COMPOSER_UNDO_GROUP_DELAY,
  type ComposerChangeKind,
  groupUndoByChangeKind,
  joinPreviousUndoStep,
  markAsClipboardEdit,
} from "~/composer-undo-grouping";
import { collectInlineContextIds } from "~/lib/composerContextReferences";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { cn, isMacPlatform } from "~/lib/utils";
import { basenameOfPath } from "~/pierre-icons";
import { WorkspaceEntryTooltip } from "./chat/WorkspaceEntryIcon";
import { FileTagChipContent } from "./chat/FileTagChip";
import { SkillChipPopover, skillPopoverDescription } from "./chat/SkillInlineText";
import { AssistantCitationChip } from "./chat/AssistantCitationChip";
import { getTimelinePageScrollKey } from "./chat/pageScrollController";
import { ContextChip } from "./ContextChip";
import {
  ComposerContextActionsContext,
  ComposerContextReferenceChip,
  ComposerContextRecordsContext,
} from "./composerContextPresentation";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ComposerCodeBlockNodeView } from "./chat/ComposerCodeBlockNodeView";
import { resolveAssistantCitationCommentDismissal } from "./chat/assistantCitationCommentDismissal";
import { composerCodeBlockHighlight } from "./composerCodeBlockHighlight";
import { importPastedComposerText } from "./composerInlineTokenPaste";
import { didComposerSelectionChangeVisibly } from "./composerSelection";
import type { ComposerDraftContextRecords } from "./composerContextPresentation";

export interface ComposerPromptEditorHandle {
  focus: () => void;
  focusAt: (cursor: number) => void;
  focusAtEnd: () => void;
  readSelectionRange: () => { start: number; end: number };
  requestCitationComment: (request: ComposerCitationCommentRequest) => void;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  };
  isCaretOnVisualEdge: (edge: "start" | "end") => boolean;
}

export interface ComposerPromptEditorProps {
  draftKey?: string;
  value: string;
  cursor: number;
  richTextEnabled?: boolean;
  literalText?: boolean;
  /**
   * Shell commands are in play for this composer: they are on, or the draft is still a command.
   * Without it the editor is the one from before shell commands, and `shellCommand` is ignored.
   * Toggling it remounts the editor once.
   */
  shellFeatureActive?: boolean;
  /** A `! cmd` shell command: literal text with a styled leading `!`. */
  shellCommand?: boolean;
  contextRecords: ComposerDraftContextRecords;
  buildContextClipboardFragment?:
    | ((contextIds: ReadonlyArray<string>) => string | null)
    | undefined;
  importContextFragment?:
    | ((fragment: ComposerContextClipboardFragment) => ReadonlyMap<string, string>)
    | undefined;
  skills: ReadonlyArray<ServerProviderSkill>;
  disabled: boolean;
  placeholder: string;
  ariaLabel?: string | undefined;
  suggestionListId?: string | undefined;
  activeSuggestionId?: string | undefined;
  isPathQueryActive?: () => boolean;
  containerClassName?: string;
  className?: string;
  placeholderClassName?: string;
  onChange: (
    nextValue: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    contextIds: string[],
    /**
     * Set when undo or redo brought back the other shell mode. The owner adopts it instead of
     * deriving the mode from the text, which cannot tell a command `!` from a prose one.
     */
    restoredShellCommand?: boolean,
  ) => void;
  onVisibleSelectionChange?: () => void;
  onCommandKeyDown?: (key: string, event: KeyboardEvent, isTaskItem?: boolean) => boolean;
  onPageScrollKeyDown?: (key: "PageUp" | "PageDown") => void;
  onPageScrollKeyUp?: (key: string) => void;
  onPageScrollRelease?: () => void;
  onCitationSubmitAndSend?: () => void;
  /** Saves unsaved citation text into replacedValue when a controlled rewrite replaces the document. */
  onCitationDraftSave?: (replacedValue: string, savedValue: string) => void;
  onPaste: React.ClipboardEventHandler<HTMLElement>;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
}

export type ComposerCitationCommentRequest = {
  previousValue: string;
  value: string;
  citationStart: number;
  sourceAnchor: AssistantCitationSourceAnchor;
  insertedSpaces: CitationInsertedSpaces;
};

type CitationInsertedSpaces = { before: boolean; after: boolean };

type OpenCitationComment = {
  key: string;
  sourceAnchor?: AssistantCitationSourceAnchor;
  removeOnCancel?: CitationInsertedSpaces;
};

const ComposerCitationCommentContext = createContext<{
  openComment: OpenCitationComment | null;
  onOpenChange: (citeKey: string, open: boolean) => void;
  onDraftChange: (citeKey: string, comment: string) => void;
  onSubmitAndSend: () => void;
}>({
  openComment: null,
  onOpenChange: () => {},
  onDraftChange: () => {},
  onSubmitAndSend: () => {},
});

const RichComposerSkillsContext = createContext<ReadonlyArray<ServerProviderSkill>>([]);

const SURROUND_CLOSE: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  "'": "'",
  '"': '"',
  "“": "”",
  "`": "`",
  "<": ">",
  "«": "»",
  "*": "*",
  _: "_",
};

function resolvedThemeFromDocument(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

const CHIP_NODE_SELECTION_CLASS_NAME =
  "relative inline-flex select-none items-center align-middle leading-none data-[composer-chip-selected]:after:pointer-events-none data-[composer-chip-selected]:after:absolute data-[composer-chip-selected]:after:inset-0 data-[composer-chip-selected]:after:rounded-sm data-[composer-chip-selected]:after:bg-[Highlight] data-[composer-chip-selected]:after:opacity-30 data-[composer-chip-selected]:after:content-['']";

const ComposerMentionExtension = Node.create({
  name: "composer-mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      path: { default: "" },
      source: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-composer-mention]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-composer-mention": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerMentionNodeView);
  },
});

function ComposerMentionNodeView({ node }: NodeViewProps) {
  const actions = use(ComposerContextActionsContext);
  const path = (node.attrs.path as string) ?? "";
  const accent = documentIconColorForFileName(path);
  const chip = (
    <ContextChip
      kind="mention"
      style={accent ? ({ "--context-chip-accent": accent } as CSSProperties) : undefined}
      dir="ltr"
      render={<button type="button" />}
      onClick={() => actions.openMention(path)}
      aria-label={`Preview ${path}`}
      contentEditable={false}
      spellCheck={false}
      data-composer-mention-chip="true"
    >
      <FileTagChipContent
        path={path}
        environmentId={actions.environmentId}
        cwd={actions.cwd}
        label={basenameOfPath(path)}
        theme={resolvedThemeFromDocument()}
      />
    </ContextChip>
  );
  return (
    <NodeViewWrapper as="span" className={CHIP_NODE_SELECTION_CLASS_NAME}>
      <Tooltip>
        <TooltipTrigger render={chip} />
        <TooltipPopup side="top">
          <WorkspaceEntryTooltip
            path={path}
            environmentId={actions.environmentId}
            cwd={actions.cwd}
          />
        </TooltipPopup>
      </Tooltip>
    </NodeViewWrapper>
  );
}

const ComposerSkillExtension = Node.create({
  name: "composer-skill",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      skillName: { default: "" },
      skillLabel: { default: "" },
      skillDescription: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-composer-skill]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-composer-skill": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerSkillNodeView);
  },
});

/** Chip presentation for `$name`, or null when the provider does not offer it to users. */
function composerSkillMeta(
  skills: ReadonlyArray<ServerProviderSkill>,
  name: string,
): SkillMeta | null {
  const skill = skills.find(
    (candidate) => candidate.name === name && isProviderSkillUserInvocable(candidate),
  );
  if (!skill) return null;
  const shortDescription = skill.shortDescription?.trim();
  return {
    label: formatProviderSkillDisplayName(skill),
    description: shortDescription || skill.description?.trim() || null,
  };
}

function ComposerSkillNodeView({ node }: NodeViewProps) {
  const actions = use(ComposerContextActionsContext);
  const skills = use(RichComposerSkillsContext);
  const skillName = (node.attrs.skillName as string) ?? "";
  const skillDescription = (node.attrs.skillDescription as string | null) ?? null;
  const skill = skills.find(
    (candidate) => candidate.name === skillName && isProviderSkillUserInvocable(candidate),
  );
  // The node outlives a provider switch, so its stored label can be another provider's.
  const skillLabel = skill
    ? formatProviderSkillDisplayName(skill)
    : (node.attrs.skillLabel as string) || skillName;
  return (
    <NodeViewWrapper as="span" className={CHIP_NODE_SELECTION_CLASS_NAME}>
      <SkillChipPopover
        label={skillLabel}
        description={skill ? skillPopoverDescription(skill) : skillDescription}
        onViewInstructions={
          skill?.path && actions.environmentId ? () => actions.openMention(skill.path) : undefined
        }
      />
    </NodeViewWrapper>
  );
}

const ComposerCitationExtension = Node.create({
  name: "composer-citation",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      citation: { default: null },
      source: { default: "" },
      citeKey: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-composer-citation]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-composer-citation": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerCitationNodeView);
  },
});

function ComposerCitationNodeView({ node, editor, getPos }: NodeViewProps) {
  const commentContext = use(ComposerCitationCommentContext);
  const citation = node.attrs.citation as AssistantCitation;
  const citeKey = node.attrs.citeKey as string;
  const commentTarget =
    commentContext.openComment?.key === citeKey ? commentContext.openComment : null;

  const nodePos = () => {
    const pos = typeof getPos === "function" ? getPos() : null;
    return typeof pos === "number" ? pos : null;
  };

  const onSaveComment = (comment: string): boolean => {
    if (!editor.isEditable) return false;
    const pos = nodePos();
    if (pos === null) return false;
    const current = editor.state.doc.nodeAt(pos);
    if (!current || current.type.name !== "composer-citation") return false;
    const currentCitation = current.attrs.citation as AssistantCitation;
    const next = withAssistantCitationComment(currentCitation, comment);
    const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
      ...current.attrs,
      citation: next,
      source: serializeAssistantCitation(next),
    });
    editor.view.dispatch(tr);
    return true;
  };

  const removeOnCancel = commentTarget?.removeOnCancel;
  const onRemove = () => {
    if (!editor.isEditable || !removeOnCancel) return;
    const pos = nodePos();
    if (pos === null) return;
    const { doc } = editor.state;
    const current = doc.nodeAt(pos);
    if (!current) return;
    const end = pos + current.nodeSize;
    const from = removeOnCancel.before && doc.textBetween(pos - 1, pos) === " " ? pos - 1 : pos;
    const to = removeOnCancel.after && doc.textBetween(end, end + 1) === " " ? end + 1 : end;
    editor.chain().focus().deleteRange({ from, to }).run();
  };

  const onRestoreFocus = () => {
    if (!editor.isEditable) return;
    const pos = nodePos();
    if (pos === null) return;
    const current = editor.state.doc.nodeAt(pos);
    if (!current || current.type.name !== "composer-citation") return;
    editor.commands.focus(pos + current.nodeSize);
  };

  return (
    <NodeViewWrapper
      as="span"
      className={cn(CHIP_NODE_SELECTION_CLASS_NAME, "min-w-0 max-w-full")}
      contentEditable={false}
      spellCheck={false}
      data-composer-citation-chip="true"
      onKeyDown={(event: ReactKeyboardEvent<HTMLElement>) => {
        if (
          !editor.isEditable ||
          event.key !== "Tab" ||
          event.shiftKey ||
          event.altKey ||
          event.metaKey ||
          event.ctrlKey ||
          !(event.target instanceof HTMLElement) ||
          event.target.dataset.citationCommentTrigger === undefined
        ) {
          return;
        }
        event.preventDefault();
        onRestoreFocus();
      }}
    >
      <AssistantCitationChip
        citation={citation}
        composer
        commentEditor={{
          open: commentTarget !== null,
          sourceAnchor: commentTarget?.sourceAnchor,
          onOpenChange: (open) => {
            if (open && !editor.isEditable) return;
            commentContext.onOpenChange(citeKey, open);
          },
          ...(removeOnCancel ? { onCancel: onRemove } : {}),
          onSave: onSaveComment,
          onDraftChange: (comment) => commentContext.onDraftChange(citeKey, comment),
          onSaveAndSend: (comment) => {
            if (!onSaveComment(comment)) return false;
            commentContext.onSubmitAndSend();
            return true;
          },
          onRestoreFocus,
        }}
      />
    </NodeViewWrapper>
  );
}

const ComposerContextReferenceExtension = Node.create({
  name: "composer-context-reference",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      kind: { default: "" },
      contextId: { default: "" },
      label: { default: "" },
      source: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-composer-context-reference]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-composer-context-reference": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerContextReferenceNodeView);
  },
});

function ComposerContextReferenceNodeView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" className={CHIP_NODE_SELECTION_CLASS_NAME}>
      <ComposerContextReferenceChip
        kind={(node.attrs.kind as string) ?? ""}
        contextId={(node.attrs.contextId as string) ?? ""}
        label={(node.attrs.label as string) ?? ""}
      />
    </NodeViewWrapper>
  );
}

type StyledRange = {
  from: number;
  to: number;
  markers: { at: number; side: number; text: string }[];
};

function collectStyledRanges(doc: ProseMirrorNode): StyledRange[] {
  const ranges: StyledRange[] = [];
  const map = serializeEditorDoc(doc);
  let range: StyledRange | null = null;
  let openLength = 0;
  for (const run of map.runs) {
    if (run.nodeName === "codeBlock") continue;
    if (run.openLen > 0) {
      range ??= { from: run.pmPos, to: run.pmPos, markers: [] };
      range.markers.push({
        at: run.pmPos,
        side: -1,
        text: map.value.slice(run.mdStart, run.mdStart + run.openLen),
      });
    }
    if (range === null) continue;
    range.to = run.pmPos + run.docLen;
    if (run.closeLen > 0) {
      const end = run.mdStart + run.mdLen;
      range.markers.push({
        at: range.to,
        side: -2,
        text: map.value.slice(end - run.closeLen, end),
      });
    }
    openLength += run.openLen - run.closeLen;
    if (openLength === 0) {
      ranges.push(range);
      range = null;
    }
  }
  return ranges;
}

/** Wait for a character after '- ' so task markers reach their input rule before becoming bullets. */
function listMarkerInputRule(find: RegExp, listType: "bulletList" | "orderedList"): InputRule {
  return new InputRule({
    find,
    handler: ({ state, range, match, chain }) => {
      const marker = match.groups?.marker ?? "-";
      const space = match.groups?.space ?? " ";
      const carried = match.groups?.carried ?? "";
      // Nested lists would serialize flat, so accept only top-level paragraphs.
      const $from = state.doc.resolve(range.from);
      if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
      const command = chain()
        .deleteRange(range)
        .wrapInList(
          listType,
          listType === "orderedList" ? { start: Number.parseInt(marker, 10) || 1 } : {},
        )
        .updateAttributes("listItem", { marker, space });
      (carried ? command.insertContent(carried) : command).run();
      return undefined;
    },
  });
}

const bulletToTaskInputRule = new InputRule({
  find: /^\[([ xX])\] $/,
  handler: ({ state, range, match, chain }) => {
    const $from = state.doc.resolve(range.from);
    const item = $from.node(-1);
    if ($from.parent.type.name !== "paragraph" || item?.type.name !== "listItem") return null;
    if (!["-", "*", "+"].includes((item.attrs as { marker?: string }).marker ?? "")) return null;
    const checked = (match[1] ?? " ").toLowerCase() === "x";
    chain()
      .command(({ tr }) => {
        convertBulletItemToTask(tr, range.from, range.to, checked);
        return true;
      })
      .run();
    return undefined;
  },
});

function taskInputRule(type: NodeType): InputRule {
  const rule = wrappingInputRule({
    find: /^- \[([ xX])\] $/,
    type,
    getAttributes: (match) => ({ checked: match[1]?.toLowerCase() === "x" }),
  });
  return new InputRule({
    find: rule.find,
    handler: (props) =>
      props.state.doc.resolve(props.range.from).depth === 1 ? rule.handler(props) : null,
  });
}

function hasAncestor($pos: ResolvedPos, name: string): boolean {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === name) return true;
  }
  return false;
}

const blockquoteInputRule = new InputRule({
  find: /^>(\s)$/,
  handler: ({ state, range, match, chain }) => {
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
    chain()
      .deleteRange(range)
      .wrapIn("blockquote", { prefix: `>${match[1] ?? " "}` })
      .run();
    return undefined;
  },
});

/** Require a space after *** or ___ to preserve bold typing. Lists and quotes cannot serialize rules. */
const horizontalRuleInputRule = new InputRule({
  find: /^(---|\*\*\*|___)\s?$/,
  handler: ({ state, range, match, chain }) => {
    const source = match[0] ?? "---";
    if (!source.startsWith("---") && !/\s$/.test(source)) return null;
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
    chain()
      .deleteRange(range)
      .setHorizontalRule()
      .command(({ tr }) => {
        const $pos = tr.selection.$from;
        const index = $pos.index(0) - 1;
        if (index < 0) return true;
        const rulePos = $pos.posAtIndex(index, 0);
        const rule = tr.doc.nodeAt(rulePos);
        if (rule?.type.name === "horizontalRule") {
          tr.setNodeMarkup(rulePos, undefined, { ...rule.attrs, source });
        }
        return true;
      })
      .run();
    return undefined;
  },
});

/** Require a space to preserve PR references; lists and quotes cannot serialize headings. */
const headingInputRule = new InputRule({
  find: /^(#{1,6})(\s)$/,
  handler: ({ state, range, match, chain }) => {
    const $from = state.doc.resolve(range.from);
    if ($from.parent.type.name !== "paragraph" || $from.depth !== 1) return null;
    chain()
      .deleteRange(range)
      .setNode("heading", { level: match[1]?.length ?? 1, space: match[2] ?? " " })
      .run();
    return undefined;
  },
});

function isInCodeBlock(view: EditorView): boolean {
  return view.state.selection.$from.parent.type.spec.code === true;
}

const MarkerPluginKey = new PluginKey("composer-rich-markers");

const ComposerMarkerPlugin = new Plugin({
  key: MarkerPluginKey,
  state: {
    init: (_, state) => decorationsForSelection(state),
    apply: (tr, old, _, state) =>
      tr.docChanged || tr.selectionSet || tr.storedMarksSet ? decorationsForSelection(state) : old,
  },
  props: {
    decorations(state) {
      return MarkerPluginKey.getState(state);
    },
  },
});

function decorationsForSelection(state: EditorState): DecorationSet {
  const { doc, selection } = state;
  const caretSide = caretTakesMarksBefore(state) ? 3 : 0;
  const rtl = caretLineDirection(state) === "rtl";
  const decorations: Decoration[] = [];
  if (!selection.empty) {
    doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (node.type.name.startsWith("composer-")) {
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, { class: "composer-chip-range-selected" }),
        );
        return false;
      }
      return true;
    });
  }
  for (const range of collectStyledRanges(doc)) {
    const active = selection.empty
      ? selection.from >= range.from && selection.from <= range.to
      : selection.from < range.to && selection.to > range.from;
    if (!active) continue;
    for (const { at, side: baseSide, text } of range.markers) {
      const side = selection.empty && at === selection.from ? baseSide + caretSide : baseSide;
      const marker = document.createElement("span");
      marker.className = "composer-rich-marker";
      marker.textContent = text;
      marker.setAttribute("aria-hidden", "true");
      // Inline code is isolated left to right. In a right-to-left line its
      // opening backtick joins the closing one inside the isolate, or the line
      // would put both on the same side of the code.
      const codeMarks =
        rtl && baseSide === -1 && /^`+$/.test(text)
          ? doc.resolve(at).nodeAfter?.marks.filter((mark) => mark.type.spec.code)
          : undefined;
      decorations.push(
        Decoration.widget(at, marker, {
          side,
          key: `marker-${at}-${side}-${marker.textContent}`,
          ...(codeMarks?.length ? { marks: codeMarks } : {}),
        }),
      );
    }
  }
  return DecorationSet.create(doc, decorations);
}

const ComposerMarkersExtension = Extension.create({
  name: "composer-rich-markers",
  addProseMirrorPlugins() {
    return [ComposerMarkerPlugin];
  },
});

type TiptapEditor = NonNullable<ReturnType<typeof useEditor>>;

function replaceSkillChips(
  editor: TiptapEditor,
  replacements: ReturnType<typeof skillChipReplacements>,
): void {
  const transaction = editor.state.tr.setMeta("addToHistory", false);
  for (const { from, to, node } of replacements) transaction.replaceWith(from, to, node);
  editor.view.dispatch(transaction);
}

export function ComposerPromptEditorTiptap(props: ComposerPromptEditorProps) {
  const restoreFocusRef = useRef(false);
  const { onChange: onPromptChange } = props;
  const [selection, setSelection] = useState<{
    value: string;
    cursor: number;
    expandedCursor: number;
  } | null>(null);
  const onChange: ComposerPromptEditorProps["onChange"] = (
    value,
    cursor,
    expandedCursor,
    ...rest
  ) => {
    setSelection({ value, cursor, expandedCursor });
    onPromptChange(value, cursor, expandedCursor, ...rest);
  };
  // Changing text mode remounts the editor. Its collapsed cursor cannot represent
  // a caret inside unknown `$name` text, so retain the exact Markdown offset here.
  // Shell mode is not a remount: its switch has to stay in the undo history. Whether shell
  // commands are in play at all is, since it picks the editor's extensions.
  const shellCommand = props.shellFeatureActive === true && props.shellCommand === true;
  return (
    <ComposerPromptEditorTiptapInner
      key={`${props.draftKey ?? ""}:${props.literalText && !shellCommand ? "literal" : props.richTextEnabled ? "rich" : "plain"}${props.shellFeatureActive ? ":shell" : ""}`}
      {...props}
      restoreFocusRef={restoreFocusRef}
      initialExpandedCursor={
        selection?.value === props.value && selection.cursor === props.cursor
          ? selection.expandedCursor
          : expandCollapsedComposerCursor(props.value, props.cursor, props.literalText)
      }
      onChange={onChange}
    />
  );
}

/** Decide grouping in dispatch middleware before the history plugin applies the transaction. */
const ComposerUndoGroupingExtension = Extension.create<
  Record<string, never>,
  { previous: ComposerChangeKind | null }
>({
  name: "composer-undo-grouping",
  addStorage() {
    return { previous: null };
  },
  dispatchTransaction({ transaction, next }) {
    this.storage.previous = groupUndoByChangeKind(transaction, this.storage.previous);
    next(transaction);
  },
});

// Module scope keeps extension identity stable; Tiptap hooks read config through this.
function createComposerExtensions(richText: boolean, shellCommands: boolean) {
  return [
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      link: false,
      orderedList: false,
      underline: false,
      dropcursor: false,
      gapcursor: false,
      trailingNode: false,
      code: false,
      listKeymap: false,
      undoRedo: { newGroupDelay: COMPOSER_UNDO_GROUP_DELAY },
      italic: false,
      ...(richText ? {} : { bold: false, strike: false }),
    }),
    ComposerUndoGroupingExtension,
    ComposerTextDirectionExtension,
    ComposerMentionExtension,
    ComposerSkillExtension,
    ComposerCitationExtension,
    ComposerContextReferenceExtension,
    ComposerMarkersExtension,
    ...(shellCommands ? [ComposerShellPrefixExtension] : []),
    ...(richText
      ? [
          ComposerBoldSelectionOnlyExtension,
          ComposerItalicExtension,
          ComposerCodeExtension,
          ComposerCodeBlockExtension.extend({
            addNodeView() {
              return ReactNodeViewRenderer(ComposerCodeBlockNodeView, {
                // Tiptap shields only the button; header clicks would move ProseMirror's selection.
                stopEvent: ({ event }) =>
                  event.target instanceof Element &&
                  event.target.closest(".chat-markdown-codeblock-header") !== null,
              });
            },
            // Tiptap's fence rule allows unserializable lists/quotes; use top-level Enter instead.
            addInputRules() {
              return [];
            },
          }),
          composerCodeBlockHighlight({
            resolveTheme: () =>
              resolveDiffThemeName(
                document.documentElement.classList.contains("dark") ? "dark" : "light",
              ),
          }),
          ...ComposerBlockExtensions.map((extension) =>
            extension.name === "blockquote"
              ? extension.extend({
                  addInputRules() {
                    return [blockquoteInputRule];
                  },
                })
              : extension.name === "horizontalRule"
                ? extension.extend({
                    addInputRules() {
                      return [horizontalRuleInputRule];
                    },
                  })
                : extension.name === "heading"
                  ? extension.extend({
                      addInputRules() {
                        return [headingInputRule];
                      },
                    })
                  : extension,
          ),
          ...ComposerListExtensions.map((extension) =>
            extension.name === "listItem"
              ? extension
              : extension.extend({
                  addInputRules() {
                    return this.name === "bulletList"
                      ? [
                          listMarkerInputRule(/^(?<marker>[*+])(?<space>\s)$/, "bulletList"),
                          listMarkerInputRule(
                            /^(?<marker>-)(?<space>[ \t]+)(?<carried>[^\s[])$/,
                            "bulletList",
                          ),
                        ]
                      : [listMarkerInputRule(/^(?<marker>\d+[.)])(?<space>\s)$/, "orderedList")];
                  },
                }),
          ),
          ComposerTaskListExtension,
          ComposerTaskItemExtension.extend({
            addInputRules() {
              return [taskInputRule(this.type), bulletToTaskInputRule];
            },
          }),
        ]
      : []),
  ];
}

const ShellPrefixPluginKey = new PluginKey("composer-shell-prefix");

/**
 * Shell mode lives on the document so that undo and redo carry it with the text: the mode a
 * step was made in comes back with the step.
 */
const SHELL_COMMAND_ATTR = "shellCommand";

function isShellCommandDoc(doc: ProseMirrorNode): boolean {
  return doc.attrs[SHELL_COMMAND_ATTR] === true;
}

function startsWithShellPrefix(doc: ProseMirrorNode): boolean {
  return doc.firstChild?.firstChild?.text?.startsWith("!") === true;
}

function shellPrefixGap(): HTMLElement {
  const gap = document.createElement("span");
  gap.className = "shell-command-gap";
  return gap;
}

function isLiteralSlice(slice: Slice): boolean {
  let literal = true;
  slice.content.descendants((node) => {
    if (node.isText ? node.marks.length > 0 : node.type.name !== "paragraph") literal = false;
    return literal;
  });
  return literal;
}

/**
 * Switches shell mode as one undo step. Entering rewrites the document as the literal lines of its
 * text, which keeps the prompt string as it was, and undo brings back the rich document.
 * `joinPrevious` folds the switch into the edit that caused it, so one undo reverts both.
 */
function shellModeTransaction(
  state: EditorState,
  shellCommand: boolean,
  joinPrevious: boolean,
): Transaction {
  const tr = state.tr.setDocAttribute(SHELL_COMMAND_ATTR, shellCommand);
  if (shellCommand) {
    const map = serializeEditorDoc(state.doc);
    const literal = state.schema.nodeFromJSON(
      buildDocJson(map.value, () => null, { literalText: true }),
    );
    if (!literal.content.eq(state.doc.content)) {
      const toMarkdown = (pos: number) => flatToMarkdown(map, pmToFlat(map, pos));
      const anchor = toMarkdown(state.selection.anchor);
      const head = toMarkdown(state.selection.head);
      tr.replaceWith(0, state.doc.content.size, literal.content);
      const literalMap = serializeEditorDoc(tr.doc);
      const toPm = (offset: number) => flatToPm(literalMap, markdownToFlat(literalMap, offset));
      tr.setSelection(TextSelection.create(tr.doc, toPm(anchor), toPm(head)));
    }
  }
  return joinPrevious ? joinPreviousUndoStep(tr) : tr;
}

/**
 * Shell mode: styles the leading `!` and draws the gap after it, and keeps the command literal.
 * The gap is not text, so a typed or pasted space right after the `!` is dropped instead of
 * doubling it. Inactive outside shell mode.
 */
const ComposerShellPrefixExtension = Extension.create({
  name: "composer-shell-prefix",
  addGlobalAttributes() {
    return [
      { types: ["doc"], attributes: { [SHELL_COMMAND_ATTR]: { default: false, rendered: false } } },
    ];
  },
  // Adding or removing the leading `!` switches the mode. As its own undo step, undo steps back
  // across the switch without also taking the typing before it.
  dispatchTransaction({ transaction, next }) {
    if (
      transaction.docChanged &&
      !isHistoryTransaction(transaction) &&
      startsWithShellPrefix(transaction.before) !== startsWithShellPrefix(transaction.doc)
    ) {
      closeHistory(transaction);
    }
    next(transaction);
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: ShellPrefixPluginKey,
        // The rich editor stays mounted in shell mode, so its marks, blocks and chips are refused
        // here, whichever shortcut, paste rule or drop brings them. History is exempt: undo
        // restores the document a step was made in.
        filterTransaction(tr) {
          if (!isShellCommandDoc(tr.doc) || isHistoryTransaction(tr)) return true;
          if (tr.storedMarksSet && tr.storedMarks?.length) return false;
          return tr.steps.every(
            (step) =>
              step instanceof DocAttrStep ||
              (step instanceof ReplaceStep && isLiteralSlice(step.slice)),
          );
        },
        appendTransaction(transactions, _oldState, state) {
          if (!isShellCommandDoc(state.doc) || !transactions.some((tr) => tr.docChanged)) {
            return null;
          }
          const first = state.doc.firstChild;
          if (!first?.isTextblock) return null;
          const spaces = /^!([ \t]+)/.exec(first.textContent)?.[1];
          return spaces === undefined ? null : state.tr.delete(2, 2 + spaces.length);
        },
        props: {
          decorations(state) {
            if (!isShellCommandDoc(state.doc) || !startsWithShellPrefix(state.doc)) return null;
            return DecorationSet.create(state.doc, [
              Decoration.inline(1, 2, { class: "shell-command-prefix" }),
              // Before the caret at the `!`'s end, so typing starts after the gap.
              Decoration.widget(2, shellPrefixGap, { side: -1, key: "shell-gap" }),
            ]);
          },
        },
      }),
    ];
  },
});

const RICH_TEXT_EXTENSIONS = createComposerExtensions(true, false);
const PLAIN_TEXT_EXTENSIONS = createComposerExtensions(false, false);
const SHELL_RICH_TEXT_EXTENSIONS = createComposerExtensions(true, true);
const SHELL_PLAIN_TEXT_EXTENSIONS = createComposerExtensions(false, true);

// The `!` of a shell command stays in the text, so the placeholder also shows beside it.
function showsPlaceholderFor(value: string, shellCommand: boolean): boolean {
  // A queued command's edit stays a command with its `!` deleted too.
  return value.length === 0 || (shellCommand && value === "!");
}

function ComposerPromptEditorTiptapInner(
  props: ComposerPromptEditorProps & {
    initialExpandedCursor: number;
    restoreFocusRef: RefObject<boolean>;
  },
) {
  const {
    value,
    cursor,
    richTextEnabled,
    shellFeatureActive = false,
    contextRecords,
    buildContextClipboardFragment,
    importContextFragment,
    skills,
    disabled,
    placeholder,
    ariaLabel,
    suggestionListId,
    activeSuggestionId,
    isPathQueryActive,
    containerClassName,
    className,
    placeholderClassName,
    onChange,
    onVisibleSelectionChange,
    onCommandKeyDown,
    onPageScrollKeyDown,
    onPageScrollKeyUp,
    onPageScrollRelease,
    onCitationSubmitAndSend,
    onCitationDraftSave,
    onPaste,
    editorRef,
    restoreFocusRef,
  } = props;
  // Without shell commands in play the editor has no shell extension, documents carry no shell
  // attribute, and every shell branch below is inert.
  const shellCommand = shellFeatureActive && (props.shellCommand ?? false);
  // Literal text outside shell mode is fixed for the editor's life, as the key remounts on it.
  // Shell mode switches within the editor, and editor callbacks read it off the document, which
  // runs ahead of these props after an undo.
  const fixedLiteralText = (props.literalText ?? false) && !shellCommand;
  const richTextMode = !fixedLiteralText && (richTextEnabled ?? false);
  const literalText = fixedLiteralText || shellCommand;
  const richText = richTextMode && !shellCommand;
  const isLiteralState = (state: EditorState) => fixedLiteralText || isShellCommandDoc(state.doc);
  const isRichState = (state: EditorState) => richTextMode && !isShellCommandDoc(state.doc);
  const clampEditorCursor = (text: string, position: number) =>
    literalText
      ? Math.max(
          0,
          Math.min(text.length, Number.isFinite(position) ? Math.floor(position) : text.length),
        )
      : clampCollapsedComposerCursor(text, position);
  const expandEditorCursor = (text: string, position: number) =>
    literalText ? position : expandCollapsedComposerCursor(text, position);

  const latestValueRef = useRef(value);
  // The editor config is built once, so its handlers reach the current callbacks through here.
  const readCallbacks = useStableCallback(() => ({
    onChange,
    onVisibleSelectionChange,
    onCommandKeyDown,
    isPathQueryActive,
    importContextFragment,
  }));

  // Stable so a skills refresh does not rerun the controlled-value effect.
  const skillLabelFor = useStableCallback((name: string) => composerSkillMeta(skills, name));

  const initialCursor = clampEditorCursor(value, cursor);
  const initialExpandedCursor = Math.max(0, Math.min(value.length, props.initialExpandedCursor));
  const snapshotRef = useRef({
    value,
    cursor: initialCursor,
    expandedCursor: initialExpandedCursor,
    contextIds: literalText ? [] : collectInlineContextIds(value),
  });
  const selectionRangeRef = useRef({ start: initialExpandedCursor, end: initialExpandedCursor });
  const isApplyingControlledUpdateRef = useRef(false);
  // Whether a shell mode switch now follows from an edit, and so undoes along with it.
  const editedSinceRenderRef = useRef(false);
  const hasAppliedControlledSelectionRef = useRef(false);
  const citationRequestRef = useRef<ComposerCitationCommentRequest | null>(null);
  const [openCitation, setOpenCitation] = useState<OpenCitationComment | null>(null);
  const citationDraftRef = useRef<{ key: string; comment: string } | null>(null);
  const [isEmpty, setIsEmpty] = useState(() => showsPlaceholderFor(value, shellCommand));

  const citationCommentActions = {
    openComment: openCitation,
    onOpenChange: (nodeKey: string, open: boolean) => {
      if (!open && citationDraftRef.current?.key === nodeKey) citationDraftRef.current = null;
      setOpenCitation((current) => {
        if (open) {
          if (current?.key === nodeKey) return current;
          return { key: nodeKey };
        }
        return current?.key === nodeKey ? null : current;
      });
    },
    onDraftChange: (nodeKey: string, comment: string) => {
      citationDraftRef.current = { key: nodeKey, comment };
    },
    onSubmitAndSend: onCitationSubmitAndSend ?? (() => {}),
  };

  const handleEditorChange = (updated: TiptapEditor, restoredShellCommand?: boolean) => {
    const map = serializeEditorDoc(updated.state.doc);
    const literal = isLiteralState(updated.state);
    const contextIds = literal ? [] : map.contextIds;
    const { from, to } = updated.state.selection;
    const fromFlat = pmToFlat(map, from);
    const toFlat = pmToFlat(map, to);
    const nextValue = map.value;
    const nextExpandedCursor = Math.max(
      0,
      Math.min(map.value.length, flatToMarkdown(map, fromFlat)),
    );
    const nextCursor = collapseExpandedComposerCursor(map.value, nextExpandedCursor, literal);
    const nextSelectionRange = {
      start: Math.min(nextExpandedCursor, flatToMarkdown(map, toFlat)),
      end: Math.max(nextExpandedCursor, flatToMarkdown(map, toFlat)),
    };
    const previousSelectionRange = selectionRangeRef.current;
    selectionRangeRef.current = nextSelectionRange;
    setIsEmpty(showsPlaceholderFor(nextValue, isShellCommandDoc(updated.state.doc)));
    const previousSnapshot = snapshotRef.current;
    const snapshotChanged = !(
      restoredShellCommand === undefined &&
      previousSnapshot.value === nextValue &&
      previousSnapshot.cursor === nextCursor &&
      previousSnapshot.expandedCursor === nextExpandedCursor &&
      previousSnapshot.contextIds.length === contextIds.length &&
      previousSnapshot.contextIds.every((id, index) => id === contextIds[index])
    );
    if (isApplyingControlledUpdateRef.current) return;
    if (!snapshotChanged) {
      if (didComposerSelectionChangeVisibly(previousSelectionRange, nextSelectionRange)) {
        readCallbacks().onVisibleSelectionChange?.();
      }
      return;
    }
    // Ignore selection-only updates while a controlled rewrite is pending to avoid overwriting the new
    // prompt.
    if (
      restoredShellCommand === undefined &&
      previousSnapshot.value === nextValue &&
      nextValue !== latestValueRef.current
    ) {
      return;
    }
    snapshotRef.current = {
      value: nextValue,
      cursor: nextCursor,
      expandedCursor: nextExpandedCursor,
      contextIds,
    };
    const inCodeBlock = updated.state.selection.$from.parent.type.spec.code === true;
    const suppressTrigger =
      literal ||
      inCodeBlock ||
      [updated.state.selection.$from.nodeBefore, updated.state.selection.$from.nodeAfter].some(
        (node) => node?.isInline && node.isAtom && !node.isText && node.type.name !== "hardBreak",
      );
    readCallbacks().onChange(
      nextValue,
      nextCursor,
      nextExpandedCursor,
      suppressTrigger,
      contextIds,
      restoredShellCommand,
    );
  };

  const editorAttributes = {
    class: cn(
      "composer-tiptap -m-1 block max-h-52 min-h-12 overflow-y-auto p-1 whitespace-pre-wrap wrap-break-word bg-transparent leading-relaxed text-foreground focus:outline-none",
      shellCommand && "shell-command-text",
      className,
    ),
    "data-testid": "composer-editor",
    "data-composer-rich-text": richText ? "true" : "false",
    role: "textbox",
    "aria-multiline": "true",
    ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
    ...(disabled ? { "aria-readonly": "true" } : {}),
    ...(!disabled && suggestionListId
      ? {
          "aria-autocomplete": "list",
          "aria-haspopup": "listbox",
          ...(activeSuggestionId
            ? {
                "aria-controls": suggestionListId,
                "aria-activedescendant": activeSuggestionId,
              }
            : {}),
        }
      : {}),
    "aria-placeholder": placeholder,
  };

  const editor = useEditor(
    {
      extensions: shellFeatureActive
        ? richTextMode
          ? SHELL_RICH_TEXT_EXTENSIONS
          : SHELL_PLAIN_TEXT_EXTENSIONS
        : richTextMode
          ? RICH_TEXT_EXTENSIONS
          : PLAIN_TEXT_EXTENSIONS,
      content: {
        ...buildDocJson(value, (name) => composerSkillMeta(skills, name), {
          styling: richText,
          literalText,
        }),
        ...(shellFeatureActive ? { attrs: { [SHELL_COMMAND_ATTR]: shellCommand } } : {}),
      },
      editable: !disabled,
      editorProps: {
        attributes: editorAttributes,
        handleKeyDown: (view, event) => {
          const rich = isRichState(view.state);
          // In a right-to-left line the start is on the right.
          const backArrow = caretLineDirection(view.state) === "rtl" ? "ArrowRight" : "ArrowLeft";
          const boundary = event.metaKey
            ? event.key === "ArrowLeft" || event.key === "ArrowRight"
              ? "lineboundary"
              : event.key === "ArrowUp" || event.key === "ArrowDown"
                ? "documentboundary"
                : null
            : event.key === "Home" || event.key === "End"
              ? "lineboundary"
              : null;
          if (
            isMacPlatform(navigator.platform) &&
            boundary &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.isComposing
          ) {
            const selection = window.getSelection();
            if (
              selection?.anchorNode &&
              view.dom.contains(selection.anchorNode) &&
              typeof selection.modify === "function"
            ) {
              event.preventDefault();
              event.stopPropagation();
              const backward =
                event.key === "Home" || event.key === "ArrowUp" || event.key === backArrow;
              selection.modify(
                event.shiftKey ? "extend" : "move",
                backward ? "backward" : "forward",
                boundary,
              );
              if (selection.anchorNode && selection.focusNode) {
                const tr = view.state.tr.setSelection(
                  TextSelection.create(
                    view.state.doc,
                    view.posAtDOM(selection.anchorNode, selection.anchorOffset),
                    view.posAtDOM(selection.focusNode, selection.focusOffset),
                  ),
                );
                // A marker has two caret stops at one document position. Keep
                // the outer stop when native navigation reaches a boundary.
                if (rich && tr.selection.empty) {
                  const { $head } = tr.selection;
                  tr.setStoredMarks((backward ? $head.nodeBefore : $head.nodeAfter)?.marks ?? []);
                }
                view.dispatch(tr.scrollIntoView());
              }
              return true;
            }
          }
          if (
            ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) &&
            !event.shiftKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.isComposing &&
            view.state.selection.empty
          ) {
            const { $from } = view.state.selection;
            const direction = event.key === "ArrowUp" || event.key === backArrow ? -1 : 1;
            const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
            // At document edges, Up/Down may cross markers without changing position; record the stop to
            // preserve the caret.
            const atDocumentEdge =
              $from.pos ===
              (direction === -1
                ? TextSelection.atStart(view.state.doc).from
                : TextSelection.atEnd(view.state.doc).to);
            // Visit the styled edge's other stop before a chip so the plain stop stays reachable.
            const step =
              horizontal || atDocumentEdge
                ? stepCaretAcrossStyledEdge(view.state, direction)
                : null;
            if (step) {
              event.preventDefault();
              event.stopPropagation();
              view.dispatch(step);
              return true;
            }
            const adjacent = direction === -1 ? $from.nodeBefore : $from.nodeAfter;
            if (horizontal && adjacent?.type.name.startsWith("composer-")) {
              event.preventDefault();
              event.stopPropagation();
              view.dispatch(
                view.state.tr
                  .setSelection(
                    TextSelection.create(view.state.doc, $from.pos + direction * adjacent.nodeSize),
                  )
                  .scrollIntoView(),
              );
              return true;
            }
          }
          // Native tab order skips citation comment buttons inside the editor.
          if (
            event.key === "Tab" &&
            event.shiftKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            view.state.selection.empty
          ) {
            const { $from } = view.state.selection;
            const citation = $from.nodeBefore;
            if (citation?.type.name === "composer-citation") {
              const chip = view.nodeDOM($from.pos - citation.nodeSize);
              const commentButton =
                chip instanceof HTMLElement
                  ? chip.querySelector<HTMLElement>("[data-citation-comment-trigger]")
                  : null;
              if (commentButton) {
                event.preventDefault();
                event.stopPropagation();
                commentButton.focus();
                return true;
              }
            }
          }
          if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) {
            event.stopPropagation();
            return true;
          }
          if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
            event.preventDefault();
            return true;
          }
          if (
            event.key === "Tab" &&
            !event.metaKey &&
            !event.ctrlKey &&
            selectionInOneCodeBlock(view.state)
          ) {
            event.preventDefault();
            event.stopPropagation();
            return indentCodeBlock(view.state, event.shiftKey ? "out" : "in", (tr) =>
              view.dispatch(tr),
            );
          }
          if (
            event.key === "Enter" &&
            rich &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.isComposing
          ) {
            if (selectionInOneCodeBlock(view.state)) {
              event.preventDefault();
              event.stopPropagation();
              const dispatch = (tr: typeof view.state.tr) => view.dispatch(tr.scrollIntoView());
              return (
                exitCodeBlockOnClosingFence(view.state, dispatch) ||
                exitCodeBlockOnTrailingBlankLines(view) ||
                indentedNewlineInCodeBlock(view.state, dispatch) ||
                newlineInCode(view.state, dispatch)
              );
            }
            if (convertCodeFenceOnEnter(view.state, (tr) => view.dispatch(tr))) {
              event.preventDefault();
              event.stopPropagation();
              return true;
            }
          }
          const handler = readCallbacks().onCommandKeyDown;
          if (event.key === "Enter") {
            const instance = (view.dom as TiptapEditorHTMLElement).editor;
            const isTaskItem = rich && (instance?.isActive("taskItem") ?? false);
            const isListItem = rich && (instance?.isActive("listItem") ?? false);
            const handled = handler?.("Enter", event, isTaskItem || isListItem) ?? false;
            if (handled) {
              event.preventDefault();
              event.stopPropagation();
              return true;
            }
            event.preventDefault();
            if ((isTaskItem || isListItem) && instance && splitOrLiftListItem(instance)) {
              return true;
            }
            if (
              rich &&
              instance &&
              hasAncestor(view.state.selection.$from, "blockquote") &&
              view.state.selection.$from.parent.content.size === 0 &&
              instance.commands.lift("blockquote")
            ) {
              return true;
            }
            return splitBlockKeepMarks(view.state, (tr) => {
              view.dispatch(tr.scrollIntoView());
            });
          }
          if (!handler) return false;
          const handled = handler(event.key, event);
          if (handled) {
            event.preventDefault();
            event.stopPropagation();
          }
          return handled;
        },
        handleTextInput: (view, from, to, text, insert) => {
          // Inserting here keeps the input rules, which would read a command as Markdown, from
          // seeing the text.
          if (isShellCommandDoc(view.state.doc)) {
            view.dispatch(insert());
            return true;
          }
          if (fixedLiteralText || view.composing || text.length !== 1) return false;
          const closer = SURROUND_CLOSE[text];
          const { selection } = view.state;
          // Compose preedit updates replace a range even without a user selection.
          if (
            !closer ||
            !(selection instanceof TextSelection) ||
            selection.empty ||
            selection.from !== from ||
            selection.to !== to
          ) {
            return false;
          }
          // Do not wrap chips, atoms, or styled text; default replacement preserves marks.
          let touchesSpecial = false;
          view.state.doc.nodesBetween(from, to, (node) => {
            if (
              (node.isAtom && node.isInline && !node.isText) ||
              (node.isText && node.marks.length > 0)
            ) {
              touchesSpecial = true;
              return false;
            }
            return true;
          });
          if (touchesSpecial) return false;
          const map = serializeEditorDoc(view.state.doc);
          const startMd = flatToMarkdown(map, pmToFlat(map, from));
          const endMd = flatToMarkdown(map, pmToFlat(map, to));
          if (selectionTouchesMentionBoundary(map.value, startMd, endMd)) return false;
          const tr = view.state.tr.insertText(closer, to).insertText(text, from);
          tr.setSelection(TextSelection.create(tr.doc, from + text.length, to + text.length));
          view.dispatch(tr);
          return true;
        },
        handlePaste: (view, event) => {
          const clipboardData = event.clipboardData;
          if (!clipboardData || clipboardData.files.length > 0) return false;
          const pastedText = clipboardData.getData("text/plain");
          if (!pastedText) return false;
          event.preventDefault();
          // Paste verbatim inside fences; markdown parsing would split blocks and create unsupported chips.
          if (isInCodeBlock(view)) {
            const { from, to } = view.state.selection;
            view.dispatch(
              markAsClipboardEdit(
                view.state.tr.insertText(pastedText, from, to),
                "paste",
              ).scrollIntoView(),
            );
            return true;
          }
          const literal = isLiteralState(view.state);
          const importFragment = readCallbacks().importContextFragment;
          let text =
            !literal && importFragment
              ? importPastedComposerText(clipboardData, importFragment)
              : pastedText;
          const tokens = literal ? [] : collectComposerPromptInlineTokens(`${text}\n`);
          const isChip = (token: (typeof tokens)[number] | undefined) =>
            token?.type === "mention" ||
            (token?.type === "skill" && skillLabelFor(token.value) !== null);
          const lastToken = tokens.at(-1);
          if (isChip(lastToken) && lastToken?.end === text.length) {
            text += " ";
          }
          if (isChip(tokens[0]) && tokens[0]?.start === 0) {
            const map = serializeEditorDoc(view.state.doc);
            const offset = flatToMarkdown(map, pmToFlat(map, view.state.selection.from));
            if (offset > 0 && !/\s/.test(map.value[offset - 1]!)) text = ` ${text}`;
          }
          const { $from } = view.state.selection;
          const lineBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\uFFFC");
          const literalLength = literal
            ? 0
            : pastedPathQueryLength(lineBefore, text, readCallbacks().isPathQueryActive?.());
          const editorInstance = (view.dom as TiptapEditorHTMLElement).editor;
          if (editorInstance) {
            const $paste = view.state.selection.$from;
            const nested = ["listItem", "taskItem", "blockquote"].some((name) =>
              hasAncestor($paste, name),
            );
            insertMarkdownParagraphs(
              text,
              skillLabelFor,
              {
                styling: isRichState(view.state),
                blocks: !nested,
                literalText: literal,
                literalLength,
              },
              (content) => {
                editorInstance
                  .chain()
                  .command(({ tr }) => {
                    markAsClipboardEdit(tr, "paste");
                    return true;
                  })
                  .insertContent(content)
                  .command(({ tr }) => {
                    // Move after a pasted rule so the next keystroke cannot replace it; add a trailing line
                    // if needed.
                    const { selection } = tr;
                    if (!(selection instanceof NodeSelection) || !selection.node.isBlock) {
                      return true;
                    }
                    if (!tr.doc.resolve(selection.to).nodeAfter?.isTextblock) {
                      tr.insert(selection.to, tr.doc.type.schema.nodes.paragraph!.create());
                    }
                    tr.setSelection(TextSelection.create(tr.doc, selection.to + 1));
                    return true;
                  })
                  .run();
              },
            );
            scrollTiptapCaretIntoView(editorInstance);
          }
          return true;
        },
      },
      onUpdate: ({ editor: updated, transaction }) => {
        const history = isHistoryTransaction(transaction);
        const shell = isShellCommandDoc(updated.state.doc);
        const restoredShellCommand =
          history && shell !== isShellCommandDoc(transaction.before) ? shell : undefined;
        if (!history && transaction.getMeta("addToHistory") !== false) {
          editedSinceRenderRef.current = true;
        }
        // Undo can restore a chip for a skill the current provider no longer offers.
        if (history && !isLiteralState(updated.state)) {
          const stale = skillChipReplacements(updated.state.doc, skillLabelFor).filter(
            ({ node }) => node.isText,
          );
          if (stale.length > 0) {
            replaceSkillChips(updated, stale);
            if (restoredShellCommand !== undefined) {
              handleEditorChange(updated, restoredShellCommand);
            }
            return;
          }
        }
        handleEditorChange(updated, restoredShellCommand);
      },
      onSelectionUpdate: ({ editor: updated }) => {
        handleEditorChange(updated);
      },
    },
    [],
  );

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  // Push attributes before layout measurements; Tiptap updates them later in a passive effect.
  useLayoutEffect(() => {
    if (!editor?.isInitialized) return;
    editor.view.setProps({ attributes: editorAttributes });
  }, [editor, editorAttributes]);

  const readSnapshot = () => {
    const snapshot = snapshotRef.current;
    if (!editor) return snapshot;
    const map = serializeEditorDoc(editor.state.doc);
    const { from, to } = editor.state.selection;
    const fromFlat = pmToFlat(map, from);
    const expandedCursor = Math.max(0, Math.min(map.value.length, flatToMarkdown(map, fromFlat)));
    const literal = isLiteralState(editor.state);
    const next: typeof snapshot = {
      value: map.value,
      cursor: collapseExpandedComposerCursor(map.value, expandedCursor, literal),
      expandedCursor,
      contextIds: literal ? [] : map.contextIds,
    };
    const toFlat = pmToFlat(map, to);
    selectionRangeRef.current = {
      start: Math.min(next.expandedCursor, flatToMarkdown(map, toFlat)),
      end: Math.max(next.expandedCursor, flatToMarkdown(map, toFlat)),
    };
    snapshotRef.current = next;
    return next;
  };

  // Save citation drafts before controlled rewrites unmount their node views.
  const saveCitationDraft = useEffectEvent((current: TiptapEditor, replacedValue: string) => {
    const draft = citationDraftRef.current;
    citationDraftRef.current = null;
    if (!draft || !onCitationDraftSave) return;
    const [target] = findChildren(
      current.state.doc,
      (node) => node.type.name === "composer-citation" && node.attrs.citeKey === draft.key,
    );
    if (!target) return;
    const { node, pos } = target;
    const citation = node.attrs.citation as AssistantCitation;
    const dismissal = resolveAssistantCitationCommentDismissal({
      reason: "none",
      draft: draft.comment,
      savedComment: citation.comment,
    });
    if (dismissal.kind !== "commit") return;
    const next = withAssistantCitationComment(citation, dismissal.comment);
    current.view.dispatch(
      current.state.tr
        .setNodeMarkup(pos, undefined, {
          ...node.attrs,
          citation: next,
          source: serializeAssistantCitation(next),
        })
        .setMeta("addToHistory", false),
    );
    onCitationDraftSave(replacedValue, serializeEditorDoc(current.state.doc).value);
  });

  // The one place the controlled value reaches the editor. Imperative handlers compare against
  // the committed value, so it is recorded here even before the editor exists.
  useLayoutEffect(() => {
    latestValueRef.current = value;
    if (!editor) return;
    const initialSelection = !hasAppliedControlledSelectionRef.current;
    hasAppliedControlledSelectionRef.current = true;
    const normalizedCursor = clampEditorCursor(value, cursor);
    const previousSnapshot = snapshotRef.current;
    if (
      !initialSelection &&
      previousSnapshot.value === value &&
      previousSnapshot.cursor === normalizedCursor
    ) {
      return;
    }
    const normalizedExpandedCursor = initialSelection
      ? initialExpandedCursor
      : expandEditorCursor(value, normalizedCursor);
    snapshotRef.current = {
      value,
      cursor: normalizedCursor,
      expandedCursor: normalizedExpandedCursor,
      contextIds: collectInlineContextIds(value),
    };
    selectionRangeRef.current = {
      start: normalizedExpandedCursor,
      end: normalizedExpandedCursor,
    };
    setIsEmpty(showsPlaceholderFor(value, shellCommand));
    const rootElement = editor.view.dom;
    const isFocused = Boolean(rootElement && document.activeElement === rootElement);
    if (!initialSelection && previousSnapshot.value === value && !isFocused) return;

    isApplyingControlledUpdateRef.current = true;
    const pendingCitation =
      citationRequestRef.current?.value === value ? citationRequestRef.current : null;
    if (previousSnapshot.value !== value) {
      saveCitationDraft(editor, previousSnapshot.value);
      const content = buildDocJson(value, skillLabelFor, { styling: richText, literalText });
      if (isShellCommandDoc(editor.state.doc) === shellCommand) {
        editor.commands.setContent(content, { emitUpdate: false });
      } else {
        editor
          .chain()
          .setContent(content, { emitUpdate: false })
          .command(({ tr }) => {
            // One step with the new text, so undo brings back the old text in its own mode.
            tr.setDocAttribute(SHELL_COMMAND_ATTR, shellCommand);
            if (editedSinceRenderRef.current) joinPreviousUndoStep(tr);
            return true;
          })
          .run();
      }
    }
    const map = serializeEditorDoc(editor.state.doc);
    const flat = markdownToFlat(map, normalizedExpandedCursor);
    editor.commands.setTextSelection(flatToPm(map, flat));
    if (isFocused) scrollTiptapCaretIntoView(editor);
    if (pendingCitation) {
      citationRequestRef.current = null;
      const target = map.runs.find(
        (run) =>
          run.kind === "token" &&
          run.nodeName === "composer-citation" &&
          run.mdStart === pendingCitation.citationStart,
      );
      if (target) {
        const node = editor.state.doc.nodeAt(target.pmPos);
        const citeKey = (node?.attrs as { citeKey?: string } | undefined)?.citeKey;
        if (citeKey) {
          setOpenCitation({
            key: citeKey,
            sourceAnchor: pendingCitation.sourceAnchor,
            removeOnCancel: pendingCitation.insertedSpaces,
          });
        }
      }
    }
    queueMicrotask(() => {
      isApplyingControlledUpdateRef.current = false;
    });
  }, [
    clampEditorCursor,
    cursor,
    editor,
    expandEditorCursor,
    initialExpandedCursor,
    literalText,
    richText,
    shellCommand,
    skillLabelFor,
    value,
  ]);

  // The store decides shell mode from the editor's changes, so the switch lands a render after the
  // edit that caused it. A switch that comes with a new value rides on its rewrite above instead.
  useLayoutEffect(() => {
    if (!shellFeatureActive) return;
    if (
      editor &&
      isShellCommandDoc(editor.state.doc) !== shellCommand &&
      snapshotRef.current.value === value
    ) {
      editor.view.dispatch(
        shellModeTransaction(editor.state, shellCommand, editedSinceRenderRef.current),
      );
    }
    editedSinceRenderRef.current = false;
  });

  // Reconcile loaded or switched provider skills without rebuilding citation node views. Not on
  // leaving shell mode, which keeps the command's text as typed.
  useEffect(() => {
    if (!editor || fixedLiteralText || isShellCommandDoc(editor.state.doc)) return;
    const replacements = skillChipReplacements(editor.state.doc, (name) =>
      composerSkillMeta(skills, name),
    );
    if (replacements.length > 0) replaceSkillChips(editor, replacements);
  }, [editor, fixedLiteralText, skills]);

  useLayoutEffect(() => {
    if (!editor) return;
    if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      editor.view.focus();
      scrollTiptapCaretIntoView(editor);
    }
    return () => {
      // Capture focus before the keyed editor's DOM is removed.
      restoreFocusRef.current = editor.view.hasFocus();
    };
  }, [editor, restoreFocusRef]);

  const focusAt = (nextCursor: number, exactExpandedCursor?: number) => {
    if (!editor) return;
    // view.focus() writes selection immediately; bare DOM focus waits 20ms and can misplace fast dictation.
    editor.view.focus();
    if (snapshotRef.current.value !== latestValueRef.current) return;
    const boundedCursor = clampEditorCursor(snapshotRef.current.value, nextCursor);
    const expandedCursor =
      exactExpandedCursor ?? expandEditorCursor(snapshotRef.current.value, boundedCursor);
    const map = serializeEditorDoc(editor.state.doc);
    editor.commands.setTextSelection(flatToPm(map, markdownToFlat(map, expandedCursor)));
    scrollTiptapCaretIntoView(editor);
    if (boundedCursor === snapshotRef.current.cursor) return;
    snapshotRef.current = {
      value: snapshotRef.current.value,
      cursor: boundedCursor,
      expandedCursor,
      contextIds: snapshotRef.current.contextIds,
    };
    selectionRangeRef.current = {
      start: snapshotRef.current.expandedCursor,
      end: snapshotRef.current.expandedCursor,
    };
    readCallbacks().onChange(
      snapshotRef.current.value,
      boundedCursor,
      snapshotRef.current.expandedCursor,
      literalText,
      snapshotRef.current.contextIds,
    );
  };

  useImperativeHandle(
    editorRef,
    () => ({
      focus: () => {
        // The collapsed cursor cannot say where inside `$name` text a caret
        // sits, so restoring the caret passes along its exact offset.
        focusAt(snapshotRef.current.cursor, snapshotRef.current.expandedCursor);
      },
      focusAt: (cursor) => focusAt(cursor),
      focusAtEnd: () => {
        focusAt(
          literalText
            ? snapshotRef.current.value.length
            : collapseExpandedComposerCursor(
                snapshotRef.current.value,
                snapshotRef.current.value.length,
              ),
        );
      },
      readSelectionRange: () => {
        readSnapshot();
        return selectionRangeRef.current;
      },
      requestCitationComment: (request) => {
        citationRequestRef.current = request;
        if (!editor) return;
        const map = serializeEditorDoc(editor.state.doc);
        if (map.value !== request.value) return;
        const target = map.runs.find(
          (run) =>
            run.kind === "token" &&
            run.nodeName === "composer-citation" &&
            run.mdStart === request.citationStart,
        );
        if (!target) return;
        const node = editor.state.doc.nodeAt(target.pmPos);
        const citeKey = (node?.attrs as { citeKey?: string } | undefined)?.citeKey;
        if (citeKey) {
          citationRequestRef.current = null;
          setOpenCitation({
            key: citeKey,
            sourceAnchor: request.sourceAnchor,
            removeOnCancel: request.insertedSpaces,
          });
        }
      },
      readSnapshot,
      isCaretOnVisualEdge: (edge) => {
        const snapshot = readSnapshot();
        if (snapshot.value.length === 0) return true;
        const beforeCaret = snapshot.value.slice(0, snapshot.expandedCursor);
        const afterCaret = snapshot.value.slice(snapshot.expandedCursor);
        if (edge === "start" ? beforeCaret.includes("\n") : afterCaret.includes("\n")) {
          return false;
        }
        const rootElement = editor?.view.dom;
        const selection = window.getSelection();
        if (
          !rootElement ||
          !selection ||
          !selection.isCollapsed ||
          selection.rangeCount === 0 ||
          !selection.anchorNode ||
          !rootElement.contains(selection.anchorNode)
        ) {
          return false;
        }
        const caretRect = caretLineRect(selection.getRangeAt(0), edge);
        if (!caretRect) return false;
        const edgeElement =
          edge === "start" ? rootElement.firstElementChild : rootElement.lastElementChild;
        const edgeRect = (edgeElement ?? rootElement).getBoundingClientRect();
        const threshold = caretRect.height / 2;
        return edge === "start"
          ? caretRect.top - edgeRect.top < threshold
          : edgeRect.bottom - caretRect.bottom < threshold;
      },
    }),
    [editor, focusAt, literalText, readSnapshot],
  );

  const handleCopyCut = (event: React.ClipboardEvent, cut: boolean) => {
    const build = buildContextClipboardFragment;
    if (!editor || (cut && !editor.isEditable)) return;
    const clipboardData = event.clipboardData;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const text = serializeSelection(editor.state.doc, from, to);
    const contextIds = literalText ? [] : Array.from(new Set(collectInlineContextIds(text)));
    const fragment = contextIds.length > 0 ? build?.(contextIds) : null;
    event.preventDefault();
    clipboardData.setData("text/plain", text);
    if (fragment) {
      clipboardData.setData(COMPOSER_CONTEXT_CLIPBOARD_MIME, fragment);
      clipboardData.setData("text/html", encodeComposerContextClipboardHtml(text, fragment));
    }
    if (cut) {
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          markAsClipboardEdit(tr, "cut");
          return true;
        })
        .deleteSelection()
        .run();
    }
  };

  return (
    <RichComposerSkillsContext value={skills}>
      <ComposerContextRecordsContext value={contextRecords}>
        <ComposerCitationCommentContext value={citationCommentActions}>
          <div
            className={cn(
              "relative flow-root font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)",
              containerClassName,
            )}
          >
            <EditorContent
              editor={editor}
              onKeyDown={(event) => {
                if (
                  event.key === "Control" ||
                  event.key === "Meta" ||
                  event.key === "Alt" ||
                  event.key === "Shift"
                ) {
                  onPageScrollRelease?.();
                }
                if (event.key !== "PageUp" && event.key !== "PageDown") return;
                const target = event.currentTarget.querySelector(
                  '[data-testid="composer-editor"]',
                ) as HTMLElement | null;
                if (!target) return;
                const pageScrollKey = getTimelinePageScrollKey({
                  altKey: event.altKey,
                  clientHeight: target.clientHeight,
                  ctrlKey: event.ctrlKey,
                  defaultPrevented: event.defaultPrevented,
                  isComposing: event.nativeEvent.isComposing,
                  key: event.key,
                  keyCode: event.keyCode,
                  metaKey: event.metaKey,
                  scrollHeight: target.scrollHeight,
                  scrollTop: target.scrollTop,
                  shiftKey: event.shiftKey,
                });
                if (!pageScrollKey) {
                  onPageScrollRelease?.();
                  return;
                }
                if (!onPageScrollKeyDown) return;
                event.preventDefault();
                onPageScrollKeyDown(pageScrollKey);
              }}
              onKeyUp={(event) => onPageScrollKeyUp?.(event.key)}
              onBlur={onPageScrollRelease}
              onPasteCapture={onPaste}
              onCopyCapture={(event) => handleCopyCut(event, false)}
              onCutCapture={(event) => handleCopyCut(event, true)}
            />
            {isEmpty && contextRecords.size === 0 && placeholder ? (
              <div
                className={cn(
                  "pointer-events-none absolute inset-0 leading-relaxed text-placeholder",
                  shellCommand && "shell-command-text",
                  placeholderClassName,
                )}
              >
                {placeholder}
              </div>
            ) : null}
          </div>
        </ComposerCitationCommentContext>
      </ComposerContextRecordsContext>
    </RichComposerSkillsContext>
  );
}

/** Split newlines into paragraphs; trailing hard breaks render no visible line. */
function insertMarkdownParagraphs(
  value: string,
  skillLabelFor: (name: string) => SkillMeta | null,
  options: { styling: boolean; blocks?: boolean; literalText?: boolean; literalLength?: number },
  insertContent: (content: JSONContent[] | JSONContent) => void,
): void {
  const blocks = buildTiptapContent(value, skillLabelFor, options);
  if (blocks.length === 1 && blocks[0]?.type === "paragraph") {
    const inline = (blocks[0]?.content ?? []) as JSONContent[];
    if (inline.length === 0) return;
    insertContent(inline);
    return;
  }
  insertContent(blocks as JSONContent[]);
}

/** Native scrolling follows only real input; explicitly reveal programmatically placed carets. */
function scrollTiptapCaretIntoView(editor: TiptapEditor): void {
  editor.view.dispatch(editor.state.tr.scrollIntoView());
}

function caretLineRect(range: Range, edge: "start" | "end"): DOMRect | null {
  const collapsedRects = Array.from(range.getClientRects()).filter((rect) => rect.height > 0);
  const collapsedRect = edge === "start" ? collapsedRects.at(-1) : collapsedRects[0];
  if (collapsedRect) return collapsedRect;

  const container = range.startContainer;
  if (container.nodeType === 3) {
    const textNode = container as Text;
    if (textNode.data.length === 0) return null;
    const probeStart = Math.max(
      0,
      Math.min(
        edge === "start" ? range.startOffset : range.startOffset - 1,
        textNode.data.length - 1,
      ),
    );
    const probeRange = document.createRange();
    probeRange.setStart(textNode, probeStart);
    probeRange.setEnd(textNode, probeStart + 1);
    const probeRect = Array.from(probeRange.getClientRects()).find((rect) => rect.height > 0);
    if (probeRect) return probeRect;
    const boundingRect = probeRange.getBoundingClientRect();
    return boundingRect.height > 0 ? boundingRect : null;
  }

  if (!(container instanceof HTMLElement)) return null;
  const neighbour =
    container.childNodes[Math.max(0, range.startOffset - 1)] ??
    container.childNodes[range.startOffset];
  if (neighbour instanceof HTMLElement) {
    const neighbourRect = neighbour.getBoundingClientRect();
    if (neighbourRect.height > 0) return neighbourRect;
  } else if (neighbour instanceof Text && neighbour.data.length > 0) {
    const isBeforeCaret = neighbour === container.childNodes[range.startOffset - 1];
    const probeStart = isBeforeCaret ? neighbour.data.length - 1 : 0;
    const probeRange = document.createRange();
    probeRange.setStart(neighbour, probeStart);
    probeRange.setEnd(neighbour, probeStart + 1);
    const probeRect = Array.from(probeRange.getClientRects()).find((rect) => rect.height > 0);
    if (probeRect) return probeRect;
  }
  const containerRect = container.getBoundingClientRect();
  return containerRect.height > 0 ? containerRect : null;
}
