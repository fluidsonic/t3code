import {
  type ChatFileAttachment,
  CommandId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import {
  isUserShellCommandItem,
  USER_SHELL_OUTPUT_TAIL_BYTES,
  utf8Tail,
} from "@t3tools/provider-core/server/userShellCommand";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import {
  SHELL_COMMAND_OUTPUT_FILE_NAME,
  SHELL_COMMAND_PARTIAL_OUTPUT_FILE_NAME,
  SHELL_COMMAND_SAVED_OUTPUT_MAX_BYTES,
} from "@t3tools/shared/shellCommand";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { makeRecreateMissingWorktree } from "./ThreadWorktree.ts";
import { inheritedShellEnv } from "../terminal/terminalEnv.ts";

/** How long a stopped command gets to exit on SIGTERM before its process group gets SIGKILL. */
const STOP_GRACE = "3 seconds";
/**
 * How long output may keep arriving once the command's group is gone. A process that left the
 * group (`setsid cmd &`) can hold the pipe open forever, and the command still has to finish.
 */
const OUTPUT_DRAIN_GRACE = "1 second";

/**
 * What a `! cmd` command runs with: the server's environment cleaned as the integrated terminal
 * cleans it, the project's script variables, and no pager or prompt that would wait for input
 * nobody can give.
 */
export function userShellCommandEnv(
  hostEnv: NodeJS.ProcessEnv,
  input: { readonly projectRoot: string; readonly worktreePath: string | null },
): NodeJS.ProcessEnv {
  return {
    ...inheritedShellEnv(hostEnv),
    ...projectScriptRuntimeEnv({
      project: { cwd: input.projectRoot },
      ...(input.worktreePath === null ? {} : { worktreePath: input.worktreePath }),
    }),
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export interface UserShellProcessResult {
  /** Absent when the process never started, was stopped, or died from a signal. */
  readonly exitCode: number | undefined;
  readonly stopped: boolean;
  /** The last 32 KB of combined stdout and stderr, in arrival order. */
  readonly output: string;
  /** The whole output, once it outgrew the tail. */
  readonly fullOutput: ChatFileAttachment | undefined;
  readonly startedAt: DateTime.Utc;
  readonly completedAt: DateTime.Utc;
}

/**
 * The person's own shell, run non-interactively so it never waits on a prompt: no TTY, stdin
 * closed, rc files a login or interactive shell would read left alone.
 */
function shellInvocations(
  command: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): ReadonlyArray<readonly [string, ReadonlyArray<string>]> {
  if (platform === "win32") {
    const args = ["-NoProfile", "-NonInteractive", "-Command", command];
    return [
      ["pwsh", args],
      ["powershell.exe", args],
    ];
  }
  const shell = env.SHELL?.trim();
  return shell === undefined || shell.length === 0 || shell === "/bin/sh"
    ? [["/bin/sh", ["-c", command]]]
    : [
        [shell, ["-c", command]],
        ["/bin/sh", ["-c", command]],
      ];
}

/**
 * Runs one command in its own process group and collects its output. Completing `stop` kills the
 * group (SIGTERM, then SIGKILL); interrupting the fiber does the same through the spawn's scope.
 */
export const runUserShellProcess = Effect.fn("UserShellCommandService.runProcess")(
  function* (input: {
    readonly command: string;
    readonly cwd: string;
    readonly env: Record<string, string | undefined>;
    readonly threadId: ThreadId;
    readonly attachmentsDir: string;
    readonly stop: Deferred.Deferred<void>;
    readonly onOutput: (chunk: string) => Effect.Effect<void>;
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
    const startedAt = yield* DateTime.now;
    // A stop that landed while the workspace was being prepared runs nothing.
    if (yield* Deferred.isDone(input.stop)) {
      return {
        exitCode: undefined,
        stopped: true,
        output: "",
        fullOutput: undefined,
        startedAt,
        completedAt: startedAt,
      } satisfies UserShellProcessResult;
    }
    const spawn = ([file, args]: readonly [string, ReadonlyArray<string>]) =>
      spawner.spawn(
        ChildProcess.make(file, args, {
          cwd: input.cwd,
          env: input.env,
          extendEnv: false,
          stdin: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: STOP_GRACE,
        }),
      );
    const [first, ...fallbacks] = shellInvocations(input.command, platform, input.env);
    const spawned = yield* Effect.result(
      fallbacks.reduce(
        (attempt, invocation) => attempt.pipe(Effect.catch(() => spawn(invocation))),
        spawn(first!),
      ),
    );
    if (spawned._tag === "Failure") {
      return {
        exitCode: 127,
        stopped: false,
        output: `Failed to start the shell: ${spawned.failure.message}\n`,
        fullOutput: undefined,
        startedAt,
        completedAt: yield* DateTime.now,
      } satisfies UserShellProcessResult;
    }
    const handle = spawned.success;

    const decoder = new TextDecoder();
    let tail = "";
    let totalBytes = 0;
    const head: Array<Uint8Array> = [];
    let spill:
      | { readonly file: FileSystem.File; readonly attachment: ChatFileAttachment; written: number }
      | undefined;
    let spillFailed = false;

    // Past the inline tail the whole output goes to a file, so a log of any size costs at most
    // the tail in memory and in events. These run per output chunk, inside the runProcess span.
    const writeSpill = Effect.fnUntraced(function* (bytes: Uint8Array) {
      if (spill === undefined || spillFailed) return;
      const room = SHELL_COMMAND_SAVED_OUTPUT_MAX_BYTES - spill.written;
      if (room <= 0) return;
      const chunk = bytes.byteLength > room ? bytes.subarray(0, room) : bytes;
      yield* spill.file.writeAll(chunk);
      spill.written += chunk.byteLength;
    });
    const openSpill = Effect.gen(function* () {
      const id = createAttachmentId(input.threadId, ".log");
      if (id === null) return yield* Effect.fail("Thread id has no attachment segment.");
      const attachment: ChatFileAttachment = {
        type: "file",
        id,
        name: SHELL_COMMAND_OUTPUT_FILE_NAME,
        mimeType: "text/plain",
        sizeBytes: 1,
      };
      const filePath = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
      if (filePath === null) return yield* Effect.fail("Attachment path is outside its directory.");
      yield* fileSystem.makeDirectory(input.attachmentsDir, { recursive: true });
      const file = yield* fileSystem.open(filePath, { flag: "w" });
      spill = { file, attachment, written: 0 };
      for (const bytes of head.splice(0)) yield* writeSpill(bytes);
    });
    const onBytes = Effect.fnUntraced(function* (bytes: Uint8Array) {
      totalBytes += bytes.byteLength;
      if (spill === undefined && !spillFailed) {
        head.push(bytes);
        if (totalBytes > USER_SHELL_OUTPUT_TAIL_BYTES) {
          yield* openSpill.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("user shell command output could not be saved", {
                threadId: input.threadId,
                cause: Cause.pretty(cause),
              }).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    spillFailed = true;
                    head.length = 0;
                  }),
                ),
              ),
            ),
          );
        }
      } else {
        yield* writeSpill(bytes).pipe(
          Effect.catchCause(() =>
            Effect.sync(() => {
              spillFailed = true;
            }),
          ),
        );
      }
      const text = decoder.decode(bytes, { stream: true });
      if (text.length === 0) return;
      tail += text;
      if (tail.length > USER_SHELL_OUTPUT_TAIL_BYTES * 2) {
        tail = utf8Tail(tail, USER_SHELL_OUTPUT_TAIL_BYTES);
      }
      yield* input.onOutput(text);
    });

    const reader = yield* handle.all.pipe(
      Stream.runForEach(onBytes),
      Effect.ignoreCause,
      Effect.forkScoped,
    );
    const outcome = yield* Effect.raceFirst(
      handle.exitCode.pipe(
        Effect.map((code): number | undefined => code),
        Effect.orElseSucceed(() => undefined),
        Effect.map((exitCode) => ({ stopped: false, exitCode }) as const),
      ),
      Deferred.await(input.stop).pipe(Effect.as({ stopped: true, exitCode: undefined } as const)),
    );
    // Also ends anything the command left running in its group, which would otherwise hold the
    // output pipes open.
    yield* handle.kill({ killSignal: "SIGTERM", forceKillAfter: STOP_GRACE }).pipe(Effect.ignore);
    const drained = yield* Fiber.join(reader).pipe(Effect.timeoutOption(OUTPUT_DRAIN_GRACE));
    if (Option.isNone(drained)) yield* Fiber.interrupt(reader);
    const rest = decoder.decode();
    if (rest.length > 0) {
      tail += rest;
      yield* input.onOutput(rest);
    }
    const fullOutput =
      spill === undefined || spillFailed || spill.written === 0
        ? undefined
        : {
            ...spill.attachment,
            ...(totalBytes > spill.written ? { name: SHELL_COMMAND_PARTIAL_OUTPUT_FILE_NAME } : {}),
            sizeBytes: spill.written,
          };
    return {
      exitCode: outcome.exitCode,
      stopped: outcome.stopped,
      output: utf8Tail(tail, USER_SHELL_OUTPUT_TAIL_BYTES),
      fullOutput,
      startedAt,
      completedAt: yield* DateTime.now,
    } satisfies UserShellProcessResult;
  },
  Effect.scoped,
);

