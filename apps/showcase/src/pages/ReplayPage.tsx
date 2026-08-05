import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2, Pause, Play, RotateCcw, SkipForward } from "lucide-react";
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

export function ReplayPage({ caseId }: { caseId: string }) {
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
		<div className="flex h-screen flex-col bg-[var(--inno-chat-bg)] text-[var(--inno-text)]">
			<header className="shrink-0 border-b border-[var(--inno-border)] bg-[var(--inno-surface)]">
				<div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3">
					<a
						href="#/"
						className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
					>
						<ArrowLeft size={14} />
						全部案例
					</a>
					<div className="min-w-0 flex-1">
						<h1 className="truncate text-[14px] font-semibold leading-tight">
							{doc?.title ?? "加载中…"}
						</h1>
						{doc ? (
							<div className="mt-0.5 flex flex-wrap items-center gap-1">
								{doc.tags.map((tag) => (
									<span key={tag} className="rounded bg-[var(--inno-accent-soft)] px-1.5 py-px text-[10px] text-[var(--inno-accent)]">
										{tag}
									</span>
								))}
							</div>
						) : null}
					</div>
					<span className="shrink-0 rounded bg-[var(--inno-surface-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--inno-text-muted)]">
						真实会话回放
					</span>
				</div>
			</header>

			<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-4xl flex-col gap-3 px-4 py-6">
					{error ? (
						<div className="rounded-md border border-[var(--inno-danger-border)] bg-[var(--inno-danger-bg)] px-4 py-3 text-sm text-[var(--inno-danger)]">
							案例加载失败:{error}
						</div>
					) : doc === null ? (
						<div className="flex items-center justify-center gap-2 py-24 text-sm text-[var(--inno-text-muted)]">
							<Loader2 size={16} className="animate-spin" />
							加载案例中…
						</div>
					) : (
						<>
							{visible.map((message, i) => (
								<MessageBubble key={`${message.timestamp}-${i}`} message={message} />
							))}
							{!finished && playing ? (
								<div className="flex justify-start">
									<div className="flex items-center gap-1.5 rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3.5 py-2.5 text-[var(--inno-text-subtle)]">
										<span className="inno-replay-dot" />
										<span className="inno-replay-dot" style={{ animationDelay: "0.15s" }} />
										<span className="inno-replay-dot" style={{ animationDelay: "0.3s" }} />
									</div>
								</div>
							) : null}
							{finished ? (
								<div className="mx-auto mt-4 flex max-w-md flex-col items-center rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] px-6 py-5 text-center shadow-[var(--inno-shadow-soft)]">
									<p className="mb-1 text-[14px] font-semibold">回放结束</p>
									<p className="mb-4 text-[12px] leading-relaxed text-[var(--inno-text-muted)]">
										这是一条真实录制的会话。下载 Inno Agent,开始你自己的学习对话。
									</p>
									<div className="flex gap-2">
										<a
											href={REPO_URL}
											target="_blank"
											rel="noreferrer"
											className="rounded-md bg-[var(--inno-accent)] px-4 py-1.5 text-xs font-medium text-[var(--inno-surface)] transition-opacity hover:opacity-85"
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

			{doc ? (
				<footer className="shrink-0 border-t border-[var(--inno-border)] bg-[var(--inno-surface)]">
					<div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-2.5">
						<button
							onClick={() => (finished ? restart() : setPlaying((p) => !p))}
							className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--inno-border)] text-[var(--inno-text)] transition-colors hover:bg-[var(--inno-surface-muted)]"
							title={playing ? "暂停" : "播放"}
						>
							{playing && !finished ? <Pause size={15} /> : <Play size={15} />}
						</button>
						<button
							onClick={restart}
							className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--inno-border)] text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface-muted)]"
							title="从头播放"
						>
							<RotateCcw size={14} />
						</button>
						<input
							type="range"
							min={0}
							max={total}
							value={step}
							onChange={(e) => seek(Number(e.target.value))}
							className="inno-replay-slider min-w-0 flex-1"
						/>
						<span className="shrink-0 tabular-nums text-[11px] text-[var(--inno-text-subtle)]">
							{step} / {total}
						</span>
						<button
							onClick={cycleSpeed}
							className="shrink-0 rounded-md border border-[var(--inno-border)] px-2 py-1 text-[11px] font-medium tabular-nums text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface-muted)]"
							title="切换倍速"
						>
							{speed}×
						</button>
						<button
							onClick={() => seek(total)}
							className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--inno-border)] text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface-muted)]"
							title="跳到结尾"
						>
							<SkipForward size={14} />
						</button>
					</div>
				</footer>
			) : null}
		</div>
	);
}
