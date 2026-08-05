import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Image, Loader2, Paperclip, Pause, Play, RotateCcw, SendHorizonal, SkipForward, Sparkles } from "lucide-react";
import { MessageBubble } from "@inno-web/react/chat/MessageBubble.js";
import type { CaseDoc } from "../cases.js";
import { fetchCase } from "../cases.js";

const REPO_URL = "https://github.com/hhyqhh/inno-agent-open";
const SPEEDS = [1, 2, 4] as const;

// Reveal pacing: honor the real time gap between messages, clamped so short
// bursts stay readable and long thinking gaps don't bore the viewer.
const MIN_STEP_MS = 350;
const MAX_STEP_MS = 2500;
const FIRST_STEP_MS = 400;

function stepDelay(doc: CaseDoc, step: number, speed: number): number {
	if (step <= 0) return FIRST_STEP_MS / speed;
	const prev = doc.messages[step - 1]?.timestamp ?? 0;
	const curr = doc.messages[step]?.timestamp ?? prev;
	const gap = Math.max(0, curr - prev);
	return Math.min(MAX_STEP_MS, Math.max(MIN_STEP_MS, gap)) / speed;
}

/**
 * 1:1 replica of the product's chat view (ChatCenter normal layout):
 * conversation-stage + chat-scroll message column + bottom composer panel.
 * The composer is a disabled visual replica; the replay transport lives in a
 * slim bar right above it.
 */
