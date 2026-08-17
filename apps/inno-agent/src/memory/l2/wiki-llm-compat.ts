import type { AssistantMessage, Model, ProviderStreamOptions } from "@earendil-works/pi-ai";

const ANTHROPIC_CLEAN_EOF_ERROR = "Anthropic stream ended before message_stop";

type AnthropicPayload = {
	messages?: unknown;
};

/**
 * Keep PI's Anthropic wire payload equivalent to llm-wiki's structured calls.
 * PI adds a cache marker to the final user message by default; llm-wiki only
 * marks the system prompt and sends a single text user message.
 */
export function normalizeWikiLlmPayload(payload: unknown, model: Model<any>): unknown {
	if (model.api !== "anthropic-messages" || !payload || typeof payload !== "object") return payload;
	const body = payload as AnthropicPayload;
	if (!Array.isArray(body.messages) || body.messages.length === 0) return payload;
	const sourceMessages = body.messages;

	const messages = sourceMessages.map((message, index) => {
		if (index !== sourceMessages.length - 1 || !message || typeof message !== "object") return message;
		const candidate = message as { role?: unknown; content?: unknown };
		if (candidate.role !== "user" || !Array.isArray(candidate.content) || candidate.content.length !== 1) return message;
		const block = candidate.content[0] as { type?: unknown; text?: unknown; cache_control?: unknown };
		if (block?.type !== "text" || typeof block.text !== "string") return message;
		return { ...candidate, content: block.text };
	});

	return { ...body, messages };
}

export function withWikiLlmPayloadAlignment(options: ProviderStreamOptions): ProviderStreamOptions {
	const existingOnPayload = options.onPayload;
	return {
		...options,
		onPayload: async (payload, model) => {
			const callerPayload = existingOnPayload ? await existingOnPayload(payload, model) : payload;
			return normalizeWikiLlmPayload(callerPayload, model);
		},
	};
}

/**
 * llm-wiki accepts a clean SSE EOF after emitting content even when an
 * Anthropic-compatible gateway omits the final message_stop event. PI reports
 * that exact transport condition as an error while retaining the streamed
 * content, so treat only that condition as a completed Wiki response.
 */
export function isWikiLlmResponseAccepted(
	response: Pick<AssistantMessage, "stopReason" | "errorMessage">,
): boolean {
	return response.stopReason !== "error" || response.errorMessage === ANTHROPIC_CLEAN_EOF_ERROR;
}
