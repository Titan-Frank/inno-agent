import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { X, AlertTriangle, FileCode2 } from "lucide-react";
import type { AttachmentBinding, AttachmentRef, ChatMessage, ChatToolRecord } from "../../types/chat.js";
import { normalizeMarkdownMath } from "../../utils/markdown-math.js";
import { splitContentByBindings } from "../../utils/attachment-render.js";
import { answeredQuestionnaireFromTool, buildAnsweredQuestionnaireTimeline } from "../../utils/questionnaire.js";
import type { AnsweredQuestionnaireView } from "../../utils/questionnaire.js";
import { KIND_COLORS, KIND_LABEL_KEYS } from "./smart-input/kinds.js";
import { MarkdownArtifact } from "../MarkdownArtifact.js";
import { AnsweredQuestionCard } from "./AnsweredQuestionCard.js";

// Pure, props-driven chat rendering components. This module must NOT import
// stores or the api/ layer — apps/showcase reuses it to replay recorded
// sessions, so everything here renders from props alone.

const LONG_ASSISTANT_CHARS = 6000;
const LONG_ASSISTANT_LINES = 140;

const CHANNEL_BADGE_CLASS: Record<string, string> = {
	cli: "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)]",
	web: "bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]",
	feishu: "bg-[var(--inno-success-bg)] text-[var(--inno-success)]",
	scheduler: "bg-[var(--inno-warning-bg)] text-[var(--inno-warning)]",
	qq: "bg-cyan-50 text-cyan-500",
	wechat: "bg-lime-50 text-lime-500",
};

const CHANNEL_LABEL: Record<string, string> = {
	cli: "CLI",
	web: "Web",
	feishu: "Feishu",
	scheduler: "Job",
	qq: "QQ",
	wechat: "WeChat",
};

export function ChannelBadge({ channel }: { channel: string }) {
	return (
		<span className={`inline-block rounded px-1.5 py-px text-[9px] font-medium leading-tight ring-1 ring-black/5 ${CHANNEL_BADGE_CLASS[channel] ?? "bg-[var(--inno-surface-muted)] text-[var(--inno-text-subtle)]"}`}>
			{CHANNEL_LABEL[channel] ?? channel}
		</span>
	);
}

function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
	useEffect(() => {
		const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [onClose]);

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
			onClick={onClose}
		>
			<img
				src={src}
				alt="enlarged"
				className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
				onClick={(e) => e.stopPropagation()}
			/>
			<button
				className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/40"
				onClick={onClose}
			>
				<X size={16} />
			</button>
		</div>,
		document.body,
	);
}

/**
 * Collapsible red-tinted block for surfacing backend / model API errors
 * (e.g. HTTP 413 when the context is too long). Shows a short headline by
 * default and reveals the full backend message when expanded, so users know
 * something failed instead of seeing a silent dead end.
 */
export type AttachmentUrlResolver = (file: AttachmentRef) => string | undefined;

function AttachmentFileChip({ file, resolveUrl }: {
	file: AttachmentRef;
	resolveUrl?: AttachmentUrlResolver;
}) {
	const url = resolveUrl?.(file);
	const inner = (
		<>
			<span aria-hidden="true" className="inno-smart-type-dot" style={{ backgroundColor: KIND_COLORS[file.kind] }} />
			<span className="min-w-0 truncate">{file.path.split("/").pop() ?? file.path}</span>
		</>
	);
	const className = "inno-smart-ref-chip";
	return url
		? <a className={className} href={url} target="_blank" rel="noreferrer" title={file.path}>{inner}</a>
		: <span className={className} title={file.path}>{inner}</span>;
}

/** Read-only hover panel for a sent bubble: bound files with source + path.
 *  Mirrors the composer status panel's look, but every action is removed. */
function SentBindingPanel({ binding, anchor }: { binding: AttachmentBinding; anchor: HTMLElement | null }) {
	const { t } = useTranslation();
	const [rect, setRect] = useState<DOMRect | null>(null);

	useEffect(() => {
		setRect(anchor?.getBoundingClientRect() ?? null);
	}, [anchor]);

	if (!rect) return null;
	const width = 260;
	const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
	const top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 190));

	return createPortal(
		<div
			className="inno-smart-panel inno-smart-panel--readonly"
			style={{ left, top, width }}
			role="tooltip"
		>
			<div className="inno-smart-panel-title">
				{t("chat.smartInput.boundFilesTitle", "「{{word}}」绑定的文件（{{count}}）", { word: binding.word, count: binding.files.length })}
			</div>
			<div className="inno-smart-panel-list">
				{binding.files.map((file) => (
					<div key={file.path} className="inno-smart-panel-row">
						<span aria-hidden="true" className="inno-smart-type-dot" style={{ backgroundColor: KIND_COLORS[file.kind] }} />
						<span className="inno-smart-panel-name" title={file.path}>{file.path.split("/").pop() ?? file.path}</span>
						<span className="inno-smart-src-tag">
							{file.source === "workspace" ? t("chat.smartInput.sourceWorkspace", "工作区") : t("chat.smartInput.sourceUpload", "本地上传")}
						</span>
						<span className="inno-smart-status-done" title={file.path}>✓</span>
					</div>
				))}
			</div>
			<div className="inno-smart-panel-caption">
				{t("chat.smartInput.kindLabel", "类型")}: {t(KIND_LABEL_KEYS[binding.files[0]?.kind ?? "file"])}
				{" · "}
				{t("chat.smartInput.sentReadonly", "已随消息发送 · 只读")}
			</div>
		</div>,
		document.body,
	);
}

