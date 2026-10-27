import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import {
  MessageId,
  type NodeId,
  type OrchestrationV2TurnItem,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import type * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { userShellCommandItemId } from "@t3tools/shared/shellCommand";
import { composeUserShellPrompt } from "./UserShellCommands.ts";

const yieldToRuntime = Effect.yieldNow.pipe(
  Effect.andThen(
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          setImmediate(resolve);
        }),
    ),
  ),
);

export class ProviderTurnControlError extends Schema.TaggedError<ProviderTurnControlError>()(
  "ProviderTurnControlError",
  {
    threadId: ThreadId,
    operation: Schema.Literals(["interrupt", "restart", "steer"]),
    providerTurnId: ProviderTurnId,
    turnCompleted: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isProviderTurnControlError = Schema.is(ProviderTurnControlError);

/**
 * How long a steered `! cmd` waits for the agent to reach a steering window before its turn is
 * interrupted instead. Long enough for a slow tool call to finish; a provider whose hooks never
 * fire (managed settings turned them off) costs at most this.
 */
const USER_SHELL_PAUSE_TIMEOUT = "5 minutes";

export interface ProviderTurnControlServiceV2Shape {
  readonly interrupt: (input: {
    readonly subagent?: {
      readonly id: NodeId;
      readonly nativeTaskId: string;
      readonly requestedAt?: DateTime.Utc;
    };
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
  }) => Effect.Effect<
    void | ProviderAdapter.ProviderAdapterV2SubagentOutcome,
    ProviderTurnControlError
  >;
  readonly steer: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly messageId: MessageId;
  }) => Effect.Effect<void, ProviderTurnControlError>;
  /**
   * Holds the running turn at its next steering window for steered `! cmd` commands. Anything
   * short of `paused` (no live session, a provider that cannot hold, the timeout) means the
   * caller interrupts the turn instead.
   */
  readonly pause: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2PauseOutcome>;
  /**
   * Lets a paused turn continue with these delivered messages, composed as one steered input.
   * `false` when they could not reach the turn (it ended, its session is gone, the provider
   * refused); the caller sends them again so the results still reach the agent.
   */
  readonly release: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly messageIds: ReadonlyArray<MessageId>;
  }) => Effect.Effect<boolean>;
  readonly interruptAndAwaitTerminal: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly replacementProviderSessionId?: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly interruptedAttemptId: RunAttemptId;
  }) => Effect.Effect<void, ProviderTurnControlError>;
}

export class ProviderTurnControlServiceV2 extends Context.Service<
  ProviderTurnControlServiceV2,
  ProviderTurnControlServiceV2Shape
>()("t3/orchestration-v2/ProviderTurnControlService/ProviderTurnControlServiceV2") {}

