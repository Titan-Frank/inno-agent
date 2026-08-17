/**
 * L2 Wiki Summarizer — uses the agent's configured model via PI SDK
 * to generate structured wiki summaries from extracted content.
 */

import { logger } from "../../logger.js";
import { complete } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { splitSourceIntoSemanticChunks } from "./structural-chunker.js";
import { computeWikiSourceBudget } from "./wiki-generator.js";
import { fileExists, readJson, writeJson } from "../../storage/file-store.js";
import { buildWikiLanguageDirective } from "./wiki-output-language.js";
import { isWikiLlmResponseAccepted, withWikiLlmPayloadAlignment } from "./wiki-llm-compat.js";

function buildAnalysisSystemPrompt(purpose: string, schema: string, index: string): string {
	return [
	"You are an expert research analyst. Read the source document and produce a structured analysis.",
	"Do not output chain-of-thought, hidden reasoning, or a thinking transcript. Reason internally and write only the concise final analysis.",
	buildWikiLanguageDirective(),
	"Your analysis should cover:",
	"## Key Entities",
	"List people, organizations, products, datasets, tools mentioned. For each:",
	"- Name and type",
	"- Role in the source (central vs. peripheral)",
	"- Whether it likely already exists in the wiki (check the index)",
	"## Key Concepts",
	"List theories, methods, techniques, phenomena. For each:",
	"- Name and brief definition",
	"- Why it matters in this source",
	"- Whether it likely already exists in the wiki",
	"## Main Arguments & Findings",
	"- What are the core claims or results?",
	"- What evidence supports them?",
	"- How strong is the evidence?",
	"- Which named subject is each claim about? Do not transfer claims, limits, or evaluations from one entity/model/product/method to another just because they share keywords.",
	"## Connections to Existing Wiki",
	"- What existing pages does this source relate to?",
	"- Does it strengthen, challenge, or extend existing knowledge?",
	"## Contradictions & Tensions",
	"- Does anything in this source conflict with existing wiki content?",
	"- Are there internal tensions or caveats?",
	"## Recommendations",
	"- What wiki pages should be created or updated?",
	"- If the project schema (below) defines page types beyond entity/concept (e.g. goal, habit, reflection, finding, decision, meeting), and the source genuinely contains matching content, recommend pages of those types — name the type explicitly. Only when the source actually supports it; never invent goals/habits/journal entries that aren't in the source.",
	"- What should be emphasized vs. de-emphasized?",
	"- Any open questions worth flagging for the user?",
	"Be thorough but concise. Focus on what's genuinely important.",
	"If a folder context is provided, use it as a hint for categorization — the folder structure often reflects the user's organizational intent (e.g., 'papers/energy' suggests the file is an energy-related paper).",
	"",
	schema ? `## Project Schema (page types available — map source content to schema-defined types when it fits)\n${schema}` : "",
	purpose ? `## Wiki Purpose (for context)\n${purpose}` : "",
	index ? `## Current Wiki Index (for checking existing content)\n${index}` : "",
	].filter(Boolean).join("\n");
}

const LONG_SOURCE_CHUNK_MIN = 12_000;
const LONG_SOURCE_CHUNK_MAX = 60_000;
const LONG_SOURCE_DIGEST_MAX = 15_000;
const LONG_SOURCE_CHUNK_ANALYSIS_MAX = 40_000;

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

function trimLongText(text: string, maximum: number): string {
	return text.length <= maximum ? text : `${text.slice(0, maximum).trimEnd()}\n\n[...trimmed for prompt budget...]`;
}

function extractMarkedSection(raw: string, heading: string): string {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i").exec(raw)?.[1]?.trim() ?? "";
}

export function hashLongSourceText(text: string): string {
	let hash = 0xcbf29ce484222325n;
	const prime = 0x100000001b3n;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= BigInt(text.charCodeAt(index));
		hash = BigInt.asUintN(64, hash * prime);
	}
	return hash.toString(16).padStart(16, "0");
}

