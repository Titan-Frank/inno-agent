import { EventEmitter } from "./event-emitter.js";
import type { DesktopInfo, UpdateStatus } from "../types/desktop.js";

interface UpdaterStoreEvents {
	change: void;
}

/**
 * 桌面端自动更新状态。浏览器环境下 isDesktop=false，UI 应整体隐藏更新区块。
 */
class UpdaterStoreImpl extends EventEmitter<UpdaterStoreEvents> {
	readonly isDesktop = typeof window !== "undefined" && !!window.innoDesktop;
	info: DesktopInfo | null = null;
	status: UpdateStatus = { status: "idle" };
	private initialized = false;

	/** 懒初始化：首次进入关于页时拉取 info/status 并订阅推送。 */
	init(): void {
		if (!this.isDesktop || this.initialized) return;
		this.initialized = true;
		const bridge = window.innoDesktop!;
		void bridge.updater.getInfo().then((info) => {
			this.info = info;
			this.emit("change", undefined);
		}).catch(() => undefined);
		void bridge.updater.getStatus().then((status) => {
			this.status = status;
			this.emit("change", undefined);
		}).catch(() => undefined);
		bridge.updater.onStatusChanged((status) => {
			this.status = status;
			this.emit("change", undefined);
		});
	}

	async check(): Promise<void> {
		if (!this.isDesktop) return;
		await window.innoDesktop!.updater.checkForUpdates().catch(() => undefined);
	}

	async install(): Promise<void> {
		if (!this.isDesktop) return;
		await window.innoDesktop!.updater.quitAndInstall().catch(() => undefined);
	}

	async openDownloadPage(): Promise<void> {
		if (!this.isDesktop) return;
		await window.innoDesktop!.updater.openDownloadPage().catch(() => undefined);
	}
}

export const updaterStore = new UpdaterStoreImpl();