/**
 * Renders a sent user message with inline binding bubbles: the recorded word
 * occurrence is replaced by a word pill + one ref-chip per bound file, loose
 * attachments render as a chip row, and a collapsible details block exposes
 * the exact structured payload the agent received.
 */
function UserAttachmentContent({ content, attachments, resolveUrl }: {
	content: string;
	attachments: NonNullable<ChatMessage["attachments"]>;
	resolveUrl?: AttachmentUrlResolver;
}) {
	const { t } = useTranslation();
	const { segments, unplaced } = useMemo(
		() => splitContentByBindings(content, attachments.bindings),
		[content, attachments.bindings],
	);
	const [hovered, setHovered] = useState<{ binding: AttachmentBinding; anchor: HTMLElement } | null>(null);
	const openTimer = useRef<number | null>(null);
	const closeTimer = useRef<number | null>(null);

	useEffect(() => () => {
		if (openTimer.current) window.clearTimeout(openTimer.current);
		if (closeTimer.current) window.clearTimeout(closeTimer.current);
	}, []);

	const showBinding = (binding: AttachmentBinding, event: React.MouseEvent) => {
		if (closeTimer.current) window.clearTimeout(closeTimer.current);
		const anchor = event.currentTarget as HTMLElement;
		if (hovered?.binding === binding) return;
		if (openTimer.current) window.clearTimeout(openTimer.current);
		openTimer.current = window.setTimeout(() => setHovered({ binding, anchor }), 300);
	};
	const scheduleHide = () => {
		if (openTimer.current) window.clearTimeout(openTimer.current);
		if (closeTimer.current) window.clearTimeout(closeTimer.current);
		closeTimer.current = window.setTimeout(() => setHovered(null), 260);
	};

	const renderBinding = (binding: AttachmentBinding) => (
		<span
			key={`${binding.word}-${binding.wordIndex}`}
			className="inno-smart-ref-inline"
			onMouseEnter={(event) => showBinding(binding, event)}
			onMouseLeave={scheduleHide}
		>
			<span className="inno-smart-ref-word" title={t("chat.smartInput.sentBubbleHint", "已绑定 {{count}} 个文件", { count: binding.files.length })}>
				<span aria-hidden="true" className="inno-smart-type-dot" style={{ backgroundColor: KIND_COLORS[binding.files[0]?.kind ?? "file"] }} />
				{binding.word}
			</span>
			{binding.files.map((file) => <AttachmentFileChip key={file.path} file={file} resolveUrl={resolveUrl} />)}
		</span>
	);

	const looseRow = attachments.loose.length > 0 ? (
		<div className="mt-1.5 flex flex-wrap gap-1.5">
			{attachments.loose.map((file) => <AttachmentFileChip key={file.path} file={file} resolveUrl={resolveUrl} />)}
		</div>
	) : null;

	const trailingBindings = unplaced.length > 0 ? (
		<div className="mt-1.5 flex flex-wrap gap-1.5">
			{unplaced.map((binding) => (
				<span key={`unplaced-${binding.word}-${binding.wordIndex}`} className="inno-smart-ref-inline">
					<span className="inno-smart-ref-word">
						<span aria-hidden="true" className="inno-smart-type-dot" style={{ backgroundColor: KIND_COLORS[binding.files[0]?.kind ?? "file"] }} />
						{binding.word}
					</span>
					{binding.files.map((file) => <AttachmentFileChip key={file.path} file={file} resolveUrl={resolveUrl} />)}
				</span>
			))}
		</div>
	) : null;

	const aiView = {
		text_for_model: content,
		bindings: attachments.bindings.map((binding) => ({
			word: binding.word,
			files: binding.files.map((file) => file.path),
		})),
		loose_attachments: attachments.loose.map((file) => file.path),
	};
	const details = (attachments.bindings.length > 0 || attachments.loose.length > 0) ? (
		<details className="inno-smart-details mt-1.5">
			<summary>{t("chat.smartInput.receivedPayload", "AI 收到的结构化附件")}</summary>
			<pre>{JSON.stringify(aiView, null, 2)}</pre>
		</details>
	) : null;

	return (
		<>
			{segments.map((segment, index) =>
				segment.kind === "text"
					? <Fragment key={index}>{segment.text}</Fragment>
					: renderBinding(segment.binding),
			)}
			{looseRow}
			{trailingBindings}
			{details}
			{hovered ? (
				<span onMouseEnter={() => { if (closeTimer.current) window.clearTimeout(closeTimer.current); }} onMouseLeave={scheduleHide}>
					<SentBindingPanel binding={hovered.binding} anchor={hovered.anchor} />
				</span>
			) : null}
		</>
	);
}

