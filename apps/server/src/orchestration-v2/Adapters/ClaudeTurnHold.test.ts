import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { ProviderTurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { CLAUDE_TURN_HOLD_TIMEOUT_SECONDS, makeClaudeTurnHold } from "./ClaudeTurnHold.ts";

const turn = ProviderTurnId.make("provider-turn:claude");

const base = { session_id: "session", transcript_path: "/tmp/transcript", cwd: "/tmp" };
const postToolBatch: HookInput = { ...base, hook_event_name: "PostToolBatch", tool_calls: [] };
const stop: HookInput = { ...base, hook_event_name: "Stop", stop_hook_active: false };

const hookFor = (hold: ReturnType<typeof makeClaudeTurnHold>, event: "PostToolBatch" | "Stop") => {
  const matcher = hold.hooks[event]?.[0];
  assert.equal(matcher?.timeout, CLAUDE_TURN_HOLD_TIMEOUT_SECONDS);
  return matcher!.hooks[0]! satisfies HookCallback;
};

const fire = (hook: HookCallback, input: HookInput, signal = new AbortController().signal) =>
  Effect.promise(() => hook(input, undefined, { signal }));

describe("makeClaudeTurnHold", () => {
  it.effect("lets Claude continue at once while no pause is armed", () =>
    Effect.gen(function* () {
      const hold = makeClaudeTurnHold();
      assert.deepEqual(yield* fire(hookFor(hold, "PostToolBatch"), postToolBatch), {});
      assert.isFalse(yield* hold.release(turn, "late"));
    }),
  );

  it.effect("holds at the next window and continues with the released context", () =>
    Effect.gen(function* () {
      const hold = makeClaudeTurnHold();
      const pause = yield* hold.pause(turn).pipe(Effect.forkChild({ startImmediately: true }));
      // A subagent's tool batch is not the turn's steering window.
      assert.deepEqual(
        yield* fire(hookFor(hold, "PostToolBatch"), { ...postToolBatch, agent_id: "agent" }),
        {},
      );
      const answer = yield* fire(hookFor(hold, "PostToolBatch"), postToolBatch).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      assert.equal(yield* Fiber.join(pause), "paused");
      assert.isTrue(yield* hold.release(turn, "<user_shell_command>ls</user_shell_command>"));
      assert.deepEqual(yield* Fiber.join(answer), {
        hookSpecificOutput: {
          hookEventName: "PostToolBatch",
          additionalContext: "<user_shell_command>ls</user_shell_command>",
        },
      });
      assert.isFalse(yield* hold.release(turn, "again"));
    }),
  );

  it.effect("a Stop window continues the turn only with something to say", () =>
    Effect.gen(function* () {
      const hold = makeClaudeTurnHold();
      const pause = yield* hold.pause(turn).pipe(Effect.forkChild({ startImmediately: true }));
      const answer = yield* fire(hookFor(hold, "Stop"), stop).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      assert.equal(yield* Fiber.join(pause), "paused");
      assert.isTrue(yield* hold.release(turn, undefined));
      assert.deepEqual(yield* Fiber.join(answer), {});
    }),
  );

  it.effect("reports a turn that ends before its window, and frees one held at its end", () =>
    Effect.gen(function* () {
      const hold = makeClaudeTurnHold();
      const pause = yield* hold.pause(turn).pipe(Effect.forkChild({ startImmediately: true }));
      yield* hold.turnEnded(turn);
      assert.equal(yield* Fiber.join(pause), "turn_ended");
      assert.deepEqual(yield* fire(hookFor(hold, "Stop"), stop), {});

      const again = yield* hold.pause(turn).pipe(Effect.forkChild({ startImmediately: true }));
      const answer = yield* fire(hookFor(hold, "Stop"), stop).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      assert.equal(yield* Fiber.join(again), "paused");
      yield* hold.turnEnded(turn);
      assert.deepEqual(yield* Fiber.join(answer), {});
    }),
  );

  it.effect("giving up the wait disarms the hold, and an aborted hook frees it", () =>
    Effect.gen(function* () {
      const hold = makeClaudeTurnHold();
      const pause = yield* hold.pause(turn).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(pause);
      assert.deepEqual(yield* fire(hookFor(hold, "PostToolBatch"), postToolBatch), {});

      const again = yield* hold.pause(turn).pipe(Effect.forkChild({ startImmediately: true }));
      // @effect-diagnostics-next-line abortControllerInEffect:off - Claude aborts the hook on its own, apart from the test fiber.
      const abort = new AbortController();
      const answer = yield* fire(hookFor(hold, "PostToolBatch"), postToolBatch, abort.signal).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      assert.equal(yield* Fiber.join(again), "paused");
      // Claude gave up on the hook (its timeout, an interrupt): the result can no longer land.
      abort.abort();
      assert.deepEqual(yield* Fiber.join(answer), {});
      assert.isFalse(yield* hold.release(turn, "too late"));
    }),
  );
});
