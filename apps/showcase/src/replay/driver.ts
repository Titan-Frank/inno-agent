import { EventEmitter } from "@inno-web/stores/event-emitter.js";
import { appStore } from "@inno-web/stores/app-store.js";
import { chatStore } from "@inno-web/stores/chat-store.js";
import { learnerStore } from "@inno-web/stores/learner-store.js";
import { notebookStore } from "@inno-web/stores/notebook-store.js";
import { sessionsStore } from "@inno-web/stores/sessions-store.js";
import { workspaceStore } from "@inno-web/stores/workspace-store.js";
import type { CaseDoc } from "../cases.js";
import { fetchCase } from "../cases.js";
import { mockBackend } from "../mock/runtime.js";

const SPEEDS = [1, 2, 4] as const;
type Speed = (typeof SPEEDS)[number];

// Reveal pacing: honor the real time gap between messages, clamped so short
// bursts stay readable and long thinking gaps don't bore the viewer.
const MIN_STEP_MS = 350;
const MAX_STEP_MS = 2500;
const FIRST_STEP_MS = 400;

interface ReplayDriverEvents {
	change: void;
}

/**
 * Drives a recorded case through the REAL product stores: each step appends
 * one more message to chatStore (the real ChatCenter renders it) and, when a
 * panel keyframe is crossed, nudges the workspace/notebook/learner stores to
 * reload — the mock backend answers as-of the new step, so the right panel
 * updates in sync with the conversation, exactly like a live session.
 */
export class ReplayDriver extends EventEmitter<ReplayDriverEvents> {
	caseId: string | null = null;
	doc: CaseDoc | null = null;
	step = 0;
	playing = false;
	speed: Speed = 2;

	private timer: ReturnType<typeof setTimeout> | null = null;
	private attachRequestId = 0;
	private lastWsCount = -1;
	private lastWikiCount = -1;
	private lastProfileVisible = false;
	private autoOpenedTabs = new Set<string>();

	constructor() {
		super();
		// The real SessionSidebar opens sessions through sessionsStore; treat
		// every newly-opened session as "attach this case to the driver".
		sessionsStore.on("change", () => {
			const id = sessionsStore.currentSessionId;
			if (id && id !== this.caseId) void this.attach(id);
		});
	}

	get total(): number {
		return this.doc?.messages.length ?? 0;
	}

	get finished(): boolean {
		return this.doc !== null && this.step >= this.total;
	}

	private stepDelay(nextStep: number): number {
		if (!this.doc) return FIRST_STEP_MS;
		if (nextStep <= 0) return FIRST_STEP_MS / this.speed;
		const prev = this.doc.messages[nextStep - 1]?.timestamp ?? 0;
		const curr = this.doc.messages[nextStep]?.timestamp ?? prev;
		const gap = Math.max(0, curr - prev);
		return Math.min(MAX_STEP_MS, Math.max(MIN_STEP_MS, gap)) / this.speed;
	}

	async attach(caseId: string): Promise<void> {
		const requestId = ++this.attachRequestId;
		this.stopTimer();
		this.playing = false;
		this.step = 0;
		this.doc = null;
		this.lastWsCount = -1;
		this.lastWikiCount = -1;
		this.lastProfileVisible = false;
		this.autoOpenedTabs.clear();
		this.caseId = caseId;
		mockBackend.setCurrent(caseId, 0);
		this.emit("change", undefined);

		try {
			const loaded = await fetchCase(caseId);
			if (requestId !== this.attachRequestId) return;
			mockBackend.registerDoc(loaded);
			this.doc = loaded;
			this.applyStep(0);
			this.play();
		} catch (err) {
			console.error(`[showcase] failed to load case ${caseId}`, err);
		}
		this.emit("change", undefined);
	}

	/** Push the replay to step i: chat history prefix + panel store reloads. */
	private applyStep(i: number): void {
		const doc = this.doc;
		if (!doc || !this.caseId) return;
		mockBackend.setCurrent(this.caseId, i);
		chatStore.loadHistory(doc.messages.slice(0, i), this.caseId);

		const ws = doc.panels.workspace;
		const wsCount = ws ? ws.initial.length + ws.keyframes.filter((k) => k.atMessage < i).length : 0;
		const crossedWs = this.lastWsCount >= 0 && wsCount > this.lastWsCount && this.step < i;
		if (wsCount !== this.lastWsCount) {
			this.lastWsCount = wsCount;
			if (workspaceStore.activeWorkspaceId) void workspaceStore.loadTree();
			if (crossedWs) this.autoOpenPanel("preview");
		}

		const wikiCount = doc.panels.wiki.keyframes.filter((k) => k.atMessage < i).length;
		const crossedWiki = this.lastWikiCount >= 0 && wikiCount > this.lastWikiCount && this.step < i;
		if (wikiCount !== this.lastWikiCount) {
			this.lastWikiCount = wikiCount;
			void notebookStore.loadAll();
			if (crossedWiki) this.autoOpenPanel("notebook");
		}

		const profileVisible = doc.panels.profile.firstEventAt !== null && i > doc.panels.profile.firstEventAt;
		const crossedProfile = profileVisible && !this.lastProfileVisible && this.step < i;
		if (profileVisible !== this.lastProfileVisible) {
			this.lastProfileVisible = profileVisible;
			void learnerStore.load();
			if (crossedProfile) this.autoOpenPanel("profile");
		}

		this.step = i;
		this.emit("change", undefined);
	}

	/** Reveal the right panel for a fresh keyframe, mimicking how the product
	 *  opens the workspace preview when the agent writes files. Opens a
	 *  collapsed panel; when the panel is already open, switches the active
	 *  tab once per panel type so the viewer sees each 联动 exactly once —
	 *  after that first reveal the viewer's own tab choice is respected. */
	private autoOpenPanel(tab: "preview" | "notebook" | "profile"): void {
		if (this.autoOpenedTabs.has(tab)) return;
		this.autoOpenedTabs.add(tab);
		if (appStore.workspaceMode === "collapsed") {
			appStore.setWorkspaceMode("half");
			appStore.setWorkspaceWidth(560);
		}
		appStore.setRightPanelTab(tab);
	}

	private stopTimer(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private scheduleNext(): void {
		this.stopTimer();
		if (!this.playing || !this.doc || this.step >= this.total) return;
		this.timer = setTimeout(() => {
			this.applyStep(this.step + 1);
			this.scheduleNext();
		}, this.stepDelay(this.step));
	}

	play(): void {
		if (!this.doc) return;
		if (this.finished) this.applyStep(0);
		this.playing = true;
		this.emit("change", undefined);
		this.scheduleNext();
	}

	pause(): void {
		this.playing = false;
		this.stopTimer();
		this.emit("change", undefined);
	}

	toggle(): void {
		if (this.playing) this.pause();
		else this.play();
	}

	restart(): void {
		this.applyStep(0);
		this.play();
	}

	seek(i: number): void {
		this.pause();
		this.applyStep(Math.max(0, Math.min(i, this.total)));
	}

	skipToEnd(): void {
		this.seek(this.total);
	}

	cycleSpeed(): void {
		this.speed = SPEEDS[(SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length];
		if (this.playing) this.scheduleNext();
		this.emit("change", undefined);
	}
}

export const replayDriver = new ReplayDriver();
