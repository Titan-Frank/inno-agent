import { useEffect, useState } from "react";
import { ArrowRight, ArrowUpRight, Loader2, MessageSquareText, Sparkles } from "lucide-react";
import type { CaseMeta } from "../cases.js";
import { fetchCaseIndex } from "../cases.js";

const REPO_URL = "https://github.com/hhyqhh/inno-agent-open";

export function CaseListPage() {
	const [cases, setCases] = useState<CaseMeta[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		fetchCaseIndex()
			.then(setCases)
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	}, []);

	return (
		<div className="min-h-screen bg-[var(--inno-background)] text-[var(--inno-text)]">
			<header className="border-b border-[var(--inno-border)] bg-[var(--inno-surface)]">
				<div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-4">
					<Sparkles size={20} className="text-[var(--inno-accent)]" />
					<span className="text-[15px] font-semibold tracking-tight">Inno Agent</span>
					<span className="text-[13px] text-[var(--inno-text-muted)]">案例回放</span>
					<a
						href={REPO_URL}
						target="_blank"
						rel="noreferrer"
						className="ml-auto flex items-center gap-1.5 rounded-md border border-[var(--inno-border)] px-3 py-1.5 text-xs text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
					>
						<ArrowUpRight size={14} />
						GitHub
					</a>
				</div>
			</header>

			<main className="mx-auto max-w-5xl px-6 py-12">
				<section className="mb-10 max-w-2xl">
					<h1 className="mb-3 text-3xl font-semibold leading-tight tracking-tight">
						看 Inno Agent 如何陪伴学习
					</h1>
					<p className="text-[15px] leading-relaxed text-[var(--inno-text-muted)]">
						以下案例均为真实会话录制：一个会记住你学到哪里、把知识沉淀进 wiki、陪你做题讲题的个人学习
						agent。点击任意案例，逐条回放它的完整工作过程。
					</p>
				</section>

				{error ? (
					<div className="rounded-md border border-[var(--inno-danger-border)] bg-[var(--inno-danger-bg)] px-4 py-3 text-sm text-[var(--inno-danger)]">
						案例加载失败：{error}
					</div>
				) : cases === null ? (
					<div className="flex items-center gap-2 py-16 text-sm text-[var(--inno-text-muted)]">
						<Loader2 size={16} className="animate-spin" />
						加载案例中…
					</div>
				) : cases.length === 0 ? (
					<div className="py-16 text-sm text-[var(--inno-text-muted)]">暂无案例</div>
				) : (
					<div className="grid gap-4 sm:grid-cols-2">
						{cases.map((c) => (
							<a
								key={c.id}
								href={`#/case/${encodeURIComponent(c.id)}`}
								className="group flex flex-col rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] p-5 shadow-[var(--inno-shadow-soft)] transition-all hover:-translate-y-0.5 hover:border-[var(--inno-border-strong)]"
							>
								<div className="mb-2 flex items-start justify-between gap-3">
									<h2 className="text-[15px] font-semibold leading-snug">{c.title}</h2>
									<ArrowRight
										size={16}
										className="mt-0.5 shrink-0 text-[var(--inno-text-subtle)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--inno-accent)]"
									/>
								</div>
								<p className="mb-4 flex-1 text-[13px] leading-relaxed text-[var(--inno-text-muted)]">
									{c.description}
								</p>
								<div className="flex flex-wrap items-center gap-1.5">
									{c.tags.map((tag) => (
										<span
											key={tag}
											className="rounded bg-[var(--inno-accent-soft)] px-1.5 py-0.5 text-[11px] text-[var(--inno-accent)]"
										>
											{tag}
										</span>
									))}
									<span className="ml-auto flex items-center gap-1 text-[11px] text-[var(--inno-text-subtle)]">
										<MessageSquareText size={12} />
										{c.messageCount} 条消息 · {c.recordedAt}
									</span>
								</div>
							</a>
						))}
					</div>
				)}

				<footer className="mt-14 border-t border-[var(--inno-border)] pt-6 text-[12px] text-[var(--inno-text-subtle)]">
					案例来自真实使用录制，路径与个人信息已脱敏。
					<a href={REPO_URL} target="_blank" rel="noreferrer" className="ml-1 underline hover:text-[var(--inno-text)]">
						获取 Inno Agent
					</a>
				</footer>
			</main>
		</div>
	);
}
