import {
  type ChatAttachment,
  type MessageId,
  type OrchestrationMessageContext,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserShellBypassedMode,
} from "@t3tools/contracts";
import {
  formatUserShellCommandPrompt,
  isUserShellCommandItem,
  type UserShellCommandResult,
} from "@t3tools/provider-core/server/userShellCommand";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import {
  isPartialShellCommandOutput,
  shellCommandFromMessageText,
} from "@t3tools/shared/shellCommand";
import * as DateTime from "effect/DateTime";

import { resolveAttachmentPath } from "../attachmentStore.ts";

/** The title a command's item carries; see `scheduleUserShellCommand` in the orchestrator. */
export const USER_SHELL_COMMAND_TITLE = "Your shell command";

/** The thread modes a command sent now runs outside of, since it runs on the machine directly. */
export function userShellBypassedModes(
  thread: Pick<OrchestrationV2AppThread, "runtimeMode" | "interactionMode">,
): Array<OrchestrationV2UserShellBypassedMode> {
  return [
    ...(thread.runtimeMode === "approval-required" ? (["supervised"] as const) : []),
    ...(thread.interactionMode === "plan" ? (["plan"] as const) : []),
  ];
}

/**
 * Only a person sending from a client creates a command. Agents, scheduled tasks, and server
 * automations reach `message.dispatch` too, so the flag is refused for every other origin even
 * though the RPC scope already guards the client path.
 */
export function userShellDispatchRejection(
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
): string | null {
  if (command.shellCommand !== true) {
    return command.followingShellCommands === undefined
      ? null
      : "Only shell commands can be sent as a group.";
  }
  if (
    command.createdBy !== "user" ||
    (command.creationSource !== "web" && command.creationSource !== "mobile")
  ) {
    return "Only a person can run a shell command from the composer.";
  }
  if (
    command.scheduledTaskId !== undefined ||
    command.notification !== undefined ||
    command.delegatedCompletion !== undefined ||
    command.restartContinuationOfRunId !== undefined ||
    command.usageLimitContinuationOfRunId !== undefined ||
    command.manualContinuationOfRunId !== undefined ||
    command.usageLimitRecoveryRequestId !== undefined ||
    command.sourcePlanRef !== undefined ||
    command.senderThreadId !== undefined
  ) {
    return "A shell command cannot carry automation or continuation fields.";
  }
  if (shellCommandFromMessageText(command.text).length === 0) {
    return "A shell command needs a command to run.";
  }
  if (command.attachments.length > 0) return "A shell command cannot have attachments.";
  return null;
}

export function isShellCommandMessage(
  message: Pick<OrchestrationV2ConversationMessage, "shellCommand"> | undefined,
): boolean {
  return message?.shellCommand === true;
}

/** The result a finished command item hands to the formatter, or null while it has none. */
function userShellCommandResult(
  item: OrchestrationV2TurnItem,
  fullOutput: UserShellCommandResult["fullOutput"],
): UserShellCommandResult | null {
  if (!isUserShellCommandItem(item)) return null;
  if (item.status !== "completed" && item.status !== "failed") return null;
  return {
    command: item.input,
    exitCode: item.exitCode ?? (item.status === "completed" ? 0 : 1),
    durationMs:
      item.startedAt === null || item.completedAt === null
        ? 0
        : DateTime.toEpochMillis(item.completedAt) - DateTime.toEpochMillis(item.startedAt),
    output: item.output ?? "",
    ...(fullOutput === undefined ? {} : { fullOutput }),
    ...(item.userShellSkipped === true ? { skipped: true } : {}),
  };
}

export interface UserShellPromptEntry {
  readonly messageId: MessageId;
  readonly shellCommand?: boolean | undefined;
  readonly text: string;
  readonly context?: OrchestrationMessageContext | undefined;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

/**
 * The provider prompt for messages that include `! cmd` commands: each finished command's result
 * in the harness's own format, then the text of a message that followed them. A stopped command
 * is left out. Saved output is named by path in the result, so it is not attached again.
 */
export function composeUserShellPrompt(input: {
  readonly driver: string;
  readonly entries: ReadonlyArray<UserShellPromptEntry>;
  readonly commandItem: (messageId: MessageId) => OrchestrationV2TurnItem | undefined;
  readonly attachmentsDir: string;
}): { readonly text: string; readonly attachments: ReadonlyArray<ChatAttachment> } {
  const results: Array<UserShellCommandResult> = [];
  const texts: Array<string> = [];
  const attachments: Array<ChatAttachment> = [];
  for (const entry of input.entries) {
    if (entry.shellCommand !== true) {
      texts.push(
        projectComposerContextForProvider({
          text: entry.text,
          records: entry.context?.records ?? [],
        }),
      );
      attachments.push(...entry.attachments);
      continue;
    }
    const item = input.commandItem(entry.messageId);
    const saved = entry.attachments.find((attachment) => attachment.type === "file");
    const path =
      saved === undefined
        ? null
        : resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment: saved });
    const result =
      item === undefined
        ? null
        : userShellCommandResult(
            item,
            saved === undefined || path === null
              ? undefined
              : {
                  path,
                  sizeBytes: saved.sizeBytes,
                  partial: isPartialShellCommandOutput(saved),
                },
          );
    if (result !== null) results.push(result);
  }
  const message = texts.filter((text) => text.trim().length > 0).join("\n\n");
  return {
    text: formatUserShellCommandPrompt({
      driver: input.driver,
      results,
      ...(message.length === 0 ? {} : { message }),
    }),
    attachments,
  };
}
