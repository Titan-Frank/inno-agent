// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MessageBubble } from "./MessageBubble.js";
import type { ChatMessage } from "../../types/chat.js";

afterEach(cleanup);

function renderCommand(content: string, onOpenSkill?: (skillName: string) => void) {
	const message: ChatMessage = {
		role: "user",
		content,
		timestamp: Date.now(),
	};
	render(<MessageBubble message={message} onOpenSkill={onOpenSkill} />);
	return document.querySelector<HTMLElement>(".inno-smart-agent-ref-bubble");
}

describe("sent Agent command bubbles", () => {
	it("uses the same sent bubble surface as file references", () => {
		const chip = renderCommand("/skill:backwards-design-unit-planner");

		expect(chip).not.toBeNull();
		expect(chip?.classList.contains("inno-smart-ref-word")).toBe(true);
		expect(chip?.classList.contains("inno-smart-agent-surface")).toBe(true);
		expect(chip?.textContent).toContain("backwards-design-unit-planner");
		expect(chip?.textContent).not.toContain("/skill:");
		expect(chip?.querySelector(".inno-smart-agent-mark")?.getAttribute("width")).toBe("11");
		expect(chip?.getAttribute("title")).toBeNull();
		expect(chip?.parentElement?.classList.contains("inno-smart-agent-ref-content")).toBe(true);
	});

	it("keeps native command hints on non-skill bubbles", () => {
		const chip = renderCommand("/recall");

		expect(chip?.textContent).toContain("回顾对话");
		expect(chip?.getAttribute("title")).toBe("查找并回顾以前的对话");
	});

	it("opens the skill detail panel when its sent bubble is clicked", () => {
		let openedSkill = "";
		const chip = renderCommand("/skill:backwards-design-unit-planner", (skillName) => { openedSkill = skillName; });

		expect(chip?.tagName).toBe("BUTTON");
		if (chip) fireEvent.click(chip);
		expect(openedSkill).toBe("backwards-design-unit-planner");
	});

	it("keeps the original thinking details surface", () => {
		render(
			<MessageBubble
				message={{ role: "assistant", content: "", thinking: "Planning", timestamp: Date.now() }}
			/>,
		);

		const details = document.querySelector<HTMLElement>("details");
		expect(details).not.toBeNull();
		expect(details?.className).toBe("mb-2 min-w-0 max-w-full overflow-hidden rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2 py-1.5 text-xs text-[var(--inno-text-muted)]");
		expect(details?.querySelector("summary")?.className).toContain("font-medium");
		expect(details?.querySelector("summary")?.textContent).toContain("Thinking & tool calls");
	});
});
