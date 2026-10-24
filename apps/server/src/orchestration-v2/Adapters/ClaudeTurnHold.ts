import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import type { ProviderTurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/**
 * A hold must never reach its matcher timeout: Claude Code (2.1.310) crashes the session when a
 * `PostToolBatch` hook times out, and ends the turn without the answer for `Stop`. So the hooks
 * get a timeout far past any hold (T3 gives up waiting and releases long before), within what a
 * timer can take (setTimeout overflows past about 24.8 days).
 */
export const CLAUDE_TURN_HOLD_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;

type HoldState =
  | { readonly _tag: "idle" }
  | {
      readonly _tag: "armed";
      readonly providerTurnId: ProviderTurnId;
      readonly paused: (outcome: "paused" | "turn_ended") => void;
    }
  | {
      readonly _tag: "held";
      readonly providerTurnId: ProviderTurnId;
      readonly resume: (context: string | undefined) => void;
    };

export interface ClaudeTurnHold {
  /**
   * Registered with every query: they fire where Claude takes a steered message, after a tool
   * batch before its next model request (`PostToolBatch`) and before it ends its turn (`Stop`).
   * They answer at once unless a pause is armed.
   */
  readonly hooks: Partial<Record<HookEvent, Array<HookCallbackMatcher>>>;
  /** Waits for the turn's next steering window. Interrupting it gives the hold up. */
  readonly pause: (providerTurnId: ProviderTurnId) => Effect.Effect<"paused" | "turn_ended">;
  /** Lets a held turn continue, with `context` added for its next model request. */
  readonly release: (
    providerTurnId: ProviderTurnId,
    context: string | undefined,
  ) => Effect.Effect<boolean>;
  readonly turnEnded: (providerTurnId: ProviderTurnId) => Effect.Effect<void>;
}

/**
 * Holds a Claude session's active turn at a steering window through SDK hooks, which run in every
 * permission mode. One session runs one turn at a time, so one hold serves it; hooks that fire
 * inside a subagent never hold.
 */
export function makeClaudeTurnHold(): ClaudeTurnHold {
  let state: HoldState = { _tag: "idle" };

  const hook: HookCallback = async (input, _toolUseId, { signal }): Promise<HookJSONOutput> => {
    const armed = state;
    const event = input.hook_event_name;
    if (
      armed._tag !== "armed" ||
      input.agent_id !== undefined ||
      (event !== "PostToolBatch" && event !== "Stop")
    ) {
      return {};
    }
    const context = await new Promise<string | undefined>((resolve) => {
      const onAbort = () => {
        if (state._tag === "held" && state.resume === finish) state = { _tag: "idle" };
        resolve(undefined);
      };
      const finish = (value: string | undefined) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      state = { _tag: "held", providerTurnId: armed.providerTurnId, resume: finish };
      signal.addEventListener("abort", onAbort, { once: true });
      armed.paused("paused");
      if (signal.aborted) onAbort();
    });
    if (context === undefined || context.length === 0) return {};
    return {
      hookSpecificOutput:
        event === "Stop"
          ? { hookEventName: "Stop", additionalContext: context }
          : { hookEventName: "PostToolBatch", additionalContext: context },
    };
  };

  const matchers = [{ hooks: [hook], timeout: CLAUDE_TURN_HOLD_TIMEOUT_SECONDS }];

  const release = (providerTurnId: ProviderTurnId, context: string | undefined) =>
    Effect.sync(() => {
      const current = state;
      if (current._tag !== "held" || current.providerTurnId !== providerTurnId) return false;
      state = { _tag: "idle" };
      current.resume(context);
      return true;
    });

  return {
    hooks: { PostToolBatch: matchers, Stop: matchers },
    pause: (providerTurnId) =>
      Effect.callback<"paused" | "turn_ended">((resume) => {
        const current = state;
        if (current._tag === "held" && current.providerTurnId === providerTurnId) {
          resume(Effect.succeed("paused"));
          return;
        }
        state = {
          _tag: "armed",
          providerTurnId,
          paused: (outcome) => resume(Effect.succeed(outcome)),
        };
        return Effect.sync(() => {
          const now = state;
          if (now._tag === "armed" && now.providerTurnId === providerTurnId) {
            state = { _tag: "idle" };
          } else if (now._tag === "held" && now.providerTurnId === providerTurnId) {
            state = { _tag: "idle" };
            now.resume(undefined);
          }
        });
      }),
    release,
    turnEnded: (providerTurnId) =>
      Effect.sync(() => {
        const current = state;
        if (current._tag === "idle" || current.providerTurnId !== providerTurnId) return;
        state = { _tag: "idle" };
        if (current._tag === "armed") current.paused("turn_ended");
        else current.resume(undefined);
      }),
  };
}
