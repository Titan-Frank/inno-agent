/**
 * Preload 脚本：以 contextBridge 向 web UI 暴露桌面端能力。
 *
 * web UI 通过 window.innoDesktop 感知自己运行在 Electron 中；
 * 浏览器访问时该对象为 undefined，所有桌面能力按不可用降级。
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("innoDesktop", {
  updater: {
    /** 获取版本/平台/更新器可用性信息 */
    getInfo: () => ipcRenderer.invoke("inno:updater:get-info"),
    /** 获取当前更新状态 */
    getStatus: () => ipcRenderer.invoke("inno:updater:get-status"),
    /** 手动触发检查更新 */
    checkForUpdates: () => ipcRenderer.invoke("inno:updater:check"),
    /** 重启并安装已下载的更新 */
    quitAndInstall: () => ipcRenderer.invoke("inno:updater:quit-and-install"),
    /** 打开 Release 下载页（mac 手动下载路径） */
    openDownloadPage: () => ipcRenderer.invoke("inno:updater:open-download-page"),
    /** 订阅更新状态推送，返回取消订阅函数 */
    onStatusChanged: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on("inno:updater:status", listener);
      return () => {
        ipcRenderer.removeListener("inno:updater:status", listener);
      };
    },
  },
});
