import { lazy, Suspense } from "react";

interface LazyMarkdownEditorProps {
	value: string;
	onChange(value: string): void;
}

const MarkdownEditor = lazy(async () => {
	const [, , mod] = await Promise.all([
		import("@uiw/react-md-editor/markdown-editor.css"),
		import("@uiw/react-markdown-preview/markdown.css"),
		import("@uiw/react-md-editor"),
	]);
	return { default: mod.default };
});

function MarkdownEditorFallback() {
	return (
		<div className="flex h-full items-center justify-center bg-[var(--inno-surface)] text-xs text-[var(--inno-text-muted)]">
			Loading editor...
		</div>
	);
}

export function LazyMarkdownEditor({ value, onChange }: LazyMarkdownEditorProps) {
	return (
		<div className="h-full overflow-hidden" data-color-mode="light">
			<Suspense fallback={<MarkdownEditorFallback />}>
				<MarkdownEditor
					value={value}
					onChange={(next) => onChange(next ?? "")}
					height="100%"
					preview="live"
					visibleDragbar={false}
					style={{ height: "100%" }}
				/>
			</Suspense>
		</div>
	);
}
