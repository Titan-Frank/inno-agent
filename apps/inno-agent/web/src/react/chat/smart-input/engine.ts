import type { SmartInputRule } from "../../../types/settings.js";
import type { AttachmentBinding } from "../../../types/chat.js";
import { KIND_COLORS, kindFromName, nameMatchesExtensions } from "./kinds.js";
import {
	analyzeKeywords,
	buildOutgoing as buildOutgoingPure,
	slotChar,
	TOKEN_RE,
	tokenRegexFor,
	type KwRange,
	type OutgoingFile,
} from "./rules.js";

/**
 * SmartInputEngine — imperative port of the v76 prototype's three-layer
 * composer (mirror / textarea / hit layer). React owns the layer elements;
 * this class owns tokens, slots, rendering and the atomic-caret behavior.
 *
 * Layers:
 *   mirror  (bottom) — renders the visible text + red keyword underlines and
 *                      transparent token spans that size the in-text bubbles
 *   textarea (mid)   — transparent text, visible caret; the single source of
 *                      truth for the value
 *   hit     (top)    — absolutely positioned keyword hit-zones and bubble
 *                      chips, placed from the mirror spans' offsets
 */

export interface BoundFile {
	uid: number;
	name: string;
	/** Upload target / workspace path. */
	path: string;
	source: "workspace" | "upload";
	state: OutgoingFile["state"];
	pct: number;
	/** Present for staged OS files. */
	file?: File;
}

export interface Slot {
	id: number;
	word: string;
	rule: SmartInputRule;
	files: BoundFile[];
	/** Last badge count — only re-pop when the number changes. */
	_bc?: number;
	/** Spawned this sync — play the materialize animation once. */
	_spawn?: boolean;
}

export interface EngineAttachmentItem {
	name: string;
	path: string;
	source: "workspace" | "local";
	file?: File;
}

export interface EngineSnapshot {
	slotCount: number;
	boundFileCount: number;
}

export interface EngineCallbacks {
	onToast: (message: string, error?: boolean) => void;
	onChange: () => void;
	onSlotsSnapshot: (snapshot: EngineSnapshot) => void;
	onOpenStatusPanel: (slot: Slot, anchor: HTMLElement) => void;
	onOpenFillMenu: (slot: Slot, anchor: HTMLElement) => void;
	onBubbleContextMenu: (event: MouseEvent, slot: Slot, anchor: HTMLElement) => void;
	/** Filled-chip hover — drives the 450ms hover-open of the status panel. */
	onChipHover?: (slot: Slot, anchor: HTMLElement, entering: boolean) => void;
	onWorkspaceHighlight: (paths: string[] | null) => void;
}

export interface EngineData {
	getSettings: () => { enabled: boolean; allowDrag: boolean; allowRightClick: boolean };
	getRules: () => SmartInputRule[];
	getWorkspaceFiles: () => Array<{ name: string; path: string }>;
	takeAttachment: (path: string) => EngineAttachmentItem | undefined;
	returnAttachment: (item: EngineAttachmentItem) => void;
}

export interface EngineLabels {
	[key: string]: string;
}

export interface SmartInputEngineOptions {
	textarea: HTMLTextAreaElement;
	mirror: HTMLElement;
	hitLayer: HTMLElement;
	labels: () => EngineLabels;
	data: EngineData;
	callbacks: EngineCallbacks;
}

interface TokRect {
	start: number;
	end: number;
	x0: number;
	x1: number;
}

const DWELL_MS = 1000;

export class SmartInputEngine {
	private readonly ta: HTMLTextAreaElement;
	private readonly mirror: HTMLElement;
	private readonly hit: HTMLElement;
	private readonly opts: SmartInputEngineOptions;

	slots: Slot[] = [];
	private nextSlotId = 1;
	private nextFileId = 1;
	private tokRects: TokRect[] = [];
	private syncTimer: number | null = null;
	private detached = false;
	private dwellFollower: HTMLElement | null = null;
	private dwellRaf = 0;
	private dwellStart = 0;
	private dragPos = { x: 0, y: 0 };
	/** Set while an in-page file drag is live (workspace handle / attachment chip). */
	dragMeta: { type: string; raw: string; file?: { name: string; path: string; source: "workspace" | "local"; file?: File }; consumed?: boolean } | { bubble: true; slot: Slot; origValue: string; dropped: boolean } | null = null;

	constructor(options: SmartInputEngineOptions) {
		this.opts = options;
		this.ta = options.textarea;
		this.mirror = options.mirror;
		this.hit = options.hitLayer;
	}

	// ── lifecycle ───────────────────────────────────────────────────────────

	attach(): void {
		const ta = this.ta;
		ta.addEventListener("input", this.handleInput);
		ta.addEventListener("beforeinput", this.handleBeforeInput);
		ta.addEventListener("keydown", this.handleKeyDown);
		ta.addEventListener("click", this.snapCaretOut);
		ta.addEventListener("select", this.snapCaretOut);
		ta.addEventListener("mousedown", this.handleMouseDown);
		ta.addEventListener("scroll", this.handleScroll);
		ta.addEventListener("dragover", this.handleDragOver);
		ta.addEventListener("drop", this.handleDrop);
		window.addEventListener("resize", this.sync);
		this.sync();
	}

