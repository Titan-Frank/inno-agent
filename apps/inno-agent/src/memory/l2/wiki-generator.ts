/**
 * Model-assisted wiki page generation. The module owns Inno's FILE contract,
 * storage metadata boundary, schema routing, and recovery behavior; the
 * prompts describe the desired page behavior without exposing storage fields
 * to the model.
 */
import { basename, dirname, join, normalize } from "node:path";
import { existsSync } from "node:fs";
import { complete } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { ensureDir, readJsonl, readText, writeJsonl, writeText } from "../../storage/file-store.js";
import { logger } from "../../logger.js";
import type { ManifestEntry } from "./types.js";
import { getSourcePagePath, parseFrontmatter } from "./wiki-maintainer.js";
import { mergeWikiPageContent } from "./wiki-page-merge.js";
import { currentWikiDate } from "./wiki-date.js";
import {
	applyWikiPageStorageMetadata,
	readWikiPageStorageMetadata,
	setWikiFrontmatterScalar,
	writeWikiFrontmatterArray,
} from "./wiki-page-model-view.js";
import { sanitizeGeneratedWikiPage } from "./wiki-ingest-sanitize.js";
import { buildWikiLanguageDirective } from "./wiki-output-language.js";
import { isWikiLlmResponseAccepted, withWikiLlmPayloadAlignment } from "./wiki-llm-compat.js";
import { parseWikiSchemaRouting, validateWikiPageRouting, type WikiSchemaRouting } from "./wiki-schema-routing.js";

const OPENER_LINE = /^---\s*FILE:\s*(.+?)\s*---\s*$/i;
const CLOSER_LINE = /^---\s*END\s+FILE\s*---\s*$/i;
const FENCE_LINE = /^\s{0,3}(```+|~~~+)/;
const AGGREGATE_PATHS = new Set(["wiki/index.md", "wiki/overview.md", "wiki/log.md"]);
const LONG_SOURCE_MIN_BUDGET = 8_000;
const LONG_SOURCE_MAX_SINGLE_PASS_BUDGET = 300_000;

function isWindowsSafePathSegment(segment: string): boolean {
	if (!segment || /[<>:"|?*]/.test(segment) || /[ .]$/.test(segment)) return false;
	const stem = segment.split(".")[0]?.toUpperCase();
	return Boolean(stem) && !["CON", "PRN", "AUX", "NUL"].includes(stem!)
		&& !/^COM[1-9]$/.test(stem!) && !/^LPT[1-9]$/.test(stem!);
}

/** Reject paths that cannot be safely written inside the wiki directory. */
function isSafeIngestPath(path: string): boolean {
	if (!path.trim() || /[\x00-\x1f]/.test(path) || path.startsWith("/") || path.startsWith("\\") || /^[a-z]:/i.test(path)) return false;
	const normalizedPath = path.replace(/\\/g, "/");
	const segments = normalizedPath.split("/");
	return normalizedPath.startsWith("wiki/") && !segments.some((segment) => segment === "..")
		&& segments.every(isWindowsSafePathSegment);
}

export interface ParsedFileBlock {
	path: string;
	content: string;
}

/** Parse the model's line-oriented FILE block protocol. */
export function parseGeneratedFileBlocks(text: string): { blocks: ParsedFileBlock[]; warnings: string[]; truncatedPaths: string[] } {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const blocks: ParsedFileBlock[] = [];
	const warnings: string[] = [];
	const truncatedPaths: string[] = [];
	for (let index = 0; index < lines.length;) {
		const opener = OPENER_LINE.exec(lines[index]);
		if (!opener) { index += 1; continue; }
		const path = opener[1].trim();
		index += 1;
		const content: string[] = [];
		let fenceMarker: string | null = null;
		let fenceLength = 0;
		let closed = false;
		while (index < lines.length) {
			const line = lines[index];
			const fence = FENCE_LINE.exec(line);
			if (fence) {
				const marker = fence[1][0];
				if (fenceMarker === null) { fenceMarker = marker; fenceLength = fence[1].length; }
				else if (marker === fenceMarker && fence[1].length >= fenceLength) { fenceMarker = null; fenceLength = 0; }
				content.push(line); index += 1; continue;
			}
			if (fenceMarker === null && CLOSER_LINE.test(line)) { closed = true; index += 1; break; }
			content.push(line); index += 1;
		}
		if (!closed) {
			warnings.push(`FILE block \"${path || "(unnamed)"}\" was not closed before end of stream \u2014 likely truncation (model hit max_tokens, timeout, or connection dropped). Block dropped.`);
			if (path && isSafeIngestPath(path)) truncatedPaths.push(path);
			continue;
		}
		if (!path || !isSafeIngestPath(path)) {
			warnings.push(`FILE block with unsafe path \"${path || "(unnamed)"}\" rejected (must be under wiki/, no .., no absolute paths, and Windows-safe file names).`);
			continue;
		}
		blocks.push({ path, content: content.join("\n") });
	}
	return { blocks, warnings, truncatedPaths };
}

export interface RichGenerationResult {
	created: string[];
	updated: string[];
	pages: string[];
	aggregateWrites?: string[];
	reviews: number;
	warnings: string[];
	hardFailures: string[];
	unrecoveredTruncatedPaths: string[];
}

export interface WikiIngestReview {
	id: string;
	sourceId: string;
	sourcePath: string;
	type: "contradiction" | "duplicate" | "missing-page" | "suggestion" | "confirm";
	title: string;
	description: string;
	pages?: string[];
	search?: string[];
	options: Array<{ label: string; action: string }>;
	createdAt: string;
}

