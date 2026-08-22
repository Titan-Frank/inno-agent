import type { AttachmentFileKind } from "../../../types/chat.js";

/**
 * Shared file-kind vocabulary for smart input (便捷输入) attachments: the
 * fixed type colors kept from the v76 prototype (red/blue/green/orange/
 * purple/gray hues) and the extension → kind mapping used to color and
 * type-check bubbles, chips and settings previews. Pure constants — safe to
 * import from props-only render modules (showcase replay included).
 */

/** Type color per kind — fixed hues blended into the theme surface via CSS. */
export const KIND_COLORS: Record<AttachmentFileKind, string> = {
	pdf: "#ef4444",
	doc: "#3b82f6",
	xls: "#22c55e",
	ppt: "#f97316",
	image: "#a855f7",
	file: "#8b92a5",
};

/** i18n keys for short kind labels (PDF / 文档 / 表格 / 幻灯片 / 图片 / 文件). */
export const KIND_LABEL_KEYS: Record<AttachmentFileKind, string> = {
	pdf: "chat.smartInput.kinds.pdf",
	doc: "chat.smartInput.kinds.doc",
	xls: "chat.smartInput.kinds.xls",
	ppt: "chat.smartInput.kinds.ppt",
	image: "chat.smartInput.kinds.image",
	file: "chat.smartInput.kinds.file",
};

/** Extension (with leading dot, lowercase) → kind. Unknown → "file". */
const EXTENSION_KINDS: Record<string, AttachmentFileKind> = {
	".pdf": "pdf",
	".doc": "doc",
	".docx": "doc",
	".rtf": "doc",
	".txt": "doc",
	".md": "doc",
	".xls": "xls",
	".xlsx": "xls",
	".csv": "xls",
	".ppt": "ppt",
	".pptx": "ppt",
	".png": "image",
	".jpg": "image",
	".jpeg": "image",
	".gif": "image",
	".webp": "image",
	".bmp": "image",
	".tiff": "image",
	".svg": "image",
};

export function extensionOf(name: string): string {
	const index = name.lastIndexOf(".");
	return index === -1 ? "" : name.slice(index).toLowerCase();
}

export function kindFromExtension(ext: string): AttachmentFileKind {
	return EXTENSION_KINDS[ext] ?? "file";
}

/** Kind for a file name or workspace path (last path segment's extension). */
export function kindFromName(name: string): AttachmentFileKind {
	const base = name.split("/").pop() ?? name;
	return kindFromExtension(extensionOf(base));
}

/** true when `name`'s extension is in `extensions` (literal, dot-prefixed). */
export function nameMatchesExtensions(name: string, extensions: string[]): boolean {
	const ext = extensionOf(name);
	return extensions.some((candidate) => {
		const normalized = candidate.startsWith(".") ? candidate.toLowerCase() : `.${candidate.toLowerCase()}`;
		return normalized === ext;
	});
}
