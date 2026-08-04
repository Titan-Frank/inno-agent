import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getWikiStats } from "../../api/wiki.js";
import { settingsStore } from "../../stores/settings-store.js";
import { updaterStore } from "../../stores/updater-store.js";
import type { WikiStats } from "../../types/wiki.js";
import { useStoreSnapshot } from "../hooks.js";
import { SettingsSection, SettingsCard } from "./primitives.js";
import { formatBytes } from "./shared.js";

/** 桌面端（Electron）版本与更新卡片；浏览器环境不渲染。 */
function UpdateCard() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(updaterStore, () => ({
		info: updaterStore.info,
		status: updaterStore.status,
	}));

	useEffect(() => {
		updaterStore.init();
	}, []);

	if (!updaterStore.isDesktop) return null;

	const { info, status } = state;
	const version = "version" in status ? status.version : undefined;

	let statusText = "";
	if (!info?.enabled) statusText = t("settings.update.devDisabled");
	else if (status.status === "checking") statusText = t("settings.update.checking");
	else if (status.status === "available") statusText = t("settings.update.available", { version });
	else if (status.status === "downloading") statusText = t("settings.update.downloading", { version });
	else if (status.status === "downloaded") statusText = t("settings.update.downloaded", { version });
	else if (status.status === "not-available") statusText = t("settings.update.notAvailable");
	else if (status.status === "error") statusText = t("settings.update.error", { message: status.error });

	const checking = status.status === "checking";
	const downloading = status.status === "downloading";

	return (
		<SettingsCard className="mt-3">
			<div className="mb-3 flex items-center justify-between">
				<h4 className="text-sm font-medium text-[var(--inno-text)]">{t("settings.update.title")}</h4>
				<button
					className="shrink-0 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)] disabled:opacity-50"
					disabled={!info?.enabled || checking || downloading}
					onClick={() => void updaterStore.check()}
				>
					{t("settings.update.check")}
				</button>
			</div>
			<div className="flex items-center justify-between gap-3 text-sm">
				<div className="min-w-0">
					<span className="text-[var(--inno-text-muted)]">{t("settings.update.currentVersion")}</span>{" "}
					<span className="font-medium text-[var(--inno-text)]">{info?.version ?? "-"}</span>
					{statusText ? (
						<div className={`mt-1 text-xs ${status.status === "error" ? "text-[var(--inno-danger)]" : "text-[var(--inno-text-muted)]"}`}>
							{statusText}
						</div>
					) : null}
					{downloading ? (
						<div className="mt-2 h-1.5 w-48 overflow-hidden rounded-full bg-[var(--inno-surface-muted)]">
							<div
								className="h-full rounded-full bg-[var(--inno-accent)] transition-[width]"
								style={{ width: `${Math.round(status.progress.percent)}%` }}
							/>
						</div>
					) : null}
				</div>
				{info?.canAutoInstall && status.status === "downloaded" ? (
					<button
						className="shrink-0 rounded-md bg-[var(--inno-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
						onClick={() => void updaterStore.install()}
					>
						{t("settings.update.install")}
					</button>
				) : null}
				{info?.enabled && !info.canAutoInstall && (status.status === "available" || status.status === "downloaded") ? (
					<button
						className="shrink-0 rounded-md bg-[var(--inno-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
						onClick={() => void updaterStore.openDownloadPage()}
					>
						{t("settings.update.goDownload")}
					</button>
				) : null}
			</div>
			{info?.enabled && !info.canAutoInstall ? (
				<p className="mt-2 text-xs text-[var(--inno-text-muted)]">{t("settings.update.macHint")}</p>
			) : null}
		</SettingsCard>
	);
}

export function AboutSettings() {
	const { t } = useTranslation();
	const [healthOk, setHealthOk] = useState(false);
	const [wikiStats, setWikiStats] = useState<WikiStats | null>(null);
	const state = useStoreSnapshot(settingsStore, () => ({
		settings: settingsStore.settings,
		isLoading: settingsStore.isLoading,
		error: settingsStore.error,
	}));

	useEffect(() => {
		void fetch("/api/health").then((res) => setHealthOk(res.ok)).catch(() => setHealthOk(false));
		void getWikiStats().then(setWikiStats).catch(() => setWikiStats(null));
	}, []);

	return (
		<SettingsSection title={t("settings.tabs.about")} description={t("settings.sections.about.desc", "服务状态与存储统计")}>
			<SettingsCard>
				<div className="mb-3 flex items-center justify-between">
					<h4 className="text-sm font-medium text-[var(--inno-text)]">{t("settings.title")}</h4>
					<button className="shrink-0 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-1.5 text-sm text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]" onClick={() => void settingsStore.load()}>
						{t("settings.refresh")}
					</button>
				</div>
				{state.isLoading ? <div className="text-sm text-[var(--inno-text-muted)]">{t("settings.loading")}</div> : null}
				{state.error ? <div className="rounded bg-[var(--inno-danger-bg)] p-2 text-sm text-[var(--inno-danger)]">{state.error}</div> : null}
				<div className="settings-stats-grid grid gap-3 text-sm">
					<div className="rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-3">
						<div className="text-xs text-[var(--inno-text-muted)]">{t("settings.stats.server")}</div>
						<div className={healthOk ? "font-medium text-[var(--inno-success)]" : "font-medium text-[var(--inno-danger)]"}>
							{healthOk ? t("settings.stats.healthy") : t("settings.stats.offline")}
						</div>
					</div>
					<div className="min-w-0 rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-3">
						<div className="text-xs text-[var(--inno-text-muted)]">{t("settings.stats.defaultModel")}</div>
						<div className="font-medium text-[var(--inno-text)] [overflow-wrap:anywhere]">{state.settings ? `${state.settings.defaultProvider}/${state.settings.defaultModel}` : "-"}</div>
					</div>
					<div className="rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-3">
						<div className="text-xs text-[var(--inno-text-muted)]">{t("settings.stats.wiki")}</div>
						<div className="font-medium text-[var(--inno-text)]">
							{wikiStats ? t("settings.stats.wikiStat", { count: wikiStats.pageCount, size: formatBytes(wikiStats.totalSize) }) : "-"}
						</div>
					</div>
				</div>
			</SettingsCard>
			<UpdateCard />
		</SettingsSection>
	);
}