export const layer: Layer.Layer<
  ProviderTurnControlServiceV2,
  never,
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ServerConfig.ServerConfig
> = Layer.effect(
  ProviderTurnControlServiceV2,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

    const load = Effect.fn("ProviderTurnControlService.load")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerSessionId: ProviderSessionId;
      readonly replacementProviderSessionId?: ProviderSessionId;
      readonly providerThreadId: ProviderThreadId;
      readonly providerTurnId: ProviderTurnId;
      readonly operation: "interrupt" | "restart" | "steer";
      readonly messageId?: MessageId;
    }) {
      const context = yield* projections.getProviderControlContext(input.threadId, input);
      const { providerThread, providerTurn } = context;
      const targetsRecordedSession = providerThread?.providerSessionId === input.providerSessionId;
      const targetsCommittedReplacement =
        input.operation === "restart" &&
        input.replacementProviderSessionId !== undefined &&
        providerThread?.providerSessionId === input.replacementProviderSessionId;
      if (
        providerThread === undefined ||
        providerTurn === undefined ||
        (!targetsRecordedSession && !targetsCommittedReplacement) ||
        providerTurn.providerThreadId !== providerThread.id
      ) {
        return yield* new ProviderTurnControlError({
          threadId: input.threadId,
          operation: input.operation,
          providerTurnId: input.providerTurnId,
          cause: "The recorded provider execution target is no longer valid.",
        });
      }
      // A restart-session command commits the replacement binding before its
      // process-bound effect runs. The old live runtime must still receive
      // the interrupt, but only when the projection matches the exact
      // replacement captured by that same durable effect.
      const interruptProviderThread = targetsRecordedSession
        ? providerThread
        : { ...providerThread, providerSessionId: input.providerSessionId };
      if (providerTurn.status !== "running") {
        if (input.operation === "steer") {
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: "steer",
            providerTurnId: input.providerTurnId,
            turnCompleted: providerTurn.status === "completed",
            cause: "The provider turn ended before the steering message was delivered.",
          });
        }
        return {
          context,
          providerThread: interruptProviderThread,
          providerTurn,
          session: Option.none(),
        };
      }
      const session = yield* sessions.get(input.providerSessionId);
      if (Option.isNone(session)) {
        // Interrupt/restart against a already-released session must not fail
        // the durable effect (and retry 5x). The turn may still look running
        // in projection until recovery/finalization; there is no live adapter
        // to interrupt.
        if (input.operation === "interrupt" || input.operation === "restart") {
          yield* Effect.logWarning(
            "Provider interrupt/restart found no live session; treating as already stopped",
            {
              threadId: input.threadId,
              operation: input.operation,
              providerSessionId: input.providerSessionId,
              providerTurnId: input.providerTurnId,
              providerTurnStatus: providerTurn.status,
            },
          );
          return {
            context,
            providerThread: interruptProviderThread,
            providerTurn,
            session: Option.none(),
          };
        }
        return yield* new ProviderTurnControlError({
          threadId: input.threadId,
          operation: input.operation,
          providerTurnId: input.providerTurnId,
          cause: `Provider session ${input.providerSessionId} is not active.`,
        });
      }
      return { context, providerThread: interruptProviderThread, providerTurn, session };
    });

    return ProviderTurnControlServiceV2.of({
      interrupt: Effect.fn("ProviderTurnControlService.interrupt")(
        function* (input) {
          const loaded = yield* load({ ...input, operation: "interrupt" });
          const session = Option.isSome(loaded.session)
            ? loaded.session
            : yield* sessions.get(input.providerSessionId);
          if (Option.isNone(session)) {
            if (input.subagent !== undefined) {
              return yield* new ProviderTurnControlError({
                threadId: input.threadId,
                operation: "interrupt",
                providerTurnId: input.providerTurnId,
                cause: "No live provider session can confirm this subagent's outcome.",
              });
            }
            return;
          }
          if (input.subagent !== undefined) {
            if (session.value.stopSubagent === undefined) {
              return yield* new ProviderTurnControlError({
                threadId: input.threadId,
                operation: "interrupt",
                providerTurnId: input.providerTurnId,
                cause: "The provider does not support stopping a native subagent.",
              });
            }
            return yield* session.value.stopSubagent({
              providerThread: loaded.providerThread,
              nativeTaskId: input.subagent.nativeTaskId,
              ...(input.subagent.requestedAt === undefined
                ? {}
                : { requestedAt: input.subagent.requestedAt }),
            });
          }
          // Settled turns still reach adapters, which alone know whether background work remains.
          yield* session.value.interruptTurn({
            providerThread: loaded.providerThread,
            providerTurnId: loaded.providerTurn.id,
            requestRuntimeRestart: true,
          });
          // Use real time; ingestion fibers do not advance TestClock and would leave Stop blocked.
          yield* Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + 2_000;
            while (
              loaded.providerTurn.status === "running" &&
              (yield* Clock.currentTimeMillis) < deadline
            ) {
              const current = yield* projections.getProviderControlContext(input.threadId, input);
              if (
                current.providerTurn?.status !== "running" &&
                current.attempt?.status !== "running"
              ) {
                return;
              }
              yield* Effect.sleep("10 millis");
            }
          }).pipe(Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()));
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnControlError(cause)
                ? cause
                : new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "interrupt",
                    providerTurnId: input.providerTurnId,
                    cause,
                  }),
            ),
          ),
      ),
      interruptAndAwaitTerminal: Effect.fn("ProviderTurnControlService.interruptAndAwaitTerminal")(
        function* (input) {
          const loaded = yield* load({ ...input, operation: "restart" });
          if (Option.isNone(loaded.session)) {
            // Without a live adapter, no terminal event can arrive; proceed to detach/start without polling.
            if (loaded.providerTurn.status === "running") {
              yield* Effect.logWarning(
                "Provider restart interrupt skipped; no live session for a still-projected running turn",
                {
                  threadId: input.threadId,
                  providerSessionId: input.providerSessionId,
                  providerTurnId: input.providerTurnId,
                },
              );
            }
            return;
          }

          yield* loaded.session.value.interruptTurn({
            providerThread: loaded.providerThread,
            providerTurnId: loaded.providerTurn.id,
          });

          for (let remaining = 1_000; remaining > 0; remaining -= 1) {
            const { providerTurn, attempt } = yield* projections.getProviderControlContext(
              input.threadId,
              {
                providerThreadId: input.providerThreadId,
                providerTurnId: input.providerTurnId,
                attemptId: input.interruptedAttemptId,
              },
            );
            if (
              providerTurn !== undefined &&
              providerTurn.status !== "running" &&
              attempt !== undefined &&
              attempt.status !== "running"
            ) {
              return;
            }
            // Yield through Node's event loop; detached ingestion cannot advance a deterministic Effect clock.
            yield* yieldToRuntime;
          }
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: "restart",
            providerTurnId: input.providerTurnId,
            cause: `Provider turn ${input.providerTurnId} did not terminalize before restart.`,
          });
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnControlError(cause)
                ? cause
                : new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "restart",
                    providerTurnId: input.providerTurnId,
                    cause,
                  }),
            ),
          ),
      ),
      pause: Effect.fn("ProviderTurnControlService.pause")(
        function* (input) {
          const { providerThread, providerTurn } = yield* projections.getProviderControlContext(
            input.threadId,
            input,
          );
          if (providerThread === undefined || providerTurn?.status !== "running") {
            return "turn_ended" as const;
          }
          const session = yield* sessions.get(input.providerSessionId);
          const pauseTurn = Option.isSome(session) ? session.value.pauseTurn : undefined;
          if (pauseTurn === undefined) return "unsupported" as const;
          const outcome = yield* pauseTurn({
            providerThread,
            providerTurnId: providerTurn.id,
          }).pipe(Effect.timeoutOption(USER_SHELL_PAUSE_TIMEOUT));
          return Option.getOrElse(outcome, () => "unsupported" as const);
        },
        (effect, input) =>
          effect.pipe(
            Effect.catch((cause) =>
              Effect.logWarning("orchestration-v2.user-shell-pause-failed", {
                threadId: input.threadId,
                providerTurnId: input.providerTurnId,
                cause,
              }).pipe(Effect.as("unsupported" as const)),
            ),
          ),
      ),
      release: Effect.fn("ProviderTurnControlService.release")(
        function* (input) {
          const { providerThread } = yield* projections.getProviderControlContext(
            input.threadId,
            input,
          );
          const session = yield* sessions.get(input.providerSessionId);
          if (providerThread === undefined || Option.isNone(session)) {
            return input.messageIds.length === 0;
          }
          const records =
            input.messageIds.length === 0
              ? { messages: [] }
              : yield* projections.getThreadRecords(input.threadId, ["messages"], {
                  messageIds: [...input.messageIds],
                });
          const entries = input.messageIds.flatMap((id) => {
            const message = records.messages.find((candidate) => candidate.id === id);
            return message === undefined ? [] : [{ ...message, messageId: message.id }];
          });
          const commandItems = new Map<MessageId, OrchestrationV2TurnItem>();
          for (const entry of entries) {
            if (entry.shellCommand !== true) continue;
            const item = yield* projections.getTurnItem({
              threadId: input.threadId,
              itemId: userShellCommandItemId(entry.messageId),
            });
            if (item !== null) commandItems.set(entry.messageId, item);
          }
          const first = entries[0];
          const prompt =
            first === undefined
              ? undefined
              : composeUserShellPrompt({
                  driver: providerThread.driver,
                  entries,
                  commandItem: (messageId) => commandItems.get(messageId),
                  attachmentsDir: serverConfig.attachmentsDir,
                });
          const message =
            first === undefined || prompt === undefined
              ? undefined
              : {
                  messageId: first.id,
                  text: prompt.text,
                  attachments: prompt.attachments,
                  createdBy: first.createdBy,
                  creationSource: first.creationSource,
                };
          // A hold continues with text; attachments, from a steered message, follow as a steer.
          const withText = message !== undefined && message.attachments.length === 0;
          const released =
            session.value.releaseTurn === undefined
              ? false
              : yield* session.value
                  .releaseTurn({
                    providerThread,
                    providerTurnId: input.providerTurnId,
                    ...(withText ? { text: message.text } : {}),
                  })
                  .pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("orchestration-v2.user-shell-release-turn-failed", {
                        threadId: input.threadId,
                        providerTurnId: input.providerTurnId,
                        cause,
                      }).pipe(Effect.as(false)),
                    ),
                  );
          // Or the hold gave out first (its timeout, a recovered process): steer the input then.
          if (message !== undefined && (!released || !withText)) {
            yield* session.value.steerTurn({
              threadId: input.threadId,
              runId: input.runId,
              providerThread,
              providerTurnId: input.providerTurnId,
              message,
            });
          }
          return true;
        },
        (effect, input) =>
          effect.pipe(
            Effect.catch((cause) =>
              Effect.logWarning("orchestration-v2.user-shell-release-failed", {
                threadId: input.threadId,
                providerTurnId: input.providerTurnId,
                cause,
              }).pipe(Effect.as(input.messageIds.length === 0)),
            ),
          ),
      ),
      steer: Effect.fn("ProviderTurnControlService.steer")(
        function* (input) {
          const context = yield* projections.getProviderControlContext(input.threadId, input);
          const ownership = context.message?.delegatedCompletion;
          if (ownership !== undefined) {
            const projection = yield* projections.getThreadRecords(input.threadId, ["runs"], {
              runIds: [ownership.parentRunId],
            });
            const cohort = projection.runs.find(
              (run) => run.id === ownership.parentRunId,
            )?.delegatedCompletion;
            if (
              cohort?.disposition !== "open" ||
              cohort.delivery?.messageId !== input.messageId ||
              cohort.delivery.generation !== ownership.generation ||
              cohort.delivery.taskIds.length === 0
            )
              return;
          }
          const loaded = yield* load({ ...input, operation: "steer" });
          if (Option.isNone(loaded.session)) return;
          const { message, run } = loaded.context;
          if (message === undefined || run === undefined) {
            return yield* new ProviderTurnControlError({
              threadId: input.threadId,
              operation: "steer",
              providerTurnId: input.providerTurnId,
              cause: "The persisted steering message or target run is missing.",
            });
          }
          // A steered `! cmd` steers with its result once it finished.
          const commandItem =
            message.shellCommand === true
              ? yield* projections.getTurnItem({
                  threadId: input.threadId,
                  itemId: userShellCommandItemId(message.id),
                })
              : null;
          const shellPrompt =
            message.shellCommand === true
              ? composeUserShellPrompt({
                  driver: loaded.providerThread.driver,
                  entries: [{ ...message, messageId: message.id }],
                  commandItem: () => commandItem ?? undefined,
                  attachmentsDir: serverConfig.attachmentsDir,
                })
              : undefined;
          yield* loaded.session.value
            .steerTurn({
              threadId: input.threadId,
              runId: run.id,
              providerThread: loaded.providerThread,
              providerTurnId: loaded.providerTurn.id,
              message: {
                messageId: message.id,
                text:
                  shellPrompt?.text ??
                  projectComposerContextForProvider({
                    text: message.text,
                    records: message.context?.records ?? [],
                  }),
                attachments: shellPrompt?.attachments ?? message.attachments,
                createdBy: message.createdBy,
                creationSource: message.creationSource,
                ...(message.scheduledTaskId === undefined
                  ? {}
                  : { scheduledTaskId: message.scheduledTaskId }),
                ...(message.senderThreadId === undefined
                  ? {}
                  : { senderThreadId: message.senderThreadId }),
              },
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  const current = yield* projections.getProviderControlContext(
                    input.threadId,
                    input,
                  );
                  return yield* new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "steer",
                    providerTurnId: input.providerTurnId,
                    turnCompleted: current.providerTurn?.status === "completed",
                    cause,
                  });
                }),
              ),
            );
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnControlError(cause)
                ? cause
                : new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "steer",
                    providerTurnId: input.providerTurnId,
                    cause,
                  }),
            ),
          ),
      ),
    });
  }),
);
