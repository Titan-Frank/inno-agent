export interface StructuralChunkOptions {
	targetChars?: number;
	overlapChars?: number;
}

const DEFAULT_TARGET_CHARS = 24_000;
const DEFAULT_OVERLAP_CHARS = 400;
const MIN_CHUNK_RATIO = 0.6;

function lastBoundary(content: string, start: number, hardEnd: number): number {
	const minEnd = Math.min(hardEnd, start + Math.floor((hardEnd - start) * MIN_CHUNK_RATIO));
	const window = content.slice(minEnd, hardEnd);
	const candidates = [
		window.lastIndexOf("\n#"),
		window.lastIndexOf("\n\n"),
		Math.max(
			window.lastIndexOf("。"),
			window.lastIndexOf("！"),
			window.lastIndexOf("？"),
			window.lastIndexOf(". "),
			window.lastIndexOf("! "),
			window.lastIndexOf("? "),
		),
	];
	const relative = Math.max(...candidates);
	if (relative < 0) return hardEnd;
	return minEnd + relative + (window.startsWith("\n#", relative) ? 1 : 2);
}

/**
 * Split text without dropping content. Breaks prefer headings, paragraphs and
 * sentence endings; a small read-only overlap gives adjacent chunks context.
 */
export function splitStructuralChunks(content: string, options: StructuralChunkOptions = {}): string[] {
	if (!content) return [];
	const targetChars = Math.max(1_000, Math.trunc(options.targetChars ?? DEFAULT_TARGET_CHARS));
	const overlapChars = Math.max(0, Math.min(Math.trunc(options.overlapChars ?? DEFAULT_OVERLAP_CHARS), targetChars / 4));
	if (content.length <= targetChars) return [content];

	const chunks: string[] = [];
	let cursor = 0;
	while (cursor < content.length) {
		const hardEnd = Math.min(content.length, cursor + targetChars);
		const end = hardEnd < content.length ? lastBoundary(content, cursor, hardEnd) : hardEnd;
		const chunkStart = chunks.length === 0 ? cursor : Math.max(0, cursor - overlapChars);
		chunks.push(content.slice(chunkStart, end));
		cursor = end > cursor ? end : hardEnd;
	}
	return chunks;
}
