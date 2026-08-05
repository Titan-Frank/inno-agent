import type { CaseDoc, CaseMeta } from "../cases.js";
import type { WorkspaceFileDetail, WorkspaceFileKind, WorkspaceTree, WorkspaceTreeNode } from "@inno-web/types/workspace.js";

/**
 * Step-aware mock backend for the showcase. The real product UI (stores +
 * components) talks to the backend exclusively through apiFetch → fetch;
 * installMockFetch routes every /api/* call here, and this class answers from
 * the exported case fixtures. Panel data (workspace tree, wiki pages, learner
 * profile) is reconstructed as of the current replay step, so driving the
 * step forward and asking the stores to reload reproduces the live
 * chat → panel 联动 of a real session.
 */

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

interface WorkspaceFileState {
	content?: string;
	asset?: string;
	size: number;
	updatedAt: string;
}

const KIND_BY_EXT: Record<string, WorkspaceFileKind> = {
	".md": "markdown",
	".markdown": "markdown",
	".html": "html",
	".htm": "html",
	".pdf": "pdf",
	".png": "image",
	".jpg": "image",
	".jpeg": "image",
	".gif": "image",
	".svg": "image",
	".webp": "image",
	".docx": "office",
	".xlsx": "office",
	".pptx": "office",
	".txt": "text",
	".json": "text",
	".csv": "text",
	".tsv": "text",
	".py": "text",
	".js": "text",
	".ts": "text",
	".css": "text",
	".sh": "text",
	".yaml": "text",
	".yml": "text",
	".tex": "text",
	".log": "text",
};

