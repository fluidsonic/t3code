import type { CommandOutputView } from "@t3tools/client-runtime/state/command-output";
import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { TERMINAL_PALETTES, terminalOutputSpans } from "@t3tools/shared/terminalOutput";
import { useLayoutEffect, useRef } from "react";

import { useTheme } from "../../hooks/useTheme";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import type { TurnItemSource } from "./timelineRowContext";
import { cn } from "~/lib/utils";
import { Spinner } from "../ui/spinner";

const FOLLOW_SLACK_PX = 8;

export function useCommandOutputStreaming(environmentId: EnvironmentId): boolean {
  return (
    useServerConfigs().get(environmentId)?.environment.capabilities.commandOutputStreaming === true
  );
}

/**
 * Output of one expanded command row: streams while the command runs, then
 * shows its final output. Mount it only when `useCommandOutputStreaming` holds
 * or a `source` serves the output.
 * It subscribes only while mounted, so collapsed rows and other threads receive nothing.
 */
export function CommandOutputPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  /** A person's `! cmd`: a spinner while loading, and the same 20-line cap as its bubble. */
  readonly variant?: "default" | "shell";
  readonly source?: TurnItemSource["commandOutput"] | undefined;
}) {
  const shell = props.variant === "shell";
  const input = { threadId: props.threadId, itemId: props.itemId };
  const { data, error } = useEnvironmentQuery<CommandOutputView, unknown>(
    props.source
      ? props.source(input)
      : orchestrationEnvironment.v2.commandOutput({ environmentId: props.environmentId, input }),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const text = data?.output.text ?? "";
  const { resolvedTheme } = useTheme();

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && followRef.current) element.scrollTop = element.scrollHeight;
  });

  if (text.length === 0) {
    if (error) return <div className="text-destructive">Couldn&apos;t load output: {error}</div>;
    if (data === null) {
      return shell ? (
        <Spinner size="sm" tone="muted" aria-label="Loading output" />
      ) : (
        <div className="text-muted-foreground italic">Loading output…</div>
      );
    }
    return data.running ? null : <div className="text-muted-foreground italic">No output.</div>;
  }
  return (
    <div>
      {data?.output.truncated ? (
        <div className="text-muted-foreground italic">Earlier output not shown</div>
      ) : null}
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          followRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK_PX;
        }}
        className={cn("overflow-auto text-muted-foreground", shell ? "max-h-[20lh]" : "max-h-80")}
      >
        <TerminalOutputSpans text={text} theme={resolvedTheme} />
      </div>
    </div>
  );
}

function TerminalOutputSpans(props: {
  readonly text: string;
  readonly theme: keyof typeof TERMINAL_PALETTES;
}) {
  const spans = terminalOutputSpans(props.text, TERMINAL_PALETTES[props.theme]);
  return spans.map((span, index) =>
    span.style === null ? (
      span.text
    ) : (
      // Spans never reorder and are rebuilt on each update.
      // oxlint-disable-next-line react/no-array-index-key
      <span key={index} style={span.style}>
        {span.text}
      </span>
    ),
  );
}

/** A `! cmd`'s output the client already holds, colored like the live panel. */
export function CommandOutputText(props: { readonly text: string }) {
  const { resolvedTheme } = useTheme();
  return (
    <div className="max-h-[20lh] overflow-auto text-muted-foreground">
      <TerminalOutputSpans text={props.text} theme={resolvedTheme} />
    </div>
  );
}
