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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
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
}

const CASES: CaseSpec[] = [
	{
		id: "trig-handout",
		sessionFile: "2026-06-05T14-39-09-564Z_019e9839-40fc-7e36-9742-655ab4a46828.jsonl",
		title: "生成一份三角函数讲义",
		titleEn: "Generating a trigonometry handout",
		description: "学习者说明自己的薄弱点后，agent 先理论后练习，生成讲义并记录学习事件到 L1 画像。",
		tags: ["L1 学习者画像", "讲义生成", "个性化教学"],
		maxUserTurns: 6,
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
	[/\b(sk|pk|pat| Bearer)[-_A-Za-z0-9]{16,}\b/g, "[REDACTED]"],
	[/"(apiKey|token|accessToken|refreshToken|secret)"\s*:\s*"[^"]{6,}"/g, '"$1": "[REDACTED]"'],
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

interface ShowcaseMessage {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
	thinking?: string;
	tools?: ShowcaseToolRecord[];
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
	const finalizeAssistant = () => {
		if (pendingAssistant) {
			messages.push(pendingAssistant);
			pendingAssistant = null;
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
					} else if (block.type === "thinking" && typeof block.thinking === "string") {
						pending.thinking = pending.thinking ? `${pending.thinking}\n${block.thinking}` : block.thinking;
					} else if (block.type === "toolCall") {
						pending.tools = pending.tools ?? [];
						pending.tools.push({
							toolCallId: typeof block.id === "string" ? block.id : "",
							toolName: typeof block.name === "string" ? block.name : "tool",
							args: block.arguments,
						});
					}
				}
			} else if (typeof content === "string" && content) {
				pending.content = pending.content ? `${pending.content}\n${content}` : content;
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
			continue;
		}
	}
	finalizeAssistant();

	return messages.filter((m) =>
		m.role === "user" ? !!m.content : m.content || m.thinking || (m.tools && m.tools.length > 0),
	);
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
		if (m.tools?.length) {
			out.tools = m.tools.map((tool) => {
				const record: ShowcaseToolRecord = {
					toolCallId: tool.toolCallId,
					toolName: tool.toolName,
					args: sanitizeValue(tool.args, rewrites),
				};
				const argsJson = JSON.stringify(record.args);
				if (argsJson && argsJson.length > LIMITS.toolArgs && record.args && typeof record.args === "object") {
					// Shrink oversized string fields inside args (usually file contents).
					for (const [k, v] of Object.entries(record.args as Record<string, unknown>)) {
						if (typeof v === "string" && v.length > 400) {
							(record.args as Record<string, unknown>)[k] = truncateText(v, 400);
						}
					}
				}
				if (tool.result !== undefined) {
					record.result = typeof tool.result === "string"
						? truncateText(sanitizeText(tool.result, rewrites), LIMITS.toolResult)
						: sanitizeValue(tool.result, rewrites);
				}
				if (tool.isError) record.isError = true;
				return record;
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
		let messages = parseSessionMessages(sessionPath);
		if (spec.maxUserTurns) messages = trimToUserTurns(messages, spec.maxUserTurns);
		messages = polishMessages(messages, rewrites);

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
