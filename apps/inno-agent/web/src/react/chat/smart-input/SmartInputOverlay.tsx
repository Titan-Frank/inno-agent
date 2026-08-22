import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Check, Plus, RotateCcw, X } from "lucide-react";
import type { EngineAttachmentItem, SmartInputEngine } from "./engine.js";
import { KIND_COLORS, KIND_LABEL_KEYS, kindFromName, nameMatchesExtensions } from "./kinds.js";
import type { PendingUpload } from "../composer-utils.js";

/**
 * Floating panels for the smart-input composer: status panel (bound files,
 * live upload progress, retry), fill menu (workspace picker + batch
 * multi-select) and the bubble context menu. Portal-rendered and clamped to
 * the viewport; behavior ports the v76 prototype (hover 450ms open, 260ms
 * auto-close, pin-on-interact, >25px real move to unpin).
 */

export interface SmartPanelState {
	kind: "status" | "fill" | "menu";
	slotId: number;
	anchor: { left: number; bottom: number };
	/** Context-menu coordinates (kind === "menu"). */
	x?: number;
	y?: number;
}

interface SmartInputOverlayProps {
	engine: SmartInputEngine | null;
	panel: SmartPanelState | null;
	onClose: () => void;
	onOpenPanel: (panel: SmartPanelState) => void;
	workspaceFiles: Array<{ name: string; path: string }>;
	attachments: PendingUpload[];
	takeAttachment: (path: string) => EngineAttachmentItem | undefined;
	onWorkspaceHighlight: (paths: string[] | null) => void;
}

const AUTO_CLOSE_MS = 260;
const UNPIN_MOVE_PX = 25;

function rectOf(el: HTMLElement): SmartPanelState["anchor"] {
	const rect = el.getBoundingClientRect();
	return { left: rect.left, bottom: rect.bottom };
}

function chipFor(engine: SmartInputEngine | null, slotId: number): HTMLElement | null {
	void engine;
	return document.querySelector<HTMLElement>(`.inno-smart-chip[data-slot-id="${slotId}"]`);
}

