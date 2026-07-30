import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeText } from "../../storage/file-store.js";
import { runL2Lint } from "./l2-lint.js";
import { upsertManifest } from "./manifest-store.js";
import { serializeFrontmatter } from "./wiki-maintainer.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-l2-lint-"));
	tempDirs.push(dir);
	return dir;
}

function page(sourceId = "l2src_clean", body = "# Clean\n\nNo links."): string {
	return `${serializeFrontmatter({
		title: "Clean",
		created: "2026-07-30",
		type: "concept",
		tags: ["concept"],
		sources: ["raw/uploads/source.md"],
		source_ids: [sourceId],
		updated: "2026-07-30",
		status: "draft",
		confidence: "medium",
	})}\n${body}`;
}

function writeCleanFixture(root: string): void {
	writeText(join(root, "raw/uploads/source.md"), "raw");
	writeText(join(root, "extracted/source.md"), "extracted");
	writeText(join(root, "wiki/concepts/clean.md"), page());
	writeText(join(root, "wiki/index.md"), "- [[Clean]] — `wiki/concepts/clean.md`\n");
	upsertManifest(root, {
		id: "l2src_clean",
		title: "Clean source",
		sourceType: "markdown",
		rawPath: "raw/uploads/source.md",
		extractedPath: "extracted/source.md",
		wikiPages: ["wiki/concepts/clean.md"],
		tags: [],
		contentHash: "cleanhash",
		status: "indexed",
		source: { origin: "user_upload" },
		createdAt: "2026-07-30T00:00:00.000Z",
		updatedAt: "2026-07-30T00:00:00.000Z",
	});
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("L2 structural lint", () => {
	it("returns a clean report for a traceable indexed page", () => {
		const root = makeTempDir();
		writeCleanFixture(root);
		expect(runL2Lint(root)).toMatchObject({ pagesChecked: 1, sourcesChecked: 1, errors: 0, warnings: 0, findings: [] });
	});

	it("reports malformed pages, dangling links, provenance, source, manifest, and index drift", () => {
		const root = makeTempDir();
		writeCleanFixture(root);
		writeText(join(root, "wiki/concepts/broken.md"), "# Missing metadata\n\nSee [[Unknown Topic]].");
		writeText(join(root, "wiki/entities/invalid.md"), "---\ntitle: [unterminated\n---\ninvalid");
		writeText(join(root, "wiki/index.md"), "- [[Ghost]] — `wiki/concepts/ghost.md`\n");
		upsertManifest(root, {
			id: "l2src_incomplete",
			title: "Broken source",
			sourceType: "markdown",
			rawPath: "raw/uploads/missing.md",
			extractedPath: "extracted/missing.md",
			wikiPages: ["wiki/concepts/missing.md"],
			tags: [],
			contentHash: "missinghash",
			status: "error",
			source: { origin: "user_upload" },
			createdAt: "2026-07-30T00:00:00.000Z",
			updatedAt: "2026-07-30T00:00:00.000Z",
		});

		const codes = runL2Lint(root).findings.map((item) => item.code);
		expect(codes).toEqual(expect.arrayContaining([
			"missing_frontmatter",
			"invalid_frontmatter",
			"dangling_link",
			"missing_source_file",
			"manifest_page_missing",
			"index_missing_page",
			"index_stale_page",
			"incomplete_archive",
		]));
	});

	it("reports unknown source ids without changing the page", () => {
		const root = makeTempDir();
		writeCleanFixture(root);
		const path = join(root, "wiki/concepts/clean.md");
		writeText(path, page("l2src_unknown"));
		const before = readFileSync(path, "utf8");

		expect(runL2Lint(root).findings).toContainEqual(expect.objectContaining({ code: "unknown_source_id" }));
		expect(readFileSync(path, "utf8")).toBe(before);
	});
});
