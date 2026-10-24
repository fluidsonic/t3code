import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function isAutomaticCompletionRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  run: OrchestrationV2Run,
): boolean {
  return projection.messages.some(
    (message) => message.id === run.userMessageId && message.delegatedCompletion !== undefined,
  );
}

export function queuedRunsInDeliveryOrder(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages">,
): ReadonlyArray<OrchestrationV2Run> {
  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter((message) => message.delegatedCompletion !== undefined)
      .map((message) => message.id),
  );
  // A steer waiting for steered shell commands goes first: it was meant for the running turn.
  // Only a thread that ran one can hold such a steer.
  const steeredMessageIds = new Set(
    projection.thread.hasShellCommands === true
      ? projection.messages
          .filter((message) => message.shellSteer === true)
          .map((message) => message.id)
      : [],
  );
  const queued = projection.runs
    .filter((run) => run.status === "queued")
    .toSorted(
      (left, right) =>
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal,
    );
  const steers = queued.filter((run) => steeredMessageIds.has(run.userMessageId));
  const rest = queued.filter((run) => !steeredMessageIds.has(run.userMessageId));
  const completions = rest.filter((run) => automaticCompletionMessageIds.has(run.userMessageId));
  const messages = rest.filter((run) => !automaticCompletionMessageIds.has(run.userMessageId));
  // Completions and messages each keep their queue order and interleave by request time,
  // so neither kind can hold the other back while more of it keeps arriving.
  const ordered: Array<OrchestrationV2Run> = [...steers];
  let completionIndex = 0;
  let messageIndex = 0;
  for (;;) {
    const completion = completions[completionIndex];
    const message = messages[messageIndex];
    if (completion === undefined || message === undefined) {
      return [...ordered, ...completions.slice(completionIndex), ...messages.slice(messageIndex)];
    }
    if (
      DateTime.toEpochMillis(completion.requestedAt) <= DateTime.toEpochMillis(message.requestedAt)
    ) {
      ordered.push(completion);
      completionIndex += 1;
    } else {
      ordered.push(message);
      messageIndex += 1;
    }
  }
}
