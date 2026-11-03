// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  SHELL_COMMAND_OUTPUT_FILE_NAME,
  SHELL_COMMAND_PARTIAL_OUTPUT_FILE_NAME,
  SHELL_COMMAND_SAVED_OUTPUT_MAX_BYTES,
} from "@t3tools/shared/shellCommand";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { CommandOutputHub } from "./CommandOutputHub.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import {
  layer as userShellCommandServiceLayer,
  recordUserShellResult,
  runUserShellProcess,
  UserShellCommandService,
  userShellCommandEnv,
} from "./UserShellCommandService.ts";

const threadId = ThreadId.make("thread:user-shell");

const run = (
  command: string,
  options: {
    readonly stop?: Deferred.Deferred<void>;
    /** Sees everything the command printed so far, and the directory it runs in. */
    readonly onOutput?: (output: string, cwd: string) => Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-user-shell-" });
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-attachments-" });
    const stop = options.stop ?? (yield* Deferred.make<void>());
    const chunks: Array<string> = [];
    const result = yield* runUserShellProcess({
      command,
      cwd,
      env: { ...process.env, SHELL: "/bin/sh" },
      threadId,
      attachmentsDir,
      stop,
      onOutput: (chunk) =>
        Effect.sync(() => chunks.push(chunk)).pipe(
          Effect.andThen(() => options.onOutput?.(chunks.join(""), cwd) ?? Effect.void),
        ),
    });
    return { result, chunks, cwd, attachmentsDir };
  });

/** Lets a fixture blocked on `read line < name` carry on. */
const release = (cwd: string, name: string) =>
  Effect.promise(() => NodeFS.promises.writeFile(`${cwd}/${name}`, "\n"));

/** Opens a FIFO for reading, once a writer has opened it too. */
const openFifo = (fifo: string) =>
  Effect.callback<NodeFS.ReadStream>((resume) => {
    const stream = NodeFS.createReadStream(fifo);
    stream.once("open", () => {
      stream.resume();
      resume(Effect.succeed(stream));
    });
    stream.once("error", (error) => resume(Effect.die(error)));
    return Effect.sync(() => stream.destroy());
  });

/** Completes once every writer of the FIFO has closed it. */
const writersClosed = (stream: NodeFS.ReadStream) =>
  Effect.callback<void>((resume) => {
    if (stream.readableEnded) return resume(Effect.void);
    stream.once("end", () => resume(Effect.void));
    return Effect.sync(() => stream.destroy());
  });

