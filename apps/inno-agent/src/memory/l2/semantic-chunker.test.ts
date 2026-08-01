import { describe, expect, it } from "vitest";

import { splitSemanticChunks } from "./semantic-chunker.js";

describe("semantic L2 chunking", () => {
	it("keeps short content on the existing single-chunk path", () => {
		expect(splitSemanticChunks("short text")).toEqual(["short text"]);
	});

	it("prefers semantic boundaries and preserves the document tail", () => {
		const content = `${"A".repeat(1_200)}\n\n## 第二节\n${"B".repeat(1_200)}\n\nTAIL_FACT`;
		const chunks = splitSemanticChunks(content, { targetChars: 1_500, overlapChars: 50 });

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0]).toMatch(/\n\n$/);
		expect(chunks.at(-1)).toContain("TAIL_FACT");
		expect(chunks.every((chunk) => chunk.length <= 1_550)).toBe(true);
	});
});
