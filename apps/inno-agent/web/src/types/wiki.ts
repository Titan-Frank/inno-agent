export type BuiltInWikiPageType = "source-summary" | "source" | "entity" | "concept" | "query" | "comparison" | "synthesis" | "analysis";
export type WikiPageType = BuiltInWikiPageType | (string & {});
export type WikiPageStatus = "draft" | "reviewed" | "outdated";
export type ConfidenceLevel = "low" | "medium" | "high";

export interface WikiPageFrontmatter {
	title: string;
	created: string;
	type: WikiPageType;
	tags: string[];
	related?: string[];
	sources: string[];
	source_ids: string[];
	updated: string;
	status: WikiPageStatus;
	confidence: ConfidenceLevel;
	contested?: boolean;
	contradictions?: string[];
}

export interface WikiPageSummary {
	path: string;
	frontmatter: WikiPageFrontmatter | null;
	bodyPreview: string;
	sourceId: string;
}

export interface WikiPageDetail {
	path: string;
	content: string;
}

export interface WikiGraphData {
	nodes: WikiGraphNode[];
	edges: WikiGraphEdge[];
	communities?: WikiGraphCommunities;
}

export interface WikiGraphNode {
	id: string;
	title: string;
	type: WikiPageType | "tag";
	tags: string[];
	degree?: number;
	community?: number;
}

export interface WikiGraphEdge {
	source: string;
	target: string;
	type: "link" | "tag";
	weight?: number;
}

export interface WikiGraphCommunities {
	count: number;
	modularity: number;
	lowCohesion: { community: number; cohesion: number; size: number }[];
}

export interface WikiStats {
	pageCount: number;
	totalSize: number;
	entryCount: number;
}
