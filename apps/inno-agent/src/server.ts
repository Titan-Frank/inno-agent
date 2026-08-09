// Register source-map-support so that compiled JS stack traces and
// pino-caller call sites map back to the original TS source locations.
import "source-map-support/register.js";

import { createServer, type IncomingMessage as HttpReq, type ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { loadConfig, saveConfig, normalizeContentHubConfig, type InnoConfig, type InnoContentHubConfig } from "./config.js";
import { installFetchLogger } from "./utils/fetch-logger.js";
import { applyProviderProxyBypass } from "./utils/proxy-bypass.js";
import { ensureDir, readJson, readText, writeJson, writeText } from "./storage/file-store.js";
import {
	createNewSession,
	getCurrentSessionId,
	getLoadedSkills,
	getSession,
	getActivePromptToken,
	initSession,
	isQueueTaskCancelled,
	reloadResources,
	switchSessionFile,
	syncConfig,
	applyWorkspaceCwd,
	setWorkspaceCwdResolver,
} from "./agent/pi-runner.js";
import { completePromptOnce, runPromptSerialized, runPromptStreamingInSession, runPromptInSession, abortPromptForTurnToken, persistPendingUserTurn, persistCancelledQueuedTurn, type PromptRunOutcome } from "./agent/pi-runner.js";
import type { ImageContent } from "@earendil-works/pi-ai";
import { ChannelRegistry } from "./channels/channel.js";
import type { ChannelStreamEvent } from "./channels/channel.js";
import { FeishuChannel } from "./channels/feishu/feishu-channel.js";
import { PersonalChannelDispatcher } from "./channels/personal-dispatcher.js";
import { BridgeChannel } from "./channels/bridge/bridge-channel.js";
import { WeChatChannel } from "./channels/wechat/wechat-channel.js";
import type { PersonalBridgeChannelConfig } from "./config.js";
import { JobStore } from "./scheduler/job-store.js";
import { seedManagedMcpConfig } from "./mcp/mcp-config-store.js";
import { CronScheduler } from "./scheduler/cron-scheduler.js";
import { json, matchRoute, readBody } from "./server/http-helpers.js";
import {
	contentDispositionAttachment,
	safeJoin,
	slugifySkillName,
	WORKSPACE_IGNORES,
} from "./server/file-helpers.js";
import { handleChannelsRoutes } from "./server/routes/channels.js";
import { handleJobsRoutes } from "./server/routes/jobs.js";
import { handleSettingsRoutes } from "./server/routes/settings.js";
import { handleSkillsRoutes, type SkillLibraryItem } from "./server/routes/skills.js";
import { handleWorkspacesRoutes } from "./server/routes/workspaces.js";
import { handleSessionsRoutes } from "./server/routes/sessions.js";
import { handleLearnerRoutes } from "./server/routes/learner.js";
import { handleWikiRoutes } from "./server/routes/wiki.js";
import { handlePresetsRoutes } from "./server/routes/presets.js";
import { handlePracticeRoutes } from "./server/routes/practice.js";
import {
	mergeChannels,
	type SessionChannel,
	type SessionChannelMetadata,
	type SessionMessageSummary,
	type SessionQuestionMetadata,
	type SessionSummary,
	type SessionTopicMetadata,
} from "./server/session-model.js";
import { logger } from "./logger.js";
import { applyRuntimeEnvironment, parseRuntimeArgs, resolveRuntimePaths } from "./runtime.js";
import { questionBridge, type QuestionBridgeResult } from "./agent/question-bridge.js";
import { hasCompleteTurnAfterBaseline, streamRegistry, type SessionStreamState, type StreamPersistence } from "./chat/stream-registry.js";
import { DEFAULT_WORKSPACE_ID, TEMP_WORKSPACE_ID, WorkspaceRegistry } from "./workspace/workspace-registry.js";
import { createContentSource, type RemoteContentSource } from "./content-source/index.js";
import { mapWithConcurrency } from "./content-source/types.js";
import { RunRecordStore } from "./terminal/run-record-store.js";
import { TerminalSessionManager } from "./terminal/terminal-session-manager.js";
import type { ClientTerminalEvent, ServerTerminalEvent } from "./terminal/terminal-types.js";
import { WebSocketServer, type WebSocket } from "ws";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

// bodyTimeout: 15 min safety net for LLM provider requests. Provider-level
// timeout (retry.provider.timeoutMs, default 10 min) should fire first; this
// ensures a hung connection can't live longer than 15 minutes even if the
// provider timeout fails to abort.
setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 900_000, headersTimeout: 0 }));
installFetchLogger();

const parsed = parseRuntimeArgs(process.argv.slice(2));
const paths = resolveRuntimePaths(parsed.options);
applyRuntimeEnvironment(paths);

// Port is resolved from CLI / env only — config.json is read lazily.
const port = parsed.options.port
	?? (process.env.INNO_PORT ? Number.parseInt(process.env.INNO_PORT, 10) : undefined)
	?? 3000;

// Config is loaded on first API request, not at startup.
let config!: InnoConfig;

// ---------------------------------------------------------------------------
// Lazy bootstrap — directories, stores, channels, and agent session are
// deferred until the first meaningful web request (not /health or static files).
// Before that, no INNO_HOME subdirectories or files are created.
// ---------------------------------------------------------------------------

const dataDir = paths.dataDir;
const l2DataDir = paths.l2DataDir;
const skillsDir = paths.skillsDir;

// All stateful services are declared with !: — they are guaranteed to be
// initialised before any API handler that uses them runs, because the HTTP
// handler calls ensureBootstrapped() before dispatching.
let jobStore!: JobStore;
let channelRegistry!: ChannelRegistry;
let workspaceRegistry!: WorkspaceRegistry;
let runRecordStore!: RunRecordStore;
let terminalManager!: TerminalSessionManager;
let feishuChannel: FeishuChannel | null = null;
let wechatChannel: WeChatChannel | null = null;
let dispatcher: PersonalChannelDispatcher | null = null;

let bootstrapped = false;
let bootstrapPromise: Promise<void> | null = null;
let bridgeToken: string | undefined;

