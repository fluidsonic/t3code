import {
  type LiveUserShellCommand,
  liveUserShellCommands,
  type UserShellCommandStatus,
  userShellCommandAnnouncement,
  userShellCommandIsActive,
  userShellCommandModeNote,
  userShellCommandOutcomeLine,
  userShellCommandPresentation,
} from "@t3tools/client-runtime/user-shell-command";
import { shellCommandFromMessageText } from "@t3tools/shared/shellCommand";
import { AuthTerminalOperateScope, type EnvironmentId, type TurnItemId } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  CircleXIcon,
  ClockIcon,
  SquareIcon,
} from "lucide-react";
import { useId, useState } from "react";

import type { ComposerThreadTarget } from "../../composerDraftStore";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ChatMessage } from "../../types";
import { cn } from "~/lib/utils";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  CommandOutputPanel,
  CommandOutputText,
  useCommandOutputStreaming,
} from "./CommandOutputPanel";
import { ComposerBanner } from "./ComposerBanner";
import { ShellCommandText } from "./ShellCommandText";

const NO_COMMANDS: ReadonlyArray<LiveUserShellCommand> = [];

/**
 * A running command was stopped; it goes back to the person, at `target`, the composer it was
 * stopped from. The view can show another thread's composer by the time the stop settles.
 */
export type StoppedRunningCommandHandler = (
  command: string,
  itemId: TurnItemId,
  target: ComposerThreadTarget,
) => void;

/** What `ShellCommandsControl` shows: live commands, then sends the server doesn't have yet. */
export function shellCommandRows(
  projection: Parameters<typeof liveUserShellCommands>[0] | null,
  optimisticMessages: ReadonlyArray<
    Pick<ChatMessage, "id" | "text" | "shellCommand" | "inputIntent">
  >,
) {
  const commands = projection ? liveUserShellCommands(projection) : NO_COMMANDS;
  // A queued command waits with the queued messages instead.
  const sending = optimisticMessages.filter(
    (message) =>
      message.shellCommand === true &&
      message.inputIntent !== "queued_turn" &&
      !projection?.messages.some((candidate) => candidate.id === message.id) &&
      !commands.some((command) => command.userShellMessageId === message.id),
  );
  return { commands, sending };
}

/**
 * A thread's `! cmd` commands until their results reach the agent, at the end of the timeline
 * where queued messages wait. Delivered, a command moves into the transcript; stopped, it is gone.
 * A command just sent waits here until the server has it.
 */
