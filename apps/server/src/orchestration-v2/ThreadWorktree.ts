import type { OrchestrationV2AppThread } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";

export class WorktreeRecreateError extends Schema.TaggedError<WorktreeRecreateError>()(
  "WorktreeRecreateError",
  {
    worktreePath: Schema.String,
    branch: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not recreate the worktree for branch '${this.branch}' at ${this.worktreePath}.`;
  }
}

export class WorktreeRecreateNoBaseError extends Schema.TaggedError<WorktreeRecreateNoBaseError>()(
  "WorktreeRecreateNoBaseError",
  { worktreePath: Schema.String, branch: Schema.String },
) {
  override get message(): string {
    return `Could not recreate branch '${this.branch}' at ${this.worktreePath}: the project workspace has no current branch to start it from (detached HEAD?).`;
  }
}

/**
 * Storage cleanup can remove an idle thread's managed worktree. Work about to run in it puts the
 * worktree back on its branch first, recreating the branch from the workspace's when it is gone.
 */
export const makeRecreateMissingWorktree = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

  const recreate = Effect.fn("ThreadWorktree.recreate")(function* (input: {
    readonly cwd: string;
    readonly worktreePath: string;
    readonly branch: string;
  }) {
    const { cwd, worktreePath, branch } = input;
    yield* gitWorkflow.pruneWorktrees({ cwd });
    const localBranchNames = yield* gitWorkflow.listLocalBranchNames(cwd);
    if (localBranchNames.includes(branch)) {
      yield* gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath });
      return;
    }
    // Recovery can follow an external checkout, before the status cache expires.
    yield* gitWorkflow.invalidateLocalStatus(cwd);
    const { refName: baseRef } = yield* gitWorkflow.localStatus({ cwd });
    if (baseRef === null) {
      return yield* new WorktreeRecreateNoBaseError({ worktreePath, branch });
    }
    yield* gitWorkflow.createWorktree({
      cwd,
      refName: `refs/heads/${baseRef}`,
      newRefName: branch,
      baseRefName: `refs/heads/${baseRef}`,
      path: worktreePath,
    });
  });

  return Effect.fn("ThreadWorktree.recreateMissing")(function* (
    thread: Pick<OrchestrationV2AppThread, "id" | "projectId" | "worktreePath" | "branch">,
    /** Names the caller in log lines, e.g. "provider turn start". */
    logPrefix: string,
  ) {
    const { worktreePath, branch } = thread;
    if (worktreePath === null || branch === null) return;
    const exists = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
    if (exists || !(yield* isManagedWorktreePath(worktreePath))) return;
    const project = yield* projects.getById(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (project === undefined) return;
    yield* Effect.logWarning(`${logPrefix} recreating missing worktree`, {
      threadId: thread.id,
      worktreePath,
      branch,
    });
    yield* recreate({ cwd: project.workspaceRoot, worktreePath, branch }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "WorktreeRecreateNoBaseError"
          ? cause
          : new WorktreeRecreateError({ worktreePath, branch, cause }),
      ),
    );
  });
});
