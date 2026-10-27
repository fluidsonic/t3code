import {
  composerDraftIsShellCommand,
  nextComposerShellMode,
} from "@t3tools/client-runtime/user-shell-command";
import type { RefObject } from "react";

import {
  type ComposerThreadTarget,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../../composerDraftStore";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditor";

/**
 * Why this composer can't run `! cmd` shell commands, or null when it can. They need the
 * environment's setting and terminal access on this connection.
 */
export function shellCommandsUnavailableReason(input: {
  readonly enabled: boolean;
  readonly canOperateTerminal: boolean;
}): string | null {
  if (!input.enabled) return "Shell commands are off for this environment.";
  if (!input.canOperateTerminal) return "This connection can't run shell commands.";
  return null;
}

/**
 * The composer's `! cmd` shell mode: the draft store decides it as the prompt changes; this adds
 * what only the composer sees (permission, a question taking the editor, a queued edit's kind,
 * Backspace and paste). A command drafted while available stays one, with `sendBlockedReason`.
 */
export function useComposerShellMode(input: {
  readonly composerDraftTarget: ComposerThreadTarget;
  /** From `shellCommandsUnavailableReason`; while set, `!` is prose. */
  readonly unavailableReason: string | null;
  readonly answeringQuestion: boolean;
  /** Null unless editing a queued message, whose kind cannot change. */
  readonly editingQueuedShellCommand: boolean | null;
  readonly promptRef: { readonly current: string };
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
}) {
  const draft = useComposerThreadDraft(input.composerDraftTarget);
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const canRunShellCommands = input.unavailableReason === null;
  const available = canRunShellCommands && !input.answeringQuestion;
  const isShellMode =
    !input.answeringQuestion &&
    (input.editingQueuedShellCommand ?? composerDraftIsShellCommand(draft));
  const sendBlockedReason = isShellMode ? input.unavailableReason : null;
  /** Whether a prompt edit may enter shell mode; a queued message's edit keeps its kind. */
  const canEnterShellMode = available && input.editingQueuedShellCommand !== false;
  /**
   * Whether the composer runs its shell-aware code at all: shell commands are on here, or the
   * draft is still a command. Otherwise it runs exactly as it did before shell commands existed.
   */
  const active = canRunShellCommands || isShellMode;

  /** Backspace on an empty command leaves shell mode and keeps the `!` as prose. */
  const leaveOnBackspace = (key: string, event: KeyboardEvent): boolean => {
    if (
      key !== "Backspace" ||
      !isShellMode ||
      input.editingQueuedShellCommand !== null ||
      input.promptRef.current !== "!" ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.isComposing
    ) {
      return false;
    }
    const range = input.editorRef.current?.readSelectionRange();
    if (range?.start !== 1 || range.end !== 1) return false;
    setPrompt(input.composerDraftTarget, "!", { shellMode: false });
    return true;
  };

  /**
   * The range a paste of `text` replaces when it turns the prompt into a command, or null when it
   * doesn't. Such a paste must land as typed: the rich editor would read Markdown in it, and
   * folding a long paste into a file would leave nothing to run.
   */
  const commandPasteRange = (text: string): { start: number; end: number } | null => {
    if (!canEnterShellMode || isShellMode || input.editingQueuedShellCommand !== null) return null;
    const prompt = input.promptRef.current;
    const range = input.editorRef.current?.readSelectionRange() ?? {
      start: prompt.length,
      end: prompt.length,
    };
    const nextPrompt = prompt.slice(0, range.start) + text + prompt.slice(range.end);
    return nextComposerShellMode({
      previousPrompt: prompt,
      previousShellMode: false,
      nextPrompt,
      available: true,
    })
      ? range
      : null;
  };

  return {
    active,
    isShellMode,
    sendBlockedReason,
    canEnterShellMode,
    leaveOnBackspace,
    commandPasteRange,
  };
}
