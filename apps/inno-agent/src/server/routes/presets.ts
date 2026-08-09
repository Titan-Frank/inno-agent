import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import type { RemoteContentSource } from "../../content-source/index.js";
import { logger } from "../../logger.js";
import { listPresets, listRemotePresets } from "../../presets/preset-store.js";
import type { RuntimePaths } from "../../runtime.js";
import { json } from "../http-helpers.js";

export interface PresetsRouteContext {
	paths: RuntimePaths;
	getContentSource: () => RemoteContentSource;
}

/**
 * /api/presets and /api/preset-library route domain (ready-to-use workspace
 * templates). Returns true when the request was handled. Extracted verbatim
 * from server.ts during the P2 route split — behavior unchanged.
 */
export async function handlePresetsRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: PresetsRouteContext,
): Promise<boolean> {
	const { paths, getContentSource } = ctx;

	// --- Presets API (ready-to-use workspace templates) ---
	// Local cache listing (offline fallback / already-downloaded presets).
	if (method === "GET" && url === "/api/presets") {
		json(res, 200, listPresets(paths));
		return true;
	}

	// Live catalog from the remote content hub (Simple Mode preset cards).
	// Falls back to the bundled/cached presets when the hub is empty or
	// unreachable, so the shipped templates always appear.
	if (method === "GET" && url.split("?")[0] === "/api/preset-library") {
		const forceRefresh = new URL(url, "http://localhost").searchParams.get("refresh") === "1";
		try {
			const remote = await listRemotePresets(getContentSource(), forceRefresh);
			if (remote.length > 0) {
				const merged = new Map(listPresets(paths).map((preset) => [preset.id, preset]));
				for (const preset of remote) merged.set(preset.id, preset);
				json(res, 200, Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name)));
			} else {
				json(res, 200, listPresets(paths));
			}
		} catch (err) {
			logger.warn({ err }, "failed to list preset library; falling back to bundled presets");
			json(res, 200, listPresets(paths));
		}
		return true;
	}

	return false;
}
