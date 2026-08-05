/**
 * Export recorded PI sessions into static showcase cases for apps/showcase.
 *
 * Reads session JSONL files, replays the same aggregation logic as
 * server.ts's parseSessionFile (user / assistant-turn merge / toolResult
 * pairing), sanitizes local paths and secrets, truncates bulky tool output,
 * and writes one JSON per case plus an index.json manifest.
 *
 * Usage:
 *   npx tsx scripts/export-showcase-cases.ts [--sessions-dir <dir>] [--out <dir>] [--only <id,id>]
 *
 * Defaults: --sessions-dir runtime/data/sessions --out apps/showcase/public/cases
 *
 * IMPORTANT: exported cases are meant to be published. Always review the
 * output JSON before committing — the sanitizer rewrites paths and common
 * secret shapes, but message CONTENT is preserved verbatim.
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

// --- Case registry -----------------------------------------------------------
// One entry per published case. `maxUserTurns` optionally trims the tail of a
// long session so the replay stays digestible.

interface CaseSpec {
	/** Showcase case id — becomes <id>.json and the page route. */
	id: string;
	/** Session JSONL file name inside the sessions dir. */
	sessionFile: string;
	title: string;
	titleEn: string;
	description: string;
	tags: string[];
	/** Keep only the first N user turns (and their assistant replies). */
	maxUserTurns?: number;
	/** Display name for the reconstructed workspace (defaults to the cwd basename). */
	workspaceName?: string;
	/** Workspace-relative paths excluded from the initial-file snapshot. */
	excludePaths?: string[];
}

const CASES: CaseSpec[] = [
	{
		id: "trig-handout",
		sessionFile: "2026-06-05T14-39-09-564Z_019e9839-40fc-7e36-9742-655ab4a46828.jsonl",
		title: "生成一份三角函数讲义",
		titleEn: "Generating a trigonometry handout",
		description: "学习者说明自己的薄弱点后，agent 先理论后练习，生成讲义并记录学习事件到 L1 画像。",
		tags: ["L1 学习者画像", "讲义生成", "个性化教学"],
		maxUserTurns: 8,
	},
	{
		id: "l2-wiki-autoresearch",
		sessionFile: "2026-06-11T07-50-22-966Z_019eb5a9-29f6-7611-b5ba-fcbbdfcf07aa.jsonl",
		title: "什么是 AutoResearch？（结合知识库）",
		titleEn: "Explaining AutoResearch with the L2 wiki",
		description: "agent 检索 L2 wiki 与 L3 历史会话，结合本地论文讲解概念，并把新内容归档回知识库。",
		tags: ["L2 Wiki", "L3 跨会话回忆", "文档解析"],
	},
	{
		id: "paper-explain",
		sessionFile: "2026-07-05T13-54-49-451Z_019f328f-71eb-7cd2-8ee3-d64dcfd8db13.jsonl",
		title: "目录下这篇论文讲了什么",
		titleEn: "Walking through a paper in the workspace",
		description: "agent 解析工作区里的 PDF 论文，给出结构化解读。",
		tags: ["文档解析", "论文解读"],
		excludePaths: ["截屏2026-06-30 19.28.13.png"],
	},
	{
		id: "gaokao-geometry",
		sessionFile: "2026-06-14T15-55-58-389Z_019ec6d8-d035-7664-bf81-8c5e8a90cd0d.jsonl",
		title: "高考数学立体几何题讲解",
		titleEn: "Gaokao solid-geometry tutoring",
		description: "查找高考立体几何真题，通过互动提问确认需求后逐题讲解，并记录掌握情况。",
		tags: ["互动提问", "题目讲解", "L1 学习者画像"],
	},
	{
		id: "problem-explain",
		sessionFile: "2026-06-14T16-23-09-514Z_019ec6f1-b3ca-7e37-a596-ffa9eeb3fa6d.jsonl",
		title: "讲解一道数学题",
		titleEn: "Explaining a math problem",
		description: "读取工作区中的题目文件，逐步讲解解题思路。",
		tags: ["题目讲解"],
	},
];

