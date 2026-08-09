import { realpathSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";

/**
 * Pure file/path helpers shared by the server route domains (skills,
 * workspaces) and server.ts itself. Extracted verbatim from server.ts during
 * the P2 route split — everything here is stateless.
 */

export function safeJoin(baseDir: string, userPath: string): string | null {
	const resolvedBase = resolve(baseDir);
	const resolvedPath = resolve(resolvedBase, userPath);
	const rel = relative(resolvedBase, resolvedPath);
	if (rel.startsWith("..") || resolve(rel) === rel) return null;
	return resolvedPath;
}

export function slugifySkillName(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64);
	return slug || "uploaded-skill";
}

export const WORKSPACE_TREE_MAX_DEPTH = 8;

/**
 * Canonicalize a tree root for containment checks. The root itself may
 * contain symlink components (e.g. macOS /tmp → /private/tmp); children's
 * realpaths never match a non-canonical root, which would silently render
 * every directory empty.
 */
export function canonicalTreeRoot(dir: string): string {
	try {
		return realpathSync(dir);
	} catch {
		return dir;
	}
}

export interface WorkspaceTreeNode {
	name: string;
	path: string;
	type: "file" | "directory";
	size?: number;
	updatedAt?: string;
	children?: WorkspaceTreeNode[];
}

export const TEXT_PREVIEW_EXTENSIONS = new Set([
	".txt",
	".md",
	".markdown",
	".json",
	".jsonl",
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".css",
	".html",
	".htm",
	".xml",
	".yaml",
	".yml",
	".csv",
	".log",
	".py",
	".rb",
	".go",
	".rs",
	".java",
	".kt",
	".kts",
	".swift",
	".c",
	".cpp",
	".cc",
	".cxx",
	".h",
	".hpp",
	".cs",
	".php",
	".r",
	".R",
	".lua",
	".pl",
	".pm",
	".sh",
	".bash",
	".zsh",
	".fish",
	".bat",
	".ps1",
	".sql",
	".graphql",
	".gql",
	".toml",
	".ini",
	".cfg",
	".conf",
	".env",
	".gitignore",
	".dockerignore",
	".editorconfig",
	".prettierrc",
	".eslintrc",
	".scss",
	".sass",
	".less",
	".vue",
	".svelte",
	".astro",
	".tf",
	".proto",
	".gradle",
	".cmake",
	".makefile",
	".dockerfile",
]);

export const TEXT_NOEXT_NAMES = new Set(["makefile", "dockerfile", "gemfile", "rakefile", "procfile", "vagrantfile"]);

/** Office document extensions previewable via LiteParse text extraction. */
export const OFFICE_PREVIEW_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);

/** Map an office extension to a preview format the frontend dispatches on. */
export function officeFormat(filePath: string): "docx" | "xlsx" | "pptx" | undefined {
	const ext = extname(filePath).toLowerCase();
	if (ext === ".docx") return "docx";
	if (ext === ".xlsx") return "xlsx";
	if (ext === ".pptx") return "pptx";
	return undefined;
}

/** Whether a file looks like a dotfile config (almost always text). */
export function isDotfileText(filePath: string): boolean {
	return basename(filePath).startsWith(".");
}

export function contentTypeForWorkspaceFile(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	if (ext === ".pdf") return "application/pdf";
	if (ext === ".html" || ext === ".htm") return "text/html; charset=utf-8";
	if (ext === ".md" || ext === ".markdown") return "text/markdown; charset=utf-8";
	if (ext === ".json") return "application/json; charset=utf-8";
	if (ext === ".png") return "image/png";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".gif") return "image/gif";
	if (ext === ".svg") return "image/svg+xml";
	if (ext === ".webp") return "image/webp";
	if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
	if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
	if (ext === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
	if (TEXT_PREVIEW_EXTENSIONS.has(ext)) return "text/plain; charset=utf-8";
	if (isDotfileText(filePath)) return "text/plain; charset=utf-8";
	return "application/octet-stream";
}

export function workspaceFileKind(filePath: string): "markdown" | "html" | "pdf" | "image" | "office" | "text" | "binary" {
	const ext = extname(filePath).toLowerCase();
	if (ext === ".md" || ext === ".markdown") return "markdown";
	if (ext === ".html" || ext === ".htm") return "html";
	if (ext === ".pdf") return "pdf";
	if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"].includes(ext)) return "image";
	if (OFFICE_PREVIEW_EXTENSIONS.has(ext)) return "office";
	if (TEXT_PREVIEW_EXTENSIONS.has(ext)) return "text";
	if (!ext && TEXT_NOEXT_NAMES.has(basename(filePath).toLowerCase())) return "text";
	// Dotfiles (.env, .env.local, .npmrc, .gitconfig, etc.) are text config files
	if (isDotfileText(filePath)) return "text";
	return "binary";
}
