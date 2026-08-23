// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { SmartInputRule } from "../../../types/settings.js";
import { SmartInputEngine, type EngineAttachmentItem, type Slot } from "./engine.js";
import { slotChar } from "./rules.js";

function makeRule(keyword = "pdf"): SmartInputRule {
	return { id: `r-${keyword}`, isPreset: false, keyword, extensions: [".pdf"], allExtensions: false, excludeExtensions: [], enabled: true };
}

function makeEngine(
	value: string,
	slot?: Slot,
	onReturnAttachment: (item: EngineAttachmentItem) => void = () => undefined,
	allowDrag = true,
	rules: SmartInputRule[] = [makeRule()],
	onOpenStatusPanel: (slot: Slot, anchor: HTMLElement) => void = () => undefined,
): { engine: SmartInputEngine; textarea: HTMLTextAreaElement; mirror: HTMLDivElement; hitLayer: HTMLDivElement } {
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
		}),
			data: {
				getSettings: () => ({ enabled: true, allowDrag, allowRightClick: false }),
				getRules: () => rules,
				takeAttachment: () => undefined,
			returnAttachment: onReturnAttachment,
			},
			callbacks: {
				onChange: () => undefined,
			onSlotsSnapshot: () => undefined,
			onOpenStatusPanel,
			onOpenFillMenu: () => undefined,
			onBubbleContextMenu: () => undefined,
			onWorkspaceHighlight: () => undefined,
		},
	});
	if (slot) engine.adoptSlots([slot]);
	return { engine, textarea, mirror, hitLayer };
}

function slot(id = 1): Slot {
	return { id, word: "pdf", rule: makeRule(), files: [] };
}

