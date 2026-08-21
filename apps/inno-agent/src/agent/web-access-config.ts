/**
 * Managed default for pi-web-access's config file (`web-search.json`).
 *
 * pi-web-access reads its config from `$PI_CODING_AGENT_DIR/web-search.json`,
 * which runtime.ts points at inno's configDir. Two integration concerns are
 * encoded here:
 *
 * 1. Tool-name collision: pi-web-access's own `web_search` would silently
 *    override inno's built-in Tavily `web_search` at the PI tool registry
 *    (last registration wins, no error). The managed default keeps
 *    `webSearch`/`sourceCheck` disabled so inno's Tavily tool — which has the
 *    settings-UI key card and Chinese prompt hints — remains the single
 *    search tool, while pi-web-access provides `fetch_content` /
 *    `get_search_content` (URL, GitHub repo, PDF, YouTube extraction).
 * 2. No browser curator: the "summary-review" workflow opens an interactive
 *    browser window, which makes no sense for a server deployment and is
 *    surprising in the CLI. Force `workflow: "none"`.
 *
 * The file is only written when absent — user edits (e.g. re-enabling
 * pi-web-access search, adding provider keys) are never clobbered.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger.js";

export const WEB_ACCESS_CONFIG_FILE = "web-search.json";

const MANAGED_DEFAULT = {
	tools: {
		webSearch: { enabled: false },
		sourceCheck: { enabled: false },
	},
	workflow: "none",
};

/** Write the managed default config if the user has no web-search.json yet. */
export function ensureWebAccessConfig(configDir: string): void {
	const configPath = join(configDir, WEB_ACCESS_CONFIG_FILE);
	if (existsSync(configPath)) return;
	try {
		writeFileSync(configPath, JSON.stringify(MANAGED_DEFAULT, null, 2) + "\n", "utf-8");
		logger.info({ configPath }, "wrote managed pi-web-access default config");
	} catch (err) {
		// Non-fatal: pi-web-access still loads with its own defaults; its
		// web_search would then override inno's Tavily tool (last-wins).
		logger.warn({ err, configPath }, "failed to write pi-web-access default config");
	}
}

/**
 * Build jiti aliases that pin `@earendil-works/pi-ai` (and its `./compat`
 * subpath) to the copy in inno-agent's own dependency tree.
 *
 * Why: this monorepo's root node_modules hoists pi-ai 0.75.x (pinned by
 * pi-web-ui, used by the web frontend and showcase app), while the backend
 * runs on pi-ai 0.84.x. pi-web-access is hoisted to the root, so its bare
 * `@earendil-works/pi-ai/compat` import would resolve to the 0.75.x copy —
 * whose exports map has no `./compat` — and fail to load. jiti's alias does
 * literal path mapping (it does not consult the target package's exports
 * map), so both the package root and the `./compat` subpath are aliased to
 * their resolved dist files.
 *
 * Walks up from the extension module so it works from both `src/` (tsx) and
 * compiled `dist/`. Returns undefined when no suitable copy is found; the
 * caller then loads without aliases and lets the import fail loudly.
 */
export function resolvePiAiJitiAliases(fromModuleUrl: string): Record<string, string> | undefined {
	let dir = dirname(fileURLToPath(fromModuleUrl));
	for (;;) {
		const pkgDir = join(dir, "node_modules", "@earendil-works", "pi-ai");
		try {
			const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")) as {
				exports?: Record<string, { import?: unknown }>;
			};
			const compat = pkg.exports?.["./compat"]?.import;
			const main = pkg.exports?.["."]?.import;
			if (typeof compat === "string" && typeof main === "string") {
				return {
					"@earendil-works/pi-ai/compat": join(pkgDir, compat),
					"@earendil-works/pi-ai": join(pkgDir, main),
				};
			}
		} catch {
			// No pi-ai here — keep walking up.
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}
