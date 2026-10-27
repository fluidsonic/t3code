import {
  AuthTerminalOperateScope,
  type ChatAttachment,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  type LiveUserShellCommand,
  type UserShellCommandItem,
  userShellCommandAnnouncement,
  userShellCommandIsActive,
  userShellCommandModeNote,
  userShellCommandOutcomeLine,
  userShellCommandOutputView,
  userShellCommandPresentation,
  userShellCommandRunningText,
  userShellCommandStatusText,
} from "@t3tools/client-runtime/user-shell-command";
import { canEditInTerminal } from "@t3tools/shared/projectScripts";
import { TERMINAL_PALETTES, terminalOutputSpans } from "@t3tools/shared/terminalOutput";
import type React from "react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  withTiming,
  type LayoutAnimationFunction,
} from "react-native-reanimated";

import * as SecureStore from "expo-secure-store";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { Sheet } from "../../components/ui/Sheet";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useCommandOutputStreaming } from "./thread-command-output";
import { useVisibleSecondClock } from "./use-visible-second-clock";
import type { CodeBlockShellActions } from "./threadShellCommandPresentation";

// The `!` sits in a square 1.35em wide, then a 0.65em gap, as on the web and in the composer.
// Commands render at text-sm (14px over 19px lines), so the square fills the first line.
const SHELL_TEXT_SIZE = 14;
const SHELL_PREFIX_SIZE = SHELL_TEXT_SIZE * 1.35;
const SHELL_PREFIX_GAP = SHELL_TEXT_SIZE * 0.65;
const SHELL_PREFIX_RADIUS = SHELL_TEXT_SIZE * 0.3;

// Output keeps its terminal layout: 20 lines of text-2xs, then it scrolls.
const OUTPUT_LINE_HEIGHT = 16;
const OUTPUT_MAX_LINES = 20;
// Above the composer the output gets less room.
const PANEL_OUTPUT_MAX_LINES = 10;
// Within this many points of the end still counts as following the output.
const FOLLOW_SLACK = 8;

// Opening or closing the output eases the bubble's width, as on the web. Height changes at once so
// the feed can keep its place, and the right edge stays put while the left one moves. Children lay
// out at their final size, so the bubble reveals them rather than re-wrapping them.
const BUBBLE_RESIZE_TIMING = {
  duration: 180,
  easing: Easing.bezier(0.32, 0.72, 0, 1),
  reduceMotion: ReduceMotion.System,
};
const bubbleWidthTransition: LayoutAnimationFunction = (values) => {
  "worklet";
  return {
    initialValues: {
      originX: values.currentOriginX,
      originY: values.targetOriginY,
      width: values.currentWidth,
      height: values.targetHeight,
    },
    animations: {
      originX: withTiming(values.targetOriginX, BUBBLE_RESIZE_TIMING),
      originY: values.targetOriginY,
      width: withTiming(values.targetWidth, BUBBLE_RESIZE_TIMING),
      height: values.targetHeight,
    },
  };
};

/** The square and gap before a command, scaled with the system text size like the text beside it. */
function useShellPrefixMetrics() {
  const { fontScale } = useWindowDimensions();
  return {
    size: SHELL_PREFIX_SIZE * fontScale,
    gap: SHELL_PREFIX_GAP * fontScale,
    radius: SHELL_PREFIX_RADIUS * fontScale,
  };
}

/**
 * A `! cmd` as the person wrote it, with the `!` in its square. Every line of a multi-line command
 * starts where the first one's text does; the square hangs before it.
 */
export function ShellCommandText(props: {
  readonly command: string;
  /** Layout of the whole line, such as `flex-1`. */
  readonly className?: string;
  /** The command's color; the square keeps its own. */
  readonly textClassName?: string;
  readonly numberOfLines?: number;
  /** Read in place of the command, which alone doesn't say it is one. */
  readonly accessibilityLabel?: string;
}) {
  const prefix = useShellPrefixMetrics();
  return (
    <View
      accessible={props.accessibilityLabel !== undefined}
      accessibilityLabel={props.accessibilityLabel}
      className={cn("flex-row", props.className)}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="items-center justify-center bg-shell-prefix"
        style={{
          width: prefix.size,
          height: prefix.size,
          borderRadius: prefix.radius,
          marginRight: prefix.gap,
        }}
      >
        <Text className="font-mono text-sm font-bold text-shell-prefix-foreground">!</Text>
      </View>
      <Text
        selectable={props.numberOfLines === undefined}
        numberOfLines={props.numberOfLines}
        // `shrink`, not `flex-1`: in a bubble sized to its content, a zero flex basis gives the
        // command no width, so the text wraps and overflows a bubble measured for one line.
        className={cn(
          "min-w-0 shrink ios:font-[family-name:Menlo] android:font-mono text-sm",
          props.textClassName,
        )}
      >
        {props.command}
      </Text>
    </View>
  );
}