export function ReplayPage({ caseId }: { caseId: string }) {
	const { t } = useTranslation();
	const [doc, setDoc] = useState<CaseDoc | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [step, setStep] = useState(0);
	const [playing, setPlaying] = useState(false);
	const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(2);
	const scrollRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		setDoc(null);
		setError(null);
		setStep(0);
		setPlaying(false);
		fetchCase(caseId)
			.then((loaded) => {
				setDoc(loaded);
				setPlaying(true);
			})
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	}, [caseId]);

	const total = doc?.messages.length ?? 0;
	const finished = doc !== null && step >= total;

	// Playback driver.
	useEffect(() => {
		if (!doc || !playing || step >= total) return;
		const timer = window.setTimeout(() => setStep((s) => s + 1), stepDelay(doc, step, speed));
		return () => window.clearTimeout(timer);
	}, [doc, playing, step, speed, total]);

	// Keep the newest message in view while replaying.
	useEffect(() => {
		if (!playing) return;
		const el = scrollRef.current;
		if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
	}, [step, playing]);

	const seek = useCallback((value: number) => {
		setPlaying(false);
		setStep(value);
	}, []);

	const restart = useCallback(() => {
		setStep(0);
		setPlaying(true);
	}, []);

	const cycleSpeed = useCallback(() => {
		setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]);
	}, []);

	const visible = useMemo(() => doc?.messages.slice(0, step) ?? [], [doc, step]);

	return (
		<section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--inno-chat-bg)]">
			<div className="conversation-stage relative min-h-0 flex-1">
				<div
					ref={scrollRef}
					className="chat-scroll inno-chat-grid h-full min-h-0 overflow-y-auto px-4 py-4"
				>
					<div className="mx-auto flex min-w-0 max-w-3xl flex-col gap-3">
						{error ? (
							<div className="rounded-md border border-[var(--inno-danger-border)] bg-[var(--inno-danger-bg)] px-4 py-3 text-sm text-[var(--inno-danger)]">
								案例加载失败：{error}
							</div>
						) : doc === null ? (
							<div className="flex flex-col items-center justify-center pt-20 text-[var(--inno-text-muted)]">
								<Loader2 size={20} className="mb-3 animate-spin text-[var(--inno-border-strong)]" />
								<p className="text-sm">加载案例中…</p>
							</div>
						) : (
							<>
								{/* Case header — centered, like a system divider in the conversation */}
								<div className="mb-1 flex flex-col items-center gap-1.5 pb-1 text-center">
									<span className="rounded-full border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-3 py-0.5 text-[10px] font-medium text-[var(--inno-text-muted)]">
										真实会话回放 · {doc.recordedAt}
									</span>
									<h1 className="text-[14px] font-semibold text-[var(--inno-text)]">{doc.title}</h1>
									<div className="flex flex-wrap items-center justify-center gap-1">
										{doc.tags.map((tag) => (
											<span key={tag} className="rounded bg-[var(--inno-accent-soft)] px-1.5 py-px text-[10px] text-[var(--inno-accent)]">
												{tag}
											</span>
										))}
									</div>
								</div>

								{visible.map((message, i) => (
									<MessageBubble key={`${message.timestamp}-${i}`} message={message} />
								))}

								{/* Same "activity" bubble the product shows while a turn runs */}
								{!finished && playing ? (
									<motion.div
										className="flex justify-start"
										initial={{ opacity: 0, y: 8 }}
										animate={{ opacity: 1, y: 0 }}
										transition={{ duration: 0.2, ease: "easeOut" }}
									>
										<div className="inno-message min-w-0 max-w-[78%] rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-[13px] text-[var(--inno-text-muted)] shadow-sm">
											<div className="flex min-w-0 items-center gap-2">
												<span className="inno-stream-status-dot is-streaming shrink-0" />
												<Sparkles size={14} className="shrink-0 text-[var(--inno-accent)]" />
												<span className="min-w-0 font-medium text-[var(--inno-text)]">回放中…</span>
											</div>
										</div>
									</motion.div>
								) : null}

								{finished ? (
									<div className="mx-auto mt-3 flex max-w-md flex-col items-center rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] px-6 py-5 text-center shadow-[var(--inno-shadow-soft)]">
										<p className="mb-1 text-[14px] font-semibold text-[var(--inno-text)]">回放结束</p>
										<p className="mb-4 text-[12px] leading-relaxed text-[var(--inno-text-muted)]">
											这是一条真实录制的会话。下载 Inno Agent，开始你自己的学习对话。
										</p>
										<div className="flex gap-2">
											<a
												href={REPO_URL}
												target="_blank"
												rel="noreferrer"
												className="inno-primary-button rounded-md px-4 py-1.5 text-xs font-medium"
											>
												获取 Inno Agent
											</a>
											<button
												onClick={restart}
												className="rounded-md border border-[var(--inno-border)] px-4 py-1.5 text-xs text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface-muted)]"
											>
												重新播放
											</button>
										</div>
									</div>
								) : null}
							</>
						)}
					</div>
				</div>
			</div>

			{/* Bottom panel — same chrome as the product's composer area */}
			<div className="shrink-0 border-t border-[var(--inno-border)] bg-[var(--inno-surface)] p-3">
				<div className="mx-auto max-w-3xl">
						{/* Replay transport */}
						<div className="mb-2 flex items-center gap-2">
							<button
								onClick={() => (finished ? restart() : setPlaying((p) => !p))}
								disabled={!doc}
								className="inno-icon-button flex h-7 w-7 shrink-0 items-center justify-center rounded-md disabled:opacity-50"
								title={playing && !finished ? "暂停" : "播放"}
							>
								{playing && !finished ? <Pause size={14} /> : <Play size={14} />}
							</button>
							<button
								onClick={restart}
								disabled={!doc}
								className="inno-icon-button flex h-7 w-7 shrink-0 items-center justify-center rounded-md disabled:opacity-50"
								title="从头播放"
							>
								<RotateCcw size={13} />
							</button>
							<input
								type="range"
								min={0}
								max={total}
								value={step}
								disabled={!doc}
								onChange={(e) => seek(Number(e.target.value))}
								className="inno-replay-slider min-w-0 flex-1"
							/>
							<span className="shrink-0 text-[11px] tabular-nums text-[var(--inno-text-subtle)]">
								{step} / {total}
							</span>
							<button
								onClick={cycleSpeed}
								className="shrink-0 rounded-md border border-[var(--inno-border)] px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface-muted)]"
								title="切换倍速"
							>
								{speed}×
							</button>
							<button
								onClick={() => seek(total)}
								disabled={!doc}
								className="inno-icon-button flex h-7 w-7 shrink-0 items-center justify-center rounded-md disabled:opacity-50"
								title="跳到结尾"
							>
								<SkipForward size={13} />
							</button>
						</div>

						{/* Disabled 1:1 replica of the product composer */}
						<div className="inno-composer flex items-end gap-2 rounded-lg p-2">
							<button className="inno-icon-button flex h-9 w-9 shrink-0 rounded-md disabled:opacity-50" title={t("chat.uploadFiles", "上传文件")} disabled>
								<Paperclip size={16} />
							</button>
							<button className="inno-icon-button flex h-9 w-9 shrink-0 rounded-md disabled:opacity-50" title={t("chat.attachImage", "添加图片")} disabled>
								<Image size={16} />
							</button>
							<textarea
								className="max-h-[200px] min-h-[36px] flex-1 resize-none overflow-hidden rounded-md border-0 bg-transparent px-2 py-2 text-sm leading-5 text-[var(--inno-text)] outline-none placeholder:text-[var(--inno-text-subtle)] disabled:opacity-60"
								placeholder={t("chat.composerPlaceholder", "输入消息…")}
								rows={1}
								disabled
							/>
							<button
								className="inno-primary-button flex h-9 w-9 shrink-0 items-center justify-center rounded-md disabled:opacity-50"
								title={t("chat.send", "发送")}
								disabled
							>
								<SendHorizonal size={16} />
							</button>
						</div>
				</div>
			</div>
		</section>
	);
}
