import * as DocumentText from "../provider/DocumentText.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  EventId,
  GuestMessageId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2TurnItem,
  type UserInputAttachments,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  createAttachmentId,
  createPendingAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorDispatchError,
} from "./Orchestrator.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { dispatchCommand, launchThread } from "./ThreadMessageIntake.ts";
import { userShellCommandItemId } from "@t3tools/shared/shellCommand";

const layerIntakeTest = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-question-intake-",
}).pipe(
  Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  Layer.provideMerge(ServerSettings.layerTest()),
);

const layerFailingDispatchHandler =
  (captured: OrchestrationV2ServerCommand[]) => (command: OrchestrationV2ServerCommand) => {
    captured.push(command);
    return Effect.fail(
      new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Stop after intake",
      }),
    );
  };

const layerFailingDispatch = (captured: OrchestrationV2ServerCommand[]) =>
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    dispatch: layerFailingDispatchHandler(captured),
  });

const NOW = DateTime.makeUnsafe("2026-09-13T00:00:00.000Z");

const answeredRespondEvents = (input: {
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly attachmentsByQuestionId: UserInputAttachments;
}): OrchestrationV2StoredEvent[] => [
  {
    sequence: 1,
    commandId: null,
    event: {
      id: EventId.make("evt-recorded-answer"),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: NOW,
      payload: {
        id: TurnItemId.make("item-recorded-answer"),
        type: "user_input_request",
        threadId: input.threadId,
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
        completedAt: NOW,
        updatedAt: NOW,
        requestId: RuntimeRequestId.make(input.requestId),
        questions: [],
        questionAnswer: {
          requestId: input.requestId,
          answers: {},
          attachmentsByQuestionId: input.attachmentsByQuestionId,
        },
      },
    },
  },
];