const STATUS_ICON = {
  completed: "checkmark.circle",
  failed: "xmark.circle.fill",
  skipped: "slash.circle",
} as const;

const STATUS_TINT = {
  completed: "accent-adaptive-emerald-600-400",
  failed: "accent-danger-foreground",
  skipped: "accent-icon-muted",
} as const;

const SMALL_SPINNER_STYLE = {
  width: 14,
  height: 14,
  transform: Platform.OS === "android" ? undefined : [{ scale: 0.75 }],
};

function SmallSpinner() {
  return (
    <AppActivityIndicator
      size={Platform.OS === "android" ? 14 : "small"}
      colorClassName="accent-icon-muted"
      style={SMALL_SPINNER_STYLE}
    />
  );
}

/** A command's output as the terminal printed it: unwrapped, scrolling both ways past its bounds. */
function ShellCommandOutputText(props: {
  readonly text: string;
  readonly running: boolean;
  readonly themeAppearance: "light" | "dark";
  readonly maxLines?: number;
}) {
  const spans = useMemo(
    () =>
      // A final newline ends the last line; a terminal doesn't show an empty one after it.
      terminalOutputSpans(
        props.text.replace(/\r?\n$/u, ""),
        TERMINAL_PALETTES[props.themeAppearance],
      ),
    [props.text, props.themeAppearance],
  );
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  // Follow new output until the reader scrolls up; scrolling back down resumes.
  const followRef = useRef(true);
  return (
    <ScrollView
      ref={scrollRef}
      nestedScrollEnabled
      // Without `flexGrow: 0`, a bubble sized to its content measures this at its max height.
      style={{ flexGrow: 0, maxHeight: OUTPUT_LINE_HEIGHT * (props.maxLines ?? OUTPUT_MAX_LINES) }}
      scrollEventThrottle={100}
      onScroll={(event) => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        followRef.current =
          contentSize.height - contentOffset.y - layoutMeasurement.height <= FOLLOW_SLACK;
      }}
      onContentSizeChange={() => {
        if (props.running && followRef.current) scrollRef.current?.scrollToEnd({ animated: false });
      }}
    >
      <ScrollView horizontal nestedScrollEnabled directionalLockEnabled>
        <Text
          selectable
          className="ios:font-[family-name:Menlo] android:font-mono text-2xs text-foreground-muted"
        >
          {spans.map((span, index) =>
            span.style === null ? (
              span.text
            ) : (
              // Spans are rebuilt from scratch on every update and never reorder.
              // oxlint-disable-next-line react/no-array-index-key
              <Text key={index} style={span.style}>
                {span.text}
              </Text>
            ),
          )}
        </Text>
      </ScrollView>
    </ScrollView>
  );
}

/**
 * A person's `! cmd` once its result reached the agent: the command, then its exit code and
 * duration, with the output folded away; opening it fetches the output the thread omits. Until
 * then it lives above the composer, in `ThreadShellCommandsPanel`.
 */