	/**
	 * Rehydrate slots when the composer DOM remounts (welcome ↔ conversation
	 * switch). Tokens in the surviving draft value keep their PUA slot ids, so
	 * the new engine instance adopts the old slot list as-is.
	 */
	adoptSlots(slots: Slot[]): void {
		this.slots = slots;
		this.nextSlotId = slots.reduce((max, slot) => Math.max(max, slot.id + 1), 1);
		this.nextFileId = slots.reduce(
			(max, slot) => slot.files.reduce((inner, file) => Math.max(inner, file.uid + 1), max),
			1,
		);
	}

	detach(): void {
		this.detached = true;
		this.teardown();
		// Settings only affect future input: restore any in-draft bubbles back
		// to their plain words so no PUA glyphs leak into the raw value.
		this.restoreAllTokens();
		this.slots = [];
		this.opts.callbacks.onWorkspaceHighlight(null);
		this.emitSnapshot();
	}

	/**
	 * Tear down for a composer DOM remount (welcome ↔ conversation switch):
	 * listeners and layers go away, but the draft value and slot list survive
	 * so the next engine instance picks up exactly where this one left off.
	 */
	detachForRemount(): void {
		this.detached = true;
		this.teardown();
	}

	private teardown(): void {
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
		this.stopDwellFollower();
		this.ta.removeEventListener("input", this.handleInput);
		this.ta.removeEventListener("beforeinput", this.handleBeforeInput);
		this.ta.removeEventListener("keydown", this.handleKeyDown);
		this.ta.removeEventListener("click", this.snapCaretOut);
		this.ta.removeEventListener("select", this.snapCaretOut);
		this.ta.removeEventListener("mousedown", this.handleMouseDown);
		this.ta.removeEventListener("scroll", this.handleScroll);
		this.ta.removeEventListener("dragover", this.handleDragOver);
		this.ta.removeEventListener("drop", this.handleDrop);
		window.removeEventListener("resize", this.sync);
		this.mirror.innerHTML = "";
		this.hit.innerHTML = "";
		this.opts.callbacks.onWorkspaceHighlight(null);
	}

	private emitSnapshot(): void {
		this.opts.callbacks.onSlotsSnapshot({
			slotCount: this.slots.length,
			boundFileCount: this.slots.reduce((sum, slot) => sum + slot.files.length, 0),
		});
		this.opts.callbacks.onChange();
	}

	// ── input / IME ─────────────────────────────────────────────────────────

	private handleInput = (event: Event): void => {
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
		// IME composition: sync the mirror immediately so composition text
		// renders through the mirror and tokens never flash as raw glyphs.
		if ((event as InputEvent).isComposing) {
			this.sync();
			return;
		}
		this.syncTimer = window.setTimeout(this.sync, 80);
	};

	private handleScroll = (): void => {
		this.mirror.style.transform = `translateY(${-this.ta.scrollTop}px)`;
	};

	// ── analyze + render ────────────────────────────────────────────────────

	private activeRules(): SmartInputRule[] {
		return this.opts.data.getRules().filter((rule) => rule.enabled && rule.keyword && rule.extensions.length > 0);
	}

	/**
	 * Native editing can still split a token before keydown reaches us (for
	 * example, deleting a selected range or using word-delete). Never let the
	 * implementation marker leak into the visible textarea: restore a known
	 * broken token to its plain keyword, and discard an orphan marker.
	 */
	private repairBrokenTokens(): string {
		const original = this.ta.value;
		if (!original) return original;

		const fragmentFor = (markerIndex: number): { start: number; end: number } => {
			let start = markerIndex;
			let end = markerIndex + 1;
			if (start > 0 && original[start - 1] === "{") start -= 1;
			if (original[end] === "}") end += 1;
			while (original[end] === "\u00A0") end += 1;
			return { start, end };
		};

		const replacements: Array<{ start: number; end: number; text: string }> = [];
		const protectedRanges: Array<{ start: number; end: number }> = [];
		const covered = (index: number): boolean =>
			replacements.some((replacement) => index >= replacement.start && index < replacement.end) ||
			protectedRanges.some((range) => index >= range.start && index < range.end);

		for (const slot of this.slots) {
			const tokenMatch = tokenRegexFor(slot.id).exec(original);
			if (tokenMatch) {
				const markerIndex = original.indexOf(slotChar(slot.id), tokenMatch.index);
				if (markerIndex !== -1) protectedRanges.push(fragmentFor(markerIndex));
				continue;
			}
			const markerIndex = original.indexOf(slotChar(slot.id));
			if (markerIndex === -1) continue;
			const fragment = fragmentFor(markerIndex);
			replacements.push({ ...fragment, text: slot.word });
		}

		// A stale slot can survive a remount or a selection edit. It has no word
		// to restore, so remove its marker and any adjacent token syntax instead
		// of rendering a private-use glyph to the user.
		const markerRe = /[\uE000-\uF8FF]/g;
		let marker: RegExpExecArray | null;
		while ((marker = markerRe.exec(original))) {
			if (!covered(marker.index)) {
				const fragment = fragmentFor(marker.index);
				replacements.push({ ...fragment, text: "" });
			}
		}
		// If the private-use marker itself was deleted, the native control can
		// leave only `{`/`}` plus the internal NBSP padding. Those NBSPs are not
		// user text, so this narrow cleanup is safe and removes the last visible
		// piece of a broken token without touching ordinary braces or spaces.
		const orphanSyntaxRe = /(?:\{\}|\{|\})\u00A0+/g;
		let orphanSyntax: RegExpExecArray | null;
		while ((orphanSyntax = orphanSyntaxRe.exec(original))) {
			if (!covered(orphanSyntax.index)) {
				replacements.push({ start: orphanSyntax.index, end: orphanSyntax.index + orphanSyntax[0].length, text: "" });
			}
		}
		if (replacements.length === 0) return original;

		const selectionStart = this.ta.selectionStart ?? original.length;
		const selectionEnd = this.ta.selectionEnd ?? selectionStart;
		let nextStart = selectionStart;
		let nextEnd = selectionEnd;
		let value = original;
		for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
			value = value.slice(0, replacement.start) + replacement.text + value.slice(replacement.end);
			const delta = replacement.text.length - (replacement.end - replacement.start);
			const mapPosition = (position: number): number => {
				if (position < replacement.start) return position;
				if (position > replacement.end) return position + delta;
				if (position === replacement.start) return position;
				return replacement.start + replacement.text.length;
			};
			nextStart = mapPosition(nextStart);
			nextEnd = mapPosition(nextEnd);
		}

