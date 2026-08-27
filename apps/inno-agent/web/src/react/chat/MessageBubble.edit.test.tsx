// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key === "chat.editAndResend" ? "Edit and resend" : key,
	}),
}));

import type { ChatMessage } from "../../types/chat.js";
import { MessageBubble } from "./MessageBubble.js";

afterEach(cleanup);

const plainUserMessage: ChatMessage = {
	role: "user",
	content: "teh quadratic formula",
	timestamp: 1,
	channel: "web",
	entryId: "user-entry",
};

describe("MessageBubble edit and resend", () => {
	it("offers a plain Web user message for editing", () => {
		const onEdit = vi.fn();
		render(<MessageBubble message={plainUserMessage} onEdit={onEdit} />);

		fireEvent.click(screen.getByRole("button", { name: "Edit and resend" }));

		expect(onEdit).toHaveBeenCalledWith(plainUserMessage);
	});

	it("does not offer text-only editing when the original message has attachments", () => {
		const message: ChatMessage = {
			...plainUserMessage,
			attachments: {
				bindings: [],
				loose: [{ path: "question.pdf", kind: "pdf", source: "workspace" }],
			},
		};

		render(<MessageBubble message={message} onEdit={vi.fn()} />);

		expect(screen.queryByRole("button", { name: "Edit and resend" })).toBeNull();
	});

	it("does not offer editing for a transient message without a persisted entry id", () => {
		const { entryId: _entryId, ...message } = plainUserMessage;

		render(<MessageBubble message={message} onEdit={vi.fn()} />);

		expect(screen.queryByRole("button", { name: "Edit and resend" })).toBeNull();
	});
});
