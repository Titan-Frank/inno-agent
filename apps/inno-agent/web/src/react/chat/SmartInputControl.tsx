import { ChevronDown, ChevronUp, FlaskConical, Keyboard } from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SmartInputRule, SmartInputSettings } from "../../types/settings.js";
import { PopoverSurface } from "../ui/PopoverSurface.js";
import { Switch } from "../ui/Switch.js";

export interface SmartInputControlProps {
	smartInputSettings?: SmartInputSettings;
	onToggleSmartInput: () => void;
	onToggleSmartInputRule: (ruleId: string) => void;
	smartInputSaving?: boolean;
	onOpenSmartInputSettings: () => void;
	compact?: boolean;
}

export function SmartInputControl({
	smartInputSettings,
	onToggleSmartInput,
	onToggleSmartInputRule,
	smartInputSaving = false,
	onOpenSmartInputSettings,
	compact = false,
}: SmartInputControlProps) {
	const { t } = useTranslation();
	const smartInputRef = useRef<HTMLDivElement | null>(null);
	const smartInputTriggerRef = useRef<HTMLButtonElement | null>(null);
	const smartInputPanelRef = useRef<HTMLDivElement | null>(null);
	const [smartInputMenuOpen, setSmartInputMenuOpen] = useState(false);
	const [smartInputMenuPosition, setSmartInputMenuPosition] = useState({ left: 8, top: 8 });

	const repositionSmartInputMenu = useCallback(() => {
		if (!smartInputMenuOpen) return;
		const trigger = smartInputTriggerRef.current;
		const panel = smartInputPanelRef.current;
		if (!trigger || !panel) return;

		const margin = 8;
		const triggerRect = trigger.getBoundingClientRect();
		const panelRect = panel.getBoundingClientRect();
		const width = panel.offsetWidth || panelRect.width;
		const height = panel.offsetHeight || panelRect.height;
		const maxLeft = Math.max(margin, window.innerWidth - width - margin);
		const preferredLeft = compact ? triggerRect.left - width - margin : triggerRect.left;
		const left = Math.max(margin, Math.min(preferredLeft, maxLeft));
		const aboveSpace = triggerRect.top - margin;
		const belowSpace = window.innerHeight - triggerRect.bottom - margin;
		const openAbove = aboveSpace >= height || aboveSpace >= belowSpace;
		const preferredTop = openAbove
			? triggerRect.top - height - margin
			: triggerRect.bottom + margin;
		const maxTop = Math.max(margin, window.innerHeight - height - margin);
		const top = Math.max(margin, Math.min(preferredTop, maxTop));

		setSmartInputMenuPosition((previous) => previous.left === left && previous.top === top ? previous : { left, top });
	}, [compact, smartInputMenuOpen]);

	useEffect(() => {
		if (!smartInputMenuOpen) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (smartInputRef.current?.contains(target) || smartInputPanelRef.current?.contains(target)) return;
			setSmartInputMenuOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setSmartInputMenuOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [smartInputMenuOpen]);

	useLayoutEffect(() => {
		if (!smartInputMenuOpen) return;
		repositionSmartInputMenu();
		const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(repositionSmartInputMenu);
		for (const target of [smartInputTriggerRef.current, smartInputPanelRef.current]) {
			if (target) resizeObserver?.observe(target);
		}
		window.addEventListener("resize", repositionSmartInputMenu);
		document.addEventListener("scroll", repositionSmartInputMenu, true);
		return () => {
			resizeObserver?.disconnect();
			window.removeEventListener("resize", repositionSmartInputMenu);
			document.removeEventListener("scroll", repositionSmartInputMenu, true);
		};
	}, [repositionSmartInputMenu, smartInputMenuOpen]);

	const rules = smartInputSettings?.rules ?? [];
	const enabledRuleCount = rules.filter((rule) => rule.enabled).length;
	const dragFeatureEnabled = smartInputSettings?.enabled === true && smartInputSettings.allowDrag === true;
	const rightClickFeatureEnabled = smartInputSettings?.enabled === true && smartInputSettings.allowRightClick === true;
	const agentCommandFeatureEnabled = smartInputSettings?.enabled === true && smartInputSettings.allowAgentCommands === true;
	const isRuleActive = (rule: SmartInputRule): boolean => Boolean(
		smartInputSettings?.enabled
			&& rule.enabled
			&& rule.keyword
			&& (rule.allExtensions || rule.extensions.length > 0),
	);

	return (
		<div ref={smartInputRef} className={`inno-workspace-smart-input ${compact ? "inno-composer-smart-input" : ""}`}>
			<button
				type="button"
				ref={smartInputTriggerRef}
				className={compact
					? "inno-composer-action inno-icon-button flex h-9 w-9 shrink-0 rounded-full disabled:opacity-50"
					: "inno-workspace-switcher-trigger inno-workspace-smart-input-trigger"}
				title={t("settings.smartInput.openSettings", "打开便捷输入面板")}
				aria-label={t("settings.smartInput.openSettings", "打开便捷输入面板")}
				aria-haspopup="dialog"
				aria-expanded={smartInputMenuOpen}
				onClick={() => setSmartInputMenuOpen((open) => !open)}
			>
				<span className="inno-workspace-smart-input-icon" aria-hidden="true"><Keyboard size={compact ? 16 : 15} /></span>
				{compact ? null : (
					<>
						<span className="inno-workspace-switcher-label inno-workspace-smart-input-label">{t("settings.smartInput.master", "便捷输入")} <span className="inno-smart-beta">Beta</span></span>
						{smartInputMenuOpen ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
					</>
				)}
			</button>
			{smartInputMenuOpen && typeof document !== "undefined" ? createPortal(
				<PopoverSurface
					ref={smartInputPanelRef}
					className="inno-workspace-switcher-menu inno-workspace-smart-input-panel"
					role="dialog"
					aria-label={t("settings.smartInput.title", "便捷输入")}
					style={{
						position: "fixed",
						left: smartInputMenuPosition.left,
						top: smartInputMenuPosition.top,
						right: "auto",
						bottom: "auto",
						zIndex: 100,
						transformOrigin: compact ? "bottom right" : "bottom left",
					}}
				>
					<div className="inno-workspace-smart-input-panel-head">
						<div className="min-w-0">
							<div className="inno-workspace-smart-input-panel-title">{t("settings.smartInput.master", "便捷输入")} <span className="inno-smart-beta">Beta</span></div>
							<p className="inno-workspace-smart-input-panel-desc">{t("settings.smartInput.menuDesc", "输入 pdf / word 等关键词可转为文件气泡，点击或拖入即可绑定")}</p>
						</div>
						<Switch
							checked={smartInputSettings?.enabled === true}
							onChange={onToggleSmartInput}
							aria-label={t("settings.smartInput.master", "便捷输入")}
						/>
					</div>
					<p className="inno-workspace-smart-input-feature-hint">
						<span className={dragFeatureEnabled ? "is-enabled" : undefined}>
							{t("settings.smartInput.homeDragHint", "拖文件到气泡绑定，悬停关键词 1 秒自动转换")}
						</span>
						<br />
						<span className={rightClickFeatureEnabled ? "is-enabled" : undefined}>
							{t("settings.smartInput.homeRightClickHint", "右键附件插入为气泡")}
						</span>
						<br />
						<span className={agentCommandFeatureEnabled ? "is-enabled" : undefined}>
							{t("settings.smartInput.homeAgentCommandsHint", "允许 Agent 命令转气泡：输入“技能”或 skill 可选择技能；/ Agent 命令可直接转为气泡")}
						</span>
						<br />
						<span className="is-enabled">
							{t("settings.smartInput.homeSettingsHint", "可进入设置修改上述功能")}
						</span>
					</p>
					<div className="inno-workspace-smart-input-panel-section">
						<div className="inno-workspace-smart-input-panel-section-head">
							<span>{t("settings.smartInput.rules", "关键词规则")}</span>
							<span>{t("settings.smartInput.menuRuleCount", "已开启 {{enabled}} 条 / 共 {{total}} 条", { enabled: enabledRuleCount, total: rules.length })}</span>
						</div>
						{rules.length > 0 ? (
							<div className="inno-workspace-smart-input-rules">
								{rules.map((rule) => {
									const active = isRuleActive(rule);
									return (
										<button
											key={rule.id}
											type="button"
											className={`inno-workspace-smart-input-rule ${active ? "is-active" : "is-off"}`}
											disabled={smartInputSaving}
											aria-pressed={rule.enabled}
											title={t(
												rule.enabled ? "settings.smartInput.disableRule" : "settings.smartInput.toggleRule",
												rule.enabled ? "关闭该关键词" : "启用该关键词",
											)}
											onClick={() => onToggleSmartInputRule(rule.id)}
										>
											{rule.keyword}
										</button>
									);
								})}
							</div>
						) : (
							<p className="inno-workspace-smart-input-empty">{t("settings.smartInput.rulesEmpty", "暂无启用的关键词规则")}</p>
						)}
					</div>
					<p className="inno-workspace-smart-input-hint">
						{t("settings.smartInput.menuRuleHint", "实心表示正在调用；点击关键词即可开关")}
						<br />
						{t("settings.smartInput.menuHint", "可进入实验室修改关键词和规则")}
					</p>
					<button
						type="button"
						className="inno-workspace-smart-input-settings"
						onClick={() => {
							setSmartInputMenuOpen(false);
							onOpenSmartInputSettings();
						}}
					>
						<FlaskConical size={14} aria-hidden="true" />
						<span>{t("settings.smartInput.openSettings", "打开实验室中的便捷输入设置")}</span>
					</button>
				</PopoverSurface>,
				document.body,
			) : null}
		</div>
	);
}