export function ErrorBlock({ error }: { error: string }) {
	const isLong = error.length > 80 || error.includes("\n");
	return (
		<details className="rounded-md border border-[var(--inno-danger-border)] bg-[var(--inno-danger-bg)] px-2.5 py-1.5 text-xs text-[var(--inno-danger)]" open={!isLong}>
			<summary className="flex cursor-pointer select-none items-center gap-1.5 font-medium">
				<AlertTriangle size={14} className="shrink-0" />
				Request failed
				{isLong ? <span className="text-[var(--inno-danger)]">· click to expand</span> : null}
			</summary>
			<pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--inno-danger)]">{error}</pre>
		</details>
	);
}

function shouldCollapseAssistantContent(content: string): boolean {
	if (content.length > LONG_ASSISTANT_CHARS) return true;
	return content.split(/\r\n|\r|\n/).length > LONG_ASSISTANT_LINES;
}

function AssistantContent({ content }: { content: string }) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const trimmed = content.trim();
	// normalizeMarkdownMath is a multi-regex full-text scan — cache it so
	// unrelated re-renders (e.g. streaming emits) don't re-scan old messages.
	const normalized = useMemo(() => normalizeMarkdownMath(trimmed), [trimmed]);
	if (!trimmed) return null;
	if (!shouldCollapseAssistantContent(trimmed)) {
		return <MarkdownArtifact content={normalized} />;
	}
	const lineCount = trimmed.split(/\r\n|\r|\n/).length;
	const preview = trimmed.slice(0, 900);
	return (
		<div className="rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-2.5">
			<div className="mb-2 flex min-w-0 items-center gap-2 text-xs text-[var(--inno-text-muted)]">
				<FileCode2 size={14} className="shrink-0 text-[var(--inno-accent)]" />
				<span className="min-w-0 flex-1 truncate">{t("chat.longContentCollapsed", "内容较长，已折叠以保持页面流畅")}</span>
				<span className="shrink-0 tabular-nums">{lineCount} {t("preview.streamingLines", "行")}</span>
			</div>
			{expanded ? (
				<div className="max-h-[60vh] overflow-auto rounded border border-[var(--inno-border)] bg-[var(--inno-surface)] p-2">
					<MarkdownArtifact content={normalized} />
				</div>
			) : (
				<pre className="max-h-36 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--inno-text-muted)] [overflow-wrap:anywhere]">
					{preview}
					{trimmed.length > preview.length ? "\n\n…" : ""}
				</pre>
			)}
			<button
				className="mt-2 rounded-md border border-[var(--inno-border)] px-2.5 py-1 text-xs text-[var(--inno-text-muted)] transition-colors hover:bg-[var(--inno-surface)] hover:text-[var(--inno-text)]"
				onClick={() => setExpanded((v) => !v)}
			>
				{expanded ? t("chat.collapseFullContent", "收起完整内容") : t("chat.expandFullContent", "展开完整内容")}
			</button>
		</div>
	);
}

/** Keep a completed questionnaire anchored where its tool call interrupted the
 * assistant text. Session history merges the text before and after a tool call
 * into one message, so rendering every tool above the message moves the card
 * away from the point at which the learner originally answered it. */
function AssistantTimelineContent({ content, questionnaires }: { content: string; questionnaires: AnsweredQuestionnaireView[] }) {
	const timeline = buildAnsweredQuestionnaireTimeline(content, questionnaires);
	return (
		<>
			{timeline.entries.map(({ tool, questionnaire, before }) => (
				<Fragment key={tool.toolCallId}>
					<AssistantContent content={before} />
					<div className="my-2">
						<AnsweredQuestionCard questionnaire={questionnaire} />
					</div>
				</Fragment>
			))}
			<AssistantContent content={timeline.tail} />
		</>
	);
}