export function SmartInputOverlay({ engine, panel, onClose, onOpenPanel, workspaceFiles, attachments, takeAttachment, onWorkspaceHighlight }: SmartInputOverlayProps) {
	const { t } = useTranslation();
	const panelRef = useRef<HTMLDivElement | null>(null);
	const closeTimer = useRef<number | null>(null);
	const pinned = useRef(false);
	const pinPos = useRef({ x: 0, y: 0 });
	const justOpened = useRef(false);
	const [multiSelect, setMultiSelect] = useState(false);
	const [picked, setPicked] = useState<Map<string, string>>(new Map());

	const slot = panel ? engine?.slots.find((entry) => entry.id === panel.slotId) ?? null : null;

	const cancelClose = useCallback(() => {
		if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
		closeTimer.current = null;
	}, []);

	const scheduleClose = useCallback(() => {
		cancelClose();
		closeTimer.current = window.setTimeout(() => {
			if (pinned.current) {
				scheduleClose();
				return;
			}
			const el = panelRef.current;
			if (el && (el.matches(":hover") || document.querySelector(".inno-smart-chip:hover"))) {
				scheduleClose();
				return;
			}
			onClose();
		}, AUTO_CLOSE_MS);
	}, [cancelClose, onClose]);

	const pin = useCallback((event: { clientX: number; clientY: number }) => {
		pinned.current = true;
		pinPos.current = { x: event.clientX, y: event.clientY };
	}, []);

	// Clamp after mount so measurements are real; runs for every panel kind.
	useEffect(() => {
		if (!panel || !panelRef.current) return;
		justOpened.current = true;
		cancelClose();
		const el = panelRef.current;
		const desiredLeft = panel.kind === "menu" ? panel.x ?? panel.anchor.left : panel.anchor.left;
		const desiredTop = panel.kind === "menu" ? panel.y ?? panel.anchor.bottom + 6 : panel.anchor.bottom + 6;
		const width = el.offsetWidth;
		const height = el.offsetHeight;
		el.style.left = `${Math.max(8, Math.min(desiredLeft, window.innerWidth - width - 8))}px`;
		el.style.top = `${Math.max(8, Math.min(desiredTop, window.innerHeight - height - 8))}px`;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [panel?.kind, panel?.slotId]);

	// Reset transient state when the panel closes.
	useEffect(() => {
		if (panel) return;
		pinned.current = false;
		setMultiSelect(false);
		setPicked(new Map());
		onWorkspaceHighlight(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [panel]);

	// Outside click / capture scroll / ESC close, with the opening click swallowed.
	useEffect(() => {
		if (!panel) return;
		const onPointerDown = (event: PointerEvent) => {
			if (justOpened.current) {
				justOpened.current = false;
				return;
			}
			const target = event.target as Node;
			if (target.isConnected === false) return;
			if (panelRef.current?.contains(target)) return;
			if ((target as HTMLElement).closest?.(".inno-smart-chip")) return;
			onClose();
		};
		const onScroll = () => onClose();
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		const onMouseMove = (event: MouseEvent) => {
			if (!pinned.current || !panelRef.current) return;
			if (Math.hypot(event.clientX - pinPos.current.x, event.clientY - pinPos.current.y) < UNPIN_MOVE_PX) return;
			const target = event.target as Node;
			if (panelRef.current.contains(target) || (target as HTMLElement).closest?.(".inno-smart-chip")) return;
			pinned.current = false;
			scheduleClose();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("scroll", onScroll, true);
		window.addEventListener("keydown", onKey);
		document.addEventListener("mousemove", onMouseMove);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("keydown", onKey);
			document.removeEventListener("mousemove", onMouseMove);
		};
	}, [panel, onClose, scheduleClose]);

	useEffect(() => () => {
		if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
	}, []);

	if (!panel || !engine || !slot) return null;

	const primaryKind = kindFromName(`x${slot.rule.extensions[0] ?? ""}`);
	const kindLabel = t(KIND_LABEL_KEYS[primaryKind]);
	const ruleAccepts = (name: string) => nameMatchesExtensions(name, slot.rule.extensions);

	const openStatus = () => {
		const chip = chipFor(engine, slot.id);
		if (chip) onOpenPanel({ kind: "status", slotId: slot.id, anchor: rectOf(chip) });
	};
	const openFill = () => {
		const chip = chipFor(engine, slot.id);
		if (chip) onOpenPanel({ kind: "fill", slotId: slot.id, anchor: rectOf(chip) });
	};

	const sourceLabel = (file: SmartInputEngine["slots"][number]["files"][number]) => {
		if (file.source === "workspace") return t("chat.smartInput.sourceWorkspace", "工作区");
		if (file.state === "failed") return t("chat.smartInput.uploadFailed", "失败");
		if (file.state === "uploading") return `${Math.floor(file.pct)}%`;
		if (file.state === "local") return t("chat.smartInput.sourceUploadPending", "待上传");
		return t("chat.smartInput.sourceUpload", "本地上传");
	};

	const fillCandidates = [
		...workspaceFiles.filter((file) => ruleAccepts(file.name)).map((file) => ({ name: file.name, path: file.path, source: "workspace" as const })),
		...attachments
			.filter((item) => item.source === "workspace" && ruleAccepts(item.fileName))
			.map((item) => ({ name: item.fileName, path: item.path, source: "attach" as const })),
	];

	const bindCandidate = (candidate: { name: string; path: string; source: string }) => {
		if (candidate.source === "attach") {
			const item = takeAttachment(candidate.path);
			if (item) engine.bindFileToSlot(slot, item);
		} else {
			engine.bindWorkspaceFile(slot, candidate.path);
		}
	};

	const renderProgress = (file: SlotFile) => {
		if (file.state === "uploading") {
			return <span className="inno-smart-progress-ring" style={{ ["--p" as string]: `${file.pct}` }} title={`${Math.floor(file.pct)}%`} />;
		}
		if (file.state === "failed") {
			return (
				<button type="button" className="inno-smart-retry-btn" title={t("chat.smartInput.retryUpload", "重试上传")} onClick={(event) => { pin(event); engine.retryUpload(file.uid); }}>
					<RotateCcw size={12} />
				</button>
			);
		}
		if (file.state === "local") {
			return <span className="inno-smart-status-pending" title={t("chat.smartInput.sourceUploadPending", "待上传")}>…</span>;
		}
		return <span className="inno-smart-status-done">✓</span>;
	};

	const renderStatusPanel = () => (
		<div
			ref={panelRef}
			className="inno-smart-panel"
			onMouseEnter={cancelClose}
			onMouseLeave={scheduleClose}
			style={{ left: panel.anchor.left, top: panel.anchor.bottom + 6 }}
		>
			<div className="inno-smart-panel-title">
				{t("chat.smartInput.boundFilesTitle", "「{{word}}」绑定的文件（{{count}}）", { word: slot.word, count: slot.files.length })}
			</div>
			<div
				className="inno-smart-panel-list"
				onMouseEnter={() => onWorkspaceHighlight(slot.files.map((file) => file.path))}
				onMouseLeave={() => onWorkspaceHighlight(null)}
				style={{ gridTemplateColumns: `repeat(${Math.min(3, Math.max(1, Math.ceil(slot.files.length / 3)))}, minmax(0, 1fr))` }}
			>
				{slot.files.map((file) => (
					<div
						key={file.uid}
						className="inno-smart-panel-row"
						onMouseEnter={() => onWorkspaceHighlight([file.path])}
					>
						<span aria-hidden="true" className="inno-smart-type-dot" style={{ backgroundColor: KIND_COLORS[kindFromName(file.name)] }} />
						<span className="inno-smart-panel-name" title={file.path}>{file.name}</span>
						<span className="inno-smart-src-tag">{sourceLabel(file)}</span>
						{renderProgress(file)}
						<button
							type="button"
							className="inno-smart-panel-remove"
							title={t("chat.smartInput.removeBinding", "移除绑定")}
							onClick={(event) => {
								pin(event);
								const wasLast = slot.files.length <= 1;
								engine.removeBinding(slot, file.uid);
								if (wasLast) {
									onClose();
									openFill();
								}
							}}
						>
							<X size={12} />
						</button>
					</div>
				))}
			</div>
			<div className="inno-smart-panel-caption">{t("chat.smartInput.kindLabel", "类型")}: {kindLabel}</div>
		</div>
	);

	const renderFillMenu = () => (
		<div
			ref={panelRef}
			className="inno-smart-panel inno-smart-panel--fill"
			onMouseEnter={cancelClose}
			onMouseLeave={scheduleClose}
			style={{ left: panel.anchor.left, top: panel.anchor.bottom + 6 }}
		>
			<div className="inno-smart-fill-head">
				<div className="inno-smart-panel-title">
					{t("chat.smartInput.pickFileTitle", "选择{{kind}}文件（工作区）", { kind: kindLabel })}
				</div>
				{fillCandidates.length > 0 ? (
					<button
						type="button"
						className={`inno-smart-fill-plus ${multiSelect ? "is-on" : ""}`}
						title={t("chat.smartInput.batchAdd", "批量添加")}
						onClick={() => {
							setMultiSelect((value) => !value);
							setPicked(new Map());
						}}
					>
						<Plus size={12} />
					</button>
				) : null}
			</div>
			{fillCandidates.length === 0 ? (
				<div className="inno-smart-panel-empty">{t("chat.smartInput.workspaceNoMatch", "工作区暂无匹配该规则的文件")}</div>
			) : (
				<div
					className={`inno-smart-panel-list inno-smart-panel-grid ${multiSelect ? "is-multi" : ""}`}
					onMouseEnter={() => onWorkspaceHighlight(fillCandidates.filter((c) => c.source === "workspace").map((c) => c.path))}
					onMouseLeave={() => onWorkspaceHighlight(null)}
					style={{ gridTemplateColumns: `repeat(${Math.min(3, Math.max(1, Math.ceil(fillCandidates.length / 3)))}, minmax(0, 1fr))` }}
				>
					{fillCandidates.map((candidate) => {
						const active = picked.has(candidate.path);
						return (
							<button
								key={`${candidate.source}:${candidate.path}`}
								type="button"
								className={`inno-smart-panel-row inno-smart-panel-pick ${active ? "is-on" : ""}`}
								title={candidate.path}
								onMouseEnter={() => onWorkspaceHighlight(candidate.source === "workspace" ? [candidate.path] : null)}
								onClick={(event) => {
									if (multiSelect) {
										pin(event);
										setPicked((current) => {
											const next = new Map(current);
											if (next.has(candidate.path)) next.delete(candidate.path);
											else next.set(candidate.path, candidate.source);
											return next;
										});
										return;
									}
									bindCandidate(candidate);
									onClose();
								}}
							>
								<span aria-hidden="true" className="inno-smart-type-dot" style={{ backgroundColor: KIND_COLORS[kindFromName(candidate.name)] }} />
								<span className="inno-smart-panel-name">{candidate.name}</span>
								{candidate.source === "attach" ? <span className="inno-smart-src-tag">{t("chat.smartInput.sourceAttach", "附件")}</span> : null}
								{multiSelect && active ? <Check size={12} className="shrink-0 text-[var(--inno-accent)]" /> : null}
							</button>
						);
					})}
				</div>
			)}
			{multiSelect ? (
				<div className="inno-smart-fill-foot">
					<button type="button" className="inno-smart-fill-btn" onClick={onClose}>{t("common.cancel", "取消")}</button>
					<button
						type="button"
						className="inno-smart-fill-btn is-primary"
						disabled={picked.size === 0}
						onClick={() => {
							for (const [path, source] of picked) {
								bindCandidate({ name: path.split("/").pop() ?? path, path, source });
							}
							if (picked.size > 0) openStatus();
							onClose();
						}}
					>
						✓ {picked.size}
					</button>
				</div>
			) : null}
		</div>
	);

	const renderMenu = () => {
		const items: Array<{ label: string; onClick?: () => void; danger?: boolean } | "sep"> = [];
		if (slot.files.length > 0) {
			items.push({ label: t("chat.smartInput.viewStatus", "查看上传状态"), onClick: openStatus });
			items.push({ label: t("chat.smartInput.unbindAll", "移除全部绑定（{{count}} 个文件回到附件）", { count: slot.files.length }), onClick: () => engine.unbindAll(slot) });
			items.push("sep");
		} else {
			items.push({ label: t("chat.smartInput.chooseFile", "选择文件…"), onClick: openFill });
			items.push("sep");
		}
		items.push({ label: t("chat.smartInput.ignoreBubble", "忽略气泡（还原为文字）"), onClick: () => engine.removeSlot(slot), danger: true });

		return (
			<div ref={panelRef} className="inno-smart-menu" style={{ left: panel.x ?? 0, top: panel.y ?? 0 }}>
				{items.map((item, index) => item === "sep"
					? <div key={index} className="inno-smart-menu-sep" />
					: (
						<button
							key={index}
							type="button"
							className={`inno-smart-menu-item ${item.danger ? "is-danger" : ""}`}
							onClick={() => { onClose(); item.onClick?.(); }}
						>
							{item.label}
						</button>
					),
				)}
			</div>
		);
	};

	const node = panel.kind === "status" ? renderStatusPanel() : panel.kind === "fill" ? renderFillMenu() : renderMenu();
	return createPortal(node, document.body);
}

type SlotFile = SmartInputEngine["slots"][number]["files"][number];
