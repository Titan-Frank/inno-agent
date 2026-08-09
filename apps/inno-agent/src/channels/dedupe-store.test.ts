import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DedupeStore } from "./dedupe-store.js";

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "inno-dedupe-"));
	file = join(dir, "dedupe.jsonl");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("DedupeStore", () => {
	it("treats an unmarked message as new and a marked one as duplicate", () => {
		const store = new DedupeStore(file);
		expect(store.isDuplicate("feishu", "msg-1")).toBe(false);
		store.mark("feishu", "msg-1");
		expect(store.isDuplicate("feishu", "msg-1")).toBe(true);
	});

	it("scopes duplicates per channel", () => {
		const store = new DedupeStore(file);
		store.mark("feishu", "msg-1");
		expect(store.isDuplicate("qq", "msg-1")).toBe(false);
	});

	it("persists marks across instances (process restart)", () => {
		new DedupeStore(file).mark("feishu", "msg-1");
		const reloaded = new DedupeStore(file);
		expect(reloaded.isDuplicate("feishu", "msg-1")).toBe(true);
	});

	it("expires entries past their TTL", () => {
		const store = new DedupeStore(file, /* ttlMs */ -1);
		store.mark("feishu", "msg-1");
		expect(store.isDuplicate("feishu", "msg-1")).toBe(false);
	});

	it("does not load expired entries from disk", () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		writeFileSync(
			file,
			JSON.stringify({ key: "feishu:msg-old", seenAt: past, expiresAt: past }) + "\n",
			"utf-8",
		);
		const store = new DedupeStore(file);
		expect(store.isDuplicate("feishu", "msg-old")).toBe(false);
	});

	it("cleanup() drops expired in-memory entries", () => {
		const store = new DedupeStore(file, /* ttlMs */ -1);
		store.mark("feishu", "msg-1");
		store.cleanup();
		expect(store.isDuplicate("feishu", "msg-1")).toBe(false);
	});
});
