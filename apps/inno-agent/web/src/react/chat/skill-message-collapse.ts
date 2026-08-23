/**
 * The PI SDK expands `/skill:name args` into a full `<skill …>…</skill>`
 * document BEFORE the user message is persisted, so session history stores the
 * whole skill body. Rendering that verbatim floods the chat — collapse the
 * envelope back into a compact placeholder chip for display only. The LLM-side
 * content is untouched; this is a pure presentation-layer transform.
 */
export interface CollapsedSkillMessage {
	skillName: string;
	args: string;
}

// Mirrors the envelope built by the SDK's skill expansion:
//   <skill name="…" location="…">\n…\n</skill>            (no args)
//   <skill name="…" location="…">\n…\n</skill>\n\n<args>  (with args)
const SKILL_MESSAGE_RE = /^<skill name="([^"]+)" location="[^"]*">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

export function collapseSkillMessage(text: string): CollapsedSkillMessage | null {
	const match = SKILL_MESSAGE_RE.exec(text.trim());
	if (!match) return null;
	return { skillName: match[1], args: (match[2] ?? "").trim() };
}
