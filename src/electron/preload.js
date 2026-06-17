const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kabinette", {
  meta: () => ipcRenderer.invoke("app:meta"),
  saveNote: (note) => ipcRenderer.invoke("note:save", note),
  updateConfig: (patch) => ipcRenderer.invoke("config:update", patch),
  loadChatOutbox: () => ipcRenderer.invoke("chat-outbox:load"),
  saveChatOutbox: (items) => ipcRenderer.invoke("chat-outbox:save", items),
  loadChatHistory: () => ipcRenderer.invoke("chat-history:load"),
  saveChatHistory: (items) => ipcRenderer.invoke("chat-history:save", items),
  focusWindow: () => ipcRenderer.invoke("window:focus"),
  setClientPanelOpen: (open) => ipcRenderer.invoke("client-window:set-open", open),
  setClientInputPassThrough: (passThrough) => ipcRenderer.invoke("client-window:set-input-passthrough", passThrough),
  setClientEdgeTabTop: (top) => ipcRenderer.invoke("client-window:set-edge-tab-top", top),
  previewClientEdgeDrag: (position) => ipcRenderer.invoke("client-window:preview-edge-drag", position),
  setClientEdgeTabPosition: (position) => ipcRenderer.invoke("client-window:set-edge-tab-position", position),
  installUpdate: (updateUrl, updateVersion) => ipcRenderer.invoke("client:update-install", updateUrl, updateVersion),
  quitApp: () => ipcRenderer.invoke("app:quit"),
  onWindowBlur: (callback) => {
    ipcRenderer.on("window:blur", callback);
  },
  onClientPanelOpen: (callback) => {
    ipcRenderer.on("client-panel:open", callback);
  }
});
