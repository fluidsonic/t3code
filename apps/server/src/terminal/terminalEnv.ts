import { stripAppImageRuntimeEnv } from "@t3tools/shared/appImageRuntimeEnv";

// The tmux/screen/Zellij keys name the multiplexer pane that launched the server,
// so inheriting them points multiplexer-aware tools at that unrelated pane.
const TERMINAL_ENV_BLOCKLIST = new Set([
  "PORT",
  "ELECTRON_RENDERER_PORT",
  "ELECTRON_RUN_AS_NODE",
  "TMUX",
  "TMUX_PANE",
  "STY",
  "WINDOW",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
]);

function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("T3CODE_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

/** The server's environment without the keys that belong to the server process itself. */
export function withoutServerEnvKeys(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    env[key] = value;
  }
  return env;
}

/** The environment a command the user runs inherits, as the integrated terminal gets it. */
export function inheritedShellEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return stripAppImageRuntimeEnv(withoutServerEnvKeys(baseEnv));
}
