import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  PREVIEW_ZOOM_LEVELS,
  type PreviewAdjustInput,
  type PreviewZoomFactor,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { toastManager } from "~/components/ui/toast";
import { updatePreviewServerSnapshot } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { previewBridge } from "./previewBridge";
import { previewEnvironment } from "~/state/preview";

/** One step along the zoom ladder; 0 resets to the default. */
function stepPreviewZoomFactor(current: PreviewZoomFactor, direction: -1 | 0 | 1) {
  if (direction === 0) return DEFAULT_PREVIEW_ZOOM_FACTOR;
  const index = PREVIEW_ZOOM_LEVELS.indexOf(current);
  const from = index < 0 ? PREVIEW_ZOOM_LEVELS.indexOf(DEFAULT_PREVIEW_ZOOM_FACTOR) : index;
  return PREVIEW_ZOOM_LEVELS[
    Math.min(Math.max(from + direction, 0), PREVIEW_ZOOM_LEVELS.length - 1)
  ]!;
}

/** Changes a server-owned browser tab and applies the server's reply locally. */
export async function adjustServerPreviewTab(
  threadRef: ScopedThreadRef,
  tabId: string,
  change: Omit<PreviewAdjustInput, "threadId" | "tabId">,
): Promise<void> {
  const result = await runAtomCommand(
    appAtomRegistry,
    previewEnvironment.adjust,
    {
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, tabId, ...change },
    },
    { label: "preview appearance or zoom" },
  );
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Unable to change the browser tab",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
    return;
  }
  updatePreviewServerSnapshot(threadRef, result.value);
}

export interface ZoomablePreviewTab {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly runtimeTabId: string;
  /** The server's zoom when it owns the tab, which then zooms through it; null otherwise. */
  readonly serverZoomFactor: PreviewZoomFactor | null;
}

/** Zooms one tab the way its menu does, for the menu and for zoom keys alike. */
export function zoomPreviewTab(tab: ZoomablePreviewTab, direction: -1 | 0 | 1): void {
  if (tab.serverZoomFactor !== null) {
    const next = stepPreviewZoomFactor(tab.serverZoomFactor, direction);
    if (next !== tab.serverZoomFactor) {
      void adjustServerPreviewTab(tab.threadRef, tab.tabId, { zoomFactor: next });
    }
    return;
  }
  if (!previewBridge) return;
  if (direction === 1) void previewBridge.zoomIn(tab.runtimeTabId);
  else if (direction === -1) void previewBridge.zoomOut(tab.runtimeTabId);
  else void previewBridge.resetZoom(tab.runtimeTabId);
}