export function ThreadShellCommandMessage(props: {
  readonly environmentId: EnvironmentId;
  readonly command: string;
  readonly result: UserShellCommandItem | null;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  /** The reader asked for the output; it shows once loaded. */
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
  readonly bubbleColor: import("react-native").ColorValue;
  readonly bubbleMaxWidth: number | `${number}%`;
  readonly themeAppearance: "light" | "dark";
  /** The full output once the bounded tail could not hold it. */
  readonly renderAttachment: (attachment: ChatAttachment) => ReactNode;
  /** Timestamp, pending state and actions under the bubble. */
  readonly footer: ReactNode;
}) {
  const { result } = props;
  const presentation = result === null ? null : userShellCommandPresentation(result);
  const streamsOutput = useCommandOutputStreaming(props.environmentId);
  const modeNote = result === null ? null : userShellCommandModeNote(result);
  const prefix = useShellPrefixMetrics();
  // Thread data omits command output; the same subscription agent command rows use brings it.
  const fetchedOutput = useEnvironmentQuery(
    result !== null && streamsOutput && props.expanded
      ? orchestrationEnvironment.v2.commandOutput({
          environmentId: props.environmentId,
          input: { threadId: result.threadId, itemId: result.id },
        })
      : null,
  );
  const outputText = streamsOutput
    ? (fetchedOutput.data?.output.text ?? "")
    : (result?.output ?? "");
  const view = userShellCommandOutputView({
    running: false,
    wantsOutput: props.expanded,
    fetchesOutput: streamsOutput,
    outputSettled: fetchedOutput.data !== null || fetchedOutput.error !== null,
    hasOutput: outputText.length > 0,
  });
  const showOutput = result !== null && view.showOutput;
  const outcomeLine = presentation === null ? null : userShellCommandOutcomeLine(presentation);
  const iconSlot = { width: prefix.size, marginRight: prefix.gap } as const;

  return (
    <View className="mb-5 items-end">
      {/* Sized to its content: the wider of the command and the output, which scrolls past the
          max width. The tint eases with the bubble so neither shows past the other. */}
      <Animated.View
        layout={bubbleWidthTransition}
        className="min-w-0 overflow-hidden rounded-[20px]"
        style={{ backgroundColor: props.bubbleColor, maxWidth: props.bubbleMaxWidth }}
      >
        <Animated.View
          layout={bubbleWidthTransition}
          className="min-w-0 gap-2 rounded-[20px] bg-shell-tint px-3.5 py-2.5"
        >
          <ShellCommandText
            command={props.command}
            accessibilityLabel={`${presentation?.status === "skipped" ? "Not run" : "You ran"}: ${props.command}`}
            textClassName="text-user-bubble-foreground"
          />
          {presentation?.status === "skipped" ? (
            // It never ran, so there is no output to open.
            <View className="min-h-6 flex-row items-center">
              <View className="items-center" style={iconSlot}>
                <SymbolView
                  name={STATUS_ICON.skipped}
                  size={14}
                  tintColorClassName={STATUS_TINT.skipped}
                />
              </View>
              <Text className="min-w-0 shrink text-xs text-user-bubble-foreground-muted">
                {presentation.summary}
              </Text>
            </View>
          ) : presentation !== null && !userShellCommandIsActive(presentation.status) ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${presentation.summary}, ${view.expanded ? "hide" : "show"} output`}
              accessibilityState={{ expanded: view.expanded, busy: view.loading }}
              hitSlop={6}
              onPress={props.onToggleExpanded}
              className="min-h-6 flex-row items-center active:opacity-70"
            >
              <View className="items-center" style={iconSlot}>
                <SymbolView
                  name={STATUS_ICON[presentation.status]}
                  size={14}
                  tintColorClassName={STATUS_TINT[presentation.status]}
                />
              </View>
              <Text className="min-w-0 shrink text-xs tabular-nums text-user-bubble-foreground-muted">
                {userShellCommandStatusText(presentation)}
              </Text>
              <View className="ml-auto size-6 items-center justify-center">
                {view.loading ? (
                  <SmallSpinner />
                ) : (
                  <SymbolView
                    name={view.expanded ? "chevron.up" : "chevron.down"}
                    size={12}
                    tintColorClassName="accent-icon-muted"
                  />
                )}
              </View>
            </Pressable>
          ) : null}
          {showOutput && result !== null ? (
            <View className="rounded-xl bg-screen/60 p-2">
              {outputText.length > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Copy output"
                  hitSlop={6}
                  onPress={() => copyTextWithHaptic(outputText)}
                  className="absolute right-1 top-1 z-10 size-7 items-center justify-center rounded-md active:opacity-60"
                >
                  <SymbolView name="doc.on.doc" size={13} tintColorClassName="accent-icon-muted" />
                </Pressable>
              ) : null}
              <View className={outputText.length > 0 ? "pr-7" : undefined}>
                {fetchedOutput.data?.output.truncated ? (
                  <Text className="pb-0.5 text-3xs text-foreground-subtle">
                    Earlier output not shown
                  </Text>
                ) : null}
                {outputText.length > 0 ? (
                  <ShellCommandOutputText
                    text={outputText}
                    running={false}
                    themeAppearance={props.themeAppearance}
                  />
                ) : (
                  <Text className="ios:font-[family-name:Menlo] android:font-mono text-2xs italic text-foreground-muted">
                    {fetchedOutput.error === null
                      ? "No output."
                      : `Couldn't load output: ${fetchedOutput.error}`}
                  </Text>
                )}
                {outcomeLine !== null ? (
                  <Text className="mt-1 ios:font-[family-name:Menlo] android:font-mono text-2xs text-danger-foreground">
                    {outcomeLine}
                  </Text>
                ) : null}
              </View>
            </View>
          ) : null}
          {showOutput ? props.attachments.map(props.renderAttachment) : null}
          {modeNote !== null ? (
            <Text className="text-2xs text-user-bubble-foreground-muted">{modeNote}</Text>
          ) : null}
        </Animated.View>
      </Animated.View>
      {props.footer}
    </View>
  );
}