export function ToolRecordDetails({ tool, className }: { tool: ChatToolRecord; className: string }) {	const [open, setOpen] = useState(false);
	const detail = useMemo(() => {
		if (!open) return "";
		return JSON.stringify({
			args: tool.args,
			result: tool.result,
		}, null, 2);
	}, [open, tool.args, tool.result]);

	return (
		<details className={className} onToggle={(e) => setOpen(e.currentTarget.open)}>
			<summary className={tool.isError ? "cursor-pointer break-words text-[var(--inno-danger)] [overflow-wrap:anywhere]" : "cursor-pointer break-words text-[var(--inno-text-muted)] [overflow-wrap:anywhere]"}>
				{tool.toolName}
			</summary>
			{open ? (
				<pre className="mt-1 max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] [overflow-wrap:anywhere]">{detail}</pre>
			) : null}
		</details>
	);
}

export const MessageBubble = memo(function MessageBubble({ message, showChannel, resolveAttachmentUrl }: {
	message: ChatMessage;
	showChannel?: boolean;
	/** Optional URL resolver for attachment chips (workspace raw link). Kept as
	 *  a prop so this module stays store/api-free for showcase replay. */
	resolveAttachmentUrl?: AttachmentUrlResolver;
}) {
	const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
	const answeredQuestionnaires = (message.tools ?? []).flatMap((tool): AnsweredQuestionnaireView[] => {
		const questionnaire = answeredQuestionnaireFromTool(tool);
		return questionnaire ? [{ tool, questionnaire }] : [];
	});
	const hasAnsweredQuestionnaire = answeredQuestionnaires.length > 0;
	const answeredToolCallIds = new Set(answeredQuestionnaires.map((view) => view.tool.toolCallId));
	const regularTools = (message.tools ?? []).filter((tool) => !answeredToolCallIds.has(tool.toolCallId));

	if (message.role === "user") {
		return (
			<motion.div
				className="flex justify-end"
				initial={{ opacity: 0, y: 12 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.25, ease: "easeOut" }}
			>
				<div className="inno-message w-fit whitespace-pre-wrap break-words rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--inno-text)]" style={{ maxWidth: "min(70%, 38rem)" }}>
					{showChannel && message.channel ? (
						<div className="mb-1 flex justify-end"><ChannelBadge channel={message.channel} /></div>
					) : null}
					{message.images?.length ? (
						<div className="mb-2 flex flex-wrap gap-1.5">
							{message.images.map((img, i) => (
								<img
									key={i}
									src={img.previewUrl}
									alt="attached"
									className="max-h-48 max-w-full cursor-zoom-in rounded object-contain"
									onClick={() => setLightboxSrc(img.previewUrl)}
								/>
							))}
						</div>
					) : null}
					{lightboxSrc ? <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} /> : null}
					{message.attachments && (message.attachments.bindings.length > 0 || message.attachments.loose.length > 0) ? (
						<UserAttachmentContent
							content={message.content.trim()}
							attachments={message.attachments}
							resolveUrl={resolveAttachmentUrl}
						/>
					) : (
						message.content.trim()
					)}
				</div>
			</motion.div>
		);
	}

	return (
		<motion.div
			className="flex justify-start"
			initial={{ opacity: 0, y: 12 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.25, ease: "easeOut" }}
		>
			<div className={`inno-message min-w-0 ${hasAnsweredQuestionnaire ? "w-full max-w-[76%]" : "max-w-[78%]"} overflow-hidden rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--inno-text)]`}>
				{showChannel && message.channel ? (
					<div className="mb-1"><ChannelBadge channel={message.channel} /></div>
				) : null}
				{message.thinking || regularTools.length ? (
					<details className="mb-2 min-w-0 max-w-full overflow-hidden rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2 py-1.5 text-xs text-[var(--inno-text-muted)]">
						<summary className="cursor-pointer select-none break-words font-medium text-[var(--inno-text-muted)] [overflow-wrap:anywhere]">
							Thinking & tool calls
							{regularTools.length ? ` · ${regularTools.length}` : ""}
						</summary>
						{message.thinking ? <pre className="mt-2 max-h-44 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono [overflow-wrap:anywhere]">{message.thinking}</pre> : null}
						{regularTools.length ? (
							<div className="mt-2 grid min-w-0 max-w-full gap-1.5">
								{regularTools.map((tool) => (
									<ToolRecordDetails key={tool.toolCallId} tool={tool} className="min-w-0 max-w-full overflow-hidden rounded border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1" />
								))}
							</div>
						) : null}
					</details>
				) : null}
				<AssistantTimelineContent content={message.content} questionnaires={answeredQuestionnaires} />
				{message.error ? (
					<div className={message.content.trim() ? "mt-2" : ""}>
						<ErrorBlock error={message.error} />
					</div>
				) : null}
			</div>
		</motion.div>
	);
});
