/**
 * 自动更新模块
 *
 * 检测新版本 → (Windows) 后台自动下载 → 用户点击「重启安装」。
 * macOS 构建当前未签名，electron-updater 拒绝安装未签名更新，
 * 因此 mac 只检测并提示，由 UI 引导用户去 Release 页手动下载。
 * 仅在打包后的生产环境启用。
 */

import { autoUpdater } from "electron-updater";
import { app, ipcMain, shell } from "electron";

const DOWNLOAD_PAGE_URL = "https://github.com/hhyqhh/inno-agent/releases/latest";

/** Windows(NSIS)/Linux(AppImage) 由 electron-updater 自动下载安装；macOS 仅提示（未签名无法安装） */
const canAutoInstall = process.platform === "win32" || process.platform === "linux";

/** 当前更新状态 */
let currentStatus = { status: "idle" };

/** 主窗口引用（用于推送状态） */
let win = null;

/** 定时检查定时器 */
let checkInterval = null;

/** 更新状态并推送给渲染进程 */
function setStatus(status) {
  currentStatus = status;
  win?.webContents?.send("inno:updater:status", status);
}

/** 归一化 releaseNotes（可能是 string 或数组） */
function normalizeReleaseNotes(releaseNotes) {
  if (typeof releaseNotes === "string") return releaseNotes;
  if (Array.isArray(releaseNotes)) {
    return releaseNotes.map((n) => n?.note).filter(Boolean).join("\n");
  }
  return undefined;
}

/** 手动触发检查更新 */
export async function checkForUpdates() {
  if (!app.isPackaged) {
    console.log("[更新] 开发环境，跳过检查");
    return;
  }
  // 已在下载中或已下载完成，不重复检查
  if (currentStatus.status === "downloading" || currentStatus.status === "downloaded") {
    console.log("[更新] 跳过检查：已在下载中或已下载完成");
    return;
  }

  try {
    setStatus({ status: "checking" });
    await autoUpdater.checkForUpdates();
  } catch (err) {
    console.error("[更新] 检查更新失败:", err);
    setStatus({ status: "error", error: err instanceof Error ? err.message : String(err) });
  }
}

/** 退出并安装已下载的更新（仅 Windows 自动更新路径可达） */
export function quitAndInstall() {
  if (!app.isPackaged) {
    console.warn("[更新] 开发环境不支持安装更新");
    return;
  }
  if (currentStatus.status !== "downloaded") {
    console.warn("[更新] 跳过安装：当前没有已下载的更新");
    return;
  }
  // before-quit 已负责 kill 后端子进程
  autoUpdater.quitAndInstall(true, true);
}

/**
 * 初始化自动更新
 *
 * @param mainWindow - 主窗口实例，用于推送更新状态
 */
export function initAutoUpdater(mainWindow) {
  win = mainWindow;

  autoUpdater.logger = {
    info: (...args) => console.log("[更新-updater]", ...args),
    warn: (...args) => console.warn("[更新-updater]", ...args),
    error: (...args) => console.error("[更新-updater]", ...args),
    debug: (...args) => console.log("[更新-updater:debug]", ...args),
  };

  // mac 不自动下载（未签名装不上，避免浪费带宽）；下载后也不在退出时自动安装，
  // 由用户在设置页明确点击「重启安装」。
  autoUpdater.autoDownload = canAutoInstall;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => {
    console.log("[更新] 正在检查更新...");
    setStatus({ status: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    console.log("[更新] 发现新版本:", info.version);
    setStatus({
      status: "available",
      version: info.version,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    setStatus({
      status: "downloading",
      version: currentStatus.version || "",
      progress: {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      },
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("[更新] 下载完成:", info.version);
    setStatus({ status: "downloaded", version: info.version });
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[更新] 已是最新版本");
    setStatus({ status: "not-available" });
  });

  autoUpdater.on("error", (err) => {
    console.error("[更新] 更新出错:", err);
    setStatus({ status: "error", error: err.message });
  });

  // 启动后延迟 10 秒首次检查
  setTimeout(() => {
    console.log("[更新] 首次自动检查更新");
    checkForUpdates();
  }, 10_000);

  // 每 4 小时自动检查一次
  checkInterval = setInterval(() => {
    console.log("[更新] 定时自动检查更新");
    checkForUpdates();
  }, 4 * 60 * 60 * 1000);

  // 窗口关闭时清理定时器
  mainWindow.on("closed", () => {
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
    }
    win = null;
  });

  console.log(`[更新] 自动更新模块已初始化（${canAutoInstall ? "自动下载" : "仅检测提示"}）`);
}

/** 注册更新相关 IPC 处理器（供 preload 调用） */
export function registerUpdaterIpc() {
  ipcMain.handle("inno:updater:get-info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    enabled: app.isPackaged,
    canAutoInstall: app.isPackaged && canAutoInstall,
  }));

  ipcMain.handle("inno:updater:get-status", () => currentStatus);

  ipcMain.handle("inno:updater:check", async () => {
    await checkForUpdates();
  });

  ipcMain.handle("inno:updater:quit-and-install", () => {
    quitAndInstall();
  });

  ipcMain.handle("inno:updater:open-download-page", () => {
    shell.openExternal(DOWNLOAD_PAGE_URL);
  });
}
