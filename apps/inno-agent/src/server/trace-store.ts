import { readJson, writeJson } from "../storage/file-store.js";
import type { StreamEventEnvelope } from "../chat/stream-registry.js";
import type { SessionMessageSummary, SessionTraceEvent } from "./session-model.js";

/** UI-only trace storage. PI owns the session JSONL; this sidecar is deliberately
 * kept out of the model context and can be dropped without damaging a session. */
export interface SessionTraceEntry {
	/** Index of the assistant message in the parsed visible session history. */
	assistantIndex: number;
	/** Stable PI session-tree entry id when the parser can provide one. */
	assistantMessageId?: string;
	startedAt?: string;
	finishedAt?: string;
	events: SessionTraceEvent[];
}

export type SessionTraceMetadata = Record<string, SessionTraceEntry[]>;

let cache: SessionTraceMetadata | null = null;

export function traceMetadataPath(dataDir: string): string {
	return `${dataDir}/sessions/traces.json`.replaceAll("\\", "/");
}

function read(dataDir: string): SessionTraceMetadata {
	if (cache === null) cache = readJson<SessionTraceMetadata>(traceMetadataPath(dataDir), {});
	return cache;
}

function write(dataDir: string, metadata: SessionTraceMetadata): void {
	cache = metadata;
	writeJson(traceMetadataPath(dataDir), metadata);
}

export function resetTraceStoreForTests(): void {
	cache = null;
}

export function recordSessionTrace(
	dataDir: string,
	sessionId: string,
	entry: {
		assistantIndex: number;
		assistantMessageId?: string;
		startedAt?: string;
		finishedAt?: string;
		events: StreamEventEnvelope[];
	},
): void {
	if (!sessionId || entry.assistantIndex < 0) return;
	const metadata = { ...read(dataDir) };
	const normalizedEvents = entry.events.map((envelope) => ({
		eventId: envelope.eventId,
		...(envelope.traceId ? { traceId: envelope.traceId } : {}),
		...(envelope.occurredAt ? { occurredAt: envelope.occurredAt } : {}),
		event: envelope.event as Record<string, unknown>,
	}));
	const nextEntry: SessionTraceEntry = {
		assistantIndex: entry.assistantIndex,
		...(entry.assistantMessageId ? { assistantMessageId: entry.assistantMessageId } : {}),
		...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
		...(entry.finishedAt ? { finishedAt: entry.finishedAt } : {}),
		events: normalizedEvents,
	};
	metadata[sessionId] = [
		...(metadata[sessionId] ?? []).filter((item) => item.assistantIndex !== entry.assistantIndex),
		nextEntry,
	];
	write(dataDir, metadata);
}

export function mergeSessionTraces(
	dataDir: string,
	sessionId: string,
	messages: SessionMessageSummary[],
): SessionMessageSummary[] {
	const entries = read(dataDir)[sessionId];
	if (!entries?.length) return messages;
	const byIndex = new Map(entries.map((entry) => [entry.assistantIndex, entry]));
	return messages.map((message, index) => {
		const byId = message.role === "assistant" && message.entryId
			? entries.find((candidate) => candidate.assistantMessageId === message.entryId)
			: undefined;
		const byPosition = byIndex.get(index);
		// Position is only a compatibility fallback for old sidecars that were
		// written before assistant message ids were recorded. Once an entry has
		// an id, never let a branched session inherit it by index.
		const entry = byId ?? (byPosition && !byPosition.assistantMessageId ? byPosition : undefined);
		if (!entry || message.role !== "assistant") return message;
		return {
			...message,
			traceEvents: entry.events,
			traceStartedAt: entry.startedAt,
			traceFinishedAt: entry.finishedAt,
		};
	});
}

export function clearSessionTraces(dataDir: string, sessionId: string): void {
	const metadata = read(dataDir);
	if (!(sessionId in metadata)) return;
	const next = { ...metadata };
	delete next[sessionId];
	write(dataDir, next);
}
