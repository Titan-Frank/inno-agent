// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { SmartInputRule } from "../../../types/settings.js";
import { SmartInputEngine, type Slot } from "./engine.js";
import { slotChar } from "./rules.js";

function makeRule(keyword = "pdf"): SmartInputRule {
	return { id: `r-${keyword}`, keyword, extensions: [".pdf"], enabled: true };
}

function makeEngine(value: string, slot?: Slot): { engine: SmartInputEngine; textarea: HTMLTextAreaElement } {
	const textarea = document.createElement("textarea");
	const mirror = document.createElement("div");
	const hitLayer = document.createElement("div");
	textarea.value = value;
	document.body.append(textarea, mirror, hitLayer);
	const engine = new SmartInputEngine({
		textarea,
		mirror,
		hitLayer,
		labels: () => ({
			kwHitTitle: "",
			bubbleCreated: "",
			dragDisabled: "",
			alreadyBound: "",
			typeMismatch: "",
			noRuleForFile: "",
			insertedAsBubble: "",
			bound: "",
		}),
		data: {
			getSettings: () => ({ enabled: true, allowDrag: false, allowRightClick: false }),
			getRules: () => [makeRule()],
			getWorkspaceFiles: () => [],
			takeAttachment: () => undefined,
			returnAttachment: () => undefined,
		},
		callbacks: {
			onToast: () => undefined,
			onChange: () => undefined,
			onSlotsSnapshot: () => undefined,
			onOpenStatusPanel: () => undefined,
			onOpenFillMenu: () => undefined,
			onBubbleContextMenu: () => undefined,
			onWorkspaceHighlight: () => undefined,
		},
	});
	if (slot) engine.adoptSlots([slot]);
	return { engine, textarea };
}

function slot(id = 1): Slot {
	return { id, word: "pdf", rule: makeRule(), files: [] };
}

describe("SmartInputEngine token editing", () => {
	it("repairs a token whose closing syntax was deleted", () => {
		const currentSlot = slot();
		const broken = `阅读{${slotChar(currentSlot.id)}`;
		const { engine, textarea } = makeEngine(broken, currentSlot);
		textarea.setSelectionRange(broken.length, broken.length);

		engine.attach();

		expect(textarea.value).toBe("阅读pdf");
		expect(engine.slots).toHaveLength(0);
	});

	it("removes orphan token punctuation when the private marker was deleted", () => {
		const currentSlot = slot();
		const broken = `阅读}\u00A0\u00A0`;
		const { engine, textarea } = makeEngine(broken, currentSlot);
		textarea.setSelectionRange(broken.length, broken.length);

		engine.attach();

		expect(textarea.value).toBe("阅读");
		expect(textarea.value).not.toMatch(/[{}\uE000-\uF8FF]/);
	});

	it("deletes the whole bubble when Backspace lands inside its padded token", () => {
		const currentSlot = slot();
		const token = `{${slotChar(currentSlot.id)}}\u00A0\u00A0`;
		const { engine, textarea } = makeEngine(`阅读${token}`, currentSlot);
		engine.attach();
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);

		const event = new KeyboardEvent("keydown", { key: "Backspace", cancelable: true });
		textarea.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(textarea.value).toBe("阅读pdf");
		expect(engine.slots).toHaveLength(0);
	});

	it("deletes a selected bubble as one unit instead of leaving a marker fragment", () => {
		const currentSlot = slot();
		const token = `{${slotChar(currentSlot.id)}}\u00A0\u00A0`;
		const { engine, textarea } = makeEngine(`阅读${token}后`, currentSlot);
		engine.attach();
		const tokenStart = 2;
		textarea.setSelectionRange(tokenStart + 1, tokenStart + token.length - 1);

		const event = new InputEvent("beforeinput", {
			inputType: "deleteContentBackward",
			bubbles: true,
			cancelable: true,
		});
		textarea.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(textarea.value).toBe("阅读后");
		expect(engine.slots).toHaveLength(0);
	});
});
