import { appStore, type WorkspaceMode } from "./app-store.js";
import {
	CHAT_BASELINE_WIDTH,
	SIDEBAR_WIDTH,
	getEffectiveWorkspaceWidth,
} from "./app-layout.js";

export type WindowExpansionSide = "left" | "right";
export type PanelSpaceResult = "ready" | "busy" | "unavailable";

let pendingExpansion: WindowExpansionSide | null = null;

function waitForViewportWidth(minWidth: number): Promise<boolean> {
	if (typeof window === "undefined" || window.innerWidth >= minWidth) return Promise.resolve(true);

	return new Promise((resolve) => {
		const startedAt = performance.now();
		const check = () => {
			if (window.innerWidth >= minWidth) {
				resolve(true);
				return;
			}
			if (performance.now() - startedAt >= 600) {
				resolve(false);
				return;
			}
			window.requestAnimationFrame(check);
		};
		check();
	});
}

/**
 * Make room for a non-overlay panel before changing the app layout.
 *
 * In a normal browser there is no native window to resize. The caller still
 * applies its requested layout when this returns "unavailable", allowing the
 * existing fitPanelLayout fallback to keep the chat usable.
 */
export async function ensureWindowForPanel(
	side: WindowExpansionSide,
	requestedWorkspaceWidth?: number,
	requestedWorkspaceMode?: WorkspaceMode,
): Promise<PanelSpaceResult> {
	const currentSidebarCollapsed = appStore.sidebarCollapsed;
	const currentWorkspaceMode = appStore.workspaceMode;
	const workspaceWidth = requestedWorkspaceWidth ?? appStore.workspaceWidth;
	const workspaceMode = requestedWorkspaceMode ?? currentWorkspaceMode;
	const leftWidth = currentSidebarCollapsed && side !== "left" ? 0 : SIDEBAR_WIDTH;
	const rightWidth = currentWorkspaceMode === "collapsed" && side !== "right"
		? 0
		: getEffectiveWorkspaceWidth(workspaceWidth, workspaceMode === "collapsed" ? "half" : workspaceMode);
	const requiredWidth = CHAT_BASELINE_WIDTH + leftWidth + rightWidth;
	const viewportWidth = typeof window === "undefined" ? requiredWidth : window.innerWidth;
	const additionalWidth = Math.max(0, requiredWidth - viewportWidth);
	if (additionalWidth === 0) return "ready";

	const expandWindowWidth = typeof window === "undefined" ? undefined : window.innoDesktop?.expandWindowWidth;
	if (!expandWindowWidth) return "unavailable";
	if (pendingExpansion) return "busy";

	pendingExpansion = side;
	try {
		const expanded = await expandWindowWidth(side, additionalWidth);
		if (!expanded) return "unavailable";
		return (await waitForViewportWidth(requiredWidth)) ? "ready" : "unavailable";
	} catch {
		// A browser build, a closed Electron window, or a failed IPC request
		// should fall back to the renderer's fitted layout instead of blocking
		// the panel from opening.
		return "unavailable";
	} finally {
		pendingExpansion = null;
	}
}
