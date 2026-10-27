#!/usr/bin/env node
// Rebuilds `fluidsonic/main` from upstream main plus every `fork/<order>-<name>` branch on origin,
// then builds "T3 Code (Marc).app" and publishes it to a local update feed the app updates from.
//
//   node fork-sync.ts              sync, check, push, build, publish to the feed
//   node fork-sync.ts --dry-run    sync and check only; push and build nothing
//   node fork-sync.ts install      install the newest feed build now, quitting and reopening the app
//   node fork-sync.ts serve        serve the feed on 127.0.0.1; the LaunchAgent keeps this running
//
// Branch scheme (the branch list is the source of truth):
//   fork/10-pr-20145       tracks upstream PR #20145; dropped once the PR is merged or closed
//   fork/10.1-<name>       stacked on fork/10-*; rebased onto it on every sync
//   fork/20-<name>         based on upstream main
// Orders sort numerically per segment. A topic whose commits all landed upstream is deleted.
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const REPO = process.env.T3_FORK_REPO ?? join(process.env.HOME ?? "", "Documents/t3-code-fork");
const UPSTREAM_REPO = "pingdotgg/t3code";
const FORK_REPO = "fluidsonic/t3code";
const INTEGRATION = "fluidsonic/main";
const MAIN_CHECKOUT = join(process.env.HOME ?? "", "Documents/t3-code");
// Local `main` in MAIN_CHECKOUT carries this commit on top of upstream; it never belongs in a topic.
const NOTES_SUBJECT = "fork: agent notes";
const APP_ID = "com.fluidsonic.t3marc";
const PRODUCT_NAME = "T3 Code (Marc)";
const OFFICIAL_APP_ID = "com.t3tools.t3code";
const INSTALL_PATH = `/Applications/${PRODUCT_NAME}.app`;
const LEGACY_INSTALL_PATHS = ["/Applications/T3 Marc.app"];
const META = new URL(".", import.meta.url).pathname;
const FEED_DIR = join(META, "feed");
const FEED_PORT = 47825;
// The app's updater (Squirrel.Mac) accepts only builds matching the running app's designated
// requirement; ad-hoc signatures never match, so every build is signed with one local identity.
const SIGNING_KEYCHAIN = join(META, "signing.keychain-db");
const SIGNING_NAME = "T3 Code Marc Local Signing";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const report: string[] = [];
let pushed = false;
// Homebrew installs rustup keg-only; the desktop build needs cargo. T3 Code sets ELECTRON_RUN_AS_NODE
// for agents, which would leak into the build's Electron probes.
const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...inheritedEnv } = process.env;
const env = { ...inheritedEnv, PATH: `${join(REPO, "node_modules/.bin")}:/opt/homebrew/opt/rustup/bin:${process.env.PATH}` };

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
  updateMainCheckout();
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
    stripNotes(entry.branch, base);
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

  publish(build());
  if (isRunning(APP_ID)) report.push(`${PRODUCT_NAME} offers the update to restart into within a few minutes`);
  else copyApp(newestFeedZip());
}

function stripNotes(branch: string, base: string) {
  for (;;) {
    const notes = git("log", "--format=%H", "--fixed-strings", `--grep=${NOTES_SUBJECT}`, `${base}..HEAD`)
      .split("\n")
      .find((sha) => sha && git("log", "-1", "--format=%s", sha) === NOTES_SUBJECT);
    if (!notes) return;
    const rebase = exec("git", ["rebase", "--onto", `${notes}^`, notes], { env: { ...env, GIT_EDITOR: "true" } });
    if (!rebase.ok) finishInProgress("rebase", `removing the notes commit from ${branch}`);
    report.push(`${branch}: removed the "${NOTES_SUBJECT}" commit`);
  }
}

function updateMainCheckout() {
  const inMain = (...argv: string[]) => exec("git", ["-C", MAIN_CHECKOUT, ...argv]);
  if (inMain("branch", "--show-current").out !== "main") return report.push(`${MAIN_CHECKOUT} isn't on main; left as is`);
  if (inMain("status", "--porcelain", "--untracked-files=no").out) return report.push(`${MAIN_CHECKOUT} has uncommitted changes; main left as is`);
  if (inMain("merge-base", "--is-ancestor", "upstream/main", "HEAD").ok) return;
  if (!inMain("rebase", "upstream/main").ok) {
    inMain("rebase", "--abort");
    return report.push(`couldn't rebase ${MAIN_CHECKOUT} main onto upstream; left as is`);
  }
  report.push(`${MAIN_CHECKOUT} main rebased onto upstream`);
}

