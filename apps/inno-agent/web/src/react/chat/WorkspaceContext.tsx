import { ChevronDown, ChevronUp, FlaskConical, Keyboard } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceMeta } from "../../api/workspaces.js";
import type { SmartInputRule, SmartInputSettings } from "../../types/settings.js";
import { WorkspaceSwitcher, type WorkspaceChoice, type WorkspaceSelectionKind } from "../WorkspaceSwitcher.js";
import { PopoverSurface } from "../ui/PopoverSurface.js";
import { Switch } from "../ui/Switch.js";

interface WorkspaceContextProps {
	workspaces: WorkspaceMeta[];
	selectedWorkspaceId: string | null;
	selectedKind: WorkspaceSelectionKind;
	newWorkspaceName?: string;
	busy?: boolean;
	disabled?: boolean;
	onChange: (choice: WorkspaceChoice) => void;
	smartInputSettings?: SmartInputSettings;
	onToggleSmartInput: () => void;
	onToggleSmartInputRule: (ruleId: string) => void;
	smartInputSaving?: boolean;
	onOpenSmartInputSettings: () => void;
}

/** Workspace context row used below the welcome composer. */
export function WorkspaceContext({
	workspaces,
	selectedWorkspaceId,
	selectedKind,
	newWorkspaceName = "",
	busy = false,
	disabled = false,
	onChange,
	smartInputSettings,
	onToggleSmartInput,
	onToggleSmartInputRule,
	smartInputSaving = false,
	onOpenSmartInputSettings,
}: WorkspaceContextProps) {
	const { t } = useTranslation();
	const smartInputRef = useRef<HTMLDivElement | null>(null);
	const [smartInputMenuOpen, setSmartInputMenuOpen] = useState(false);

	useEffect(() => {
		if (!smartInputMenuOpen) return;
		const onPointerDown = (event: PointerEvent) => {
			if (!smartInputRef.current?.contains(event.target as Node)) setSmartInputMenuOpen(false);
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

	const rules = smartInputSettings?.rules ?? [];
	const enabledRuleCount = rules.filter((rule) => rule.enabled).length;
	const isRuleActive = (rule: SmartInputRule): boolean => Boolean(
		smartInputSettings?.enabled
			&& rule.enabled
			&& (rule.allExtensions || rule.extensions.length > 0),
	);
	return (
		<div className="inno-workspace-context-row">
			<WorkspaceSwitcher
				workspaces={workspaces}
				selectedWorkspaceId={selectedWorkspaceId}
				selectedKind={selectedKind}
				newWorkspaceName={newWorkspaceName}
				busy={busy}
				disabled={disabled}
				onChange={onChange}
			/>
			<div ref={smartInputRef} className="inno-workspace-smart-input">
				<button
					type="button"
					className="inno-workspace-switcher-trigger inno-workspace-smart-input-trigger"
					title={t("settings.smartInput.openSettings", "打开便捷输入面板")}
					onClick={() => setSmartInputMenuOpen((open) => !open)}
					aria-haspopup="dialog"
					aria-expanded={smartInputMenuOpen}
				>
					<span className="inno-workspace-smart-input-icon" aria-hidden="true"><Keyboard size={15} /></span>
					<span className="inno-workspace-switcher-label inno-workspace-smart-input-label">{t("settings.smartInput.master", "便捷输入")} <span className="inno-smart-beta">Beta</span></span>
					{smartInputMenuOpen ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
				</button>
				{smartInputMenuOpen ? (
					<PopoverSurface className="inno-workspace-switcher-menu inno-workspace-smart-input-panel" role="dialog" aria-label={t("settings.smartInput.title", "便捷输入")}>
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
				</PopoverSurface>
				) : null}
			</div>
		</div>
	);
}
