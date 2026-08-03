import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { settingsStore } from "../../stores/settings-store.js";
import type { InnoSettings } from "../../types/settings.js";
import { Switch } from "../ui/Switch.js";
import { SettingsSection, SettingsCard, SettingsRow } from "./primitives.js";

/* ---------- Simple Mode (streamlined experience) ---------- */

function SimpleModeCard({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const [enabled, setEnabled] = useState(settings.simpleMode?.enabled === true);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		setEnabled(settings.simpleMode?.enabled === true);
	}, [settings.simpleMode?.enabled]);

	async function handleToggle(next: boolean) {
		setEnabled(next);
		setSaving(true);
		try {
			await settingsStore.saveSimpleMode(next);
		} catch {
			setEnabled(!next);
		} finally {
			setSaving(false);
		}
	}

	return (
		<SettingsCard>
			<SettingsRow
				label={t("settings.simpleMode.title")}
				description={enabled ? t("settings.simpleMode.onDesc") : t("settings.simpleMode.offDesc")}
				control={<Switch checked={enabled} onChange={(v) => void handleToggle(v)} disabled={saving} />}
			/>
		</SettingsCard>
	);
}

/* ---------- Memory layer toggles (L1/L2/L3) ---------- */

type MemoryLayer = "l1Enabled" | "l2Enabled" | "l3Enabled";

function MemoryToggleRow({
	enabled,
	saving,
	locked,
	title,
	desc,
	onToggle,
}: {
	enabled: boolean;
	saving: boolean;
	locked?: boolean;
	title: string;
	desc: string;
	onToggle: (next: boolean) => void;
}) {
	// In Simple Mode the layers are force-locked OFF; show them as off + disabled.
	const shown = locked ? false : enabled;
	return (
		<SettingsRow
			label={title}
			description={desc}
			disabled={locked}
			control={<Switch checked={shown} onChange={onToggle} disabled={saving || locked} />}
		/>
	);
}

function MemoryLayersCard({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const locked = settings.simpleMode?.enabled === true;
	const initial = {
		l1Enabled: settings.memory?.l1Enabled !== false,
		l2Enabled: settings.memory?.l2Enabled !== false,
		l3Enabled: settings.memory?.l3Enabled !== false,
	};
	const [state, setState] = useState(initial);
	const [savingKey, setSavingKey] = useState<MemoryLayer | null>(null);

	useEffect(() => {
		setState({
			l1Enabled: settings.memory?.l1Enabled !== false,
			l2Enabled: settings.memory?.l2Enabled !== false,
			l3Enabled: settings.memory?.l3Enabled !== false,
		});
	}, [settings.memory?.l1Enabled, settings.memory?.l2Enabled, settings.memory?.l3Enabled]);

	async function handleToggle(key: MemoryLayer, next: boolean) {
		setState((s) => ({ ...s, [key]: next }));
		setSavingKey(key);
		try {
			await settingsStore.saveMemory({ [key]: next });
		} catch {
			setState((s) => ({ ...s, [key]: !next }));
		} finally {
			setSavingKey(null);
		}
	}

	const layers: { key: MemoryLayer; ns: "l1" | "l2" | "memory" }[] = [
		{ key: "l1Enabled", ns: "l1" },
		{ key: "l2Enabled", ns: "l2" },
		{ key: "l3Enabled", ns: "memory" },
	];

	return (
		<SettingsCard>
			<h4 className="mb-3 text-sm font-medium text-[var(--inno-text)]">{t("settings.memorySection")}</h4>
			{locked ? <p className="mb-3 text-xs text-[var(--inno-warning)]">{t("settings.simpleMode.memoryLocked")}</p> : null}
			<div className="grid gap-4">
				{layers.map(({ key, ns }) => {
					const enabled = state[key];
					return (
						<MemoryToggleRow
							key={key}
							enabled={enabled}
							saving={savingKey === key}
							locked={locked}
							title={t(`settings.${ns}.title`)}
							desc={enabled ? t(`settings.${ns}.onDesc`) : t(`settings.${ns}.offDesc`)}
							onToggle={(next) => void handleToggle(key, next)}
						/>
					);
				})}
			</div>
		</SettingsCard>
	);
}

/* ---------- Memory category page ---------- */

export function MemorySettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	return (
		<SettingsSection title={t("settings.tabs.memory")} description={t("settings.sections.memory.desc", "简单模式与分层记忆开关")}>
			<SimpleModeCard settings={settings} />
			<MemoryLayersCard settings={settings} />
		</SettingsSection>
	);
}