export function ShellCommandsControl(props: {
  readonly environmentId: EnvironmentId;
  readonly rows: ReturnType<typeof shellCommandRows>;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly onStoppedRunningCommand: StoppedRunningCommandHandler;
}) {
  const { commands, sending } = props.rows;
  const count = commands.length + sending.length;
  if (count === 0) return null;
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        role="region"
        aria-label={`${count} shell command${count === 1 ? "" : "s"}`}
        className="relative z-0"
      >
        <ComposerBanner.Scroll className="max-h-80">
          <ComposerBanner.Children render={<ol />}>
            {commands.map((item) => (
              <ShellCommandRow
                key={item.id}
                environmentId={props.environmentId}
                item={item}
                composerDraftTarget={props.composerDraftTarget}
                onStoppedRunningCommand={props.onStoppedRunningCommand}
              />
            ))}
            {sending.map((message) => (
              <li key={message.id} className="grid" data-user-shell-command="waiting">
                <ComposerBanner.Row>
                  <ComposerBanner.Icon>
                    <ClockIcon />
                  </ComposerBanner.Icon>
                  <ComposerBanner.Content className="text-foreground/80">
                    <span className="min-w-0 flex-1 truncate">
                      <ShellCommandText command={shellCommandFromMessageText(message.text)} />
                    </span>
                    <span className="shrink-0 text-muted-foreground">Waiting…</span>
                  </ComposerBanner.Content>
                </ComposerBanner.Row>
              </li>
            ))}
          </ComposerBanner.Children>
        </ComposerBanner.Scroll>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

/**
 * Reads out commands starting and finishing. Mounted apart from the panel, which leaves with its
 * last command: a command's result is read out while it leaves for the transcript.
 */
export function ShellCommandsAnnouncer(props: {
  readonly commands: ReadonlyArray<LiveUserShellCommand>;
}) {
  return (
    <span role="status" className="sr-only">
      {useShellCommandAnnouncement(props.commands)}
    </span>
  );
}

/**
 * The latest start or end among commands seen while shown; one already running when it appears
 * isn't announced.
 */
function useShellCommandAnnouncement(commands: ReadonlyArray<LiveUserShellCommand>): string {
  const statuses = commands.map(
    (command) => [command.id, userShellCommandPresentation(command)] as const,
  );
  const key = statuses.map(([id, presentation]) => `${id}:${presentation.status}`).join("\n");
  const [seen, setSeen] = useState(() => ({
    key,
    statuses: new Map<string, UserShellCommandStatus>(
      statuses.map(([id, presentation]) => [id, presentation.status]),
    ),
    text: "",
  }));
  if (seen.key !== key) {
    const texts: string[] = [];
    for (const [id, presentation] of statuses) {
      const previous = seen.statuses.get(id);
      // A command skipped after an earlier one failed first appears skipped.
      if (previous === undefined && presentation.status !== "skipped") continue;
      const announcement = userShellCommandAnnouncement(previous ?? null, presentation);
      if (announcement !== null) texts.push(announcement);
    }
    const text = texts.length === 0 ? seen.text : texts.join(". ");
    setSeen({
      key,
      statuses: new Map(statuses.map(([id, presentation]) => [id, presentation.status])),
      text,
    });
  }
  return seen.text;
}

function ShellCommandRow(props: {
  readonly environmentId: EnvironmentId;
  readonly item: LiveUserShellCommand;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly onStoppedRunningCommand: StoppedRunningCommandHandler;
}) {
  const { item } = props;
  const presentation = userShellCommandPresentation(item);
  const active = userShellCommandIsActive(presentation.status);
  const streamsOutput = useCommandOutputStreaming(props.environmentId);
  const canStop = useEnvironmentScope(props.environmentId, AuthTerminalOperateScope);
  const stopCommand = useAtomCommand(threadEnvironment.stopUserShellCommand);
  const [stopping, setStopping] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const outputId = useId();
  const outcomeLine = userShellCommandOutcomeLine(presentation);
  const modeNote = userShellCommandModeNote(item);

  const stop = () => {
    const wasRunning = presentation.status === "running";
    const target = props.composerDraftTarget;
    setStopping(true);
    void stopCommand({
      environmentId: props.environmentId,
      input: { threadId: item.threadId, turnItemId: item.id },
    }).then((outcome) => {
      if (outcome._tag === "Failure") {
        setStopping(false);
        return;
      }
      // A command that never ran is removed like a cancelled queued message.
      if (wasRunning) props.onStoppedRunningCommand(item.input, item.id, target);
    });
  };

  return (
    <li className="grid" data-user-shell-command={presentation.status}>
      <ComposerBanner.Row>
        <ComposerBanner.Icon>
          {presentation.status === "running" ? (
            <Spinner size="sm" tone="muted" />
          ) : presentation.status === "waiting" ? (
            <ClockIcon />
          ) : presentation.status === "failed" ? (
            <CircleXIcon className="text-destructive" />
          ) : presentation.status === "skipped" ? (
            <CircleSlashIcon />
          ) : (
            <CircleCheckIcon className="text-success-foreground" />
          )}
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="text-foreground/80">
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
              <ShellCommandText command={item.input} />
            </TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96 break-words">
              <ShellCommandText command={item.input} />
            </TooltipPopup>
          </Tooltip>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {presentation.summary}
          </span>
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          {/* A skipped command never ran, so it has no output to show. */}
          {presentation.status === "waiting" || presentation.status === "skipped" ? null : (
            <ComposerBanner.Dismiss
              aria-label={expanded ? "Hide output" : "Show output"}
              aria-expanded={expanded}
              aria-controls={outputId}
              onClick={() => setExpanded((value) => !value)}
            >
              <ChevronDownIcon className={cn("size-3.5", expanded && "rotate-180")} />
            </ComposerBanner.Dismiss>
          )}
          {active && canStop && item.awaitsWorkspace !== true ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <ComposerBanner.Dismiss
                    aria-label="Stop command"
                    disabled={stopping}
                    onClick={stop}
                  />
                }
              >
                {stopping ? (
                  <Spinner size="xs" aria-hidden />
                ) : (
                  <SquareIcon aria-hidden className="size-3 fill-current" />
                )}
              </TooltipTrigger>
              <TooltipPopup>Stop command; nothing is sent to the agent</TooltipPopup>
            </Tooltip>
          ) : null}
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      {expanded ? (
        <ComposerBanner.Body className="pb-1">
          <div
            id={outputId}
            className="rounded-lg bg-background/60 p-2 font-mono text-xs whitespace-pre"
          >
            {streamsOutput ? (
              <CommandOutputPanel
                environmentId={props.environmentId}
                threadId={item.threadId}
                itemId={item.id}
                variant="shell"
              />
            ) : item.output ? (
              <CommandOutputText text={item.output} />
            ) : (
              <div className="text-muted-foreground italic">No output.</div>
            )}
            {outcomeLine === null ? null : (
              <div className="mt-1 text-destructive">{outcomeLine}</div>
            )}
          </div>
          {modeNote === null ? null : (
            <p className="mt-1 text-2xs text-muted-foreground">{modeNote}</p>
          )}
        </ComposerBanner.Body>
      ) : null}
    </li>
  );
}
