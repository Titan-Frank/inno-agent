import { ArrowUpRight, LayoutGrid } from "lucide-react";
import type { CaseMeta } from "../cases.js";

const REPO_URL = "https://github.com/hhyqhh/inno-agent-open";

/**
 * Visual replica of the product's SessionSidebar (same chrome classes and
 * structure), with the session list replaced by the showcase case list.
 */
export function CaseSidebar({ cases, activeId }: { cases: CaseMeta[] | null; activeId?: string }) {
	return (
		<aside className="inno-sidebar-scope flex h-full min-h-0 flex-col overflow-hidden border-r border-[var(--inno-border)] bg-[var(--inno-sidebar-bg)]">
			{/* Header — mirrors SessionSidebar: IA badge + product name */}
			<div className="border-b border-[var(--inno-border)] px-3 py-2.5">
				<div className="flex items-center justify-between gap-2">
					<div className="flex min-w-0 items-center gap-2">
						<span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] text-[10px] font-semibold text-[var(--inno-text)] shadow-sm">
							IA
						</span>
						<div className="min-w-0">
							<h1 className="inno-sidebar-title font-semibold tracking-tight text-[var(--inno-text)]">
								Inno Agent
							</h1>
						</div>
					</div>
					<a
						href={REPO_URL}
						target="_blank"
						rel="noreferrer"
						title="GitHub"
						className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--inno-text-subtle)] transition-colors hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text-muted)]"
					>
						<ArrowUpRight size={14} />
					</a>
				</div>
			</div>

			{/* Section label */}
			<div className="flex items-center gap-1.5 px-3 pb-1 pt-2.5 text-[11px] font-medium text-[var(--inno-text-subtle)]">
				<LayoutGrid size={12} />
				案例回放
			</div>

			{/* Case list — same rhythm as the session cards */}
			<nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
				{cases === null ? (
					<p className="px-2 py-3 text-xs text-[var(--inno-text-subtle)]">加载中…</p>
				) : cases.length === 0 ? (
					<p className="px-2 py-3 text-xs text-[var(--inno-text-subtle)]">暂无案例</p>
				) : (
					<ul className="flex flex-col gap-0.5">
						{cases.map((c) => {
							const active = c.id === activeId;
							return (
								<li key={c.id}>
									<a
										href={`#/case/${encodeURIComponent(c.id)}`}
										className={`block rounded-md px-2 py-1.5 transition-colors ${
											active
												? "bg-[var(--inno-sidebar-active)]"
												: "hover:bg-[var(--inno-sidebar-active)]"
										}`}
									>
										<span className={`block truncate text-[13px] leading-snug ${active ? "font-medium text-[var(--inno-text)]" : "text-[var(--inno-text)]"}`}>
											{c.title}
										</span>
										<span className="mt-0.5 block truncate text-[11px] text-[var(--inno-text-subtle)]">
											{c.tags.join(" · ")} · {c.recordedAt}
										</span>
									</a>
								</li>
							);
						})}
					</ul>
				)}
			</nav>

			{/* Footer */}
			<div className="border-t border-[var(--inno-border)] px-3 py-2">
				<p className="text-[11px] leading-relaxed text-[var(--inno-text-subtle)]">
					均为真实会话录制回放
				</p>
				<a
					href={REPO_URL}
					target="_blank"
					rel="noreferrer"
					className="mt-1 flex items-center gap-1 text-[11px] text-[var(--inno-text-muted)] underline-offset-2 hover:underline"
				>
					获取 Inno Agent
					<ArrowUpRight size={11} />
				</a>
			</div>
		</aside>
	);
}
