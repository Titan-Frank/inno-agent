import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexAllSessions, indexSession } from "./indexer.js";
import { formatRecallForPrompt, recall } from "./recall.js";
import { openL3Store, segmentForFts, type L3Store } from "./sqlite-store.js";

/**
 * L3 tests. `segmentForFts` is a pure function and always runs. The store /
 * indexer / recall suites need node:sqlite (Node >= 22.5); on older runtimes
 * the whole point is that L3 degrades to disabled, so they skip conditionally.
 */
function nodeSqliteAvailable(): boolean {
	const [major, minor] = process.versions.node.split(".").map((v) => Number.parseInt(v, 10));
	return major > 22 || (major === 22 && minor >= 5);
}

describe("segmentForFts (pure)", () => {
	it("splits CJK runs into overlapping bigrams", () => {
		expect(segmentForFts("学习计划")).toBe("学习 习计 计划");
	});

	it("keeps ASCII runs whole and lowercased", () => {
		expect(segmentForFts("Python AsyncIO")).toBe("python asyncio");
	});

	it("handles mixed CJK/ASCII and punctuation (single CJK chars stay unigrams)", () => {
		expect(segmentForFts("用Node.js写爬虫")).toBe("用 node js 写爬 爬虫");
	});

	it("returns empty string for empty input", () => {
		expect(segmentForFts("")).toBe("");
	});
});

describe.skipIf(!nodeSqliteAvailable())("L3 store + recall (node:sqlite)", () => {
	let l3Dir: string;
	let sessionDir: string;
	let store: L3Store | null;

	beforeEach(async () => {
		l3Dir = mkdtempSync(join(tmpdir(), "inno-l3-db-"));
		sessionDir = mkdtempSync(join(tmpdir(), "inno-l3-sess-"));
		store = await openL3Store(l3Dir);
		expect(store).not.toBeNull();
	});

	afterEach(() => {
		store?.close();
		rmSync(l3Dir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	});

	function upsert(sessionId: string, texts: string[], role: "user" | "assistant" = "user") {
		store!.upsertChunks(
			texts.map((text, i) => ({
				id: `${sessionId}:${i}`,
				sessionId,
				role,
				text,
				ts: Date.parse("2026-08-01T10:00:00Z") + i,
			})),
		);
	}

	it("upserts chunks and finds them via CJK bigram search", () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		const hits = store!.searchLexical("机器学习");
		expect(hits).toHaveLength(1);
		expect(hits[0].sessionId).toBe("s1");
		expect(hits[0].bm25).toBeLessThan(0);
	});

	it("returns no hits for lexically absent queries", () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		expect(store!.searchLexical("烹饪食谱")).toHaveLength(0);
	});

	it("recall gates on coverage: unrelated queries inject nothing", () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		expect(recall(store, "机器学习")).toHaveLength(1);
		expect(recall(store, "烹饪食谱")).toHaveLength(0);
	});

	it("recall rejects too-short queries (single CJK char)", () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		expect(recall(store, "机")).toHaveLength(0);
	});

	it("recall excludes the active session", () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		expect(recall(store, "机器学习", { excludeSessionId: "s1" })).toHaveLength(0);
	});

	it("recall dedups near-identical snippets", () => {
		const text = "我们在整理机器学习的学习笔记和公式推导";
		upsert("s1", [text]);
		upsert("s2", [text]);
		const results = recall(store, "机器学习");
		expect(results).toHaveLength(1);
	});

	it("recall on a null store degrades to empty", () => {
		expect(recall(null, "机器学习")).toEqual([]);
	});

	it("deleteSession removes chunks, FTS rows, and index state", () => {
		upsert("s1", ["我们在整理机器学习的学习笔记和公式推导"]);
		store!.setIndexState("s1", 100, 200, 1);
		expect(store!.chunkCount()).toBe(1);

		store!.deleteSession("s1");

		expect(store!.chunkCount()).toBe(0);
		expect(store!.searchLexical("机器学习")).toHaveLength(0);
		expect(store!.getIndexState("s1")).toBeNull();
	});

	it("index state round-trips", () => {
		expect(store!.getIndexState("s1")).toBeNull();
		store!.setIndexState("s1", 123, 456, 7);
		expect(store!.getIndexState("s1")).toEqual({ lastOffset: 123, lastMtimeMs: 456, chunkCount: 7 });
	});

	function writeSession(name: string, lines: unknown[]): string {
		const path = join(sessionDir, name);
		writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
		return path;
	}

	function messageEvent(role: string, text: string, stopReason?: string) {
		return {
			type: "message",
			timestamp: "2026-08-01T10:00:00Z",
			message: { role, content: [{ type: "text", text }], ...(stopReason ? { stopReason } : {}) },
		};
	}

	it("indexSession extracts user/assistant text and skips thinking/toolCall noise", () => {
		const path = writeSession("sess_a.jsonl", [
			messageEvent("user", "今天学习了机器学习的基础概念"),
			{
				type: "message",
				timestamp: "2026-08-01T10:00:01Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "内部推理不应进索引" },
						{ type: "text", text: "好的，我们从梯度下降开始复习" },
					],
					stopReason: "stop",
				},
			},
			{ type: "message", timestamp: "2026-08-01T10:00:02Z", message: { role: "toolResult", content: "noise" } },
		]);

		const written = indexSession(store!, path);
		expect(written).toBe(2);
		expect(store!.chunkCount()).toBe(2);
		expect(store!.searchLexical("机器学习")).toHaveLength(1);
		expect(store!.searchLexical("内部推理")).toHaveLength(0);
	});

	it("indexSession skips unchanged files (mtime-gated incremental indexing)", () => {
		const path = writeSession("sess_b.jsonl", [messageEvent("user", "今天学习了机器学习的基础概念")]);
		expect(indexSession(store!, path)).toBe(1);
		// Same mtime → skipped entirely.
		expect(indexSession(store!, path)).toBe(0);
	});

	it("indexAllSessions backfills a directory of session files", () => {
		writeSession("sess_c.jsonl", [messageEvent("user", "今天学习了机器学习的基础概念")]);
		writeSession("sess_d.jsonl", [messageEvent("user", "晚上复习了线性代数的特征值分解")]);
		writeFileSync(join(sessionDir, "not-a-session.txt"), "ignored", "utf-8");

		const summary = indexAllSessions(store!, sessionDir);
		expect(summary).toEqual({ sessions: 2, chunks: 2 });
	});

	it("end-to-end: indexed history is recallable from a later session", () => {
		writeSession("sess_old.jsonl", [messageEvent("user", "上周我们讨论了机器学习的学习笔记")]);
		indexAllSessions(store!, sessionDir);

		const results = recall(store, "机器学习", { excludeSessionId: "sess_new.jsonl" });
		expect(results).toHaveLength(1);
		const promptSection = formatRecallForPrompt(results);
		expect(promptSection).toContain("相关历史对话");
		expect(promptSection).toContain("机器学习");
	});

	it("formatRecallForPrompt returns empty string when there is nothing to inject", () => {
		expect(formatRecallForPrompt([])).toBe("");
	});
});
