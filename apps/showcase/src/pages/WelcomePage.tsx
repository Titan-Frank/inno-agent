import { ArrowRight, MessageSquareText, Sparkles } from "lucide-react";
import type { CaseMeta } from "../cases.js";

const REPO_URL = "https://github.com/hhyqhh/inno-agent-open";

/**
 * Landing view inside the chat column — mirrors the product's welcome
 * screen (centered hero above the composer area).
 */
export function WelcomePage({ cases }: { cases: CaseMeta[] | null }) {
	return (
		<section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--inno-chat-bg)]">
			<div className="chat-scroll inno-chat-grid min-h-0 flex-1 overflow-y-auto px-4 py-4">
				<div className="mx-auto flex min-h-full max-w-3xl flex-col items-center justify-center py-10 text-center">
					<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--inno-surface-muted)] text-[var(--inno-text-subtle)]">
						<Sparkles size={22} />
					</div>
					<h1 className="mb-2 text-xl font-semibold tracking-tight text-[var(--inno-text)]">
						看 Inno Agent 如何陪伴学习
					</h1>
					<p className="mb-8 max-w-xl text-[13px] leading-relaxed text-[var(--inno-text-muted)]">
						一个会记住你学到哪里、把知识沉淀进 wiki、陪你做题讲题的个人学习
						agent。以下案例均为真实会话录制——从左侧选择，或点击下方卡片，逐条回放它的完整工作过程。
					</p>

					<div className="grid w-full gap-3 text-left sm:grid-cols-2">
						{(cases ?? []).map((c) => (
							<a
								key={c.id}
								href={`#/case/${encodeURIComponent(c.id)}`}
								className="group flex flex-col rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] p-4 shadow-[var(--inno-shadow-soft)] transition-all hover:-translate-y-0.5 hover:border-[var(--inno-border-strong)]"
							>
								<div className="mb-1.5 flex items-start justify-between gap-3">
									<h2 className="text-[14px] font-semibold leading-snug text-[var(--inno-text)]">{c.title}</h2>
									<ArrowRight
										size={15}
										className="mt-0.5 shrink-0 text-[var(--inno-text-subtle)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--inno-accent)]"
									/>
								</div>
								<p className="mb-3 flex-1 text-[12px] leading-relaxed text-[var(--inno-text-muted)]">
									{c.description}
								</p>
								<div className="flex flex-wrap items-center gap-1.5">
									{c.tags.map((tag) => (
										<span
											key={tag}
											className="rounded bg-[var(--inno-accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--inno-accent)]"
										>
											{tag}
										</span>
									))}
									<span className="ml-auto flex items-center gap-1 text-[10px] text-[var(--inno-text-subtle)]">
										<MessageSquareText size={11} />
										{c.messageCount} 条
									</span>
								</div>
							</a>
						))}
					</div>

					<p className="mt-8 text-[12px] text-[var(--inno-text-subtle)]">
						路径与个人信息已脱敏 ·
						<a href={REPO_URL} target="_blank" rel="noreferrer" className="ml-1 underline hover:text-[var(--inno-text)]">
							在 GitHub 获取 Inno Agent
						</a>
					</p>
				</div>
			</div>
		</section>
	);
}
