import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type TurnItemId,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { threadShellFromProjection } from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import {
  SHELL_COMMAND_OUTPUT_FILE_NAME,
  SHELL_COMMAND_PARTIAL_OUTPUT_FILE_NAME,
  userShellCommandItemId,
} from "@t3tools/shared/shellCommand";
import { composeUserShellPrompt, userShellDispatchRejection } from "./UserShellCommands.ts";
import { projectTurnItemForWire } from "./WireProjection.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const threadId = ThreadId.make("thread:user-shell");

/** The provider asked to hold a turn; the test answers with how the pause went. */
interface PauseRequest {
  readonly providerTurnId: ProviderTurnId;
  readonly outcome: Deferred.Deferred<ProviderAdapter.ProviderAdapterV2PauseOutcome>;
}

interface HarnessOptions {
  readonly pause?: boolean;
  /** The provider refuses to continue a paused turn or take a steer, as when its turn is gone. */
  readonly failDelivery?: boolean;
}

const harness = Effect.fn("UserShellCommandsTest.harness")(function* (
  name: string,
  options: HarnessOptions = {},
) {
  const cwd = yield* checkpointWorkspace(`user-shell-${name}`);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
  const steered: Array<string> = [];
  const interrupts: Array<ProviderTurnId> = [];
  const shellStarts: Array<TurnItemId> = [];
  const shellStops: Array<TurnItemId> = [];
  /** Interrupts and command starts, in the order they happened. */
  const timeline: Array<string> = [];
  const pauses = yield* Queue.unbounded<PauseRequest>();
  const runningTurns = new Map<
    ProviderTurnId,
    { readonly providerTurn: OrchestrationV2ProviderTurn; readonly runOrdinal: number }
  >();
  /** The text each release continued the paused turn with; null for none. */
  const released: Array<string | null> = [];
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: { ...CodexProviderCapabilitiesV2.turns, supportsActiveSteering: true },
  };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              started.push(turn);
              const providerTurn: OrchestrationV2ProviderTurn = {
                id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: {
                  driver,
                  nativeId: `native:${turn.attemptId}`,
                  strength: "strong",
                },
                ordinal: turn.providerTurnOrdinal,
                status: "running",
                startedAt: now,
                completedAt: null,
              };
              runningTurns.set(providerTurn.id, { providerTurn, runOrdinal: turn.runOrdinal });
              yield* Queue.offer(events, { type: "provider_turn.updated", driver, providerTurn });
            }),
          steerTurn: (turn) =>
            options.failDelivery === true
              ? Effect.fail(
                  new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId: turn.providerTurnId,
                  }),
                )
              : Effect.sync(() => void steered.push(turn.message.text)),
          ...(options.pause === true
            ? {
                pauseTurn: (turn: ProviderAdapter.ProviderAdapterV2PauseInput) =>
                  Effect.gen(function* () {
                    const outcome =
                      yield* Deferred.make<ProviderAdapter.ProviderAdapterV2PauseOutcome>();
                    yield* Queue.offer(pauses, { providerTurnId: turn.providerTurnId, outcome });
                    return yield* Deferred.await(outcome);
                  }),
                releaseTurn: (turn: ProviderAdapter.ProviderAdapterV2ReleaseInput) =>
                  options.failDelivery === true
                    ? Effect.fail(
                        new ProviderAdapter.ProviderAdapterSteerRunError({
                          driver,
                          providerThreadId: turn.providerThread.id,
                          providerTurnId: turn.providerTurnId,
                        }),
                      )
                    : Effect.sync(() => {
                        released.push(turn.text ?? null);
                        return true;
                      }),
              }
            : {}),
          // Ends the turn as interrupted, as a provider reports it.
          interruptTurn: (turn) =>
            Effect.gen(function* () {
              interrupts.push(turn.providerTurnId);
              timeline.push("interrupt");
              const running = runningTurns.get(turn.providerTurnId);
              if (running === undefined) return;
              runningTurns.delete(turn.providerTurnId);
              const completedAt = yield* DateTime.now;
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: { ...running.providerTurn, status: "interrupted", completedAt },
              });
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: running.providerTurn.providerThreadId,
                providerTurnId: running.providerTurn.id,
                runOrdinal: running.runOrdinal,
                status: "interrupted",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name: `user-shell-${name}` },
    ProviderAdapterRegistry.layerSingle(adapter),
    {
      runEffectWorker: false,
      userShellCommands: {
        start: ({ turnItemId }) =>
          Effect.sync(() => {
            shellStarts.push(turnItemId);
            timeline.push(`start:${String(turnItemId)}`);
          }),
        stop: ({ turnItemIds }) => Effect.sync(() => void shellStops.push(...turnItemIds)),
        stopThread: () => Effect.void,
      },
    },
  );
  return {
    cwd,
    events,
    started,
    steered,
    interrupts,
    shellStarts,
    shellStops,
    pauses,
    released,
    timeline,
    layer,
  };
});

type Harness = Effect.Success<ReturnType<typeof harness>>;

const scenario = <E>(
  name: string,
  body: (
    input: Harness,
  ) => Effect.Effect<
    void,
    E,
    Orchestrator.OrchestratorV2 | EffectWorker.OrchestrationEffectWorkerV2 | EventSink.EventSinkV2
  >,
  options: HarnessOptions = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const input = yield* harness(name, options);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:user-shell"),
          title: "Shell commands",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: input.cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* body(input);
      }).pipe(Effect.provide(input.layer));
    }),
  );

