import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

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
  const priority = (run: OrchestrationV2Run) =>
    steeredMessageIds.has(run.userMessageId)
      ? 2
      : automaticCompletionMessageIds.has(run.userMessageId)
        ? 1
        : 0;
  return projection.runs
    .filter((run) => run.status === "queued")
    .toSorted((left, right) => {
      const deliveryPriority = priority(right) - priority(left);
      return (
        deliveryPriority ||
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal
      );
    });
}