const MIME_BY_EXT: Record<string, string> = {
	".md": "text/markdown",
	".html": "text/html",
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".webp": "image/webp",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function extOf(path: string): string {
	const idx = path.lastIndexOf(".");
	return idx >= 0 ? path.slice(idx).toLowerCase() : "";
}

function kindOf(path: string): WorkspaceFileKind {
	return KIND_BY_EXT[extOf(path)] ?? "text";
}

function sortTreeNodes(nodes: WorkspaceTreeNode[]): void {
	nodes.sort((a, b) => {
		if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	for (const node of nodes) {
		if (node.children) sortTreeNodes(node.children);
	}
}

export class MockBackend {
	cases: CaseMeta[] = [];
	private docs = new Map<string, CaseDoc>();
	currentCaseId: string | null = null;
	step = 0;
	private warnedRoutes = new Set<string>();

	setCases(cases: CaseMeta[]): void {
		this.cases = cases;
	}

	registerDoc(doc: CaseDoc): void {
		this.docs.set(doc.id, doc);
	}

	setCurrent(caseId: string | null, step: number): void {
		this.currentCaseId = caseId;
		this.step = step;
	}

	private currentDoc(): CaseDoc | undefined {
		return this.currentCaseId ? this.docs.get(this.currentCaseId) : undefined;
	}

	/** Workspace file states as of the current replay step. */
	private workspaceFiles(doc: CaseDoc): Map<string, WorkspaceFileState> {
		const files = new Map<string, WorkspaceFileState>();
		const ws = doc.panels.workspace;
		if (!ws) return files;
		for (const f of ws.initial) {
			files.set(f.path, { content: f.content, asset: f.asset, size: f.size, updatedAt: f.updatedAt });
		}
		for (const k of ws.keyframes) {
			if (k.atMessage >= this.step) continue;
			const prev = files.get(k.path);
			files.set(k.path, {
				content: k.content,
				size: k.content.length,
				updatedAt: doc.messages[Math.min(k.atMessage, doc.messages.length - 1)]?.timestamp
					? new Date(doc.messages[Math.min(k.atMessage, doc.messages.length - 1)].timestamp).toISOString()
					: (prev?.updatedAt ?? doc.recordedAt),
			});
		}
		return files;
	}

	private buildTree(doc: CaseDoc): WorkspaceTree {
		const ws = doc.panels.workspace;
		const root: WorkspaceTree = {
			name: ws?.name ?? doc.title,
			path: "",
			type: "directory",
			root: "",
			children: [],
		};
		const files = this.workspaceFiles(doc);
		for (const [path, state] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			const parts = path.split("/");
			let children = root.children;
			for (let i = 0; i < parts.length; i++) {
				const part = parts[i];
				const nodePath = parts.slice(0, i + 1).join("/");
				if (i === parts.length - 1) {
					children.push({ name: part, path: nodePath, type: "file", size: state.size, updatedAt: state.updatedAt });
				} else {
					let dir = children.find((c) => c.type === "directory" && c.name === part);
					if (!dir) {
						dir = { name: part, path: nodePath, type: "directory", children: [] };
						children.push(dir);
					}
					children = dir.children!;
				}
			}
		}
		sortTreeNodes(root.children);
		return root;
	}

	private wikiPagesAtStep(doc: CaseDoc) {
		return doc.panels.wiki.keyframes.filter((k) => k.atMessage < this.step).map((k) => k.page);
	}

	private handleWorkspaceFile(doc: CaseDoc, params: URLSearchParams): Response {
		const path = params.get("path") ?? "";
		const state = this.workspaceFiles(doc).get(path);
		if (!state) return jsonResponse({ error: "File not found" }, 404);
		const ext = extOf(path);
		const kind = kindOf(path);
		const detail: WorkspaceFileDetail = {
			path,
			name: path.split("/").pop() ?? path,
			kind,
			mimeType: MIME_BY_EXT[ext] ?? "text/plain",
			size: state.size,
			updatedAt: state.updatedAt,
		};
		if (kind === "office") detail.format = ext.slice(1) as "docx" | "xlsx" | "pptx";
		if (state.content !== undefined && kind !== "pdf" && kind !== "image" && kind !== "office") {
			detail.content = state.content;
		}
		if (state.asset) {
			detail.url = `${import.meta.env.BASE_URL}${state.asset}`;
		}
		return jsonResponse(detail);
	}

	private emptyProfile() {
		return {
			learner_id: "demo-learner",
			version: 0,
			updated_at: new Date().toISOString(),
			goals: [],
			knowledge_states: [],
			misconceptions: [],
			preferences: { explanation_style: [], practice_style: [], feedback_tone: [], avoid: [] },
			profile_summary: "",
		};
	}

	handle(pathname: string, params: URLSearchParams, method: string, init?: RequestInit): Response {
		const doc = this.currentDoc();

		// --- sessions ---
		if (pathname === "/api/sessions" && method === "GET") {
			return jsonResponse(
				this.cases.map((c) => ({
					id: c.id,
					name: c.title,
					createdAt: c.recordedAt,
					updatedAt: c.recordedAt,
					messageCount: c.messageCount,
					preview: c.description,
					channels: ["web"],
					origin: "web",
					hasTopic: true,
				})),
			);
		}
		if (pathname === "/api/sessions" && method === "POST") {
			return jsonResponse({ error: "回放演示环境无法创建新会话" }, 503);
		}
		const sessionMatch = /^\/api\/sessions\/([^/]+)(\/.*)?$/.exec(pathname);
		if (sessionMatch) {
			const id = decodeURIComponent(sessionMatch[1]);
			const sub = sessionMatch[2] ?? "";
			const meta = this.cases.find((c) => c.id === id);
			if (sub === "/activate") return jsonResponse({ id, active: true });
			if (sub === "/workspace") {
				const wsId = `ws-${id}`;
				const wsDoc = this.docs.get(id);
				return jsonResponse({
					sessionId: id,
					workspaceId: wsId,
					workspace: {
						id: wsId,
						name: wsDoc?.panels.workspace?.name ?? meta?.title ?? id,
						relPath: "",
						createdAt: meta?.recordedAt ?? "",
						updatedAt: meta?.recordedAt ?? "",
						isTemp: false,
						sessionIds: [id],
					},
				});
			}
			if (sub === "" && method === "GET") {
				if (!meta) return jsonResponse({ error: "Session not found" }, 404);
				// History is intentionally empty — the replay driver owns the
				// message list and pushes prefixes via chatStore.loadHistory.
				return jsonResponse({
					id: meta.id,
					name: meta.title,
					createdAt: meta.recordedAt,
					updatedAt: meta.recordedAt,
					messageCount: meta.messageCount,
					preview: meta.description,
					channels: ["web"],
					origin: "web",
					hasTopic: true,
					messages: [],
					sessionRevision: "showcase-1",
				});
			}
			return jsonResponse({ ok: true });
		}

		// --- workspaces ---
		if (pathname === "/api/workspaces" && method === "GET") {
			return jsonResponse(
				this.cases.map((c) => ({
					id: `ws-${c.id}`,
					name: this.docs.get(c.id)?.panels.workspace?.name ?? c.title,
					relPath: "",
					createdAt: c.recordedAt,
					updatedAt: c.recordedAt,
					isTemp: false,
					sessionIds: [c.id],
				})),
			);
		}
		if (pathname === "/api/workspace/tree" && doc) {
			return jsonResponse(this.buildTree(doc));
		}
		if (pathname === "/api/workspace/file" && doc) {
			return this.handleWorkspaceFile(doc, params);
		}

		// --- wiki (L2) ---
		if (pathname === "/api/wiki/pages" && doc) {
			const pages = this.wikiPagesAtStep(doc);
			return jsonResponse(
				pages.map((p) => ({
					path: p.path,
					frontmatter: {
						title: p.title,
						created: doc.recordedAt,
						type: "source-summary",
						tags: [],
						sources: [],
						source_ids: [],
						updated: doc.recordedAt,
						status: "reviewed",
						confidence: "medium",
					},
					bodyPreview: p.content.replace(/^---[\s\S]*?---/, "").trim().slice(0, 200),
					sourceId: "",
				})),
			);
		}
		if (pathname === "/api/wiki/page" && method === "GET" && doc) {
			const path = params.get("path") ?? "";
			const page = this.wikiPagesAtStep(doc).find((p) => p.path === path);
			if (!page) return jsonResponse({ error: "Page not found" }, 404);
			return jsonResponse({ path: page.path, content: page.content });
		}
		if (pathname === "/api/wiki/graph" && doc) {
			const pages = this.wikiPagesAtStep(doc);
			return jsonResponse({
				nodes: pages.map((p) => ({ id: p.path, title: p.title, type: "source-summary", tags: [] })),
				edges: [],
			});
		}
		if (pathname === "/api/wiki/stats" && doc) {
			const pages = this.wikiPagesAtStep(doc);
			return jsonResponse({
				pageCount: pages.length,
				totalSize: pages.reduce((sum, p) => sum + p.content.length, 0),
				entryCount: pages.length,
			});
		}

		// --- learner profile (L1) ---
		if (pathname === "/api/learner/profile" && doc) {
			const panel = doc.panels.profile;
			const visible = panel.firstEventAt !== null && this.step > panel.firstEventAt;
			return jsonResponse(visible && panel.profile ? panel.profile : this.emptyProfile());
		}

		// --- settings / misc collections ---
		if (pathname === "/api/settings") {
			return jsonResponse({
				defaultProvider: "demo",
				defaultModel: "demo-model",
				availableModels: [{ provider: "demo", id: "demo-model", input: ["text"] }],
				configuredModels: [{ provider: "demo", id: "demo-model", input: ["text"] }],
				simpleMode: { enabled: false },
				memory: { l1Enabled: true, l2Enabled: true, l3Enabled: true },
				ui: { theme: "light" },
				channels: {},
			});
		}
		if (pathname === "/api/jobs") return jsonResponse([]);
		if (pathname === "/api/skills") return jsonResponse([]);
		if (pathname === "/api/presets" || pathname === "/api/preset-library" || pathname === "/api/skill-library") {
			return jsonResponse([]);
		}
		if (pathname.startsWith("/api/chat/status/")) {
			return jsonResponse({ found: false });
		}
		if (pathname === "/api/chat/stream" || pathname === "/api/chat") {
			return jsonResponse({ error: "这是回放演示环境，无法发送新消息。下载 Inno Agent 亲自体验 →" }, 503);
		}
		if (pathname === "/health") return jsonResponse({ ok: true });

		// Mutations against anything else: pretend success so the UI stays quiet.
		if (method !== "GET") return jsonResponse({ ok: true });

		if (!this.warnedRoutes.has(pathname)) {
			this.warnedRoutes.add(pathname);
			console.warn(`[showcase mock] unhandled GET ${pathname} — returning 404`);
		}
		return jsonResponse({ error: "Not available in showcase" }, 404);
	}
}

export const mockBackend = new MockBackend();

/** Intercept fetch: /api/* goes to the mock backend; everything else passes through. */
export function installMockFetch(): void {
	const original = window.fetch.bind(window);
	window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const parsed = new URL(url, window.location.origin);
		if (!parsed.pathname.startsWith("/api/") && parsed.pathname !== "/health") {
			return original(input, init);
		}
		const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET") ?? "GET").toUpperCase();
		return mockBackend.handle(parsed.pathname, parsed.searchParams, method, init);
	}) as typeof window.fetch;
}
