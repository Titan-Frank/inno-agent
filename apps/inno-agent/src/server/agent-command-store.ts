import { readJson, writeJson } from "../storage/file-store.js";
import type { SessionMessageSummary } from "./session-model.js";

/**
 * The runtime expands Inno's Agent commands before the PI SDK persists a user
 * message. Keep the original command in a small session sidecar so the web UI
 * can render the sent message as an atomic command bubble while the model
 * still receives the expanded instruction.
 */
export interface SessionAgentCommandEntry {
	commandContent: string;
	expandedContent: string;
	timestamp: number;
}

export type SessionAgentCommandsMetadata = Record<string, SessionAgentCommandEntry[]>;

let cache: SessionAgentCommandsMetadata | null = null;

function read(dataDir: string): SessionAgentCommandsMetadata {
	if (cache === null) {
		cache = readJson<SessionAgentCommandsMetadata>(agentCommandsMetadataPath(dataDir), {});
	}
	return cache;
}

function write(dataDir: string, metadata: SessionAgentCommandsMetadata): void {
	cache = metadata;
	writeJson(agentCommandsMetadataPath(dataDir), metadata);
}

export function agentCommandsMetadataPath(dataDir: string): string {
	return `${dataDir}/sessions/agent-commands.json`.replaceAll("\\", "/");
}

export function resetAgentCommandStoreForTests(): void {
	cache = null;
}

export function recordSessionAgentCommand(
	dataDir: string,
	sessionId: string,
	entry: SessionAgentCommandEntry,
): void {
	if (!sessionId) return;
	const metadata = { ...read(dataDir) };
	metadata[sessionId] = [...(metadata[sessionId] ?? []), entry];
	write(dataDir, metadata);
}

export function clearSessionAgentCommands(dataDir: string, sessionId: string): void {
	const metadata = read(dataDir);
	if (!(sessionId in metadata)) return;
	const next = { ...metadata };
	delete next[sessionId];
	write(dataDir, next);
}

const EXPANDED_COMMANDS = [
	{
		command: "/recall",
		bare: "请使用 l3_recall 工具回顾我们之前的对话，总结一下最近学过的重点。",
		prefix: "请使用 l3_recall 工具检索我们过去的对话，并结合检索结果回答：",
	},
	{
		command: "/remember",
		bare: "我想让你记住一些关于我学习情况的信息（学习者画像 L1）。请问我需要告诉你什么？",
		prefix: "请将以下关于我的信息记录到学习者画像（L1），并简短确认你记住了什么：",
	},
	{
		command: "/wiki",
		bare: "请使用 l2_query 工具查看 Wiki 知识库的索引概览，告诉我里面都归档了哪些内容。",
		prefix: "请使用 l2_query 工具检索 Wiki 知识库，并结合检索结果回答：",
	},
] as const;

/** Recover commands persisted before the sidecar was introduced. */
function collapseLegacyExpandedCommand(content: string): string | null {
	const text = content.trim();
	for (const entry of EXPANDED_COMMANDS) {
		if (text === entry.bare) return entry.command;
		if (text.startsWith(entry.prefix)) {
			const args = text.slice(entry.prefix.length).trim();
			if (args) return `${entry.command} ${args}`;
		}
	}
	return null;
}

/**
 * Restore original Agent command text in presentation-facing session
 * messages. Entries are matched FIFO, which keeps repeated identical
 * commands associated with the correct turn and mirrors attachment metadata.
 */
export function mergeSessionAgentCommands(
	dataDir: string,
	sessionId: string,
	messages: SessionMessageSummary[],
): SessionMessageSummary[] {
	const entries = read(dataDir)[sessionId];
	const pending = [...(entries ?? [])];
	return messages.map((message) => {
		if (message.role !== "user") return message;
		if (pending.length > 0) {
			const index = pending.findIndex((entry) =>
				entry.expandedContent === message.content || entry.commandContent === message.content,
			);
			if (index !== -1) {
				const [entry] = pending.splice(index, 1);
				return { ...message, content: entry.commandContent };
			}
		}
		const legacyCommand = collapseLegacyExpandedCommand(message.content);
		return legacyCommand ? { ...message, content: legacyCommand } : message;
	});
}
