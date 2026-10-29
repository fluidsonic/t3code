import { describe, expect, it } from "vite-plus/test";

import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

describe("queued run delivery order", () => {
  it("keeps automatic completion delivery ahead of visible queued messages", () => {
    const projection = {
      thread: {},
      messages: [
        { id: "message:visible-first" },
        {
          id: "message:automatic",
          delegatedCompletion: {
            generation: 1,
            parentRunId: "run:parent",
            taskIds: ["task:child"],
          },
        },
        { id: "message:visible-second" },
      ],
      runs: [
        {
          id: "run:visible-first",
          ordinal: 2,
          queuePosition: 1,
          status: "queued",
          userMessageId: "message:visible-first",
        },
        {
          id: "run:automatic",
          ordinal: 4,
          queuePosition: 3,
          status: "queued",
          userMessageId: "message:automatic",
        },
        {
          id: "run:visible-second",
          ordinal: 3,
          queuePosition: 2,
          status: "queued",
          userMessageId: "message:visible-second",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:automatic",
      "run:visible-first",
      "run:visible-second",
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
          status: "queued",
          userMessageId: "message:queued",
        },
        {
          id: "run:automatic",
          ordinal: 3,
          queuePosition: 2,
          status: "queued",
          userMessageId: "message:automatic",
        },
        {
          id: "run:steer",
          ordinal: 4,
          queuePosition: 3,
          status: "queued",
          userMessageId: "message:steer",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:steer",
      "run:automatic",
      "run:queued",
    ]);
  });
});
