import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ChangeEvent,
	type ClipboardEvent,
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { InnoModelInfo } from "../types/settings.js";
import { chatStore } from "../stores/chat-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { workspaceStore } from "../stores/workspace-store.js";
import { settingsStore } from "../stores/settings-store.js";
import { appStore } from "../stores/app-store.js";
import type { CreateSessionInput } from "../api/sessions.js";
import { bindSessionWorkspace } from "../api/workspaces.js";
import { ApiError } from "../api/client.js";
import type { PresetMeta } from "../types/presets.js";
import { arrayBufferToBase64 } from "../api/uploads.js";
import { uploadWorkspaceFileWithProgress } from "../api/workspace.js";
import type { AttachmentRef } from "../types/chat.js";
import { fetchPresetList, readCachedPresets, removeCachedPreset } from "../utils/preset-cache.js";
import { useStoreSnapshot } from "./hooks.js";
import { ChatComposer } from "./chat/ChatComposer.js";
import { ChatConversation } from "./chat/ChatConversation.js";
import { BusyBlocker, QuestionHint } from "./chat/ChatStatusBanners.js";
import { ChatUploadChips } from "./chat/ChatUploadChips.js";
import { ChatWelcome } from "./chat/ChatWelcome.js";
import { WorkspaceContext } from "./chat/WorkspaceContext.js";
import type { WorkspaceChoice } from "./WorkspaceSwitcher.js";
import {
	flattenWorkspaceFiles,
	isLargeTextPaste,
	localPendingUpload,
	prepareInlineImage,
	resizeComposerTextarea,
	workspacePendingUpload,
	type PendingPasteBlock,
	type PendingUpload,
	type PreparedInlineImage,
} from "./chat/composer-utils.js";
import { kindFromName } from "./chat/smart-input/kinds.js";
import type { EngineAttachmentItem } from "./chat/smart-input/engine.js";
import { useSmartInput } from "./chat/smart-input/useSmartInput.js";
import { SmartInputOverlay, type SmartPanelState } from "./chat/smart-input/SmartInputOverlay.js";

type PresetRefreshStatus = "success" | "error";


type WsMode = "temp" | "new" | "existing";

// Remember the user's last workspace choice for a new chat so the bottom
// "新建对话" button doesn't always reset to temp.
const LAST_WS_MODE_KEY = "inno.lastWorkspaceMode";
const LAST_WS_ID_KEY = "inno.lastWorkspaceId";

interface ChatCenterProps {
	onOpenPresetPanels: () => void | Promise<void>;
}

function readLastWsMode(): WsMode {
	if (typeof window === "undefined") return "temp";
	const value = window.localStorage.getItem(LAST_WS_MODE_KEY);
	return value === "new" || value === "existing" ? value : "temp";
}

function readLastWsId(): string {
	if (typeof window === "undefined") return "";
	return window.localStorage.getItem(LAST_WS_ID_KEY) ?? "";
}

function rememberWsChoice(mode: WsMode, existingId: string): void {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(LAST_WS_MODE_KEY, mode === "existing" ? "existing" : "temp");
	if (mode === "existing" && existingId) window.localStorage.setItem(LAST_WS_ID_KEY, existingId);
}