export function buildChunkSystemPrompt(purpose: string, schema: string, index: string): string {
	return [
		"You are analyzing a long source document for a personal wiki.",
		"Do not output chain-of-thought, hidden reasoning, or a thinking transcript.",
		"Analyze only the current MAIN CHUNK. Use overlap and digest for context only.",
		"Keep stable names consistent with the existing wiki and prior digest.",
	buildWikiLanguageDirective(),
	"Output exactly two markdown sections:",
		"## Chunk Analysis",
		"- Concise summary of the main chunk",
		"- New or updated entities",
		"- New or updated concepts",
		"- Any schema-defined page types beyond entity/concept that the main chunk genuinely supports",
		"- Claims, findings, evidence, contradictions",
		"- Open questions or research gaps",
		"## Updated Global Digest",
		"A compact document-level digest that incorporates this chunk and preserves prior cross-chunk context.",
		"Keep this digest structured under: Summary, Entities, Concepts, Schema-Typed Candidates, Claims, Evidence, Contradictions, Open Questions, Cross-Chunk Relations.",
		"Use schema-defined types only when the source actually supports them; never invent goals, habits, journal entries, decisions, or similar user-authored records that are not present in the source.",
		"Stable project context follows. It changes rarely and should be treated as background:",
		purpose ? `## Wiki Purpose\n${purpose}` : "",
		schema ? `## Wiki Schema\n${schema}` : "",
		index ? `## Current Wiki Index\n${trimLongText(index, 40_000)}` : "",
	].filter(Boolean).join("\n");
}

export function buildChunkUserPrompt(
	sourceIdentity: string,
	chunk: ReturnType<typeof splitSourceIntoSemanticChunks>[number],
	globalDigest: string,
	folderContext?: string,
): string {
	return [
		`Source file: ${sourceIdentity}`,
		folderContext ? `Folder context: ${folderContext}` : "",
		`Chunk: ${chunk.index}/${chunk.total}`,
		chunk.headingPath ? `Heading path: ${chunk.headingPath}` : "",
		"## Current Global Digest",
		globalDigest || "(No prior digest yet.)",
		chunk.overlapBefore ? "## Previous Overlap Context\n" + chunk.overlapBefore : "",
		"## MAIN CHUNK TO ANALYZE",
		chunk.main,
		"Return only the two requested sections. Do not repeat overlap-only facts unless the main chunk supports them.",
	].filter(Boolean).join("\n");
}

async function completeSummary(
	model: Model<any>,
	modelRegistry: ModelRegistry,
	systemPrompt: string,
	userPrompt: string,
	maxTokens: number,
	signal?: AbortSignal,
): Promise<string> {
	try {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			throw new Error("Failed to resolve API key");
		}

		const response = await complete(
			model,
			{
				systemPrompt,
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: userPrompt }],
						timestamp: Date.now(),
					},
				],
			},
			withWikiLlmPayloadAlignment({
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens,
				temperature: 0.1,
				reasoning: "off",
				timeoutMs: 600_000,
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000),
			}),
		);

		if (!isWikiLlmResponseAccepted(response)) {
			throw new Error(response.errorMessage ?? "LLM request failed");
		}

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		return text;
	} catch (err) {
		logger.warn({ err }, "[L2 summarizer] Failed");
		throw err instanceof Error ? err : new Error(String(err));
	}
}

/**
 * Call the agent's configured LLM to generate a structured wiki summary.
 * Returns the generated markdown body, or null on failure.
 */
