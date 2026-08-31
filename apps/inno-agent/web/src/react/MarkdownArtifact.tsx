import "@mariozechner/mini-lit/dist/CodeBlock.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";

interface MarkdownArtifactProps {
	content: string;
}

export function MarkdownArtifact({ content }: MarkdownArtifactProps) {
	return <markdown-block content={content} />;
}
