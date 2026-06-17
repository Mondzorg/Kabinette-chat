const http = require("http");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const fsSync = require("fs");
const path = require("path");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 4780);
const AUTH_TOKEN = String(process.env.KABINETTE_TOKEN || "");
const PUBLIC_UPDATE_URL = String(process.env.KABINETTE_PUBLIC_UPDATE_URL || "");
const PUBLIC_HOST = String(process.env.KABINETTE_PUBLIC_HOST || "");
const FIREWALL_RULE_NAME = `Kabinette Realtime Server ${PORT}`;
const STATE_PATH = process.env.KABINETTE_STATE_PATH || path.join(process.cwd(), "kabinette-server-state.json");
const clients = new Map();
const admins = new Set();
const state = {
  clients: {},
  updateQueue: {},
  chatMessages: []
};
let installerInfoCache = null;
const UPDATE_PROTOCOL_VERSION = 2;

process.on("uncaughtException", (error) => {
  console.error(`Onverwachte serverfout opgevangen: ${error.stack || error.message}`);
});

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error(`Onverwachte async serverfout opgevangen: ${message}`);
});

function loadState() {
  try {
    const saved = JSON.parse(fsSync.readFileSync(STATE_PATH, "utf8"));
    state.clients = saved.clients && typeof saved.clients === "object" ? saved.clients : {};
    state.updateQueue = saved.updateQueue && typeof saved.updateQueue === "object" ? saved.updateQueue : {};
    state.chatMessages = Array.isArray(saved.chatMessages) ? saved.chatMessages.slice(-500) : [];
    for (const client of Object.values(state.clients)) {
      clients.set(client.id, { ...client, ws: null });
    }
  } catch {
    saveState();
  }
}

let saveTimer = null;

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const clientsToSave = {};
      for (const client of clients.values()) {
        clientsToSave[client.id] = clientView(client);
      }

      const stateDir = path.dirname(STATE_PATH);
      const tempPath = `${STATE_PATH}.tmp`;
      fsSync.mkdirSync(stateDir, { recursive: true });
      fsSync.writeFileSync(tempPath, JSON.stringify({
        clients: clientsToSave,
        updateQueue: state.updateQueue,
        chatMessages: state.chatMessages.slice(-500)
      }, null, 2));
      fsSync.renameSync(tempPath, STATE_PATH);
    } catch (error) {
      console.warn(`State kon niet worden opgeslagen: ${error.message}`);
    }
  }, 80);
}

function now() {
  return new Date().toISOString();
}

function json(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (error) {
    console.warn(`WebSocket bericht kon niet worden verzonden: ${error.message}`);
    return false;
  }
}

function snapshot() {
  return [...clients.values()].map((client) => ({
    id: client.id,
    cabinetName: client.cabinetName,
    computerName: client.computerName,
    userName: client.userName,
    note: client.note,
    online: Boolean(client.ws && client.ws.readyState === client.ws.OPEN),
    updateQueued: Boolean(state.updateQueue[client.id]),
    updatedAt: client.updatedAt,
    connectedAt: client.connectedAt
  }));
}

function broadcastAdmins(payload) {
  for (const admin of admins) json(admin, payload);
}

function clientView(client) {
  return { ...client, ws: undefined, online: Boolean(client.ws && client.ws.readyState === client.ws.OPEN) };
}

function isLoopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return !host || host === "localhost" || host === "0.0.0.0" || host === "::" || host === "::1" || host.startsWith("127.");
}

function localLanAddress() {
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces || []) {
      if (item.family === "IPv4" && !item.internal) return item.address;
    }
  }
  return os.hostname();
}

function hostWithPort(hostname, port) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "");
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return port ? `${formattedHost}:${port}` : formattedHost;
}

function updateUrlFromHost(host, protocol = "http:") {
  const parsedHost = String(host || "").trim();
  let hostname = parsedHost;
  let port = String(PORT);
  if (parsedHost) {
    try {
      const parsed = new URL(`${protocol}//${parsedHost}`);
      hostname = parsed.hostname;
      port = parsed.port || String(PORT);
    } catch {
      hostname = parsedHost.replace(/:\d+$/, "");
      const match = parsedHost.match(/:(\d+)$/);
      if (match) port = match[1];
    }
  }
  if (isLoopbackHost(hostname)) hostname = localLanAddress();
  return `${protocol}//${hostWithPort(hostname, port)}/updates/client.exe`;
}