// The fixtures are POSIX shell scripts; Windows runs PowerShell.
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("runUserShellProcess", () => {
  it.live("reports the exit code and stdout and stderr in the order they arrived", () =>
    Effect.gen(function* () {
      const released = new Set<string>();
      // Each line is printed only once the one before it was read, so the order is fixed.
      const { result, chunks, cwd } = yield* run(
        "mkfifo go1 go2; pwd; printf 'out1\\n'; read line < go1; printf 'err1\\n' >&2; read line < go2; printf 'out2\\n'; exit 3",
        {
          onOutput: (output, cwd) => {
            const next = output.endsWith("out1\n") ? "go1" : output.endsWith("err1\n") ? "go2" : "";
            if (next === "" || released.has(next)) return Effect.void;
            released.add(next);
            return release(cwd, next);
          },
        },
      );
      const realCwd = yield* (yield* FileSystem.FileSystem).realPath(cwd);
      assert.equal(result.exitCode, 3);
      assert.isFalse(result.stopped);
      assert.equal(result.output, `${realCwd}\nout1\nerr1\nout2\n`);
      assert.equal(chunks.join(""), result.output);
      assert.isUndefined(result.fullOutput);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("saves output past the tail to a thread attachment", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { result, attachmentsDir } = yield* run(
        "head -c 40000 /dev/zero | tr '\\000' x; printf 'end\\n'",
      );
      assert.equal(result.exitCode, 0);
      assert.equal(Buffer.byteLength(result.output), 32 * 1024);
      assert.isTrue(result.output.endsWith("xend\n"));
      const fullOutput = result.fullOutput;
      assert.isDefined(fullOutput);
      assert.equal(fullOutput?.sizeBytes, 40_004);
      assert.isTrue(fullOutput?.id.startsWith("thread-user-shell-"));
      const saved = yield* fileSystem.readFileString(
        path.join(attachmentsDir, `${fullOutput?.id}.log`),
      );
      assert.equal(saved.length, 40_004);
      assert.equal(fullOutput?.name, SHELL_COMMAND_OUTPUT_FILE_NAME);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("names saved output that outgrew the cap as partial", () =>
    Effect.gen(function* () {
      const { result } = yield* run(
        `head -c ${SHELL_COMMAND_SAVED_OUTPUT_MAX_BYTES + 10} /dev/zero | tr '\\000' x; printf 'end\\n'`,
      );
      assert.equal(result.exitCode, 0);
      assert.isTrue(result.output.endsWith("xend\n"));
      assert.equal(result.fullOutput?.sizeBytes, SHELL_COMMAND_SAVED_OUTPUT_MAX_BYTES);
      assert.equal(result.fullOutput?.name, SHELL_COMMAND_PARTIAL_OUTPUT_FILE_NAME);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("kills the command's whole process group when stopped", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const stop = yield* Deferred.make<void>();
      const started = yield* Deferred.make<string>();
      // The child alone holds the FIFO open for writing, so its end of file means the child died.
      const running = yield* run('mkfifo held; sleep 30 3>held & echo "child $!"; wait', {
        stop,
        onOutput: (output, cwd) =>
          output.includes("child ")
            ? Deferred.succeed(started, cwd).pipe(Effect.asVoid)
            : Effect.void,
      }).pipe(Effect.forkScoped);
      const held = yield* openFifo(path.join(yield* Deferred.await(started), "held"));
      yield* Deferred.succeed(stop, undefined);
      const { result } = yield* Fiber.join(running);
      assert.isTrue(result.stopped);
      assert.isUndefined(result.exitCode);
      assert.match(result.output, /child \d+/);
      yield* writersClosed(held);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("spawns nothing when stopped before it started", () =>
    Effect.gen(function* () {
      const stop = yield* Deferred.make<void>();
      yield* Deferred.succeed(stop, undefined);
      // A spawn would fail on the missing directory; a stop must not get that far.
      const result = yield* runUserShellProcess({
        command: "true",
        cwd: "/nonexistent/t3-user-shell",
        env: { ...process.env, SHELL: "/bin/sh" },
        threadId,
        attachmentsDir: "/nonexistent/t3-attachments",
        stop,
        onOutput: () => Effect.void,
      });
      assert.isTrue(result.stopped);
      assert.isUndefined(result.exitCode);
      assert.equal(result.output, "");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("finishes when a process that left the group keeps the output open", () =>
    Effect.gen(function* () {
      let orphan: number | undefined;
      // The orphan has its own session, so killing the command's group leaves it running.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (orphan === undefined) return;
          try {
            process.kill(orphan, "SIGKILL");
          } catch {
            // Already gone.
          }
        }),
      );
      const { result } = yield* run(
        'mkfifo ready; perl -e \'use POSIX; POSIX::setsid() or die; open(my $r, ">", "ready"); close($r); sleep 30\' & echo "orphan $!"; read line < ready; echo detached',
        {
          onOutput: (output) =>
            Effect.sync(() => {
              const pid = /orphan (\d+)/.exec(output)?.[1];
              if (pid !== undefined) orphan = Number(pid);
            }),
        },
      );
      assert.equal(result.exitCode, 0);
      assert.match(result.output, /orphan \d+\ndetached\n$/);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("userShellCommandEnv", () => {
  it("drops the server's own variables as the terminal does, and turns pagers off", () => {
    const env = userShellCommandEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/user",
        PORT: "3773",
        ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_RENDERER_PORT: "5173",
        TMUX: "/tmp/tmux-1/default,1,0",
        TMUX_PANE: "%1",
        ZELLIJ: "0",
        T3CODE_HOME: "/home/user/.t3",
        VITE_HTTP_URL: "http://localhost:3773",
        PAGER: "less",
      },
      { projectRoot: "/work/app", worktreePath: "/work/app-tree" },
    );
    assert.deepEqual(env, {
      PATH: "/usr/bin",
      HOME: "/home/user",
      T3CODE_PROJECT_ROOT: "/work/app",
      T3CODE_WORKTREE_PATH: "/work/app-tree",
      PAGER: "cat",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
    });
  });
});

describe("recordUserShellResult", () => {
  const target = { threadId, turnItemId: TurnItemId.make("turn-item:user-shell:message") };

  it.effect("retries a failed write until it is recorded", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const dispatch = Effect.suspend(() =>
        ++attempts < 3 ? Effect.fail("database busy") : Effect.void,
      );
      const recording = yield* recordUserShellResult(dispatch, target).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(recording);
      assert.equal(attempts, 3);
    }),
  );

  it.effect("gives up after a bounded number of attempts", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const dispatch = Effect.suspend(() => {
        attempts += 1;
        return Effect.fail("database busy");
      });
      const recording = yield* recordUserShellResult(dispatch, target).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 hour");
      yield* Fiber.join(recording);
      assert.equal(attempts, 5);
    }),
  );
});

describe("UserShellCommandService", () => {
  it.effect("reports a command it cannot run as failed, so its run does not wait forever", () =>
    Effect.gen(function* () {
      const finished = yield* Deferred.make<OrchestrationV2ServerCommand>();
      const turnItemId = TurnItemId.make("item:user-shell");
      const runId = RunId.make("run:user-shell");
      const layer = userShellCommandServiceLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            ServerSettings.layerTest(),
            Layer.mock(ServerConfig.ServerConfig)({
              attachmentsDir: "/synthetic-attachments",
              worktreesDir: "/synthetic-worktrees",
            } as never),
            Layer.mock(GitWorkflowService.GitWorkflowService)({}),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(CheckpointServiceV2)({}),
            Layer.mock(CommandOutputHub)({ append: () => Effect.void, finish: () => Effect.void }),
            Layer.mock(OrchestratorV2)({
              dispatch: (command) =>
                Deferred.succeed(finished, command).pipe(
                  Effect.as({ sequence: 0, storedEvents: [] }),
                ),
            }),
            Layer.mock(ProjectionStoreV2)({
              getTurnItem: () =>
                Effect.succeed({
                  id: turnItemId,
                  threadId,
                  runId,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 1,
                  status: "running",
                  title: null,
                  startedAt: null,
                  completedAt: null,
                  updatedAt: DateTime.makeUnsafe(0),
                  type: "command_execution",
                  input: "ls",
                  userShellMessageId: MessageId.make("message:user-shell"),
                }),
              getThreadRecords: () =>
                Effect.succeed({
                  thread: { id: threadId, projectId: ProjectId.make("project:gone") },
                  runs: [{ id: runId }],
                  nodes: [],
                  checkpointScopes: [],
                } as never),
            }),
            // The thread's project was deleted while the command waited.
            Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedNone }),
          ),
        ),
      );
      const command = yield* UserShellCommandService.use((service) =>
        service.start({ threadId, turnItemId }),
      ).pipe(Effect.andThen(Deferred.await(finished)), Effect.provide(layer));
      assert.equal(command.type, "user-shell-command.finish");
      if (command.type !== "user-shell-command.finish") return;
      assert.equal(command.turnItemId, turnItemId);
      assert.equal(command.exitCode, 1);
      assert.isFalse(command.stopped);
      assert.include(command.output, "project");
    }),
  );
});