it.effect("claims question uploads and passes readable paths through the V2 request command", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const id = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${id}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const captured: OrchestrationV2ServerCommand[] = [];
    yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-1"),
      threadId: ThreadId.make("thread-answer"),
      requestId: RuntimeRequestId.make("request-1"),
      answers: { q: ["Selected option"] },
      attachmentsByQuestionId: {
        q: [{ type: "image", id, name: "screen.png", mimeType: "image/png", sizeBytes: 3 }],
      },
    }).pipe(Effect.provide(layerFailingDispatch(captured)), Effect.result);
    expect(captured).toHaveLength(1);
    const command = captured[0]!;
    expect(command.type).toBe("runtime-request.respond");
    if (command.type !== "runtime-request.respond") return;
    const attachment = command.attachmentsByQuestionId?.q?.[0];
    expect(attachment).toBeDefined();
    const path = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: attachment!,
    });
    expect(path).not.toBeNull();
    expect(NodeFS.readFileSync(path!)).toEqual(Buffer.from([1, 2, 3]));
    expect(command.answers?.q).toEqual([
      "Selected option",
      `Attached image "screen.png": "${path}"`,
    ]);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("retains claimed copies when dispatch failure may have been accepted", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const captured: OrchestrationV2ServerCommand[] = [];
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-ambiguous"),
      threadId: ThreadId.make("thread-ambiguous"),
      requestId: RuntimeRequestId.make("request-ambiguous"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(Effect.provide(layerFailingDispatch(captured)), Effect.result);
    expect(result._tag).toBe("Failure");
    expect(captured).toHaveLength(1);
    const threadFiles = NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
      entry.startsWith("thread-ambiguous-"),
    );
    expect(threadFiles).toHaveLength(1);
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("releases claimed copies when the command was already rejected", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-rejected"),
      threadId: ThreadId.make("thread-rejected"),
      requestId: RuntimeRequestId.make("request-rejected"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: (command) =>
            Effect.fail(
              new OrchestratorCommandPreviouslyRejectedError({
                commandId: command.commandId,
                commandType: command.type,
                detail: "rejected earlier",
              }),
            ),
        }),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-rejected-"),
      ),
    ).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("releases claimed copies when dispatch replays an earlier accepted response", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread-replay");
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const earlierAttachment = {
      type: "image" as const,
      id: ChatAttachmentId.make("thread-replay-00000000-0000-4000-8000-0000000000aa"),
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 3,
    };
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${earlierAttachment.id}.png`),
      new Uint8Array([4, 4, 4]),
    );
    const storedEvents = answeredRespondEvents({
      threadId,
      requestId: "request-replay",
      attachmentsByQuestionId: { q: [earlierAttachment] },
    });
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-replay"),
      threadId,
      requestId: RuntimeRequestId.make("request-replay"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: () => Effect.succeed({ sequence: 1, storedEvents }),
        }),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Success");
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-replay-"),
      ),
    ).toEqual([`${earlierAttachment.id}.png`]);
    expect(
      NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${earlierAttachment.id}.png`)),
    ).toEqual(Buffer.from([4, 4, 4]));
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("a retried response re-claims the preserved pending uploads", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread-retry");
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    const lateId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const command: OrchestrationV2Command = {
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-retry"),
      threadId,
      requestId: RuntimeRequestId.make("request-retry"),
      answers: { q1: ["one"], q2: ["two"] },
      attachmentsByQuestionId: {
        q1: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
        q2: [
          {
            type: "image",
            id: lateId,
            name: "late.png",
            mimeType: "image/png",
            sizeBytes: 2,
          },
        ],
      },
    };
    const captured: OrchestrationV2ServerCommand[] = [];
    const first = yield* dispatchCommand(command).pipe(
      Effect.provide(layerFailingDispatch(captured)),
      Effect.result,
    );
    expect(first._tag).toBe("Failure");
    expect(captured).toHaveLength(0);

    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${lateId}.png`),
      new Uint8Array([7, 7]),
    );
    const retry = yield* dispatchCommand(command).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: (dispatched) => {
            captured.push(dispatched);
            return Effect.succeed({ sequence: 1, storedEvents: [] });
          },
        }),
      ),
      Effect.result,
    );
    expect(retry._tag).toBe("Success");
    const dispatched = captured[0]!;
    expect(dispatched.type).toBe("runtime-request.respond");
    if (dispatched.type !== "runtime-request.respond") return;
    for (const attachment of [
      ...(dispatched.attachmentsByQuestionId?.q1 ?? []),
      ...(dispatched.attachmentsByQuestionId?.q2 ?? []),
    ]) {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      expect(path).not.toBeNull();
      expect(NodeFS.existsSync(path!)).toBe(true);
    }
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-retry-"),
      ),
    ).toHaveLength(2);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("sends a guest message with the guest's files, never ones the client names", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const guestFile = {
      type: "image" as const,
      id: ChatAttachmentId.make(createAttachmentId("thread-guest")!),
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 3,
    };
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${guestFile.id}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const guestMessageId = GuestMessageId.make("guest-message:files");
    const captured: OrchestrationV2ServerCommand[] = [];
    const layerGuestShare = Layer.mock(ThreadManagementService.ThreadManagementService)({
      dispatch: layerFailingDispatchHandler(captured),
      // Only the share is read.
      getThreadSnapshotWindow: () =>
        Effect.succeed({
          projection: {
            thread: {
              guestShare: {
                messages: [{ id: guestMessageId, status: "pending", attachments: [guestFile] }],
              },
            },
          },
        } as unknown as Effect.Success<
          ReturnType<
            ThreadManagementService.ThreadManagementServiceShape["getThreadSnapshotWindow"]
          >
        >),
    });
    yield* dispatchCommand({
      type: "message.dispatch",
      commandId: CommandId.make("send-guest-message"),
      threadId: ThreadId.make("thread-guest"),
      messageId: MessageId.make("message-guest"),
      guestMessageId,
      text: "",
      attachments: [{ ...guestFile, id: ChatAttachmentId.make("thread-guest-owner-file") }],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    }).pipe(Effect.provide(layerGuestShare), Effect.result);
    const command = captured[0];
    if (command?.type !== "message.dispatch") throw new Error("Expected a message dispatch.");
    expect(command.attachments).toHaveLength(1);
    // The guest's file, which is already the thread's.
    expect(command.attachments).toEqual([guestFile]);
  }).pipe(Effect.provide(layerIntakeTest)),
);

const layerAcceptingDispatch = (
  captured: OrchestrationV2ServerCommand[],
  receipts: ReadonlySet<string> = new Set(),
  ranCommands: ReadonlyArray<OrchestrationV2TurnItem> = [],
) =>
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    hasReceipt: (commandId) => Effect.succeed(receipts.has(commandId)),
    getTurnItem: ({ itemId }) =>
      Effect.succeed({ item: ranCommands.find((item) => item.id === itemId) ?? null }),
    dispatch: (command) => {
      captured.push(command);
      return Effect.succeed({ sequence: 1, storedEvents: [] });
    },
  });

const shellSend = (id: string, shellCommand = true): OrchestrationV2Command => ({
  type: "message.dispatch",
  commandId: CommandId.make(`shell-${id}`),
  threadId: ThreadId.make("thread-shell"),
  messageId: MessageId.make(`message-${id}`),
  text: "npm test",
  shellCommand,
  attachments: [],
  dispatchMode: { type: "start_immediately" },
  createdBy: "user",
  creationSource: "web",
});

const shellsOn = ServerSettings.layerTest({ enableShellCommands: true });

it.effect("refuses new shell commands while the environment has them turned off", () =>
  Effect.gen(function* () {
    const captured: OrchestrationV2ServerCommand[] = [];
    const refused = yield* dispatchCommand(shellSend("off")).pipe(
      Effect.provide(layerAcceptingDispatch(captured)),
      Effect.flip,
    );
    expect(refused._tag).toBe("ShellCommandsDisabledError");
    expect(refused.message).toContain("Turn on Shell commands in Settings");
    const editRefused = yield* dispatchCommand({
      type: "queued-run.edit",
      commandId: CommandId.make("edit-shell"),
      threadId: ThreadId.make("thread-shell"),
      runId: RunId.make("run-queued"),
      text: "npm run lint",
      shellCommand: true,
    }).pipe(Effect.provide(layerAcceptingDispatch(captured)), Effect.flip);
    expect(editRefused._tag).toBe("ShellCommandsDisabledError");
    expect(captured).toHaveLength(0);

    // A plain message, and a stop for a command already running, are not shell sends.
    yield* dispatchCommand(shellSend("plain", false)).pipe(
      Effect.provide(layerAcceptingDispatch(captured)),
    );
    yield* dispatchCommand({
      type: "user-shell-command.stop",
      commandId: CommandId.make("stop-shell"),
      threadId: ThreadId.make("thread-shell"),
      turnItemId: TurnItemId.make("turn-item:user-shell:message-running"),
    }).pipe(Effect.provide(layerAcceptingDispatch(captured)));
    expect(captured.map((command) => command.type)).toEqual([
      "message.dispatch",
      "user-shell-command.stop",
    ]);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("accepts shell commands once the environment turns them on", () =>
  Effect.gen(function* () {
    const captured: OrchestrationV2ServerCommand[] = [];
    yield* dispatchCommand(shellSend("on")).pipe(
      Effect.provide(Layer.mergeAll(layerAcceptingDispatch(captured), shellsOn)),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ type: "message.dispatch", shellCommand: true });
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("replays an accepted shell command after the setting is turned off", () =>
  Effect.gen(function* () {
    const captured: OrchestrationV2ServerCommand[] = [];
    yield* dispatchCommand(shellSend("retry")).pipe(
      Effect.provide(layerAcceptingDispatch(captured, new Set(["shell-retry"]))),
    );
    expect(captured).toHaveLength(1);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("refuses a client resend of a command that already ran", () =>
  Effect.gen(function* () {
    const captured: OrchestrationV2ServerCommand[] = [];
    const ran: OrchestrationV2TurnItem = {
      id: userShellCommandItemId(MessageId.make("message-ran")),
      threadId: ThreadId.make("thread-shell"),
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
      type: "command_execution",
      input: "npm test",
      userShellMessageId: MessageId.make("message-ran"),
    };
    const refused = yield* dispatchCommand(shellSend("ran")).pipe(
      Effect.provide(Layer.mergeAll(layerAcceptingDispatch(captured, new Set(), [ran]), shellsOn)),
      Effect.flip,
    );
    expect(refused._tag).toBe("OrchestratorDispatchError");
    expect(captured).toHaveLength(0);
    // A retry of the send that ran it replays its receipt.
    yield* dispatchCommand(shellSend("ran")).pipe(
      Effect.provide(
        Layer.mergeAll(layerAcceptingDispatch(captured, new Set(["shell-ran"]), [ran]), shellsOn),
      ),
    );
    expect(captured).toHaveLength(1);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("refuses to launch a thread with a shell command while they are off", () =>
  Effect.gen(function* () {
    const launched: ThreadLaunchService.ThreadLaunchInput[] = [];
    const layerLaunch = Layer.mergeAll(
      layerAcceptingDispatch([]),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) => {
          launched.push(input);
          return Effect.die("launch result is not read here");
        },
      }),
    );
    const input: ThreadLaunchService.ThreadLaunchInput = {
      commandId: CommandId.make("launch-shell"),
      projectId: ProjectId.make("project-shell"),
      title: "npm test",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { text: "npm test", shellCommand: true, attachments: [] },
      createdBy: "user",
      creationSource: "web",
    };
    const refused = yield* launchThread(input).pipe(Effect.provide(layerLaunch), Effect.flip);
    expect(refused._tag).toBe("ShellCommandsDisabledError");
    expect(launched).toHaveLength(0);

    yield* launchThread(input).pipe(
      Effect.provide(Layer.mergeAll(layerLaunch, shellsOn)),
      Effect.exit,
    );
    expect(launched).toHaveLength(1);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("a launch retry passes the setting only once its shell command was accepted", () =>
  Effect.gen(function* () {
    const launched: ThreadLaunchService.ThreadLaunchInput[] = [];
    const layerLaunch = (receipts: ReadonlySet<string>) =>
      Layer.mergeAll(
        layerAcceptingDispatch([], receipts),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) => {
            launched.push(input);
            return Effect.die("launch result is not read here");
          },
        }),
      );
    const input: ThreadLaunchService.ThreadLaunchInput = {
      commandId: CommandId.make("launch-retry"),
      projectId: ProjectId.make("project-shell"),
      title: "npm test",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { text: "npm test", shellCommand: true, attachments: [] },
      createdBy: "user",
      creationSource: "web",
    };
    // The thread was created, but its command never was.
    const refused = yield* launchThread(input).pipe(
      Effect.provide(layerLaunch(new Set(["launch-retry"]))),
      Effect.flip,
    );
    expect(refused._tag).toBe("ShellCommandsDisabledError");
    expect(launched).toHaveLength(0);

    yield* launchThread(input).pipe(
      Effect.provide(layerLaunch(new Set(["launch-retry", "launch-retry:initial-message"]))),
      Effect.exit,
    );
    expect(launched).toHaveLength(1);
  }).pipe(Effect.provide(layerIntakeTest)),
);