function resolveUpdateUrl(requestedUrl, ws) {
  if (PUBLIC_UPDATE_URL) return PUBLIC_UPDATE_URL;
  if (PUBLIC_HOST) return updateUrlFromHost(PUBLIC_HOST);

  try {
    const parsed = new URL(String(requestedUrl || ""));
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !isLoopbackHost(parsed.hostname)) {
      parsed.pathname = "/updates/client.exe";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
    return updateUrlFromHost(parsed.host, parsed.protocol);
  } catch {
    return updateUrlFromHost(ws?.requestHost);
  }
}

function peerSnapshot(forClientId) {
  return snapshot()
    .filter((client) => client.id !== forClientId)
    .map((client) => ({
      id: client.id,
      cabinetName: client.cabinetName,
      computerName: client.computerName,
      userName: client.userName,
      online: client.online
    }));
}

function broadcastPeers() {
  for (const client of clients.values()) {
    if (client.ws && client.ws.readyState === client.ws.OPEN) {
      json(client.ws, { type: "peers", peers: peerSnapshot(client.id) });
    }
  }
}

function chatView(message) {
  return {
    id: message.id,
    clientMessageId: message.clientMessageId || "",
    fromClientId: message.fromClientId,
    fromName: message.fromName,
    fromComputer: message.fromComputer,
    toClientId: message.toClientId,
    text: message.text,
    createdAt: message.createdAt
  };
}

function recentChatFor(clientId) {
  return state.chatMessages
    .filter((message) => message.fromClientId === clientId || message.toClientId === clientId)
    .slice(-150)
    .map(chatView);
}

function migrateChatClientId(fromClientId, toClientId) {
  if (!fromClientId || !toClientId || fromClientId === toClientId) return false;
  let changed = false;
  for (const message of state.chatMessages) {
    if (message.fromClientId === fromClientId) {
      message.fromClientId = toClientId;
      changed = true;
    }
    if (message.toClientId === fromClientId) {
      message.toClientId = toClientId;
      changed = true;
    }
  }
  return changed;
}

function deliverPendingChat(client) {
  if (!client.ws || client.ws.readyState !== client.ws.OPEN) return;
  let changed = false;
  for (const message of state.chatMessages) {
    if (message.toClientId === client.id && !message.deliveredAt) {
      json(client.ws, { type: "chat:message", message: chatView(message) });
      message.deliveredAt = now();
      changed = true;
    }
  }
  if (changed) saveState();
}

function queueOrSendUpdate(client, updateUrl) {
  if (!client) return "missing";
  const updateInfo = clientInstallerInfo();
  const includeVersion = Number(client.updateProtocolVersion || 0) >= UPDATE_PROTOCOL_VERSION;
  const message = { type: "client:update-install", url: updateUrl };
  if (includeVersion) message.version = updateInfo?.version || "";
  if (client.ws && client.ws.readyState === client.ws.OPEN) {
    json(client.ws, message);
    delete state.updateQueue[client.id];
    return "sent";
  }
  state.updateQueue[client.id] = { ...message, requestedAt: now() };
  return "queued";
}

function deliverQueuedUpdate(client) {
  const queued = state.updateQueue[client.id];
  if (!queued) return;
  if (client.ws && client.ws.readyState === client.ws.OPEN) {
    const includeVersion = Number(client.updateProtocolVersion || 0) >= UPDATE_PROTOCOL_VERSION;
    const message = { type: "client:update-install", url: queued.url };
    if (includeVersion) message.version = queued.version || clientInstallerInfo()?.version || "";
    json(client.ws, message);
    delete state.updateQueue[client.id];
    saveState();
  }
}

function isAuthorized(message) {
  return !AUTH_TOKEN || message.authToken === AUTH_TOKEN;
}