export function ChatCenter({ onOpenPresetPanels }: ChatCenterProps) {
	const { t } = useTranslation();
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const welcomeLayoutRef = useRef<HTMLDivElement | null>(null);
	const welcomeComposerBaseHeightRef = useRef<number | null>(null);
	const draftRef = useRef("");
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const imageInputRef = useRef<HTMLInputElement | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const shouldStickToBottomRef = useRef(true);
	const userScrollGestureRef = useRef(false);
	const pasteBlockIdRef = useRef(0);
	const [uploads, setUploads] = useState<PendingUpload[]>([]);
	const [isUploading, setIsUploading] = useState(false);
	const [attachMenuOpen, setAttachMenuOpen] = useState(false);
	const [smartToast, setSmartToast] = useState<{ message: string; error?: boolean } | null>(null);
	const [smartHasSlots, setSmartHasSlots] = useState(false);
	const [smartPanel, setSmartPanel] = useState<SmartPanelState | null>(null);
	const smartToastTimer = useRef<number | null>(null);
	const smartHoverTimer = useRef<number | null>(null);
	const smartHoverCloseTimer = useRef<number | null>(null);
	const mirrorRef = useRef<HTMLDivElement | null>(null);
	const hitRef = useRef<HTMLDivElement | null>(null);
	const uploadsRef = useRef<PendingUpload[]>([]);
	uploadsRef.current = uploads;
	const [inlineImages, setInlineImages] = useState<PreparedInlineImage[]>([]);
	const [draftValue, setDraftValue] = useState(draftRef.current);
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	const [pasteBlocks, setPasteBlocks] = useState<PendingPasteBlock[]>([]);

	// New-chat workspace selection is draft state until the first message creates
	// a session. The active session path is bound in handleWorkspaceChange.
	const [wsMode, setWsMode] = useState<WsMode>(() => readLastWsMode());
	const [wsName, setWsName] = useState("");
	const [wsExistingId, setWsExistingId] = useState(() => readLastWsId());
	const [wsError, setWsError] = useState("");
	const [isSwitchingWorkspace, setIsSwitchingWorkspace] = useState(false);

	const simpleMode = useStoreSnapshot(settingsStore, () => settingsStore.settings?.simpleMode?.enabled === true);
	const modelState = useStoreSnapshot(settingsStore, () => {
		const settings = settingsStore.settings;
		const models = settings?.availableModels ?? settings?.configuredModels ?? [];
		const current = models.find((model) => model.provider === settings?.defaultProvider && model.id === settings?.defaultModel);
		return {
			models,
			defaultProvider: settings?.defaultProvider ?? "",
			defaultModel: settings?.defaultModel ?? "",
			currentModelSupportsNativeImages: current?.input.includes("image") ?? true,
			isSavingModel: settingsStore.isSavingModel,
		};
	});
	const modelOptions = useMemo(() => {
		const seen = new Set<string>();
		return modelState.models.filter((model) => {
			const key = `${model.provider}:${model.id}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}, [modelState.models]);
	const currentModel = modelOptions.find((model) => model.provider === modelState.defaultProvider && model.id === modelState.defaultModel);

	const [presets, setPresets] = useState<PresetMeta[]>(() => readCachedPresets() ?? []);
	const [presetsLoaded, setPresetsLoaded] = useState(() => readCachedPresets() !== null);
	const [isLoadingPresets, setIsLoadingPresets] = useState(() => readCachedPresets() === null);
	const [isRefreshingPresets, setIsRefreshingPresets] = useState(false);
	const [presetsRefreshError, setPresetsRefreshError] = useState<string | null>(null);
	const [presetRefreshStatus, setPresetRefreshStatus] = useState<PresetRefreshStatus | null>(null);
	const presetRefreshStatusTimerRef = useRef<number | null>(null);
	const presetAutoRefreshStartedRef = useRef(false);
	const [openingPresetId, setOpeningPresetId] = useState<string | null>(null);
	const [togglingMode, setTogglingMode] = useState(false);
	const [presetQuery, setPresetQuery] = useState("");

	const cancelPresetRefreshStatusTimer = useCallback(() => {
		if (presetRefreshStatusTimerRef.current === null) return;
		window.clearTimeout(presetRefreshStatusTimerRef.current);
		presetRefreshStatusTimerRef.current = null;
	}, []);

	const showPresetRefreshStatus = useCallback((status: PresetRefreshStatus) => {
		cancelPresetRefreshStatusTimer();
		setPresetRefreshStatus(status);
		// Keep the failure marker visible until the next refresh attempt. A
		// successful refresh remains a transient confirmation for five seconds.
		if (status !== "success") return;
		presetRefreshStatusTimerRef.current = window.setTimeout(() => {
			setPresetRefreshStatus(null);
			presetRefreshStatusTimerRef.current = null;
		}, 5_000);
	}, [cancelPresetRefreshStatusTimer]);

	useEffect(() => () => cancelPresetRefreshStatusTimer(), [cancelPresetRefreshStatusTimer]);

	const chat = useStoreSnapshot(chatStore, () => ({
		messages: chatStore.messages,
		isSending: chatStore.isSending,
		isLoadingHistory: chatStore.isLoadingHistory,
		streamingActivity: chatStore.streamingActivity,
		streamingActivityDetail: chatStore.streamingActivityDetail,
		streamingError: chatStore.streamingError,
		canReconnect: chatStore.canReconnect,
		activeTools: chatStore.activeTools,
		completedTools: chatStore.completedTools,
		lastUserPrompt: chatStore.lastUserPrompt,
		pendingQuestion: chatStore.pendingQuestion,
	}));
	const sessions = useStoreSnapshot(sessionsStore, () => ({
		currentSessionId: sessionsStore.currentSessionId,
		preselectedWorkspaceId: sessionsStore.preselectedWorkspaceId,
		busyBlocker: sessionsStore.busyBlocker,
		isWelcome: sessionsStore.isWelcomeView,
	}));
	const workspaces = useStoreSnapshot(workspacesStore, () => ({
		list: workspacesStore.workspaces,
	}));
	const loadedPresetIds = useMemo(
		() => new Set(
			workspaces.list
				.filter((workspace) => workspace.id.startsWith("preset-"))
				.map((workspace) => workspace.id.slice("preset-".length)),
		),
		[workspaces.list],
	);
	// Active workspace for the current session — drives upload target + button
	// availability. Synced by sessionsStore on openSession/createSession, and
	// pre-seeded by the useEffect below when the welcome screen's "existing"
	// workspace picker selects one.
	const activeWorkspaceId = useStoreSnapshot(workspaceStore, () => workspaceStore.activeWorkspaceId);
	const workspaceTree = useStoreSnapshot(workspaceStore, () => workspaceStore.tree);
	const workspaceFiles = useMemo(() => workspaceTree ? flattenWorkspaceFiles(workspaceTree) : [], [workspaceTree]);
	const isWelcome = sessions.isWelcome;

	const selectableWorkspaces = useMemo(
		() => workspaces.list.filter((workspace) => !workspace.isTemp && !workspace.id.startsWith("channel-")),
		[workspaces.list],
	);

	const toggleMode = useCallback(() => {
		if (togglingMode) return;
		const next = !(settingsStore.settings?.simpleMode?.enabled === true);
		setTogglingMode(true);
		void settingsStore.saveSimpleMode(next).finally(() => setTogglingMode(false));
	}, [togglingMode]);

	const closeModelPicker = useCallback(() => setModelPickerOpen(false), []);
	const toggleModelPicker = useCallback(() => setModelPickerOpen((open) => !open), []);
	const handleModelSelect = useCallback((model: InnoModelInfo) => {
		setModelPickerOpen(false);
		if (model.provider === modelState.defaultProvider && model.id === modelState.defaultModel) return;
		void settingsStore.switchModel(model.provider, model.id);
	}, [modelState.defaultModel, modelState.defaultProvider]);
	const openModelSettings = useCallback(() => {
		setModelPickerOpen(false);
		appStore.openSettings("models");
	}, []);

	const handleWorkspaceChange = useCallback(async (choice: WorkspaceChoice) => {
		setWsError("");
		if (isWelcome) {
			if (choice.kind === "temp") {
				setWsMode("temp");
				setWsName("");
				setWsExistingId("");
			} else if (choice.kind === "workspace") {
				setWsMode("existing");
				setWsExistingId(choice.workspaceId);
				setWsName("");
			} else {
				setWsMode("new");
				setWsName(choice.name);
				setWsExistingId("");
			}
			return;
		}

		const sessionId = sessions.currentSessionId;
		if (!sessionId) return;
		if (chat.isSending || isUploading) {
			setWsError(t("chat.workspaceBusy"));
			return;
		}

		setIsSwitchingWorkspace(true);
		try {
			let workspaceId: string;
			if (choice.kind === "workspace") {
				workspaceId = choice.workspaceId;
			} else if (choice.kind === "new") {
				workspaceId = (await workspacesStore.create({ name: choice.name, isTemp: false })).id;
			} else {
				const tempWorkspace = workspaces.list.find((workspace) => workspace.isTemp);
				if (!tempWorkspace) throw new Error(t("chat.workspaceUnavailable"));
				workspaceId = tempWorkspace.id;
			}

			if (workspaceId !== activeWorkspaceId) {
				await bindSessionWorkspace(sessionId, workspaceId);
				await workspaceStore.setActiveWorkspace(workspaceId);
			}
			await workspacesStore.load();
		} catch (error) {
			setWsError(error instanceof Error ? error.message : t("chat.workspaceSwitchFailed"));
		} finally {
			setIsSwitchingWorkspace(false);
		}
	}, [activeWorkspaceId, chat.isSending, isUploading, isWelcome, sessions.currentSessionId, t, workspaces.list]);

	const uploadWorkspaceId: string | undefined | null = isWelcome
		? (simpleMode || wsMode === "temp"
			? undefined
			: wsMode === "existing" && wsExistingId
				? wsExistingId
				: null)
		: activeWorkspaceId;
	const hasSendableContent = Boolean(
		draftValue.trim()
			|| pasteBlocks.some((block) => block.text.trim())
			|| uploads.some((upload) => upload.status !== "failed")
			|| inlineImages.length > 0
			|| smartHasSlots,
	);

	useEffect(() => {
		if (isWelcome && workspaces.list.length === 0) void workspacesStore.load();
	}, [isWelcome, workspaces.list.length]);

	useEffect(() => {
		if (wsMode === "existing" && wsExistingId && workspaces.list.length > 0) {
			if (!selectableWorkspaces.some((workspace) => workspace.id === wsExistingId)) {
				setWsMode("temp");
				setWsExistingId("");
			}
		}
	}, [wsMode, wsExistingId, workspaces.list.length, selectableWorkspaces]);

	useEffect(() => {
		if (sessions.preselectedWorkspaceId) {
			setWsMode("existing");
			setWsExistingId(sessions.preselectedWorkspaceId);
		}
	}, [sessions.preselectedWorkspaceId]);

	useEffect(() => {
		if (isWelcome && wsMode === "existing" && wsExistingId) {
			void workspaceStore.setActiveWorkspace(wsExistingId);
			appStore.setRightPanelTab("preview");
			if (appStore.workspaceMode === "collapsed" && sessions.preselectedWorkspaceId === wsExistingId) {
				appStore.setWorkspaceWidth(300);
				appStore.setWorkspaceMode("quarter");
			}
		}
	}, [isWelcome, wsMode, wsExistingId, sessions.preselectedWorkspaceId]);

	useEffect(() => {
		const el = scrollRef.current;
		const content = el?.querySelector<HTMLElement>("[data-conversation-content]");
		if (!el || !content) return;
		const observer = new ResizeObserver(() => {
			if (shouldStickToBottomRef.current) el.scrollTop = el.scrollHeight;
		});
		observer.observe(content);
		return () => observer.disconnect();
	}, [sessions.currentSessionId]);

	useEffect(() => {
		shouldStickToBottomRef.current = true;
	}, [sessions.currentSessionId]);

	const markUserScrollGesture = useCallback(() => {
		userScrollGestureRef.current = true;
	}, []);
	const handleScrollerPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
		const el = scrollRef.current;
		if (el && event.clientX >= el.getBoundingClientRect().right - 24) markUserScrollGesture();
	}, [markUserScrollGesture]);
	const handleChatScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		if (distanceFromBottom < 96) {
			shouldStickToBottomRef.current = true;
			userScrollGestureRef.current = false;
			return;
		}
		if (!userScrollGestureRef.current) return;
		userScrollGestureRef.current = false;
		shouldStickToBottomRef.current = false;
	}, []);
	const pauseAutoScroll = useCallback(() => {
		shouldStickToBottomRef.current = false;
	}, []);

	const resizeInput = useCallback(() => {
		const el = inputRef.current;
		if (!el) return;
		const minHeight = resizeComposerTextarea(el);
		const welcomeLayout = welcomeLayoutRef.current;
		if (!welcomeLayout) return;
		const composer = el.closest<HTMLElement>(".inno-composer");
		if (!composer) return;
		const textareaHeight = el.getBoundingClientRect().height;
		const composerHeight = composer.getBoundingClientRect().height;
		if (welcomeComposerBaseHeightRef.current === null) {
			welcomeComposerBaseHeightRef.current = composerHeight - textareaHeight + minHeight;
		}
		const composerGrowth = Math.max(0, composerHeight - welcomeComposerBaseHeightRef.current);
		welcomeLayout.style.setProperty("--inno-welcome-composer-half-growth", `${composerGrowth / 2}px`);
	}, []);

	useEffect(() => {
		welcomeComposerBaseHeightRef.current = null;
		const el = inputRef.current;
		if (!el) return;
		resizeInput();
		if (typeof ResizeObserver === "undefined") return;
		let lastWidth = Math.round(el.getBoundingClientRect().width);
		const observer = new ResizeObserver(([entry]) => {
			const nextWidth = Math.round(entry.contentRect.width);
			if (nextWidth === lastWidth) return;
			lastWidth = nextWidth;
			resizeInput();
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [isWelcome, resizeInput]);

	useEffect(() => {
		if (isWelcome) resizeInput();
	}, [isWelcome, inlineImages, pasteBlocks, resizeInput]);

	const isComposingRef = useRef(false);

	const handleInput = useCallback(() => {
		const el = inputRef.current;
		if (!el) return;
		draftRef.current = el.value;
		setDraftValue(el.value);
		// Safari drops in-progress IME composition (e.g. Chinese/Japanese input)
		// when the textarea's height/overflow/selection is mutated mid-composition,
		// which is what resizeInput does. Defer the resize until compositionend.
		if (isComposingRef.current) return;
		resizeInput();
	}, [resizeInput]);

	const handleCompositionStart = useCallback(() => {
		isComposingRef.current = true;
	}, []);

	const handleCompositionEnd = useCallback(() => {
		isComposingRef.current = false;
		resizeInput();
	}, [resizeInput]);

	// ── Smart input engine (便捷输入) ─────────────────────────────────────
	const smartSettings = useStoreSnapshot(settingsStore, () => settingsStore.settings?.smartInput);
	const smartInputEnabled = smartSettings?.enabled === true;

	const showSmartToast = useCallback((message: string, error?: boolean) => {
		setSmartToast({ message, error });
		if (smartToastTimer.current !== null) window.clearTimeout(smartToastTimer.current);
		smartToastTimer.current = window.setTimeout(() => setSmartToast(null), 2200);
	}, []);
	useEffect(() => () => {
		if (smartToastTimer.current !== null) window.clearTimeout(smartToastTimer.current);
	}, []);

	const takeAttachment = useCallback((path: string): EngineAttachmentItem | undefined => {
		const item = uploadsRef.current.find((entry) => entry.path === path || entry.fileName === path);
		if (!item) return undefined;
		setUploads((current) => current.filter((entry) => entry !== item));
		return { name: item.fileName, path: item.path, source: item.source, file: item.file };
	}, []);

	const returnAttachment = useCallback((item: EngineAttachmentItem) => {
		setUploads((current) => {
			if (current.some((entry) => entry.path === item.path && entry.source === item.source)) return current;
			return [...current, item.source === "workspace"
				? workspacePendingUpload(item.path)
				: { fileName: item.name, path: item.path, source: "local", status: "ready", pct: 0, file: item.file }];
		});
	}, []);

	const handleSmartChange = useCallback(() => {
		const el = inputRef.current;
		if (!el) return;
		draftRef.current = el.value;
		setDraftValue(el.value);
		resizeInput();
	}, [resizeInput]);

	const rectOfChip = (chip: HTMLElement): SmartPanelState["anchor"] => {
		const rect = chip.getBoundingClientRect();
		return { left: rect.left, bottom: rect.bottom };
	};

	const openSmartPanel = useCallback((kind: SmartPanelState["kind"], slot: { id: number }, chip: HTMLElement) => {
		setSmartPanel({ kind, slotId: slot.id, anchor: rectOfChip(chip) });
	}, []);

	const handleChipHover = useCallback((slot: { id: number; files: unknown[] }, chip: HTMLElement, entering: boolean) => {
		if (smartHoverCloseTimer.current !== null) {
			window.clearTimeout(smartHoverCloseTimer.current);
			smartHoverCloseTimer.current = null;
		}
		if (entering) {
			if (smartHoverTimer.current !== null) return;
			smartHoverTimer.current = window.setTimeout(() => {
				smartHoverTimer.current = null;
				openSmartPanel("status", slot, chip);
			}, 450);
			return;
		}
		if (smartHoverTimer.current !== null) {
			window.clearTimeout(smartHoverTimer.current);
			smartHoverTimer.current = null;
		}
		// Left the chip: if the status panel for this slot is open but the
		// pointer did not move onto it, close it shortly (panel parity).
		smartHoverCloseTimer.current = window.setTimeout(() => {
			smartHoverCloseTimer.current = null;
			const overPanel = document.querySelector(".inno-smart-panel:hover");
			const overChip = document.querySelector(".inno-smart-chip:hover");
			if (!overPanel && !overChip) setSmartPanel(null);
		}, 260);
	}, [openSmartPanel]);

	const highlightWorkspace = useCallback((paths: string[] | null) => {
		window.dispatchEvent(new CustomEvent("inno-smart-highlight", { detail: paths }));
	}, []);

	const engineRef = useSmartInput({
		enabled: smartInputEnabled,
		remountKey: isWelcome ? "welcome" : "session",
		textareaRef: inputRef,
		mirrorRef,
		hitRef,
		getSettings: () => smartSettings,
		getWorkspaceFiles: () => workspaceFiles,
		takeAttachment,
		returnAttachment,
		onToast: showSmartToast,
		onChange: handleSmartChange,
		onSnapshot: (snapshot) => setSmartHasSlots(snapshot.slotCount > 0),
		onOpenStatusPanel: (slot, chip) => openSmartPanel("status", slot, chip),
		onOpenFillMenu: (slot, chip) => openSmartPanel("fill", slot, chip),
		onBubbleContextMenu: (event, slot, chip) => {
			const rect = chip.getBoundingClientRect();
			setSmartPanel({ kind: "menu", slotId: slot.id, anchor: { left: rect.left, bottom: rect.bottom }, x: event.clientX, y: event.clientY });
		},
		onChipHover: handleChipHover,
		onWorkspaceHighlight: highlightWorkspace,
	});

	const buildSessionInput = useCallback((): CreateSessionInput | { __error: string } => {
		if (simpleMode || wsMode === "temp") return { newWorkspace: { isTemp: true } };
		if (wsMode === "new") {
			const trimmed = wsName.trim();
			if (!trimmed) return { __error: t("chat.errWsName") };
			return { newWorkspace: { name: trimmed, isTemp: false } };
		}
		if (!wsExistingId) return { __error: t("chat.errWsSelect") };
		return { workspaceId: wsExistingId };
	}, [simpleMode, wsMode, wsName, wsExistingId, t]);

	const loadPresets = useCallback(async (forceRefresh = false) => {
		setPresetsRefreshError(null);
		if (forceRefresh) {
			cancelPresetRefreshStatusTimer();
			setPresetRefreshStatus(null);
		}
		if (!forceRefresh) {
			const cached = readCachedPresets();
			if (cached !== null) {
				setPresets(cached);
				setPresetsLoaded(true);
				setIsLoadingPresets(false);
				return;
			}
		}
		if (forceRefresh) {
			setIsRefreshingPresets(true);
		} else {
			setIsLoadingPresets(true);
		}
		try {
			const next = await fetchPresetList(forceRefresh);
			setPresets(next);
			setPresetsLoaded(true);
			if (forceRefresh) {
				showPresetRefreshStatus("success");
			}
		} catch {
			// Keep the last successful list visible and avoid leaking transport
			// details such as the English "fetch failed" into the localized UI.
			setPresetsRefreshError(t("presets.refreshFailed"));
			showPresetRefreshStatus("error");
		} finally {
			setIsLoadingPresets(false);
			setIsRefreshingPresets(false);
		}
	}, [cancelPresetRefreshStatusTimer, showPresetRefreshStatus, t]);

	// Refresh the preset catalog once when the app first opens in Simple Mode.
	// ChatCenter stays mounted across session changes, so this also works when
	// the app restores an existing session instead of showing the welcome view.
	// Cached cards render immediately; the forced request updates them in the
	// background and reuses the same success/error indicator as manual refresh.
	useEffect(() => {
		if (!simpleMode || presetAutoRefreshStartedRef.current) return;
		presetAutoRefreshStartedRef.current = true;
		void loadPresets(true);
	}, [simpleMode, loadPresets]);

	const openPreset = useCallback((presetId: string) => {
		setWsError("");
		setOpeningPresetId(presetId);
		void (async () => {
			try {
				await Promise.all([
					sessionsStore.createSessionWith({ presetId }),
					onOpenPresetPanels(),
				]);
			} catch (err) {
				const unavailable = err instanceof ApiError
					&& err.status === 404
					&& err.data?.code === "PRESET_UNAVAILABLE";
				if (unavailable) {
					setPresets((current) => current.filter((preset) => preset.id !== presetId));
					removeCachedPreset(presetId);
				} else {
					setWsError(err instanceof Error ? err.message : t("chat.errOpenPreset"));
				}
			} finally {
				setOpeningPresetId(null);
			}
		})();
	}, [onOpenPresetPanels, t]);

	const handleSend = useCallback(() => {
		const engine = engineRef.current;
		const outgoing = engine ? engine.buildOutgoing() : null;
		// Smart input active → the visible text already has tokens restored to
		// their plain words; word indices were computed against exactly this text.
		const rawValue = outgoing ? outgoing.visibleText : inputRef.current?.value ?? draftValue;
		const input = [rawValue.trim(), ...pasteBlocks.map((block) => block.text.trim())].filter(Boolean).join("\n\n");
		if ((!input && uploads.length === 0 && inlineImages.length === 0) || chat.isSending || isUploading) return;
		shouldStickToBottomRef.current = true;
		const pendingUploads = [...uploads];
		const pendingImages = [...inlineImages];

		const resetComposer = () => {
			draftRef.current = "";
			setDraftValue("");
			if (inputRef.current) {
				inputRef.current.value = "";
				resizeInput();
			}
			setPasteBlocks([]);
		};

		void (async () => {
			setIsUploading(true);
			try {
				let targetSessionId = sessions.currentSessionId;
				if (isWelcome) {
					const wsInput = buildSessionInput();
					if ("__error" in wsInput) {
						setWsError(wsInput.__error);
						return;
					}
					setWsError("");
					if (!simpleMode) rememberWsChoice(wsMode, wsExistingId);
					await sessionsStore.createSessionWith(wsInput);
					targetSessionId = sessionsStore.currentSessionId;
				}

				const targetWorkspaceId = workspaceStore.activeWorkspaceId ?? (isWelcome ? undefined : uploadWorkspaceId ?? undefined);
				const toUpload = pendingUploads.filter((item) => item.source === "local" && item.status !== "failed" && item.file);
				const enginePending = outgoing?.pendingFiles ?? [];
				if ((toUpload.length > 0 || enginePending.length > 0) && targetWorkspaceId === undefined) throw new Error(t("chat.uploadHint"));

				// Local files upload one-by-one with real byte progress; failures
				// stay in the attachment row as retryable instead of blocking the
				// message. Workspace files are already on the server — no upload.
				const loose: AttachmentRef[] = [];
				const failedNames: string[] = [];
				for (const item of pendingUploads) {
					if (item.source === "workspace") {
						loose.push({ path: item.path, kind: kindFromName(item.path), source: "workspace" });
						continue;
					}
					if (!item.file || item.status === "failed") {
						if (item.status === "failed") failedNames.push(item.fileName);
						continue;
					}
					const key = item.path;
					const patch = (patchItem: Partial<PendingUpload>) => setUploads((current) =>
						current.map((entry) => entry.path === key && entry.source === "local" ? { ...entry, ...patchItem } : entry));
					patch({ status: "uploading", pct: 0 });
					try {
						const dataBase64 = arrayBufferToBase64(await item.file.arrayBuffer());
						const node = await uploadWorkspaceFileWithProgress(
							{ path: item.path, dataBase64 },
							targetWorkspaceId,
							(loaded, total) => patch({ pct: total > 0 ? Math.min(100, (loaded / total) * 100) : 0 }),
						);
						loose.push({ path: node.path, kind: kindFromName(node.path), source: "upload" });
						patch({ status: "ready", pct: 100, path: node.path });
					} catch {
						patch({ status: "failed", pct: 0 });
						failedNames.push(item.fileName);
					}
				}

				// Local files bound to keyword bubbles upload through the same
				// per-file pipeline; successes fold back into their bindings,
				// failures stay retryable and skip this message.
				const uploadedForBindings: Array<{ word: string; wordIndex: number; uid: number; path: string }> = [];
				let engineSkipped = 0;
				if (engine && outgoing) {
					for (const pending of outgoing.pendingFiles) {
						const uid = pending.file.uid;
						engine.setUploadProgress(uid, 0);
						try {
							const dataBase64 = arrayBufferToBase64(await pending.file.file.arrayBuffer());
							const node = await uploadWorkspaceFileWithProgress(
								{ path: pending.file.path, dataBase64 },
								targetWorkspaceId,
								(loaded, total) => engine.setUploadProgress(uid, total > 0 ? Math.min(100, (loaded / total) * 100) : 0),
							);
							engine.completeUpload(uid, node.path);
							uploadedForBindings.push({ word: pending.word, wordIndex: pending.wordIndex, uid, path: node.path });
						} catch {
							engine.failUpload(uid);
							engineSkipped++;
						}
					}
				}

				if (loose.length > 0 || pendingUploads.some((item) => item.source === "workspace") || uploadedForBindings.length > 0) {
					appStore.setRightPanelTab("preview");
					if (appStore.workspaceMode === "collapsed") appStore.setWorkspaceMode("quarter");
					if (workspaceStore.activeWorkspaceId !== targetWorkspaceId) await workspaceStore.setActiveWorkspace(targetWorkspaceId ?? null);
					else await workspaceStore.loadTree();
				}

				const messageContent = input || (pendingImages.length > 0 ? t("chat.describeImage") : "");
				const imagesToSend = pendingImages.length > 0 ? pendingImages.map(({ data, mimeType }) => ({ data, mimeType })) : undefined;
				const bindings = engine && outgoing
					? engine.finalizeBindings(outgoing.readyBindings, uploadedForBindings)
					: [];
				const attachments = bindings.length > 0 || loose.length > 0 ? { bindings, loose } : undefined;

				resetComposer();
				engine?.postSendCleanup();
				setUploads((current) => current.filter((entry) => entry.status === "failed"));
				setInlineImages([]);
				setWsError("");
				const skippedTotal = failedNames.length + engineSkipped;
				if (skippedTotal > 0) {
					showSmartToast(t("chat.smartInput.uploadSkippedCount", "有 {{count}} 个文件未上传成功，未随消息发送，已回到附件栏可重试", { count: skippedTotal }), true);
				}
				void chatStore.send(messageContent, imagesToSend, targetSessionId, attachments);
			} catch (error) {
				setWsError(error instanceof Error ? error.message : t("chat.errCreateSession"));
			} finally {
				setIsUploading(false);
			}
		})();
	}, [
		buildSessionInput,
		chat.isSending,
		draftValue,
		inlineImages,
		isUploading,
		isWelcome,
		pasteBlocks,
		resizeInput,
		sessions.currentSessionId,
		showSmartToast,
		simpleMode,
		t,
		uploadWorkspaceId,
		uploads,
		wsExistingId,
		wsMode,
	]);

	const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.nativeEvent.isComposing || event.keyCode === 229) return;
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			handleSend();
		}
	}, [handleSend]);

	const handleStop = useCallback(() => chatStore.cancel(), []);
	const handleReconnect = useCallback(() => void chatStore.reconnect(), []);
	const handleRetry = useCallback(() => {
		shouldStickToBottomRef.current = true;
		void chatStore.retry();
	}, []);

	const addImageFiles = useCallback((files: File[]) => {
		files.forEach((file) => {
			void prepareInlineImage(file).then((prepared) => setInlineImages((prev) => [...prev, prepared]));
		});
	}, []);

	const showPasteInTextField = useCallback((blockId: number) => {
		const el = inputRef.current;
		const block = pasteBlocks.find((item) => item.id === blockId);
		if (!block || !el) return;
		const start = Math.min(el.selectionStart, el.value.length);
		const end = Math.min(el.selectionEnd, el.value.length);
		el.focus();
		el.setRangeText(block.text, start, end, "end");
		draftRef.current = el.value;
		setDraftValue(el.value);
		setPasteBlocks((prev) => prev.filter((item) => item.id !== blockId));
		resizeInput();
	}, [pasteBlocks, resizeInput]);

	const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
		const imageItems = Array.from(event.clipboardData.items).filter((item) => item.type.startsWith("image/"));
		if (imageItems.length > 0) {
			event.preventDefault();
			const files = imageItems.map((item) => item.getAsFile()).filter((file): file is File => file !== null);
			addImageFiles(files);
			return;
		}
		const text = event.clipboardData.getData("text/plain");
		if (text && isLargeTextPaste(text)) {
			event.preventDefault();
			const id = pasteBlockIdRef.current++;
			setPasteBlocks((prev) => [...prev, { id, text }]);
		}
	}, [addImageFiles]);

	const handleImageFiles = useCallback((event: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/"));
		if (files.length === 0) return;
		addImageFiles(files);
		event.target.value = "";
	}, [addImageFiles]);
	const removeInlineImage = useCallback((index: number) => {
		setInlineImages((prev) => prev.filter((_, currentIndex) => currentIndex !== index));
	}, []);
	const addLocalFiles = useCallback((files: File[]) => {
		if (files.length === 0) return;
		setWsError("");
		setUploads((current) => [...current, ...files.map(localPendingUpload)]);
	}, []);

	const handleFiles = useCallback((event: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files ?? []);
		if (files.length === 0) return;
		addLocalFiles(files);
		event.target.value = "";
	}, [addLocalFiles]);

	const pickWorkspaceFile = useCallback((path: string) => {
		setWsError("");
		setUploads((current) =>
			current.some((item) => item.source === "workspace" && item.path === path)
				? current
				: [...current, workspacePendingUpload(path)],
		);
	}, []);

	const retryUpload = useCallback((index: number) => {
		setUploads((current) => current.map((item, currentIndex) =>
			currentIndex === index && item.status === "failed" ? { ...item, status: "ready", pct: 0 } : item));
	}, []);

	const removeUpload = useCallback((index: number) => {
		setUploads((current) => current.filter((_, currentIndex) => currentIndex !== index));
	}, []);

	const renderComposer = (placeholder: string) => (
		<ChatComposer
			inputRef={inputRef}
			fileInputRef={fileInputRef}
			imageInputRef={imageInputRef}
			placeholder={placeholder}
			defaultValue={draftRef.current}
			inlineImages={inlineImages}
			pasteBlocks={pasteBlocks}
			modelState={modelState}
			modelOptions={modelOptions}
			currentModel={currentModel}
			modelPickerOpen={modelPickerOpen}
			attachMenuOpen={attachMenuOpen}
			workspaceFiles={workspaceFiles}
			smartInputEnabled={smartInputEnabled}
			mirrorRef={mirrorRef}
			hitRef={hitRef}
			chatIsSending={chat.isSending}
			canReconnect={chat.canReconnect}
			lastUserPrompt={chat.lastUserPrompt}
			isUploading={isUploading}
			hasSendableContent={hasSendableContent}
			hasPendingQuestion={Boolean(chat.pendingQuestion)}
			onInput={handleInput}
			onCompositionStart={handleCompositionStart}
			onCompositionEnd={handleCompositionEnd}
			onKeyDown={handleKeyDown}
			onPaste={handlePaste}
			onFiles={handleFiles}
			onImageFiles={handleImageFiles}
			onRemoveInlineImage={removeInlineImage}
			onShowPasteInTextField={showPasteInTextField}
			onRemovePasteBlock={(blockId) => setPasteBlocks((prev) => prev.filter((block) => block.id !== blockId))}
			onToggleModelPicker={toggleModelPicker}
			onCloseModelPicker={closeModelPicker}
			onModelSelect={handleModelSelect}
			onOpenModelSettings={openModelSettings}
			onToggleAttachMenu={() => setAttachMenuOpen((open) => !open)}
			onCloseAttachMenu={() => setAttachMenuOpen(false)}
			onPickWorkspaceFile={pickWorkspaceFile}
			onDropFiles={addLocalFiles}
			onSend={handleSend}
			onStop={handleStop}
			onReconnect={handleReconnect}
			onRetry={handleRetry}
		/>
	);

	const renderWorkspaceContext = (context: "welcome" | "session") => {
		// The workspace selector belongs to the new-chat home page. A real
		// conversation already has a fixed workspace context and should keep the
		// composer uncluttered.
		if (context === "session") return null;
		const selectedWorkspaceId = wsMode === "existing" ? wsExistingId : null;
		const selectedKind: "workspace" | "temp" | "new" = wsMode === "existing" ? "workspace" : wsMode;
		return (
			<WorkspaceContext
				workspaces={workspaces.list}
				selectedWorkspaceId={selectedWorkspaceId}
				selectedKind={selectedKind}
				newWorkspaceName={wsMode === "new" ? wsName : ""}
				busy={isSwitchingWorkspace}
				disabled={isUploading || Boolean(chat.pendingQuestion)}
				onChange={handleWorkspaceChange}
			/>
		);
	};

	const uploadChips = (
		<ChatUploadChips
			uploads={uploads}
			onRemove={removeUpload}
			onRetry={retryUpload}
			onInsertAsBubble={smartInputEnabled && smartSettings?.allowRightClick !== false
				? (path) => {
					const item = takeAttachment(path);
					if (item) engineRef.current?.insertAttachmentAsBubble(item);
				}
				: undefined}
		/>
	);
	const questionHint = chat.pendingQuestion ? <QuestionHint scrollRef={scrollRef} /> : null;
	const busyBlocker = <BusyBlocker busyBlocker={sessions.busyBlocker} />;
	const smartToastNode = smartToast && typeof document !== "undefined" ? createPortal(
		<div className={`inno-smart-toast ${smartToast.error ? "is-error" : ""}`} role="status">{smartToast.message}</div>,
		document.body,
	) : null;
	const smartOverlayNode = smartInputEnabled ? (
		<SmartInputOverlay
			engine={engineRef.current}
			panel={smartPanel}
			onClose={() => setSmartPanel(null)}
			onOpenPanel={(next) => setSmartPanel(next)}
			workspaceFiles={workspaceFiles}
			attachments={uploads}
			takeAttachment={takeAttachment}
			onWorkspaceHighlight={highlightWorkspace}
		/>
	) : null;

	if (isWelcome) {
		return (
			<>
			{smartToastNode}
			{smartOverlayNode}
			<ChatWelcome
				welcomeLayoutRef={welcomeLayoutRef}
				simpleMode={simpleMode}
				togglingMode={togglingMode}
				onToggleMode={toggleMode}
				uploadChips={uploadChips}
				questionHint={questionHint}
				busyBlocker={busyBlocker}
				composer={renderComposer(t("chat.welcomePlaceholder"))}
				workspaceContext={renderWorkspaceContext("welcome")}
				presets={presets}
				presetsLoaded={presetsLoaded}
				isLoadingPresets={isLoadingPresets}
				isRefreshingPresets={isRefreshingPresets}
				presetsRefreshError={presetsRefreshError}
				presetRefreshStatus={presetRefreshStatus}
				loadedPresetIds={loadedPresetIds}
				onRefreshPresets={() => void loadPresets(true)}
				openingPresetId={openingPresetId}
				onOpenPreset={openPreset}
				presetQuery={presetQuery}
				onPresetQueryChange={setPresetQuery}
				wsError={wsError}
			/>
			</>
		);
	}

	return (
		<>
		{smartToastNode}
		{smartOverlayNode}
		<ChatConversation
			chat={chat}
			scrollRef={scrollRef}
			onScroll={handleChatScroll}
			onWheel={markUserScrollGesture}
			onTouchStart={markUserScrollGesture}
			onPointerDown={handleScrollerPointerDown}
			onPauseAutoScroll={pauseAutoScroll}
			uploadChips={uploadChips}
			questionHint={questionHint}
			busyBlocker={busyBlocker}
			composer={renderComposer(t("chat.composerPlaceholder"))}
			workspaceContext={renderWorkspaceContext("session")}
			wsError={wsError}
		/>
		</>
	);
}
