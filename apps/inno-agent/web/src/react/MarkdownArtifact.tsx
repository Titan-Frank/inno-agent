import { lazy, Suspense } from "react";

interface MarkdownArtifactProps {
	content: string;
}

const MarkdownArtifactElement = lazy(async () => {
	await import("@earendil-works/pi-web-ui");
	return {
		default: ({ content }: MarkdownArtifactProps) => <markdown-artifact content={content} />,
	};
});

export function MarkdownArtifact({ content }: MarkdownArtifactProps) {
	return (
		<Suspense fallback={<pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed">{content}</pre>}>
			<MarkdownArtifactElement content={content} />
		</Suspense>
	);
}