function ensureFirewallRule() {
  if (process.platform !== "win32" || process.env.KABINETTE_SKIP_FIREWALL === "1") return;

  const addArgs = [
    "advfirewall",
    "firewall",
    "add",
    "rule",
    `name=${FIREWALL_RULE_NAME}`,
    "dir=in",
    "action=allow",
    "protocol=TCP",
    `localport=${PORT}`,
    "profile=private,domain"
  ];

  execFile("netsh", ["advfirewall", "firewall", "show", "rule", `name=${FIREWALL_RULE_NAME}`], (showError) => {
    if (!showError) {
      console.log(`Firewall rule bestaat al: ${FIREWALL_RULE_NAME}`);
      return;
    }

    execFile("netsh", addArgs, (addError) => {
      if (!addError) {
        console.log(`Firewall rule toegevoegd: TCP ${PORT}`);
        return;
      }

      console.warn(`Firewall rule kon niet automatisch worden toegevoegd voor TCP ${PORT}.`);
      console.warn("Start de server eenmalig als administrator of voer dit uit in PowerShell als administrator:");
      console.warn(`netsh advfirewall firewall add rule name="${FIREWALL_RULE_NAME}" dir=in action=allow protocol=TCP localport=${PORT} profile=private,domain`);
    });
  });
}

function clientInstallerPath() {
  const exeDir = path.dirname(process.execPath);
  const candidates = [
    process.env.KABINETTE_CLIENT_INSTALLER,
    path.join(process.cwd(), "client-installer.exe"),
    path.join(process.cwd(), "dist", "client-installer.exe"),
    path.join(process.cwd(), "Kabinette Notes Client Setup 0.1.0.exe"),
    path.join(process.cwd(), "dist", "client", "Kabinette Notes Client Setup 0.1.0.exe"),
    path.join(exeDir, "client-installer.exe"),
    path.join(exeDir, "Kabinette Notes Client Setup 0.1.0.exe"),
    path.join(exeDir, "client", "Kabinette Notes Client Setup 0.1.0.exe")
  ].filter(Boolean);

  return candidates.find((candidate) => fsSync.existsSync(candidate));
}

function clientInstallerInfo() {
  const installerPath = clientInstallerPath();
  if (!installerPath) return null;
  try {
    const stat = fsSync.statSync(installerPath);
    const cacheKey = `${installerPath}:${stat.size}:${stat.mtimeMs}`;
    let hash = installerInfoCache?.key === cacheKey ? installerInfoCache.hash : "";
    if (!hash) {
      hash = crypto.createHash("sha256").update(fsSync.readFileSync(installerPath)).digest("hex");
      installerInfoCache = { key: cacheKey, hash };
    }
    const versionCandidates = [
      process.env.KABINETTE_CLIENT_UPDATE_VERSION,
      `${installerPath}.version`,
      path.join(path.dirname(installerPath), "client-installer.version"),
      path.join(path.dirname(installerPath), "client-setup.version")
    ].filter(Boolean);
    let version = "";
    for (const candidate of versionCandidates) {
      if (candidate === process.env.KABINETTE_CLIENT_UPDATE_VERSION) {
        version = String(candidate || "").trim();
      } else {
        try {
          version = fsSync.readFileSync(candidate, "utf8").trim();
        } catch {
          version = "";
        }
      }
      if (version) break;
    }
    return {
      path: installerPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      version: version || `sha256:${hash}`
    };
  } catch {
    return null;
  }
}