/**
 * Until its result is recorded, a command's item reads as running and the thread's other commands
 * wait, so a failed write is retried. The finish command id is fixed per item, so a retry after a
 * write that did commit replays its receipt.
 */
export const recordUserShellResult = Effect.fn("UserShellCommandService.recordResult")(function* <
  E,
  R,
>(
  dispatch: Effect.Effect<unknown, E, R>,
  target: { readonly threadId: ThreadId; readonly turnItemId: TurnItemId },
) {
  yield* dispatch.pipe(
    Effect.retry({ times: 4, schedule: Schedule.exponential("500 millis") }),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) =>
        Effect.logWarning("user shell command result could not be recorded", {
          threadId: target.threadId,
          turnItemId: target.turnItemId,
          cause: Cause.pretty(cause),
        }),
    ),
  );
});

/**
 * Runs a person's `! cmd` commands outside the effect outbox, which handles one effect per thread
 * at a time: `start` forks the process and returns, and the result comes back to the orchestrator
 * as a `user-shell-command.finish` command.
 */
export interface UserShellCommandServiceShape {
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly turnItemId: TurnItemId;
  }) => Effect.Effect<void>;
  readonly stop: (input: {
    readonly threadId: ThreadId;
    readonly turnItemIds: ReadonlyArray<TurnItemId>;
  }) => Effect.Effect<void>;
  /** Archive and delete end every command of the thread. */
  readonly stopThread: (threadId: ThreadId) => Effect.Effect<void>;
}

