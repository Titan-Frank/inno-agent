/**
 * Split streaming markdown into a stable prefix and an active tail.
 *
 * Cut points are blank lines — once a blank line arrives, everything before
 * it is final (markdown never reaches backwards across a paragraph break),
 * so the prefix can be rendered by a memoized component and never parsed
 * again. Two constructs may legitimately contain blank lines and therefore
 * suppress cutting while open:
 *
 * - fenced code blocks (``` / ~~~)
 * - display math ($$...$$)
 *
 * The result is used to keep per-tick re-rendering cost proportional to the
 * tail (the still-growing paragraph) instead of the whole message.
 */
export interface StreamingMarkdownSplit {
	/** Closed blocks, oldest first; each is final and safe to cache forever. */
	blocks: string[];
	/** The trailing, still-incomplete block ("" when text just ended on a blank line). */
	tail: string;
}

export function splitStreamingMarkdown(text: string): StreamingMarkdownSplit {
	const blocks: string[] = [];
	let blockStart = 0;
	let inFence = false;
	let fenceChar = "";
	let inMath = false;

	let lineStart = 0;
	const n = text.length;
	while (lineStart < n) {
		let lineEnd = text.indexOf("\n", lineStart);
		if (lineEnd === -1) lineEnd = n;
		const trimmed = text.slice(lineStart, lineEnd).trim();

		const fence = /^(`{3,}|~{3,})/.exec(trimmed);
		if (fence) {
			if (!inFence) {
				inFence = true;
				fenceChar = fence[1][0];
			} else if (fence[1][0] === fenceChar) {
				inFence = false;
			}
		}
		if (!inFence) {
			// Naive parity tracking: inline $$...$$ toggles twice on one line and
			// nets out; a lone $$ opens/closes a display block.
			let pos = lineStart;
			while ((pos = text.indexOf("$$", pos)) !== -1 && pos < lineEnd) {
				inMath = !inMath;
				pos += 2;
			}
		}

		if (!inFence && !inMath && trimmed === "" && lineStart > blockStart) {
			const block = text.slice(blockStart, lineStart).trim();
			if (block) blocks.push(block);
			blockStart = lineEnd + 1;
		}
		lineStart = lineEnd + 1;
	}

	return { blocks, tail: text.slice(blockStart).trim() };
}