export async function summarizeContent(
	model: Model<any>,
	modelRegistry: ModelRegistry,
	title: string,
	content: string,
	wikiContext = "（知识库为空）",
	options?: {
		checkpointPath?: string;
		sourceIdentity?: string;
		purpose?: string;
		schema?: string;
		index?: string;
		overview?: string;
			folderContext?: string;
			signal?: AbortSignal;
	},
): Promise<{ analysis: string; sourceContext: string; chunked: boolean } | null> {
	const purpose = options?.purpose ?? "";
	const schema = options?.schema ?? "";
	const index = options?.index ?? wikiContext;
	const overview = options?.overview ?? "";
	const maxContextSize = (model as { contextWindow?: number }).contextWindow;
	// llm-wiki budgets the source against the stable wiki context supplied to
	// autoIngestImpl, including the overview even though Stage 1 does not print it.
	const stableContextLength = purpose.length + schema.length + index.length + overview.length;
	const sourceBudget = computeWikiSourceBudget(maxContextSize, stableContextLength);
	if (content.length <= sourceBudget) {
		const systemPrompt = buildAnalysisSystemPrompt(purpose, schema, index);
		const userPrompt = `Analyze this source document:\n\n**File:** ${options?.sourceIdentity ?? title}${options?.folderContext ? `\n**Folder context:** ${options.folderContext}` : ""}\n\n---\n\n${content}`;
		const analysis = await completeSummary(model, modelRegistry, systemPrompt, userPrompt, 4096, options?.signal);
		return { analysis, sourceContext: content, chunked: false };
	}

	const targetChars = clamp(Math.floor(sourceBudget * 0.55), LONG_SOURCE_CHUNK_MIN, LONG_SOURCE_CHUNK_MAX);
	const overlapChars = clamp(Math.floor(targetChars * 0.08), 800, 3_000);
	const chunks = splitSourceIntoSemanticChunks(content, targetChars, overlapChars);
	if (chunks.length <= 1) {
		const systemPrompt = buildAnalysisSystemPrompt(purpose, schema, index);
		const userPrompt = `Analyze this source document:\n\n**File:** ${options?.sourceIdentity ?? title}${options?.folderContext ? `\n**Folder context:** ${options.folderContext}` : ""}\n\n---\n\n${content}`;
		const analysis = await completeSummary(model, modelRegistry, systemPrompt, userPrompt, 4096, options?.signal);
		return { analysis, sourceContext: content, chunked: false };
	}
	type Checkpoint = {
		version: 1; sourceIdentity: string; sourceHash: string; sourceLength: number; sourceBudget: number; targetChars: number;
		overlapChars: number; chunkTotal: number; completedThrough: number; globalDigest: string; analyses: string[]; updatedAt?: number;
	};
	const identity = options?.sourceIdentity ?? title;
	const sourceHash = hashLongSourceText(content);
	const emptyCheckpoint: Checkpoint = {
		version: 1, sourceIdentity: identity, sourceHash, sourceLength: content.length, sourceBudget, targetChars, overlapChars,
		chunkTotal: chunks.length, completedThrough: 0, globalDigest: "", analyses: [],
	};
	let checkpoint = emptyCheckpoint;
	if (options?.checkpointPath && fileExists(options.checkpointPath)) {
		const candidate = readJson<Checkpoint | null>(options.checkpointPath, null);
		if (candidate?.version === 1 && candidate.sourceIdentity === identity && candidate.sourceHash === sourceHash && candidate.sourceLength === content.length
			&& candidate.sourceBudget === sourceBudget && candidate.targetChars === targetChars && candidate.overlapChars === overlapChars
			&& candidate.chunkTotal === chunks.length && candidate.completedThrough >= 0 && candidate.completedThrough <= chunks.length
			&& Array.isArray(candidate.analyses) && candidate.analyses.length === candidate.completedThrough) checkpoint = candidate;
	}
	let globalDigest = checkpoint.globalDigest;
	const analyses = [...checkpoint.analyses];
	const chunkSystemPrompt = buildChunkSystemPrompt(purpose, schema, index);
	for (const chunk of chunks) {
		if (chunk.index <= checkpoint.completedThrough) continue;
		const raw = await completeSummary(
			model,
			modelRegistry,
			chunkSystemPrompt,
			buildChunkUserPrompt(identity, chunk, trimLongText(globalDigest, LONG_SOURCE_DIGEST_MAX), options?.folderContext),
			4096,
			options?.signal,
		);
		const chunkAnalysis = extractMarkedSection(raw, "Chunk Analysis") || raw.trim();
		const nextDigest = extractMarkedSection(raw, "Updated Global Digest");
		analyses.push(`## Chunk ${chunk.index}/${chunk.total}${chunk.headingPath ? ` — ${chunk.headingPath}` : ""}\n${trimLongText(chunkAnalysis, LONG_SOURCE_CHUNK_ANALYSIS_MAX)}`);
		globalDigest = trimLongText(nextDigest || [globalDigest, chunkAnalysis].filter(Boolean).join("\n\n"), LONG_SOURCE_DIGEST_MAX);
		checkpoint = { ...checkpoint, completedThrough: chunk.index, globalDigest, analyses: [...analyses], updatedAt: Date.now() };
		if (options?.checkpointPath) writeJson(options.checkpointPath, checkpoint);
	}
	const analysis = [
		"# Consolidated Long-Document Analysis", "", "## Final Global Digest", globalDigest || "(No digest produced.)", "",
		"## Per-Chunk Analyses", analyses.join("\n\n"),
	].join("\n");
	const sourceContext = [
		`# Long Source Context: ${identity}`,
		"",
		`The original source was analyzed in ${chunks.length} semantic chunks with paragraph/section boundaries and overlap. Use this consolidated context instead of assuming the raw document ended early.`,
		"",
		"## Final Global Digest",
		globalDigest || "(No digest produced.)",
		"",
		"## Chunk Analysis Notes",
		trimLongText(analyses.join("\n\n"), Math.max(sourceBudget, LONG_SOURCE_CHUNK_ANALYSIS_MAX)),
	].join("\n");
	return { analysis, sourceContext, chunked: true };
}
