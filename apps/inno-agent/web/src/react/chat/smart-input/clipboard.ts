import type { SmartInputRule } from "../../../types/settings.js";
import type { Slot } from "./engine.js";

export const SMART_BUBBLE_CLIPBOARD_TYPE = "application/x-inno-agent-smart-bubble";
export const SMART_BUBBLE_CLIPBOARD_VERSION = 1;

export interface SmartBubbleClipboardFile {
	name: string;
	path: string;
	/** Workspace files can be rebound by path; local files need the in-memory cache when available. */
	source: "workspace" | "local";
	cacheKey?: string;
}

export interface SmartBubbleClipboardBubble {
	start: number;
	end: number;
	word: string;
	rule: SmartInputRule;
	files: SmartBubbleClipboardFile[];
}

export interface SmartBubbleClipboardPayload {
	version: number;
	text: string;
	clipboardId: string;
	bubbles: SmartBubbleClipboardBubble[];
}

/**
 * Local files cannot ride along in a JSON clipboard payload, so copies stash
 * them in this bounded per-clipboardId cache. Pasting within the same page
 * lifetime can therefore restore the staged File objects; pasting elsewhere
 * falls back to the plain-text names.
 */
let smartBubbleClipboardSequence = 0;
const smartBubbleClipboardFiles = new Map<string, Map<string, File>>();

export function nextClipboardId(): string {
	return `smart-bubble-${Date.now()}-${smartBubbleClipboardSequence++}`;
}

export function rememberClipboardFiles(clipboardId: string, files: Map<string, File>): void {
	if (files.size === 0) return;
	smartBubbleClipboardFiles.set(clipboardId, files);
	while (smartBubbleClipboardFiles.size > 16) {
		const oldest = smartBubbleClipboardFiles.keys().next().value;
		if (typeof oldest !== "string") break;
		smartBubbleClipboardFiles.delete(oldest);
	}
}

export function clipboardFilesFor(clipboardId: string): Map<string, File> | undefined {
	return smartBubbleClipboardFiles.get(clipboardId);
}

/**
 * Build the copy payload for a selection: the plain-text projection (bubbles
 * replaced by their words) plus per-bubble file descriptors. Pure with respect
 * to the engine — callers pass the current value, selection and token ranges.
 */
export function buildClipboardPayload(
	value: string,
	selectionStart: number,
	selectionEnd: number,
	tokenRanges: Array<[number, number, number]>,
	slots: Slot[],
): SmartBubbleClipboardPayload | null {
	const selectedStart = Math.max(0, Math.min(value.length, Math.min(selectionStart, selectionEnd)));
	const selectedEnd = Math.max(0, Math.min(value.length, Math.max(selectionStart, selectionEnd)));
	const ranges = tokenRanges
		.filter(([start, end]) => start >= selectedStart && end <= selectedEnd)
		.sort(([a], [b]) => a - b);
	if (ranges.length === 0) return null;

	const clipboardId = nextClipboardId();
	const cachedFiles = new Map<string, File>();
	const bubbles: SmartBubbleClipboardBubble[] = [];
	let text = "";
	let cursor = selectedStart;
	let cacheIndex = 0;
	for (const [start, end, slotId] of ranges) {
		const slot = slots.find((entry) => entry.id === slotId);
		if (!slot) continue;
		text += value.slice(cursor, start);
		const bubbleStart = text.length;
		text += slot.word;
		const files = slot.files.map((file) => {
			const isWorkspace = file.state === "workspace";
			const cacheKey = !isWorkspace && file.file ? String(cacheIndex++) : undefined;
			if (cacheKey && file.file) cachedFiles.set(cacheKey, file.file);
			return {
				name: file.name,
				path: file.path,
				source: isWorkspace ? "workspace" as const : "local" as const,
				...(cacheKey ? { cacheKey } : {}),
			};
		});
		bubbles.push({ start: bubbleStart, end: text.length, word: slot.word, rule: slot.rule, files });
		cursor = end;
	}
	text += value.slice(cursor, selectedEnd);
	if (bubbles.length === 0) return null;

	rememberClipboardFiles(clipboardId, cachedFiles);
	return { version: SMART_BUBBLE_CLIPBOARD_VERSION, text, clipboardId, bubbles };
}

/**
 * Validate an untrusted clipboard payload. `resolveRule` maps the carried rule
 * (or the bubble word) onto a live rule so stale settings cannot resurrect a
 * disabled preset.
 */
export function parseClipboardPayload(
	raw: string,
	resolveRule: (raw: unknown, word: string) => SmartInputRule | null,
): SmartBubbleClipboardPayload | null {
	try {
		const parsed = JSON.parse(raw) as Partial<SmartBubbleClipboardPayload>;
		if (parsed.version !== SMART_BUBBLE_CLIPBOARD_VERSION || typeof parsed.text !== "string" || !Array.isArray(parsed.bubbles)) return null;
		const text = parsed.text;
		const rawBubbles = parsed.bubbles;
		const bubbles = rawBubbles
			.map((rawBubble): SmartBubbleClipboardBubble | null => {
				if (!rawBubble || typeof rawBubble !== "object") return null;
				const bubble = rawBubble as Partial<SmartBubbleClipboardBubble>;
				const start = bubble.start;
				const end = bubble.end;
				if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return null;
				const word = bubble.word;
				if (typeof word !== "string" || !word || text.slice(start, end) !== word) return null;
				const rule = resolveRule(bubble.rule, word);
				if (!rule) return null;
				const files = Array.isArray(bubble.files)
					? bubble.files.flatMap((rawFile) => {
						if (!rawFile || typeof rawFile !== "object") return [];
						const file = rawFile as Partial<SmartBubbleClipboardFile>;
						if (typeof file.name !== "string" || typeof file.path !== "string") return [];
						return [{
							name: file.name,
							path: file.path,
							source: file.source === "workspace" ? "workspace" as const : "local" as const,
							...(typeof file.cacheKey === "string" ? { cacheKey: file.cacheKey } : {}),
						}];
					})
					: [];
				return { start, end, word, rule, files };
			})
			.filter((bubble): bubble is SmartBubbleClipboardBubble => bubble !== null)
			.filter((bubble) => bubble.end <= text.length)
			.sort((a, b) => a.start - b.start);
		if (bubbles.some((bubble, index) => index > 0 && bubble.start < bubbles[index - 1]!.end)) return null;
		return {
			version: parsed.version,
			text,
			clipboardId: typeof parsed.clipboardId === "string" ? parsed.clipboardId : "",
			bubbles,
		};
	} catch {
		return null;
	}
}
