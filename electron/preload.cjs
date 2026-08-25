const { contextBridge, ipcRenderer, webUtils } = require("electron");

function isCloseDialogCopy(value) {
  if (!value || typeof value !== "object") return false;
  const copy = value;
  const buttons = copy.buttons;
  return typeof copy.title === "string"
    && typeof copy.message === "string"
    && typeof copy.detail === "string"
    && typeof copy.remember === "string"
    && buttons
    && typeof buttons === "object"
    && typeof buttons.hide === "string"
    && typeof buttons.quit === "string"
    && typeof buttons.cancel === "string";
}

function isWindowExpansionSide(value) {
  return value === "left" || value === "right";
}

contextBridge.exposeInMainWorld("innoDesktop", {
  setCloseDialogCopy(copy) {
    if (isCloseDialogCopy(copy)) {
      ipcRenderer.send("inno-close-dialog-copy", copy);
    }
  },
  async openLocalFile(file) {
    if (!file || typeof file !== "object") return false;
    let path = "";
    try {
      path = webUtils.getPathForFile(file) || "";
    } catch {
      path = "";
    }
    if (!path) return false;
    const error = await ipcRenderer.invoke("inno-open-path", path);
    return typeof error === "string" && error.length === 0;
  },
  expandWindowWidth(side, additionalWidth) {
    if (!isWindowExpansionSide(side) || !Number.isFinite(additionalWidth) || additionalWidth < 0) {
      return Promise.resolve(false);
    }
    return ipcRenderer.invoke("inno-expand-window-width", { side, additionalWidth });
  },
  getWindowWidthCapacity(side) {
    if (!isWindowExpansionSide(side)) return Promise.resolve(0);
    return ipcRenderer.invoke("inno-window-width-capacity", side);
  },
});
