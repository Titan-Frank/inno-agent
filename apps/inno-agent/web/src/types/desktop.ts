/**
 * 桌面端（Electron）能力桥的类型声明。
 *
 * electron/preload.cjs 通过 contextBridge 注入 window.innoDesktop；
 * 浏览器访问时为 undefined，所有桌面 UI 必须先做存在性判断。
 */

export type UpdateStatus =
	| { status: "idle" }
	| { status: "checking" }
	| { status: "available"; version: string; releaseNotes?: string }
	| { status: "downloading"; version: string; progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } }
	| { status: "downloaded"; version: string }
	| { status: "not-available" }
	| { status: "error"; error: string };

export interface DesktopInfo {
	version: string;
	platform: string;
	/** 打包环境才为 true（开发环境不启用自动更新） */
	enabled: boolean;
	/** Windows 自动下载安装路径；mac 未签名仅提示 */
	canAutoInstall: boolean;
}

export interface InnoDesktopBridge {
	updater: {
		getInfo: () => Promise<DesktopInfo>;
		getStatus: () => Promise<UpdateStatus>;
		checkForUpdates: () => Promise<void>;
		quitAndInstall: () => Promise<void>;
		openDownloadPage: () => Promise<void>;
		onStatusChanged: (callback: (status: UpdateStatus) => void) => () => void;
	};
}

declare global {
	interface Window {
		innoDesktop?: InnoDesktopBridge;
	}
}