function clipboardEvent(type: "copy" | "paste", values: Map<string, string>): Event {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", {
		value: {
			getData: (format: string) => values.get(format) ?? "",
			setData: (format: string, value: string) => values.set(format, value),
		},
	});
	return event;
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

	it("returns bound files to the attachment row when smart input is disabled", () => {
		const currentSlot = slot();
		currentSlot.files = [{ uid: 1, name: "lesson.pdf", path: "lesson.pdf", source: "workspace", state: "workspace", pct: 100 }];
		const returned: EngineAttachmentItem[] = [];
		const token = `{${slotChar(currentSlot.id)}}\u00A0\u00A0`;
		const { engine, textarea } = makeEngine(`阅读${token}`, currentSlot, (item) => returned.push(item));

		engine.attach();
		engine.detach();

		expect(textarea.value).toBe("阅读pdf");
		expect(returned).toEqual([{ name: "lesson.pdf", path: "lesson.pdf", source: "workspace" }]);
		expect(engine.slots).toHaveLength(0);
	});

	it("flushes the mirror immediately for paste input", () => {
		const { engine, textarea, mirror } = makeEngine("");
		engine.attach();

		textarea.value = "快速粘贴的内容";
		textarea.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", bubbles: true }));

		expect(mirror.textContent).toContain("快速粘贴的内容");
	});

	it("paints the native selection on visible text and bubbles", async () => {
		const currentSlot = slot();
		const token = `{${slotChar(currentSlot.id)}}\u00A0\u00A0`;
		const { engine, textarea, mirror, hitLayer } = makeEngine(`前面的文字${token}后面的文字`, currentSlot);
		engine.attach();
		const flushFrame = async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
		textarea.setSelectionRange(0, textarea.value.length);
		textarea.dispatchEvent(new Event("select", { bubbles: true }));
		await flushFrame();

		const selectedText = Array.from(mirror.querySelectorAll<HTMLElement>(".inno-smart-selection"))
			.map((element) => element.textContent ?? "")
			.join("");
		expect(selectedText).toBe("前面的文字后面的文字");
		expect(mirror.querySelector(".inno-smart-slot-tok")?.classList.contains("is-selected")).toBe(true);
		expect(hitLayer.querySelector(".inno-smart-chip")?.classList.contains("is-selected")).toBe(true);

		textarea.setSelectionRange(0, 1);
		textarea.dispatchEvent(new Event("select", { bubbles: true }));
		await flushFrame();
		expect(hitLayer.querySelector(".inno-smart-chip")?.classList.contains("is-selected")).toBe(false);
	});

	it("copies bound file names for other apps and restores files in-app as loose attachments", () => {
		const sourceSlot = slot();
		sourceSlot.files = [
			{ uid: 1, name: "lesson.pdf", path: "lesson.pdf", source: "workspace", state: "workspace", pct: 100 },
			{ uid: 2, name: "slides.pdf", path: "slides.pdf", source: "workspace", state: "workspace", pct: 100 },
		];
		const token = `{${slotChar(sourceSlot.id)}}\u00A0\u00A0`;
		const source = makeEngine(`前${token}后`, sourceSlot);
		source.engine.attach();
		source.textarea.setSelectionRange(0, source.textarea.value.length);
		const copied = new Map<string, string>();
		const copy = clipboardEvent("copy", copied);
		source.textarea.dispatchEvent(copy);

		expect(copy.defaultPrevented).toBe(true);
		expect(copied.get("text/plain")).toBe("前pdf后\nlesson.pdf\nslides.pdf");
		const payload = JSON.parse(copied.get("application/x-inno-agent-smart-bubble") ?? "null") as { bubbles?: Array<{ files?: Array<{ name: string }> }> };
		expect(payload.bubbles?.[0]?.files?.map((file) => file.name)).toEqual(["lesson.pdf", "slides.pdf"]);

		const returned: EngineAttachmentItem[] = [];
		const target = makeEngine("", undefined, (item) => returned.push(item));
		target.engine.attach();
		const paste = clipboardEvent("paste", copied);
		target.textarea.dispatchEvent(paste);

		expect(paste.defaultPrevented).toBe(true);
		expect(target.textarea.value).toBe("");
		expect(target.engine.slots).toHaveLength(0);
		expect(returned.map((file) => file.name)).toEqual(["lesson.pdf", "slides.pdf"]);
	});

	it("leaves ordinary text clipboard operations native", () => {
		const { engine, textarea } = makeEngine("普通文字");
		engine.attach();
		textarea.setSelectionRange(0, textarea.value.length);
		const copied = new Map<string, string>();
		const copy = clipboardEvent("copy", copied);
		textarea.dispatchEvent(copy);

		expect(copy.defaultPrevented).toBe(false);
		expect(copied).toEqual(new Map());
	});

	it("preserves the textarea scroll position when an earlier keyword becomes a bubble", () => {
		const { engine, textarea, hitLayer } = makeEngine(`pdf ${"较长的文本 ".repeat(80)}`);
		let scrollTop = 48;
		Object.defineProperty(textarea, "scrollTop", {
			configurable: true,
			get: () => scrollTop,
			set: (value: number) => { scrollTop = value; },
		});
		Object.defineProperty(textarea, "focus", {
			configurable: true,
			value: () => { scrollTop = 600; },
		});
		engine.attach();

		const keywordHit = hitLayer.querySelector<HTMLElement>(".inno-smart-kw-hit");
		expect(keywordHit).not.toBeNull();
		keywordHit?.click();

		expect(scrollTop).toBe(48);
	});

	it("keeps the bubble hit layer aligned while the textarea scrolls", () => {
		const { engine, textarea, mirror, hitLayer } = makeEngine("");
		engine.attach();
		Object.defineProperty(textarea, "scrollTop", { configurable: true, value: 36 });
		textarea.dispatchEvent(new Event("scroll"));

		expect(mirror.style.transform).toBe("translateY(-36px)");
		expect(hitLayer.style.transform).toBe("translateY(-36px)");
	});

	it("auto-scrolls the textarea when a bubble is dragged to the lower edge", () => {
		const currentSlot = slot();
		const token = `{${slotChar(currentSlot.id)}}\u00A0\u00A0`;
		const { engine, textarea, hitLayer } = makeEngine(`前${token}后`, currentSlot);
		let scrollTop = 0;
		Object.defineProperty(textarea, "scrollTop", {
			configurable: true,
			get: () => scrollTop,
			set: (value: number) => { scrollTop = value; },
		});
		Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 600 });
		Object.defineProperty(textarea, "clientHeight", { configurable: true, value: 100 });
		Object.defineProperty(textarea, "getBoundingClientRect", {
			configurable: true,
			value: () => ({ top: 0, bottom: 100, height: 100 }),
		});
		engine.attach();

		const chip = hitLayer.querySelector<HTMLElement>(".inno-smart-chip");
		expect(chip).not.toBeNull();
		if (!chip) return;
		const pointerEvent = (type: string, clientY: number) => {
			const event = new Event(type, { bubbles: true, cancelable: true });
			Object.defineProperties(event, {
				button: { configurable: true, value: 0 },
				clientX: { configurable: true, value: 10 },
				clientY: { configurable: true, value: clientY },
				pointerId: { configurable: true, value: 1 },
				pointerType: { configurable: true, value: "mouse" },
			});
			return event;
		};

		chip.dispatchEvent(pointerEvent("pointerdown", 10));
		window.dispatchEvent(pointerEvent("pointermove", 98));
		window.dispatchEvent(pointerEvent("pointerup", 98));

		expect(scrollTop).toBeGreaterThan(0);
	});

	it("binds all matching files from a mixed multi-file drop and returns mismatches", () => {
		const currentSlot = slot();
		const returned: EngineAttachmentItem[] = [];
		const token = `{${slotChar(currentSlot.id)}}\u00A0\u00A0`;
		const { engine, hitLayer } = makeEngine(token, currentSlot, (item) => returned.push(item));
		engine.attach();

		const accepted = new File(["pdf"], "lesson.pdf", { type: "application/pdf" });
		const acceptedSecond = new File(["pdf"], "slides.pdf", { type: "application/pdf" });
		const rejected = new File(["text"], "notes.txt", { type: "text/plain" });
		const event = new Event("drop", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "dataTransfer", { value: { files: [accepted, acceptedSecond, rejected] } });

		const chip = hitLayer.querySelector<HTMLElement>(".inno-smart-chip");
		chip?.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(currentSlot.files.map((file) => file.name)).toEqual(["lesson.pdf", "slides.pdf"]);
		expect(returned).toHaveLength(1);
		expect(returned[0]).toMatchObject({ name: "notes.txt", path: "notes.txt", source: "local" });
		expect(returned[0]?.file).toBe(rejected);
	});

	it("binds a workspace multi-selection from in-page drag metadata", () => {
		const currentSlot = slot();
		const returned: EngineAttachmentItem[] = [];
		const token = `{${slotChar(currentSlot.id)}}\u00A0\u00A0`;
		const { engine, hitLayer } = makeEngine(token, currentSlot, (item) => returned.push(item));
		engine.attach();
		engine.markDragStart([
			{ name: "one.pdf", path: "one.pdf", source: "workspace" },
			{ name: "two.pdf", path: "two.pdf", source: "workspace" },
			{ name: "notes.txt", path: "notes.txt", source: "workspace" },
		], "page:one.pdf|two.pdf|notes.txt");

		const event = new Event("drop", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "dataTransfer", { value: { files: [] } });
		hitLayer.querySelector<HTMLElement>(".inno-smart-chip")?.dispatchEvent(event);

		expect(currentSlot.files.map((file) => file.name)).toEqual(["one.pdf", "two.pdf"]);
		expect(returned).toEqual([{ name: "notes.txt", path: "notes.txt", source: "workspace" }]);
	});

	it("prefers a matching preset over a user all-formats rule for right-click insertion", () => {
		const preset = {
			...makeRule("pdf"),
			id: "smart-rule-pdf",
			isPreset: true,
		};
		const allFormats = {
			...makeRule("附件"),
			id: "custom-all",
			extensions: [],
			allExtensions: true,
		};
		const { engine } = makeEngine("", undefined, undefined, true, [allFormats, preset]);
		engine.attach();

		engine.insertAttachmentAsBubble({ name: "lesson.pdf", path: "lesson.pdf", source: "workspace" });

		expect(engine.slots).toHaveLength(1);
		expect(engine.slots[0]?.word).toBe("pdf");
		expect(engine.slots[0]?.rule).toBe(preset);
	});

	it("reorders a bubble to a text-flow position even when file drag-to-fill is disabled", () => {
		const currentSlot = slot();
		const token = `{${slotChar(currentSlot.id)}}\u00A0`;
		const { engine, textarea, mirror, hitLayer } = makeEngine(`前${token}后`, currentSlot, undefined, false);
		engine.attach();

		const chip = hitLayer.querySelector<HTMLElement>(".inno-smart-chip");
		expect(chip).not.toBeNull();
		if (!chip) return;

		const makePointerEvent = (type: string, clientX: number, clientY: number) => {
			const event = new Event(type, { bubbles: true, cancelable: true });
			Object.defineProperties(event, {
				button: { configurable: true, value: 0 },
				clientX: { configurable: true, value: clientX },
				clientY: { configurable: true, value: clientY },
				pointerId: { configurable: true, value: 1 },
			});
			return event;
		};

		const doc = document as Document & {
			caretRangeFromPoint?: (x: number, y: number) => Range | null;
		};
		const originalCaretRangeFromPoint = doc.caretRangeFromPoint;
		Object.defineProperty(doc, "caretRangeFromPoint", {
			configurable: true,
			value: () => {
				const range = document.createRange();
				range.selectNodeContents(mirror);
				range.collapse(false);
				return range;
			},
		});

		try {
			chip.dispatchEvent(makePointerEvent("pointerdown", 10, 10));
			window.dispatchEvent(makePointerEvent("pointermove", 250, 100));
			window.dispatchEvent(makePointerEvent("pointerup", 250, 100));

			expect(textarea.value).toBe(`前后${token}`);
			expect(engine.slots).toHaveLength(1);
		} finally {
			if (originalCaretRangeFromPoint) {
				Object.defineProperty(doc, "caretRangeFromPoint", { configurable: true, value: originalCaretRangeFromPoint });
			} else {
				Reflect.deleteProperty(doc, "caretRangeFromPoint");
			}
		}
	});

	it("opens the bubble panel after a click without a drag", () => {
		const currentSlot = slot();
		currentSlot.files = [{ uid: 1, name: "lesson.pdf", path: "lesson.pdf", source: "workspace", state: "workspace", pct: 100 }];
		const token = `{${slotChar(currentSlot.id)}}\u00A0`;
		let opened = 0;
		const { engine, hitLayer } = makeEngine(`前${token}后`, currentSlot, undefined, true, [makeRule()], () => {
			opened += 1;
		});
		engine.attach();

		const chip = hitLayer.querySelector<HTMLElement>(".inno-smart-chip");
		expect(chip).not.toBeNull();
		if (!chip) return;
		const pointerDown = new Event("pointerdown", { bubbles: true, cancelable: true });
		Object.defineProperties(pointerDown, {
			button: { configurable: true, value: 0 },
			pointerId: { configurable: true, value: 1 },
			pointerType: { configurable: true, value: "mouse" },
			clientX: { configurable: true, value: 10 },
			clientY: { configurable: true, value: 10 },
		});
		chip.dispatchEvent(pointerDown);
		const pointerUp = new Event("pointerup", { bubbles: true, cancelable: true });
		Object.defineProperty(pointerUp, "pointerId", { configurable: true, value: 1 });
		window.dispatchEvent(pointerUp);
		chip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

		expect(opened).toBe(1);
	});

	it("fuses same-format bubbles and moves unique files to the target", () => {
		const source = slot(1);
		source.files = [{ uid: 1, name: "source.pdf", path: "source.pdf", source: "workspace", state: "workspace", pct: 100 }];
		const target = slot(2);
		target.files = [{ uid: 2, name: "target.pdf", path: "target.pdf", source: "workspace", state: "workspace", pct: 100 }];
		const sourceToken = `{${slotChar(source.id)}}\u00A0`;
		const targetToken = `{${slotChar(target.id)}}\u00A0`;
		const { engine, textarea } = makeEngine(`先${sourceToken}后${targetToken}`, source);
		engine.adoptSlots([source, target]);
		engine.attach();

		expect(engine.mergeSlots(source, target)).toBe(true);
		expect(textarea.value).toBe(`先后${targetToken}`);
		expect(engine.slots).toEqual([target]);
		expect(target.files.map((file) => file.name)).toEqual(["target.pdf", "source.pdf"]);
	});

	it("does not fuse bubbles with different format contracts", () => {
		const source = slot(1);
		const target: Slot = { ...slot(2), rule: { ...makeRule("doc"), extensions: [".doc"] } };
		const sourceToken = `{${slotChar(source.id)}}\u00A0`;
		const targetToken = `{${slotChar(target.id)}}\u00A0`;
		const value = `先${sourceToken}后${targetToken}`;
		const { engine, textarea } = makeEngine(value, source);
		engine.adoptSlots([source, target]);
		engine.attach();

		expect(engine.mergeSlots(source, target)).toBe(false);
		expect(textarea.value).toBe(value);
		expect(engine.slots).toEqual([source, target]);
	});
});
