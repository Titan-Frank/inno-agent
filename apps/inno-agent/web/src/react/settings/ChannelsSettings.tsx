import { useEffect, useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, QrCode as QrCodeIcon, CheckCircle, Wifi, WifiOff } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { settingsStore } from "../../stores/settings-store.js";
import { feishuQrRegister, feishuQrStatus, wechatQrLogin, wechatQrStatus, wechatStatus } from "../../api/settings.js";
import type { InnoSettings, ChannelsSettingsPayload, PersonalBridgeChannelConfig } from "../../types/settings.js";
import { inputCls } from "../ui/input.js";
import { checkboxCls } from "../ui/checkbox.js";
import { SettingsSection } from "./primitives.js";

/* ---------- Channels Settings ---------- */

function ChannelsCard({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveMsg, setSaveMsg] = useState<string | null>(null);
	const [formError, setFormError] = useState<string | null>(null);

	// Feishu
	const [feishuEnabled, setFeishuEnabled] = useState(settings.channels?.feishu?.enabled ?? false);
	const [feishuAppId, setFeishuAppId] = useState(settings.feishu?.appId ?? "");
	const [feishuAppSecret, setFeishuAppSecret] = useState("");
	const [feishuPersonalOnly, setFeishuPersonalOnly] = useState(settings.channels?.feishu?.personalOnly ?? true);
	const [feishuAllowedUsers, setFeishuAllowedUsers] = useState(
		(settings.channels?.feishu?.allowedUserIds ?? []).join("\n"),
	);

	// Feishu QR registration state
	const [feishuQrUrl, setFeishuQrUrl] = useState<string | null>(null);
	const [feishuQrDeviceCode, setFeishuQrDeviceCode] = useState<string | null>(null);
	const [feishuQrState, setFeishuQrState] = useState<string | null>(null); // waitingScan | confirmed | expired | denied
	const [feishuQrError, setFeishuQrError] = useState<string | null>(null);
	const feishuQrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(() => {
		return () => { if (feishuQrPollRef.current) clearInterval(feishuQrPollRef.current); };
	}, []);

	const startFeishuQrRegister = useCallback(async () => {
		setFeishuQrState("scanning");
		setFeishuQrUrl(null);
		setFeishuQrError(null);
		if (feishuQrPollRef.current) clearInterval(feishuQrPollRef.current);
		try {
			const { deviceCode, qrUrl, interval } = await feishuQrRegister();
			setFeishuQrDeviceCode(deviceCode);
			setFeishuQrUrl(qrUrl);
			setFeishuQrState("waitingScan");
			// Poll status
			feishuQrPollRef.current = setInterval(async () => {
				try {
					const res = await feishuQrStatus(deviceCode);
					if (res.status === "confirmed") {
						setFeishuQrState("confirmed");
						setFeishuEnabled(true);
						if (feishuQrPollRef.current) clearInterval(feishuQrPollRef.current);
						// Refresh settings to get new appId
						settingsStore.load();
					} else if (res.status === "expired") {
						setFeishuQrState("expired");
						if (feishuQrPollRef.current) clearInterval(feishuQrPollRef.current);
					} else if (res.status === "denied") {
						setFeishuQrState("denied");
						if (feishuQrPollRef.current) clearInterval(feishuQrPollRef.current);
					}
				} catch {
					// ignore poll errors
				}
			}, (interval || 5) * 1000);
		} catch (err) {
			setFeishuQrState(null);
			setFeishuQrError(err instanceof Error ? err.message : "QR registration failed");
		}
	}, []);

	// QQ
	const qqConfig = settings.channels?.qq as PersonalBridgeChannelConfig | undefined;
	const [qqEnabled, setQqEnabled] = useState(qqConfig?.enabled ?? false);
	const [qqSidecarUrl, setQqSidecarUrl] = useState(qqConfig?.sidecarBaseUrl ?? "http://127.0.0.1:4318");
	const [qqPersonalOnly, setQqPersonalOnly] = useState(qqConfig?.personalOnly ?? true);
	const [qqAllowedUsers, setQqAllowedUsers] = useState(
		(qqConfig?.allowedUserIds ?? []).join("\n"),
	);
	// QQ channel is not yet implemented; flip to true when ready to expose settings.
	const QQ_CHANNEL_READY = false;

	// WeChat (iLink native mode)
	const wechatConfig = settings.channels?.wechat;
	const [wechatEnabled, setWechatEnabled] = useState(wechatConfig?.enabled ?? false);
	const [wechatPersonalOnly, setWechatPersonalOnly] = useState(wechatConfig?.personalOnly ?? true);
	const [wechatAllowedUsers, setWechatAllowedUsers] = useState(
		(wechatConfig?.allowedUserIds ?? []).join("\n"),
	);
	// QR login state
	const [qrUrl, setQrUrl] = useState<string | null>(null);
	const [qrId, setQrId] = useState<string | null>(null);
	const [qrStatus, setQrStatus] = useState<string | null>(null); // scanning | waitingScan | scanned | confirmed | expired
	const [wxConnected, setWxConnected] = useState(false);
	const [wxBotId, setWxBotId] = useState<string | null>(null);
	const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	// Check WeChat connection status on mount
	useEffect(() => {
		if (wechatEnabled) {
			wechatStatus().then((s) => {
				setWxConnected(s.connected);
				if (s.botId) setWxBotId(s.botId);
			}).catch(() => {});
		}
		return () => { if (qrPollRef.current) clearInterval(qrPollRef.current); };
	}, [wechatEnabled]);

	const [qrError, setQrError] = useState<string | null>(null);

	const startQrLogin = useCallback(async () => {
		setQrStatus("scanning");
		setQrUrl(null);
		setQrError(null);
		if (qrPollRef.current) clearInterval(qrPollRef.current);
		try {
			const { qrId: id, qrUrl: url } = await wechatQrLogin();
			setQrId(id);
			setQrUrl(url);
			setQrStatus("waitingScan");
			// Poll status every 2s
			qrPollRef.current = setInterval(async () => {
				try {
					const res = await wechatQrStatus(id);
					if (res.status === "scanned") setQrStatus("scanned");
					else if (res.status === "confirmed") {
						setQrStatus("confirmed");
						setWxConnected(true);
						if (res.botId) setWxBotId(res.botId);
						if (qrPollRef.current) clearInterval(qrPollRef.current);
					} else if (res.status === "expired") {
						setQrStatus("expired");
						if (qrPollRef.current) clearInterval(qrPollRef.current);
					}
				} catch {
					// ignore poll errors
				}
			}, 2000);
		} catch (err) {
			setQrStatus(null);
			setQrError(err instanceof Error ? err.message : "QR login failed");
		}
	}, []);

	// Bridge
	const [bridgeToken, setBridgeToken] = useState("");

	function parseUserIds(text: string): string[] {
		return text.split("\n").map((s) => s.trim()).filter(Boolean);
	}

	async function handleSave() {
		setFormError(null);
		setSaveMsg(null);
		setSaving(true);
		try {
			const payload: ChannelsSettingsPayload = {
				channels: {
					feishu: {
						enabled: feishuEnabled,
						personalOnly: feishuPersonalOnly,
						allowedUserIds: parseUserIds(feishuAllowedUsers),
					},
					qq: {
						enabled: qqEnabled,
						mode: "bridge",
						personalOnly: qqPersonalOnly,
						allowedUserIds: parseUserIds(qqAllowedUsers),
						sidecarBaseUrl: qqSidecarUrl.trim(),
					},
					wechat: {
						enabled: wechatEnabled,
						mode: "ilink",
						personalOnly: wechatPersonalOnly,
						allowedUserIds: parseUserIds(wechatAllowedUsers),
					},
				},
			};
			if (feishuAppId.trim()) {
				payload.feishu = {
					appId: feishuAppId.trim(),
					...(feishuAppSecret.trim() ? { appSecret: feishuAppSecret.trim() } : {}),
				};
			}
			if (bridgeToken.trim()) {
				payload.bridge = { token: bridgeToken.trim() };
			}
			await settingsStore.saveChannels(payload);
			setSaveMsg(t("settings.channels.saved"));
			setTimeout(() => setSaveMsg(null), 3000);
		} catch (err) {
			setFormError(err instanceof Error ? err.message : "Save failed");
		} finally {
			setSaving(false);
		}
	}

	const labelCls = "mb-0.5 block text-[10px] text-[var(--inno-text-muted)]";
	const checkCls = "flex items-center gap-1.5 text-xs text-[var(--inno-text-muted)]";

	return (
		<div className="rounded-lg bg-[var(--inno-surface)]">
			<button
				className="flex w-full items-center justify-between px-4 py-3 text-left"
				onClick={() => { setExpanded((v) => !v); setFormError(null); setSaveMsg(null); }}
			>
				<div className="flex items-center gap-2">
					{expanded ? <ChevronDown size={14} className="text-[var(--inno-text-subtle)]" /> : <ChevronRight size={14} className="text-[var(--inno-text-subtle)]" />}
					<span className="text-sm font-medium text-[var(--inno-text)]">{t("settings.channels.title")}</span>
				</div>
				<div className="flex items-center gap-2 text-xs text-[var(--inno-text-subtle)]">
					{feishuEnabled && <span className="rounded bg-[var(--inno-success-bg)] px-1.5 py-0.5 text-[var(--inno-success)]">{t("settings.channels.feishu.title")}</span>}
					{qqEnabled && QQ_CHANNEL_READY && <span className="rounded bg-[var(--inno-accent-soft)] px-1.5 py-0.5 text-[var(--inno-accent)]">{t("settings.channels.qq.title")}</span>}
					{wechatEnabled && <span className="rounded bg-[var(--inno-success-bg)] px-1.5 py-0.5 text-[var(--inno-success)]">{t("settings.channels.wechat.title")}</span>}
				</div>
			</button>
			{expanded && (
				<div className="border-t border-[var(--inno-border)] px-4 pb-4 pt-3 grid gap-4">
					{/* Feishu */}
					<div className="rounded-lg bg-[var(--inno-surface)] p-3">
						<div className="mb-2 flex items-center justify-between">
							<div>
								<div className="text-xs font-medium text-[var(--inno-text)]">{t("settings.channels.feishu.title")}</div>
								<div className="text-[10px] text-[var(--inno-text-subtle)]">{t("settings.channels.feishu.desc")}</div>
							</div>
							<label className={checkCls}>
								<input type="checkbox" className={checkboxCls} checked={feishuEnabled} onChange={(e) => setFeishuEnabled(e.target.checked)} />
								{t("settings.channels.enabled")}
							</label>
						</div>

						{/* Feishu QR Registration */}
						<div className="mb-3">
							{feishuQrState === "waitingScan" && feishuQrUrl ? (
								<div className="flex flex-col items-center gap-2 rounded-lg bg-[var(--inno-bg-alt)] p-4">
									<div className="text-xs font-medium text-[var(--inno-text)]">{t("settings.feishu.qrTitle")}</div>
									<QRCodeSVG value={feishuQrUrl} size={192} />
									<div className="text-[10px] text-[var(--inno-text-subtle)]">{t("settings.feishu.qrSubtitle")}</div>
									<div className="text-[10px] text-[var(--inno-accent)]">{t("settings.feishu.qrWaiting")}</div>
								</div>
							) : feishuQrState === "confirmed" ? (
								<div className="flex items-center gap-2 rounded-lg border border-[var(--inno-success-border)] bg-[var(--inno-success-bg)] p-3">
									<CheckCircle className="h-4 w-4 text-[var(--inno-success)]" />
									<span className="text-xs text-[var(--inno-success)]">{t("settings.feishu.qrConfirmed")}</span>
								</div>
							) : feishuQrState === "expired" ? (
								<div className="flex items-center gap-2 rounded-lg border border-[var(--inno-warning-border)] bg-[var(--inno-warning-bg)] p-3">
									<span className="text-xs text-[var(--inno-warning)]">{t("settings.feishu.qrExpired")}</span>
									<button className="ml-auto rounded bg-[var(--inno-accent)] px-2 py-0.5 text-[10px] text-white" onClick={startFeishuQrRegister}>{t("settings.feishu.qrRegenerate")}</button>
								</div>
							) : feishuQrState === "denied" ? (
								<div className="flex items-center gap-2 rounded-lg border border-[var(--inno-danger-border)] bg-[var(--inno-danger-bg)] p-3">
									<span className="text-xs text-[var(--inno-danger)]">{t("settings.feishu.qrDenied")}</span>
									<button className="ml-auto rounded bg-[var(--inno-accent)] px-2 py-0.5 text-[10px] text-white" onClick={startFeishuQrRegister}>{t("settings.feishu.qrRegenerate")}</button>
								</div>
							) : feishuQrState === "scanning" ? (
								<div className="text-center text-[10px] text-[var(--inno-text-subtle)] py-2">{t("settings.feishu.qrWaiting")}</div>
							) : (
								<button
									className="w-full rounded border border-[var(--inno-border)] bg-[var(--inno-bg-alt)] px-3 py-2 text-xs text-[var(--inno-text)] hover:bg-[var(--inno-bg-hover)] flex items-center justify-center gap-2"
									onClick={startFeishuQrRegister}
								>
									<QrCodeIcon size={14} />
									{t("settings.feishu.qrRegister")}
								</button>
							)}
							{feishuQrError && (
								<div className="mt-1 rounded bg-[var(--inno-danger-bg)] px-2 py-1 text-[10px] text-[var(--inno-danger)]">{feishuQrError}</div>
							)}
						</div>

						{feishuEnabled && (
							<div className="grid grid-cols-2 gap-2">
								<div>
									<label className={labelCls}>{t("settings.channels.feishu.appId")}</label>
									<input className={inputCls} value={feishuAppId} onChange={(e) => setFeishuAppId(e.target.value)} />
								</div>
								<div>
									<label className={labelCls}>{t("settings.channels.feishu.appSecret")} {settings.feishu?.appSecret && <span className="text-[var(--inno-text-subtle)]">(••••)</span>}</label>
									<input className={inputCls} type="password" placeholder={t("settings.channels.feishu.appSecretHint") ?? ""} value={feishuAppSecret} onChange={(e) => setFeishuAppSecret(e.target.value)} />
								</div>
								<div className="col-span-2 flex items-center gap-3">
									<label className={checkCls}>
										<input type="checkbox" className={checkboxCls} checked={feishuPersonalOnly} onChange={(e) => setFeishuPersonalOnly(e.target.checked)} />
										{t("settings.channels.personalOnly")}
									</label>
								</div>
								<div className="col-span-2">
									<label className={labelCls}>{t("settings.channels.allowedUserIds")}</label>
									<textarea className={`${inputCls} h-14 resize-y`} placeholder={t("settings.channels.allowedUserIdsHint") ?? ""} value={feishuAllowedUsers} onChange={(e) => setFeishuAllowedUsers(e.target.value)} />
								</div>
							</div>
						)}
					</div>

					{/* QQ (hidden: channel not yet implemented) */}
					{QQ_CHANNEL_READY && (
					<div className="rounded-lg bg-[var(--inno-surface)] p-3">
						<div className="mb-2 flex items-center justify-between">
							<div>
								<div className="text-xs font-medium text-[var(--inno-text)]">{t("settings.channels.qq.title")}</div>
								<div className="text-[10px] text-[var(--inno-text-subtle)]">{t("settings.channels.qq.desc")}</div>
							</div>
							<label className={checkCls}>
								<input type="checkbox" className={checkboxCls} checked={qqEnabled} onChange={(e) => setQqEnabled(e.target.checked)} />
								{t("settings.channels.enabled")}
							</label>
						</div>
						{qqEnabled && (
							<div className="grid grid-cols-2 gap-2">
								<div className="col-span-2">
									<label className={labelCls}>{t("settings.channels.sidecarBaseUrl")}</label>
									<input className={inputCls} value={qqSidecarUrl} onChange={(e) => setQqSidecarUrl(e.target.value)} />
								</div>
								<div className="col-span-2 flex items-center gap-3">
									<label className={checkCls}>
										<input type="checkbox" className={checkboxCls} checked={qqPersonalOnly} onChange={(e) => setQqPersonalOnly(e.target.checked)} />
										{t("settings.channels.personalOnly")}
									</label>
								</div>
								<div className="col-span-2">
									<label className={labelCls}>{t("settings.channels.allowedUserIds")}</label>
									<textarea className={`${inputCls} h-14 resize-y`} placeholder={t("settings.channels.allowedUserIdsHint") ?? ""} value={qqAllowedUsers} onChange={(e) => setQqAllowedUsers(e.target.value)} />
								</div>
							</div>
						)}
					</div>
					)}

					{/* WeChat (iLink native) */}
					<div className="rounded-lg bg-[var(--inno-surface)] p-3">
						<div className="mb-2 flex items-center justify-between">
							<div>
								<div className="text-xs font-medium text-[var(--inno-text)]">{t("settings.channels.wechat.title")}</div>
								<div className="text-[10px] text-[var(--inno-text-subtle)]">{t("settings.channels.wechat.desc")}</div>
							</div>
							<label className={checkCls}>
								<input type="checkbox" className={checkboxCls} checked={wechatEnabled} onChange={(e) => setWechatEnabled(e.target.checked)} />
								{t("settings.channels.enabled")}
							</label>
						</div>
						{wechatEnabled && (
							<div className="grid gap-2">
								{/* Connection status */}
								<div className="flex items-center gap-2 rounded border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2.5 py-2">
									{wxConnected ? (
										<>
											<Wifi size={14} className="text-[var(--inno-success)]" />
											<span className="text-xs font-medium text-[var(--inno-success)]">{t("settings.channels.wechat.connected")}</span>
											{wxBotId && <span className="text-[10px] text-[var(--inno-text-subtle)] ml-1">{t("settings.channels.wechat.botId")}: {wxBotId}</span>}
										</>
									) : (
										<>
											<WifiOff size={14} className="text-[var(--inno-text-subtle)]" />
											<span className="text-xs text-[var(--inno-text-muted)]">{t("settings.channels.wechat.disconnected")}</span>
										</>
									)}
								</div>

								{/* QR login area */}
								<div className="flex flex-col items-center gap-2 rounded border border-dashed border-[var(--inno-border)] bg-[var(--inno-surface)] p-3">
									{qrUrl && qrStatus !== "confirmed" && qrStatus !== "expired" && (
										<QRCodeSVG value={qrUrl} size={192} level="M" />
									)}
									{qrStatus === "confirmed" && (
										<div className="flex items-center gap-1.5 text-xs text-[var(--inno-success)]">
											<CheckCircle size={14} />
											{t("settings.channels.wechat.confirmed")}
										</div>
									)}
									{qrStatus === "expired" && (
										<div className="text-xs text-[var(--inno-warning)]">{t("settings.channels.wechat.expired")}</div>
									)}
									{qrStatus === "scanning" && (
										<div className="text-xs text-[var(--inno-text-subtle)]">{t("settings.channels.wechat.scanning")}</div>
									)}
									{qrStatus === "waitingScan" && (
										<div className="text-xs text-[var(--inno-text-muted)]">{t("settings.channels.wechat.waitingScan")}</div>
									)}
									{qrStatus === "scanned" && (
										<div className="text-xs text-[var(--inno-accent)]">{t("settings.channels.wechat.scanned")}</div>
									)}
									{(!qrStatus || qrStatus === "confirmed" || qrStatus === "expired") && (
										<button
											className="flex items-center gap-1.5 rounded-md inno-primary-button px-3 py-1.5 text-xs text-white"
											onClick={() => void startQrLogin()}
										>
											<QrCodeIcon size={14} />
											{wxConnected ? t("settings.channels.wechat.relogin") : t("settings.channels.wechat.scanLogin")}
										</button>
									)}
									{qrError && (
										<div className="rounded bg-[var(--inno-danger-bg)] px-2 py-1 text-xs text-[var(--inno-danger)]">{qrError}</div>
									)}
								</div>
								<div className="flex items-center gap-3">
									<label className={checkCls}>
										<input type="checkbox" className={checkboxCls} checked={wechatPersonalOnly} onChange={(e) => setWechatPersonalOnly(e.target.checked)} />
										{t("settings.channels.personalOnly")}
									</label>
								</div>
								<div>
									<label className={labelCls}>{t("settings.channels.allowedUserIds")}</label>
									<textarea className={`${inputCls} h-14 resize-y`} placeholder={t("settings.channels.allowedUserIdsHint") ?? ""} value={wechatAllowedUsers} onChange={(e) => setWechatAllowedUsers(e.target.value)} />
								</div>
							</div>
						)}
					</div>

					{/* Bridge Token (used by QQ sidecar) */}
					{QQ_CHANNEL_READY && qqEnabled && (
						<div className="rounded-lg bg-[var(--inno-surface)] p-3">
							<div className="text-xs font-medium text-[var(--inno-text)] mb-1">{t("settings.channels.bridgeToken")}</div>
							<div className="text-[10px] text-[var(--inno-text-subtle)] mb-2">{t("settings.channels.bridgeTokenHint")}</div>
							<input
								className={inputCls}
								type="password"
								placeholder={settings.bridge?.token ? t("settings.channels.bridgeTokenPlaceholder") ?? "" : ""}
								value={bridgeToken}
								onChange={(e) => setBridgeToken(e.target.value)}
							/>
							{settings.bridge?.token && <div className="mt-1 text-[10px] text-[var(--inno-text-subtle)]">({settings.bridge.token})</div>}
						</div>
					)}

					{formError && <div className="rounded bg-[var(--inno-danger-bg)] px-2 py-1 text-xs text-[var(--inno-danger)]">{formError}</div>}
					{saveMsg && <div className="rounded bg-[var(--inno-success-bg)] px-2 py-1 text-xs text-[var(--inno-success)]">{saveMsg}</div>}
					<button
						className="rounded-md inno-primary-button px-3 py-1.5 text-xs text-white disabled:opacity-50 justify-self-start"
						disabled={saving}
						onClick={() => void handleSave()}
					>
						{saving ? t("settings.channels.saving") : t("settings.channels.save")}
					</button>
				</div>
			)}
		</div>
	);
}

/* ---------- Channels category page ---------- */

export function ChannelsSettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	return (
		<SettingsSection title={t("settings.tabs.channels")} description={t("settings.sections.channels.desc", "飞书、微信等消息渠道接入")}>
			<ChannelsCard settings={settings} />
		</SettingsSection>
	);
}