/**
 * A thread's `! cmd` commands above the composer until their results reach the agent, each with
 * its status, Stop, and output a tap away. Delivered, a command moves into the thread; stopped, it
 * is gone.
 */
export function ThreadShellCommandsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly commands: ReadonlyArray<LiveUserShellCommand>;
  readonly themeAppearance: "light" | "dark";
  /** A running command was stopped here; it goes back to the person. */
  readonly onStoppedRunningCommand: (command: string) => void;
}) {
  if (props.commands.length === 0) return null;
  return (
    <View className="gap-1 px-4 pb-2">
      {props.commands.map((item) => (
        <LiveShellCommandRow
          key={item.id}
          environmentId={props.environmentId}
          item={item}
          themeAppearance={props.themeAppearance}
          onStoppedRunningCommand={props.onStoppedRunningCommand}
        />
      ))}
    </View>
  );
}

/** Ticks on its own, so only the label re-renders each second. */
function RunningCommandText(props: { readonly startedAt: LiveUserShellCommand["startedAt"] }) {
  const nowMs = useVisibleSecondClock(props.startedAt !== null);
  return <>{userShellCommandRunningText(props.startedAt, nowMs)}</>;
}

function LiveShellCommandRow(props: {
  readonly environmentId: EnvironmentId;
  readonly item: LiveUserShellCommand;
  readonly themeAppearance: "light" | "dark";
  readonly onStoppedRunningCommand: (command: string) => void;
}) {
  const { item } = props;
  const presentation = userShellCommandPresentation(item);
  const active = userShellCommandIsActive(presentation.status);
  const streamsOutput = useCommandOutputStreaming(props.environmentId);
  const canStop = useEnvironmentScope(props.environmentId, AuthTerminalOperateScope);
  const stopCommand = useAtomCommand(threadEnvironment.stopUserShellCommand, "stop command");
  const [stopping, setStopping] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const fetchedOutput = useEnvironmentQuery(
    streamsOutput && expanded
      ? orchestrationEnvironment.v2.commandOutput({
          environmentId: props.environmentId,
          input: { threadId: item.threadId, itemId: item.id },
        })
      : null,
  );
  const outputText = streamsOutput ? (fetchedOutput.data?.output.text ?? "") : (item.output ?? "");
  const outcomeLine = userShellCommandOutcomeLine(presentation);

  // Announce changes seen while shown, not the state of a command already running at mount.
  const announcedStatusRef = useRef(presentation.status);
  const { status, summary } = presentation;
  useEffect(() => {
    const announcement = userShellCommandAnnouncement(announcedStatusRef.current, {
      status,
      summary,
    });
    announcedStatusRef.current = status;
    if (announcement !== null) AccessibilityInfo.announceForAccessibility(announcement);
  }, [status, summary]);

  const stop = () => {
    const wasRunning = presentation.status === "running";
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
      if (wasRunning) props.onStoppedRunningCommand(item.input);
    });
  };

  return (
    <View className="rounded-2xl bg-card-alt px-3 py-2">
      <View className="min-h-7 flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${item.input}, ${presentation.summary}`}
          accessibilityHint={expanded ? "Hides the output" : "Shows the output"}
          accessibilityState={{ expanded }}
          disabled={presentation.status === "waiting"}
          onPress={() => setExpanded((value) => !value)}
          className="min-w-0 flex-1 flex-row items-center gap-2 active:opacity-70"
        >
          <View className="size-4 items-center justify-center">
            {presentation.status === "running" ? (
              <SmallSpinner />
            ) : presentation.status === "waiting" ? (
              <SymbolView name="clock" size={14} tintColorClassName="accent-icon-muted" />
            ) : (
              <SymbolView
                name={STATUS_ICON[presentation.status]}
                size={14}
                tintColorClassName={STATUS_TINT[presentation.status]}
              />
            )}
          </View>
          <ShellCommandText command={item.input} numberOfLines={1} className="min-w-0 flex-1" />
          <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">
            {presentation.status === "running" ? (
              <RunningCommandText startedAt={item.startedAt} />
            ) : (
              presentation.summary
            )}
          </Text>
        </Pressable>
        {active && canStop && item.awaitsWorkspace !== true ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop command"
            disabled={stopping}
            hitSlop={8}
            onPress={stop}
            className="size-7 items-center justify-center rounded-md disabled:opacity-60"
          >
            {({ pressed }) =>
              stopping ? (
                <SmallSpinner />
              ) : (
                <SymbolView
                  name="stop.fill"
                  size={10}
                  tintColorClassName={pressed ? "accent-danger-foreground" : "accent-icon-muted"}
                />
              )
            }
          </Pressable>
        ) : null}
      </View>
      {expanded ? (
        <View className="mt-1.5 rounded-xl bg-screen/60 p-2">
          {outputText.length > 0 ? (
            <ShellCommandOutputText
              text={outputText}
              running={active}
              themeAppearance={props.themeAppearance}
              maxLines={PANEL_OUTPUT_MAX_LINES}
            />
          ) : (
            <Text className="ios:font-[family-name:Menlo] android:font-mono text-2xs italic text-foreground-muted">
              {fetchedOutput.error === null
                ? active
                  ? "No output yet."
                  : "No output."
                : `Couldn't load output: ${fetchedOutput.error}`}
            </Text>
          )}
          {!active && outcomeLine !== null ? (
            <Text className="mt-1 ios:font-[family-name:Menlo] android:font-mono text-2xs text-danger-foreground">
              {outcomeLine}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// Rows sit close together; reaching down into the next row would run its command instead.
const ROW_HIT_SLOP = { left: 8, right: 8, top: 2, bottom: 2 } as const;

/**
 * An untagged block of `! cmd` lines, as on the web: each command on its own row with Run and its
 * other actions, and Run all for several. `commands` are what the rows run, without their `!`;
 * Copy copies the block as written.
 */
export function ShellCommandsCodeBlock(props: {
  readonly code: string;
  readonly commands: ReadonlyArray<string>;
  readonly actions: CodeBlockShellActions;
  /** Opens the other actions for one command. */
  readonly onMore: (command: string) => void;
  readonly backgroundColor: import("react-native").ColorValue;
}) {
  const { runCommands } = props.actions;
  return (
    <View
      className="my-2 overflow-hidden rounded-xl pb-1.5"
      style={{ backgroundColor: props.backgroundColor }}
    >
      <View className="flex-row items-center justify-end px-1.5 pt-1">
        {props.commands.length > 1 && runCommands ? (
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Runs them in order and sends the results to the agent. A failure skips the rest."
            hitSlop={ROW_HIT_SLOP}
            onPress={() => runCommands(props.commands)}
            className="h-8 flex-row items-center gap-1 rounded-md px-2 active:opacity-60"
          >
            <SymbolView name="play" size={12} tintColorClassName="accent-icon-muted" />
            <Text className="text-xs text-foreground-muted">Run all</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy code"
          hitSlop={ROW_HIT_SLOP}
          onPress={() => copyTextWithHaptic(props.code)}
          className="size-8 items-center justify-center rounded-md active:opacity-60"
        >
          <SymbolView name="doc.on.doc" size={13} tintColorClassName="accent-icon-muted" />
        </Pressable>
      </View>
      {props.commands.map((command, index) => (
        <ShellCommandBlockRow
          // A block's commands never reorder, and the same command can appear twice.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          command={command}
          actions={props.actions}
          onMore={props.onMore}
        />
      ))}
    </View>
  );
}

function ShellCommandBlockRow(props: {
  readonly command: string;
  readonly actions: CodeBlockShellActions;
  readonly onMore: (command: string) => void;
}) {
  const { runCommand } = props.actions;
  // The row a finger is on lights up, so its actions' target is clear.
  const [active, setActive] = useState(false);
  const highlight = { onPressIn: () => setActive(true), onPressOut: () => setActive(false) };
  return (
    <View
      className={cn(
        "mx-1.5 flex-row items-start gap-1 rounded-lg py-0.5 ps-2",
        active && "bg-shell-tint",
      )}
    >
      <ShellCommandText command={props.command} className="min-w-0 flex-1 py-1.5" />
      {runCommand ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Run ${props.command}`}
          accessibilityHint="Runs it here and sends the result to the agent"
          hitSlop={ROW_HIT_SLOP}
          onPress={() => runCommand(props.command)}
          {...highlight}
          className="h-8 flex-row items-center gap-1 rounded-md px-2"
        >
          <SymbolView name="play" size={12} tintColorClassName="accent-icon-muted" />
          <Text className="text-xs text-foreground-muted">Run</Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`More actions for ${props.command}`}
        hitSlop={ROW_HIT_SLOP}
        onPress={() => props.onMore(props.command)}
        {...highlight}
        className="size-8 items-center justify-center rounded-md"
      >
        <SymbolView name="ellipsis" size={14} tintColorClassName="accent-icon-muted" />
      </Pressable>
    </View>
  );
}

/** The actions for a tapped runnable code block, with the command shown before anything runs. */
export function ShellCommandActionsSheet(props: {
  readonly command: string;
  readonly actions: CodeBlockShellActions;
  readonly onClose: () => void;
}) {
  const [closing, setClosing] = useState(false);
  const act = (action: (command: string) => void) => {
    if (closing) return;
    setClosing(true);
    props.onClose();
    action(props.command);
  };
  const { runCommand, editCommand, editInTerminal } = props.actions;
  return (
    <Sheet title="Command" onClose={props.onClose}>
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 24 }}
      >
        <View className="mb-4 rounded-xl bg-card-alt px-3 py-2.5">
          <ShellCommandText command={props.command} />
        </View>
        <View className="overflow-hidden rounded-xl">
          {runCommand ? (
            <ListActionRow
              icon="play"
              label="Run"
              description="Runs here and sends the result to the agent"
              onPress={() => act(runCommand)}
            />
          ) : null}
          {editCommand ? (
            <ListActionRow
              icon="pencil"
              label="Edit in the composer"
              onPress={() => act(editCommand)}
            />
          ) : null}
          {editInTerminal && canEditInTerminal(props.command) ? (
            <ListActionRow
              icon="terminal"
              label="Edit in terminal"
              onPress={() => act(editInTerminal)}
            />
          ) : null}
          <ListActionRow
            icon="doc.on.doc"
            label="Copy command"
            onPress={() => act((command) => copyTextWithHaptic(command))}
          />
        </View>
      </ScrollView>
    </Sheet>
  );
}

const RUN_EXPLAINED_KEY = "t3code.shell-command-run-explained.v1";
let runExplained: boolean | null = null;

/**
 * A code block's Run says only "Run", so the first run on this device says where the output goes.
 * Unreadable storage asks again rather than failing the run. Of runs tapped before the answer,
 * only the first confirmed runs: a double tap asks twice, and must not run twice.
 */
export function runAfterExplainingOnce(run: () => void): void {
  void (async () => {
    runExplained ??= await SecureStore.getItemAsync(RUN_EXPLAINED_KEY).then(
      (value) => value === "1",
      () => false,
    );
    if (runExplained) {
      run();
      return;
    }
    Dialog.confirm({
      title: "Run in this thread's workspace?",
      message:
        "Commands from code blocks run here, and their output is sent to the agent, which replies to it. You won't be asked again.",
      confirmText: "Run",
      onConfirm: () => {
        if (runExplained) return;
        runExplained = true;
        void SecureStore.setItemAsync(RUN_EXPLAINED_KEY, "1").catch(() => undefined);
        run();
      },
    });
  })();
}
