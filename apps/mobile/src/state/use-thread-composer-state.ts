import { useComposerAttachmentActions } from "./use-composer-attachment-actions";
import * as Dialog from "../components/ui/Dialog";
import { AuthOrchestrationOperateScope, AuthTerminalOperateScope } from "@t3tools/contracts";
import {
  isRunningUserShellCommand,
  liveUserShellCommands,
  stopComposerShellCommands,
  userShellCommandOwnsWorkingSlot as deriveUserShellCommandOwnsWorkingSlot,
} from "@t3tools/client-runtime/user-shell-command";
import * as DateTime from "effect/DateTime";
import {
  SHELL_COMMAND_CONTENT_BLOCKED,
  queuedShellCommandEditText,
  resolveComposerShellSend,
  shellCommandsDisabledReason,
} from "../lib/composerShellCommand";
import { shellCommandMessageText, shellCommandPrompt } from "@t3tools/shared/shellCommand";
import { readEnvironmentScope } from "./session";
import { readCanRunShellCommands } from "./shell-commands";
import { useAtomValue } from "@effect/atom-react";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import { resolvePendingHandoff } from "@t3tools/client-runtime/handoff";
import {
  deriveProviderSubagentStatus,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadRuntime,
  threadRuntimeHasInterruptibleRun,
} from "@t3tools/client-runtime/state/thread-execution";
import { useRef, useState } from "react";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { nextPastedTextFileName, pastedTextDisposition } from "@t3tools/client-runtime/text-paste";
import {
  parseCodexFeedbackCommand,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { composerContextSendBlockReason, reidentifyComposerContext } from "../lib/composerContext";
import { uuidv4 } from "../lib/uuid";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import {
  describeUnavailableModelSelection,
  isModelSelectionUnavailable,
} from "../lib/modelOptions";
import { resolveProviderInteractionMode } from "./legacy-plan-mode";
import {
  createPastedTextComposerAttachment,
  pasteComposerClipboard,
  removePersistedComposerAttachmentFile,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { buildThreadFeed, createThreadFeedCache } from "../lib/threadActivity";
import { acknowledgedThreadMessagesAtom } from "./acknowledged-thread-messages";
import {
  appendPendingThreadMessages,
  selectPendingAcknowledgedMessages,
} from "../features/threads/pending-thread-feed";
import { threadAllowsProviderSwitch } from "./thread-provider-switching";
import { appAtomRegistry } from "../state/atom-registry";
import { pendingThreadCreationMessage } from "./pending-thread-creation";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentUploadsAtom,
} from "../state/composer-attachment-uploads";
import {
  appendComposerDraftAttachments,
  captureComposerDraftInsertion,
  countComposerDraftAttachmentsAfterSelection,
  insertComposerDraftText,
  insertComposerDraftContext,
  rememberComposerDraftSelection,
  clearComposerDraft,
  clearComposerDraftContent,
  ComposerDraftKindConflictError,
  composerDraftIsBlank,
  composerContextImportsAtom,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  removeComposerDraftAttachment,
  scheduleUnusedComposerAttachmentCleanup,
  returnStoppedShellCommandToDraft,
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
  useComposerDraftSettings,
} from "./use-composer-drafts";
import {
  resolveComposerDispatchMode,
  type ActiveTurnComposerAction,
} from "@t3tools/client-runtime/state/composer-dispatch";
import { Atom } from "effect/reactivity";
import { AsyncResult } from "effect/reactivity";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { prepareTurnAttachments } from "../lib/attachmentUpload";
import { DEFAULT_FOLLOW_UP_BEHAVIOR } from "../lib/followUpBehavior";
import { mobilePreferencesAtom } from "./preferences";
import { environmentThreadDetails } from "./threads";
import {
  endQueuedRunEdit,
  getQueuedRunEdit,
  queuedEditDraftKey,
  removeQueuedRunEditAttachment,
  resolveQueuedEditPayload,
  startQueuedRunEditSave,
  useQueuedRunEdit,
} from "./queued-run-edit";
import { setPendingConnectionError } from "../state/use-remote-environment-registry";
import { clearThreadComposerError, setThreadComposerError } from "./thread-composer-error";
import {
  useSelectedThreadProjection,
  useSelectedThreadVisibleTurnItems,
} from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";
import { enqueueThreadOutboxMessage, threadOutboxManager } from "./thread-outbox";
import { dispatchingQueuedMessageIdAtom, useThreadOutboxMessages } from "./use-thread-outbox";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

const EMPTY_QUEUE_WORKFLOW_ATOM = Atom.make<null>(null).pipe(
  Atom.withLabel("mobile-thread-queue-workflow:empty"),
);
const EMPTY_CHECKPOINT_SUMMARIES_ATOM = Atom.make<ReadonlyArray<ThreadCheckpointSummary>>([]);
const EMPTY_LIVE_SHELL_COMMANDS: ReturnType<typeof liveUserShellCommands> = [];

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const upgraded = upgradeLegacyContextMessage(input.text);
  if (
    !insertComposerDraftContext(
      threadKey,
      reidentifyComposerContext(upgraded.text, upgraded.records, uuidv4),
    )
  ) {
    Dialog.alert("Too many context items", "Remove some context from the draft and try again.");
    return;
  }
  if (input.attachments && input.attachments.length > 0) {
    const rejectedCount = appendComposerDraftAttachments(threadKey, input.attachments, {
      appendReference: true,
    });
    if (rejectedCount > 0) {
      setPendingConnectionError(
        `${rejectedCount} comment attachment${rejectedCount === 1 ? " was" : "s were"} not added. Messages can contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
      );
    }
  }
}

/** Resolve per call so callbacks created before editing still target the current draft. */
function activeComposerDraftKey(thread: {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
}): string {
  const threadKey = scopedThreadKey(thread.environmentId, thread.id);
  const edit = getQueuedRunEdit(threadKey);
  return edit === null ? threadKey : queuedEditDraftKey(threadKey, edit.runId);
}

/** Whether the thread's composer can send `! cmd`; never while editing a queued message's prose. */
function composerCanRunShellCommands(thread: {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
}): boolean {
  const edit = getQueuedRunEdit(scopedThreadKey(thread.environmentId, thread.id));
  return (
    readCanRunShellCommands(thread.environmentId) && (edit === null || edit.shellCommand === true)
  );
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null;
  const draft = useComposerDraft(threadKey);

  return {
    draftMessage: draft.text,
    draftAttachments: draft.attachments,
  };
}

/** A provider without the interaction-mode toggle runs in the default mode. */
export function updateThreadDraftModelSelection(
  threadKey: string,
  value: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): void {
  const provider = providers.find((candidate) => candidate.instanceId === value.instanceId);
  updateComposerDraftSettings(threadKey, {
    modelSelection: value,
    ...(provider?.showInteractionModeToggle === false
      ? { interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE }
      : {}),
  });
}

export function useThreadComposerState() {
  const {
    selectedThread: selectedThreadShell,
    selectedThreadCreation,
    selectedThreadDetailRef,
    selectedEnvironmentRuntime,
  } = useThreadSelection();
  const selectedThreadProjection = useSelectedThreadProjection();
  const selectedThreadVisibleTurnItems = useSelectedThreadVisibleTurnItems();
  const acknowledgedMessages = useAtomValue(acknowledgedThreadMessagesAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const uploadThreadFeedback = useAtomCommand(threadEnvironment.uploadFeedback, {
    reportFailure: false,
  });
  const editQueuedRun = useAtomCommand(threadEnvironment.editQueuedRun, {
    label: "edit queued message",
    reportFailure: false,
  });
  const stopUserShellCommand = useAtomCommand(
    threadEnvironment.stopUserShellCommand,
    "stop command",
  );
  const [isSavingQueuedEdit, setIsSavingQueuedEdit] = useState(false);
  const savingQueuedEditRef = useRef(false);
  const pastedTextFileNamesRef = useRef<{ threadKey: string | null; names: Set<string> }>({
    threadKey: null,
    names: new Set(),
  });
  const reservePastedTextFileName = (threadKey: string, existingNames: ReadonlyArray<string>) => {
    if (pastedTextFileNamesRef.current.threadKey !== threadKey) {
      pastedTextFileNamesRef.current = { threadKey, names: new Set() };
    }
    const names = pastedTextFileNamesRef.current.names;
    for (const name of existingNames) names.add(name);
    const nextName = nextPastedTextFileName([...names]);
    names.add(nextName);
    return nextName;
  };

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const selectedThreadQueuedMessages = selectedThreadKey
    ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []).filter(
        (message) => message.creation === undefined,
      )
    : [];
  const feedbackSubmissions = selectedThreadKey
    ? (feedbackSubmissionsByThreadKey[selectedThreadKey] ?? [])
    : [];
  const dismissFeedback = (id: MessageId) => {
    if (!selectedThreadKey) return;
    setFeedbackSubmissionsByThreadKey((current) => ({
      ...current,
      [selectedThreadKey]: (current[selectedThreadKey] ?? []).filter((entry) => entry.id !== id),
    }));
  };
  const selectedThreadMessages = selectedThreadProjection?.projection.messages;
  const selectedThreadAttempts = selectedThreadProjection?.projection.attempts;
  const selectedThreadNodes = selectedThreadProjection?.projection.nodes;
  const checkpointSummaries = useAtomValue(
    selectedThreadDetailRef === null
      ? EMPTY_CHECKPOINT_SUMMARIES_ATOM
      : environmentThreadDetails.checkpointSummariesAtom(selectedThreadDetailRef),
  );
  // A thread whose creation has not delivered its turn yet: the prompt only
  // exists in the outbox, so it is appended to whatever the server has. The
  // detail is usually present but empty during a worktree checkout, so this
  // cannot be an either/or with the loaded messages.
  const pendingCreationMessage = selectedThreadCreation?.message ?? null;
  const [feedCache] = useState(createThreadFeedCache);
  const selectedThreadFeed = (() => {
    const pendingCreation =
      pendingCreationMessage !== null &&
      !selectedThreadMessages?.some((message) => message.id === pendingCreationMessage.messageId)
        ? [pendingThreadCreationMessage(pendingCreationMessage)]
        : [];
    const feed = buildThreadFeed(selectedThreadVisibleTurnItems, {
      anchoredMessages: pendingCreation,
      attempts: selectedThreadAttempts,
      nodes: selectedThreadNodes,
      checkpointSummaries,
      cache: feedCache,
    });
    const pendingAcknowledgments = selectPendingAcknowledgedMessages(acknowledgedMessages, {
      threadKey: selectedThreadKey,
      queuedMessages: selectedThreadQueuedMessages,
      projectedMessages: selectedThreadMessages,
    });
    if (pendingAcknowledgments.length === 0) return feed;
    return appendPendingThreadMessages(feed, feed, pendingAcknowledgments).map((entry) =>
      entry.pendingMessage ? { ...entry, acknowledged: true } : entry,
    );
  })();

  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const followUpBehavior = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR)
    : DEFAULT_FOLLOW_UP_BEHAVIOR;
  const queueWorkflow = useAtomValue(
    selectedThreadDetailRef === null
      ? EMPTY_QUEUE_WORKFLOW_ATOM
      : environmentThreadDetails.queueWorkflowAtom(selectedThreadDetailRef),
  );
  const queuedRunEdit = useQueuedRunEdit(selectedThreadKey);
  const composerDraftKey =
    selectedThreadKey === null
      ? null
      : queuedRunEdit === null
        ? selectedThreadKey
        : queuedEditDraftKey(selectedThreadKey, queuedRunEdit.runId);
  const selectedDraft = useComposerDraftSettings(selectedThreadKey);
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;
  const selectedThread = selectedThreadShell;
  const modelSelection = selectedDraft.modelSelection ?? selectedThread?.modelSelection ?? null;
  const serverConfig = selectedEnvironmentRuntime?.serverConfig;
  const pendingHandoff = resolvePendingHandoff(
    selectedThreadProjection?.projection,
    isModelSelectionUnavailable(serverConfig, modelSelection, selectedThread?.projectId ?? null)
      ? null
      : modelSelection,
    serverConfig?.providers ?? [],
  );
  const runtimeMode = selectedDraft.runtimeMode ?? selectedThread?.runtimeMode ?? null;
  const selectedProvider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
    (provider) => provider.instanceId === modelSelection?.instanceId,
  );
  const interactionMode = selectedThread
    ? resolveProviderInteractionMode(
        selectedProvider,
        selectedDraft.interactionMode ?? selectedThread.interactionMode,
      )
    : null;
  const canSwitchThreadProvider = threadAllowsProviderSwitch({
    thread: selectedThreadShell,
    projection: selectedThreadProjection?.projection,
  });
  const selectedThreadRuntime = selectedThreadProjection
    ? deriveThreadRuntime(selectedThreadProjection.projection)
    : (selectedThreadShell?.runtime ?? null);
  const selectedThreadActivityRun = selectedThreadProjection
    ? deriveThreadActivityRun(selectedThreadProjection.projection)
    : (selectedThreadShell?.latestRun ?? null);

  const isCompacting = (() => {
    const queuedCompact = selectedThreadQueuedMessages.some(
      (message) =>
        message.messageId === dispatchingQueuedMessageId &&
        message.shellCommand !== true &&
        message.text.trim().toLowerCase() === "/compact" &&
        message.attachments.length === 0,
    );
    if (queuedCompact) return true;
    const activeRunId = selectedThreadRuntime?.activeRunId;
    if (!activeRunId || !threadRuntimeIsActive(selectedThreadRuntime)) return false;
    if (
      selectedThreadVisibleTurnItems.some(
        ({ item }) =>
          item.runId === activeRunId && item.type === "compaction" && item.status === "running",
      )
    ) {
      return true;
    }
    const compactMessage = selectedThreadVisibleTurnItems.findLast(
      ({ item }) =>
        item.runId === activeRunId &&
        item.type === "user_message" &&
        item.shellCommand !== true &&
        item.text.trim().toLowerCase() === "/compact" &&
        item.attachments.length === 0,
    );
    if (!compactMessage) return false;
    return !selectedThreadVisibleTurnItems.some(
      ({ item }) =>
        item.runId === activeRunId &&
        item.type === "compaction" &&
        (item.status === "completed" ||
          item.status === "failed" ||
          item.status === "interrupted" ||
          item.status === "cancelled"),
    );
  })();
  // A compacting turn cannot take steering input, so follow-ups queue meanwhile.
  const canSteerActiveTurn = queueWorkflow?.canPromoteToSteer === true && !isCompacting;
  // A stop or a restart holds the queue, completion wakes included, until it
  // is resumed; the queue sheet lists only the user's own messages.
  const queueHeld = queueWorkflow?.isHeld === true;

  const runlessWorkStartedAt = selectedThreadProjection
    ? deriveRunlessWorkStartedAt(selectedThreadProjection.projection)
    : null;
  const activeWorkStartedAt = (() => {
    if (!selectedThreadShell) {
      return null;
    }
    // A person's `! cmd` can run before the agent's turn starts; that is work too.
    const runningShellCommand =
      selectedThreadProjection?.projection.turnItems.find(isRunningUserShellCommand);
    return (
      resolveThreadWorkingStartedAt({
        latestRun: selectedThreadActivityRun,
        runtime: selectedThreadRuntime,
      }) ??
      runlessWorkStartedAt ??
      (runningShellCommand
        ? DateTime.formatIso(runningShellCommand.startedAt ?? runningShellCommand.updatedAt)
        : null)
    );
  })();
  const runlessWorkActive = runlessWorkStartedAt !== null;

  const providerSubagentStatus = selectedThreadProjection
    ? deriveProviderSubagentStatus(selectedThreadProjection.projection)
    : null;

  const activeThreadBusy = threadRuntimeIsActive(selectedThreadRuntime);
  const interruptibleRunId = threadRuntimeHasInterruptibleRun(selectedThreadRuntime)
    ? (selectedThreadRuntime?.activeRunId ?? null)
    : null;

  const cancelQueuedRunEdit = () => {
    if (selectedThreadKey === null || savingQueuedEditRef.current) return;
    endQueuedRunEdit(selectedThreadKey);
  };

  const onRemoveQueuedEditAttachment = (attachmentId: string) => {
    if (selectedThreadKey === null) return;
    removeQueuedRunEditAttachment(selectedThreadKey, attachmentId);
  };

  const saveQueuedRunEdit = async () => {
    const thread = selectedThreadShell;
    if (!thread || savingQueuedEditRef.current) return;
    const threadKey = scopedThreadKey(thread.environmentId, thread.id);
    const edit = getQueuedRunEdit(threadKey);
    if (edit === null) return;
    const draft = getComposerDraftSnapshot(queuedEditDraftKey(threadKey, edit.runId));
    const shellCommand = edit.shellCommand === true;
    const text = shellCommand ? queuedShellCommandEditText(draft.text) : draft.text.trim();
    if (text.length === 0) {
      Dialog.alert(
        shellCommand ? "Add a command" : "Add a message",
        shellCommand
          ? "A queued command cannot be left empty."
          : "A queued message cannot be left empty.",
      );
      return;
    }
    if (shellCommand && draft.attachments.length > 0) {
      Dialog.alert("Remove attachments", SHELL_COMMAND_CONTENT_BLOCKED);
      return;
    }
    if (
      edit.existingAttachments.length + draft.attachments.length >
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      Dialog.alert(
        "Too many attachments",
        `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
      );
      return;
    }
    const finishSave = startQueuedRunEditSave(threadKey);
    if (finishSave === null) return;
    savingQueuedEditRef.current = true;
    setIsSavingQueuedEdit(true);
    const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
    const prepared = await settlePromise(() =>
      prepareTurnAttachments({
        environmentId: thread.environmentId,
        attachments: draft.attachments,
        supportsImageUploads: capabilities?.attachmentUploads === true,
      }),
    );
    if (AsyncResult.isFailure(prepared)) {
      savingQueuedEditRef.current = false;
      setIsSavingQueuedEdit(false);
      finishSave(false);
      const error = squashAtomCommandFailure(prepared);
      Dialog.alert(
        `Could not save the queued ${shellCommand ? "command" : "message"}`,
        error instanceof Error ? error.message : "Your edit is still in the composer.",
      );
      return;
    }
    if (prepared.value.status !== "ready") {
      savingQueuedEditRef.current = false;
      setIsSavingQueuedEdit(false);
      finishSave(false);
      return;
    }
    const payload = resolveQueuedEditPayload({
      edit,
      draftContext: draft.context,
      draftAttachments: draft.attachments,
      uploaded: prepared.value.attachments,
    });
    const result = await editQueuedRun({
      environmentId: thread.environmentId,
      input: {
        threadId: thread.id,
        runId: edit.runId,
        text: shellCommand ? shellCommandMessageText(text) : text,
        ...(shellCommand ? { shellCommand: true } : {}),
        edit: {
          messageId: edit.messageId,
          attachments: payload.attachments,
          ...(payload.context ? { context: payload.context } : {}),
        },
      },
    });
    savingQueuedEditRef.current = false;
    setIsSavingQueuedEdit(false);
    if (result._tag !== "Success") {
      // The run left the queue during the save; its exit already told the composer what happened.
      if (!finishSave(false)) return;
      // A queued command still runs once the setting is off, but editing it needs the setting.
      const disabled = shellCommandsDisabledReason(squashAtomCommandFailure(result));
      Dialog.alert(
        `Could not save the queued ${shellCommand ? "command" : "message"}`,
        `${disabled ?? "It may have already started."} Your edit is still in the composer.`,
      );
      return;
    }
    // False when the edit was cancelled or begun again meanwhile; its draft is the newer edit's.
    if (finishSave(true)) {
      clearComposerDraft(queuedEditDraftKey(threadKey, edit.runId), {
        deferAttachmentCleanup: true,
      });
    }
    scheduleUnusedComposerAttachmentCleanup(draft.attachments);
  };

  // Resolve at send time because outbox delivery may be delayed.
  // Steering uses "auto" so an ended turn queues a run instead of restoring the draft.
  const resolveFollowUpDispatchMode = (
    activeTurnDefault: ActiveTurnComposerAction,
    followUpOverride: ActiveTurnComposerAction | undefined,
  ): "queue" | "auto" | null => {
    const followUpAction = resolveComposerDispatchMode({
      running: activeThreadBusy && canSteerActiveTurn,
      alternateModifier: followUpOverride !== undefined && followUpOverride !== activeTurnDefault,
      activeTurnDefault,
    });
    const setupRunning = [selectedThreadActivityRun?.status, selectedThreadRuntime?.status].some(
      (status) => status === "preparing" || status === "starting",
    );
    return setupRunning
      ? "queue"
      : followUpAction === "auto"
        ? null
        : followUpAction === "queue"
          ? "queue"
          : "auto";
  };

  /**
   * Runs `commands` as if each were typed as `! command` and sent, without touching the draft.
   * Assistant code blocks only exist in started threads, so there is no thread to create.
   * Several go in one send as a group: each runs after the one before succeeds.
   */
  const runShellCommand = async (commands: ReadonlyArray<string>): Promise<MessageId | null> => {
    const [command, ...following] = commands;
    const thread = selectedThreadShell;
    if (command === undefined) return null;
    if (
      !thread ||
      selectedThreadCreation !== null ||
      !readCanRunShellCommands(thread.environmentId) ||
      (selectedEnvironmentRuntime?.connectionState === "connected" &&
        !readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope))
    ) {
      return null;
    }
    const threadKey = scopedThreadKey(thread.environmentId, thread.id);
    const texts = JSON.stringify(commands.map(shellCommandMessageText));
    // A double tap must not run a code block twice. Read live: the outbox holds the first tap's
    // send at once, and a tap held up by the first-run dialog runs after this render's is stale.
    const alreadyQueued = (
      appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom)[threadKey] ?? []
    ).some(
      (message) =>
        message.shellCommand === true &&
        JSON.stringify([
          message.text,
          ...(message.followingShellCommands ?? []).map((next) => next.text),
        ]) === texts,
    );
    if (alreadyQueued) return null;
    const settings = getComposerDraftSnapshot(threadKey);
    const modelSelection = settings.modelSelection ?? thread.modelSelection;
    const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
      (entry) => entry.instanceId === modelSelection.instanceId,
    );
    const dispatchMode = resolveFollowUpDispatchMode(followUpBehavior, undefined);
    const metadata = makeQueuedMessageMetadata();
    const messageId = MessageId.make(metadata.messageId);
    clearThreadComposerError(threadKey);
    const queued = await settlePromise(() =>
      enqueueThreadOutboxMessage({
        environmentId: thread.environmentId,
        threadId: thread.id,
        messageId,
        commandId: CommandId.make(metadata.commandId),
        text: shellCommandMessageText(command),
        shellCommand: true,
        ...(following.length === 0
          ? {}
          : {
              followingShellCommands: following.map((next) => ({
                messageId: MessageId.make(makeQueuedMessageMetadata().messageId),
                text: shellCommandMessageText(next),
              })),
            }),
        attachments: [],
        modelSelection,
        runtimeMode: settings.runtimeMode ?? thread.runtimeMode,
        interactionMode: resolveProviderInteractionMode(
          provider,
          settings.interactionMode ?? thread.interactionMode,
        ),
        ...(dispatchMode === null ? {} : { dispatchMode }),
        createdAt: metadata.createdAt,
      }),
    );
    if (AsyncResult.isFailure(queued)) {
      const error = squashAtomCommandFailure(queued);
      setThreadComposerError(
        threadKey,
        error instanceof Error ? error.message : "Failed to save the command.",
      );
      return null;
    }
    return messageId;
  };

  // Commands above the composer until their results reach the agent.
  const liveShellCommands = selectedThreadProjection
    ? liveUserShellCommands(selectedThreadProjection.projection)
    : EMPTY_LIVE_SHELL_COMMANDS;
  // The outbox and acknowledged sends stand in for web's optimistic ones; a send queued behind a
  // turn waits with the queued messages instead.
  const userShellCommandOwnsWorkingSlot = deriveUserShellCommandOwnsWorkingSlot({
    projection: selectedThreadProjection?.projection ?? null,
    sendingShellMessageIds: [
      ...(selectedThreadKey === null ? [] : (queuedMessagesByThreadKey[selectedThreadKey] ?? [])),
      ...acknowledgedMessages.filter(
        (message) => scopedThreadKey(message.environmentId, message.threadId) === selectedThreadKey,
      ),
    ].flatMap((message) =>
      message.shellCommand === true && message.dispatchMode !== "queue" ? [message.messageId] : [],
    ),
  });

  /** Puts `command` into the composer in shell mode, asking before replacing a draft. */
  const offerShellCommand = (
    command: string,
    prompt: { readonly title: string; readonly message: string },
    onPlaced?: () => void,
  ) => {
    const thread = selectedThreadShell;
    if (!thread) return;
    const threadKey = scopedThreadKey(thread.environmentId, thread.id);
    if (getQueuedRunEdit(threadKey) !== null) {
      Dialog.alert("Finish editing the queued message first.");
      return;
    }
    const place = () => {
      clearComposerDraftContent(threadKey);
      setComposerDraftText(threadKey, shellCommandPrompt(command), {
        shellMode: true,
        canRunShellCommands: composerCanRunShellCommands(thread),
      });
      // Against the text the draft kept, or the editor ignores the caret and leaves it at the start.
      const stored = getComposerDraftSnapshot(threadKey).text;
      rememberComposerDraftSelection(threadKey, stored, {
        start: stored.length,
        end: stored.length,
      });
      onPlaced?.();
    };
    if (composerDraftIsBlank(getComposerDraftSnapshot(threadKey))) {
      place();
      return;
    }
    Dialog.alert(prompt.title, prompt.message, [
      { text: "Keep mine", style: "cancel" },
      { text: "Replace", style: "destructive", onPress: place },
    ]);
  };

  const editShellCommand = (command: string, onPlaced?: () => void) =>
    offerShellCommand(
      command,
      { title: "Replace your draft?", message: "The composer already has a draft." },
      onPlaced,
    );

  // Mobile has no prompt history to keep a stopped command in while a draft is there, so it asks.
  const returnStoppedShellCommand = (command: string) => {
    const thread = selectedThreadShell;
    if (!thread) return;
    const threadKey = scopedThreadKey(thread.environmentId, thread.id);
    if (getQueuedRunEdit(threadKey) !== null) return;
    const returned = returnStoppedShellCommandToDraft(threadKey, command, {
      canRunShellCommands: readCanRunShellCommands(thread.environmentId),
    });
    if (returned !== "draft") return;
    offerShellCommand(command, {
      title: "Replace your draft with the stopped command?",
      message: shellCommandPrompt(command),
    });
  };

  /**
   * The composer's Stop while the thread's commands are all it does: they stop as their own Stop
   * would. False where Stop interrupts the thread instead.
   */
  const stopShellCommandsInsteadOfThread = (): boolean => {
    const thread = selectedThreadShell;
    if (!thread || !readEnvironmentScope(thread.environmentId, AuthTerminalOperateScope)) {
      return false;
    }
    const stopping = stopComposerShellCommands({
      projection: selectedThreadProjection?.projection ?? null,
      stop: async (command) =>
        (
          await stopUserShellCommand({
            environmentId: thread.environmentId,
            input: { threadId: command.threadId, turnItemId: command.id },
          })
        )._tag === "Success",
      onStoppedRunning: (command) => returnStoppedShellCommand(command.input),
    });
    return stopping !== null;
  };

  const onSendMessage = async (
    followUpOverride?: ActiveTurnComposerAction,
    beforeDispatch?: (
      text: string,
      hasAttachmentsOrContext: boolean,
    ) => Promise<boolean | "responded">,
  ) => {
    if (
      selectedThreadShell &&
      selectedEnvironmentRuntime?.connectionState === "connected" &&
      !readEnvironmentScope(selectedThreadShell.environmentId, AuthOrchestrationOperateScope)
    )
      return null;
    if (!selectedThreadShell) {
      return null;
    }
    // Before thread creation succeeds, follow-ups could become orphaned and be dropped by the drain.
    if (selectedThreadCreation !== null) {
      return null;
    }

    const editKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    if (getQueuedRunEdit(editKey) !== null) {
      await saveQueuedRunEdit();
      return null;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const draft = getComposerDraftSnapshot(threadKey);
    if (appAtomRegistry.get(composerContextImportsAtom)[threadKey]) return null;
    const thread = selectedThreadShell;
    const text = draft.text.trim();
    const attachments = draft.attachments;
    if (
      composerAttachmentUploadBlockReason({
        environmentId: selectedThreadShell.environmentId,
        attachments,
        connected: selectedEnvironmentRuntime?.connectionState === "connected",
        serverConfig: selectedEnvironmentRuntime?.serverConfig ?? null,
        states: appAtomRegistry.get(composerAttachmentUploadsAtom),
      }) !== null
    )
      return null;
    if (text.length === 0 && attachments.length === 0) {
      return null;
    }
    const shellSend = resolveComposerShellSend({
      draft,
      canRunShellCommands: readCanRunShellCommands(selectedThreadShell.environmentId),
    });
    if (shellSend.kind === "empty") return null;
    if (shellSend.kind === "blocked") {
      Dialog.alert("Can't run this command", shellSend.reason);
      return null;
    }
    const shellCommand = shellSend.kind === "command" ? shellSend.command : null;
    // Recovery preserves over-cap attachments; require trimming or outbox delivery would reject indefinitely.
    if (attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      Dialog.alert(
        "Too many attachments",
        `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
      );
      return null;
    }

    const contextBlockReason = composerContextSendBlockReason(draft.context);
    if (contextBlockReason) {
      Dialog.alert("Too much context", contextBlockReason);
      return null;
    }

    const modelSelection = draft.modelSelection ?? thread.modelSelection;
    const serverConfig = selectedEnvironmentRuntime?.serverConfig;
    if (
      selectedEnvironmentRuntime?.connectionState === "connected" &&
      isModelSelectionUnavailable(serverConfig, modelSelection, thread.projectId)
    ) {
      const { title, detail } = describeUnavailableModelSelection(
        serverConfig,
        modelSelection,
        thread.projectId,
      );
      Dialog.alert(title, detail);
      return null;
    }
    const provider = serverConfig?.providers.find(
      (entry) => entry.instanceId === modelSelection.instanceId,
    );
    const feedbackCommand =
      shellCommand === null && attachments.length === 0 && provider?.driver === "codex"
        ? parseCodexFeedbackCommand(text)
        : null;
    if (feedbackCommand) {
      if (!readEnvironmentScope(selectedThreadShell.environmentId, AuthOrchestrationOperateScope))
        return null;
      if (thread.activeProviderThreadId === null) {
        Dialog.alert("Start a Codex thread first", "Send a message before you submit feedback.");
        return null;
      }
      const metadata = makeQueuedMessageMetadata();
      await submitCodexFeedback({
        submission: {
          id: MessageId.make(metadata.messageId),
          command: text,
          createdAt: metadata.createdAt,
        },
        clearDraft: () => clearComposerDraftContent(threadKey),
        onUpdate: (submission) => {
          setFeedbackSubmissionsByThreadKey((current) => {
            const existing = current[threadKey] ?? [];
            const found = existing.some((entry) => entry.id === submission.id);
            return {
              ...current,
              [threadKey]: found
                ? existing.map((entry) => (entry.id === submission.id ? submission : entry))
                : [...existing, submission],
            };
          });
        },
        upload: () =>
          uploadThreadFeedback({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, ...feedbackCommand },
          }),
      });
      return null;
    }

    // A command isn't an answer to the agent, so it leaves pending approvals alone.
    if (beforeDispatch !== undefined && shellCommand === null) {
      const response = await beforeDispatch(
        text,
        attachments.length > 0 || draft.context !== undefined,
      );
      if (!response) return null;
      // A context paste still landing, or any draft or settings change while approvals were
      // declined, means this snapshot is no longer what the user sent.
      if (appAtomRegistry.get(composerContextImportsAtom)[threadKey]) return null;
      const current = getComposerDraftSnapshot(threadKey);
      if (
        current.text !== draft.text ||
        JSON.stringify(current.context) !== JSON.stringify(draft.context) ||
        JSON.stringify(current.modelSelection) !== JSON.stringify(draft.modelSelection) ||
        current.runtimeMode !== draft.runtimeMode ||
        current.interactionMode !== draft.interactionMode ||
        current.attachments.length !== attachments.length ||
        current.attachments.some((attachment, index) => attachment.id !== attachments[index]?.id)
      )
        return null;
      if (response === "responded") {
        clearComposerDraftContent(threadKey);
        return null;
      }
    }

    // A redirect declined approvals to steer the waiting turn, not to queue behind it.
    const followUpDispatchMode = resolveFollowUpDispatchMode(
      beforeDispatch !== undefined && shellCommand === null ? "steer" : followUpBehavior,
      followUpOverride,
    );

    const metadata = makeQueuedMessageMetadata();
    const messageId = MessageId.make(metadata.messageId);
    clearThreadComposerError(threadKey);
    const enqueuePromise = enqueueThreadOutboxMessage({
      environmentId: selectedThreadShell.environmentId,
      threadId: selectedThreadShell.id,
      messageId,
      commandId: CommandId.make(metadata.commandId),
      ...(shellCommand === null
        ? { text }
        : { text: shellCommandMessageText(shellCommand), shellCommand: true }),
      attachments,
      context: draft.context,
      modelSelection,
      runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
      interactionMode: resolveProviderInteractionMode(
        provider,
        draft.interactionMode ?? thread.interactionMode,
      ),
      ...(followUpDispatchMode === null ? {} : { dispatchMode: followUpDispatchMode }),
      createdAt: metadata.createdAt,
    });
    clearComposerDraftContent(threadKey, { deferAttachmentCleanup: true });
    enqueuePromise.then(
      () => scheduleUnusedComposerAttachmentCleanup(attachments),
      (error: unknown) => {
        // Restore with uncapped append; capped merge could drop attachments added during the failed write.
        const failedMessage =
          error instanceof Error ? error.message : "Failed to save the queued message.";
        const restored = () => {
          appendComposerDraftAttachments(threadKey, attachments, { allowOverflow: true });
          setThreadComposerError(threadKey, failedMessage);
        };
        // A merge that fails to persist has still published the text.
        const restore = () =>
          mergeComposerDraftContent(threadKey, {
            ...(shellCommand === null
              ? { text }
              : { text: shellCommandMessageText(shellCommand), shellCommand: true }),
            context: draft.context,
            attachments: [],
          }).then(restored, (restoreError: unknown) => {
            if (restoreError instanceof ComposerDraftKindConflictError) throw restoreError;
            restored();
          });
        void restore().catch((restoreError: ComposerDraftKindConflictError) => {
          // Something of the other kind was typed meanwhile; joining them would change what runs.
          Dialog.alert(`${failedMessage} Replace your draft with it?`, restoreError.message, [
            {
              text: "Keep mine",
              style: "cancel",
              onPress: () => scheduleUnusedComposerAttachmentCleanup(attachments),
            },
            {
              text: "Replace",
              style: "destructive",
              onPress: () => {
                clearComposerDraftContent(threadKey);
                void restore();
              },
            },
          ]);
        });
      },
    );
    return messageId;
  };

  const onChangeDraftMessage = (value: string) => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = activeComposerDraftKey(selectedThreadShell);
    setComposerDraftText(threadKey, value, {
      canRunShellCommands: composerCanRunShellCommands(selectedThreadShell),
    });
  };

  const { onPickDraftMedia, onPickDraftFiles, onNativePasteImages, onNativePasteText } =
    useComposerAttachmentActions({
      draftKey: selectedThreadShell ? activeComposerDraftKey(selectedThreadShell) : null,
      serverConfig: selectedEnvironmentRuntime?.serverConfig,
    });

  const onPasteIntoDraft = async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = activeComposerDraftKey(selectedThreadShell);
    const insertion = captureComposerDraftInsertion(threadKey);
    const result = await pasteComposerClipboard({
      existingCount: countComposerDraftAttachmentsAfterSelection(threadKey, insertion),
    });
    const rejectedPasteCount = appendComposerDraftAttachments(threadKey, result.images, {
      appendReference: true,
      insertion,
    });
    if (result.text) {
      const currentDraft = getComposerDraftSnapshot(threadKey);
      const currentAttachments = currentDraft.attachments;
      const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
      const advertisedMax =
        capabilities?.attachmentUploads === true
          ? capabilities.fileAttachments?.maxUploadBytes
          : undefined;
      const maxBytes =
        advertisedMax === undefined ? null : clampFileAttachmentUploadBytes(advertisedMax);
      const wouldExceedInputLimit =
        currentDraft.text.length -
          (currentDraft.text === insertion.text
            ? Math.max(0, insertion.end - insertion.start)
            : 0) +
          result.text.length >
        PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
      const shouldFold =
        pastedTextDisposition({
          text: result.text,
          wouldExceedInputLimit,
          canAttach: true,
        }) === "attachment";
      const canAttach =
        maxBytes !== null &&
        countComposerDraftAttachmentsAfterSelection(threadKey, insertion) <
          PROVIDER_SEND_TURN_MAX_ATTACHMENTS &&
        new TextEncoder().encode(result.text).byteLength <= maxBytes;
      if (shouldFold && canAttach && maxBytes !== null) {
        try {
          const attachment = await createPastedTextComposerAttachment({
            text: result.text,
            name: reservePastedTextFileName(
              threadKey,
              currentAttachments.map((item) => item.name),
            ),
            maxBytes,
          });
          if (
            appendComposerDraftAttachments(threadKey, [attachment], {
              appendReference: true,
              insertion,
            }) > 0
          ) {
            await removePersistedComposerAttachmentFile(attachment.fileUri);
            setPendingConnectionError(
              `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
            );
          }
        } catch (error) {
          setPendingConnectionError(
            error instanceof Error ? error.message : "Could not attach pasted text.",
          );
        }
      } else if (shouldFold && !wouldExceedInputLimit) {
        insertComposerDraftText(threadKey, result.text, insertion, {
          canRunShellCommands: composerCanRunShellCommands(selectedThreadShell),
        });
      } else if (shouldFold) {
        setPendingConnectionError(
          wouldExceedInputLimit
            ? "Pasted text is too large for this message. Remove some text or an attachment, then paste again."
            : "Could not attach pasted text. Remove an attachment or use a smaller paste, then try again.",
        );
      } else {
        insertComposerDraftText(threadKey, result.text, insertion, {
          canRunShellCommands: composerCanRunShellCommands(selectedThreadShell),
        });
      }
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    } else if (rejectedPasteCount > 0) {
      setPendingConnectionError(
        `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
      );
    }
  };

  const onRemoveDraftImage = (imageId: string) => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = activeComposerDraftKey(selectedThreadShell);
    removeComposerDraftAttachment(threadKey, imageId);
  };

  const onUpdateInteractionMode = (value: ProviderInteractionMode) => {
    if (!selectedThreadKey) {
      return;
    }
    const modelSelection =
      getComposerDraftSnapshot(selectedThreadKey).modelSelection ?? selectedThread?.modelSelection;
    const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
      (candidate) => candidate.instanceId === modelSelection?.instanceId,
    );
    updateComposerDraftSettings(selectedThreadKey, {
      interactionMode: resolveProviderInteractionMode(provider, value),
    });
  };

  return {
    feedbackSubmissions,
    dismissFeedback,
    selectedThreadFeed,
    selectedThreadActivityRun,
    selectedThreadQueueCount,
    selectedThreadQueuedMessages,
    dispatchingQueuedMessageId,
    activeWorkStartedAt,
    runlessWorkActive,
    providerSubagentStatus,
    isCompacting,
    composerDraftKey,
    followUpBehavior,
    canSteerActiveTurn,
    queueHeld,
    queuedRunEdit,
    isSavingQueuedEdit,
    cancelQueuedRunEdit,
    onRemoveQueuedEditAttachment,
    modelSelection,
    pendingHandoff,
    canSwitchThreadProvider,
    runtimeMode,
    interactionMode,
    activeThreadBusy,
    interruptibleRunId,
    onChangeDraftMessage,
    onPickDraftMedia,
    onPickDraftFiles,
    onPasteIntoDraft,
    onNativePasteImages,
    onNativePasteText,
    onRemoveDraftImage,
    onSendMessage,
    runShellCommand,
    editShellCommand,
    liveShellCommands,
    userShellCommandOwnsWorkingSlot,
    returnStoppedShellCommand,
    stopShellCommandsInsteadOfThread,
    onUpdateInteractionMode,
  };
}
