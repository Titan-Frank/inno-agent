import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { settingsStore } from "../../stores/settings-store.js";
import { useStoreSnapshot } from "../hooks.js";
import { Switch } from "../ui/Switch.js";
import { Spinner } from "../ui/Spinner.js";
import { SettingsCard, SettingsRow, SettingsSection } from "./primitives.js";
import { KIND_COLORS, kindFromExtension } from "../chat/smart-input/kinds.js";
import type { SmartInputRule, SmartInputSettings } from "../../types/settings.js";

/**
 * Smart Input (便捷输入) settings: master switch + interaction toggles and a
 * keyword-rule manager. The keyword pill mirrors the composer bubble so the
 * settings page previews what typing will look like; every mutation saves
 * immediately through the settings store (server-normalized on return).
 */

const EXT_PATTERN = /^\.[a-z0-9]+$/i;

function normalizeExt(raw: string): string | null {
	const trimmed = raw.trim().toLowerCase();
	if (!trimmed) return null;
	const withDot = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
	return EXT_PATTERN.test(withDot) ? withDot : null;
}

interface RuleDraft {
	keyword: string;
	extensions: string[];
}

export function SmartInputSettings() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(settingsStore, () => ({
		smartInput: settingsStore.settings?.smartInput,
		isSaving: settingsStore.isSavingSmartInput,
	}));
	const smartInput = state.smartInput;

	const [draft, setDraft] = useState<SmartInputSettings | null>(smartInput ?? null);
	const [editingKeywordId, setEditingKeywordId] = useState<string | null>(null);
	const [keywordInput, setKeywordInput] = useState("");
	const [extInputId, setExtInputId] = useState<string | null>(null);
	const [extInput, setExtInput] = useState("");
	const [newRule, setNewRule] = useState<RuleDraft | null>(null);
	const [error, setError] = useState("");
	const extInputRef = useRef<HTMLInputElement | null>(null);
	const keywordInputRef = useRef<HTMLInputElement | null>(null);
	const newKeywordRef = useRef<HTMLInputElement | null>(null);

	// Server responses are the source of truth once a save settles.
	useEffect(() => {
		if (!state.isSaving && smartInput) setDraft(smartInput);
	}, [smartInput, state.isSaving]);

	if (!draft) return null;

	const persist = (next: SmartInputSettings) => {
		setDraft(next);
		setError("");
		void settingsStore.saveSmartInput(next).catch(() => {
			// Revert to the last server-known value on failure.
			setDraft(settingsStore.settings?.smartInput ?? next);
			setError(t("settings.smartInput.saveFailed", "保存失败，已恢复上次配置"));
		});
	};

	const patchConfig = (patch: Partial<SmartInputSettings>) => persist({ ...draft, ...patch });

	const patchRule = (id: string, patch: Partial<SmartInputRule>) => {
		patchConfig({ rules: draft.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)) });
	};

	const removeRule = (id: string) => {
		patchConfig({ rules: draft.rules.filter((rule) => rule.id !== id) });
	};

	const commitKeyword = (rule: SmartInputRule): void => {
		const keyword = keywordInput.trim();
		if (!keyword) {
			setError(t("settings.smartInput.keywordEmpty", "关键词不能为空"));
			return;
		}
		if (draft.rules.some((entry) => entry.id !== rule.id && entry.keyword === keyword)) {
			setError(t("settings.smartInput.keywordDuplicate", "关键词已存在"));
			return;
		}
		setError("");
		setEditingKeywordId(null);
		patchRule(rule.id, { keyword });
	};

	const commitExtension = (rule: SmartInputRule): void => {
		const ext = normalizeExt(extInput);
		if (!ext) {
			setError(t("settings.smartInput.extInvalid", "后缀格式无效（例：.pdf）"));
			return;
		}
		if (rule.extensions.includes(ext)) {
			setError(t("settings.smartInput.extDuplicate", "该后缀已存在"));
			return;
		}
		setError("");
		setExtInputId(null);
		setExtInput("");
		patchRule(rule.id, { extensions: [...rule.extensions, ext] });
	};

	const commitNewRule = (): void => {
		if (!newRule) return;
		const keyword = newRule.keyword.trim();
		if (!keyword) {
			setError(t("settings.smartInput.keywordEmpty", "关键词不能为空"));
			return;
		}
		if (draft.rules.some((rule) => rule.keyword === keyword)) {
			setError(t("settings.smartInput.keywordDuplicate", "关键词已存在"));
			return;
		}
		if (newRule.extensions.length === 0) {
			setError(t("settings.smartInput.extRequired", "请至少添加一个文件后缀"));
			return;
		}
		setError("");
		setNewRule(null);
		patchConfig({
			rules: [
				{ id: `smart-rule-${Date.now().toString(36)}`, keyword, extensions: newRule.extensions, enabled: true },
				...draft.rules,
			],
		});
	};

	const masterDisabled = !draft.enabled;

	const renderKeywordPill = (rule: SmartInputRule) => {
		const kind = kindFromExtension(rule.extensions[0] ?? "");
		const editing = editingKeywordId === rule.id;
		if (editing) {
			return (
				<input
					ref={keywordInputRef}
					className="inno-smart-set-keyword-input"
					value={keywordInput}
					spellCheck={false}
					onChange={(event) => setKeywordInput(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") { event.preventDefault(); commitKeyword(rule); }
						if (event.key === "Escape") { setEditingKeywordId(null); setError(""); }
					}}
					onBlur={() => commitKeyword(rule)}
				/>
			);
		}
		return (
			<button
				type="button"
				className={`inno-smart-set-pill ${rule.enabled ? "" : "is-off"}`}
				title={t("settings.smartInput.renameKeyword", "点击重命名关键词")}
				onClick={() => {
					setEditingKeywordId(rule.id);
					setKeywordInput(rule.keyword);
					requestAnimationFrame(() => keywordInputRef.current?.select());
				}}
			>
				<span aria-hidden="true" className="inno-smart-type-dot" style={{ backgroundColor: rule.enabled ? KIND_COLORS[kind] : "var(--inno-text-subtle)" }} />
				{rule.keyword}
			</button>
		);
	};

	const renderExtensions = (rule: SmartInputRule) => (
		<span className="inno-smart-set-exts">
			{rule.extensions.map((ext) => (
				<span key={ext} className="inno-smart-set-ext">
					{ext}
					<button
						type="button"
						className="inno-smart-set-ext-x"
						title={t("settings.smartInput.removeExt", "移除后缀")}
						onClick={() => patchRule(rule.id, { extensions: rule.extensions.filter((entry) => entry !== ext) })}
					>
						×
					</button>
				</span>
			))}
			{extInputId === rule.id ? (
				<input
					ref={extInputRef}
					className="inno-smart-set-ext-input"
					placeholder=".ext"
					value={extInput}
					spellCheck={false}
					onChange={(event) => setExtInput(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") { event.preventDefault(); commitExtension(rule); }
						if (event.key === "Escape") { setExtInputId(null); setExtInput(""); setError(""); }
					}}
					onBlur={() => { if (extInput.trim()) commitExtension(rule); else { setExtInputId(null); setError(""); } }}
				/>
			) : (
				<button
					type="button"
					className="inno-smart-set-ext-add"
					title={t("settings.smartInput.addExt", "添加后缀")}
					disabled={state.isSaving}
					onClick={() => {
						setExtInputId(rule.id);
						setExtInput("");
						requestAnimationFrame(() => extInputRef.current?.focus());
					}}
				>
					<Plus size={10} />
				</button>
			)}
		</span>
	);

	const renderRuleRow = (rule: SmartInputRule) => (
		<div key={rule.id} className={`inno-smart-set-row ${rule.enabled ? "" : "is-off"}`}>
			{renderKeywordPill(rule)}
			{renderExtensions(rule)}
			<span className="flex shrink-0 items-center gap-2.5">
				<Switch
					checked={rule.enabled}
					disabled={state.isSaving}
					aria-label={t("settings.smartInput.toggleRule", "启用该关键词")}
					onChange={(value) => patchRule(rule.id, { enabled: value })}
				/>
				<button
					type="button"
					className="inno-smart-set-delete"
					title={t("settings.smartInput.deleteRule", "删除规则")}
					disabled={state.isSaving}
					onClick={() => removeRule(rule.id)}
				>
					<Trash2 size={14} />
				</button>
			</span>
		</div>
	);

	const renderNewRuleRow = () => newRule ? (
		<div className="inno-smart-set-row is-new">
			<input
				ref={newKeywordRef}
				className="inno-smart-set-keyword-input is-primary"
				placeholder={t("settings.smartInput.newKeywordPlaceholder", "关键词")}
				value={newRule.keyword}
				spellCheck={false}
				onChange={(event) => setNewRule({ ...newRule, keyword: event.target.value })}
				onKeyDown={(event) => {
					if (event.key === "Enter") { event.preventDefault(); commitNewRule(); }
					if (event.key === "Escape") { setNewRule(null); setError(""); }
				}}
			/>
			<span className="inno-smart-set-exts">
				{newRule.extensions.map((ext) => (
					<span key={ext} className="inno-smart-set-ext">
						{ext}
						<button
							type="button"
							className="inno-smart-set-ext-x"
							onClick={() => setNewRule({ ...newRule, extensions: newRule.extensions.filter((entry) => entry !== ext) })}
						>
							×
						</button>
					</span>
				))}
				{extInputId === "__new__" ? (
					<input
						ref={extInputRef}
						className="inno-smart-set-ext-input"
						placeholder=".ext"
						value={extInput}
						spellCheck={false}
						onChange={(event) => setExtInput(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								const ext = normalizeExt(extInput);
								if (!ext) { setError(t("settings.smartInput.extInvalid", "后缀格式无效（例：.pdf）")); return; }
								if (newRule.extensions.includes(ext)) { setError(t("settings.smartInput.extDuplicate", "该后缀已存在")); return; }
								setError("");
								setExtInput("");
								setNewRule({ ...newRule, extensions: [...newRule.extensions, ext] });
								requestAnimationFrame(() => extInputRef.current?.focus());
							}
							if (event.key === "Escape") { setExtInputId(null); setExtInput(""); }
						}}
						onBlur={() => {
							const ext = normalizeExt(extInput);
							if (ext && !newRule.extensions.includes(ext)) setNewRule({ ...newRule, extensions: [...newRule.extensions, ext] });
							setExtInputId(null);
							setExtInput("");
						}}
					/>
				) : (
					<button
						type="button"
						className="inno-smart-set-ext-add"
						title={t("settings.smartInput.addExt", "添加后缀")}
						onClick={() => {
							setExtInputId("__new__");
							setExtInput("");
							requestAnimationFrame(() => extInputRef.current?.focus());
						}}
					>
						<Plus size={10} />
					</button>
				)}
			</span>
			<span className="flex shrink-0 items-center gap-2">
				<button type="button" className="inno-smart-set-action is-ghost" onClick={() => { setNewRule(null); setError(""); }}>
					{t("common.cancel", "取消")}
				</button>
				<button type="button" className="inno-smart-set-action is-primary" disabled={state.isSaving} onClick={commitNewRule}>
					{t("common.save", "保存")}
				</button>
			</span>
		</div>
	) : null;

	return (
		<SettingsSection
			title={t("settings.smartInput.title", "便捷输入")}
			description={t("settings.smartInput.desc", "在输入框输入关键词即可转为文件气泡，把文件明确绑定到指代词")}
		>
			<SettingsCard>
				<SettingsRow
					label={t("settings.smartInput.master", "便捷输入")}
					description={t("settings.smartInput.masterDesc", "开启后输入 pdf / word 等关键词出现红色下划线，点击或拖入文件转为气泡")}
					control={<Switch checked={draft.enabled} disabled={state.isSaving} onChange={(value) => patchConfig({ enabled: value })} />}
				/>
				<div className={`mt-3 ml-0.5 border-l-2 border-[var(--inno-border)] pl-3 ${masterDisabled ? "opacity-60" : ""}`}>
					<div className="grid gap-3">
						<SettingsRow
							label={t("settings.smartInput.allowDrag", "允许拖入填充")}
							description={t("settings.smartInput.allowDragDesc", "拖文件到气泡绑定；拖文件悬停关键词 1 秒自动转换")}
							control={<Switch checked={draft.allowDrag} disabled={masterDisabled || state.isSaving} onChange={(value) => patchConfig({ allowDrag: value })} />}
						/>
						<SettingsRow
							label={t("settings.smartInput.allowRightClick", "允许右键附件转气泡")}
							description={t("settings.smartInput.allowRightClickDesc", "附件右键「插入为气泡」")}
							control={<Switch checked={draft.allowRightClick} disabled={masterDisabled || state.isSaving} onChange={(value) => patchConfig({ allowRightClick: value })} />}
						/>
					</div>
				</div>
			</SettingsCard>

			<SettingsCard className={masterDisabled ? "opacity-60" : ""}>
				<div className="mb-2 flex items-center justify-between gap-3">
					<div className="flex items-center gap-2">
						<h4 className="text-sm font-medium text-[var(--inno-text)]">{t("settings.smartInput.rules", "关键词规则")}</h4>
						<span className="rounded-full bg-[var(--inno-surface-muted)] px-2 py-0.5 text-[10.5px] text-[var(--inno-text-muted)]">
							{t("settings.smartInput.ruleCount", "共 {{count}} 条", { count: draft.rules.length })}
						</span>
						{state.isSaving ? <Spinner size={12} className="text-[var(--inno-text-subtle)]" /> : null}
					</div>
					<button
						type="button"
						className="inno-smart-set-add"
						disabled={state.isSaving || Boolean(newRule)}
						onClick={() => {
							setNewRule({ keyword: "", extensions: [] });
							requestAnimationFrame(() => newKeywordRef.current?.focus());
						}}
					>
						<Plus size={13} />
						{t("settings.smartInput.addRule", "新增关键词")}
					</button>
				</div>
				{error ? <div className="inno-smart-set-error">{error}</div> : null}
				<div className="grid gap-1.5">
				{renderNewRuleRow()}
				{draft.rules.map((rule) => renderRuleRow(rule))}
					{draft.rules.length === 0 && !newRule ? (
						<div className="rounded-md border border-dashed border-[var(--inno-border)] px-3 py-4 text-center text-xs text-[var(--inno-text-subtle)]">
							{t("settings.smartInput.rulesEmpty", "暂无规则，点击「新增关键词」创建")}
						</div>
					) : null}
				</div>
				<p className="mt-3 text-[11px] leading-relaxed text-[var(--inno-text-subtle)]">
					{t("settings.smartInput.rulesHint", "关键词按字面匹配；气泡只接受其后缀列表内的文件。设置仅影响后续输入。")}
				</p>
			</SettingsCard>
		</SettingsSection>
	);
}
