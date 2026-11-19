import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

const at = (time: string) => DateTime.makeUnsafe(`2026-01-01T${time}Z`);
const delegatedCompletion = {
  generation: 1,
  parentRunId: "run:parent",
  taskIds: ["task:child"],
};

describe("queued run delivery order", () => {
  it("delivers completions and queued messages in request order, keeping manual queue order", () => {
    const projection = {
      thread: {},
      messages: [
        { id: "message:old" },
        { id: "message:moved" },
        { id: "message:earlier-completion", delegatedCompletion },
        { id: "message:later-completion", delegatedCompletion },
      ],
      runs: [
        {
          id: "run:old",
          ordinal: 3,
          queuePosition: 2,
          requestedAt: at("10:00:00"),
          status: "queued",
          userMessageId: "message:old",
        },
        {
          id: "run:moved",
          ordinal: 4,
          queuePosition: 1,
          requestedAt: at("10:02:00"),
          status: "queued",
          userMessageId: "message:moved",
        },
        {
          id: "run:earlier-completion",
          ordinal: 2,
          queuePosition: 3,
          requestedAt: at("09:59:00"),
          status: "queued",
          userMessageId: "message:earlier-completion",
        },
        {
          id: "run:later-completion",
          ordinal: 5,
          queuePosition: 4,
          requestedAt: at("10:03:00"),
          status: "queued",
          userMessageId: "message:later-completion",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:earlier-completion",
      "run:moved",
      "run:old",
      "run:later-completion",
    ]);
  });

  it("puts a steer that waits for shell commands first", () => {
    const projection = {
      thread: { hasShellCommands: true },
      messages: [
        { id: "message:queued" },
        {
          id: "message:automatic",
          delegatedCompletion: { generation: 1, parentRunId: "run:parent", taskIds: ["task"] },
        },
        { id: "message:steer", shellSteer: true },
      ],
      runs: [
        {
          id: "run:queued",
          ordinal: 2,
          queuePosition: 1,
          requestedAt: at("10:00:00"),
          status: "queued",
          userMessageId: "message:queued",
        },
        {
          id: "run:automatic",
          ordinal: 3,
          queuePosition: 2,
          requestedAt: at("10:01:00"),
          status: "queued",
          userMessageId: "message:automatic",
        },
        {
          id: "run:steer",
          ordinal: 4,
          queuePosition: 3,
          requestedAt: at("10:02:00"),
          status: "queued",
          userMessageId: "message:steer",
        },
      ],
    } as never;

    // The steer jumps both queues; the rest keep request order.
    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:steer",
      "run:queued",
      "run:automatic",
    ]);
  });
});
