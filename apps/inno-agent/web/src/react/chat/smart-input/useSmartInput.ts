import { useEffect, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { SmartInputEngine, type EngineAttachmentItem, type EngineCallbacks, type EngineSnapshot } from "./engine.js";
import type { SmartInputRule, SmartInputSettings } from "../../../types/settings.js";

export interface UseSmartInputOptions {
	enabled: boolean;
	/** Changes when the composer DOM remounts (welcome ↔ conversation view). */
	remountKey: string;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	mirrorRef: RefObject<HTMLDivElement | null>;
	hitRef: RefObject<HTMLDivElement | null>;
	getSettings: () => SmartInputSettings | undefined;
	getWorkspaceFiles: () => Array<{ name: string; path: string }>;
	takeAttachment: (path: string) => EngineAttachmentItem | undefined;
	returnAttachment: (item: EngineAttachmentItem) => void;
	onToast: (message: string, error?: boolean) => void;
	onChange: () => void;
	onSnapshot?: (snapshot: EngineSnapshot) => void;
	onOpenStatusPanel: EngineCallbacks["onOpenStatusPanel"];
	onOpenFillMenu: EngineCallbacks["onOpenFillMenu"];
	onBubbleContextMenu: EngineCallbacks["onBubbleContextMenu"];
	onChipHover?: EngineCallbacks["onChipHover"];
	onWorkspaceHighlight: EngineCallbacks["onWorkspaceHighlight"];
}

/**
 * Owns the SmartInputEngine lifecycle around the composer textarea. When
 * `enabled` flips off the engine detaches and restores in-draft bubbles back
 * to plain words (settings only affect future input).
 */
export function useSmartInput(options: UseSmartInputOptions) {
	const { t } = useTranslation();
	const engineRef = useRef<SmartInputEngine | null>(null);
	// Slot list survives composer remounts: tokens in the draft keep their PUA
	// ids, so a fresh engine instance adopts the previous slots.
	const stashedSlots = useRef<SmartInputEngine["slots"]>([]);
	// Latest callbacks without re-instantiating the engine on every render.
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const enabled = options.enabled;
	const remountKey = options.remountKey;

	useEffect(() => {
		if (!enabled) return;
		const textarea = optionsRef.current.textareaRef.current;
		const mirror = optionsRef.current.mirrorRef.current;
		const hit = optionsRef.current.hitRef.current;
		if (!textarea || !mirror || !hit) return;

		const current = optionsRef.current;
		const labels = () => ({
			kwHitTitle: t("chat.smartInput.kwHitTitle", "点击转为文件气泡，或拖文件悬停 1 秒自动转换"),
			emptyBubbleTitle: t("chat.smartInput.emptyBubbleTitle", "拖入文件，或点击选择"),
			removeBubble: t("chat.smartInput.removeBubble", "删除气泡"),
			bubbleCreated: t("chat.smartInput.bubbleCreated", "已转为气泡，拖入文件或点击选择"),
			bound: t("chat.smartInput.boundToast", "已绑定 {{name}}"),
			alreadyBound: t("chat.smartInput.alreadyBound", "该文件已绑定在此气泡"),
			typeMismatch: t("chat.smartInput.typeMismatch", "类型不符：文件后缀与该关键词规则不匹配"),
			dragDisabled: t("chat.smartInput.dragDisabled", "设置已关闭拖入填充"),
			noRuleForFile: t("chat.smartInput.noRuleForFile", "没有规则匹配该文件后缀，无法转为气泡"),
			insertedAsBubble: t("chat.smartInput.insertedAsBubble", "已插入为气泡并绑定该文件"),
		});

		const engine = new SmartInputEngine({
			textarea,
			mirror,
			hitLayer: hit,
			labels,
			data: {
				getSettings: () => {
					const settings = current.getSettings();
					return {
						enabled: settings?.enabled ?? false,
						allowDrag: settings?.allowDrag !== false,
						allowRightClick: settings?.allowRightClick !== false,
					};
				},
				getRules: (): SmartInputRule[] => current.getSettings()?.rules ?? [],
				getWorkspaceFiles: () => current.getWorkspaceFiles(),
				takeAttachment: (path) => current.takeAttachment(path),
				returnAttachment: (item) => current.returnAttachment(item),
			},
			callbacks: {
				onToast: (message, error) => current.onToast(message, error),
				onChange: () => current.onChange(),
				onSlotsSnapshot: (snapshot) => current.onSnapshot?.(snapshot),
				onOpenStatusPanel: current.onOpenStatusPanel,
				onOpenFillMenu: current.onOpenFillMenu,
				onBubbleContextMenu: current.onBubbleContextMenu,
				onChipHover: current.onChipHover,
				onWorkspaceHighlight: current.onWorkspaceHighlight,
			},
		});
		engineRef.current = engine;
		engine.adoptSlots(stashedSlots.current);
		engine.attach();

		const onGlobalDragOver = (event: DragEvent) => engine.trackDragPosition(event.clientX, event.clientY);
		const onGlobalDragEnd = () => engine.cancelBubbleDrag();
		const onPageDragStart = (event: Event) => {
			const detail = (event as CustomEvent<{ name: string; path: string; source: "workspace" | "local"; file?: File }>).detail;
			if (detail) engine.markDragStart(detail, `page:${detail.path}`);
		};
		const onPageDragEnd = () => engine.cancelBubbleDrag();
		window.addEventListener("dragover", onGlobalDragOver, true);
		window.addEventListener("dragend", onGlobalDragEnd);
		window.addEventListener("inno-smart-dragstart", onPageDragStart);
		window.addEventListener("inno-smart-dragend", onPageDragEnd);

		return () => {
			window.removeEventListener("dragover", onGlobalDragOver, true);
			window.removeEventListener("dragend", onGlobalDragEnd);
			window.removeEventListener("inno-smart-dragstart", onPageDragStart);
			window.removeEventListener("inno-smart-dragend", onPageDragEnd);
			if (!optionsRef.current.enabled) {
				// Feature turned off: settings only affect future input, so
				// bubbles restore to plain words and slots are dropped.
				stashedSlots.current = [];
				engine.detach();
			} else {
				// Composer remount: keep slots for the next engine instance; the
				// draft value (with tokens) survives via defaultValue.
				engine.detachForRemount();
				stashedSlots.current = engine.slots;
			}
			engineRef.current = null;
		};
	}, [enabled, remountKey, t]);

	return engineRef;
}
