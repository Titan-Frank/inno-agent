import { useEffect, useRef, type ReactNode } from "react";
import { FilePlus2, Cpu, TerminalSquare, Zap, GraduationCap, BookOpen, CalendarClock, Puzzle, Settings, History, BookmarkPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SlashPaletteEntry } from "./slash-palette-utils.js";

export interface SlashCommandPaletteProps {
	entries: SlashPaletteEntry[];
	activeIndex: number;
	query: string;
	onSelect: (entry: SlashPaletteEntry) => void;
	onActiveChange: (index: number) => void;
}

const APP_ACTION_ICONS = {
	"new-chat": <FilePlus2 size={15} />,
	model: <Cpu size={15} />,
	profile: <GraduationCap size={15} />,
	jobs: <CalendarClock size={15} />,
	skills: <Puzzle size={15} />,
	settings: <Settings size={15} />,
} as const;

const AGENT_COMMAND_ICONS: Record<string, ReactNode> = {
	recall: <History size={15} />,
	remember: <BookmarkPlus size={15} />,
	wiki: <BookOpen size={15} />,
};

function entryIcon(entry: SlashPaletteEntry) {
	if (entry.group === "app") {
		return entry.action ? APP_ACTION_ICONS[entry.action] : <TerminalSquare size={15} />;
	}
	const known = AGENT_COMMAND_ICONS[entry.name];
	if (known) return known;
	if (entry.name.startsWith("skill:")) return <Zap size={15} />;
	return <TerminalSquare size={15} />;
}

/**
 * Codex-style slash-command menu shown above the composer while the draft is
 * a bare `/query`. Purely presentational — ChatCenter owns filtering,
 * keyboard navigation, and what "select" means per entry.
 */
export function SlashCommandPalette({ entries, activeIndex, query, onSelect, onActiveChange }: SlashCommandPaletteProps) {
	const { t } = useTranslation();
	const listRef = useRef<HTMLDivElement | null>(null);

	// Keep the active row in view during keyboard navigation.
	useEffect(() => {
		const list = listRef.current;
		const active = list?.querySelector<HTMLElement>('[data-active="true"]');
		active?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	let lastGroup: SlashPaletteEntry["group"] | null = null;
	return (
		<div
			className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] shadow-lg"
			role="listbox"
			aria-label={t("chat.slashPalette.ariaLabel")}
		>
			<div ref={listRef} className="max-h-72 overflow-y-auto py-1">
				{entries.length === 0 ? (
					<div className="px-3 py-2 text-xs text-[var(--inno-text-muted)]">
						{t("chat.slashPalette.empty", { query })}
					</div>
				) : (
					entries.map((entry, index) => {
						const showGroupHeader = entry.group !== lastGroup;
						lastGroup = entry.group;
						return (
							<div key={entry.key}>
								{showGroupHeader ? (
									<div className="px-3 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--inno-text-subtle)]">
										{entry.group === "app" ? t("chat.slashPalette.appGroup") : t("chat.slashPalette.agentGroup")}
									</div>
								) : null}
								<button
									type="button"
									role="option"
									aria-selected={index === activeIndex}
									data-active={index === activeIndex}
									className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm ${
										index === activeIndex
											? "bg-[var(--inno-accent-soft)] text-[var(--inno-text)]"
											: "text-[var(--inno-text)] hover:bg-[var(--inno-surface-muted)]"
									}`}
									onMouseEnter={() => onActiveChange(index)}
									onClick={() => onSelect(entry)}
								>
									<span className="shrink-0 text-[var(--inno-text-muted)]">{entryIcon(entry)}</span>
									<span className="shrink-0 font-medium">/{entry.name}</span>
									{entry.description ? (
										<span className="min-w-0 flex-1 truncate text-right text-xs text-[var(--inno-text-muted)]" title={entry.description}>
											{entry.description}
										</span>
									) : null}
								</button>
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}
