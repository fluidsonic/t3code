import {
  approvalRequestLabel,
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { approvalCommandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerBanner } from "./ComposerBanner";
import { composerFloatingLayerProps } from "./composerEventScope";
import { cn } from "~/lib/utils";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  className?: string;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  className,
}: ComposerPendingApprovalPanelProps) {
  const Detail = approval.requestKind === "mcp-elicitation" ? "span" : "code";
  const fallbackLabel = approvalRequestLabel(approval.requestKind);
  const detailAriaLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access request"
      : approval.requestKind === "command"
        ? "Command"
        : approval.requestKind === "file-read"
          ? "File to read"
          : approval.requestKind === "permission"
            ? "Permission request"
            : "File change";

  return (
    <span
      aria-label={fallbackLabel}
      className={cn("flex min-w-0 flex-1 flex-col items-start gap-1", className)}
      role="group"
    >
      <span className="flex w-full min-w-0 items-baseline gap-2 text-2xs text-muted-foreground">
        <span className="shrink-0 font-medium text-warning">{fallbackLabel}</span>
        {approval.fullAccessOverride ? (
          <Popover>
            <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
              {FULL_ACCESS_OVERRIDE_QUESTION}
            </PopoverTrigger>
            <PopoverPopup
              {...composerFloatingLayerProps}
              aria-label={FULL_ACCESS_OVERRIDE_QUESTION}
              tooltipStyle
              side="top"
              className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
            >
              {fullAccessOverrideExplanation(approval.fullAccessOverride)}
            </PopoverPopup>
          </Popover>
        ) : null}
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 tabular-nums">1/{pendingCount}</span>
        ) : null}
      </span>
      <ComposerBanner.Scroll className="w-full">
        <span className="flex flex-col gap-1">
          {approval.appName || approval.title ? (
            <span
              aria-label="Approval explanation"
              className="w-full min-w-0 text-2xs text-muted-foreground whitespace-pre-wrap wrap-break-word"
            >
              {approval.appName ?? approval.title}
            </span>
          ) : null}
          <Detail
            aria-label={detailAriaLabel}
            className={cn(
              "block w-full min-w-0 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
              approval.requestKind === "mcp-elicitation"
                ? "whitespace-pre-wrap font-sans wrap-break-word"
                : "whitespace-pre-wrap font-mono wrap-anywhere",
            )}
            data-approval-detail="complete"
            tabIndex={0}
          >
            {approval.responseCapability === "not_resumable"
              ? "Provider process is gone. Interrupt or restart the run to respond."
              : approval.detail
                ? approval.requestKind === "command"
                  ? approvalCommandDisplayText(approval.detail)
                  : approval.detail
                : fallbackLabel}
          </Detail>
          {approval.reason ? (
            <span className="w-full min-w-0 text-2xs text-muted-foreground whitespace-pre-wrap wrap-break-word">
              {approval.reason}
            </span>
          ) : null}
        </span>
      </ComposerBanner.Scroll>
    </span>
  );
});