function outputText(response: Awaited<ReturnType<typeof complete>>): string {
	return response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function withTimeout(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(600_000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error("Wiki ingestion cancelled");
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

/** Select a bounded generation budget from the model context window. */
export function computeWikiGenerationMaxTokens(maxContextSize: number | undefined): number {
	const maxContext = maxContextSize && maxContextSize > 0 ? maxContextSize : 128_000;
	if (maxContext >= 512_000) return 32_768;
	if (maxContext >= 256_000) return 24_576;
	if (maxContext >= 128_000) return 16_384;
	return 8_192;
}

/** Reserve context and output space before sending source text to the model. */
export function computeWikiSourceBudget(maxContextSize: number | undefined, stableContextLength: number): number {
	const maxContext = maxContextSize && maxContextSize > 0 ? maxContextSize : 128_000;
	const responseReserve = computeWikiGenerationMaxTokens(maxContextSize);
	const stableReserve = Math.min(Math.floor(maxContext * 0.25), Math.max(12_000, stableContextLength));
	const instructionReserve = Math.max(12_000, Math.floor(maxContext * 0.08));
	const available = maxContext - responseReserve - stableReserve - instructionReserve;
	const upper = Math.min(LONG_SOURCE_MAX_SINGLE_PASS_BUDGET, Math.max(LONG_SOURCE_MIN_BUDGET, Math.floor(maxContext * 0.6)));
	return clamp(Math.floor(available), LONG_SOURCE_MIN_BUDGET, upper);
}

function trimForPrompt(value: string, maximum: number): string {
	return value.length <= maximum ? value : `${value.slice(0, maximum).trimEnd()}\n\n[...trimmed for prompt budget...]`;
}

function buildPrompt(
	entry: ManifestEntry,
	sourceIdentity: string,
	sourcePagePath: string,
	sourceContent: string,
	schema: string,
	purpose: string,
	index: string,
	overview: string,
): string {
	const today = currentWikiDate();
	return [
		"You are a wiki maintainer. Based on the analysis provided, generate wiki files.",
		"Do not output chain-of-thought, hidden reasoning, or explanatory preamble. Reason internally and output only the requested FILE/REVIEW blocks.",
		"",
		buildWikiLanguageDirective(),
		"",
		"## IMPORTANT: Source File",
		`The original source file is: **${sourceIdentity}**`,
		`All wiki pages generated from this source MUST include this filename in their frontmatter \`sources\` field.`,
		`Today's date is **${today}**. Use this exact date for all new \`created\`, \`updated\`, and wiki/log.md ingest dates.`,
		"",
		schema ? `## Project Schema and Routing (AUTHORITATIVE)\n${schema}\n\nUse this schema as the primary routing rule for page types and directories.\nIf it defines custom folders or distinctions (for example people, technologies, organizations, methods, or cases), write pages into those schema-defined folders instead of forcing them into wiki/entities/ or wiki/concepts/.\nUse wiki/entities/ and wiki/concepts/ only when the schema does not provide a more specific destination.\nEvery generated page's frontmatter type must match the schema directory used in its FILE path.` : "",
		"",
		"## What to generate",
		"",
		`1. A source summary page at **${sourcePagePath}** (MUST use this exact path)`,
		"2. Entity or schema-defined typed pages for key named things identified in the analysis. Prefer schema-defined directories when present; otherwise use wiki/entities/.",
		"3. Concept or schema-defined typed pages for key ideas, methods, techniques, and abstractions. Prefer schema-defined directories when present; otherwise use wiki/concepts/.",
		"4. A log entry for wiki/log.md (just the new entry to append, format: ## [YYYY-MM-DD] ingest | Title)",
		"Do not generate wiki/index.md or wiki/overview.md. The application maintains aggregate navigation separately so large wikis are never rewritten through model output.",
		"",
		"## Frontmatter Rules (CRITICAL — parser is strict)",
		"",
		"Every page begins with a YAML frontmatter block. Format rules, in order of importance:",
		"",
		"1. The VERY FIRST line of the file MUST be exactly `---` (three hyphens, nothing else).",
		"   Do NOT wrap the file in a ```yaml ... ``` code fence.",
		"   Do NOT prefix it with a `frontmatter:` key or any other line.",
		"2. Each frontmatter line is a `key: value` pair on its own line.",
		"3. The frontmatter ends with another `---` line on its own.",
		"4. The next line after the closing `---` is the start of the page body.",
		"5. Arrays use the standard YAML inline form `[a, b, c]` (no outer brackets around each item).",
		"   Wikilinks belong in the BODY only — never write `related: [[a]], [[b]]` (invalid YAML);",
		"   write `related: [a, b]` with bare slugs.",
		"",
		"Required fields and types:",
		"  • type     — one of the known types (source | entity | concept | comparison | query | synthesis | thesis | methodology | finding), or a custom type explicitly defined by the project schema",
		"  • title    — string (quote it if it contains a colon, e.g. `title: \"Foo: Bar\"`)",
		`  • created  — ${today} for new pages (YYYY-MM-DD, no quotes)`,
		`  • updated  — ${today} for new pages (same as created)`,
		"  • tags     — array of bare strings: `tags: [microbiology, ai]`",
		"  • related  — array of bare wiki page slugs: `related: [foo, bar-baz]`. Do NOT include",
		"               `wiki/`, `.md`, or `[[…]]` here — slugs only.",
		`  • sources  — array of source filenames; MUST include "${sourceIdentity}".`,
		"",
		"Concrete example of a complete, parseable page (everything between the two `---` lines",
		"is the frontmatter; the heading and prose below are the body):",
		"",
		"    ---",
		"    type: entity",
		"    title: Example Entity",
		`    created: ${today}`,
		`    updated: ${today}`,
		"    tags: [example, demo]",
		"    related: [related-slug-1, related-slug-2]",
		`    sources: ["${sourceIdentity}"]`,
		"    ---",
		"",
		"    # Example Entity",
		"",
		"    Body content goes here. Use [[wikilink]] syntax in the body for cross-references.",
		"",
		"Other rules:",
		"- Use [[wikilink]] syntax in the BODY for cross-references between pages",
		"- If you include images, use wiki-root-relative paths such as `media/source-slug/image.png`; never output absolute filesystem paths.",
		"- Preserve subject boundaries: when a source discusses multiple entities/models/products/methods, keep claims, evaluations, limitations, benchmark results, and recommendations attached to the exact subject they describe.",
		"- Do not merge or generalize a claim about one subject into another subject's page solely because they share terms (for example context window size, benchmark name, dataset, architecture, or feature name).",
		"- If a page needs to mention another subject for comparison, write it explicitly as a comparison and cite which source/frontmatter `sources` entry supports that statement.",
		"- Use kebab-case for Latin-script filenames; for Chinese/Japanese/Korean titles keep the CJK characters (do NOT romanize to pinyin/romaji or translate to English)",
		"- Derive filenames from the page title in the mandatory output language, but short proper nouns and technical identifiers take precedence: preserve names such as OpenAI, GPT-5, Transformer, CLIP, ImageNet, PyTorch, CUDA, GitHub, arXiv, React, LanceDB, AnyTXT, MinerU, model names, dataset names, tool names, and code identifiers in their standard original form. Do not put raw URLs, citation strings, or full paper titles directly into file paths; convert surrounding descriptive prose to a safe readable title. For Chinese/Japanese/Korean prose titles, keep readable CJK characters in the filename instead of translating the slug to English.",
		"- Preserve structured source data verbatim: copy SQL DDL / CREATE TABLE statements, schema definitions, API signatures, configuration, and tabular data into fenced code blocks (or Markdown tables) in the source summary page instead of paraphrasing them. Exact column names, types, constraints, primary/foreign keys, and indexes must survive ingest — a prose-only summary that drops them loses the structure the user imported the source to keep.",
		"- Follow the analysis recommendations on what to emphasize",
		"- If the analysis found connections to existing pages, add cross-references",
		"",
		"## Review block types",
		"",
		"After all FILE blocks, optionally emit REVIEW blocks for anything that needs human judgment:",
		"",
		"- contradiction: the analysis found conflicts with existing wiki content",
		"- duplicate: an entity/concept might already exist under a different name in the index",
		"- missing-page: an important concept is referenced but has no dedicated page",
		"- suggestion: ideas for further research, related sources to look for, or connections worth exploring",
		"",
		"Only create reviews for things that genuinely need human input. Don't create trivial reviews.",
		"",
		"## OPTIONS allowed values (only these predefined labels):",
		"",
		"- contradiction: OPTIONS: Create Page | Skip",
		"- duplicate: OPTIONS: Create Page | Skip",
		"- missing-page: OPTIONS: Create Page | Skip",
		"- suggestion: OPTIONS: Create Page | Skip",
		"",
		"The user also has a 'Deep Research' button (auto-added by the system) that triggers web search.",
		"Do NOT invent custom option labels. Only use 'Create Page' and 'Skip'.",
		"",
		"For suggestion and missing-page reviews, the SEARCH field must contain 2-3 web search queries",
		"(keyword-rich, specific, suitable for a search engine — NOT titles or sentences). Example:",
		"  SEARCH: automated technical debt detection AI generated code | software quality metrics LLM code generation | static analysis tools agentic software development",
		"",
		purpose ? `## Wiki Purpose\n${purpose}` : "",
		index ? `## Current Wiki Index (preserve all existing entries, add new ones)\n${index}` : "",
		overview ? `## Current Overview (update this to reflect the new source)\n${overview}` : "",
		"",
		"## Output Format (MUST FOLLOW EXACTLY — this is how the parser reads your response)",
		"",
		"Your ENTIRE response consists of FILE blocks followed by optional REVIEW blocks. Nothing else.",
		"",
		"FILE block template:",
		"```",
		"---FILE: wiki/path/to/page.md---",
		"(complete file content with YAML frontmatter)",
		"---END FILE---",
		"```",
		"",
		"REVIEW block template (optional, after all FILE blocks):",
		"```",
		"---REVIEW: type | Title---",
		"Description of what needs the user's attention.",
		"OPTIONS: Create Page | Skip",
		"PAGES: wiki/page1.md, wiki/page2.md",
		"SEARCH: query 1 | query 2 | query 3",
		"---END REVIEW---",
		"```",
		"",
		"## Output Requirements (STRICT — deviations will cause parse failure)",
		"",
		"1. The FIRST character of your response MUST be `-` (the opening of `---FILE:`).",
		"2. DO NOT output any preamble such as \"Here are the files:\", \"Based on the analysis...\", or any introductory prose.",
		"3. DO NOT echo or restate the analysis — that was stage 1's job. Your job is to emit FILE blocks.",
		"4. DO NOT output markdown tables, bullet lists, or headings outside of FILE/REVIEW blocks.",
		"5. DO NOT output any trailing commentary after the last `---END FILE---` or `---END REVIEW---`.",
		"6. Between blocks, use only blank lines — no prose.",
		"7. FILE block prose (body, explanations, descriptions, section text) must use the mandatory output language specified below. Preserve proper nouns, acronyms, model names, dataset names, tool/library names, code identifiers, URLs, file names, citation strings, paper titles, and technical terms with no widely-used localized equivalent in their standard original form, including in page names and section headings.",
		"",
		"If you start with anything other than `---FILE:`, the entire response will be discarded.",
		"",
		"---",
		"",
		buildWikiLanguageDirective(),
	].filter(Boolean).join("\n");
}

function buildUserPrompt(sourceIdentity: string, analysis: string, sourceContent: string): string {
	return [
		`Source document to process: **${sourceIdentity}**`,
		"",
		"The Stage 1 analysis below is CONTEXT to inform your output. Do NOT echo",
		"its tables, bullet points, or prose. Your output must be FILE/REVIEW",
		"blocks as specified in the system prompt — nothing else.",
		"",
		"## Stage 1 Analysis (context only — do not repeat)",
		"",
		analysis,
		"",
		"## Source Context",
		"",
		sourceContent,
		"",
		"---",
		"",
		`Now emit the FILE blocks for the wiki files derived from **${sourceIdentity}**.`,
		"Your response MUST begin with `---FILE:` as the very first characters.",
		"No preamble. No analysis prose. Start immediately.",
	].join("\n");
}

function safeRelativePath(raw: string, sourcePagePath: string): string | null {
	const rel = normalize(raw.trim()).replaceAll("\\", "/").replace(/^\.\//, "");
	if (!isSafeIngestPath(rel) || !rel.endsWith(".md")) return null;
	if (rel.startsWith("wiki/sources/")) return sourcePagePath;
	if (rel === "wiki/index.md" || rel === "wiki/overview.md") return null;
	return rel;
}

function unique(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** Ensure generated page bodies use the configured Chinese target language. */
function contentMatchesChineseTarget(content: string): boolean {
	const frontmatterEnd = content.indexOf("\n---\n", 3);
	let body = frontmatterEnd > 0 ? content.slice(frontmatterEnd + 5) : content;
	body = body
		.replace(/```[\s\S]*?```/g, "")
		.replace(/\$\$[\s\S]*?\$\$/g, "")
		.replace(/\$[^$\n]*\$/g, "");
	const sample = body.slice(0, 1_500);
	if (sample.trim().length < 20) return true;

	const counts = new Map<string, number>();
	for (const character of sample) {
		const codePoint = character.codePointAt(0);
		if (!codePoint || codePoint < 0x80) continue;
		const script = nonLatinScript(codePoint);
		if (script) counts.set(script, (counts.get(script) ?? 0) + 1);
	}
	if ((counts.get("Japanese") ?? 0) > 0 && (counts.get("Chinese") ?? 0) > 0) return true;
	let detected = "English";
	let maximum = 0;
	for (const [script, count] of counts) {
		if (count > maximum) { detected = script; maximum = count; }
	}
	if (maximum < 2) detected = "English";
	return new Set(["Chinese", "Japanese", "Korean"]).has(detected);
}

/** Unicode script ranges used by the Chinese language guard. */
function nonLatinScript(codePoint: number): string | null {
	if ((codePoint >= 0x4e00 && codePoint <= 0x9fff) || (codePoint >= 0x3400 && codePoint <= 0x4dbf)
		|| (codePoint >= 0x20000 && codePoint <= 0x2a6df) || (codePoint >= 0xf900 && codePoint <= 0xfaff)) return "Chinese";
	if ((codePoint >= 0x3040 && codePoint <= 0x309f) || (codePoint >= 0x30a0 && codePoint <= 0x30ff)
		|| (codePoint >= 0x31f0 && codePoint <= 0x31ff) || (codePoint >= 0xff65 && codePoint <= 0xff9f)) return "Japanese";
	if ((codePoint >= 0xac00 && codePoint <= 0xd7af) || (codePoint >= 0x1100 && codePoint <= 0x11ff)
		|| (codePoint >= 0x3130 && codePoint <= 0x318f)) return "Korean";
	if ((codePoint >= 0x0600 && codePoint <= 0x06ff) || (codePoint >= 0x0750 && codePoint <= 0x077f)
		|| (codePoint >= 0x08a0 && codePoint <= 0x08ff) || (codePoint >= 0xfb50 && codePoint <= 0xfdff)
		|| (codePoint >= 0xfe70 && codePoint <= 0xfeff)) return "Arabic";
	if ((codePoint >= 0x0590 && codePoint <= 0x05ff) || (codePoint >= 0xfb1d && codePoint <= 0xfb4f)) return "Hebrew";
	if (codePoint >= 0x0e00 && codePoint <= 0x0e7f) return "Thai";
	if (codePoint >= 0x0900 && codePoint <= 0x097f) return "Hindi";
	if (codePoint >= 0x0980 && codePoint <= 0x09ff) return "Bengali";
	if (codePoint >= 0x0b80 && codePoint <= 0x0bff) return "Tamil";
	if (codePoint >= 0x0c00 && codePoint <= 0x0c7f) return "Telugu";
	if (codePoint >= 0x0c80 && codePoint <= 0x0cff) return "Kannada";
	if (codePoint >= 0x0d00 && codePoint <= 0x0d7f) return "Malayalam";
	if (codePoint >= 0x0a80 && codePoint <= 0x0aff) return "Gujarati";
	if (codePoint >= 0x0a00 && codePoint <= 0x0a7f) return "Punjabi";
	if (codePoint >= 0x1000 && codePoint <= 0x109f) return "Burmese";
	if (codePoint >= 0x1780 && codePoint <= 0x17ff) return "Khmer";
	if (codePoint >= 0x0e80 && codePoint <= 0x0eff) return "Lao";
	if ((codePoint >= 0x10a0 && codePoint <= 0x10ff) || (codePoint >= 0x2d00 && codePoint <= 0x2d2f)) return "Georgian";
	if (codePoint >= 0x0530 && codePoint <= 0x058f) return "Armenian";
	if (codePoint >= 0x1200 && codePoint <= 0x137f) return "Amharic";
	if (codePoint >= 0x0f00 && codePoint <= 0x0fff) return "Tibetan";
	if (codePoint >= 0x0d80 && codePoint <= 0x0dff) return "Sinhala";
	if ((codePoint >= 0x0400 && codePoint <= 0x04ff) || (codePoint >= 0x0500 && codePoint <= 0x052f)) return "Russian";
	if ((codePoint >= 0x0370 && codePoint <= 0x03ff) || (codePoint >= 0x1f00 && codePoint <= 0x1fff)) return "Greek";
	return null;
}

function canonicalGeneratedSources(sources: string[], promptSourceIdentity: string): string[] {
	const normalizedIdentity = normalize(promptSourceIdentity).replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
	const identityKey = normalizedIdentity.toLowerCase();
	const identityBaseName = basename(normalizedIdentity).toLowerCase();
	const canonical = sources.flatMap((source) => {
		const normalizedSource = normalize(source).replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
		const key = normalizedSource.toLowerCase();
		if (!normalizedSource || normalizedSource.startsWith("/") || /^[a-z]:\//i.test(normalizedSource)) return [];
		if (normalizedSource.split("/").some((part) => part === "..")) return [];
		if (["wiki/index.md", "wiki/overview.md", "wiki/log.md"].includes(key)) return [];
		if (key === ".llm-wiki" || key.startsWith(".llm-wiki/")) return [];
		if (key === identityKey || (!normalizedSource.includes("/") && key === identityBaseName)) return [normalizedIdentity];
		return [normalizedSource];
	});
	return unique([...canonical, normalizedIdentity]);
}

/** Normalize a generated path when its title indicates a target-language rewrite. */
export function canonicalizeGeneratedPagePath(rel: string, content: string, sourcePagePath: string): string {
	if (rel === sourcePagePath || AGGREGATE_PATHS.has(rel)) return rel;
	const filename = rel.slice(rel.lastIndexOf("/") + 1);
	if (/\p{Script=Han}/u.test(filename)) return rel;
	const parsed = parseFrontmatter(sanitizeGeneratedWikiPage(content));
	const title = parsed.frontmatter?.title?.trim() || parsed.body.match(/^#\s+(.+)$/m)?.[1]?.trim();
	if (!title || !/\p{Script=Han}/u.test(title)) return rel;
	const slug = Array.from(title
		.normalize("NFKC")
		.toLowerCase()
		.trim()
		.replace(/\s+/g, "-")
		.replace(/[^\p{L}\p{N}-]/gu, "")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, ""))
		.slice(0, 50)
		.join("");
	if (!slug) return rel;
	return `${rel.slice(0, rel.lastIndexOf("/") + 1)}${slug}.md`;
}

function normalizeGeneratedPage(rel: string, content: string, entry: ManifestEntry, promptSourceIdentity: string): string {
	let modelVisibleContent = sanitizeGeneratedWikiPage(content);
	const parsed = parseFrontmatter(modelVisibleContent);
	const today = currentWikiDate();
	modelVisibleContent = setWikiFrontmatterScalar(modelVisibleContent, "created", today);
	modelVisibleContent = setWikiFrontmatterScalar(modelVisibleContent, "updated", today);
	modelVisibleContent = writeWikiFrontmatterArray(
		modelVisibleContent,
		"sources",
		canonicalGeneratedSources(parsed.frontmatter?.sources ?? [], promptSourceIdentity),
	);
	const emittedStorage = readWikiPageStorageMetadata(modelVisibleContent);
	return applyWikiPageStorageMetadata(modelVisibleContent, {
		...emittedStorage,
		sourceIds: unique([...emittedStorage.sourceIds, entry.id]),
	});
}

export function parseGeneratedReviewBlocks(text: string, entry: Pick<ManifestEntry, "id" | "rawPath">): WikiIngestReview[] {
	const reviews: WikiIngestReview[] = [];
	const pattern = /---REVIEW:\s*(\w[\w-]*)\s*\|\s*(.+?)\s*---\n([\s\S]*?)---END REVIEW---/g;
	for (const match of text.matchAll(pattern)) {
		const rawType = match[1].trim().toLowerCase();
		const body = match[3].trim();
		const optionsLine = body.match(/^OPTIONS:\s*(.+)$/m)?.[1];
		const pagesLine = body.match(/^PAGES:\s*(.+)$/m)?.[1];
		const searchLine = body.match(/^SEARCH:\s*(.+)$/m)?.[1];
		const description = body
			.replace(/^OPTIONS:.*$/m, "")
			.replace(/^PAGES:.*$/m, "")
			.replace(/^SEARCH:.*$/m, "")
			.trim();
		reviews.push({
			id: `l2review_${entry.id}_${reviews.length + 1}`,
			sourceId: entry.id,
			sourcePath: entry.rawPath,
			type: ["contradiction", "duplicate", "missing-page", "suggestion"].includes(rawType)
				? rawType as WikiIngestReview["type"]
				: "confirm",
			title: match[2].trim(),
			description,
			...(pagesLine && { pages: pagesLine.split(",").map((value) => value.trim()) }),
			...(searchLine && { search: searchLine.split("|").map((value) => value.trim()).filter(Boolean) }),
			options: optionsLine
				? optionsLine.split("|").map((value) => value.trim()).map((label) => ({ label, action: label }))
				: [{ label: "Approve", action: "Approve" }, { label: "Skip", action: "Skip" }],
			createdAt: new Date().toISOString(),
		});
	}
	return reviews;
}

function replaceSourceReviews(l2DataDir: string, entry: ManifestEntry, reviews: WikiIngestReview[]): void {
	const reviewPath = join(l2DataDir, "reviews.jsonl");
	const retained = readJsonl<WikiIngestReview>(reviewPath).filter((review) => review.sourceId !== entry.id);
	writeJsonl(reviewPath, [...retained, ...reviews]);
}

function countGeneratedFileBlocks(text: string): number {
	return (text.match(/---FILE:\s*[^-]+---/g) ?? []).length;
}

export function shouldRunDedicatedReviewStage(generation: string): boolean {
	return generation.length >= 10_000
		|| countGeneratedFileBlocks(generation) >= 4
		|| /---REVIEW:\s*[\w-]+\s*\|[\s\S]*$/i.test(generation);
}

export function buildTruncatedRepairPrompt(
	paths: string[],
	entry: ManifestEntry,
	sourceIdentity: string,
	analysis: string,
	sourceContext: string,
	schema: string,
	purpose: string,
	maxContextSize: number | undefined,
): string {
	const maxContext = maxContextSize && maxContextSize > 0 ? maxContextSize : 128_000;
	const sectionCap = Math.max(4_000, Math.floor(maxContext * 0.12));
	return [
		"You are repairing truncated wiki FILE blocks from an earlier generation.",
		"Return exactly one complete FILE block for each requested path and no other files.",
		"Every block must end with `---END FILE---`. Do not output a preamble, REVIEW blocks, or trailing commentary.",
		"Preserve the requested paths exactly and include the source identity in each page's frontmatter `sources` field.",
		"",
		buildWikiLanguageDirective(),
		"",
		"## Requested paths",
		...paths.map((path) => `- ${path}`),
		"",
		`## Source identity\n${sourceIdentity}`,
		schema ? `## Project schema\n${trimForPrompt(schema, sectionCap)}` : "",
		purpose ? `## Wiki purpose\n${trimForPrompt(purpose, sectionCap)}` : "",
		`## Stage 1 analysis\n${trimForPrompt(analysis, sectionCap)}`,
		`## Source context\n${trimForPrompt(sourceContext, sectionCap)}`,
	].filter(Boolean).join("\n");
}

export function filterTruncatedRepairOutput(
	text: string,
	allowedPaths: readonly string[],
): { text: string; paths: string[]; warnings: string[] } {
	const allowed = new Set(allowedPaths.map(normalizedPathKey));
	const parsed = parseGeneratedFileBlocks(text);
	const warnings = [...parsed.warnings];
	const seen = new Set<string>();
	const kept: ParsedFileBlock[] = [];
	const dropped: ParsedFileBlock[] = [];
	const duplicates: ParsedFileBlock[] = [];
	for (const block of parsed.blocks) {
		const pathKey = normalizedPathKey(block.path);
		if (!allowed.has(pathKey)) {
			dropped.push(block);
			continue;
		}
		if (seen.has(pathKey)) {
			duplicates.push(block);
			continue;
		}
		seen.add(pathKey);
		kept.push(block);
	}
	if (dropped.length > 0) {
		warnings.push(`Dropped ${dropped.length} unrequested FILE block(s) from truncated repair output: ${dropped.map((block) => block.path).join(", ")}`);
	}
	if (duplicates.length > 0) {
		warnings.push(`Dropped ${duplicates.length} duplicate FILE block(s) from truncated repair output: ${duplicates.map((block) => block.path).join(", ")}`);
	}
	return {
		text: kept.map((block) => `---FILE: ${block.path}---\n${block.content.trimEnd()}\n---END FILE---`).join("\n\n"),
		paths: kept.map((block) => block.path),
		warnings,
	};
}

export function buildReviewPrompt(
	purpose: string,
	index: string,
	sourceIdentity: string,
	analysis: string,
	sourceContext: string,
	generated: string,
	maxContextSize: number | undefined,
): string {
	const maxContext = maxContextSize && maxContextSize > 0 ? maxContextSize : 128_000;
	const sectionCap = Math.max(4_000, Math.floor(maxContext * 0.15));
	const indexCap = Math.max(3_000, Math.floor(sectionCap * 0.8));
	return [
		"You are identifying high-value follow-up research items for a personal wiki.",
		"Do not output chain-of-thought, hidden reasoning, or explanatory preamble.",
		"",
		buildWikiLanguageDirective(),
		"",
		"Your job is NOT to generate wiki pages. The wiki page generation already happened.",
		"Output only REVIEW blocks for unresolved knowledge gaps that deserve human attention or Deep Research.",
		"",
		"Create REVIEW blocks only for genuinely useful follow-up work:",
		"- missing-page: an important entity/concept is referenced but still lacks a dedicated page",
		"- suggestion: a research question, source type, or comparison that would materially improve the wiki",
		"- contradiction: a conflict or tension that requires user judgment",
		"- duplicate: likely duplicate pages/names that need user review",
		"",
		"Prefer 1-5 high-signal reviews. If there is nothing worth reviewing, output nothing.",
		"For suggestion and missing-page reviews, include a SEARCH line with 2-3 keyword-rich web search queries separated by ` | `.",
		"Use only these options: OPTIONS: Create Page | Skip",
		"",
		"REVIEW block template:",
		"```",
		"---REVIEW: suggestion | Precise title---",
		"Concise description of the gap and why it matters.",
		"OPTIONS: Create Page | Skip",
		"PAGES: wiki/page1.md, wiki/page2.md",
		"SEARCH: query 1 | query 2 | query 3",
		"---END REVIEW---",
		"```",
		"",
		"Return REVIEW blocks only. Do not output FILE blocks. Do not wrap the response in markdown fences.",
		"",
		purpose ? `## Wiki Purpose\n${purpose}` : "",
		index ? `## Current Wiki Index\n${trimForPrompt(index, indexCap)}` : "",
		"",
		`## Source\n${sourceIdentity}`,
		"",
		"## Stage 1 Analysis",
		trimForPrompt(analysis, sectionCap),
		"",
		"## Source Context",
		trimForPrompt(sourceContext, sectionCap),
		"",
		"## Generated Wiki Output",
		trimForPrompt(generated, sectionCap),
	].filter(Boolean).join("\n");
}

interface RichWriteResult {
	created: string[];
	updated: string[];
	pages: string[];
	aggregateWrites: string[];
	completedInputPaths: string[];
	warnings: string[];
	hardFailures: string[];
}

function normalizedPathKey(path: string): string {
	return normalize(path).replaceAll("\\", "/");
}

/**
 * A malformed or rejected FILE block is a warning, while an actual filesystem
 * failure is accumulated and does not prevent other generated pages from being written.
 */
async function writeGeneratedFileBlocks(
	l2DataDir: string,
	blocks: ParsedFileBlock[],
	entry: ManifestEntry,
	sourceIdentity: string,
	sourcePagePath: string,
	routing: WikiSchemaRouting,
	model: Model<any>,
	modelRegistry: ModelRegistry,
	signal?: AbortSignal,
): Promise<RichWriteResult> {
	const created: string[] = [];
	const updated: string[] = [];
	const pages: string[] = [];
	const aggregateWrites: string[] = [];
	const completedInputPaths: string[] = [];
	const warnings: string[] = [];
	const hardFailures: string[] = [];
	for (const block of blocks) {
		throwIfAborted(signal);
		const requestedRel = safeRelativePath(block.path, sourcePagePath);
		if (!requestedRel) {
			warnings.push(`FILE block \"${block.path}\" is outside Inno's supported wiki page directories and was dropped.`);
			continue;
		}
		const rel = canonicalizeGeneratedPagePath(requestedRel, block.content, sourcePagePath);
		if (rel === "wiki/log.md") {
			try {
				const abs = join(l2DataDir, rel);
				ensureDir(dirname(abs));
				const content = stampGeneratedLogDate(block.content, currentWikiDate()).trim();
				const existing = existsSync(abs) ? readText(abs).trim() : "";
				writeText(abs, existing ? `${existing}\n\n${content}` : content);
				aggregateWrites.push(rel);
				completedInputPaths.push(block.path);
			} catch (err) {
				const message = `Failed to write \"${rel}\": ${err instanceof Error ? err.message : String(err)}`;
				logger.warn({ err, source: entry.rawPath, path: rel }, "rich wiki FILE block write failed");
				warnings.push(message);
				hardFailures.push(rel);
			}
			continue;
		}
		const normalized = normalizeGeneratedPage(rel, sanitizeGeneratedWikiPage(block.content), entry, sourceIdentity);
		const routingIssue = validateWikiPageRouting(rel, normalized, routing);
		if (routingIssue) {
			warnings.push(`Dropped \"${rel}\" \u2014 ${routingIssue.message}`);
			continue;
		}
		const isEntityOrSource = rel.includes("/entities/") || rel.includes("/sources/");
		if (!isEntityOrSource && !contentMatchesChineseTarget(normalized)) {
			warnings.push(`Dropped \"${rel}\" \u2014 body language doesn't match target Chinese.`);
			continue;
		}

		try {
			const abs = join(l2DataDir, rel);
			ensureDir(dirname(abs));
			if (existsSync(abs)) {
				const existing = readText(abs);
				const oldPage = parseFrontmatter(existing);
				const ownedOnlyByCurrentSource = Boolean(
					oldPage.frontmatter?.source_ids.length
					&& oldPage.frontmatter.source_ids.every((sourceId) => sourceId === entry.id),
				);
				if (ownedOnlyByCurrentSource) {
					backupExistingPage(l2DataDir, rel, existing);
					writeText(abs, normalized);
				} else {
					const merged = await mergeWikiPageContent(existing, normalized, sourceIdentity, model, modelRegistry, signal);
					if (merged.usedFallback) {
						backupExistingPage(l2DataDir, rel, existing);
					}
					writeText(abs, merged.content);
				}
				updated.push(rel);
			} else {
				writeText(abs, normalized);
				created.push(rel);
			}
			pages.push(rel);
			completedInputPaths.push(block.path);
		} catch (err) {
			const message = `Failed to write \"${rel}\": ${err instanceof Error ? err.message : String(err)}`;
			logger.warn({ err, source: entry.rawPath, path: rel }, "rich wiki FILE block write failed");
			warnings.push(message);
			hardFailures.push(rel);
		}
	}

	return { created, updated, pages, aggregateWrites, completedInputPaths, warnings, hardFailures };
}

function backupExistingPage(l2DataDir: string, wikiPath: string, content: string): void {
	const historyDir = join(l2DataDir, "page-history");
	ensureDir(historyDir);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const name = wikiPath.replaceAll("/", "_").replace(/\.md$/i, "");
	writeText(join(historyDir, `${name}-${stamp}.md`), content);
}

function stampGeneratedLogDate(content: string, date: string): string {
	const normalized = content.replace(/\bYYYY-MM-DD\b/g, date);
	if (!/^\s*##\s*\[?\d{4}-\d{2}-\d{2}\]?/m.test(normalized)) return normalized;
	return normalized.replace(/^(\s*##\s*\[?)\d{4}-\d{2}-\d{2}(\]?)/m, `$1${date}$2`);
}

export async function generateRichWikiPages(
	l2DataDir: string,
	entry: ManifestEntry,
	analysis: string,
	sourceContent: string,
	context: { schema: string; purpose?: string; index: string; overview?: string; sourceIdentity?: string },
	model: Model<any>,
	modelRegistry: ModelRegistry,
	signal?: AbortSignal,
): Promise<RichGenerationResult | null> {
	try {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) throw new Error("Failed to resolve API key");
		const maxContextSize = (model as { contextWindow?: number }).contextWindow;
		const maxTokens = computeWikiGenerationMaxTokens(maxContextSize);
		const sourceIdentity = context.sourceIdentity ?? entry.rawPath;
		const sourcePagePath = getSourcePagePath(entry, context.sourceIdentity);
		const routing = parseWikiSchemaRouting(context.schema);
		const generationSourceContext = sourceContent;
		const response = await complete(
			model,
			{
				systemPrompt: buildPrompt(entry, sourceIdentity, sourcePagePath, generationSourceContext, context.schema, context.purpose ?? "", context.index, context.overview ?? ""),
				messages: [{ role: "user" as const, content: [{ type: "text" as const, text: buildUserPrompt(sourceIdentity, analysis, generationSourceContext) }], timestamp: Date.now() }],
			},
			withWikiLlmPayloadAlignment({ apiKey: auth.apiKey, headers: auth.headers, maxTokens, temperature: 0.1, reasoning: "off", timeoutMs: 600_000, signal: withTimeout(signal) }),
		);
		throwIfAborted(signal);
		if (!isWikiLlmResponseAccepted(response)) throw new Error(response.errorMessage ?? "wiki generation failed");
		const generated = outputText(response);
		let reviewText = generated;
		if (shouldRunDedicatedReviewStage(generated)) {
			try {
				const reviewResponse = await complete(model, {
					systemPrompt: buildReviewPrompt(context.purpose ?? "", context.index, sourceIdentity, analysis, generationSourceContext, generated, maxContextSize),
					messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Emit only high-value REVIEW blocks for follow-up research or unresolved knowledge gaps. Output nothing if there are none." }], timestamp: Date.now() }],
				}, withWikiLlmPayloadAlignment({ apiKey: auth.apiKey, headers: auth.headers, maxTokens: Math.min(8_192, Math.max(4_096, Math.floor(maxTokens / 2))), temperature: 0.1, reasoning: "off", timeoutMs: 600_000, signal: withTimeout(signal) }));
				throwIfAborted(signal);
				if (!isWikiLlmResponseAccepted(reviewResponse)) throw new Error(reviewResponse.errorMessage ?? "review generation failed");
				reviewText += `\n${outputText(reviewResponse)}`;
			} catch (err) {
				logger.warn({ err, source: entry.rawPath }, "dedicated wiki review generation failed");
			}
		}
		const parsedOutput = parseGeneratedFileBlocks(generated);
		const warnings = [...parsedOutput.warnings];
		const initialWrite = await writeGeneratedFileBlocks(l2DataDir, parsedOutput.blocks, entry, sourceIdentity, sourcePagePath, routing, model, modelRegistry, signal);
		warnings.push(...initialWrite.warnings);
		const created = [...initialWrite.created];
		const updated = [...initialWrite.updated];
		const pages = [...initialWrite.pages];
		const aggregateWrites = [...initialWrite.aggregateWrites];
		const hardFailures = [...initialWrite.hardFailures];
		const initialWrittenPaths = [...initialWrite.pages, ...initialWrite.aggregateWrites];
		let unrecoveredTruncatedPaths = unique(parsedOutput.truncatedPaths.filter((path) =>
			!initialWrittenPaths.some((writtenPath) => normalizedPathKey(writtenPath) === normalizedPathKey(path)),
		));

		if (unrecoveredTruncatedPaths.length > 0) {
			try {
				const repairResponse = await complete(model, {
					systemPrompt: buildTruncatedRepairPrompt(unrecoveredTruncatedPaths, entry, sourceIdentity, analysis, generationSourceContext, context.schema, context.purpose ?? "", maxContextSize),
					messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Regenerate the requested FILE blocks now. Start immediately with `---FILE:`." }], timestamp: Date.now() }],
					}, withWikiLlmPayloadAlignment({ apiKey: auth.apiKey, headers: auth.headers, maxTokens, temperature: 0.1, reasoning: "off", timeoutMs: 600_000, signal: withTimeout(signal) }));
					throwIfAborted(signal);
				if (!isWikiLlmResponseAccepted(repairResponse)) throw new Error(repairResponse.errorMessage ?? "truncated FILE repair failed");
				const filteredRepair = filterTruncatedRepairOutput(outputText(repairResponse), unrecoveredTruncatedPaths);
				warnings.push(...filteredRepair.warnings);
				const repairBlocks = parseGeneratedFileBlocks(filteredRepair.text).blocks;
					const repairWrite = await writeGeneratedFileBlocks(l2DataDir, repairBlocks, entry, sourceIdentity, sourcePagePath, routing, model, modelRegistry, signal);
				warnings.push(...repairWrite.warnings);
				created.push(...repairWrite.created);
				updated.push(...repairWrite.updated);
				pages.push(...repairWrite.pages);
				aggregateWrites.push(...repairWrite.aggregateWrites);
				hardFailures.push(...repairWrite.hardFailures);
				const completedRepairPaths = new Set(repairWrite.completedInputPaths.map(normalizedPathKey));
				const recoveredPaths = filteredRepair.paths.filter((path) => completedRepairPaths.has(normalizedPathKey(path)));
				for (const path of recoveredPaths) {
					const warningPrefix = `FILE block \"${path}\" was not closed before end of stream`;
					for (let index = warnings.length - 1; index >= 0; index -= 1) {
						if (warnings[index].startsWith(warningPrefix)) warnings.splice(index, 1);
					}
				}
				const recoveredKeys = new Set(recoveredPaths.map(normalizedPathKey));
				unrecoveredTruncatedPaths = unrecoveredTruncatedPaths.filter((path) => !recoveredKeys.has(normalizedPathKey(path)));
			} catch (err) {
				warnings.push(`Truncated FILE repair failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		// Keep a valid source page as a fallback when the model omits that FILE block.
		if (!pages.includes(sourcePagePath)) {
			throwIfAborted(signal);
			const fallback = normalizeGeneratedPage(sourcePagePath, [
				"---", "type: source", `title: ${JSON.stringify(`Source: ${sourceIdentity}`)}`, "tags: []", "related: []",
				`sources: [${JSON.stringify(sourceIdentity)}]`, `source_ids: [${JSON.stringify(entry.id)}]`, "---", `# Source: ${sourceIdentity}`, "", analysis || "(Analysis not available)",
			].join("\n"), entry, sourceIdentity);
			try {
				const abs = join(l2DataDir, sourcePagePath);
				ensureDir(dirname(abs));
				writeText(abs, fallback);
				created.push(sourcePagePath);
				pages.push(sourcePagePath);
			} catch (err) {
				const message = `Failed to write fallback source summary \"${sourcePagePath}\": ${err instanceof Error ? err.message : String(err)}`;
				warnings.push(message);
			}
		}

		let reviews = 0;
		if (hardFailures.length === 0 && unrecoveredTruncatedPaths.length === 0) {
			throwIfAborted(signal);
			const reviewItems = parseGeneratedReviewBlocks(reviewText, entry);
			try {
				replaceSourceReviews(l2DataDir, entry, reviewItems);
				reviews = reviewItems.length;
			} catch (err) {
				warnings.push(`Review persistence failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		return {
			created: unique(created),
			updated: unique(updated),
			pages: unique(pages),
			aggregateWrites: unique(aggregateWrites),
			reviews,
			warnings,
			hardFailures: unique(hardFailures),
			unrecoveredTruncatedPaths: unique(unrecoveredTruncatedPaths),
		};
	} catch (err) {
		logger.warn({ err, source: basename(entry.rawPath) }, "rich wiki generation failed; archive remains retryable");
		throw err instanceof Error ? err : new Error(String(err));
	}
}
