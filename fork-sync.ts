#!/usr/bin/env node
// Rebuilds `fluidsonic/main` from upstream main plus every `fork/<order>-<name>` branch on origin,
// then builds "T3 Marc.app".
//
//   node fork-sync.ts              sync, check, push, build
//   node fork-sync.ts --dry-run    sync and check only; push and build nothing
//   node fork-sync.ts install      install the newest build into /Applications
//
// Branch scheme (the branch list is the source of truth):
//   fork/10-pr-20145       tracks upstream PR #20145; dropped once the PR is merged or closed
//   fork/10.1-<name>       stacked on fork/10-*; rebased onto it on every sync
//   fork/20-<name>         based on upstream main
// Orders sort numerically per segment. A topic whose commits all landed upstream is deleted.
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.env.T3_FORK_REPO ?? join(process.env.HOME ?? "", "Documents/t3-code-fork");
const UPSTREAM_REPO = "pingdotgg/t3code";
const FORK_REPO = "fluidsonic/t3code";
const INTEGRATION = "fluidsonic/main";
const APP_ID = "com.fluidsonic.t3marc";
const PRODUCT_NAME = "T3 Marc";
const OFFICIAL_APP_ID = "com.t3tools.t3code";
const INSTALL_PATH = `/Applications/${PRODUCT_NAME}.app`;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const report: string[] = [];
let pushed = false;
// Homebrew installs rustup keg-only; the desktop build needs cargo.
const env = { ...process.env, PATH: `${join(REPO, "node_modules/.bin")}:/opt/homebrew/opt/rustup/bin:${process.env.PATH}` };

class SyncError extends Error {}
const fail = (message: string): never => {
  throw new SyncError(message);
};

function exec(cmd: string, argv: string[], options: SpawnSyncOptions = {}) {
  const result = spawnSync(cmd, argv, { cwd: REPO, encoding: "utf8", env, ...options });
  return {
    ok: result.status === 0,
    out: `${result.stdout ?? ""}`.trim(),
    err: `${result.stderr ?? ""}`.trim(),
  };
}
function git(...argv: string[]): string {
  const result = exec("git", argv);
  if (!result.ok) fail(`git ${argv.join(" ")}\n${result.err || result.out}`);
  return result.out;
}
function step(cmd: string, argv: string[]) {
  const result = spawnSync(cmd, argv, { cwd: REPO, stdio: "inherit", env });
  if (result.status !== 0) fail(`${cmd} ${argv.join(" ")} failed`);
}

interface Entry {
  readonly branch: string;
  readonly order: number[];
  readonly name: string;
  readonly pr?: number;
  readonly oldTip: string;
  newTip?: string;
  dropped?: string;
}

const compareOrder = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
};

function listEntries(): Entry[] {
  const refs = git("for-each-ref", "--format=%(refname:strip=3) %(objectname)", "refs/remotes/origin/fork/");
  const entries: Entry[] = [];
  for (const line of refs.split("\n").filter(Boolean)) {
    const [branch, sha] = line.split(" ");
    const match = /^fork\/(\d+(?:\.\d+)*)-(.+)$/.exec(branch);
    if (!match) {
      report.push(`ignored ${branch}: name doesn't match fork/<order>-<name>`);
      continue;
    }
    const pr = /^pr-(\d+)$/.exec(match[2]);
    entries.push({
      branch,
      order: match[1].split(".").map(Number),
      name: match[2],
      ...(pr ? { pr: Number(pr[1]) } : {}),
      oldTip: sha,
    });
  }
  return entries.sort((a, b) => compareOrder(a.order, b.order));
}

const parentOf = (entry: Entry, entries: Entry[]) =>
  entry.order.length === 1
    ? undefined
    : entries.find((other) => compareOrder(other.order, entry.order.slice(0, -1)) === 0);