// A reference with an idle default keeps test runtimes that never run commands free of the
// process spawner; the server runtime provides `layer`.
export class UserShellCommandService extends Context.Reference<UserShellCommandServiceShape>(
  "t3/orchestration-v2/UserShellCommandService",
  {
    defaultValue: () => ({
      start: () => Effect.void,
      stop: () => Effect.void,
      stopThread: () => Effect.void,
    }),
  },
) {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const outputHub = yield* CommandOutputHub.CommandOutputHub;
  const checkpoints = yield* CheckpointService.CheckpointServiceV2;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const recreateMissingWorktree = yield* makeRecreateMissingWorktree;
  const services = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  >();
  const layerScope = yield* Effect.scope;
  const running = new Map<
    TurnItemId,
    { readonly threadId: ThreadId; readonly stop: Deferred.Deferred<void> }
  >();

  const prepare = Effect.fn("UserShellCommandService.prepare")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnItemId: TurnItemId;
  }) {
    const item = yield* projections.getTurnItem({
      threadId: input.threadId,
      itemId: input.turnItemId,
    });
    // A stop that landed before the effect ran already settled the item.
    if (item === null || !isUserShellCommandItem(item) || item.status !== "running") {
      return undefined;
    }
    const records = yield* projections.getThreadRecords(
      input.threadId,
      ["runs", "nodes", "checkpointScopes"],
      item.runId === null ? undefined : { runIds: [item.runId] },
    );
    const run = records.runs.find((candidate) => candidate.id === item.runId);
    const project = Option.getOrUndefined(yield* projects.get(records.thread.projectId));
    // Still reported, so the item and the run waiting on it settle.
    if (run === undefined) {
      return { _tag: "unavailable", reason: "The command's run no longer exists.\n" } as const;
    }
    if (project === undefined) {
      return { _tag: "unavailable", reason: "The command's project no longer exists.\n" } as const;
    }
    const thread = records.thread;
    // The same root the agent works in: the worktree, else the project (for a thread without a
    // project, its scratch folder).
    const cwd = thread.worktreePath ?? project.workspaceRoot;
    const rootNode = records.nodes.find((node) => node.id === run.rootNodeId);
    const scope = records.checkpointScopes.find(
      (entry) => entry.id === rootNode?.checkpointScopeId,
    );
    const lease = Effect.gen(function* () {
      // A command still runs against what exists; only a provider turn fails without its worktree.
      yield* recreateMissingWorktree(thread, "shell command").pipe(
        Effect.catch((error) =>
          Effect.logWarning("shell command failed to recreate worktree", {
            threadId: thread.id,
            cause: error.message,
          }),
        ),
      );
      // Before the run's first command, so its changes land in this run's diff. Later commands
      // and the provider turn find the baseline already there.
      if (run.status === "starting" && scope !== undefined) {
        yield* checkpoints
          .captureBaseline({ scope, ordinalWithinScope: Math.max(0, run.ordinal - 1) })
          .pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              () =>
                Effect.logWarning("user shell command ran without a checkpoint baseline", {
                  runId: run.id,
                }),
            ),
          );
      }
    });
    yield* thread.worktreePath === null
      ? lease
      : withWorkspaceLease(path.resolve(thread.worktreePath), lease);
    const hostEnv = yield* HostProcess.Environment;
    return {
      _tag: "ready" as const,
      command: item.input,
      cwd,
      env: userShellCommandEnv(hostEnv, {
        projectRoot: project.workspaceRoot,
        worktreePath: thread.worktreePath,
      }),
    };
  });

  const execute = Effect.fn("UserShellCommandService.execute")(function* (
    input: { readonly threadId: ThreadId; readonly turnItemId: TurnItemId },
    stop: Deferred.Deferred<void>,
  ) {
    const target = { threadId: input.threadId, itemId: input.turnItemId };
    const prepared = yield* prepare(input).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("user shell command could not be prepared", {
            threadId: input.threadId,
            turnItemId: input.turnItemId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(null)),
      ),
    );
    if (prepared === undefined) return;
    const result =
      prepared === null || prepared._tag === "unavailable"
        ? ({
            exitCode: 1,
            stopped: false,
            output:
              prepared === null
                ? "The command's workspace could not be prepared.\n"
                : prepared.reason,
            fullOutput: undefined,
            startedAt: yield* DateTime.now,
            completedAt: yield* DateTime.now,
          } satisfies UserShellProcessResult)
        : yield* runUserShellProcess({
            command: prepared.command,
            cwd: prepared.cwd,
            env: prepared.env,
            threadId: input.threadId,
            attachmentsDir: config.attachmentsDir,
            stop,
            onOutput: (chunk) => outputHub.append({ ...target, chunk }),
          }).pipe(Effect.provideContext(services));
    yield* outputHub.finish(target);
    yield* recordUserShellResult(
      orchestrator.dispatch({
        type: "user-shell-command.finish",
        commandId: CommandId.make(`command:user-shell-command.finish:${input.turnItemId}`),
        threadId: input.threadId,
        turnItemId: input.turnItemId,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        stopped: result.stopped,
        output: result.output,
        ...(result.fullOutput === undefined ? {} : { fullOutput: result.fullOutput }),
        startedAt: result.startedAt,
        completedAt: result.completedAt,
      }),
      input,
    );
  });

  const signal = (ids: Iterable<TurnItemId>) =>
    Effect.forEach(
      ids,
      (id) => {
        const entry = running.get(id);
        return entry === undefined ? Effect.void : Deferred.succeed(entry.stop, undefined);
      },
      { discard: true },
    );

  return {
    start: Effect.fn("UserShellCommandService.start")(function* (
      input: Parameters<UserShellCommandServiceShape["start"]>[0],
    ) {
      if (running.has(input.turnItemId)) return;
      const stop = Deferred.makeUnsafe<void>();
      // Registered before this returns, so a stop effect after it always finds the command.
      running.set(input.turnItemId, { threadId: input.threadId, stop });
      yield* execute(input, stop).pipe(
        Effect.ensuring(Effect.sync(() => running.delete(input.turnItemId))),
        Effect.forkIn(layerScope),
      );
    }),
    stop: (input: Parameters<UserShellCommandServiceShape["stop"]>[0]) => signal(input.turnItemIds),
    stopThread: (threadId: ThreadId) =>
      Effect.suspend(() =>
        signal(
          [...running.entries()].flatMap(([id, entry]) =>
            entry.threadId === threadId ? [id] : [],
          ),
        ),
      ),
  } satisfies UserShellCommandServiceShape;
});

export const layer = Layer.effect(UserShellCommandService, make);