// --- Sanitization ------------------------------------------------------------

function buildPathRewrites(): Array<[RegExp, string]> {
	const home = homedir(); // e.g. /Users/haohao
	const escapedRoot = repoRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const rules: Array<[RegExp, string]> = [
		// Longest first: workspace dirs inside the repo, then the repo itself.
		[new RegExp(`${escapedRoot}[\\\\/]workspace[\\\\/]workspace-[a-z0-9-]+`, "gi"), "/workspace"],
		[new RegExp(`${escapedRoot}[\\\\/]workspace`, "gi"), "/workspace"],
		[new RegExp(escapedRoot, "gi"), "/inno-agent"],
		// Any other absolute path under the user's home (covers runtime/data, ~/.inno-agent).
		[new RegExp(`${escapedHome}[\\\\/]\\.inno-agent`, "gi"), "~/.inno-agent"],
		[new RegExp(escapedHome, "gi"), "~"],
		// Generic fallback for other users' paths quoted in tool output.
		[/\/Users\/[^\s/"']+/g, "~"],
		// Repo-dir name remnants in paths that escaped the root rewrite above
		// (e.g. recorded under a different checkout layout).
		[/inno-agent-open/g, "inno-agent"],
	];
	// Unix owner column in `ls -la` output, mentions in paths, etc.
	const username = userInfo().username;
	if (username && username.length >= 3) {
		rules.push([new RegExp(`\\b${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), "learner"]);
	}
	return rules;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
	// Common API key shapes: sk-*, tvly-*, ghp_*, xox*, Bearer tokens, etc.
	[/\b(sk|pk|pat|tvly|ghp|gho|xox[bap]| Bearer)[-_A-Za-z0-9]{10,}\b/g, "[REDACTED]"],
	[/"(apiKey|api_key|token|accessToken|refreshToken|secret)"\s*:\s*"[^"]{6,}"/g, '"$1": "[REDACTED]"'],
	[/\\"(apiKey|api_key|token|accessToken|refreshToken|secret)\\"\s*:\s*\\"[^\\"]{6,}\\"/g, '\\"$1\\": \\"[REDACTED]\\"'],
];

function sanitizeText(input: string, rewrites: Array<[RegExp, string]>): string {
	let out = input;
	for (const [pattern, replacement] of rewrites) out = out.replace(pattern, replacement);
	for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
	return out;
}

function sanitizeValue<T>(value: T, rewrites: Array<[RegExp, string]>): T {
	if (typeof value === "string") return sanitizeText(value, rewrites) as T;
	if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, rewrites)) as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeValue(v, rewrites);
		return out as T;
	}
	return value;
}

function truncateText(text: string, max: number): string {
	if (text.length <= max) return text;
	const kept = text.slice(0, max);
	return `${kept}\n… [已截断，原文共 ${text.length} 字符 / truncated from ${text.length} chars]`;
}

const LIMITS = {
	thinking: 4000,
	toolArgs: 1200,
	toolResult: 2000,
};

// --- Session parsing (mirrors parseSessionFile in server.ts) -----------------

interface ShowcaseToolRecord {
	toolCallId: string;
	toolName: string;
	args: unknown;
	result?: unknown;
	isError?: boolean;
}

/**
 * One ordered piece of an assistant turn, used by the showcase to synthesize
 * a live-like SSE stream (text/thinking deltas, tool start/end). `at`/`endAt`
 * are absolute ms timestamps from the session log; the replayer clamps the
 * gaps so pacing feels real without dead air.
 */
type ShowcaseStreamSegment =
	| { kind: "thinking"; text: string; at: number }
	| { kind: "text"; text: string; at: number }
	| {
			kind: "tool";
			toolCallId: string;
			toolName: string;
			args: unknown;
			result?: unknown;
			isError?: boolean;
			at: number;
			endAt: number;
	  };

interface ShowcaseMessage {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
	thinking?: string;
	tools?: ShowcaseToolRecord[];
	/** Ordered blocks of this turn (assistant messages only). */
	stream?: ShowcaseStreamSegment[];
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const record = part as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

function parseSessionMessages(filePath: string): ShowcaseMessage[] {
	const raw = readFileSync(filePath, "utf-8");
	const lines = raw.split("\n").filter((line) => line.trim().length > 0);
	const messages: ShowcaseMessage[] = [];

	let pendingAssistant: ShowcaseMessage | null = null;
	let pendingStream: ShowcaseStreamSegment[] = [];
	const finalizeAssistant = () => {
		if (pendingAssistant) {
			if (pendingStream.length > 0) pendingAssistant.stream = pendingStream;
			messages.push(pendingAssistant);
			pendingAssistant = null;
			pendingStream = [];
		}
	};
	const ensureAssistant = (timestamp: number): ShowcaseMessage => {
		if (!pendingAssistant) pendingAssistant = { role: "assistant", content: "", timestamp };
		return pendingAssistant;
	};

	for (const line of lines) {
		const entry = JSON.parse(line) as Record<string, unknown>;
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const message = entry.message as Record<string, unknown>;
		const role = message.role;
		const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Date.now();

		if (role === "user") {
			finalizeAssistant();
			const content = textFromContent(message.content);
			if (!content) continue;
			messages.push({ role: "user", content, timestamp: ts });
			continue;
		}

		if (role === "assistant") {
			const pending = ensureAssistant(ts);
			const content = message.content;
			if (Array.isArray(content)) {
				for (const part of content) {
					if (!part || typeof part !== "object") continue;
					const block = part as Record<string, unknown>;
					if (block.type === "text" && typeof block.text === "string") {
						pending.content = pending.content ? `${pending.content}\n${block.text}` : block.text;
						pendingStream.push({ kind: "text", text: block.text, at: ts });
					} else if (block.type === "thinking" && typeof block.thinking === "string") {
						pending.thinking = pending.thinking ? `${pending.thinking}\n${block.thinking}` : block.thinking;
						pendingStream.push({ kind: "thinking", text: block.thinking, at: ts });
					} else if (block.type === "toolCall") {
						const toolCallId = typeof block.id === "string" ? block.id : "";
						const toolName = typeof block.name === "string" ? block.name : "tool";
						pending.tools = pending.tools ?? [];
						pending.tools.push({ toolCallId, toolName, args: block.arguments });
						pendingStream.push({
							kind: "tool",
							toolCallId,
							toolName,
							args: block.arguments,
							at: ts,
							endAt: ts,
						});
					}
				}
			} else if (typeof content === "string" && content) {
				pending.content = pending.content ? `${pending.content}\n${content}` : content;
				pendingStream.push({ kind: "text", text: content, at: ts });
			}
			pending.timestamp = ts;
			if (typeof message.stopReason === "string" && message.stopReason !== "toolUse") {
				finalizeAssistant();
			}
			continue;
		}

		if (role === "toolResult") {
			const pending = ensureAssistant(ts);
			const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
			const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
			const result = textFromContent(message.content) || message.content;
			const isError = Boolean(message.isError);
			pending.tools = pending.tools ?? [];
			const existing = pending.tools.find((t) => t.toolCallId === toolCallId);
			if (existing) {
				existing.result = result;
				existing.isError = isError;
			} else {
				pending.tools.push({ toolCallId, toolName, args: undefined, result, isError });
			}
			const segment = pendingStream.find((s) => s.kind === "tool" && s.toolCallId === toolCallId && s.result === undefined);
			if (segment && segment.kind === "tool") {
				segment.result = result;
				segment.isError = isError;
				segment.endAt = ts;
			} else if (!existing) {
				// toolCall block missing from the log (e.g. compacted away) — still
				// stream the result so the replay stays in order.
				pendingStream.push({ kind: "tool", toolCallId, toolName, args: undefined, result, isError, at: ts, endAt: ts });
			}
			continue;
		}
	}
	finalizeAssistant();

	return messages.filter((m) =>
		m.role === "user" ? !!m.content : m.content || m.thinking || (m.tools && m.tools.length > 0),
	);
}

// --- Panel reconstruction (workspace / wiki / profile) -----------------------
// The showcase replays not just the chat but the side panels' evolution. All
// keyframes carry `atMessage` = index into the exported messages array, so
// they must be extracted from the TRIMMED but PRE-TRUNCATION message list.

interface WorkspaceInitFile {
	path: string;
	content?: string;
	asset?: string;
	size: number;
	updatedAt: string;
}

interface WorkspaceKeyframe {
	atMessage: number;
	/** Tool call that produced this file state — the mock backend reveals the
	 *  file the moment that tool's tool_end is streamed. */
	toolCallId: string;
	path: string;
	content: string;
	change: "created" | "modified";
}

interface WikiKeyframe {
	atMessage: number;
	toolCallId: string;
	page: { path: string; title: string; content: string };
}

interface ProfileEvent {
	atMessage: number;
	toolCallId: string;
	summary: string;
}

interface CasePanels {
	workspace: {
		workspaceId: string;
		name: string;
		initial: WorkspaceInitFile[];
		keyframes: WorkspaceKeyframe[];
	} | null;
	wiki: { keyframes: WikiKeyframe[] };
	profile: {
		firstEventAt: number | null;
		events: ProfileEvent[];
		profile: unknown | null;
	};
}

const MAX_KEYFRAME_CONTENT = 60_000;
const MAX_INLINE_TEXT_FILE = 100_000;
const MAX_ASSET_FILE = 8 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
	".md", ".txt", ".json", ".jsonl", ".csv", ".tsv", ".py", ".js", ".mjs", ".ts",
	".html", ".css", ".sh", ".yaml", ".yml", ".xml", ".svg", ".tex", ".log",
]);

function readSessionCwd(filePath: string): { cwd: string; startedAt: number } | null {
	const raw = readFileSync(filePath, "utf-8");
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		const entry = JSON.parse(line) as Record<string, unknown>;
		if (entry.type === "session" && typeof entry.cwd === "string") {
			return { cwd: entry.cwd, startedAt: Date.parse(String(entry.timestamp ?? "")) || 0 };
		}
	}
	return null;
}

/** Extract workspace write/edit keyframes from tool calls. */
function extractWorkspaceKeyframes(
	messages: ShowcaseMessage[],
	cwd: string,
	rewrites: Array<[RegExp, string]>,
): WorkspaceKeyframe[] {
	const keyframes: WorkspaceKeyframe[] = [];
	const virtualFs = new Map<string, string>();
	messages.forEach((message, atMessage) => {
		if (message.role !== "assistant" || !message.tools) return;
		for (const tool of message.tools) {
			if (tool.isError) continue;
			const args = tool.args as Record<string, unknown> | undefined;
			if (!args || typeof args.path !== "string") continue;
			const absPath = args.path;
			if (!absPath.startsWith(cwd)) continue;
			const relPath = absPath.slice(cwd.length).replace(/^[/\\]+/, "");
			if (!relPath) continue;

			if (tool.toolName === "write" && typeof args.content === "string") {
				const content = truncateText(sanitizeText(args.content, rewrites), MAX_KEYFRAME_CONTENT);
				keyframes.push({ atMessage, toolCallId: tool.toolCallId, path: relPath, content, change: virtualFs.has(relPath) ? "modified" : "created" });
				virtualFs.set(relPath, content);
			} else if (tool.toolName === "edit" && Array.isArray(args.edits)) {
				let prior = virtualFs.get(relPath);
				if (prior === undefined) {
					// Edit targets a file the session didn't write (e.g. a
					// pre-existing .skills file excluded from the initial
					// snapshot). Seed the virtual FS from the current on-disk
					// content so the file preview resolves during replay; the
					// recorded edits typically no longer apply (their oldText
					// is already gone), which degrades gracefully to "final
					// state shown from the first edit".
					const abs = join(cwd, relPath);
					if (!existsSync(abs) || statSync(abs).size > MAX_KEYFRAME_CONTENT) continue;
					prior = readFileSync(abs, "utf-8");
				}
				let next = prior;
				for (const edit of args.edits as Array<Record<string, unknown>>) {
					const oldText = typeof edit.oldText === "string" ? edit.oldText : "";
					const newText = typeof edit.newText === "string" ? edit.newText : "";
					if (oldText && next.includes(oldText)) next = next.replace(oldText, newText);
				}
				const content = truncateText(sanitizeText(next, rewrites), MAX_KEYFRAME_CONTENT);
				keyframes.push({ atMessage, toolCallId: tool.toolCallId, path: relPath, content, change: "modified" });
				virtualFs.set(relPath, content);
			}
		}
	});
	return keyframes;
}

/** Snapshot files that existed in the workspace BEFORE the session started. */
function collectInitialFiles(
	cwd: string,
	sessionStartMs: number,
	keyframedPaths: Set<string>,
	caseAssetsDir: string,
	caseId: string,
	rewrites: Array<[RegExp, string]>,
	excludePaths: Set<string> = new Set(),
): WorkspaceInitFile[] {
	if (!existsSync(cwd)) return [];
	const files: WorkspaceInitFile[] = [];
	const cutoff = sessionStartMs - 30_000;
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			const stat = statSync(full);
			if (stat.mtimeMs > cutoff) continue; // created/modified during the session
			const relPath = relative(cwd, full).split("\\").join("/");
			if (keyframedPaths.has(relPath) || excludePaths.has(relPath)) continue;
			const ext = extname(entry.name).toLowerCase();
			const record: WorkspaceInitFile = {
				path: relPath,
				size: stat.size,
				updatedAt: stat.mtime.toISOString(),
			};
			if (TEXT_EXTENSIONS.has(ext) && stat.size <= MAX_INLINE_TEXT_FILE) {
				record.content = sanitizeText(readFileSync(full, "utf-8"), rewrites);
			} else if (stat.size <= MAX_ASSET_FILE) {
				const assetRel = join(caseAssetsDir, relPath);
				mkdirSync(dirname(assetRel), { recursive: true });
				copyFileSync(full, assetRel);
				record.asset = `cases/${caseId}/assets/${relPath}`;
			} else {
				continue; // too large — skip entirely
			}
			files.push(record);
		}
	};
	walk(cwd);
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Wiki keyframes: each successful l2_archive call contributes one page. */
function extractWikiKeyframes(messages: ShowcaseMessage[], rewrites: Array<[RegExp, string]>): WikiKeyframe[] {
	const keyframes: WikiKeyframe[] = [];
	messages.forEach((message, atMessage) => {
		if (message.role !== "assistant" || !message.tools) return;
		for (const tool of message.tools) {
			if (tool.toolName !== "l2_archive" || tool.isError) continue;
			const args = tool.args as Record<string, unknown> | undefined;
			if (!args || typeof args.title !== "string" || typeof args.content !== "string") continue;
			const resultText = typeof tool.result === "string" ? tool.result : "";
			const pathMatch = /Wiki 页面[::]\s*(\S+\.md)/.exec(resultText);
			const slug = args.title.toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);
			keyframes.push({
				atMessage,
				toolCallId: tool.toolCallId,
				page: {
					path: pathMatch?.[1] ?? `wiki/sources/${slug}.md`,
					title: sanitizeText(args.title, rewrites),
					content: truncateText(sanitizeText(args.content, rewrites), MAX_KEYFRAME_CONTENT),
				},
			});
		}
	});
	return keyframes;
}

/** Profile events + a sanitized snapshot of the current learner profile. */
function extractProfilePanel(
	messages: ShowcaseMessage[],
	dataDir: string,
	rewrites: Array<[RegExp, string]>,
): CasePanels["profile"] {
	const events: ProfileEvent[] = [];
	messages.forEach((message, atMessage) => {
		if (message.role !== "assistant" || !message.tools) return;
		for (const tool of message.tools) {
			if (tool.toolName !== "record_learning_event" || tool.isError) continue;
			const args = tool.args as Record<string, unknown> | undefined;
			const payload = (args?.payload ?? {}) as Record<string, unknown>;
			const topic = typeof payload.milestone === "string" ? payload.milestone
				: typeof payload.topic === "string" ? payload.topic
				: typeof args?.event_type === "string" ? args.event_type : "learning event";
			events.push({ atMessage, toolCallId: tool.toolCallId, summary: sanitizeText(topic, rewrites) });
		}
	});
	let profile: unknown | null = null;
	if (events.length > 0) {
		const profilePath = join(dataDir, "learner", "profile.json");
		if (existsSync(profilePath)) {
			const raw = JSON.parse(readFileSync(profilePath, "utf-8")) as Record<string, unknown>;
			raw.learner_id = "demo-learner";
			profile = sanitizeValue(raw, rewrites);
		}
	}
	return {
		firstEventAt: events.length > 0 ? events[0].atMessage : null,
		events,
		profile,
	};
}

// --- Export pipeline ---------------------------------------------------------

function trimToUserTurns(messages: ShowcaseMessage[], maxUserTurns: number): ShowcaseMessage[] {
	let userTurns = 0;
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === "user") userTurns++;
		if (userTurns > maxUserTurns) return messages.slice(0, i);
	}
	return messages;
}

function polishMessages(messages: ShowcaseMessage[], rewrites: Array<[RegExp, string]>): ShowcaseMessage[] {
	return messages.map((m) => {
		const out: ShowcaseMessage = {
			role: m.role,
			content: truncateText(sanitizeText(m.content, rewrites), 20000),
			timestamp: m.timestamp,
		};
		if (m.thinking) out.thinking = truncateText(sanitizeText(m.thinking, rewrites), LIMITS.thinking);
		const polishArgs = (args: unknown): unknown => {
			const clean = sanitizeValue(args, rewrites);
			const argsJson = JSON.stringify(clean);
			if (argsJson && argsJson.length > LIMITS.toolArgs && clean && typeof clean === "object") {
				// Shrink oversized string fields inside args (usually file contents).
				for (const [k, v] of Object.entries(clean as Record<string, unknown>)) {
					if (typeof v === "string" && v.length > 2000) {
						(clean as Record<string, unknown>)[k] = truncateText(v, 2000);
					}
				}
			}
			return clean;
		};
		const polishResult = (result: unknown): unknown =>
			typeof result === "string"
				? truncateText(sanitizeText(result, rewrites), LIMITS.toolResult)
				: sanitizeValue(result, rewrites);
		if (m.tools?.length) {
			out.tools = m.tools.map((tool) => {
				const record: ShowcaseToolRecord = {
					toolCallId: tool.toolCallId,
					toolName: tool.toolName,
					args: polishArgs(tool.args),
				};
				if (tool.result !== undefined) record.result = polishResult(tool.result);
				if (tool.isError) record.isError = true;
				return record;
			});
		}
		if (m.stream?.length) {
			out.stream = m.stream.map((seg) => {
				if (seg.kind === "thinking") {
					return { kind: "thinking", text: truncateText(sanitizeText(seg.text, rewrites), LIMITS.thinking), at: seg.at };
				}
				if (seg.kind === "text") {
					return { kind: "text", text: truncateText(sanitizeText(seg.text, rewrites), 20000), at: seg.at };
				}
				const tool: ShowcaseStreamSegment = {
					kind: "tool",
					toolCallId: seg.toolCallId,
					toolName: seg.toolName,
					args: polishArgs(seg.args),
					at: seg.at,
					endAt: seg.endAt,
				};
				if (seg.result !== undefined) tool.result = polishResult(seg.result);
				if (seg.isError) tool.isError = true;
				return tool;
			});
		}
		return out;
	});
}

function main(): void {
	const args = process.argv.slice(2);
	const flag = (name: string, fallback: string): string => {
		const idx = args.indexOf(`--${name}`);
		return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
	};
	const sessionsDir = resolve(flag("sessions-dir", join(repoRoot, "runtime/data/sessions")));
	const dataDir = resolve(flag("data-dir", join(repoRoot, "runtime/data")));
	const outDir = resolve(flag("out", join(repoRoot, "apps/showcase/public/cases")));
	const only = flag("only", "").split(",").map((s) => s.trim()).filter(Boolean);

	const rewrites = buildPathRewrites();
	mkdirSync(outDir, { recursive: true });

	const index: Array<Record<string, unknown>> = [];
	for (const spec of CASES) {
		if (only.length > 0 && !only.includes(spec.id)) continue;
		const sessionPath = join(sessionsDir, spec.sessionFile);
		if (!existsSync(sessionPath)) {
			console.warn(`[skip] ${spec.id}: session file not found: ${sessionPath}`);
			continue;
		}
		let rawMessages = parseSessionMessages(sessionPath);
		if (spec.maxUserTurns) rawMessages = trimToUserTurns(rawMessages, spec.maxUserTurns);

		// Panels first — keyframe indices must align with the trimmed message
		// list, and file contents must be captured before polishMessages
		// truncates tool args.
		const sessionInfo = readSessionCwd(sessionPath);
		let workspacePanel: CasePanels["workspace"] = null;
		if (sessionInfo) {
			const wsKeyframes = extractWorkspaceKeyframes(rawMessages, sessionInfo.cwd, rewrites);
			const initial = collectInitialFiles(
				sessionInfo.cwd,
				sessionInfo.startedAt,
				new Set(wsKeyframes.map((k) => k.path)),
				join(outDir, spec.id, "assets"),
				spec.id,
				rewrites,
				new Set(spec.excludePaths ?? []),
			);
			workspacePanel = {
				workspaceId: `ws-${spec.id}`,
				name: spec.workspaceName ?? basename(sessionInfo.cwd),
				initial,
				keyframes: wsKeyframes,
			};
		}
		const wikiPanel = { keyframes: extractWikiKeyframes(rawMessages, rewrites) };
		const profilePanel = extractProfilePanel(rawMessages, dataDir, rewrites);

		const messages = polishMessages(rawMessages, rewrites);

		const recordedAt = spec.sessionFile.slice(0, 10);
		const caseDoc = {
			id: spec.id,
			title: spec.title,
			titleEn: spec.titleEn,
			description: spec.description,
			tags: spec.tags,
			recordedAt,
			messageCount: messages.length,
			messages,
			panels: {
				workspace: workspacePanel,
				wiki: wikiPanel,
				profile: profilePanel,
			},
		};
		const outPath = join(outDir, `${spec.id}.json`);
		writeFileSync(outPath, JSON.stringify(caseDoc));
		const sizeKb = Math.round(JSON.stringify(caseDoc).length / 1024);
		index.push({
			id: spec.id,
			title: spec.title,
			titleEn: spec.titleEn,
			description: spec.description,
			tags: spec.tags,
			recordedAt,
			messageCount: messages.length,
		});
		console.log(`[ok] ${spec.id}: ${messages.length} messages, ${sizeKb} KB -> ${basename(outPath)}`);
	}
	writeFileSync(join(outDir, "index.json"), JSON.stringify({ cases: index }, null, 2));
	console.log(`[done] ${index.length} case(s) exported to ${outDir}`);
	console.log("REMINDER: review the exported JSON for sensitive content before publishing.");
}

main();