function finishInProgress(kind: "rebase" | "merge", label: string) {
  // rerere.autoUpdate stages recorded resolutions; anything still unmerged needs a human.
  for (;;) {
    const gitDir = git("rev-parse", "--absolute-git-dir");
    const inProgress =
      kind === "rebase"
        ? existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))
        : existsSync(join(gitDir, "MERGE_HEAD"));
    if (!inProgress) return;
    const unmerged = git("diff", "--name-only", "--diff-filter=U");
    if (unmerged) {
      exec("git", [kind, "--abort"]);
      fail(`${label}: conflicts rerere couldn't resolve in\n  ${unmerged.split("\n").join("\n  ")}`);
    }
    const next = exec("git", kind === "rebase" ? ["rebase", "--continue"] : ["commit", "--no-edit"], {
      env: { ...env, GIT_EDITOR: "true" },
    });
    if (!next.ok && kind === "merge") fail(`${label}: ${next.err || next.out}`);
    report.push(`${label}: reused a recorded conflict resolution`);
  }
}

function sync() {
  if (git("status", "--porcelain", "--untracked-files=no")) fail(`${REPO} has uncommitted changes`);
  const repoSync = exec("gh", ["repo", "sync", FORK_REPO, "-b", "main"]);
  if (!repoSync.ok) report.push(`couldn't sync ${FORK_REPO} main: ${repoSync.err}`);
  git("fetch", "--quiet", "upstream", "main");
  git("fetch", "--quiet", "--prune", "origin");
  const upstreamMain = git("rev-parse", "upstream/main");
  const entries = listEntries();

  for (const entry of entries) {
    if (entry.pr !== undefined) {
      const state = exec("gh", ["pr", "view", String(entry.pr), "-R", UPSTREAM_REPO, "--json", "state", "-q", ".state"]);
      if (!state.ok) fail(`${entry.branch}: can't read PR #${entry.pr}: ${state.err}`);
      if (state.out !== "OPEN") {
        entry.dropped = `PR #${entry.pr} is ${state.out.toLowerCase()}`;
        continue;
      }
      git("fetch", "--quiet", "upstream", `pull/${entry.pr}/head`);
      entry.newTip = git("rev-parse", "FETCH_HEAD");
      continue;
    }
    const parent = parentOf(entry, entries);
    const base = parent?.newTip ?? upstreamMain;
    git("switch", "--quiet", "--force-create", entry.branch, entry.oldTip);
    // A stacked topic sits on its parent's previous tip; move only its own commits.
    const oldBase = parent ? git("merge-base", entry.oldTip, parent.oldTip) : undefined;
    const rebase = exec("git", oldBase ? ["rebase", "--onto", base, oldBase] : ["rebase", base], {
      env: { ...env, GIT_EDITOR: "true" },
    });
    if (!rebase.ok) finishInProgress("rebase", `rebasing ${entry.branch}`);
    entry.newTip = git("rev-parse", "HEAD");
    if (entry.newTip === base) entry.dropped = "all of its commits are upstream";
  }

  git("switch", "--quiet", "--force-create", INTEGRATION, upstreamMain);
  for (const entry of entries) {
    if (entry.dropped || !entry.newTip) continue;
    const merge = exec("git", ["merge", "--no-ff", "--no-edit", "-m", `fork: merge ${entry.branch}`, entry.newTip]);
    if (!merge.ok) finishInProgress("merge", `merging ${entry.branch}`);
  }

  step("vp", ["install"]);
  check();

  for (const entry of entries) {
    if (entry.dropped) report.push(`drop ${entry.branch}: ${entry.dropped}`);
    else if (entry.newTip !== entry.oldTip) report.push(`update ${entry.branch}`);
  }
  report.push(`${INTEGRATION} = upstream ${upstreamMain.slice(0, 10)} + ${entries.filter((e) => !e.dropped).length} branches`);
  if (dryRun) return;

  pushed = true;
  for (const entry of entries) {
    if (entry.dropped) git("push", "--quiet", "origin", "--delete", entry.branch);
    else if (entry.newTip !== entry.oldTip)
      git("push", "--quiet", `--force-with-lease=${entry.branch}:${entry.oldTip}`, "origin", `${entry.newTip}:refs/heads/${entry.branch}`);
  }
  git("push", "--quiet", "--force", "origin", INTEGRATION);

  const build = spawnSync("node", ["scripts/build-desktop-artifact.ts", "--platform", "mac", "--target", "dmg"], {
    cwd: REPO,
    stdio: "inherit",
    env: { ...env, T3CODE_DESKTOP_APP_ID: APP_ID, T3CODE_DESKTOP_PRODUCT_NAME: PRODUCT_NAME },
  });
  if (build.status !== 0) fail("desktop build failed");
  report.push(`built ${newestDmg()}; run \`node fork-sync.ts install\` to install it`);
}

