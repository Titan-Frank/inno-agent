import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PendingUpload } from "./composer-utils.js";
import { KIND_COLORS, kindFromName } from "./smart-input/kinds.js";

export interface ChatUploadChipsProps {
	uploads: PendingUpload[];
	onRemove: (index: number) => void;
	/** Re-arm a failed local upload so the next send retries it. */
	onRetry?: (index: number) => void;
	/** Present when smart input is on: right-click "insert as bubble". */
	onInsertAsBubble?: (path: string) => void;
}

/**
 * Composer attachment row: workspace files attach instantly ("工作区" tag),
 * local files upload at send time with a live progress ring and stay
 * retryable on failure. Chips are draggable onto keyword bubbles and expose
 * a right-click menu when smart input is enabled.
 */
export function ChatUploadChips({ uploads, onRemove, onRetry, onInsertAsBubble }: ChatUploadChipsProps) {
	const { t } = useTranslation();
	const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!menu) return;
		const close = (event: PointerEvent) => {
			if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMenu(null);
		};
		document.addEventListener("pointerdown", close);
		window.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", close);
			window.removeEventListener("keydown", onKey);
		};
	}, [menu]);

	if (uploads.length === 0) return null;

	const startPageDrag = (item: PendingUpload) => {
		const detail = { name: item.fileName, path: item.path, source: item.source === "workspace" ? "workspace" as const : "local" as const, file: item.file };
		window.dispatchEvent(new CustomEvent("inno-smart-dragstart", { detail }));
	};

	return (
		<div className="mb-2 flex flex-wrap gap-1.5">
			{uploads.map((file, index) => {
				const kind = kindFromName(file.fileName);
				const uploading = file.status === "uploading";
				const failed = file.status === "failed";
				return (
					<span
						key={`${file.path}-${index}`}
						draggable
						onDragStart={(event) => {
							if (onInsertAsBubble) {
								event.dataTransfer.setData("application/x-inno-file", JSON.stringify({ name: file.fileName, path: file.path, source: file.source }));
								event.dataTransfer.effectAllowed = "copy";
								startPageDrag(file);
							}
						}}
						onDragEnd={() => {
							if (onInsertAsBubble) window.dispatchEvent(new CustomEvent("inno-smart-dragend"));
						}}
						onContextMenu={(event) => {
							if (!onInsertAsBubble) return;
							event.preventDefault();
							setMenu({ x: event.clientX, y: event.clientY, index });
						}}
						className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs shadow-sm ${
							onInsertAsBubble ? "cursor-grab" : ""
						} ${
							failed
								? "border-[var(--inno-danger-border)] bg-[var(--inno-danger-bg)]"
								: "border-[var(--inno-border)] bg-[var(--inno-surface-muted)]"
						}`}
						title={file.path}
					>
						<span aria-hidden="true" className="inno-smart-type-dot" style={{ backgroundColor: KIND_COLORS[kind] }} />
						<span className="max-w-[220px] truncate text-[var(--inno-text)]">{file.fileName}</span>
						{file.source === "workspace" ? (
							<span className="text-[10px] text-[var(--inno-text-subtle)]">{t("chat.smartInput.sourceWorkspace", "工作区")}</span>
						) : uploading ? (
							<span
								className="inno-smart-progress-ring"
								data-pct={Math.floor(file.pct)}
								style={{ ["--p" as string]: `${file.pct}` }}
								title={t("chat.smartInput.uploadingPct", "上传中 {{pct}}%", { pct: Math.floor(file.pct) })}
							/>
						) : failed ? (
							<span className="flex items-center gap-0.5">
								<span className="text-[10px] text-[var(--inno-danger)]">{t("chat.smartInput.uploadFailed", "失败")}</span>
								{onRetry ? (
									<button
										type="button"
										className="inno-smart-retry-btn"
										title={t("chat.smartInput.retryUpload", "重试上传（随下次发送）")}
										onClick={() => onRetry(index)}
									>
										<RotateCcw size={12} />
									</button>
								) : null}
							</span>
						) : (
							<span className="text-[10px] text-[var(--inno-text-subtle)]">{t("chat.smartInput.sourceUploadPending", "待上传")}</span>
						)}
						<button
							type="button"
							className="text-[var(--inno-text-muted)] hover:text-[var(--inno-text)]"
							title={t("chat.removeUpload")}
							onClick={() => onRemove(index)}
						>
							<X size={14} />
						</button>
					</span>
				);
			})}
			{menu ? createPortal(
				(
					<div ref={menuRef} className="inno-smart-menu" style={{ left: menu.x, top: menu.y }}>
						<button
							type="button"
							className="inno-smart-menu-item"
							onClick={() => {
								setMenu(null);
								onInsertAsBubble?.(uploads[menu.index].path);
							}}
						>
							{t("chat.smartInput.insertAsBubble", "插入为气泡")}
						</button>
						<button
							type="button"
							className="inno-smart-menu-item is-danger"
							onClick={() => {
								onRemove(menu.index);
								setMenu(null);
							}}
						>
							{t("chat.smartInput.removeAttachment", "移除附件")}
						</button>
					</div>
				),
				document.body,
			) : null}
		</div>
	);
}