function check() {
  // A React Compiler bailout still builds but can crash the app (an unmemoized ChatView loops), and
  // check-changed only runs this test when it sits beside a change.
  const compiled = spawnSync("vp", ["test", "run", "src/reactCompilerCoverage.test.ts"], { cwd: join(REPO, "apps/web"), env, encoding: "utf8" });
  if (compiled.status !== 0) {
    process.stdout.write(compiled.stdout ?? "");
    fail("the React Compiler skips a web file; see the reactCompilerCoverage test output above");
  }
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

/** Builds and signs the app; every build gets a newer version so the updater offers it. */
function build(): { app: string; version: string } {
  const base = JSON.parse(readFileSync(join(REPO, "apps/server/package.json"), "utf8")).version.split("-")[0];
  const version = `${base}-marc.${new Date().toISOString().replace(/\D/g, "").slice(0, 12)}`;
  rmSync(join(REPO, "release"), { recursive: true, force: true });
  const result = spawnSync("node", ["scripts/build-desktop-artifact.ts", "--platform", "mac", "--target", "zip"], {
    cwd: REPO,
    stdio: "inherit",
    env: { ...env, T3CODE_DESKTOP_APP_ID: APP_ID, T3CODE_DESKTOP_PRODUCT_NAME: PRODUCT_NAME, T3CODE_DESKTOP_VERSION: version },
  });
  if (result.status !== 0) fail("desktop build failed");
  // The build keeps only the zip; unpack it to add the feed and sign.
  const built = readdirSync(join(REPO, "release")).find((file) => file.endsWith(".zip"));
  if (!built) fail(`no .zip in ${join(REPO, "release")}`);
  const unpacked = join(REPO, "release", "unpacked");
  step("ditto", ["-x", "-k", join(REPO, "release", built!), unpacked]);
  const app = join(unpacked, `${PRODUCT_NAME}.app`);
  if (!existsSync(app)) fail(`no ${PRODUCT_NAME}.app in ${built}`);
  writeFileSync(
    join(app, "Contents/Resources/app-update.yml"),
    `provider: generic\nurl: http://127.0.0.1:${FEED_PORT}\nupdaterCacheDirName: t3code-marc-updater\n`,
  );
  step("codesign", ["--force", "--deep", "--keychain", SIGNING_KEYCHAIN, "--sign", signingIdentity(), app]);
  return { app, version };
}

/** Creates the local signing identity on first use; it must stay the same across builds. */
function signingIdentity(): string {
  if (!existsSync(SIGNING_KEYCHAIN)) {
    const dir = mkdtempSync(join(tmpdir(), "t3-marc-signing-"));
    try {
      const openssl = existsSync("/opt/homebrew/bin/openssl") ? "/opt/homebrew/bin/openssl" : "openssl";
      step(openssl, [
        "req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "36500", "-subj", `/CN=${SIGNING_NAME}`,
        "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
        "-addext", "basicConstraints=critical,CA:false",
        "-addext", "keyUsage=critical,digitalSignature",
        "-addext", "extendedKeyUsage=critical,codeSigning",
      ]);
      step(openssl, ["pkcs12", "-export", "-legacy", "-inkey", join(dir, "key.pem"), "-in", join(dir, "cert.pem"), "-out", join(dir, "id.p12"), "-passout", "pass:t3marc"]);
      step("security", ["create-keychain", "-p", "", SIGNING_KEYCHAIN]);
      step("security", ["set-keychain-settings", SIGNING_KEYCHAIN]);
      step("security", ["unlock-keychain", "-p", "", SIGNING_KEYCHAIN]);
      step("security", ["import", join(dir, "id.p12"), "-k", SIGNING_KEYCHAIN, "-P", "t3marc", "-T", "/usr/bin/codesign"]);
      exec("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", "", SIGNING_KEYCHAIN]);
      report.push(`created the signing identity in ${SIGNING_KEYCHAIN}; install once by hand to switch to it`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  exec("security", ["unlock-keychain", "-p", "", SIGNING_KEYCHAIN]);
  const identity = /\b([0-9A-F]{40})\b/.exec(exec("security", ["find-identity", "-p", "codesigning", SIGNING_KEYCHAIN]).out)?.[1];
  return identity ?? fail(`no signing identity in ${SIGNING_KEYCHAIN}`);
}

/** Zips the app into the feed and points latest-mac.yml at it, keeping the previous build. */
function publish({ app, version }: { app: string; version: string }) {
  mkdirSync(FEED_DIR, { recursive: true });
  const zipName = `T3-Code-Marc-${version}-${process.arch}.zip`;
  const zip = join(FEED_DIR, zipName);
  step("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
  const sha512 = createHash("sha512").update(readFileSync(zip)).digest("base64");
  const size = statSync(zip).size;
  writeFileSync(
    join(FEED_DIR, "latest-mac.yml"),
    `version: ${version}\nfiles:\n  - url: ${zipName}\n    sha512: ${sha512}\n    size: ${size}\npath: ${zipName}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`,
  );
  for (const old of feedZips().slice(2)) rmSync(join(FEED_DIR, old));
  report.push(`published ${version} to ${zip}`);
}

const feedZips = () =>
  existsSync(FEED_DIR)
    ? readdirSync(FEED_DIR)
        .filter((file) => file.endsWith(".zip"))
        .sort((a, b) => statSync(join(FEED_DIR, b)).mtimeMs - statSync(join(FEED_DIR, a)).mtimeMs)
    : [];

function newestFeedZip(): string {
  const zip = feedZips()[0];
  return zip ? join(FEED_DIR, zip) : fail(`no build in ${FEED_DIR} yet`);
}

const isRunning = (bundleId: string) =>
  exec("osascript", ["-e", `application id "${bundleId}" is running`]).out === "true";

function install() {
  const zip = newestFeedZip();
  if (isRunning(OFFICIAL_APP_ID)) fail("Quit T3 Code first; both apps share one data folder and one instance lock.");
  if (isRunning(APP_ID)) {
    exec("osascript", ["-e", `tell application id "${APP_ID}" to quit`]);
    for (let i = 0; i < 30 && isRunning(APP_ID); i++) spawnSync("sleep", ["1"]);
    if (isRunning(APP_ID)) fail(`${PRODUCT_NAME} didn't quit`);
  }
  copyApp(zip);
  spawnSync("open", [INSTALL_PATH]);
}

function copyApp(zip: string) {
  const dir = mkdtempSync(join(tmpdir(), "t3-marc-install-"));
  try {
    step("ditto", ["-x", "-k", zip, dir]);
    step("rm", ["-rf", INSTALL_PATH]);
    step("ditto", [join(dir, `${PRODUCT_NAME}.app`), INSTALL_PATH]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  report.push(`installed ${basename(zip)} to ${INSTALL_PATH}`);
  for (const legacy of LEGACY_INSTALL_PATHS) {
    if (!existsSync(legacy)) continue;
    const id = exec("defaults", ["read", join(legacy, "Contents/Info"), "CFBundleIdentifier"]).out;
    if (id !== APP_ID) continue;
    step("rm", ["-rf", legacy]);
    report.push(`removed ${legacy}`);
  }
}

/** Serves the feed's files to the app's updater; loopback only. */
function serve() {
  createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname.slice(1));
    const file = join(FEED_DIR, name);
    if (request.method !== "GET" || !name || name !== basename(name) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Length": statSync(file).size, "Cache-Control": "no-store" });
    createReadStream(file).pipe(response);
  }).listen(FEED_PORT, "127.0.0.1", () => console.log(`serving ${FEED_DIR} on http://127.0.0.1:${FEED_PORT}`));
}

try {
  // The retired com.fluidsonic.t3marc.install LaunchAgent still calls `install --auto` until unloaded.
  if (args.includes("--auto")) process.exit(0);
  if (args[0] === "serve") serve();
  else {
    if (args[0] === "install") install();
    else sync();
    console.log(`\nfork-sync: ok\n${report.map((line) => `- ${line}`).join("\n")}`);
  }
} catch (error) {
  if (!(error instanceof SyncError)) throw error;
  console.error(`\nfork-sync: FAILED\n${error.message}\n${report.map((line) => `- ${line}`).join("\n")}`);
  console.error(pushed ? "Branches were pushed before the failure." : "Nothing was pushed or installed.");
  process.exit(1);
}
