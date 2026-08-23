import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	appStore: {
		sidebarCollapsed: false,
		workspaceMode: "collapsed" as const,
		workspaceWidth: 520,
	},
}));

vi.mock("./app-store.js", () => ({ appStore: mocks.appStore }));

import { ensureWindowForPanel } from "./window-expansion.js";

describe("ensureWindowForPanel", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("falls back cleanly for a browser without the Electron bridge", async () => {
		vi.stubGlobal("window", { innerWidth: 1200 });

		await expect(ensureWindowForPanel("right", 640, "half")).resolves.toBe("unavailable");
	});
});