function parseAppUpdateVersion(version) {
  const match = String(version || "").match(/^app:(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return match.slice(1).map((item) => Number(item));
}

function isUpdateNewer(availableVersion, installedVersion) {
  const available = String(availableVersion || "");
  const installed = String(installedVersion || "");
  if (!available) return false;
  if (!installed) return true;
  if (available === installed) return false;

  const availableApp = parseAppUpdateVersion(available);
  const installedApp = parseAppUpdateVersion(installed);
  if (availableApp && installedApp) {
    for (let index = 0; index < availableApp.length; index += 1) {
      if (availableApp[index] > installedApp[index]) return true;
      if (availableApp[index] < installedApp[index]) return false;
    }
    return false;
  }

  return true;
}

function updateAvailablePayload(ws, installedVersion = "", includeVersion = false) {
  const info = clientInstallerInfo();
  if (!info) return null;
  if (!isUpdateNewer(info.version, installedVersion)) return null;
  const payload = {
    type: "update:available",
    updateUrl: resolveUpdateUrl("", ws),
    size: info.size,
    modifiedAt: new Date(info.mtimeMs).toISOString()
  };
  if (includeVersion) payload.version = info.version;
  return payload;
}

function notifyClientsAboutUpdate() {
  for (const client of clients.values()) {
    if (client.ws && client.ws.readyState === client.ws.OPEN) {
      const payload = updateAvailablePayload(
        client.ws,
        client.installedUpdateVersion || "",
        Number(client.updateProtocolVersion || 0) >= UPDATE_PROTOCOL_VERSION
      );
      if (payload) json(client.ws, payload);
    }
  }
}

function clientSetupInstallerPath() {
  const exeDir = path.dirname(process.execPath);
  const candidates = [
    process.env.KABINETTE_CLIENT_SETUP,
    path.join(process.cwd(), "client-setup.exe"),
    path.join(process.cwd(), "dist", "client-setup.exe"),
    path.join(process.cwd(), "Kabinette Notes Client Setup 0.1.0.exe"),
    path.join(process.cwd(), "dist", "client", "Kabinette Notes Client Setup 0.1.0.exe"),
    path.join(exeDir, "client-setup.exe"),
    path.join(exeDir, "Kabinette Notes Client Setup 0.1.0.exe"),
    path.join(exeDir, "client", "Kabinette Notes Client Setup 0.1.0.exe")
  ].filter(Boolean);

  return candidates.find((candidate) => fsSync.existsSync(candidate));
}

function upsertClient(ws, message) {
  const incomingComputer = String(message.computerName || "").toLowerCase();
  let duplicateClient = null;
  let duplicateUpdate = null;
  let chatIdsMigrated = false;
  if (incomingComputer) {
    for (const [id, existingClient] of clients) {
      const existingComputer = String(existingClient.computerName || "").toLowerCase();
      if (id !== message.id && existingComputer === incomingComputer) {
        duplicateClient = duplicateClient || existingClient;
        duplicateUpdate = duplicateUpdate || state.updateQueue[id];
        chatIdsMigrated = migrateChatClientId(id, message.id) || chatIdsMigrated;
        if (existingClient.ws && existingClient.ws !== ws) {
          json(existingClient.ws, { type: "duplicate:closed" });
          existingClient.ws.close(4001, "Duplicate client");
        }
        clients.delete(id);
        delete state.updateQueue[id];
      }
    }
  }

  const existing = clients.get(message.id) || duplicateClient;
  const incomingNote = typeof message.note === "string" ? message.note : null;
  const note = existing?.note ?? incomingNote ?? "";
  const client = {
    id: message.id,
    cabinetName: message.cabinetName || existing?.cabinetName || message.computerName || "Kabinet",
    computerName: message.computerName || existing?.computerName || "Onbekend",
    userName: message.userName || existing?.userName || "Onbekend",
    installedUpdateVersion: String(message.installedUpdateVersion || existing?.installedUpdateVersion || ""),
    updateProtocolVersion: Number(message.updateProtocolVersion || existing?.updateProtocolVersion || 0),
    note,
    updatedAt: now(),
    connectedAt: existing?.connectedAt || now(),
    ws
  };
  clients.set(client.id, client);
  if (duplicateUpdate && !state.updateQueue[client.id]) state.updateQueue[client.id] = duplicateUpdate;
  ws.clientId = client.id;
  saveState();
  broadcastAdmins({ type: "clients", clients: snapshot() });
  broadcastPeers();
  if (chatIdsMigrated) deliverPendingChat(client);
  return client;
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (requestUrl.pathname === "/health") {
    const updateInfo = clientInstallerInfo();
    const installedUpdateVersion = requestUrl.searchParams.get("installedUpdateVersion") || "";
    const includeVersion = Number(requestUrl.searchParams.get("updateProtocol") || 0) >= UPDATE_PROTOCOL_VERSION;
    const hasNewUpdate = Boolean(updateInfo && isUpdateNewer(updateInfo.version, installedUpdateVersion));
    res.writeHead(200, {
      "content-type": "application/json",
      "access-control-allow-origin": "*"
    });
    res.end(JSON.stringify({
      ok: true,
      clients: clients.size,
      admins: admins.size,
      authEnabled: Boolean(AUTH_TOKEN),
      updateAvailable: hasNewUpdate,
      updateVersion: includeVersion ? updateInfo?.version || "" : "",
      updateSize: updateInfo?.size || 0,
      updateModifiedAt: updateInfo ? new Date(updateInfo.mtimeMs).toISOString() : "",
      updateUrl: hasNewUpdate ? resolveUpdateUrl(`http://${req.headers.host || ""}`, { requestHost: req.headers.host || "" }) : ""
    }));
    return;
  }

  if (req.url === "/updates/client.exe" || req.url === "/updates/client-setup.exe") {
    const installerPath = req.url === "/updates/client-setup.exe"
      ? clientSetupInstallerPath()
      : clientInstallerPath();
    if (!installerPath) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Client installer niet gevonden op de server.\n");
      return;
    }

    res.writeHead(200, {
      "content-type": "application/vnd.microsoft.portable-executable",
      "content-length": fsSync.statSync(installerPath).size
    });
    fsSync.createReadStream(installerPath).pipe(res);
    return;
  }

  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("Kabinette realtime server is actief.\n");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  ws.requestHost = req.headers.host || "";
  ws.on("message", (raw) => {
    try {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        json(ws, { type: "error", message: "Ongeldig JSON bericht." });
        return;
      }

    if (message.type === "hello" && !isAuthorized(message)) {
      json(ws, { type: "error", message: "Niet gemachtigd." });
      ws.close(1008, "Niet gemachtigd");
      return;
    }

    if (message.type === "hello" && message.role === "admin") {
      admins.add(ws);
      json(ws, { type: "clients", clients: snapshot() });
      return;
    }

    if (message.type === "hello" && message.role === "probe") {
      json(ws, {
        type: "probe:ready",
        clients: clients.size,
        admins: admins.size,
        authEnabled: Boolean(AUTH_TOKEN),
        serverTime: now()
      });
      return;
    }

    if (message.type === "hello" && message.role === "client") {
      const client = upsertClient(ws, message);
      json(ws, { type: "ready", serverTime: now() });
      json(ws, { type: "note:set", note: client.note || "", notify: false });
      json(ws, { type: "peers", peers: peerSnapshot(client.id) });
      deliverPendingChat(client);
      json(ws, { type: "chat:history", messages: recentChatFor(client.id) });
      deliverQueuedUpdate(client);
      const updatePayload = updateAvailablePayload(
        ws,
        String(message.installedUpdateVersion || ""),
        Number(message.updateProtocolVersion || 0) >= UPDATE_PROTOCOL_VERSION
      );
      if (updatePayload) json(ws, updatePayload);
      return;
    }

    if (message.type === "note:update" && ws.clientId) {
      const client = clients.get(ws.clientId);
      if (!client) return;
      client.note = String(message.note || "");
      client.updatedAt = now();
      saveState();
      broadcastAdmins({
        type: "client:update",
        source: "client",
        notify: Boolean(message.notify),
        client: { ...client, ws: undefined, online: true }
      });
      return;
    }

    if (message.type === "chat:send" && ws.clientId) {
      const sender = clients.get(ws.clientId);
      const recipient = clients.get(message.toClientId);
      const text = String(message.text || "").trim();
      const clientMessageId = String(message.clientMessageId || "").slice(0, 120);
      if (!sender || sender.ws !== ws) return;
      if (!recipient || !text) {
        json(ws, { type: "chat:error", clientMessageId, message: "Ontvanger niet gevonden of bericht is leeg." });
        return;
      }

      if (clientMessageId) {
        const existingMessage = state.chatMessages.find((item) => (
          item.fromClientId === sender.id && item.clientMessageId === clientMessageId
        ));
        if (existingMessage) {
          json(ws, { type: "chat:message", message: chatView(existingMessage) });
          if (!existingMessage.deliveredAt && json(recipient.ws, { type: "chat:message", message: chatView(existingMessage) })) {
            existingMessage.deliveredAt = now();
            saveState();
          }
          return;
        }
      }

      const chatMessage = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        clientMessageId,
        fromClientId: sender.id,
        fromName: sender.cabinetName || sender.computerName,
        fromComputer: sender.computerName,
        toClientId: recipient.id,
        text: text.slice(0, 1000),
        createdAt: now(),
        deliveredAt: null
      };

      state.chatMessages.push(chatMessage);
      if (state.chatMessages.length > 500) state.chatMessages.splice(0, state.chatMessages.length - 500);
      json(ws, { type: "chat:message", message: chatView(chatMessage) });

      if (json(recipient.ws, { type: "chat:message", message: chatView(chatMessage) })) {
        chatMessage.deliveredAt = now();
      }

      saveState();
      return;
    }

    if (message.type === "client:rename" && admins.has(ws)) {
      const client = clients.get(message.clientId);
      if (!client) return;
      client.cabinetName = String(message.cabinetName || client.cabinetName).trim() || client.cabinetName;
      client.updatedAt = now();
      if (client.ws) json(client.ws, { type: "settings", cabinetName: client.cabinetName });
      saveState();
      broadcastAdmins({ type: "clients", clients: snapshot() });
      broadcastPeers();
      return;
    }

    if (message.type === "client:remove" && admins.has(ws)) {
      const client = clients.get(message.clientId);
      if (!client) return;
      if (client.ws && client.ws.readyState === client.ws.OPEN && !message.force) {
        json(ws, { type: "error", message: "Online clients kunnen niet stil verwijderd worden." });
        return;
      }
      if (client.ws && client.ws.readyState === client.ws.OPEN) client.ws.close(4002, "Removed by admin");
      clients.delete(message.clientId);
      delete state.updateQueue[message.clientId];
      saveState();
      broadcastAdmins({ type: "clients", clients: snapshot() });
      broadcastPeers();
      return;
    }

    if (message.type === "client:update" && admins.has(ws)) {
      if (!clientInstallerPath()) {
        json(ws, { type: "error", message: "Client installer niet gevonden op de server. Zet client-installer.exe naast de server of in dist/client." });
        return;
      }
      const updateUrl = resolveUpdateUrl(message.url, ws);
      const targets = message.clientId ? [clients.get(message.clientId)] : [...clients.values()];
      let sentCount = 0;
      let queuedCount = 0;
      for (const client of targets) {
        const result = queueOrSendUpdate(client, updateUrl);
        if (result === "sent") sentCount += 1;
        if (result === "queued") queuedCount += 1;
      }
      saveState();
      broadcastAdmins({ type: "clients", clients: snapshot() });
      json(ws, {
        type: "update:queued",
        targetCount: sentCount + queuedCount,
        sentCount,
        queuedCount,
        updateUrl
      });
      return;
    }

    if (message.type === "admin:note" && admins.has(ws)) {
      const client = clients.get(message.clientId);
      if (!client) return;
      client.note = String(message.note || "");
      client.updatedAt = now();
      if (client.ws) json(client.ws, { type: "note:set", note: client.note, notify: Boolean(message.notify) });
      saveState();
      broadcastAdmins({ type: "client:update", source: "admin", client: clientView(client) });
    }
    } catch (error) {
      console.error(`Serverfout bij verwerken van ${ws.clientId || "onbekende verbinding"}: ${error.stack || error.message}`);
      json(ws, { type: "error", message: "Server kon dit bericht niet verwerken." });
    }
  });

  ws.on("close", () => {
    admins.delete(ws);
    if (ws.clientId && clients.has(ws.clientId)) {
      const client = clients.get(ws.clientId);
      if (client.ws !== ws) return;
      client.ws = null;
      client.updatedAt = now();
      saveState();
      broadcastAdmins({ type: "clients", clients: snapshot() });
      broadcastPeers();
    }
  });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Poort ${PORT} is al in gebruik. Start met een andere poort, bijvoorbeeld:`);
    console.error(`$env:PORT="4790"; .\\KabinetteServer.exe`);
    return;
  }
  console.error("Server kon niet starten:", error.message);
});

ensureFirewallRule();
loadState();

let lastInstallerVersion = clientInstallerInfo()?.version || "";
setInterval(() => {
  const version = clientInstallerInfo()?.version || "";
  if (!version || version === lastInstallerVersion) return;
  lastInstallerVersion = version;
  notifyClientsAboutUpdate();
}, 30000).unref?.();

server.listen(PORT, "0.0.0.0", () => {
  const nets = Object.values(os.networkInterfaces()).flat().filter(Boolean);
  const ips = nets.filter((net) => net.family === "IPv4" && !net.internal).map((net) => net.address);
  console.log(`Kabinette realtime server: ws://localhost:${PORT}`);
  console.log(`Auth token: ${AUTH_TOKEN ? "aan" : "uit"}`);
  for (const ip of ips) console.log(`LAN: ws://${ip}:${PORT}`);
});
