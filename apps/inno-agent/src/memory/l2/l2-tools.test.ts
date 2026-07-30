import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { L2Memory } from "./l2-memory.js";
import { createL2Tools } from "./l2-tools.js";
import { readManifest } from "./manifest-store.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-l2-tools-"));
	tempDirs.push(dir);
	return dir;
}

function fakeMemory(root: string): L2Memory {
	return {
		dataDir: root,
		indexPageByPath: vi.fn().mockResolvedValue(undefined),
	} as unknown as L2Memory;
}

async function archive(root: string, content: string) {
	const tool = createL2Tools(root, undefined, fakeMemory(root))[0];
	return (tool.execute as (...args: any[]) => Promise<any>)(
		"call-1",
		{ title: "学习资料", content, sourceType: "markdown", tags: ["test"] },
		undefined,
		undefined,
		{ model: undefined, modelRegistry: undefined },
	);
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("l2_archive", () => {
	it("writes traceable raw, extracted, manifest, and wiki records", async () => {
		const root = makeTempDir();
		await archive(root, "正文包含 [[间隔重复]] 概念。");

		const entries = readManifest(root);
		expect(entries).toHaveLength(1);
		expect(entries[0].status).toBe("indexed");
		expect(readFileSync(join(root, entries[0].rawPath), "utf8")).toContain("间隔重复");
		expect(readFileSync(join(root, entries[0].extractedPath!), "utf8")).toContain("间隔重复");
		expect(entries[0].wikiPages.length).toBeGreaterThan(0);
		for (const pagePath of entries[0].wikiPages) {
			expect(readFileSync(join(root, pagePath), "utf8")).toContain(entries[0].id);
		}
	});

	it("deduplicates repeated content by hash", async () => {
		const root = makeTempDir();
		await archive(root, "完全相同的资料");
		const duplicate = await archive(root, "完全相同的资料");

		expect(readManifest(root)).toHaveLength(1);
		expect(duplicate.details).toMatchObject({ duplicate: true });
	});

	it("discovers a linked concept near the end of a long source without a model", async () => {
		const root = makeTempDir();
		const content = `${"前置内容。\n\n".repeat(6_000)}末尾定义 [[尾部概念]]。`;
		await archive(root, content);

		const entry = readManifest(root)[0];
		const linkedPage = entry.wikiPages.find((pagePath) => pagePath.includes("尾部概念"));
		expect(linkedPage).toBeDefined();
		expect(readFileSync(join(root, linkedPage!), "utf8")).toContain(entry.id);
	});
});