		this.ta.value = value;
		this.ta.setSelectionRange(
			Math.max(0, Math.min(value.length, nextStart)),
			Math.max(0, Math.min(value.length, nextEnd)),
		);
		return value;
	}

	sync = (): void => {
		if (this.detached) return;
		const value = this.repairBrokenTokens();

		// Slots whose token vanished (edited away) die; their files flow back
		// to the attachment row.
		const alive = new Set<number>();
		TOKEN_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = TOKEN_RE.exec(value))) {
			alive.add(match[1].codePointAt(0)! - 0xE000);
		}
		this.slots = this.slots.filter((slot) => {
			if (alive.has(slot.id)) return true;
			this.returnFilesToAttachments(slot);
			return false;
		});

		if (!this.opts.data.getSettings().enabled) {
			this.renderMirror(value, [], []);
			this.hit.innerHTML = "";
			this.emitSnapshot();
			return;
		}

		const { kws, slots } = analyzeKeywords(value, this.activeRules(), alive);
		this.renderMirror(value, kws, slots);
		this.renderHitLayer(kws, slots);
		this.emitSnapshot();
	};

	private escape(text: string): string {
		return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	}

	private renderMirror(value: string, kws: KwRange[], slots: Array<{ start: number; end: number; slotId: number }>): void {
		let html = "";
		let pos = 0;
		const ranges: Array<{ start: number; end: number; kind: "kw" | "slot"; kw?: KwRange; slotId?: number }> = [
			...kws.map((kw) => ({ start: kw.start, end: kw.end, kind: "kw" as const, kw })),
			...slots.map((slot) => ({ start: slot.start, end: slot.end, kind: "slot" as const, slotId: slot.slotId })),
		].sort((a, b) => a.start - b.start);
		for (const range of ranges) {
			html += this.escape(value.slice(pos, range.start));
			const text = this.escape(value.slice(range.start, range.end));
			if (range.kind === "kw") {
				html += `<span class="inno-smart-kw${range.kw?.hi ? " is-hi" : ""}">${text}</span>`;
			} else {
				const slot = this.slots.find((entry) => entry.id === range.slotId);
				const width = slot ? this.tokenWidth(slot.word) : 48;
				html += `<span class="inno-smart-slot-tok" data-slot-id="${range.slotId ?? ""}" style="width:${width}px">${text}</span>`;
			}
			pos = range.end;
		}
		html += this.escape(value.slice(pos)) + "\n";
		this.mirror.innerHTML = html;
		this.mirror.style.transform = `translateY(${-this.ta.scrollTop}px)`;
	}

	private renderHitLayer(kws: KwRange[], slots: Array<{ start: number; end: number; slotId: number }>): void {
		this.hit.innerHTML = "";
		const kwSpans = Array.from(this.mirror.querySelectorAll<HTMLElement>("span.inno-smart-kw"));
		const slotSpans = Array.from(this.mirror.querySelectorAll<HTMLElement>("span.inno-smart-slot-tok"));

		let ki = 0;
		for (const kw of kws) {
			const span = kwSpans[ki++];
			if (span) this.hit.appendChild(this.makeKwHit(span, kw));
		}
		this.tokRects = [];
		let si = 0;
		for (const slotRange of slots) {
			const span = slotSpans[si++];
			const slot = this.slots.find((entry) => entry.id === slotRange.slotId);
			if (!span || !slot) continue;
			this.hit.appendChild(this.makeSlotChip(span, slot));
			this.tokRects.push({ start: slotRange.start, end: slotRange.end, x0: span.offsetLeft, x1: span.offsetLeft + span.offsetWidth });
		}
	}

	// ── token construction (DOM-probe measurement) ──────────────────────────

	private probeWidth(text: string, chip: boolean): number {
		const probe = document.createElement("span");
		probe.className = chip ? "inno-smart-chip-probe" : "inno-smart-ta-probe";
		probe.textContent = text;
		this.hit.appendChild(probe);
		const width = probe.getBoundingClientRect().width;
		probe.remove();
		return width;
	}

	private tokenWidth(word: string): number {
		return Math.max(36, this.probeWidth(word, true)) + 12;
	}

	buildToken(slot: Slot): { token: string; re: RegExp } {
		const core = `{${slotChar(slot.id)}}`;
		// NBSPs are internal caret padding only. TOKEN_RE deliberately excludes
		// ordinary spaces, so a user-entered space after the bubble stays outside
		// the token and cannot stretch it.
		const coreWidth = this.probeWidth(core, false);
		const spaceWidth = this.probeWidth("\u00A0", false) || 4.6;
		const padding = Math.max(0, Math.ceil((this.tokenWidth(slot.word) - coreWidth) / spaceWidth));
		return { token: core + "\u00A0".repeat(padding), re: tokenRegexFor(slot.id) };
	}

	// ── keyword hit zone ────────────────────────────────────────────────────

	private makeKwHit(span: HTMLElement, kw: KwRange): HTMLElement {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "inno-smart-kw-hit";
		button.style.left = `${span.offsetLeft}px`;
		button.style.top = `${span.offsetTop}px`;
		button.style.width = `${span.offsetWidth}px`;
		button.style.height = `${span.offsetHeight}px`;
		button.title = this.opts.labels().kwHitTitle;
		button.addEventListener("click", () => this.toBubble(kw));
		button.addEventListener("mouseenter", () => span.classList.add("is-hot"));
		button.addEventListener("mouseleave", () => span.classList.remove("is-hot"));

		// Drag-dwell: hover 1s while dragging a compatible file → auto-convert
		// and bind the in-hand file.
		let dwellTimer: number | null = null;
		const clearDwell = () => {
			if (dwellTimer !== null) window.clearTimeout(dwellTimer);
			dwellTimer = null;
			this.stopDwellFollower();
			span.classList.remove("is-hot");
		};
		const matchesDrag = (): boolean => {
			const meta = this.dragMeta;
			if (!meta || "bubble" in meta || meta.consumed) return false;
			return this.ruleAccepts(kw.rule, meta.type);
		};
		const autoConvert = () => {
			const meta = this.dragMeta;
			if (!meta || "bubble" in meta || !matchesDrag()) return;
			if (this.ta.value.slice(kw.start, kw.end) !== kw.word) return;
			const slot = this.toBubble(kw);
			if (slot && meta.file) {
				slot._spawn = true;
				this.bindFileToSlot(slot, meta.file);
				meta.consumed = true;
				document.body.classList.remove("inno-smart-dragging");
				this.hit.querySelectorAll(".inno-smart-chip.is-drag-match").forEach((el) => el.classList.remove("is-drag-match"));
			}
		};
		button.addEventListener("dragover", (event) => {
			if (!this.opts.data.getSettings().allowDrag || !this.dragMeta) return;
			if (!matchesDrag()) return;
			event.preventDefault();
			event.dataTransfer!.dropEffect = "move";
			if (dwellTimer !== null) return;
			span.classList.add("is-hot");
			this.startDwellFollower(KIND_COLORS[this.kindOfRule(kw.rule)]);
			dwellTimer = window.setTimeout(() => {
				clearDwell();
				autoConvert();
			}, DWELL_MS);
		});
		button.addEventListener("dragleave", clearDwell);
		button.addEventListener("drop", (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (!this.opts.data.getSettings().allowDrag || !this.dragMeta) return;
			if (!matchesDrag()) return;
			clearDwell();
			autoConvert();
		});
		return button;
	}

	private startDwellFollower(color: string): void {
		this.stopDwellFollower();
		const follower = document.createElement("div");
		follower.className = "inno-smart-dwell-follower";
		follower.style.setProperty("--smart-ct", color);
		follower.innerHTML = "<i></i>";
		document.body.appendChild(follower);
		this.dwellFollower = follower;
		this.dwellStart = performance.now();
		const bar = follower.querySelector("i")!;
		const tick = () => {
			if (!this.dwellFollower) return;
			this.dwellFollower.style.left = `${this.dragPos.x + 14}px`;
			this.dwellFollower.style.top = `${this.dragPos.y + 20}px`;
			bar.style.width = `${Math.min(100, (performance.now() - this.dwellStart) / 10)}%`;
			this.dwellRaf = requestAnimationFrame(tick);
		};
		tick();
	}

	stopDwellFollower(): void {
		cancelAnimationFrame(this.dwellRaf);
		if (this.dwellFollower) {
			this.dwellFollower.remove();
			this.dwellFollower = null;
		}
	}

	trackDragPosition(x: number, y: number): void {
		this.dragPos = { x, y };
	}

	// ── slot chips ──────────────────────────────────────────────────────────

	private kindOfRule(rule: SmartInputRule): keyof typeof KIND_COLORS {
		return kindFromName(`x${rule.extensions[0] ?? ""}`);
	}

	private ruleAccepts(rule: SmartInputRule, name: string): boolean {
		return nameMatchesExtensions(name, rule.extensions);
	}

	private makeSlotChip(span: HTMLElement, slot: Slot): HTMLElement {
		const chip = document.createElement("div");
		const count = slot.files.length;
		chip.className = `inno-smart-chip ${count ? "is-filled" : "is-empty"}`;
		if (slot._spawn) {
			chip.classList.add("is-spawn");
			slot._spawn = false;
		}
		chip.dataset.slotId = String(slot.id);
		chip.style.setProperty("--smart-bc", KIND_COLORS[this.kindOfRule(slot.rule)]);
		// Sits inside the token rect with a 6px caret seam on each side.
		chip.style.left = `${span.offsetLeft + 6}px`;
		chip.style.top = `${span.offsetTop + (span.offsetHeight - 20) / 2}px`;
		chip.style.width = `${Math.max(0, span.offsetWidth - 12)}px`;
		chip.innerHTML = `<span class="inno-smart-chip-word">${this.escape(slot.word)}</span>`;

		// The bubble itself is draggable inside the text (live repositioning;
		// drop only lands inside the textarea, cancel restores the origin).
		chip.draggable = true;
		chip.addEventListener("dragstart", (event) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest?.(".inno-smart-badge, .inno-smart-chip-x")) {
				event.preventDefault();
				return;
			}
			this.markBubbleDrag(slot, chip, event);
		});

		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "inno-smart-chip-x";
		remove.textContent = "×";
		remove.title = this.opts.labels().removeBubble;
		remove.addEventListener("click", (event) => {
			event.stopPropagation();
			this.removeSlot(slot);
		});
		chip.appendChild(remove);

		if (count > 0) {
			const badge = document.createElement("span");
			badge.className = "inno-smart-badge";
			badge.textContent = String(count);
			if (slot._bc !== count) {
				badge.classList.add("is-pop");
				slot._bc = count;
			}
			chip.appendChild(badge);
			chip.addEventListener("click", () => this.opts.callbacks.onOpenStatusPanel(slot, chip));
			// Hover 450ms auto-opens the status panel (prototype parity).
			chip.addEventListener("mouseenter", () => this.opts.callbacks.onChipHover?.(slot, chip, true));
			chip.addEventListener("mouseleave", () => this.opts.callbacks.onChipHover?.(slot, chip, false));
		} else {
			chip.title = this.opts.labels().emptyBubbleTitle;
			chip.addEventListener("click", () => this.opts.callbacks.onOpenFillMenu(slot, chip));
		}
		chip.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			this.opts.callbacks.onBubbleContextMenu(event, slot, chip);
		});

		// Drop-to-bind (+drop-ok/drop-bad feedback).
		let dropOkTimer: number | null = null;
		chip.addEventListener("dragover", (event) => {
			if (!this.opts.data.getSettings().allowDrag) return;
			const meta = this.dragMeta;
			if (!meta || ("bubble" in meta)) return;
			if (meta.consumed) return;
			if (!this.ruleAccepts(slot.rule, meta.type)) return;
			event.preventDefault();
			event.stopPropagation();
			if (dropOkTimer !== null) window.clearTimeout(dropOkTimer);
			chip.classList.add("is-drop-ok");
		});
		chip.addEventListener("dragleave", (event) => {
			if (chip.contains(event.relatedTarget as Node)) return;
			dropOkTimer = window.setTimeout(() => chip.classList.remove("is-drop-ok"), 80);
		});
		chip.addEventListener("drop", (event) => {
			event.preventDefault();
			event.stopPropagation();
			chip.classList.remove("is-drop-ok");
			if (!this.opts.data.getSettings().allowDrag) {
				this.opts.callbacks.onToast(this.opts.labels().dragDisabled, true);
				return;
			}
			const meta = this.dragMeta;
			if (meta && !("bubble" in meta) && !meta.consumed && meta.file) {
				this.bindFileToSlot(slot, meta.file);
				return;
			}
			// OS file dropped straight onto the bubble: stage it (type-checked
			// inside bindFileToSlot); it uploads at send time.
			const osFile = event.dataTransfer?.files?.[0];
			if (osFile) this.bindLocalFile(slot, osFile);
		});
		return chip;
	}

	// ── slot operations ─────────────────────────────────────────────────────

	toBubble(kw: KwRange): Slot | null {
		if (!this.opts.data.getSettings().enabled) return null;
		const slot: Slot = { id: this.nextSlotId++, word: kw.word, rule: kw.rule, files: [] };
		this.slots.push(slot);
		const { token } = this.buildToken(slot);
		this.ta.value = this.ta.value.slice(0, kw.start) + token + this.ta.value.slice(kw.end);
		this.ta.focus();
		this.ta.setSelectionRange(kw.start + token.length, kw.start + token.length);
		this.sync();
		this.opts.callbacks.onToast(this.opts.labels().bubbleCreated);
		return slot;
	}

	removeSlot(slot: Slot): void {
		const { re } = this.buildToken(slot);
		const value = this.ta.value;
		const match = re.exec(value);
		if (match) {
			const start = match.index;
			const end = start + match[0].length;
			const nextValue = value.slice(0, start) + slot.word + value.slice(end);
			const mapPosition = (position: number): number => {
				if (position <= start) return position;
				if (position >= end) return position - (end - start) + slot.word.length;
				return start + slot.word.length;
			};
			const selectionStart = this.ta.selectionStart ?? end;
			const selectionEnd = this.ta.selectionEnd ?? selectionStart;
			this.ta.value = nextValue;
			this.ta.focus();
			this.ta.setSelectionRange(mapPosition(selectionStart), mapPosition(selectionEnd));
		}
		this.returnFilesToAttachments(slot);
		this.slots = this.slots.filter((entry) => entry.id !== slot.id);
		this.ta.focus();
		this.sync();
	}

	private returnFilesToAttachments(slot: Slot): void {
		for (const file of slot.files) {
			this.opts.data.returnAttachment(
				file.source === "workspace"
					? { name: file.name, path: file.path, source: "workspace" }
					: { name: file.name, path: file.path, source: "local", file: file.file },
			);
		}
	}

	unbindAll(slot: Slot): void {
		this.returnFilesToAttachments(slot);
		slot.files = [];
		this.sync();
	}

	/** Bind one file (workspace row item or staged OS file) to a slot. */
	bindFileToSlot(slot: Slot, item: EngineAttachmentItem): void {
		if (slot.files.some((file) => file.path === item.path && file.name === item.name)) {
			this.opts.callbacks.onToast(this.opts.labels().alreadyBound, true);
			return;
		}
		if (!this.ruleAccepts(slot.rule, item.name)) {
			const chip = this.hit.querySelector<HTMLElement>(`.inno-smart-chip[data-slot-id="${slot.id}"]`);
			if (chip) {
				chip.classList.add("is-drop-bad");
				window.setTimeout(() => chip.classList.remove("is-drop-bad"), 600);
			}
			this.opts.callbacks.onToast(this.opts.labels().typeMismatch, true);
			return;
		}
		slot.files.push({
			uid: this.nextFileId++,
			name: item.name,
			path: item.path,
			source: item.source === "workspace" ? "workspace" : "upload",
			state: item.source === "workspace" ? "workspace" : "local",
			pct: item.source === "workspace" ? 100 : 0,
			file: item.file,
		});
		this.sync();
		this.opts.callbacks.onToast(this.opts.labels().bound.replace("{{name}}", item.name));
	}

	/** Bind an existing workspace file by path (fill menu / linkage pick). */
	bindWorkspaceFile(slot: Slot, path: string): void {
		const name = path.split("/").pop() ?? path;
		this.bindFileToSlot(slot, { name, path, source: "workspace" });
	}

	/** Bind a staged OS file that is not in the attachment row. */
	bindLocalFile(slot: Slot, file: File): void {
		this.bindFileToSlot(slot, {
			name: file.name,
			path: file.name.replace(/[\\/?%*:|"<>]/g, "_").trim() || `upload-${Date.now()}`,
			source: "local",
			file,
		});
	}

	removeBinding(slot: Slot, uid: number): void {
		const file = slot.files.find((entry) => entry.uid === uid);
		slot.files = slot.files.filter((entry) => entry.uid !== uid);
		if (file) {
			this.opts.data.returnAttachment(
				file.source === "workspace"
					? { name: file.name, path: file.path, source: "workspace" }
					: { name: file.name, path: file.path, source: "local", file: file.file },
			);
		}
		this.sync();
	}

	/**
	 * Insert an attachment as a pre-bound bubble at the caret. The bubble's
	 * word is the first enabled rule whose extensions accept the file.
	 */
	insertAttachmentAsBubble(item: EngineAttachmentItem): void {
		const rule = this.activeRules().find((candidate) => this.ruleAccepts(candidate, item.name));
		if (!rule) {
			this.opts.callbacks.onToast(this.opts.labels().noRuleForFile, true);
			return;
		}
		const word = rule.keyword;
		const slot: Slot = { id: this.nextSlotId++, word, rule, files: [] };
		this.slots.push(slot);
		slot.files.push({
			uid: this.nextFileId++,
			name: item.name,
			path: item.path,
			source: item.source === "workspace" ? "workspace" : "upload",
			state: item.source === "workspace" ? "workspace" : "local",
			pct: item.source === "workspace" ? 100 : 0,
			file: item.file,
		});
		const caret = this.ta.selectionStart ?? this.ta.value.length;
		const { token } = this.buildToken(slot);
		this.ta.value = this.ta.value.slice(0, caret) + token + this.ta.value.slice(caret);
		this.ta.focus();
		this.ta.setSelectionRange(caret + token.length, caret + token.length);
		this.sync();
		this.opts.callbacks.onToast(this.opts.labels().insertedAsBubble);
	}

	// ── token atomicity ─────────────────────────────────────────────────────

	private tokenRanges(): Array<[number, number, number]> {
		const out: Array<[number, number, number]> = [];
		TOKEN_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = TOKEN_RE.exec(this.ta.value))) {
			out.push([match.index, match.index + match[0].length, match[1].codePointAt(0)! - 0xE000]);
		}
		return out;
	}

	private deleteTokenSelection(selectionStart: number, selectionEnd: number, touched: Array<[number, number, number]>): void {
		const intervals = [
			[selectionStart, selectionEnd] as [number, number],
			...touched.map(([start, end]) => [start, end] as [number, number]),
		].sort((a, b) => a[0] - b[0]);
		const merged: Array<[number, number]> = [];
		for (const [start, end] of intervals) {
			const previous = merged[merged.length - 1];
			if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
			else merged.push([start, end]);
		}

		const value = this.ta.value;
		let nextValue = "";
		let cursor = 0;
		for (const [start, end] of merged) {
			nextValue += value.slice(cursor, start);
			cursor = end;
		}
		nextValue += value.slice(cursor);
		const removedIds = new Set(touched.map(([, , id]) => id));
		for (const slot of this.slots) {
			if (removedIds.has(slot.id)) this.returnFilesToAttachments(slot);
		}
		this.slots = this.slots.filter((slot) => !removedIds.has(slot.id));
		this.ta.value = nextValue;
		this.ta.focus();
		const caret = merged[0]?.[0] ?? selectionStart;
		this.ta.setSelectionRange(Math.min(caret, nextValue.length), Math.min(caret, nextValue.length));
		this.sync();
	}

	private handleBeforeInput = (event: InputEvent): void => {
		if (event.isComposing || !event.inputType.startsWith("delete")) return;
		const selectionStart = this.ta.selectionStart ?? 0;
		const selectionEnd = this.ta.selectionEnd ?? selectionStart;
		const touched = this.tokenRanges().filter(([start, end]) => {
			if (selectionStart !== selectionEnd) return selectionStart < end && selectionEnd > start;
			if (event.inputType.toLowerCase().includes("forward")) return selectionStart >= start && selectionStart < end;
			return selectionStart > start && selectionStart <= end;
		});
		if (touched.length === 0) return;

		event.preventDefault();
		if (selectionStart === selectionEnd && touched.length === 1) {
			this.removeSlotById(touched[0][2]);
			return;
		}
		this.deleteTokenSelection(selectionStart, selectionEnd, touched);
	};

	private handleKeyDown = (event: KeyboardEvent): void => {
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.isComposing || event.keyCode === 229) return;
		const selectionStart = this.ta.selectionStart ?? 0;
		const selectionEnd = this.ta.selectionEnd ?? selectionStart;
		const ranges = this.tokenRanges();
		if (selectionStart !== selectionEnd) {
			if (event.key === "Backspace" || event.key === "Delete") {
				const touched = ranges.filter(([start, end]) => selectionStart < end && selectionEnd > start);
				if (touched.length > 0) {
					event.preventDefault();
					this.deleteTokenSelection(selectionStart, selectionEnd, touched);
				}
			}
			return;
		}
		const pos = selectionStart;
		if (event.key === "ArrowLeft") {
			for (const [start, end] of ranges) {
				if (pos === end || (pos > start && pos < end)) {
					event.preventDefault();
					this.ta.setSelectionRange(start, start);
					return;
				}
			}
		} else if (event.key === "ArrowRight") {
			for (const [start, end] of ranges) {
				if (pos === start || (pos > start && pos < end)) {
					event.preventDefault();
					this.ta.setSelectionRange(end, end);
					return;
				}
			}
		} else if (event.key === "Backspace") {
			for (const [start, end, id] of ranges) {
				if (pos > start && pos <= end) {
					event.preventDefault();
					this.removeSlotById(id);
					return;
				}
			}
		} else if (event.key === "Delete") {
			for (const [start, end, id] of ranges) {
				if (pos === start || (pos > start && pos < end)) {
					event.preventDefault();
					this.removeSlotById(id);
					return;
				}
			}
		}
	};

	removeSlotById(id: number): void {
		const slot = this.slots.find((entry) => entry.id === id);
		if (slot) this.removeSlot(slot);
	}

	private snapCaretOut = (): void => {
		if (this.ta.selectionStart !== this.ta.selectionEnd) return;
		const pos = this.ta.selectionStart;
		for (const [start, end] of this.tokenRanges()) {
			if (pos > start && pos < end) {
				const target = pos <= (start + end) / 2 ? start : end;
				this.ta.setSelectionRange(target, target);
				return;
			}
		}
	};

	private handleMouseDown = (event: MouseEvent): void => {
		const mirrorRect = this.mirror.getBoundingClientRect();
		const x = event.clientX - mirrorRect.left;
		for (const rect of this.tokRects) {
			let target: number | null = null;
			if (x < rect.x0 && rect.x0 - x <= 6) target = rect.start;
			else if (x > rect.x1 && x - rect.x1 <= 6) target = rect.end;
			if (target !== null) {
				requestAnimationFrame(() => this.ta.setSelectionRange(target, target));
				return;
			}
		}
	};

	// ── bubble in-text repositioning (live preview while dragging a chip) ──

	private handleDragOver = (event: DragEvent): void => {
		this.trackDragPosition(event.clientX, event.clientY);
		const meta = this.dragMeta;
		if (!meta || !("bubble" in meta)) return;
		event.preventDefault();
		event.dataTransfer!.dropEffect = "move";
		const match = tokenRegexFor(meta.slot.id).exec(this.ta.value);
		if (!match) return;
		const start = match.index;
		const end = match.index + match[0].length;
		let pos = this.ta.selectionStart;
		if (pos >= start && pos <= end) return;
		const token = match[0];
		let value = this.ta.value.slice(0, start) + this.ta.value.slice(end);
		if (pos > end) pos -= end - start;
		this.ta.value = value.slice(0, pos) + token + value.slice(pos);
		this.sync();
	};

	private handleDrop = (event: DragEvent): void => {
		const meta = this.dragMeta;
		if (!meta || !("bubble" in meta)) return;
		event.preventDefault();
		event.stopPropagation();
		meta.dropped = true;
	};

	cancelBubbleDrag(): void {
		const meta = this.dragMeta;
		if (meta && "bubble" in meta && !meta.dropped && meta.origValue != null) {
			this.ta.value = meta.origValue;
			this.sync();
		}
		this.dragMeta = null;
		this.stopDwellFollower();
		document.body.classList.remove("inno-smart-dragging");
		this.hit.querySelectorAll(".inno-smart-chip.is-drag-match, .inno-smart-chip.is-bubble-drag").forEach((el) => el.classList.remove("is-drag-match", "is-bubble-drag"));
	}

	markDragStart(item: EngineAttachmentItem, raw: string): void {
		this.dragMeta = { type: item.name, raw, file: item };
		document.body.classList.add("inno-smart-dragging");
		for (const chip of Array.from(this.hit.querySelectorAll<HTMLElement>(".inno-smart-chip"))) {
			const slot = this.slots.find((entry) => entry.id === Number(chip.dataset.slotId));
			if (slot && this.ruleAccepts(slot.rule, item.name)) chip.classList.add("is-drag-match");
		}
	}

	markBubbleDrag(slot: Slot, chip: HTMLElement, event: DragEvent): void {
		this.dragMeta = { bubble: true, slot, origValue: this.ta.value, dropped: false };
		chip.classList.add("is-bubble-drag");
		this.ta.blur();
		const ghost = chip.cloneNode(true) as HTMLElement;
		ghost.classList.remove("is-bubble-drag");
		ghost.classList.add("is-drag-ghost");
		ghost.style.width = `${chip.offsetWidth}px`;
		document.body.appendChild(ghost);
		event.dataTransfer!.setData("text/plain", `bubble:${slot.id}`);
		event.dataTransfer!.effectAllowed = "move";
		event.dataTransfer!.setDragImage(ghost, chip.offsetWidth / 2, 10);
		setTimeout(() => ghost.remove(), 0);
	}

	// ── outgoing pipeline ───────────────────────────────────────────────────

	/** Slots as the pure builder expects them. */
	private outgoingSlots(): Map<number, { word: string; files: OutgoingFile[] }> {
		const map = new Map<number, { word: string; files: OutgoingFile[] }>();
		for (const slot of this.slots) {
			map.set(slot.id, {
				word: slot.word,
				files: slot.files.map((file) => ({
					uid: file.uid,
					name: file.name,
					path: file.path,
					state: file.state,
					file: file.file,
				})),
			});
		}
		return map;
	}

	buildOutgoing() {
		return buildOutgoingPure(this.ta.value, this.outgoingSlots());
	}

	setUploadProgress(uid: number, pct: number): void {
		for (const slot of this.slots) {
			const file = slot.files.find((entry) => entry.uid === uid);
			if (file) {
				file.state = "uploading";
				file.pct = pct;
				this.notifyPanelRefresh(slot);
				return;
			}
		}
	}

	completeUpload(uid: number, uploadedPath: string): void {
		for (const slot of this.slots) {
			const file = slot.files.find((entry) => entry.uid === uid);
			if (file) {
				file.state = "workspace";
				file.pct = 100;
				file.path = uploadedPath;
				this.sync();
				return;
			}
		}
	}

	failUpload(uid: number): void {
		for (const slot of this.slots) {
			const file = slot.files.find((entry) => entry.uid === uid);
			if (file) {
				file.state = "failed";
				file.pct = 0;
				this.notifyPanelRefresh(slot);
				return;
			}
		}
	}

	retryUpload(uid: number): void {
		for (const slot of this.slots) {
			const file = slot.files.find((entry) => entry.uid === uid);
			if (file && file.state === "failed" && file.file) {
				file.state = "local";
				file.pct = 0;
				this.sync();
				return;
			}
		}
	}

	private notifyPanelRefresh(_slot: Slot): void {
		// Cheap re-render trigger — panels read slot.files fresh each render,
		// so a plain change event keeps progress rings live without a
		// full hit-layer rebuild.
		this.opts.callbacks.onChange();
	}

	reset(): void {
		this.slots = [];
		this.sync();
	}

	/**
	 * Post-send cleanup: sent content is gone; files that could not ship
	 * (failed/staged uploads) flow back to the attachment row so the user can
	 * retry them with the next message.
	 */
	postSendCleanup(): void {
		for (const slot of this.slots) {
			for (const file of slot.files) {
				if (file.state === "workspace") continue;
				this.opts.data.returnAttachment(
					file.source === "workspace"
						? { name: file.name, path: file.path, source: "workspace" }
						: { name: file.name, path: file.path, source: "local", file: file.file },
				);
			}
		}
		this.slots = [];
		this.sync();
	}

	restoreAllTokens(): void {
		let value = this.ta.value;
		for (const slot of this.slots) {
			value = value.replace(tokenRegexFor(slot.id), slot.word);
		}
		this.ta.value = value;
	}

	/** Final bindings after uploads resolved (call once per send). */
	finalizeBindings(
		ready: Array<{ word: string; wordIndex: number; files: Array<{ uid: number; name: string; path: string }> }>,
		uploaded: Array<{ word: string; wordIndex: number; uid: number; path: string }>,
	): AttachmentBinding[] {
		const byKey = new Map<string, AttachmentBinding>();
		const keyOf = (word: string, wordIndex: number) => `${word}#${wordIndex}`;
		for (const binding of ready) {
			byKey.set(keyOf(binding.word, binding.wordIndex), {
				word: binding.word,
				wordIndex: binding.wordIndex,
				files: binding.files.map((file) => ({ path: file.path, kind: kindFromName(file.path), source: "workspace" as const })),
			});
		}
		for (const upload of uploaded) {
			const key = keyOf(upload.word, upload.wordIndex);
			const existing = byKey.get(key);
			const ref = { path: upload.path, kind: kindFromName(upload.path), source: "upload" as const };
			if (existing) existing.files.push(ref);
			else byKey.set(key, { word: upload.word, wordIndex: upload.wordIndex, files: [ref] });
		}
		return Array.from(byKey.values());
	}
}