const send = (
  id: string,
  text: string,
  options: {
    readonly shellCommand?: boolean;
    /** `[id, command]` pairs sent with it as one group, as Run all does. */
    readonly following?: ReadonlyArray<readonly [string, string]>;
    readonly mode?: "start_immediately" | "queue_after_active";
    readonly deliveryIntent?: "auto" | "steer" | "restart";
    readonly model?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${id}`),
      threadId,
      messageId: MessageId.make(`message:${id}`),
      text,
      ...(options.shellCommand === true ? { shellCommand: true } : {}),
      ...(options.following === undefined
        ? {}
        : {
            followingShellCommands: options.following.map(([nextId, command]) => ({
              messageId: MessageId.make(`message:${nextId}`),
              text: command,
            })),
          }),
      attachments: [],
      dispatchMode: { type: options.mode ?? "start_immediately" },
      ...(options.deliveryIntent === undefined ? {} : { deliveryIntent: options.deliveryIntent }),
      ...(options.model === undefined
        ? {}
        : { modelSelection: { ...modelSelection, model: options.model } }),
      createdBy: "user",
      creationSource: "web",
    });
  });

const itemFor = (id: string) => userShellCommandItemId(MessageId.make(`message:${id}`));

const finish = (id: string, exitCode: number, output: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "user-shell-command.finish",
      commandId: CommandId.make(`finish:${id}`),
      threadId,
      turnItemId: itemFor(id),
      exitCode,
      stopped: false,
      output,
      startedAt: now,
      completedAt: now,
    });
  });

const stopCommand = (id: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "user-shell-command.stop",
      commandId: CommandId.make(`stop:${id}`),
      threadId,
      turnItemId: itemFor(id),
    });
  });

const drain = EffectWorker.OrchestrationEffectWorkerV2.use((worker) => worker.drain());

const projection = Orchestrator.OrchestratorV2.use((orchestrator) =>
  orchestrator.getThreadProjection(threadId),
);

const runOf = (runs: ReadonlyArray<OrchestrationV2Run>, id: string) =>
  runs.find((run) => run.userMessageId === MessageId.make(`message:${id}`));

const commandItem = (items: ReadonlyArray<OrchestrationV2TurnItem>, id: string) =>
  items.find((item) => item.id === itemFor(id));

/** The transcript as clients and history read it: a user message as `id`, a result as `id:result`. */
const transcript = (current: {
  readonly visibleTurnItems: ReadonlyArray<{ readonly item: OrchestrationV2TurnItem }>;
}) =>
  current.visibleTurnItems.flatMap(({ item }) =>
    item.type === "user_message"
      ? [String(item.messageId).replace(/^message:/u, "")]
      : item.type === "command_execution" && item.userShellMessageId !== undefined
        ? [`${String(item.userShellMessageId).replace(/^message:/u, "")}:result`]
        : [],
  );

/** Ends the agent turn that is running for `runId`, as its provider reports it. */
const endTurn = (input: Harness, runId: RunId, status: "completed" | "interrupted") =>
  Effect.gen(function* () {
    const current = yield* projection;
    const run = current.runs.find((candidate) => candidate.id === runId)!;
    const turn = current.providerTurns.find(
      (candidate) => candidate.runAttemptId === run.activeAttemptId,
    )!;
    yield* Queue.offer(input.events, {
      type: "provider_turn.updated",
      driver,
      providerTurn: { ...turn, status, completedAt: yield* DateTime.now },
    });
    yield* Queue.offer(input.events, {
      type: "turn.terminal",
      driver,
      providerThreadId: turn.providerThreadId,
      providerTurnId: turn.id,
      runOrdinal: run.ordinal,
      status,
      failure: null,
      threadDisposition: "reusable",
    });
    yield* Orchestrator.OrchestratorV2.use((orchestrator) =>
      orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === runId &&
            (event.payload.status === "waiting" ||
              event.payload.status === "completed" ||
              event.payload.status === "interrupted"),
        ),
        Stream.take(1),
        Stream.runDrain,
      ),
    );
    yield* drain;
    yield* Orchestrator.OrchestratorV2.use((orchestrator) => orchestrator.resumeQueuedRuns);
    yield* drain;
  });

const completeTurn = (input: Harness, runId: RunId) => endTurn(input, runId, "completed");

/** Waits until the provider reports the turn of `runId` running. */
const providerTurnRunning = (runId: RunId) =>
  Effect.gen(function* () {
    const current = yield* projection;
    const attemptId = current.runs.find((run) => run.id === runId)!.activeAttemptId;
    yield* EventSink.EventSinkV2.use((sink) =>
      sink.stream({ threadId, afterSequence: 0 }).pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "provider-turn.updated" &&
            event.payload.runAttemptId === attemptId &&
            event.payload.status === "running",
        ),
        Stream.take(1),
        Stream.runDrain,
      ),
    );
  });

/** Runs `trigger`, then waits for the first event after it that matches. */
const afterEvent = <A, E, R>(
  trigger: Effect.Effect<A, E, R>,
  matches: (event: OrchestrationV2DomainEvent) => boolean,
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const after = yield* sink.latestSequence({ threadId });
    const result = yield* trigger;
    yield* sink.stream({ threadId, afterSequence: after }).pipe(
      Stream.filter((stored) => matches(stored.event)),
      Stream.take(1),
      Stream.runDrain,
    );
    return result;
  });

/** Answers a pause the provider was asked for and waits for the orchestrator to take it. */
const answerPause = (
  request: PauseRequest,
  outcome: ProviderAdapter.ProviderAdapterV2PauseOutcome,
) =>
  Effect.gen(function* () {
    yield* afterEvent(Deferred.succeed(request.outcome, outcome), (event) =>
      outcome === "paused"
        ? event.type === "run.updated" && event.payload.userShellHold?.status === "paused"
        : event.type === "run.updated" && event.payload.userShellHold?.status === "interrupting",
    );
    yield* drain;
  });

/** The steers waiting at the front of the queue, in queue order. */
const queuedSteers = (current: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">) =>
  current.runs
    .filter(
      (run) =>
        run.status === "queued" &&
        current.messages.some(
          (message) => message.id === run.userMessageId && message.shellSteer === true,
        ),
    )
    .toSorted((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0))
    .map((run) => String(run.userMessageId).replace(/^message:/u, ""));

/** Starts a plain message's agent turn and waits until the provider reports it running. */
const startAgentTurn = (input: Harness, id: string) =>
  Effect.gen(function* () {
    yield* send(id, `do ${id}`);
    yield* drain;
    yield* Orchestrator.OrchestratorV2.use((orchestrator) =>
      orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        ),
        Stream.take(1),
        Stream.runDrain,
      ),
    );
    return runOf((yield* projection).runs, id)!.id;
  });

describe("userShellDispatchRejection", () => {
  const base: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> = {
    type: "message.dispatch",
    commandId: CommandId.make("command"),
    threadId,
    messageId: MessageId.make("message"),
    text: "ls",
    shellCommand: true,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  };

  it("accepts a person's send from web and mobile only", () => {
    assert.isNull(userShellDispatchRejection(base));
    assert.isNull(userShellDispatchRejection({ ...base, creationSource: "mobile" }));
    assert.isNotNull(userShellDispatchRejection({ ...base, creationSource: "mcp" }));
    assert.isNotNull(
      userShellDispatchRejection({ ...base, createdBy: "agent", creationSource: "server" }),
    );
    assert.isNotNull(
      userShellDispatchRejection({ ...base, createdBy: "agent", creationSource: "provider" }),
    );
  });

  it("refuses scheduled, automatic, empty, and attached sends", () => {
    assert.isNotNull(userShellDispatchRejection({ ...base, scheduledTaskId: "task" as never }));
    assert.isNotNull(
      userShellDispatchRejection({ ...base, restartContinuationOfRunId: RunId.make("run") }),
    );
    assert.isNotNull(userShellDispatchRejection({ ...base, text: "   " }));
    assert.isNotNull(userShellDispatchRejection({ ...base, text: " !  " }));
    assert.isNotNull(
      userShellDispatchRejection({
        ...base,
        attachments: [
          { type: "file", id: "file", name: "a.txt", mimeType: "text/plain", sizeBytes: 1 },
        ],
      }),
    );
    assert.isNull(userShellDispatchRejection({ ...base, shellCommand: false, text: "" }));
  });
});

describe("user shell commands", () => {
  it.effect("refuses a command an agent or scheduled task sends", () =>
    scenario("rejects", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const attempt = (createdBy: "user" | "agent", creationSource: "mcp" | "server") =>
          Effect.exit(
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`agent:${createdBy}:${creationSource}`),
              threadId,
              messageId: MessageId.make(`message:agent:${createdBy}:${creationSource}`),
              text: "rm -rf build",
              shellCommand: true,
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy,
              creationSource,
            }),
          );
        assert.isTrue(Exit.isFailure(yield* attempt("agent", "mcp")));
        assert.isTrue(Exit.isFailure(yield* attempt("user", "mcp")));
        assert.isTrue(Exit.isFailure(yield* attempt("agent", "server")));
        assert.equal((yield* projection).runs.length, 0);
      }),
    ),
  );

  it.effect("runs a command before the provider turn and sends its result", (ctx) =>
    scenario(ctx.task.name.slice(0, 20), (input) =>
      Effect.gen(function* () {
        yield* send("ls", "! ls -la", { shellCommand: true });
        let current = yield* projection;
        const run = runOf(current.runs, "ls")!;
        assert.equal(run.status, "starting");
        // Stored with its `! ` so clients without shell commands read it as one; the item runs
        // the bare command.
        assert.equal(
          current.messages.find((message) => message.id === MessageId.make("message:ls"))?.text,
          "! ls -la",
        );
        // Until its result reaches the agent the command is live state, not conversation.
        assert.isFalse(
          current.turnItems.some(
            (candidate) =>
              candidate.type === "user_message" &&
              candidate.messageId === MessageId.make("message:ls"),
          ),
        );
        assert.deepEqual(transcript(current), []);
        const item = commandItem(current.turnItems, "ls");
        assert.equal(item?.type === "command_execution" ? item.input : undefined, "ls -la");
        assert.equal(item?.status, "running");
        assert.equal(
          item?.type === "command_execution" ? item.userShellMessageId : undefined,
          MessageId.make("message:ls"),
        );
        assert.isFalse(item !== undefined && "bypassedModes" in item);
        assert.isTrue(
          current.messages.some(
            (message) =>
              message.id === MessageId.make("message:ls") && message.shellCommand === true,
          ),
        );
        yield* drain;
        assert.deepEqual(input.shellStarts, [itemFor("ls")]);
        assert.equal(input.started.length, 0);
        // Clients read only the shell: it reports work while the command runs.
        const shell = yield* Orchestrator.OrchestratorV2.use((orchestrator) =>
          orchestrator.getThreadShell(threadId),
        );
        assert.equal(shell?.activityRunStatus, "running");
        assert.equal(threadShellFromProjection(current).activityRunStatus, "running");

        yield* finish("ls", 0, "a.txt\n");
        yield* drain;
        current = yield* projection;
        assert.equal(commandItem(current.turnItems, "ls")?.status, "completed");
        // Delivered with the turn start: the message and its result join the transcript together.
        assert.deepEqual(transcript(current), ["ls", "ls:result"]);
        const messageItem = current.turnItems.find(
          (candidate) =>
            candidate.type === "user_message" &&
            candidate.messageId === MessageId.make("message:ls"),
        );
        assert.equal(
          messageItem?.type === "user_message" ? messageItem.text : undefined,
          "! ls -la",
        );
        assert.equal(input.started.length, 1);
        assert.include(
          input.started[0]!.message.text,
          "<user_shell_command>\n<command>\nls -la\n</command>",
        );
        assert.include(input.started[0]!.message.text, "Exit code: 0");
        assert.include(input.started[0]!.message.text, "a.txt");
      }),
    ),
  );

  it.effect("marks a thread once it gets its first command", () =>
    scenario("thread-flag", () =>
      Effect.gen(function* () {
        yield* send("work", "do work");
        assert.isUndefined((yield* projection).thread.hasShellCommands);
        yield* send("status", "git status", { shellCommand: true, mode: "queue_after_active" });
        assert.isTrue((yield* projection).thread.hasShellCommands);
      }),
    ),
  );

  it.effect("stores every accepted form of a command as `! <command>`", () =>
    scenario("stored-text", () =>
      Effect.gen(function* () {
        yield* send("bare", "  git status ", { shellCommand: true, mode: "queue_after_active" });
        yield* send("tight", "!ls", { shellCommand: true, mode: "queue_after_active" });
        // A command that starts with `!` (shell negation) keeps it after the message's own `!`.
        yield* send("negated", "! ! grep -q x f", {
          shellCommand: true,
          mode: "queue_after_active",
        });
        yield* send("prose", "! not a command", { mode: "queue_after_active" });
        const current = yield* projection;
        const textOf = (id: string) =>
          current.messages.find((message) => message.id === MessageId.make(`message:${id}`))?.text;
        assert.equal(textOf("bare"), "! git status");
        assert.equal(textOf("tight"), "! ls");
        assert.equal(textOf("negated"), "! ! grep -q x f");
        assert.equal(textOf("prose"), "! not a command");
      }),
    ),
  );

  it.effect("a command records the Supervised and Plan modes it ran outside of", () =>
    scenario("bypassed-modes", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const setModes = (
          id: string,
          runtimeMode: "approval-required" | "full-access",
          interactionMode: "plan" | "default",
        ) =>
          Effect.gen(function* () {
            yield* orchestrator.dispatch({
              type: "thread.runtime-mode.set",
              commandId: CommandId.make(`runtime-mode:${id}`),
              threadId,
              runtimeMode,
            });
            yield* orchestrator.dispatch({
              type: "thread.interaction-mode.set",
              commandId: CommandId.make(`interaction-mode:${id}`),
              threadId,
              interactionMode,
            });
          });
        yield* setModes("restricted", "approval-required", "plan");
        yield* send("ls", "ls", { shellCommand: true });
        const sent = commandItem((yield* projection).turnItems, "ls")!;
        const wire = projectTurnItemForWire(sent);
        assert.deepEqual(wire.type === "command_execution" ? wire.bypassedModes : undefined, [
          "supervised",
          "plan",
        ]);

        // Leaving the modes later does not relabel a command already sent.
        yield* setModes("open", "full-access", "default");
        yield* finish("ls", 0, "");
        const finished = commandItem((yield* projection).turnItems, "ls");
        assert.deepEqual(
          finished?.type === "command_execution" ? finished.bypassedModes : undefined,
          ["supervised", "plan"],
        );
      }),
    ),
  );

  it.effect("a new thread's first command waits for its workspace", () =>
    scenario("defer", (input) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("send:first"),
          threadId,
          messageId: MessageId.make("message:first"),
          text: "pnpm install",
          shellCommand: true,
          attachments: [],
          titleSeed: "pnpm install",
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        let current = yield* projection;
        const run = runOf(current.runs, "first")!;
        assert.equal(run.status, "preparing");
        assert.isUndefined(commandItem(current.turnItems, "first"));
        yield* orchestrator.dispatch({
          type: "prepared-run.release",
          commandId: CommandId.make("release"),
          threadId,
          runId: run.id,
        });
        yield* drain;
        current = yield* projection;
        assert.equal(runOf(current.runs, "first")?.status, "starting");
        assert.equal(commandItem(current.turnItems, "first")?.status, "running");
        assert.deepEqual(input.shellStarts, [itemFor("first")]);
        assert.equal(input.started.length, 0);
      }),
    ),
  );

  it.effect("folds queued commands and the next message into one run", () =>
    scenario("absorb", (input) =>
      Effect.gen(function* () {
        const active = yield* startAgentTurn(input, "first");
        yield* send("one", "echo one", { shellCommand: true, mode: "queue_after_active" });
        yield* send("two", "echo two", { shellCommand: true, mode: "queue_after_active" });
        yield* send("ask", "what do you see?", { mode: "queue_after_active" });
        yield* send("later", "and then this", { mode: "queue_after_active" });
        yield* completeTurn(input, active);

        let current = yield* projection;
        const batch = runOf(current.runs, "one")!;
        assert.equal(batch.status, "starting");
        assert.equal(commandItem(current.turnItems, "one")?.status, "running");

        yield* finish("one", 0, "one\n");
        current = yield* projection;
        assert.deepEqual(transcript(current), ["first"]);
        assert.equal(runOf(current.runs, "two")?.status, "cancelled");
        assert.equal(commandItem(current.turnItems, "two")?.runId, batch.id);
        assert.equal(commandItem(current.turnItems, "two")?.status, "running");

        yield* finish("two", 0, "two\n");
        yield* drain;
        current = yield* projection;
        assert.equal(runOf(current.runs, "ask")?.status, "cancelled");
        assert.equal(runOf(current.runs, "later")?.status, "queued");
        assert.notEqual(runOf(current.runs, "later")?.queueHeld, true);
        const prompt = input.started.at(-1)!;
        assert.equal(prompt.runId, batch.id);
        const text = prompt.message.text;
        assert.isTrue(text.indexOf("echo one") < text.indexOf("echo two"));
        assert.isTrue(text.trimEnd().endsWith("what do you see?"));
        assert.notInclude(text, "and then this");
        // The batch joins the transcript as it was delivered, after the turn it waited behind.
        assert.deepEqual(transcript(current), [
          "first",
          "one",
          "one:result",
          "two",
          "two:result",
          "ask",
        ]);
      }),
    ),
  );

  it.effect("sends a failed command with the next message and skips the commands waiting", () =>
    scenario("failure", (input) =>
      Effect.gen(function* () {
        yield* send("build", "make build", { shellCommand: true });
        yield* send("why", "why did it fail?", { mode: "queue_after_active" });
        yield* send("again", "make build", { shellCommand: true, mode: "queue_after_active" });
        yield* finish("build", 2, "error: missing target\n");
        yield* drain;
        const current = yield* projection;
        assert.equal(commandItem(current.turnItems, "build")?.status, "failed");
        assert.equal(runOf(current.runs, "why")?.status, "cancelled");
        assert.equal(runOf(current.runs, "again")?.status, "cancelled");
        const skipped = commandItem(current.turnItems, "again");
        assert.isTrue(skipped?.type === "command_execution" && skipped.userShellSkipped === true);
        assert.deepEqual(input.shellStarts, [itemFor("build")]);
        const text = input.started.at(-1)!.message.text;
        assert.include(text, "Exit code: 2");
        assert.include(text, "error: missing target");
        assert.include(text, "did not run because an earlier one failed: ! make build");
        assert.isTrue(text.trimEnd().endsWith("why did it fail?"));
      }),
    ),
  );

  it.effect("a failed command of a group skips the rest, each shown and told to the agent", () =>
    scenario("group-failure", (input) =>
      Effect.gen(function* () {
        yield* send("one", "echo one", {
          shellCommand: true,
          following: [
            ["two", "false"],
            ["three", "echo three"],
          ],
        });
        // All of them wait in order before the first can finish.
        let current = yield* projection;
        assert.equal(runOf(current.runs, "two")?.status, "queued");
        assert.equal(runOf(current.runs, "three")?.status, "queued");
        yield* finish("one", 0, "one\n");
        yield* finish("two", 1, "");
        yield* drain;
        current = yield* projection;
        assert.equal(runOf(current.runs, "three")?.status, "cancelled");
        const skipped = commandItem(current.turnItems, "three");
        assert.equal(skipped?.status, "failed");
        assert.isTrue(skipped?.type === "command_execution" && skipped.userShellSkipped === true);
        assert.deepEqual(input.shellStarts, [itemFor("one"), itemFor("two")]);
        const text = input.started.at(-1)!.message.text;
        assert.include(text, "echo one");
        assert.include(text, "Exit code: 1");
        assert.include(text, "did not run because an earlier one failed: ! echo three");
        // Each shows in the thread as its own command, in order.
        assert.deepEqual(transcript(current), [
          "one",
          "one:result",
          "two",
          "two:result",
          "three",
          "three:result",
        ]);
      }),
    ),
  );

  it.effect("thread Stop ends the rest of a group, so a later send doesn't run them", () =>
    scenario("group-thread-stop", (input) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* send("slow", "sleep 100", { shellCommand: true, following: [["next", "git push"]] });
        yield* drain;
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-thread"),
          threadId,
        });
        yield* drain;
        yield* send("after", "carry on");
        yield* drain;
        const current = yield* projection;
        assert.equal(runOf(current.runs, "next")?.status, "cancelled");
        assert.isUndefined(commandItem(current.turnItems, "next"));
        assert.notInclude(input.started.at(-1)?.message.text ?? "", "git push");
      }),
    ),
  );

  it.effect("stopping a command sends only the results before it", () =>
    scenario("stop-after-results", (input) =>
      Effect.gen(function* () {
        yield* send("one", "echo one", { shellCommand: true });
        yield* send("two", "sleep 100", { shellCommand: true, mode: "queue_after_active" });
        yield* send("next", "anything else?", { mode: "queue_after_active" });
        yield* finish("one", 0, "one\n");
        yield* stopCommand("two");
        yield* drain;
        const current = yield* projection;
        assert.equal(commandItem(current.turnItems, "two")?.status, "interrupted");
        assert.deepEqual(input.shellStops, [itemFor("two")]);
        assert.equal(runOf(current.runs, "next")?.status, "queued");
        assert.notEqual(runOf(current.runs, "next")?.queueHeld, true);
        const text = input.started.at(-1)!.message.text;
        assert.include(text, "echo one");
        assert.notInclude(text, "sleep 100");
        assert.notInclude(text, "anything else?");
        // The stopped command never enters the transcript; the one before it is delivered.
        assert.deepEqual(transcript(current), ["one", "one:result"]);
      }),
    ),
  );

  it.effect(
    "stopping the first command ends its run without an agent turn; the queue goes on",
    () =>
      scenario("stop-first", (input) =>
        Effect.gen(function* () {
          yield* send("slow", "sleep 100", { shellCommand: true });
          yield* send("next", "anything else?", { mode: "queue_after_active" });
          yield* drain;
          yield* stopCommand("slow");
          yield* drain;
          const current = yield* projection;
          assert.equal(runOf(current.runs, "slow")?.status, "interrupted");
          assert.deepEqual(
            input.started.map((started) => started.message.text),
            ["anything else?"],
          );
          // A late result from the killed process records its output but changes nothing else.
          yield* finish("slow", 143, "partial\n");
          const after = yield* projection;
          assert.equal(commandItem(after.turnItems, "slow")?.status, "interrupted");
          assert.equal(input.started.length, 1);
          assert.deepEqual(transcript(after), ["next"]);
        }),
      ),
  );

  it.effect("thread Stop sends nothing, not even finished commands", () =>
    scenario("thread-stop", (input) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* send("one", "echo SECRET-ONE", { shellCommand: true });
        yield* send("two", "sleep 100", { shellCommand: true, mode: "queue_after_active" });
        yield* finish("one", 0, "SECRET-ONE\n");
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-thread"),
          threadId,
        });
        yield* drain;
        let current = yield* projection;
        const run = runOf(current.runs, "one")!;
        assert.equal(run.status, "interrupted");
        assert.equal(commandItem(current.turnItems, "two")?.status, "interrupted");
        assert.deepEqual(input.shellStops, [itemFor("two")]);
        assert.equal(input.started.length, 0);
        assert.isNull(threadShellFromProjection(current).activityRunStatus);
        // Finished but never delivered: out of the transcript, like the stopped one.
        assert.notEqual(
          (commandItem(current.turnItems, "one") as { userShellDelivered?: boolean })
            .userShellDelivered,
          true,
        );
        assert.deepEqual(transcript(current), []);

        // The next turn's replay of the stopped run leaves the command out.
        yield* send("after", "carry on");
        yield* drain;
        current = yield* projection;
        assert.equal(input.started.length, 1);
        assert.notInclude(input.started[0]!.message.text, "SECRET-ONE");
        assert.include(input.started[0]!.message.text, "carry on");
        assert.deepEqual(transcript(current), ["after"]);
      }),
    ),
  );

  it.effect("Stop of a run that reached no agent leaves no interrupted row", () =>
    scenario("stop-unreached", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* send("slow", "sleep 100", { shellCommand: true });
        yield* drain;
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("interrupt-run"),
          threadId,
          runId: runOf((yield* projection).runs, "slow")!.id,
        });
        yield* drain;
        const current = yield* projection;
        assert.equal(runOf(current.runs, "slow")?.status, "interrupted");
        assert.deepEqual(
          current.visibleTurnItems.flatMap(({ item }) =>
            item.type === "run_interrupt_request" || item.type === "run_interrupt_result"
              ? [item.type]
              : [],
          ),
          [],
        );
      }),
    ),
  );

  it.effect("archiving ends the thread's commands and starts nothing after them", () =>
    scenario("archive", (input) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* send("one", "sleep 100", { shellCommand: true });
        yield* drain;
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive"),
          threadId,
        });
        yield* drain;
        let current = yield* projection;
        assert.equal(commandItem(current.turnItems, "one")?.status, "interrupted");
        assert.equal(runOf(current.runs, "one")?.status, "interrupted");
        assert.deepEqual(input.shellStops, [itemFor("one")]);
        // The killed process still reports; its result starts no agent turn.
        yield* finish("one", 143, "partial\n");
        yield* drain;
        current = yield* projection;
        assert.equal(commandItem(current.turnItems, "one")?.status, "interrupted");
        assert.equal(input.started.length, 0);
      }),
    ),
  );

  it.effect("archiving ends steered commands still waiting their turn", () =>
    scenario("archive-steer", (input) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* startAgentTurn(input, "work");
        yield* send("a", "sleep 100", { shellCommand: true, deliveryIntent: "auto" });
        yield* send("b", "echo b", { shellCommand: true, deliveryIntent: "auto" });
        assert.deepEqual(queuedSteers(yield* projection), ["a", "b"]);
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive"),
          threadId,
        });
        yield* drain;
        const current = yield* projection;
        assert.equal(runOf(current.runs, "a")?.status, "cancelled");
        assert.equal(runOf(current.runs, "b")?.status, "cancelled");
        assert.deepEqual(input.shellStarts, []);
        assert.equal(input.steered.length, 0);
      }),
    ),
  );

  it.effect("a finished command folds in only a queued message for the same model", () =>
    scenario("absorb-model", (input) =>
      Effect.gen(function* () {
        const active = yield* startAgentTurn(input, "first");
        yield* send("one", "echo one", { shellCommand: true, mode: "queue_after_active" });
        yield* send("ask", "what do you see?", { mode: "queue_after_active", model: "other" });
        yield* completeTurn(input, active);
        yield* finish("one", 0, "one\n");
        yield* drain;
        const current = yield* projection;
        assert.equal(runOf(current.runs, "ask")?.status, "queued");
        const prompt = input.started.at(-1)!;
        assert.equal(prompt.runId, runOf(current.runs, "one")?.id);
        assert.include(prompt.message.text, "echo one");
        assert.notInclude(prompt.message.text, "what do you see?");
      }),
    ),
  );

  it.effect("thread Stop ends a steered command that outlived its turn, not the turn", () =>
    scenario("stop-late-steer", (input) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const active = yield* startAgentTurn(input, "work");
        yield* send("tests", "npm test", { shellCommand: true, deliveryIntent: "auto" });
        yield* completeTurn(input, active);
        // Still working: the command runs after its turn ended, and it is not agent background work.
        let current = yield* projection;
        assert.equal(threadShellFromProjection(current).activityRunStatus, "running");
        assert.deepEqual(threadShellFromProjection(current).pendingBackgroundTasks, []);
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-thread"),
          threadId,
        });
        yield* drain;
        current = yield* projection;
        assert.equal(commandItem(current.turnItems, "tests")?.status, "interrupted");
        assert.deepEqual(input.shellStops, [itemFor("tests")]);
        assert.deepEqual(input.interrupts, []);
        assert.isNull(threadShellFromProjection(current).activityRunStatus);
      }),
    ),
  );

  it.effect.each(["steer", "restart"] as const)(
    "a command steered with %s interrupts the turn, then runs before the next one",
    (deliveryIntent) =>
      scenario(`interrupt-${deliveryIntent}`, (input) =>
        Effect.gen(function* () {
          const active = yield* startAgentTurn(input, "work");
          yield* send("status", "git status", { shellCommand: true, deliveryIntent });
          let current = yield* projection;
          // It waits at the front of the queue instead of running beside the agent.
          assert.deepEqual(queuedSteers(current), ["status"]);
          assert.isUndefined(commandItem(current.turnItems, "status"));
          assert.equal(
            current.runs.find((run) => run.id === active)?.userShellHold?.status,
            "interrupting",
          );
          assert.deepEqual(input.interrupts, []);
          // The command starts once the interrupted turn ended, as the next run.
          yield* drain;
          assert.deepEqual(input.timeline, ["interrupt", `start:${String(itemFor("status"))}`]);
          current = yield* projection;
          assert.equal(runOf(current.runs, "work")?.status, "interrupted");
          assert.equal(runOf(current.runs, "status")?.status, "starting");
          yield* finish("status", 0, "nothing to commit\n");
          yield* drain;
          assert.deepEqual(input.steered, []);
          assert.equal(input.started.length, 2);
          assert.include(input.started[1]!.message.text, "<command>\ngit status\n</command>");
          assert.include(input.started[1]!.message.text, "nothing to commit");
          current = yield* projection;
          assert.deepEqual(transcript(current), ["work", "status", "status:result"]);
        }),
      ),
  );

  it.effect("after the interrupt, steered commands run first and the steered message follows", () =>
    scenario("interrupt-batch", (input) =>
      Effect.gen(function* () {
        yield* startAgentTurn(input, "work");
        yield* send("later", "queued earlier", { mode: "queue_after_active" });
        yield* send("a", "echo a", { shellCommand: true, deliveryIntent: "auto" });
        yield* send("note", "look at both", { deliveryIntent: "auto" });
        yield* send("b", "echo b", { shellCommand: true, deliveryIntent: "auto" });
        let current = yield* projection;
        assert.deepEqual(queuedSteers(current), ["a", "note", "b"]);
        assert.equal(runOf(current.runs, "later")?.queuePosition, 4);
        yield* drain;
        yield* finish("a", 0, "a\n");
        yield* drain;
        assert.deepEqual(input.shellStarts, [itemFor("a"), itemFor("b")]);
        yield* finish("b", 0, "b\n");
        yield* drain;
        assert.equal(input.started.length, 2);
        const text = input.started[1]!.message.text;
        assert.isTrue(text.indexOf("echo a") < text.indexOf("echo b"));
        assert.isTrue(text.indexOf("echo b") < text.indexOf("look at both"));
        assert.notInclude(text, "queued earlier");
        current = yield* projection;
        assert.equal(runOf(current.runs, "later")?.status, "queued");
        assert.deepEqual(transcript(current), ["work", "a", "a:result", "b", "b:result", "note"]);
      }),
    ),
  );

  it.effect("a steered command pauses the agent and continues the same turn with its result", () =>
    scenario(
      "pause",
      (input) =>
        Effect.gen(function* () {
          const active = yield* startAgentTurn(input, "work");
          yield* send("status", "git status", { shellCommand: true, deliveryIntent: "auto" });
          yield* drain;
          const request = yield* Queue.take(input.pauses);
          // Nothing runs until the agent waits at its steering window.
          assert.deepEqual(input.shellStarts, []);
          assert.deepEqual(queuedSteers(yield* projection), ["status"]);
          yield* answerPause(request, "paused");
          let current = yield* projection;
          assert.deepEqual(input.shellStarts, [itemFor("status")]);
          assert.equal(commandItem(current.turnItems, "status")?.runId, active);
          assert.deepEqual(queuedSteers(current), []);

          yield* finish("status", 0, "nothing to commit\n");
          yield* drain;
          assert.equal(input.released.length, 1);
          assert.include(input.released[0]!, "<command>\ngit status\n</command>");
          assert.include(input.released[0]!, "nothing to commit");
          assert.deepEqual(input.interrupts, []);
          assert.deepEqual(input.steered, []);
          assert.equal(input.started.length, 1);
          current = yield* projection;
          const run = current.runs.find((candidate) => candidate.id === active)!;
          assert.equal(run.status, "running");
          assert.isUndefined(run.userShellHold);
          assert.deepEqual(transcript(current), ["work", "status", "status:result"]);
          const steer = current.turnItems.find(
            (item) =>
              item.type === "user_message" && item.messageId === MessageId.make("message:status"),
          );
          assert.equal(steer?.type === "user_message" ? steer.inputIntent : undefined, "steer");
        }),
      { pause: true },
    ),
  );

  it.effect("steers sent while the agent waits join one delivery, commands first, in order", () =>
    scenario(
      "pause-batch",
      (input) =>
        Effect.gen(function* () {
          yield* startAgentTurn(input, "work");
          yield* send("a", "echo a", { shellCommand: true, deliveryIntent: "auto" });
          yield* send("p1", "first note", { deliveryIntent: "auto" });
          yield* drain;
          yield* answerPause(yield* Queue.take(input.pauses), "paused");
          yield* send("b", "echo b", { shellCommand: true, deliveryIntent: "steer" });
          yield* send("p2", "second note", { deliveryIntent: "auto" });
          assert.deepEqual(queuedSteers(yield* projection), ["p1", "b", "p2"]);
          // One command at a time, while the agent keeps waiting.
          assert.deepEqual(input.shellStarts, [itemFor("a")]);

          yield* finish("a", 0, "a\n");
          yield* drain;
          assert.deepEqual(input.shellStarts, [itemFor("a"), itemFor("b")]);
          assert.deepEqual(input.released, []);
          yield* finish("b", 0, "b\n");
          yield* drain;
          assert.equal(input.released.length, 1);
          const text = input.released[0]!;
          const order = ["echo a", "echo b", "first note", "second note"].map((part) =>
            text.indexOf(part),
          );
          assert.isTrue(order.every((index, position) => index > (order[position - 1] ?? -1)));
          const current = yield* projection;
          assert.deepEqual(queuedSteers(current), []);
          assert.isFalse(current.runs.some((run) => run.status === "queued"));
          assert.deepEqual(transcript(current), [
            "work",
            "a",
            "a:result",
            "b",
            "b:result",
            "p1",
            "p2",
          ]);
        }),
      { pause: true },
    ),
  );

  it.effect(
    "a failed steered command sends its result and the waiting messages, and skips the rest",
    () =>
      scenario(
        "pause-failure",
        (input) =>
          Effect.gen(function* () {
            yield* startAgentTurn(input, "work");
            yield* send("a", "make build", { shellCommand: true, deliveryIntent: "auto" });
            yield* send("b", "make test", { shellCommand: true, deliveryIntent: "auto" });
            yield* send("why", "why did it fail?", { deliveryIntent: "auto" });
            yield* drain;
            yield* answerPause(yield* Queue.take(input.pauses), "paused");
            yield* finish("a", 2, "error: missing target\n");
            yield* drain;
            assert.deepEqual(input.shellStarts, [itemFor("a")]);
            assert.equal(input.released.length, 1);
            const text = input.released[0]!;
            assert.include(text, "Exit code: 2");
            assert.include(text, "why did it fail?");
            assert.include(text, "did not run because an earlier one failed: ! make test");
            const current = yield* projection;
            assert.equal(runOf(current.runs, "b")?.status, "cancelled");
            assert.deepEqual(transcript(current), [
              "work",
              "a",
              "a:result",
              "b",
              "b:result",
              "why",
            ]);
            assert.equal(runOf(current.runs, "work")?.status, "running");
          }),
        { pause: true },
      ),
  );

  it.effect("a steered result the paused turn cannot take starts the next turn instead", () =>
    scenario(
      "pause-delivery-fails",
      (input) =>
        Effect.gen(function* () {
          const active = yield* startAgentTurn(input, "work");
          yield* send("status", "git status", { shellCommand: true, deliveryIntent: "auto" });
          yield* send("note", "then fix it", { deliveryIntent: "auto" });
          yield* drain;
          yield* answerPause(yield* Queue.take(input.pauses), "paused");
          yield* finish("status", 0, "nothing to commit\n");
          yield* drain;
          assert.deepEqual(input.released, []);
          assert.deepEqual(input.steered, []);
          // Sent again, behind the turn that could not take them; not in the transcript yet.
          assert.equal(input.started.length, 1);
          let current = yield* projection;
          assert.deepEqual(transcript(current), ["work"]);

          yield* completeTurn(input, active);
          // One turn takes the result and the message steered with it, in order.
          assert.equal(input.started.length, 2);
          const text = input.started[1]!.message.text;
          assert.include(text, "<command>\ngit status\n</command>");
          assert.include(text, "nothing to commit");
          assert.isTrue(text.indexOf("nothing to commit") < text.indexOf("then fix it"));
          current = yield* projection;
          const redelivered = current.runs.find((run) => run.id === input.started[1]!.runId)!;
          // They join the transcript in the turn that received them, positioned there too.
          for (const id of [MessageId.make("message:status"), MessageId.make("message:note")]) {
            const item = current.turnItems.find(
              (candidate) => candidate.type === "user_message" && candidate.messageId === id,
            )!;
            assert.equal(item.runId, redelivered.id);
            assert.equal(Math.floor(item.ordinal / 1_000_000), redelivered.ordinal);
          }
          const result = commandItem(current.turnItems, "status")!;
          assert.equal(result.runId, redelivered.id);
          assert.equal(Math.floor(result.ordinal / 1_000_000), redelivered.ordinal);
          assert.isTrue((result as { userShellDelivered?: boolean }).userShellDelivered);
          assert.deepEqual(transcript(current), ["work", "status", "status:result", "note"]);
          assert.isFalse(current.runs.some((run) => run.status === "queued"));
        }),
      { pause: true, failDelivery: true },
    ),
  );

  it.effect("a steered command whose held turn ends on its own still reaches the agent", () =>
    scenario(
      "pause-turn-ends",
      (input) =>
        Effect.gen(function* () {
          const active = yield* startAgentTurn(input, "work");
          yield* send("status", "git status", { shellCommand: true, deliveryIntent: "auto" });
          yield* drain;
          yield* answerPause(yield* Queue.take(input.pauses), "paused");
          yield* send("b", "echo b", { shellCommand: true, deliveryIntent: "steer" });
          yield* send("later", "queued after", { mode: "queue_after_active" });
          // The provider ends the held turn itself while the command runs.
          yield* endTurn(input, active, "interrupted");
          // Nothing starts beside the running command, not even a fresh send.
          yield* send("fresh", "anything new?");
          yield* drain;
          assert.deepEqual(input.shellStarts, [itemFor("status")]);
          assert.equal(input.started.length, 1);

          yield* finish("status", 0, "clean\n");
          yield* drain;
          // Its result goes to the agent as the next turn, ahead of what waited behind it.
          assert.equal(input.started.length, 2);
          const text = input.started[1]!.message.text;
          assert.include(text, "<command>\ngit status\n</command>");
          assert.include(text, "clean");
          const current = yield* projection;
          assert.deepEqual(transcript(current), ["work", "status", "status:result"]);
          assert.deepEqual(input.shellStarts, [itemFor("status")]);
        }),
      { pause: true },
    ),
  );

  it.effect("a pause reported after Stop runs none of the steered commands", () =>
    scenario(
      "pause-after-stop",
      (input) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const active = yield* startAgentTurn(input, "work");
          yield* send("status", "git status", { shellCommand: true, deliveryIntent: "auto" });
          yield* drain;
          const request = yield* Queue.take(input.pauses);
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("stop-thread"),
            threadId,
          });
          assert.isUndefined(runOf((yield* projection).runs, "work")?.userShellHold);
          // The agent reached its steering window before the interrupt got to it.
          const late = yield* Effect.exit(
            orchestrator.dispatch({
              type: "user-shell-command.hold",
              commandId: CommandId.make("late-pause"),
              threadId,
              runId: active,
              providerTurnId: request.providerTurnId,
              outcome: "paused",
            }),
          );
          assert.isTrue(Exit.isFailure(late));
          yield* drain;
          assert.deepEqual(input.shellStarts, []);
          const current = yield* projection;
          assert.equal(runOf(current.runs, "status")?.status, "queued");
          assert.isTrue(runOf(current.runs, "status")?.queueHeld === true);
        }),
      { pause: true },
    ),
  );

  it.effect("a command steered before the turn runs holds it once it does", () =>
    scenario(
      "steer-starting",
      (input) =>
        Effect.gen(function* () {
          yield* send("work", "do work");
          const active = runOf((yield* projection).runs, "work")!.id;
          yield* send("status", "git status", { shellCommand: true, deliveryIntent: "steer" });
          assert.deepEqual(queuedSteers(yield* projection), ["status"]);
          yield* drain;
          yield* providerTurnRunning(active);
          yield* EventSink.EventSinkV2.use((sink) =>
            sink.stream({ threadId, afterSequence: 0 }).pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.payload.id === active &&
                  event.payload.userShellHold?.status === "pausing",
              ),
              Stream.take(1),
              Stream.runDrain,
            ),
          );
          yield* drain;
          yield* answerPause(yield* Queue.take(input.pauses), "paused");
          assert.deepEqual(input.shellStarts, [itemFor("status")]);
          assert.equal(commandItem((yield* projection).turnItems, "status")?.runId, active);
        }),
      { pause: true },
    ),
  );

  it.effect("stopping the steered command lets the waiting agent continue with nothing", () =>
    scenario(
      "pause-stop",
      (input) =>
        Effect.gen(function* () {
          yield* startAgentTurn(input, "work");
          yield* send("slow", "sleep 100", { shellCommand: true, deliveryIntent: "auto" });
          yield* drain;
          yield* answerPause(yield* Queue.take(input.pauses), "paused");
          yield* stopCommand("slow");
          yield* drain;
          assert.deepEqual(input.shellStops, [itemFor("slow")]);
          assert.deepEqual(input.released, [null]);
          const current = yield* projection;
          assert.equal(runOf(current.runs, "work")?.status, "running");
          assert.isUndefined(runOf(current.runs, "work")?.userShellHold);
          assert.deepEqual(transcript(current), ["work"]);
        }),
      { pause: true },
    ),
  );

  it.effect("stopping a steered command after the interrupt ends without a new turn", () =>
    scenario("interrupt-stop", (input) =>
      Effect.gen(function* () {
        yield* startAgentTurn(input, "work");
        yield* send("slow", "sleep 100", { shellCommand: true, deliveryIntent: "auto" });
        yield* drain;
        assert.deepEqual(input.shellStarts, [itemFor("slow")]);
        yield* stopCommand("slow");
        yield* drain;
        const current = yield* projection;
        assert.equal(runOf(current.runs, "slow")?.status, "interrupted");
        assert.equal(input.started.length, 1);
        assert.deepEqual(transcript(current), ["work"]);
      }),
    ),
  );

  it.effect("a provider that cannot pause its agent has the turn interrupted instead", () =>
    scenario(
      "pause-unavailable",
      (input) =>
        Effect.gen(function* () {
          yield* startAgentTurn(input, "work");
          yield* send("status", "git status", { shellCommand: true, deliveryIntent: "auto" });
          yield* drain;
          yield* answerPause(yield* Queue.take(input.pauses), "unsupported");
          assert.deepEqual(input.timeline, ["interrupt", `start:${String(itemFor("status"))}`]);
          yield* finish("status", 0, "clean\n");
          yield* drain;
          assert.deepEqual(input.released, []);
          assert.include(input.started.at(-1)!.message.text, "clean");
        }),
      { pause: true },
    ),
  );

  it.effect("a steered command that outlives the turn starts a new one with its result", () =>
    scenario("steer-late", (input) =>
      Effect.gen(function* () {
        const active = yield* startAgentTurn(input, "work");
        yield* send("tests", "npm test", { shellCommand: true, deliveryIntent: "auto" });
        yield* completeTurn(input, active);
        yield* finish("tests", 1, "1 failing\n");
        yield* drain;
        assert.equal(input.steered.length, 0);
        assert.equal(input.started.length, 2);
        const text = input.started[1]!.message.text;
        assert.include(text, "npm test");
        assert.include(text, "1 failing");
        const current = yield* projection;
        // Delivered as the new turn's start, so the message and its result open that turn.
        const messageItem = current.turnItems.find(
          (item) =>
            item.type === "user_message" && item.messageId === MessageId.make("message:tests"),
        );
        const started = input.started[1]!.runId;
        assert.equal(messageItem?.runId, started);
        assert.equal(commandItem(current.turnItems, "tests")?.runId, started);
        assert.deepEqual(transcript(current), ["work", "tests", "tests:result"]);
      }),
    ),
  );

  it.effect("an edit must keep the shell flag of the queued message", () =>
    scenario("edit", (input) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* startAgentTurn(input, "work");
        yield* send("cmd", "ls", { shellCommand: true, mode: "queue_after_active" });
        yield* send("text", "hello", { mode: "queue_after_active" });
        const current = yield* projection;
        const edit = (id: string, runId: RunId, shellCommand: boolean | undefined) =>
          Effect.exit(
            orchestrator.dispatch({
              type: "queued-run.edit",
              commandId: CommandId.make(`edit:${id}:${String(shellCommand)}`),
              threadId,
              runId,
              text: "ls -la",
              ...(shellCommand === undefined ? {} : { shellCommand }),
            }),
          );
        const commandRun = runOf(current.runs, "cmd")!.id;
        const textRun = runOf(current.runs, "text")!.id;
        assert.isTrue(Exit.isFailure(yield* edit("cmd", commandRun, undefined)));
        assert.isTrue(Exit.isFailure(yield* edit("text", textRun, true)));
        assert.isTrue(Exit.isSuccess(yield* edit("cmd", commandRun, true)));
        assert.isTrue(Exit.isSuccess(yield* edit("text", textRun, undefined)));
        const edited = yield* projection;
        const textOf = (id: string) =>
          edited.messages.find((message) => message.id === MessageId.make(`message:${id}`))?.text;
        assert.equal(textOf("cmd"), "! ls -la");
        assert.equal(textOf("text"), "ls -la");
      }),
    ),
  );
});

describe("composeUserShellPrompt", () => {
  const messageId = MessageId.make("message:big");
  const item = {
    id: userShellCommandItemId(messageId),
    threadId: ThreadId.make("thread:big"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(0),
    type: "command_execution",
    input: "cat big.log",
    output: "last line\n",
    exitCode: 0,
    userShellMessageId: messageId,
  } satisfies OrchestrationV2TurnItem;
  const prompt = (name: string) =>
    composeUserShellPrompt({
      driver: "codex",
      entries: [
        {
          messageId,
          shellCommand: true,
          text: "! cat big.log",
          attachments: [
            { type: "file", id: "thread-big-1", name, mimeType: "text/plain", sizeBytes: 2048 },
          ],
        },
      ],
      commandItem: () => item,
      attachmentsDir: "/attachments",
    }).text;

  it("tells the agent when the saved output is only the start of it", () => {
    assert.include(prompt(SHELL_COMMAND_OUTPUT_FILE_NAME), "[Output truncated. Full output: ");
    assert.include(
      prompt(SHELL_COMMAND_PARTIAL_OUTPUT_FILE_NAME),
      "[Output truncated. Only its first 2.0KB were saved: ",
    );
  });
});