function piEventToSseEvent(event: any): unknown | null {
	switch (event.type) {
		case "message_update": {
			const ev = event.assistantMessageEvent;
			if (ev.type === "text_delta") return { type: "text_delta", delta: ev.delta };
			if (ev.type === "thinking_delta") return { type: "thinking_delta", delta: ev.delta };
			if (ev.type === "toolcall_start" || ev.type === "toolcall_delta" || ev.type === "toolcall_end") {
				return toolCallStreamEventFromAssistantEvent(ev);
			}
			if (ev.type === "error") return null;
			return null;
		}
		case "message_end": {
			const msg = event.message;
			if (msg && typeof msg === "object" && "stopReason" in msg && msg.stopReason === "error") {
				return null;
			}
			return null;
		}
		case "tool_execution_start":
			return { type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
		case "tool_execution_end":
			return { type: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError };
		default:
			return null;
	}
}

function toolCallStreamEventFromAssistantEvent(ev: any): unknown | null {
	const content = Array.isArray(ev.partial?.content) ? ev.partial.content : [];
	const block = typeof ev.contentIndex === "number" ? content[ev.contentIndex] : undefined;
	if (!block || typeof block !== "object" || block.type !== "toolCall") return null;
	const toolCallId = typeof block.id === "string" && block.id ? block.id : `content-${ev.contentIndex}`;
	const toolName = typeof block.name === "string" ? block.name : "";
	if (!toolName) return null;
	const args = ev.type === "toolcall_end"
		? ev.toolCall?.arguments ?? block.arguments
		: undefined;
	return {
		type: "tool_call_delta",
		toolCallId,
		toolName,
		...(args !== undefined ? { args } : {}),
		...(ev.type === "toolcall_delta" && typeof ev.delta === "string" ? { argsDelta: ev.delta } : {}),
	};
}

/** Convert a raw PI SDK event to a ChannelStreamEvent for channel streaming replies. */
function piEventToChannelStreamEvent(event: any): ChannelStreamEvent | null {
	switch (event.type) {
		case "message_update": {
			const ev = event.assistantMessageEvent;
			if (ev.type === "text_delta") return { type: "text_delta", delta: ev.delta };
			if (ev.type === "thinking_delta") return { type: "thinking_delta", delta: ev.delta };
			if (ev.type === "error") return { type: "error", message: ev.error?.errorMessage || "LLM API error" };
			return null;
		}
		case "message_end": {
			const msg = event.message;
			if (msg && typeof msg === "object" && "stopReason" in msg && msg.stopReason === "error") {
				return { type: "error", message: msg.errorMessage || "The model request failed." };
			}
			return null;
		}
		case "tool_execution_start":
			return { type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName };
		case "tool_execution_end": {
			const summary = typeof event.result === "string" ? event.result.slice(0, 80) : undefined;
			return { type: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, summary };
		}
		default:
			return null;
	}
}

/**
 * One-shot lazy bootstrap. Idempotent — concurrent requests while the first
 * bootstrap is still in-flight all await the same promise.
 */
async function ensureBootstrapped(): Promise<void> {
	if (bootstrapped) return;
	if (bootstrapPromise) return bootstrapPromise;

	bootstrapPromise = (async () => {
		logger.info("[inno-server] first meaningful request — bootstrapping...");

		// ---- config (loaded lazily, not at process start) ----
		config = loadConfig(paths.configPath);
		applyProviderProxyBypass(config);

		// First-run MCP template: seeds <configDir>/mcp.json with a disabled
		// reference server when the file doesn't exist yet. No-op afterwards.
		seedManagedMcpConfig(paths);

		// ---- data directories ----
		ensureDir(paths.learnerDataDir);
		ensureDir(paths.sessionDir);
		ensureDir(paths.jobsDir);
		ensureDir(paths.skillsDir);
		ensureDir(paths.workspaceDir);

		// ---- stores ----
		jobStore = new JobStore(paths.jobsDir);
		jobStore.normalizePersistedJobs();

		channelRegistry = new ChannelRegistry(join(dataDir, "channels", "default-targets.json"));

		workspaceRegistry = new WorkspaceRegistry(paths.workspaceDir, dataDir);
		workspaceRegistry.ensureBootstrapped();
		try {
			const sessionFiles = existsSync(paths.sessionDir)
				? readdirSync(paths.sessionDir).filter((f) => f.endsWith(".jsonl"))
				: [];
			workspaceRegistry.migrateUnboundSessions(sessionFiles, DEFAULT_WORKSPACE_ID);
		} catch (err) {
			logger.warn({ err }, "[sessions] unbound-session migration failed");
		}

		runRecordStore = new RunRecordStore(join(dataDir, "runs"));
		terminalManager = new TerminalSessionManager(workspaceRegistry, runRecordStore);

		// Resolve agent cwd per session based on its workspace binding.
		setWorkspaceCwdResolver((sessionPath: string) => {
			const id = basename(sessionPath);
			const workspaceId = workspaceRegistry.getSessionWorkspaceId(id);
			return workspaceRegistry.resolveWorkspaceDir(workspaceId);
		});

		migrateLegacyPiSkills();

		// ---- channels ----
		function migrateReminderChannels(): void {
			const defaultFeishuTarget = channelRegistry.getDefaultTarget("feishu");
			if (!defaultFeishuTarget) return;
			for (const job of jobStore.list()) {
				if (job.taskType !== "push_reminder") continue;
				if (job.channel) continue;
				jobStore.update(job.id, {
					channel: "feishu",
					target: defaultFeishuTarget,
				});
			}
		}

		if (config.feishu?.appId && config.channels?.feishu?.enabled) {
			feishuChannel = new FeishuChannel(config.feishu, dataDir, config.channels.feishu);
			channelRegistry.register(feishuChannel);
		}

		bridgeToken = config.bridge?.token;
		if (bridgeToken) {
			const qqConfig = config.channels?.qq as PersonalBridgeChannelConfig | undefined;
			if (qqConfig?.enabled && qqConfig.sidecarBaseUrl) {
				channelRegistry.register(new BridgeChannel("qq", qqConfig.sidecarBaseUrl, bridgeToken));
			}
			const wechatConfigBridge = config.channels?.wechat;
			if (wechatConfigBridge?.enabled && "sidecarBaseUrl" in wechatConfigBridge && (wechatConfigBridge as PersonalBridgeChannelConfig).mode === "bridge") {
				channelRegistry.register(new BridgeChannel("wechat", (wechatConfigBridge as PersonalBridgeChannelConfig).sidecarBaseUrl, bridgeToken));
			}
		}

		const wechatCfg = config.channels?.wechat;
		if (wechatCfg?.enabled && (!("mode" in wechatCfg) || (wechatCfg as { mode?: string }).mode !== "bridge")) {
			wechatChannel = new WeChatChannel(dataDir, wechatCfg);
			channelRegistry.register(wechatChannel);
		}
		migrateReminderChannels();

		// ---- agent session ----
		logger.info("[inno-server] initializing agent session...");
		await initSession(config, paths, channelRegistry, {
			sandbox: parsed.options.sandbox,
			extensionDeps: {
				workspaceRegistry,
				runRecordStore,
				getCurrentSessionId,
				recordChannelInteraction: (channel) => recordCurrentSessionChannel(channel as SessionChannel),
			},
		});

		// ---- post-init: dispatcher, channels, cron, WebSocket ----
		const channelsDataDir = join(dataDir, "channels");
		ensureDir(channelsDataDir);
		dispatcher = new PersonalChannelDispatcher({
			channelRegistry,
			runPrompt: runPromptSerialized,
			runPromptInSession,
			runPromptStreamingInSession: (sessionPath, prompt, onEvent, images) => {
				return runPromptStreamingInSession(sessionPath, prompt, (piEvent: any) => {
					const channelEvent = piEventToChannelStreamEvent(piEvent);
					if (channelEvent) onEvent(channelEvent);
				}, images);
			},
			createNewSession,
			getCurrentSessionId,
			recordSessionChannel: (ch, sid?) => recordCurrentSessionChannel(ch as SessionChannel, sid, { setOriginIfEmpty: true }),
			maybeAutoGenerateTopic,
			onSessionCreated: (sessionId, channel) => {
				try {
					const ws = workspaceRegistry.ensureChannelWorkspace(channel);
					workspaceRegistry.bindSession(sessionId, ws.id);
				} catch (err) {
					logger.warn({ err }, `[sessions] failed to bind channel session ${sessionId}`);
				}
			},
			channelsDataDir,
			sessionDir: join(dataDir, "sessions"),
		});

		if (feishuChannel) {
			feishuChannel.onMessage((msg) => dispatcher!.handle(feishuChannel!, msg));
			feishuChannel.start();

			// Auto-discover default target on first boot if none persisted
			if (!channelRegistry.getDefaultTarget("feishu")) {
				feishuChannel.discoverDefaultTarget().then((target) => {
					if (target) {
						channelRegistry.setDefaultTarget(target);
						logger.info({ chatId: target.chatId }, "[feishu] auto-set default target from chat list");
					}
				}).catch((err) => {
					logger.warn({ err }, "[feishu] initial target discovery failed");
				});
			}
		}
		if (wechatChannel) {
			wechatChannel.onMessage((msg) => dispatcher!.handle(wechatChannel!, msg));
			wechatChannel.start();
		}

		const scheduler = new CronScheduler(jobStore, channelRegistry);
		scheduler.start();

		logger.info({ channels: channelRegistry.all().map((c) => c.name).join(", ") || "none" }, "[inno-server] channels");
		logger.info({ jobCount: jobStore.list().length }, "[inno-server] jobs loaded");

		bootstrapped = true;
		logger.info("[inno-server] bootstrap complete");
	})().catch((err) => {
		logger.error({ err }, "[inno-server] bootstrap failed");
		bootstrapPromise = null; // allow retry on next request
		throw err;
	});

	return bootstrapPromise;
}

// ---------------------------------------------------------------------------
// Channel hot-reload
// ---------------------------------------------------------------------------

/**
 * Stop the current Feishu channel (if any) and reinitialize it from the
 * current in-memory config. Called after PUT /api/settings/channels so that
 * new credentials take effect without a server restart.
 */
async function reloadFeishuChannel(): Promise<void> {
	// Tear down existing instance
	if (feishuChannel) {
		try { await feishuChannel.stop(); } catch { /* best effort */ }
		feishuChannel = null;
	}

	// If feishu is now configured and enabled, create a new instance
	if (!config.feishu?.appId || !config.channels?.feishu?.enabled) {
		logger.info("[feishu] channel disabled or not configured, skipping reload");
		return;
	}

	feishuChannel = new FeishuChannel(config.feishu, dataDir, config.channels.feishu);
	channelRegistry.register(feishuChannel);

	if (dispatcher) {
		feishuChannel.onMessage((msg) => dispatcher!.handle(feishuChannel!, msg));
	}
	feishuChannel.start();
	logger.info("[feishu] channel hot-reloaded with new credentials");

	// Auto-discover default target if none exists yet (fixes first-time setup
	// chicken-and-egg: user had to send FROM Feishu before agent could send TO it)
	if (!channelRegistry.getDefaultTarget("feishu")) {
		const target = await feishuChannel.discoverDefaultTarget();
		if (target) {
			channelRegistry.setDefaultTarget(target);
			logger.info({ chatId: target.chatId }, "[feishu] auto-set default target from chat list");
		}
	}
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Persist inline chat images (base64 data URLs from the web UI) to a
 * workspace-local `.chat-images/` directory so file-path-based tools
 * (`ocr_image`, `parse_document`) can read them. Returns workspace-relative
 * paths. When the chat model cannot natively recognize images, the agent is
 * steered (via the system prompt) to call `ocr_image` with these paths.
 */
function persistInlineImages(images: Array<{ data: string; mimeType: string }>, workspaceRoot: string): string[] {
	if (images.length === 0) return [];
	const chatImagesDir = join(workspaceRoot, ".chat-images");
	try {
		if (!existsSync(chatImagesDir)) mkdirSync(chatImagesDir, { recursive: true });
	} catch (err) {
		logger.warn({ err }, "failed to create .chat-images dir");
		return [];
	}
	const timestamp = Date.now();
	const paths: string[] = [];
	images.forEach((img, idx) => {
		const ext = mimeTypeToExtension(img.mimeType);
		const filename = `${timestamp}-${idx}${ext}`;
		const filePath = join(chatImagesDir, filename);
		try {
			writeFileSync(filePath, Buffer.from(img.data, "base64"));
			paths.push(`.chat-images/${filename}`);
		} catch (err) {
			logger.warn({ err, filename }, "failed to persist inline image");
		}
	});
	return paths;
}

function sessionRevision(filePath: string): string {
	try {
		const stat = statSync(filePath);
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return "missing";
	}
}

function readSessionBaseline(filePath: string): { messageCount: number; revision: string } {
	return {
		messageCount: parseSessionFile(filePath)?.messages.length ?? 0,
		revision: sessionRevision(filePath),
	};
}

function confirmTurnPersistence(
	state: SessionStreamState,
	sessionPath: string,
	outcome: PromptRunOutcome,
): StreamPersistence {
	const parsed = parseSessionFile(sessionPath);
	const revision = sessionRevision(sessionPath);
	if (!parsed) return { persisted: false, finalSessionRevision: revision };
	const structurallyComplete = hasCompleteTurnAfterBaseline(
		parsed.messages,
		state.baselineMessageCount,
	);
	const revisionChanged = revision !== state.baselineSessionRevision;
	const persisted = structurallyComplete && revisionChanged && parsed.messages.length > state.baselineMessageCount;
	if (!persisted) {
		logger.error({
			sessionId: state.sessionId,
			turnId: state.turnId,
			outcome: outcome.type,
			baselineMessageCount: state.baselineMessageCount,
			finalMessageCount: parsed.messages.length,
			baselineSessionRevision: state.baselineSessionRevision,
			finalSessionRevision: revision,
		}, "chat turn persistence confirmation failed");
	}
	return {
		persisted,
		finalMessageCount: parsed.messages.length,
		finalSessionRevision: revision,
	};
}

function mimeTypeToExtension(mimeType: string): string {
	switch (mimeType) {
		case "image/png": return ".png";
		case "image/jpeg": return ".jpg";
		case "image/gif": return ".gif";
		case "image/webp": return ".webp";
		case "image/tiff": return ".tiff";
		case "image/bmp": return ".bmp";
		default: return ".png";
	}
}

/**
 * Build the fallback prompt variant carrying the saved-image path hint, so
 * the agent knows which files to pass to `ocr_image` / `parse_document`.
 * Only sent when the model can't natively see images (text-only model or a
 * rejected native payload) — vision-capable turns receive the raw prompt so
 * they aren't steered toward `ocr_image`.
 */
function prependImagePathsHint(prompt: string, imagePaths: string[]): string {
	if (imagePaths.length === 0) return prompt;
	const list = imagePaths.map((p) => `- ${p}`).join("\n");
	return (
		`[用户本轮上传了 ${imagePaths.length} 张图片，已保存到工作区：\n${list}\n` +
		`如果需要识别图片中的文字（当前模型可能不支持图片识别），请调用 ocr_image 工具并传入上述路径。]\n\n${prompt}`
	);
}

// ---------------------------------------------------------------------------
// Static file serving (web/dist/)
// ---------------------------------------------------------------------------

const webDistDir = paths.webDistDir;

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

function isHashedStaticAsset(filePath: string): boolean {
	const rel = relative(webDistDir, filePath).split(sep).join("/");
	return /^assets\/.+-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(rel);
}

function acceptEncodingHeader(req: HttpReq): string {
	const value = req.headers["accept-encoding"];
	return Array.isArray(value) ? value.join(",") : value ?? "";
}

function encodingAccepted(acceptEncoding: string, encoding: "br" | "gzip"): boolean {
	let wildcardQ: number | undefined;
	for (const part of acceptEncoding.split(",")) {
		const [rawToken, ...params] = part.trim().split(";");
		const token = rawToken.trim().toLowerCase();
		if (!token) continue;
		let q = 1;
		for (const param of params) {
			const [name, value] = param.trim().split("=", 2);
			if (name?.trim().toLowerCase() !== "q") continue;
			const parsed = Number.parseFloat(value?.trim() ?? "");
			q = Number.isFinite(parsed) ? parsed : 0;
			break;
		}
		if (token === encoding) return q > 0;
		if (token === "*") wildcardQ = q;
	}
	return wildcardQ !== undefined ? wildcardQ > 0 : false;
}

function serveStatic(req: HttpReq, res: ServerResponse, filePath: string, sendBody = true): boolean {
	try {
		if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
		const ext = extname(filePath);
		const contentType = MIME_TYPES[ext] || "application/octet-stream";
		const acceptEncoding = acceptEncodingHeader(req);
		let responsePath = filePath;
		let contentEncoding: "br" | "gzip" | undefined;
		if (encodingAccepted(acceptEncoding, "br") && existsSync(`${filePath}.br`)) {
			responsePath = `${filePath}.br`;
			contentEncoding = "br";
		} else if (encodingAccepted(acceptEncoding, "gzip") && existsSync(`${filePath}.gz`)) {
			responsePath = `${filePath}.gz`;
			contentEncoding = "gzip";
		}

		const content = readFileSync(responsePath);
		const headers: Record<string, string | number> = {
			"Content-Type": contentType,
			"Content-Length": content.length,
			"Cache-Control": ext === ".html"
				? "no-cache"
				: isHashedStaticAsset(filePath)
					? "public, max-age=31536000, immutable"
					: "no-cache",
		};
		if (contentEncoding) {
			headers["Content-Encoding"] = contentEncoding;
			headers.Vary = "Accept-Encoding";
		}
		res.writeHead(200, headers);
		res.end(sendBody ? content : undefined);
		return true;
	} catch (err) {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Local data helpers
// ---------------------------------------------------------------------------

function sessionFileFromId(sessionDir: string, id: string): string | null {
	const fileName = basename(id);
	if (fileName !== id || !fileName.endsWith(".jsonl")) return null;
	return safeJoin(sessionDir, fileName);
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const record = part as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

function imagesFromContent(content: unknown): Array<{ previewUrl: string; mimeType: string }> {
	if (!Array.isArray(content)) return [];
	const result: Array<{ previewUrl: string; mimeType: string }> = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const record = part as Record<string, unknown>;
		if (
			record.type === "image" &&
			typeof record.data === "string" &&
			typeof record.mimeType === "string"
		) {
			result.push({
				previewUrl: `data:${record.mimeType};base64,${record.data}`,
				mimeType: record.mimeType,
			});
		}
	}
	return result;
}

function parseSkillFrontmatter(content: string): Record<string, string | boolean> {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!match) return {};
	const fm: Record<string, string | boolean> = {};
	for (const line of match[1].split("\n")) {
		const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!kv) continue;
		const raw = kv[2].trim();
		if (kv[1] in fm) continue; // 保留第一个值（标准YAML行为）
		fm[kv[1]] = raw === "true" ? true : raw === "false" ? false : raw.replace(/^["']|["']$/g, "");
	}
	return fm;
}

function ensureSkillDocument(content: string, fallbackName: string): { name: string; content: string } {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const frontmatter = parseSkillFrontmatter(normalized);
	const name = slugifySkillName(typeof frontmatter.name === "string" ? frontmatter.name : fallbackName);
	const description = typeof frontmatter.description === "string" && frontmatter.description.trim()
		? frontmatter.description.trim()
		: `Project skill uploaded for ${name}. Use when the user's task matches this skill package.`;

	if (normalized.startsWith("---\n")) {
		return { name, content: normalized };
	}

	return {
		name,
		content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${normalized.trim()}\n`,
	};
}

function copyDirectoryContents(sourceDir: string, targetDir: string): void {
	ensureDir(targetDir);
	for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
		if (entry.name === "__MACOSX" || entry.name === ".DS_Store") continue;
		const source = join(sourceDir, entry.name);
		const target = join(targetDir, entry.name);
		if (entry.isDirectory()) {
			cpSync(source, target, { recursive: true });
		} else if (entry.isFile()) {
			cpSync(source, target);
		}
	}
}

function findSkillFile(dir: string): string | null {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "__MACOSX") continue;
		const fullPath = join(dir, entry.name);
		if (entry.isFile() && entry.name === "SKILL.md") return fullPath;
	}
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "__MACOSX") continue;
		const fullPath = join(dir, entry.name);
		if (!entry.isDirectory()) continue;
		const nested = findSkillFile(fullPath);
		if (nested) return nested;
	}
	return null;
}

function validateZipEntries(zipPath: string): void {
	if (process.platform === "win32") {
		// Windows: list zip entries via .NET ZipFile API (no system unzip).
		const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
			`$zip = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}'); ` +
			`try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }`;
		const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf-8" });
		if (result.status !== 0) {
			throw new Error((result.stderr || "").trim() || "Unable to inspect zip file");
		}
		for (const rawLine of result.stdout.split(/\r?\n/)) {
			const entry = rawLine.trim();
			if (!entry) continue;
			if (entry.startsWith("/") || entry.startsWith("\\") || entry.includes("..")) {
				throw new Error(`Unsafe zip entry path: ${entry}`);
			}
		}
		return;
	}
	const result = spawnSync("/usr/bin/unzip", ["-Z1", zipPath], { encoding: "utf-8" });
	if (result.status !== 0) {
			throw new Error((result.stderr || "").trim() || "Unable to inspect zip file");
	}
	for (const rawLine of result.stdout.split("\n")) {
		const entry = rawLine.trim();
		if (!entry) continue;
		if (entry.startsWith("/") || entry.includes("..") || entry.includes("\\")) {
			throw new Error(`Unsafe zip entry path: ${entry}`);
		}
	}
}

function installSkillZip(fileName: string, data: Buffer, targetRoot: string = skillsDir): { name: string; filePath: string } {
	const fallbackName = slugifySkillName(basename(fileName, extname(fileName)));
	const tempRoot = join(tmpdir(), `inno-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const zipPath = join(tempRoot, `${fallbackName}.zip`);
	const extractDir = join(tempRoot, "extract");
	ensureDir(extractDir);
	writeFileSync(zipPath, data);

	try {
		validateZipEntries(zipPath);
		if (process.platform === "win32") {
			// Windows: extract via .NET ZipFile.ExtractToDirectory (no system unzip).
			const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
				`[System.IO.Compression.ZipFile]::ExtractToDirectory(` +
				`'${zipPath.replace(/'/g, "''")}', '${extractDir.replace(/'/g, "''")}')`;
			const unzipResult = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf-8" });
			if (unzipResult.status !== 0) {
				throw new Error((unzipResult.stderr || "").trim() || "Unable to unzip skill package");
			}
		} else {
			const unzipResult = spawnSync("/usr/bin/unzip", ["-qq", "-o", zipPath, "-d", extractDir], { encoding: "utf-8" });
			if (unzipResult.status !== 0) {
				throw new Error((unzipResult.stderr || "").trim() || "Unable to unzip skill package");
			}
		}

		return installSkillFromExtractedDir(extractDir, fallbackName, targetRoot);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

/**
 * Install a skill from an already-extracted directory: locate the SKILL.md,
 * normalize its frontmatter, and copy the package into the skills directory.
 * Shared by zip upload and skill-library import.
 */
function installSkillFromExtractedDir(extractDir: string, fallbackName: string, targetRoot: string = skillsDir): { name: string; filePath: string } {
	const skillFile = findSkillFile(extractDir);
	if (!skillFile) {
		throw new Error("Skill package must contain a SKILL.md file");
	}
	const skillRoot = dirname(skillFile);
	const skill = ensureSkillDocument(readText(skillFile), fallbackName);
	const targetDir = join(targetRoot, skill.name);
	rmSync(targetDir, { recursive: true, force: true });
	copyDirectoryContents(skillRoot, targetDir);
	writeText(join(targetDir, "SKILL.md"), skill.content);
	return { name: skill.name, filePath: join(targetDir, "SKILL.md") };
}

function installSkillMarkdown(fileName: string, data: Buffer, targetRoot: string = skillsDir): { name: string; filePath: string } {
	const skill = ensureSkillDocument(data.toString("utf-8"), basename(fileName, extname(fileName)));
	const skillDir = join(targetRoot, skill.name);
	rmSync(skillDir, { recursive: true, force: true });
	ensureDir(skillDir);
	writeText(join(skillDir, "SKILL.md"), skill.content);
	return { name: skill.name, filePath: join(skillDir, "SKILL.md") };
}

// ---------------------------------------------------------------------------
// Remote content hub (skill library + preset workspaces)
//
// Backed by a RemoteContentSource (GitHub repo by default, or a self-hosted
// bundle service). The source is created lazily from config.contentHub and
// recreated whenever the hub config changes, so settings edits take effect
// without a restart.
// ---------------------------------------------------------------------------


let contentSource: RemoteContentSource | null = null;
let contentSourceHubKey = "";

/** Stable identity for a hub config, so we recreate the source on change. */
function hubKey(hub: InnoContentHubConfig): string {
	return JSON.stringify(hub);
}

/** Get (or rebuild) the content source for the current config.contentHub. */
function getContentSource(): RemoteContentSource {
	const hub = config.contentHub ?? normalizeContentHubConfig(undefined, config.github?.token);
	const key = hubKey(hub);
	if (!contentSource || key !== contentSourceHubKey) {
		contentSource = createContentSource(hub);
		contentSourceHubKey = key;
	}
	return contentSource;
}

/** Drop the source so the next call rebuilds it (and its cache) from config. */
function invalidateContentSource(): void {
	contentSource?.invalidate();
	contentSource = null;
	contentSourceHubKey = "";
}

/**
 * Extract the `description` and `category` fields from a SKILL.md frontmatter
 * block. Supports both single-line and YAML folded/literal block scalars
 * (`>-`, `|`). Returns `""` for any missing field.
 */
function extractFrontmatterFields(content: string): { description: string; category: string } {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---/);
	if (!fmMatch) return { description: "", category: "" };
	const lines = fmMatch[1].split("\n");
	const extractField = (key: string): string => {
		const re = new RegExp(`^${key}:\\s*(.*)$`);
		for (let i = 0; i < lines.length; i++) {
			const m = lines[i].match(re);
			if (!m) continue;
			const inline = m[1].trim();
			// Block scalar (>- , |, > , |- ...) → gather indented continuation lines.
			if (/^[>|][+-]?\s*$/.test(inline)) {
				const block: string[] = [];
				for (let j = i + 1; j < lines.length; j++) {
					if (/^\s+\S/.test(lines[j]) || lines[j].trim() === "") {
						block.push(lines[j].trim());
					} else {
						break;
					}
				}
				return block.join(" ").replace(/\s+/g, " ").trim();
			}
			return inline.replace(/^["']|["']$/g, "").trim();
		}
		return "";
	};
	return {
		description: extractField("description"),
		category: extractField("category"),
	};
}

/**
 * List installable skills from the remote skill library via the content source.
 * Descriptions are best-effort (read from each SKILL.md / item meta).
 */
async function listSkillLibrary(forceRefresh = false): Promise<SkillLibraryItem[]> {
	const source = getContentSource();
	const items = await source.listItems("skills", { forceRefresh });

	const localNames = new Set(
		existsSync(skillsDir)
			? readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
			: [],
	);

	// One SKILL.md read per item over raw.githubusercontent.com; cap concurrency
	// so a large library doesn't burst past the raw CDN throttle (429) and lose
	// descriptions. Matches the preset library's approach.
	const result = await mapWithConcurrency(items, 5, async (item): Promise<SkillLibraryItem> => {
		// Prefer inline meta (bundle service); otherwise read SKILL.md frontmatter.
		let description = typeof item.meta?.description === "string" ? item.meta.description : "";
		let category = typeof item.meta?.category === "string" ? item.meta.category.trim() : "";
		if (!description || !category) {
			const md = await source.readItemTextFile("skills", item.name, "SKILL.md");
			if (md) {
				const fields = extractFrontmatterFields(md);
				if (!description) description = fields.description;
				if (!category) category = fields.category;
			}
		}
		return {
			name: item.name,
			description,
			category: category || undefined,
			installed: localNames.has(slugifySkillName(item.name)),
		};
	});
	return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Import a skill from the remote library into the global skills directory.
 * Downloads the item's files into a temp dir, then installs through the same
 * path as a zip upload (validates SKILL.md, normalizes frontmatter).
 */
async function importSkillFromLibrary(skillName: string): Promise<{ name: string; filePath: string }> {
	const source = getContentSource();
	const tempRoot = join(tmpdir(), `inno-libskill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const extractDir = join(tempRoot, "extract");
	ensureDir(extractDir);
	try {
		await source.downloadItem("skills", skillName, extractDir);
		return installSkillFromExtractedDir(extractDir, slugifySkillName(skillName), skillsDir);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

function migrateLegacyPiSkills(): void {
	const legacySkillsDir = join(paths.workspaceDir, ".pi", "skills");
	if (!existsSync(legacySkillsDir)) return;
	ensureDir(skillsDir);
	for (const entry of readdirSync(legacySkillsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const legacySkillDir = join(legacySkillsDir, entry.name);
		const legacySkillFile = join(legacySkillDir, "SKILL.md");
		if (!existsSync(legacySkillFile)) continue;
		const content = readText(legacySkillFile);
		const skill = ensureSkillDocument(content, entry.name);
		const targetDir = join(skillsDir, skill.name);
		if (!existsSync(targetDir)) {
			ensureDir(targetDir);
			cpSync(legacySkillDir, targetDir, { recursive: true });
			writeText(join(targetDir, "SKILL.md"), skill.content);
		}
	}
}

interface SkillRegistry {
	disabled: string[];
}

function skillRegistryPath(): string {
	return join(paths.configDir, "skills.json");
}

function readSkillRegistry(): SkillRegistry {
	const registry = readJson<Partial<SkillRegistry>>(skillRegistryPath(), {});
	return {
		disabled: Array.isArray(registry.disabled)
			? registry.disabled.filter((item): item is string => typeof item === "string")
			: [],
	};
}

function writeSkillRegistry(registry: SkillRegistry): void {
	ensureDir(paths.configDir);
	writeJson(skillRegistryPath(), registry);
}

function disabledSkillNames(): Set<string> {
	return new Set(readSkillRegistry().disabled);
}

function setSkillEnabled(name: string, enabled: boolean): void {
	const registry = readSkillRegistry();
	const disabled = new Set(registry.disabled);
	if (enabled) {
		disabled.delete(name);
	} else {
		disabled.add(name);
	}
	writeSkillRegistry({ disabled: Array.from(disabled).sort() });
	writeDisabledSkillsIgnoreFile(disabled);
}

function writeDisabledSkillsIgnoreFile(disabled: Set<string>): void {
	const lines = Array.from(disabled)
		.sort()
		.map((name) => `${name}/`);
	writeText(join(skillsDir, ".ignore"), lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

function listProjectSkills(): unknown[] {
	ensureDir(skillsDir);
	const disabled = disabledSkillNames();
	const loaded = getLoadedSkills();
	const loadedByPath = new Map(loaded.skills.map((skill) => [resolve(skill.filePath), skill]));
	const diagnosticsByPath = new Map<string, string[]>();
	for (const diagnostic of loaded.diagnostics) {
		if (!diagnostic.path) continue;
		const diagnosticPath = resolve(diagnostic.path);
		const list = diagnosticsByPath.get(diagnosticPath) ?? [];
		list.push(diagnostic.message);
		diagnosticsByPath.set(diagnosticPath, list);
	}

	return readdirSync(skillsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const name = entry.name;
			const filePath = join(skillsDir, name, "SKILL.md");
			const content = existsSync(filePath) ? readText(filePath) : "";
			const stat = existsSync(filePath) ? statSync(filePath) : statSync(join(skillsDir, name));
			const loadedSkill = loadedByPath.get(resolve(filePath));
			const fields = extractFrontmatterFields(content);
			return {
				name,
				description: fields.description,
				category: fields.category || undefined,
				enabled: !disabled.has(name),
				loaded: Boolean(loadedSkill),
				filePath: relative(paths.workspaceDir, filePath),
				size: existsSync(filePath) ? stat.size : 0,
				updatedAt: stat.mtime.toISOString(),
				diagnostics: diagnosticsByPath.get(resolve(filePath)) ?? [],
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Refresh the agent's in-memory skills in the background.
 *
 * Skill listings (`listProjectSkills`) read from disk, so callers can respond
 * immediately without waiting for the agent runtime to reload. Awaiting the
 * reload inside a request handler could block the HTTP response indefinitely
 * (the reload is serialized behind the agent prompt queue), which left the
 * upload UI stuck on "uploading". Fire-and-forget keeps the request snappy.
 */
function scheduleSkillsReload(): void {
	void reloadResources().catch((err) => {
		logger.warn({ err }, "[inno-server] skills reload failed");
	});
}

interface WorkspaceFileChange {
	path: string;
	change: "created" | "modified" | "deleted";
}

interface WorkspaceChangeMonitor {
	noteToolEnd(toolCallId: string, toolName: string): void;
	close(): void;
}

const WORKSPACE_CHANGE_IGNORES = new Set([
	...WORKSPACE_IGNORES,
	".next",
	".vite",
	"coverage",
]);
const MAX_WORKSPACE_CHANGE_EVENTS = 40;
const WORKSPACE_CHANGE_SETTLE_MS = 80;

function createWorkspaceChangeMonitor(
	rootDir: string | null,
	publish: (event: unknown) => void,
): WorkspaceChangeMonitor | null {
	if (!rootDir || !existsSync(rootDir)) return null;
	const root = resolve(rootDir);
	const pending = new Map<string, "change" | "rename">();
	let context: { toolCallId: string; toolName: string } | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let closed = false;

	const flush = () => {
		if (timer) clearTimeout(timer);
		timer = null;
		if (pending.size === 0 || !context) return;
		const entries = Array.from(pending.entries());
		pending.clear();
		const changes: WorkspaceFileChange[] = [];
		for (const [path, eventType] of entries.slice(0, MAX_WORKSPACE_CHANGE_EVENTS)) {
			const fullPath = resolve(root, path);
			if (existsSync(fullPath)) {
				try {
					if (!statSync(fullPath).isFile()) continue;
				} catch {
					continue;
				}
				changes.push({ path, change: eventType === "rename" ? "created" : "modified" });
			} else {
				changes.push({ path, change: "deleted" });
			}
		}
		if (changes.length > 0) {
			publish({
				type: "workspace_change",
				...context,
				changes,
				truncated: entries.length > MAX_WORKSPACE_CHANGE_EVENTS,
			});
		}
	};

	const scheduleFlush = () => {
		if (!context || closed) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(flush, WORKSPACE_CHANGE_SETTLE_MS);
	};

	let watcher: ReturnType<typeof watch>;
	try {
		watcher = watch(root, { recursive: true }, (eventType, filename) => {
			if (!filename || closed) return;
			const fullPath = resolve(root, filename.toString());
			const relativePath = relative(root, fullPath);
			if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return;
			const normalizedPath = relativePath.replaceAll("\\", "/");
			if (normalizedPath.split("/").some((part) => WORKSPACE_CHANGE_IGNORES.has(part))) return;
			pending.set(normalizedPath, eventType);
			scheduleFlush();
		});
	} catch (err) {
		logger.warn({ err, root }, "workspace file monitoring unavailable");
		return null;
	}

	watcher.on("error", (err) => {
		logger.warn({ err, root }, "workspace file monitor failed");
	});

	return {
		noteToolEnd(toolCallId, toolName) {
			context = { toolCallId, toolName };
			scheduleFlush();
		},
		close() {
			closed = true;
			flush();
			watcher.close();
		},
	};
}
function sessionTopicMetadataPath(): string {
	return join(dataDir, "sessions", "meta.json");
}

function readSessionTopicMetadata(): SessionTopicMetadata {
	return readJson<SessionTopicMetadata>(sessionTopicMetadataPath(), {});
}

function writeSessionTopic(id: string, topic: string, generated = false, extra?: { upgraded?: boolean }): void {
	const metadata = readSessionTopicMetadata();
	metadata[id] = { topic, generated, updatedAt: new Date().toISOString(), ...(extra?.upgraded ? { upgraded: true } : {}) };
	writeJson(sessionTopicMetadataPath(), metadata);
}

function parseSessionFile(filePath: string): { summary: SessionSummary; messages: SessionMessageSummary[] } | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const lines = raw.split("\n").filter((line) => line.trim().length > 0);
		const messages: SessionMessageSummary[] = [];
		const channels = new Set<SessionChannel>();
		let createdAt = "";
		let lastMessageAt = "";

		// Aggregator for the in-progress assistant turn. PI splits one assistant
		// turn into multiple JSONL entries (thinking + toolCalls + toolResults
		// + final text), so we merge them back into a single bubble.
		let pendingAssistant: SessionMessageSummary | null = null;
		const finalizeAssistant = () => {
			if (pendingAssistant) {
				messages.push(pendingAssistant);
				pendingAssistant = null;
			}
		};
		const ensureAssistant = (timestamp: number): SessionMessageSummary => {
			if (!pendingAssistant) {
				pendingAssistant = { role: "assistant", content: "", timestamp };
			}
			return pendingAssistant;
		};

		for (const line of lines) {
			const entry = JSON.parse(line) as Record<string, unknown>;
			const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
			if (!createdAt && timestamp) createdAt = timestamp;
			// Detect channel ONLY from structured JSON fields written by the system
			// (message.channel / message.source / message.api / message.model).
			// We intentionally do NOT substring-match the raw line for natural-language
			// keywords like "飞书" / "scheduled" — those appear in ordinary user/assistant
			// text and would falsely tag a web session as a feishu/scheduler session.
			// Verified on unmodified code: a learner asking "飞书的英文名?" (user text)
			// or a reply that merely mentions "飞书" (assistant text) both got mislabeled
			// as channel=feishu even though origin stayed web. The authoritative channel
			// record lives in channels.json (via recordCurrentSessionChannel); this
			// detection is only a best-effort hint for legacy sessions that predate it.
			let entryChannel: SessionChannel | undefined;
			const msgObj = entry.type === "message" && entry.message && typeof entry.message === "object"
				? entry.message as Record<string, unknown>
				: undefined;
			const channelField = typeof msgObj?.channel === "string" ? (msgObj.channel as string) : "";
			const sourceField = typeof msgObj?.source === "string" ? (msgObj.source as string) : "";
			const apiField = typeof msgObj?.api === "string" ? (msgObj.api as string) : "";
			const modelField = typeof msgObj?.model === "string" ? (msgObj.model as string) : "";
			if (channelField === "feishu") {
				channels.add("feishu");
				entryChannel = "feishu";
			}
			if (channelField === "wechat" || channelField === "wecom") {
				channels.add("wechat");
				entryChannel = entryChannel ?? "wechat";
			}
			if (channelField === "qq") {
				channels.add("qq");
				entryChannel = entryChannel ?? "qq";
			}
			if (sourceField === "web" || channelField === "web") {
				channels.add("web");
				entryChannel = entryChannel ?? "web";
			}
			// Scheduler-authored assistant messages carry a synthetic api/model marker.
			if (apiField === "inno-background" || modelField === "scheduler") {
				channels.add("scheduler");
				entryChannel = entryChannel ?? "scheduler";
			}

			if (!msgObj) continue;
			if (timestamp) lastMessageAt = timestamp;
			const message = msgObj;
			const role = message.role;
			const ts = timestamp ? Date.parse(timestamp) : Date.now();

			if (role === "user") {
				finalizeAssistant();
				const content = textFromContent(message.content);
				if (!content) continue;
				const images = imagesFromContent(message.content);
				const msg: SessionMessageSummary = { role: "user", content, timestamp: ts, channel: entryChannel };
				if (images.length > 0) msg.images = images;
				messages.push(msg);
				continue;
			}

			if (role === "assistant") {
				const pending = ensureAssistant(ts);
				if (entryChannel && !pending.channel) pending.channel = entryChannel;
				const content = message.content;
				if (Array.isArray(content)) {
					for (const part of content) {
						if (!part || typeof part !== "object") continue;
						const block = part as Record<string, unknown>;
						if (block.type === "text" && typeof block.text === "string") {
							pending.content = pending.content
								? `${pending.content}\n${block.text}`
								: block.text;
						} else if (block.type === "thinking" && typeof block.thinking === "string") {
							pending.thinking = pending.thinking
								? `${pending.thinking}\n${block.thinking}`
								: block.thinking;
						} else if (block.type === "toolCall") {
							const toolCallId = typeof block.id === "string" ? block.id : "";
							const toolName = typeof block.name === "string" ? block.name : "tool";
							const args = block.arguments;
							pending.tools = pending.tools ?? [];
							pending.tools.push({
								toolCallId,
								toolName,
								args,
								contentOffset: pending.content.length,
							});
						}
					}
				} else if (typeof content === "string" && content) {
					pending.content = pending.content ? `${pending.content}\n${content}` : content;
				}
				pending.timestamp = ts;
				// If this assistant entry ended the turn (stopReason "stop"), finalize.
				if (typeof message.stopReason === "string" && message.stopReason !== "toolUse") {
					finalizeAssistant();
				}
				continue;
			}

			if (role === "toolResult") {
				const pending = ensureAssistant(ts);
				const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
				const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
				// PI keeps a tool's structured details alongside its text content. Keep
				// those details in session history so completed questionnaires can be
				// rendered with the selected options after the session is reopened.
				const result = toolName === "ask_user_question" && message.details !== undefined
					? message.details
					: textFromContent(message.content) || message.content;
				const isError = Boolean(message.isError);
				pending.tools = pending.tools ?? [];
				const existing = pending.tools.find((t) => t.toolCallId === toolCallId);
				if (existing) {
					existing.result = result;
					existing.isError = isError;
				} else {
					pending.tools.push({ toolCallId, toolName, args: undefined, result, isError });
				}
				continue;
			}
		}
		finalizeAssistant();

		// Filter out empty assistant entries (no text, no thinking, no tools).
		const filtered = messages.filter((m) =>
			m.role === "user" ? !!m.content : (m.content || m.thinking || (m.tools && m.tools.length > 0)),
		);

		const firstUser = filtered.find((message) => message.role === "user");
		const preview = firstUser?.content.trim() ?? "";
		const name = preview ? (preview.length > 48 ? `${preview.slice(0, 45)}...` : preview) : basename(filePath);
		const stat = statSync(filePath);
		const fallbackTime = stat.mtime.toISOString();
		return {
			summary: {
				id: basename(filePath),
				name,
				createdAt: createdAt || fallbackTime,
				updatedAt: lastMessageAt || createdAt || fallbackTime,
				messageCount: filtered.length,
				preview,
				channels: channels.size > 0 ? Array.from(channels) : [],
			},
			messages: filtered,
		};
	} catch (err) {
		return null;
	}
}

function sessionChannelMetadataPath(): string {
	return join(dataDir, "sessions", "channels.json");
}

// --- Pending question persistence (survives process restart) ---
function sessionQuestionMetadataPath(): string {
	return join(dataDir, "sessions", "questions.json");
}

/** In-memory cache of questions.json — read once, updated on every write.
 *  Avoids a synchronous readFileSync on every session-detail request. */
let _questionMetadataCache: SessionQuestionMetadata | null = null;

function readSessionQuestionMetadata(): SessionQuestionMetadata {
	if (_questionMetadataCache === null) {
		_questionMetadataCache = readJson<SessionQuestionMetadata>(sessionQuestionMetadataPath(), {});
	}
	return _questionMetadataCache;
}

function writeSessionQuestionMetadata(meta: SessionQuestionMetadata): void {
	_questionMetadataCache = meta;
	writeJson(sessionQuestionMetadataPath(), meta);
}

function readSessionChannelMetadata(): SessionChannelMetadata {
	return readJson<SessionChannelMetadata>(sessionChannelMetadataPath(), {});
}

function recordCurrentSessionChannel(
	channel: SessionChannel,
	explicitSessionId?: string,
	options?: { setOriginIfEmpty?: boolean },
): void {
	const id = explicitSessionId || (() => {
		const sessionFile = getSession().sessionFile;
		return sessionFile ? basename(sessionFile) : "";
	})();
	if (!id) return;
	const metadata = readSessionChannelMetadata();
	const prev = metadata[id];
	metadata[id] = {
		channels: mergeChannels(prev?.channels ?? [], [channel]),
		// origin is the immutable birthplace of the session: set once and never
		// overwritten. Interaction tagging (e.g. a web session pushing a file to
		// feishu) must NOT change origin, so it omits setOriginIfEmpty.
		origin: prev?.origin ?? (options?.setOriginIfEmpty ? channel : undefined),
		updatedAt: new Date().toISOString(),
	};
	writeJson(sessionChannelMetadataPath(), metadata);
}

function cleanGeneratedTopic(raw: string): string {
	return raw
		.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
		.replace(/^标题[:：]\s*/i, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 32);
}

/** Strip machine-injected prefixes (e.g. the image-upload hint prepended to
 *  user prompts) so titles reflect the user's actual words. */
function stripInjectedPrefix(content: string): string {
	return content
		.replace(/^\[用户本轮上传了 \d+ 张图片，已保存到工作区：[\s\S]*?\]\s*/, "")
		.trim();
}

function fallbackTopicFromMessages(messages: SessionMessageSummary[], summary: SessionSummary): string {
	const source = stripInjectedPrefix(messages.find((message) => message.role === "user")?.content || "") || summary.preview || summary.name;
	const cleaned = source.replace(/\s+/g, " ").trim();
	return cleaned ? (cleaned.length > 28 ? `${cleaned.slice(0, 28)}...` : cleaned) : "New conversation";
}

/** Build the dialogue excerpt for topic generation: first 2 + last 4 usable
 *  messages (the opening states the goal, the tail captures where the
 *  conversation actually went), consecutive duplicates dropped (scheduler
 *  nudges repeat), machine prefixes stripped, ~2400 chars. */
function buildTopicExcerpt(messages: SessionMessageSummary[]): string {
	const usable = messages
		.map((message) => ({
			role: message.role,
			content: stripInjectedPrefix(message.content).replace(/\s+/g, " ").trim(),
		}))
		.filter((message) => message.content)
		.filter((message, index, all) => index === 0 || message.content !== all[index - 1].content);
	const picked = usable.length <= 6 ? usable : [...usable.slice(0, 2), ...usable.slice(-4)];
	return picked
		.map((message) => `${message.role === "user" ? "用户" : "助手"}: ${message.content}`)
		.join("\n")
		.slice(0, 2400);
}

async function generateSessionTopic(summary: SessionSummary, messages: SessionMessageSummary[]): Promise<string> {
	const excerpt = buildTopicExcerpt(messages);

	if (!excerpt) return fallbackTopicFromMessages(messages, summary);

	const prompt = `请用一句简短的中文短语概括下面学习对话中用户的学习目标或任务。
要求：
- 只输出标题本身，不要解释
- 8 到 16 个中文字符
- 聚焦用户想学的内容或要做的任务，忽略寒暄、客套话和系统提示
- 不要使用引号、句号或冒号

示例一：
对话：
用户: 你好
助手: 你好！今天想学点什么？
用户: 我一直搞不清贝叶斯定理，能举个生活中的例子讲讲吗
标题：贝叶斯定理入门

示例二：
对话：
用户: 帮我把这份教案改成 45 分钟公开课的版本
助手: 好的，我先看看教案的结构……
标题：教案改编公开课版

对话：
${excerpt}
标题：`;

	try {
		// Reasoning models burn tokens on a thinking block before any visible
		// text — a tiny maxTokens (e.g. 64) gets fully consumed by thinking and
		// yields an empty title. 1024 leaves ample room for both.
		const generated = cleanGeneratedTopic(await completePromptOnce(prompt, 1024));
		return generated || fallbackTopicFromMessages(messages, summary);
	} catch (err) {
		return fallbackTopicFromMessages(messages, summary);
	}
}

/**
 * Auto-generate a topic for a session if it doesn't already have one.
 * Runs asynchronously — fire and forget.
 *
 * Two passes, both guarded by `_pendingAutoTopics`:
 * 1. First pass: no topic recorded yet and ≥2 messages (the first exchange).
 * 2. Upgrade pass: the existing topic is auto-generated (never a manual
 *    rename), hasn't been upgraded yet, and the conversation has grown to
 *    TOPIC_UPGRADE_MESSAGE_THRESHOLD messages — the first-pass title was
 *    based on a single exchange and is often vague, so re-roll it once with
 *    richer context.
 */
const _pendingAutoTopics = new Set<string>();
const TOPIC_UPGRADE_MESSAGE_THRESHOLD = 6;

function maybeAutoGenerateTopic(sessionId: string): void {
	if (!sessionId || _pendingAutoTopics.has(sessionId)) return;
	const existing = readSessionTopicMetadata()[sessionId];
	if (existing && (!existing.generated || existing.upgraded)) return;

	const sessionPath = sessionFileFromId(join(dataDir, "sessions"), sessionId);
	if (!sessionPath || !existsSync(sessionPath)) return;

	_pendingAutoTopics.add(sessionId);
	void (async () => {
		try {
			const parsed = parseSessionFile(sessionPath);
			if (!parsed || parsed.messages.length < 2) return;
			if (existing && parsed.messages.length < TOPIC_UPGRADE_MESSAGE_THRESHOLD) return;
			const topic = await generateSessionTopic(parsed.summary, parsed.messages);
			writeSessionTopic(sessionId, topic, true, existing ? { upgraded: true } : undefined);
			logger.info(`[auto-topic] ${sessionId} → ${topic}${existing ? " (upgraded)" : ""}`);
		} catch (err) {
			logger.warn({ err }, `auto-topic generation failed for ${sessionId}`);
		} finally {
			_pendingAutoTopics.delete(sessionId);
		}
	})();
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

/**
 * The prompt currently holding the shared serial queue, if any. Only prompts
 * hold queue slots for a meaningful duration; switch/create are instant.
 */
function getQueueBlocker(): { sessionId: string; turnId: string; questionPending: boolean } | null {
	const token = getActivePromptToken();
	if (!token) return null;
	const state = streamRegistry.getByTurn(token);
	if (!state || (state.status !== "queued" && state.status !== "running")) return null;
	const pending = questionBridge.pendingInfo();
	return {
		sessionId: state.sessionId,
		turnId: state.turnId,
		questionPending: pending?.turnId === state.turnId,
	};
}

/**
 * Session-retention policy (issue #124): a turn parked on a question card can
 * never progress without the user, yet it holds the shared prompt queue for
 * up to the 30-minute question timeout — blocking every session switch /
 * creation behind it. Navigating to a DIFFERENT session implicitly abandons
 * the card, so abort that turn to release the queue. Turns that are actively
 * generating are left alone (they end on their own; the user can still stop
 * them explicitly via the scoped abort endpoint).
 *
 * Mirrors the scoped abort route: cancel the registry state, resolve the
 * parked question (session.abort() alone cannot wake it), then abort.
 */
function releaseQueueFromQuestionBlockedTurn(targetSessionId: string): void {
	const blocker = getQueueBlocker();
	if (!blocker || !blocker.questionPending || blocker.sessionId === targetSessionId) return;
	const state = streamRegistry.getByTurn(blocker.turnId);
	if (!state) return;
	logger.info({ blockedSession: blocker.sessionId, turnId: blocker.turnId, targetSessionId }, "auto-aborting question-blocked turn to release the prompt queue");
	streamRegistry.requestCancel(state);
	questionBridge.unbindTurn({ sessionId: state.sessionId, turnId: state.turnId, reason: "switched_away" });
	if (state.status === "running") void abortPromptForTurnToken(state.turnId);
}

/**
 * Run an enqueue-backed operation with a hard wait bound. If the queue is
 * held by a long turn the caller gets a 409 with blocker details instead of
 * hanging for minutes; a client disconnect cancels the still-queued task so
 * it never executes out from under a user who already gave up.
 */
async function runQueueOpWithTimeout<T>(
	req: HttpReq,
	res: ServerResponse,
	op: (signal: AbortSignal) => Promise<T>,
	timeoutMs = 8_000,
): Promise<T | null> {
	const aborter = new AbortController();
	// res "close" with the response unfinished = the client went away. (req
	// "close" is unusable here: it fires as soon as the request body is fully
	// received, long before we answer.)
	res.on("close", () => { if (!res.writableFinished) aborter.abort(); });
	const timer = setTimeout(() => aborter.abort(), timeoutMs);
	try {
		return await op(aborter.signal);
	} catch (err) {
		if (isQueueTaskCancelled(err)) {
			if (!res.writableFinished && !res.destroyed) {
				json(res, 409, { error: "session_busy", blocking: getQueueBlocker() ?? undefined });
			}
			return null;
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

const server = createServer(async (req, res) => {
	const url = req.url ?? "/";
	const method = req.method ?? "GET";

	try {
		// --- Health check (no bootstrap needed) ---
		if (method === "GET" && (url === "/health" || url === "/api/health")) {
			json(res, 200, { status: "ok" });
			return;
		}

		// --- Lazy bootstrap on first API request ---
		// All /api/* endpoints need the agent session and data stores.
		// Static files and SPA fallback skip this so no directories are
		// created until the user actually interacts with the web UI.
		if (url.startsWith("/api/")) {
			await ensureBootstrapped();
		}

		// --- Jobs CRUD (extracted to server/routes/jobs.ts) ---
		if (await handleJobsRoutes(req, res, method, url, { jobStore, channelRegistry })) return;

		// --- Channels + bridge (extracted to server/routes/channels.ts) ---
		if (await handleChannelsRoutes(req, res, method, url, {
			channelRegistry,
			dataDir,
			configPath: paths.configPath,
			getConfig: () => config,
			setConfig: (next) => { config = next; },
			getDispatcher: () => dispatcher,
			getBridgeToken: () => bridgeToken,
			reloadFeishuChannel,
			getWechatChannel: () => wechatChannel,
			setWechatChannel: (channel) => { wechatChannel = channel; },
		})) return;

		// --- Skills API ---
		if (await handleSkillsRoutes(req, res, method, url, {
			skillsDir,
			scheduleSkillsReload,
			listProjectSkills,
			setSkillEnabled,
			installSkillZip,
			installSkillMarkdown,
			listSkillLibrary,
			importSkillFromLibrary,
		})) return;

		// --- Sessions API (extracted to server/routes/sessions.ts) ---
		if (await handleSessionsRoutes(req, res, method, url, {
			workspaceRegistry, dataDir, paths, getContentSource,
			parseSessionFile, sessionRevision,
			readSessionChannelMetadata, sessionChannelMetadataPath,
			readSessionTopicMetadata, sessionTopicMetadataPath, writeSessionTopic,
			readSessionQuestionMetadata, writeSessionQuestionMetadata,
			recordCurrentSessionChannel, generateSessionTopic,
			sessionFileFromId, releaseQueueFromQuestionBlockedTurn, runQueueOpWithTimeout,
		})) return;

		// --- Wiki + L2 raw upload API (extracted to server/routes/wiki.ts) ---
		if (await handleWikiRoutes(req, res, method, url, { l2DataDir })) return;

		// --- Learner profile API (extracted to server/routes/learner.ts) ---
		if (await handleLearnerRoutes(req, res, method, url, { paths })) return;

		// --- Workspace API + registry + session binding (extracted to server/routes/workspaces.ts) ---
		if (await handleWorkspacesRoutes(req, res, method, url, {
			workspaceRegistry, dataDir, paths,
			installSkillZip, installSkillMarkdown, scheduleSkillsReload,
			sessionFileFromId, releaseQueueFromQuestionBlockedTurn, runQueueOpWithTimeout,
		})) return;

		// --- Presets API (extracted to server/routes/presets.ts) ---
		if (await handlePresetsRoutes(req, res, method, url, { paths, getContentSource })) return;

		// --- Terminal sessions + Runs (extracted to server/routes/practice.ts) ---
		if (await handlePracticeRoutes(req, res, method, url, {
			workspaceRegistry, l2DataDir, terminalManager, runRecordStore,
		})) return;

		// --- Settings + MCP API (extracted to server/routes/settings.ts) ---
		if (await handleSettingsRoutes(req, res, method, url, {
			paths,
			getConfig: () => config,
			setConfig: (next) => { config = next; },
			reloadFeishuChannel,
			scheduleSkillsReload,
			invalidateContentSource,
		})) return;

		// --- Chat API ---
		if (method === "POST" && url === "/api/chat") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const prompt = body.prompt as string | undefined;
			if (!prompt) {
				json(res, 400, { error: "Missing prompt" });
				return;
			}
			const rawImages = Array.isArray(body.images) ? body.images : [];
			const images = rawImages
				.filter((img): img is { data: string; mimeType: string } =>
					img && typeof img.data === "string" && typeof img.mimeType === "string")
				.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
			const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : null;
			const imageSessionId = requestedSessionId || getCurrentSessionId();
			const imageWorkspaceId = workspaceRegistry.getSessionWorkspaceId(imageSessionId);
			const imageWorkspaceRoot = workspaceRegistry.resolveWorkspaceDir(imageWorkspaceId) ?? paths.workspaceDir;
			const imagePaths = persistInlineImages(images, imageWorkspaceRoot);
			// Sent only when the images can't reach the model natively (text-only
			// model or provider rejection); vision turns get the raw prompt so
			// they aren't steered toward ocr_image.
			const imageFallbackPrompt = prependImagePathsHint(prompt, imagePaths);
			// Use atomic switch+prompt when a specific session is requested.
			let output: string;
			try {
				if (requestedSessionId) {
					const sessionPath = sessionFileFromId(join(dataDir, "sessions"), requestedSessionId);
					if (sessionPath && existsSync(sessionPath)) {
						output = await runPromptInSession(sessionPath, prompt, images.length ? images : undefined, imageFallbackPrompt);
					} else {
						output = await runPromptSerialized(prompt, images.length ? images : undefined, imageFallbackPrompt);
					}
				} else {
					output = await runPromptSerialized(prompt, images.length ? images : undefined, imageFallbackPrompt);
				}
			} catch (err) {
				logger.error({ err, sessionId: requestedSessionId }, "Non-streaming chat LLM call failed");
				json(res, 500, { error: err instanceof Error ? err.message : "LLM API call failed" });
				return;
			}
			recordCurrentSessionChannel("web", requestedSessionId || undefined, { setOriginIfEmpty: true });
			maybeAutoGenerateTopic(requestedSessionId || getCurrentSessionId());
			json(res, 200, { response: output });
			return;
		}

		// --- Question response (from web UI) ---
		if (method === "POST" && url === "/api/chat/question-response") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
			const turnId = typeof body.turnId === "string" ? body.turnId : "";
			const questionId = typeof body.questionId === "string" ? body.questionId : "";
			const result = body.result as QuestionBridgeResult | undefined;
			if (!sessionId || !turnId || !questionId || !result) {
				json(res, 400, { error: "Missing sessionId, turnId, questionId or result" });
				return;
			}
			const status = questionBridge.respond({ sessionId, turnId, questionId, result });
			if (status === "not_found") {
				// The live turn is gone (process restarted, or the turn ended while
				// the card was parked). If a persisted card matches, consume it and
				// tell the client to resubmit the answer as a fresh chat turn — the
				// agent then picks the answer up from the session history.
				const questionMeta = readSessionQuestionMetadata();
				const persistedEntry = Object.entries(questionMeta).find(([, q]) => q.questionId === questionId);
				if (persistedEntry) {
					delete questionMeta[persistedEntry[0]];
					writeSessionQuestionMetadata(questionMeta);
					json(res, 200, { accepted: true, expired: true, sessionId: persistedEntry[0] });
					return;
				}
			}
			json(res, status === "accepted" ? 200 : status === "scope_mismatch" || status === "already_resolved" ? 409 : 404, { accepted: status === "accepted" });
			return;
		}

		if (method === "POST" && url === "/api/chat/abort") {
			json(res, 400, { error: "Scoped abort requires sessionId and turnId" });
			return;
		}

		const chatAbortMatch = matchRoute("POST", method, url, "/api/chat/:sessionId/:turnId/abort");
		if (chatAbortMatch) {
			const state = streamRegistry.getByTurn(chatAbortMatch.turnId);
			if (!state || state.sessionId !== chatAbortMatch.sessionId) {
				json(res, 404, { error: "Chat turn not found" });
				return;
			}
			if (state.status !== "queued" && state.status !== "running") {
				json(res, 200, { status: state.status, cancelRequested: state.cancelRequested });
				return;
			}
			streamRegistry.requestCancel(state);
			// Resolve a parked ask_user_question before aborting: session.abort()
			// alone cannot wake the agent loop while it awaits the question
			// promise, so the turn (and its queue slot) would stay stuck until
			// the 30-minute question timeout. unbindTurn is idempotent — the
			// onFinish unbind becomes a no-op once the binding is cleared here.
			questionBridge.unbindTurn({ sessionId: state.sessionId, turnId: state.turnId, reason: "cancelled" });
			if (state.status === "running") await abortPromptForTurnToken(state.turnId);
			json(res, 202, { status: state.status, cancelRequested: true });
			return;
		}

		const chatStatusMatch = matchRoute("GET", method, url, "/api/chat/status/:sessionId");
		if (chatStatusMatch) {
			streamRegistry.cleanupExpiredTurns();
			const state = streamRegistry.getLatest(chatStatusMatch.sessionId);
			json(res, 200, state
				? { found: true, stream: streamRegistry.toPublicSnapshot(state) }
				: { found: false });
			return;
		}

		const chatEventsMatch = matchRoute("GET", method, url, "/api/chat/events/:id");
		if (chatEventsMatch) {
			const sessionId = chatEventsMatch.id;
			const params = new URL(url, "http://localhost").searchParams;
			const turnId = params.get("turnId") ?? "";
			const after = Number.parseInt(params.get("after") ?? "0", 10);
			if (!turnId || !Number.isFinite(after) || after < 0) {
				json(res, 400, { error: "turnId and a non-negative after value are required" });
				return;
			}
			const state = streamRegistry.getByTurn(turnId);
			if (!state || state.sessionId !== sessionId) {
				json(res, 404, { error: "Chat turn not found" });
				return;
			}
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				"Connection": "keep-alive",
				"X-Accel-Buffering": "no",
			});
			let ended = false;
			const eventsHeartbeat = setInterval(() => {
				if (!ended) {
					try {
						res.write(": heartbeat\n\n");
						logger.debug({ sessionId }, "SSE event replay heartbeat sent");
					} catch (err) {
						logger.warn({ sessionId, err }, "SSE event replay heartbeat write failed");
					}
				}
			}, 15_000);
			const finishResponse = () => {
				if (ended) return;
				ended = true;
				clearInterval(eventsHeartbeat);
				res.write("data: [DONE]\n\n");
				res.end();
			};
			const unsub = streamRegistry.subscribe(state, after, (envelope) => {
				if (ended) return;
				res.write(`data: ${JSON.stringify(envelope)}\n\n`);
				if (["done", "error", "aborted"].includes(envelope.event.type)) finishResponse();
			});
			if (state.terminalEventPublished && !ended) finishResponse();
			res.on("close", () => { clearInterval(eventsHeartbeat); unsub(); });
			return;
		}

		// --- Chat Streaming (SSE) ---
		if (method === "POST" && url === "/api/chat/stream") {
			const body = (await readBody(req)) as Record<string, unknown>;
			const prompt = body.prompt as string | undefined;
			const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : "";
			const clientRequestId = typeof body.clientRequestId === "string" ? body.clientRequestId : "";
			if (!prompt || !requestedSessionId || !clientRequestId) {
				json(res, 400, { error: "Missing prompt, sessionId or clientRequestId" });
				return;
			}
			if (streamRegistry.getActiveForSession(requestedSessionId)) {
				json(res, 409, { error: "Session already has an active chat turn" });
				return;
			}
			// Sending in a different session implicitly abandons another
			// session's unanswered question card — release the queue (issue #124).
			releaseQueueFromQuestionBlockedTurn(requestedSessionId);
			const targetSessionPath = sessionFileFromId(join(dataDir, "sessions"), requestedSessionId);
			if (!targetSessionPath || !existsSync(targetSessionPath)) {
				json(res, 404, { error: "Session not found" });
				return;
			}
			const streamWorkspaceId = workspaceRegistry.getSessionWorkspaceId(requestedSessionId);
			const streamWorkspaceRoot = workspaceRegistry.resolveWorkspaceDir(streamWorkspaceId);
			if (!streamWorkspaceRoot) {
				json(res, 404, { error: "Session workspace not found" });
				return;
			}
			const rawImages = Array.isArray(body.images) ? body.images : [];
			const images = rawImages
				.filter((img): img is { data: string; mimeType: string } =>
					img && typeof img.data === "string" && typeof img.mimeType === "string")
				.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
			// Persist inline images to the workspace so file-path tools (ocr_image,
			// parse_document) can read them when the chat model can't see images.
			const imagePaths = persistInlineImages(images, streamWorkspaceRoot);
			// Sent only when the images can't reach the model natively (text-only
			// model or provider rejection); vision turns get the raw prompt so
			// they aren't steered toward ocr_image.
			const imageFallbackPrompt = prependImagePathsHint(prompt, imagePaths);
			const imageArgs = images.length ? images : undefined;
			const baseline = readSessionBaseline(targetSessionPath);
			let state: SessionStreamState;
			try {
				state = streamRegistry.createTurn({
					sessionId: requestedSessionId,
					clientRequestId,
					workspaceId: streamWorkspaceId,
					workspaceRoot: streamWorkspaceRoot,
					inputSnapshot: {
						prompt,
						submittedAt: new Date().toISOString(),
						images: imagePaths.map((workspacePath, index) => ({ mimeType: images[index]?.mimeType ?? "image/png", workspacePath })),
					},
					baselineMessageCount: baseline.messageCount,
					baselineSessionRevision: baseline.revision,
				});
			} catch {
				json(res, 409, { error: "Session already has an active chat turn" });
				return;
			}
			streamRegistry.publishStreamEvent(state, { type: "stream_state", status: "queued" });

			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				"Connection": "keep-alive",
				"X-Accel-Buffering": "no",
			});

			let disconnected = false;
			let responseEnded = false;

			const heartbeatInterval = setInterval(() => {
				if (!disconnected && !responseEnded) {
					try {
						res.write(": heartbeat\n\n");
						logger.debug({ sessionId: requestedSessionId, turnId: state.turnId }, "SSE heartbeat sent");
					} catch (err) {
						logger.warn({ sessionId: requestedSessionId, turnId: state.turnId, err }, "SSE heartbeat write failed");
					}
				}
			}, 15_000);
			const finishResponse = () => {
				if (responseEnded || disconnected) return;
				responseEnded = true;
				clearInterval(heartbeatInterval);
				res.write("data: [DONE]\n\n");
				res.end();
			};
			const unsubscribeResponse = streamRegistry.subscribe(state, 0, (envelope) => {
				if (disconnected || responseEnded) return;
				res.write(`data: ${JSON.stringify(envelope)}\n\n`);
				if (["done", "error", "aborted"].includes(envelope.event.type)) finishResponse();
			});
			res.on("close", () => {
				disconnected = true;
				clearInterval(heartbeatInterval);
				unsubscribeResponse();
			});

			let workspaceChangeMonitor: ReturnType<typeof createWorkspaceChangeMonitor> = null;
			const closeWorkspaceChangeMonitor = () => workspaceChangeMonitor?.close();

			// Track whether the model API surfaced an error this turn. The PI SDK
			// does NOT throw on model API errors (e.g. HTTP 413 from an over-long
			// context) — it converts them into a terminal assistant message with
			// stopReason "error" + errorMessage, delivered via message_end. If we
			// don't forward that, runPromptStreaming resolves with empty text and
			// the UI shows nothing. So we detect it here and emit an error event.
			let promptStartTime = 0;
			const onEvent = (event: import("@earendil-works/pi-coding-agent").AgentSessionEvent) => {
				// Logging regardless of aborted state
				switch (event.type) {
					case "message_update": {
						const ev = event.assistantMessageEvent;
						if (ev.type === "error") {
							const errorMsg = ev.error.errorMessage || `LLM API error (stopReason: ${ev.error.stopReason})`;
							logger.error({ errorMessage: errorMsg, stopReason: ev.error.stopReason, elapsedMs: Date.now() - promptStartTime }, "LLM API stream error event");
						}
						break;
					}
					case "message_end": {
						const msg = event.message;
						if (
							msg && typeof msg === "object" && "stopReason" in msg &&
							(msg as { stopReason?: string }).stopReason === "error"
						) {
							const detail = (msg as { errorMessage?: string }).errorMessage;
							const errorMsg = detail || "The model request failed.";
							logger.error({ stopReason: "error", errorMessage: errorMsg, message: msg, elapsedMs: Date.now() - promptStartTime }, "Model request failed (message_end stopReason=error)");
						}
						break;
					}
					case "tool_execution_start":
						logger.info(
							{ toolName: event.toolName, toolCallId: event.toolCallId },
							"tool call started: %s", event.toolName,
						);
						break;
					case "tool_execution_end":
						workspaceChangeMonitor?.noteToolEnd(event.toolCallId, event.toolName);
						if (event.isError) {
							const errText = Array.isArray(event.result?.content)
								? event.result.content.map((c: { text?: string }) => c.text ?? "").join(" ").slice(0, 500)
								: String(event.result?.content ?? "").slice(0, 500);
							logger.warn(
								{ toolName: event.toolName, toolCallId: event.toolCallId, result: event.result },
								"tool call failed: %s — %s",
								event.toolName,
								errText || "(no error text)",
							);
						} else {
							logger.info(
								{ toolName: event.toolName, toolCallId: event.toolCallId },
								"tool call completed: %s", event.toolName,
							);
						}
						break;
					case "auto_retry_start":
						logger.warn({ attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, errorMessage: event.errorMessage, elapsedMs: Date.now() - promptStartTime }, "LLM API call failed, auto-retrying...");
						break;
					case "auto_retry_end":
						if (!event.success) {
							logger.error({ finalError: event.finalError, elapsedMs: Date.now() - promptStartTime }, "LLM API auto-retry failed");
						}
						break;
					default:
						logger.info({ eventType: (event as { type?: string }).type }, "unhandled SSE event type: %s", (event as { type?: string }).type);
						break;
				}

				// Convert to an SSE event and publish to broadcaster + live client.
				const sseEvent = piEventToSseEvent(event);
				if (sseEvent) streamRegistry.publishStreamEvent(state, sseEvent as { type: string });
			};

			promptStartTime = Date.now();
			try {
				await runPromptStreamingInSession(targetSessionPath, prompt, onEvent, imageArgs, {
					token: state.turnId,
					shouldStart: () => !state.cancelRequested,
					isCancellationRequested: () => state.cancelRequested,
					onStart: () => {
						streamRegistry.publishStreamEvent(state, { type: "stream_state", status: "running" });
						questionBridge.bindTurn({
							sessionId: state.sessionId,
							turnId: state.turnId,
							emit: (event) => streamRegistry.publishStreamEvent(state, event),
							timeoutMs: 30 * 60_000,
						});
						workspaceChangeMonitor = createWorkspaceChangeMonitor(streamWorkspaceRoot, (event) => {
							streamRegistry.publishStreamEvent(state, event as { type: string });
						});
					},
					onFinish: async (outcome) => {
						if (outcome.type === "aborted" && outcome.reason === "cancelled_before_start") {
							persistCancelledQueuedTurn(prompt, state.sessionId, imageArgs);
						} else if (outcome.type !== "completed") {
							persistPendingUserTurn(state.sessionId);
						}
						const persistence = confirmTurnPersistence(state, targetSessionPath, outcome);
						questionBridge.unbindTurn({ sessionId: state.sessionId, turnId: state.turnId, reason: outcome.type });
						closeWorkspaceChangeMonitor();
						workspaceChangeMonitor = null;
						recordCurrentSessionChannel("web", state.sessionId, { setOriginIfEmpty: true });
						if (outcome.type === "completed" && persistence.persisted) {
							streamRegistry.finishTurn(state, "completed", { type: "done", fullText: outcome.fullText }, persistence);
							maybeAutoGenerateTopic(state.sessionId);
						} else if (outcome.type === "completed") {
							streamRegistry.finishTurn(state, "error", { type: "error", message: "Final chat history could not be confirmed.", code: "persistence_confirmation_failed" }, persistence);
						} else if (outcome.type === "aborted") {
							streamRegistry.finishTurn(state, "aborted", { type: "aborted", message: "Stopped by user" }, persistence);
						} else {
							const message = outcome.error instanceof Error ? outcome.error.message : "Unknown error";
							if (state.status === "queued") {
								streamRegistry.finishTurn(state, "aborted", { type: "aborted", message: `Prompt failed before start: ${message}` }, persistence);
							} else {
								streamRegistry.finishTurn(state, "error", { type: "error", message }, persistence);
							}
						}
					},
					onFinalizeFailure: async (outcome, error) => {
						try {
							logger.error({ error, outcome: outcome.type, sessionId: state.sessionId, turnId: state.turnId }, "chat turn finalization failed");
						} catch {
							// Observability must not block the forced terminal path.
						}
						try {
							questionBridge.unbindTurn({ sessionId: state.sessionId, turnId: state.turnId, reason: "finalization_failed" });
						} catch {
							// Continue to the unique terminal event even if question cleanup fails.
						}
						try {
							closeWorkspaceChangeMonitor();
						} catch {
							// Continue to the unique terminal event even if monitor cleanup fails.
						}
						workspaceChangeMonitor = null;
						if (!state.terminalEventPublished) {
							const message = error instanceof Error ? error.message : "Finalization failed";
							if (state.status === "queued") {
								streamRegistry.finishTurn(state, "aborted", { type: "aborted", message: `Prompt failed before start: ${message}` }, { persisted: false });
							} else {
								streamRegistry.finishTurn(state, "error", { type: "error", message, code: "finalization_failed" }, { persisted: false });
							}
						}
					},
				}, streamWorkspaceRoot, imageFallbackPrompt);
			} catch (err) {
				logger.error({ err, sessionId: state.sessionId, turnId: state.turnId }, "SSE chat turn failed");
			} finally {
				clearInterval(heartbeatInterval);
				closeWorkspaceChangeMonitor();
				unsubscribeResponse();
				streamRegistry.cleanupExpiredTurns();
			}
			finishResponse();
			return;
		}

		// --- Static files / SPA fallback ---
		if (method === "GET" || method === "HEAD") {
			const urlPath = decodeURIComponent(url.split("?")[0]);
			const staticPath = safeJoin(webDistDir, urlPath.replace(/^\/+/, ""));
			const sendBody = method === "GET";
			// Try exact file in web/dist
			if (staticPath && serveStatic(req, res, staticPath, sendBody)) return;
			// SPA fallback: serve index.html for non-API paths only. An unmatched
			// /api/* route must fall through to the JSON 404 — returning HTML with
			// a 200 status breaks API client error handling.
			if (urlPath !== "/api" && !urlPath.startsWith("/api/") && serveStatic(req, res, join(webDistDir, "index.html"), sendBody)) return;
		}

		// --- 404 ---
		json(res, 404, { error: "Not found" });
	} catch (err) {
		logger.error({ err }, "unhandled error in HTTP handler");
		json(res, 500, { error: "Internal server error" });
	}
});

// ---------------------------------------------------------------------------
// Terminal WebSocket setup (the bindTerminalWs helper references the lazy
// terminalManager, but the upgrade handler only fires AFTER the first successful
// bootstrap — terminal WebSocket connections can't happen before then).
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
	const url = req.url ?? "";
		if (!bootstrapped) { socket.destroy(); return; }
	const m = /^\/api\/terminal\/sessions\/([^/?]+)\/ws$/.exec(url.split("?")[0]);
	if (!m) {
		socket.destroy();
		return;
	}
	const terminalId = decodeURIComponent(m[1]);
	const ts = terminalManager.get(terminalId);
	if (!ts) {
		socket.destroy();
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		bindTerminalWs(ws, terminalId);
	});
});

function sendTerminal(ws: WebSocket, event: ServerTerminalEvent): void {
	if (ws.readyState === ws.OPEN) {
		ws.send(JSON.stringify(event));
	}
}

function bindTerminalWs(ws: WebSocket, terminalId: string): void {
	const ts = terminalManager.get(terminalId);
	if (!ts) {
		sendTerminal(ws, { type: "error", message: "Terminal not found" });
		ws.close();
		return;
	}

	sendTerminal(ws, { type: "ready", sessionId: ts.sessionId, cwd: ts.cwd, workspaceId: ts.workspaceId });

	const offData = ts.pty.onData((chunk: string) => {
		const { cleaned, finishedRun } = terminalManager.processOutput(ts, chunk);
		if (cleaned) {
			terminalManager.recordOutput(ts, cleaned);
			sendTerminal(ws, { type: "output", data: cleaned });
		}
		if (finishedRun) {
			const run = terminalManager.finishActiveRun(ts, finishedRun.exitCode);
			sendTerminal(ws, { type: "exit", code: finishedRun.exitCode, runId: run?.id });
		}
	});
	const offExit = ts.pty.onExit(({ exitCode, signal }) => {
		const run = terminalManager.finishActiveRun(ts, exitCode, signal ? String(signal) : undefined);
		sendTerminal(ws, { type: "exit", code: exitCode, signal: signal ? String(signal) : undefined, runId: run?.id });
		ws.close();
	});

	ws.on("message", (raw) => {
		let event: ClientTerminalEvent;
		try {
			event = JSON.parse(raw.toString()) as ClientTerminalEvent;
		} catch (err) {
			sendTerminal(ws, { type: "error", message: "Invalid JSON" });
			return;
		}
		switch (event.type) {
			case "input":
				if (typeof event.data === "string") ts.pty.write(event.data);
				break;
			case "resize":
				if (typeof event.cols === "number" && typeof event.rows === "number") {
					ts.pty.resize(event.cols, event.rows);
				}
				break;
			case "run": {
				if (typeof event.command !== "string" || !event.command.trim()) break;
				if (event.command.length > 4096) {
					sendTerminal(ws, { type: "error", message: "Command too long" });
					break;
				}
				const record = terminalManager.startRun(ts, event.command, event.sourceFile);
				sendTerminal(ws, { type: "run_started", runId: record.id, command: event.command });
				break;
			}
			case "close":
				ws.close();
				break;
		}
	});

	ws.on("close", () => {
		offData();
		offExit();
		terminalManager.finishActiveRun(ts, null);
	});
}

// ---------------------------------------------------------------------------
// Start listening immediately — /health and static files work right away.
// All other endpoints call ensureBootstrapped() lazily on first request.
// ---------------------------------------------------------------------------

// Inject persistence callbacks into questionBridge so pending question cards
// survive a full process restart.
questionBridge.setPersistence({
	save: (sessionId, question) => {
		const meta = readSessionQuestionMetadata();
		meta[sessionId] = question;
		writeSessionQuestionMetadata(meta);
	},
	remove: (sessionId) => {
		const meta = readSessionQuestionMetadata();
		if (sessionId in meta) {
			delete meta[sessionId];
			writeSessionQuestionMetadata(meta);
		}
	},
});

server.listen(port, () => {
	console.log(`[inno-server] listening on http://localhost:${port}`);
	console.log(`[inno-server] config: ${paths.configPath}`);
});
