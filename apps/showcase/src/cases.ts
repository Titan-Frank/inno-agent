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

export interface WorkspaceInitFile {
	path: string;
	content?: string;
	asset?: string;
	size: number;
	updatedAt: string;
}

export interface WorkspaceKeyframe {
	atMessage: number;
	path: string;
	content: string;
	change: "created" | "modified";
}

export interface WikiKeyframe {
	atMessage: number;
	page: { path: string; title: string; content: string };
}

export interface CasePanels {
	workspace: {
		workspaceId: string;
		name: string;
		initial: WorkspaceInitFile[];
		keyframes: WorkspaceKeyframe[];
	} | null;
	wiki: { keyframes: WikiKeyframe[] };
	profile: {
		firstEventAt: number | null;
		events: Array<{ atMessage: number; summary: string }>;
		profile: unknown | null;
	};
}

export interface CaseDoc extends CaseMeta {
	messages: ChatMessage[];
	panels: CasePanels;
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
