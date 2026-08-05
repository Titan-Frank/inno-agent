import type { ChatMessage } from "@inno-web/types/chat.js";

export interface CaseMeta {
	id: string;
	title: string;
	titleEn: string;
	description: string;
	tags: string[];
	recordedAt: string;
	messageCount: number;
}

export interface CaseDoc extends CaseMeta {
	messages: ChatMessage[];
}

export async function fetchCaseIndex(): Promise<CaseMeta[]> {
	const res = await fetch(`${import.meta.env.BASE_URL}cases/index.json`);
	if (!res.ok) throw new Error(`Failed to load case index: ${res.status}`);
	const data = (await res.json()) as { cases: CaseMeta[] };
	return data.cases;
}

export async function fetchCase(id: string): Promise<CaseDoc> {
	const res = await fetch(`${import.meta.env.BASE_URL}cases/${encodeURIComponent(id)}.json`);
	if (!res.ok) throw new Error(`Failed to load case "${id}": ${res.status}`);
	return (await res.json()) as CaseDoc;
}