function check() {
  const result = spawnSync("node", ["scripts/check-changed.ts", "upstream/main"], { cwd: REPO, env, encoding: "utf8" });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status === 0) return;
  const output = `${result.stdout}\n${result.stderr}`;
  const failedSteps = [...output.matchAll(/^\s+FAIL\s+([a-z:]+)/gm)].map((match) => match[1]);
  if (failedSteps.some((name) => name !== "test")) fail(`checks failed: ${failedSteps.join(", ")}`);
  const failedTests = [...new Set([...output.matchAll(/^\s*FAIL\s+(?:\|[^|]+\|\s+)?(\S+ > .+)$/gm)].map((match) => match[1].trim()))];
  const known = readFileSync(new URL("known-test-failures.txt", import.meta.url), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const unknown = failedTests.filter((test) => !known.some((entry) => test.includes(entry)));
  if (failedTests.length === 0 || unknown.length > 0)
    fail(`tests failed:\n  ${(unknown.length > 0 ? unknown : ["(couldn't read failing tests)"]).join("\n  ")}`);
  report.push(`ignored ${failedTests.length} known test failure(s)`);
}

function newestDmg(): string {
  const dir = join(REPO, "release");
  const dmgs = existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".dmg")) : [];
  if (dmgs.length === 0) fail(`no .dmg in ${dir}`);
  return join(dir, dmgs.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)[0]);
}

const isRunning = (bundleId: string) =>
  exec("osascript", ["-e", `application id "${bundleId}" is running`]).out === "true";

function install() {
  const dmg = newestDmg();
  if (isRunning(OFFICIAL_APP_ID)) fail("Quit T3 Code first; both apps share one data folder and one instance lock.");
  if (isRunning(APP_ID)) {
    exec("osascript", ["-e", `tell application id "${APP_ID}" to quit`]);
    for (let i = 0; i < 30 && isRunning(APP_ID); i++) spawnSync("sleep", ["1"]);
    if (isRunning(APP_ID)) fail(`${PRODUCT_NAME} didn't quit`);
  }
  const mountPoint = mkdtempSync(join(tmpdir(), "t3-marc-install-"));
  step("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmg]);
  try {
    const app = readdirSync(mountPoint).find((file) => file.endsWith(".app"));
    if (!app) fail(`no .app in ${dmg}`);
    step("rm", ["-rf", INSTALL_PATH]);
    step("ditto", [join(mountPoint, app!), INSTALL_PATH]);
  } finally {
    spawnSync("hdiutil", ["detach", "-quiet", mountPoint]);
    rmSync(mountPoint, { recursive: true, force: true });
  }
  report.push(`installed ${dmg} to ${INSTALL_PATH}`);
  spawnSync("open", [INSTALL_PATH]);
}

try {
  if (args[0] === "install") install();
  else sync();
  console.log(`\nfork-sync: ok\n${report.map((line) => `- ${line}`).join("\n")}`);
} catch (error) {
  if (!(error instanceof SyncError)) throw error;
  console.error(`\nfork-sync: FAILED\n${error.message}\n${report.map((line) => `- ${line}`).join("\n")}`);
  console.error(pushed ? "Branches were pushed before the failure." : "Nothing was pushed or installed.");
  process.exit(1);
}
