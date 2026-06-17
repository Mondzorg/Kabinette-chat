(async () => {
  const meta = await window.kabinette.meta();
  const note = document.getElementById("note");
  const panel = document.getElementById("panel");
  const edgeTab = document.getElementById("edgeTab");
  const edgeBadge = document.getElementById("edgeBadge");
  const updateToast = document.getElementById("updateToast");
  const installToastUpdateButton = document.getElementById("installToastUpdateButton");
  const chatTargetPicker = document.getElementById("chatTargetPicker");
  const chatTargetButton = document.getElementById("chatTargetButton");
  const chatTargetMenu = document.getElementById("chatTargetMenu");
  const chatPanel = document.getElementById("chatPanel");
  const chatPeerName = document.getElementById("chatPeerName");
  const chatMessages = document.getElementById("chatMessages");
  const chatInput = document.getElementById("chatInput");
  const sendChatButton = document.getElementById("sendChatButton");
  const closeChatButton = document.getElementById("closeChatButton");
  const settingsButton = document.getElementById("settingsButton");
  const settingsPanel = document.getElementById("settingsPanel");
  const clientServerUrl = document.getElementById("clientServerUrl");
  const clientAuthToken = document.getElementById("clientAuthToken");
  const clientCabinetName = document.getElementById("clientCabinetName");
  const clientConnectionDetail = document.getElementById("clientConnectionDetail");
  const clientComputerName = document.getElementById("clientComputerName");
  const clientUserName = document.getElementById("clientUserName");
  const cancelSettingsButton = document.getElementById("cancelSettingsButton");
  const testConnectionButton = document.getElementById("testConnectionButton");
  const saveSettingsButton = document.getElementById("saveSettingsButton");
  const cabinetName = document.getElementById("cabinetName");
  const connectionState = document.getElementById("connectionState");

  let socket;
  let reconnectTimer;
  let saveTimer;
  let remoteSet = false;
  let isOpen = false;
  let closeTimer;
  let resizeTimer;
  let edgeDrag = null;
  let pendingAdminNotification = false;
  let pendingUpdateUrl = null;
  let availableUpdate = null;
  let updateInProgress = false;
  let activeChatPeerId = "";
  const peers = new Map();
  const localPeers = new Map();
  const unreadByPeer = new Map();
  const chatLog = [];
  const chatIds = new Set();
  const maxChatLogItems = 500;
  let latestNote = meta.note || "";
  let config = meta.config;
  let ownClientIds = new Set([config.clientId, ...(config.previousClientIds || [])].filter(Boolean));
  let chatOutbox = await window.kabinette.loadChatOutbox();
  const localChatHistory = await window.kabinette.loadChatHistory();
  let edgeTop = Number.isFinite(Number(config.edgeTabTop))
    ? Number(config.edgeTabTop)
    : Math.round((window.screen?.availHeight || window.innerHeight) * 0.46);
  let edgeSide = config.edgeTabSide === "left" ? "left" : "right";
  let edgeDisplayBounds = config.edgeDisplayBounds || null;
  let edgeMoveRequestId = 0;
  let inputPassThrough = null;

  note.value = latestNote;
  cabinetName.textContent = config.cabinetName;
  clientComputerName.textContent = `PC: ${meta.computerName}`;
  clientUserName.textContent = `Gebruiker: ${meta.userName}`;

  function setConfig(nextConfig) {
    config = nextConfig;
    ownClientIds = new Set([config.clientId, ...(config.previousClientIds || [])].filter(Boolean));
    edgeSide = config.edgeTabSide === "left" ? "left" : "right";
    edgeDisplayBounds = config.edgeDisplayBounds || edgeDisplayBounds;
    document.body.classList.toggle("edge-side-left", edgeSide === "left");
  }

  setConfig(config);

  function fillSettings() {
    clientServerUrl.value = config.serverUrl || "ws://localhost:4780";
    clientAuthToken.value = config.authToken || "";
    clientCabinetName.value = config.cabinetName || meta.computerName;
  }

  function setConnectionDetail(text, state) {
    clientConnectionDetail.textContent = text;
    clientConnectionDetail.dataset.state = state || "";
  }

  function setInputPassThrough(passThrough) {
    const next = Boolean(passThrough);
    if (inputPassThrough === next) return;
    inputPassThrough = next;
    window.kabinette.setClientInputPassThrough(next).catch(() => {
      inputPassThrough = null;
    });
  }

  function focusWhenWindowActive(element, delay = 0) {
    setTimeout(() => {
      if (document.hasFocus()) element.focus();
    }, delay);
  }

  function peerName(peerId) {
    const peer = peers.get(peerId) || localPeers.get(peerId);
    if (!peer) return "Onbekend";
    return `${peer.cabinetName || peer.computerName} (${peer.computerName})`;
  }

  function peerShortName(peerId) {
    const peer = peers.get(peerId) || localPeers.get(peerId);
    return peer ? peer.cabinetName || peer.computerName || "Vorige chat" : "Vorige chat";
  }

  function rememberLocalPeer(peer) {
    if (!peer?.id || ownClientIds.has(peer.id) || peers.has(peer.id)) return;
    const existing = localPeers.get(peer.id);
    if (!existing || existing.cabinetName === "Vorige chat") localPeers.set(peer.id, { ...existing, ...peer });
  }

  function rememberPeersFromMessage(message) {
    if (message.fromClientId && !ownClientIds.has(message.fromClientId)) {
      rememberLocalPeer({
        id: message.fromClientId,
        cabinetName: message.fromName || message.fromComputer || "Vorige chat",
        computerName: message.fromComputer || "",
        userName: "",
        online: false
      });
    }
    if (message.toClientId && !ownClientIds.has(message.toClientId)) {
      rememberLocalPeer({
        id: message.toClientId,
        cabinetName: "Vorige chat",
        computerName: "",
        userName: "",
        online: false
      });
    }
  }

  function makeClientMessageId() {
    return `${config.clientId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function pendingChatId(clientMessageId) {
    return `pending:${clientMessageId}`;
  }

  function persistChatOutbox() {
    window.kabinette.saveChatOutbox(chatOutbox).catch((error) => {
      setConnectionDetail(`Chat wachtrij kon niet worden opgeslagen: ${error.message}`, "error");
    });
  }

  function pruneChatLog() {
    chatLog.sort((a, b) => Date.parse(a.createdAt || "") - Date.parse(b.createdAt || ""));
    if (chatLog.length > maxChatLogItems) chatLog.splice(0, chatLog.length - maxChatLogItems);
  }

  function persistChatHistory() {
    const history = chatLog.filter((message) => !message.pending).slice(-maxChatLogItems);
    window.kabinette.saveChatHistory(history).catch((error) => {
      setConnectionDetail(`Chatgeschiedenis kon niet worden opgeslagen: ${error.message}`, "error");
    });
  }

  function pendingChatMessage(item) {
    return {
      id: pendingChatId(item.clientMessageId),
      clientMessageId: item.clientMessageId,
      fromClientId: config.clientId,
      fromName: config.cabinetName,
      fromComputer: meta.computerName,
      toClientId: item.toClientId,
      text: item.text,
      createdAt: item.createdAt,
      pending: true
    };
  }

  function addPendingChatMessage(item) {
    const message = pendingChatMessage(item);
    if (chatIds.has(message.id)) return;
    rememberPeersFromMessage(message);
    chatIds.add(message.id);
    chatLog.push(message);
    pruneChatLog();
    updateChatOptions();
    if (activeChatPeerId === item.toClientId) renderChat();
  }

  function removePendingChatMessage(clientMessageId) {
    const id = pendingChatId(clientMessageId);
    const index = chatLog.findIndex((message) => message.id === id);
    if (index !== -1) chatLog.splice(index, 1);
    chatIds.delete(id);
    if (activeChatPeerId) renderChat();
  }

  function acknowledgeChatMessage(clientMessageId) {
    if (!clientMessageId) return;
    const before = chatOutbox.length;
    chatOutbox = chatOutbox.filter((item) => item.clientMessageId !== clientMessageId);
    if (chatOutbox.length !== before) persistChatOutbox();
    removePendingChatMessage(clientMessageId);
  }

  function discardQueuedChatMessage(clientMessageId, reason) {
    acknowledgeChatMessage(clientMessageId);
    if (reason) setConnectionDetail(`Chatbericht niet verzonden: ${reason}`, "error");
  }

  function restorePendingChatMessages() {
    for (const item of chatOutbox) addPendingChatMessage(item);
  }

  function restoreChatHistory() {
    for (const message of localChatHistory) addChatMessage(message, true, false);
  }

  function flushChatOutbox() {
    if (!chatOutbox.length || !socket || socket.readyState !== WebSocket.OPEN) return;
    const attemptAt = new Date().toISOString();
    let changed = false;
    for (const item of chatOutbox) {
      item.lastAttemptAt = attemptAt;
      changed = true;
      send({
        type: "chat:send",
        toClientId: item.toClientId,
        text: item.text,
        clientMessageId: item.clientMessageId
      });
    }
    if (changed) persistChatOutbox();
  }

  function updateUnreadBadge() {
    const total = [...unreadByPeer.values()].reduce((sum, count) => sum + count, 0);
    if (total <= 0) {
      edgeBadge.hidden = true;
      edgeBadge.textContent = "";
      return;
    }
    edgeBadge.hidden = false;
    edgeBadge.textContent = total > 9 ? "9+" : String(total);
  }

  function updateChatOptions() {
    const allPeers = new Map([...localPeers, ...peers]);
    chatTargetMenu.textContent = "";
    chatTargetButton.textContent = activeChatPeerId && allPeers.has(activeChatPeerId)
      ? peerShortName(activeChatPeerId)
      : "Chat met...";

    const sortedPeers = [...allPeers.values()].sort((a, b) => peerName(a.id).localeCompare(peerName(b.id)));
    if (!sortedPeers.length) {
      const empty = document.createElement("div");
      empty.className = "empty-option";
      empty.textContent = "Geen chats";
      chatTargetMenu.appendChild(empty);
      return;
    }

    for (const peer of sortedPeers) {
      const unread = unreadByPeer.get(peer.id) || 0;
      const option = document.createElement("button");
      option.type = "button";
      option.role = "option";
      option.dataset.peerId = peer.id;
      option.setAttribute("aria-selected", activeChatPeerId === peer.id ? "true" : "false");
      option.textContent = `${peer.cabinetName || peer.computerName || "Vorige chat"}${unread ? ` (${unread})` : ""}`;
      chatTargetMenu.appendChild(option);
    }
  }

  function setChatTargetMenuOpen(open) {
    chatTargetMenu.hidden = !open;
    chatTargetButton.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function renderChat() {
    chatMessages.textContent = "";
    if (!activeChatPeerId) return;

    for (const message of chatLog.filter((item) => item.fromClientId === activeChatPeerId || item.toClientId === activeChatPeerId)) {
      const outgoing = ownClientIds.has(message.fromClientId);
      const row = document.createElement("div");
      row.className = `chat-message${outgoing ? " outgoing" : ""}${message.pending ? " pending" : ""}`;

      const metaLine = document.createElement("small");
      metaLine.textContent = `${outgoing ? "Jij" : message.fromName || peerName(message.fromClientId)} · ${new Date(message.createdAt).toLocaleTimeString()}${message.pending ? " · wacht" : ""}`;

      const bubble = document.createElement("span");
      bubble.textContent = message.text;

      row.append(metaLine, bubble);
      chatMessages.appendChild(row);
    }

    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function setActiveChatPeer(peerId) {
    activeChatPeerId = peerId && (peers.has(peerId) || localPeers.has(peerId)) ? peerId : "";
    chatPanel.hidden = !activeChatPeerId;
    panel.classList.toggle("is-chat-open", Boolean(activeChatPeerId));
    setChatTargetMenuOpen(false);

    if (activeChatPeerId) {
      chatPeerName.textContent = peerName(activeChatPeerId);
      unreadByPeer.delete(activeChatPeerId);
      updateUnreadBadge();
      updateChatOptions();
      renderChat();
      if (isOpen) focusWhenWindowActive(chatInput, 60);
      return;
    }

    renderChat();
  }

  function firstUnreadPeer() {
    for (const [peerId, count] of unreadByPeer) {
      if (count > 0 && peers.has(peerId)) return peerId;
    }
    return "";
  }

  function notifyChatMessage(message) {
    if (!("Notification" in window)) return;
    const show = () => {
      const notification = new Notification(`Bericht van ${message.fromName || peerName(message.fromClientId)}`, {
        body: message.text.slice(0, 120)
      });
      notification.onclick = async () => {
        await window.kabinette.focusWindow();
        await setOpen(true);
        setActiveChatPeer(message.fromClientId);
      };
    };

    if (Notification.permission === "granted") {
      show();
    } else if (Notification.permission !== "denied") {
      Notification.requestPermission().then((permission) => {
        if (permission === "granted") show();
      });
    }
  }

  function addChatMessage(message, silent, persist = true) {
    if (message?.clientMessageId && ownClientIds.has(message.fromClientId)) {
      acknowledgeChatMessage(message.clientMessageId);
    }
    if (!message?.id || chatIds.has(message.id)) return;
    rememberPeersFromMessage(message);
    chatIds.add(message.id);
    chatLog.push(message);
    pruneChatLog();
    if (persist) persistChatHistory();
    updateChatOptions();

    const incoming = !ownClientIds.has(message.fromClientId);
    const visibleInActiveChat = isOpen && activeChatPeerId === message.fromClientId;
    if (incoming && !silent && !visibleInActiveChat) {
      unreadByPeer.set(message.fromClientId, (unreadByPeer.get(message.fromClientId) || 0) + 1);
      updateUnreadBadge();
      updateChatOptions();
      notifyChatMessage(message);
    }

    if (activeChatPeerId && (message.fromClientId === activeChatPeerId || message.toClientId === activeChatPeerId)) {
      renderChat();
    }
  }

  function normalizeServerUrl(value) {
    const trimmed = String(value || "").trim();
    const withProtocol = /^wss?:\/\//i.test(trimmed) ? trimmed : `ws://${trimmed || "localhost"}`;
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new Error("Gebruik ws:// of wss://");
    }
    if (!parsed.port) parsed.port = "4780";
    return parsed.toString().replace(/\/$/, "");
  }

  function healthUrlFromWs(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new Error("Gebruik ws:// of wss://");
    }
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    parsed.pathname = "/health";
    parsed.search = "";
    parsed.searchParams.set("updateProtocol", "2");
    if (config.lastInstalledUpdateVersion) {
      parsed.searchParams.set("installedUpdateVersion", config.lastInstalledUpdateVersion);
    }
    parsed.hash = "";
    return parsed.toString();
  }

  function setUpdateAvailable(update) {
    if (!update?.updateUrl) return;
    const updateVersion = String(update.version || "");
    if (updateVersion && updateVersion === config.lastInstalledUpdateVersion) {
      clearUpdateAvailable();
      return;
    }
    const isNewUpdate = !availableUpdate || availableUpdate.updateUrl !== update.updateUrl || availableUpdate.version !== update.version;
    availableUpdate = update;
    pendingUpdateUrl = update.updateUrl;
    syncUpdateToastVisibility();
    setConnectionDetail("Nieuwe update beschikbaar.", "ok");
    if (isNewUpdate && updateVersion && updateVersion !== config.lastNotifiedUpdateVersion) {
      window.kabinette.updateConfig({ lastNotifiedUpdateVersion: updateVersion }).then(setConfig);
      notifyUpdateAvailable();
    }
  }

  function syncUpdateToastVisibility() {
    updateToast.hidden = !(isOpen && availableUpdate?.updateUrl);
  }

  function clearUpdateAvailable(message) {
    availableUpdate = null;
    pendingUpdateUrl = null;
    updateToast.hidden = true;
    installToastUpdateButton.disabled = false;
    installToastUpdateButton.textContent = "Installeren";
    if (message) setConnectionDetail(message, "ok");
  }

  async function checkForUpdate(showResult) {
    try {
      const response = await fetch(healthUrlFromWs(config.serverUrl), { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.updateAvailable && data.updateUrl) {
        setUpdateAvailable({
          updateUrl: data.updateUrl,
          version: data.updateVersion,
          size: data.updateSize,
          modifiedAt: data.updateModifiedAt
        });
        return true;
      }
      clearUpdateAvailable(showResult ? "Geen update beschikbaar." : "");
      return false;
    } catch (error) {
      if (showResult) setConnectionDetail(`Updatecheck mislukt: ${error.message}`, "error");
      return false;
    }
  }

  async function testServerUrl(url) {
    const normalizedUrl = normalizeServerUrl(url);

    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (ws) ws.close();
        reject(new Error("Timeout: WebSocket krijgt geen antwoord."));
      }, 4500);

      function done(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (ws) ws.close();
        if (error) reject(error);
        else resolve(result);
      }

      try {
        ws = new WebSocket(normalizedUrl);
      } catch (error) {
        done(error);
        return;
      }

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({
          type: "hello",
          role: "probe",
          authToken: clientAuthToken.value
        }));
      });

      ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "probe:ready") done(null, message);
        if (message.type === "error") done(new Error(message.message));
      });

      ws.addEventListener("close", (event) => {
        if (settled) return;
        if (event.code === 1008) {
          done(new Error("Server bereikbaar, maar token is fout of ontbreekt."));
        } else {
          done(new Error(`WebSocket gesloten zonder login (${event.code || "geen code"}).`));
        }
      });

      ws.addEventListener("error", () => {
        done(new Error("WebSocket netwerkfout. Check IP, poort en firewall."));
      });
    });
  }

  function edgeTopLimit() {
    const availableHeight = isOpen
      ? window.innerHeight
      : (window.screen?.height || window.screen?.availHeight || window.innerHeight);
    return Math.max(8, availableHeight - edgeTab.offsetHeight - 8);
  }

  function isCompactHiddenWindow() {
    return !isOpen && window.innerHeight <= edgeTab.offsetHeight + 12;
  }

  function applyEdgeTop() {
    edgeTab.style.top = isCompactHiddenWindow() ? "0px" : `${edgeTop}px`;
  }

  function applyEdgePlacementResult(result) {
    if (!result?.ok || !Number.isFinite(result.edgeTabTop)) return;
    edgeTop = result.edgeTabTop;
    edgeSide = result.edgeTabSide === "left" ? "left" : "right";
    edgeDisplayBounds = result.edgeDisplayBounds || edgeDisplayBounds;
    document.body.classList.toggle("edge-side-left", edgeSide === "left");
    applyEdgeTop();
  }

  function isPointInsideEdgeTab(event) {
    const rect = edgeTab.getBoundingClientRect();
    const margin = 8;
    return event.clientX >= rect.left - margin
      && event.clientX <= rect.right + margin
      && event.clientY >= rect.top - margin
      && event.clientY <= rect.bottom + margin;
  }

  function updateHiddenInputPassThrough(event) {
    if (isOpen || edgeDrag) {
      setInputPassThrough(false);
      return;
    }
    setInputPassThrough(!isPointInsideEdgeTab(event));
  }

  function previewHiddenEdgeDrag(screenX, screenY) {
    if (isOpen) return;
    const requestId = ++edgeMoveRequestId;
    window.kabinette.previewClientEdgeDrag({ screenX, screenY }).then((result) => {
      if (requestId === edgeMoveRequestId) applyEdgePlacementResult(result);
    }).catch((error) => {
      setConnectionDetail(`Pijlpositie kon niet worden aangepast: ${error.message}`, "error");
    });
  }

  function snapHiddenEdgeWindow(screenX, screenY, persist) {
    if (isOpen) return;
    const requestId = ++edgeMoveRequestId;
    window.kabinette.setClientEdgeTabPosition({ screenX, screenY }).then((result) => {
      if (requestId !== edgeMoveRequestId) return;
      applyEdgePlacementResult(result);
      if (persist) persistEdgePlacement();
    }).catch((error) => {
      setConnectionDetail(`Pijlpositie kon niet worden aangepast: ${error.message}`, "error");
    });
  }

  function persistEdgePlacement() {
    window.kabinette.updateConfig({
      edgeTabTop: Math.round(edgeTop),
      edgeTabSide: edgeSide,
      edgeDisplayBounds
    }).then((nextConfig) => {
      setConfig(nextConfig);
      if (Number.isFinite(Number(config.edgeTabTop))) {
        edgeTop = Number(config.edgeTabTop);
        applyEdgeTop();
      }
    }).catch((error) => {
      setConnectionDetail(`Pijlpositie kon niet worden opgeslagen: ${error.message}`, "error");
    });
  }

  function setEdgeTop(top, persist, moveWindow = true) {
    const clamped = Math.min(Math.max(8, top), edgeTopLimit());
    edgeTop = clamped;
    applyEdgeTop();
    if (moveWindow && !isOpen) window.kabinette.setClientEdgeTabTop(Math.round(edgeTop)).then(applyEdgePlacementResult);
    if (persist) persistEdgePlacement();
  }

  function restoreEdgeTop() {
    const savedTop = Number(config.edgeTabTop);
    setEdgeTop(Number.isFinite(savedTop) ? savedTop : (window.screen?.height || window.innerHeight) * 0.46, false, false);
  }

  async function setOpen(open) {
    isOpen = Boolean(open);
    clearTimeout(closeTimer);
    clearTimeout(resizeTimer);

    if (open) {
      setInputPassThrough(false);
      updateToast.hidden = true;
      document.body.classList.remove("is-edge-only");
      document.body.classList.add("is-panel-open");
      panel.classList.add("is-open");
      edgeTab.classList.remove("is-visible");
      const result = await window.kabinette.setClientPanelOpen(true);
      applyEdgePlacementResult(result);
      syncUpdateToastVisibility();
      const unreadPeer = firstUnreadPeer();
      if (unreadPeer && !activeChatPeerId) setActiveChatPeer(unreadPeer);
      focusWhenWindowActive(activeChatPeerId ? chatInput : note, 80);
      return;
    }

    if (pendingAdminNotification) {
      clearTimeout(saveTimer);
      await saveAndSendNote(true);
    }

    setSettingsOpen(false);
    updateToast.hidden = true;
    const result = await window.kabinette.setClientPanelOpen(false);
    applyEdgePlacementResult(result);
    document.body.classList.add("is-edge-only");
    document.body.classList.remove("is-panel-open", "is-panel-closing");
    panel.classList.remove("is-open");
    applyEdgeTop();
    edgeTab.classList.add("is-visible");
    setInputPassThrough(true);
  }

  function setSettingsOpen(open) {
    fillSettings();
    settingsPanel.hidden = !open;
    panel.classList.toggle("is-settings-open", open);
    if (open) focusWhenWindowActive(clientServerUrl, 80);
  }

  function notifyAdminReply() {
    if (isOpen || !("Notification" in window)) return;
    const show = () => {
      const notification = new Notification("Nieuwe admin notitie", {
        body: "Klik om de notitie te openen."
      });
      notification.onclick = async () => {
        await window.kabinette.focusWindow();
        setOpen(true);
      };
    };

    if (Notification.permission === "granted") {
      show();
    } else if (Notification.permission !== "denied") {
      Notification.requestPermission().then((permission) => {
        if (permission === "granted") show();
      });
    }
  }

  async function runSilentUpdate(updateUrl) {
    if (!updateUrl || updateInProgress) return;
    updateInProgress = true;
    installToastUpdateButton.disabled = true;
    installToastUpdateButton.textContent = "Downloaden...";
    syncUpdateToastVisibility();
    setConnectionDetail("Update downloaden...", "pending");
    try {
      const result = await window.kabinette.installUpdate(updateUrl, availableUpdate?.version || "");
      if (!result?.ok) {
        updateInProgress = false;
        installToastUpdateButton.disabled = false;
        installToastUpdateButton.textContent = "Installeren";
        syncUpdateToastVisibility();
        setConnectionDetail(result?.message || "Update kon niet starten.", "error");
        return;
      }
      installToastUpdateButton.textContent = "Installer start...";
      setConnectionDetail("Update gedownload. Installer start nu.", "pending");
    } catch (error) {
      updateInProgress = false;
      installToastUpdateButton.disabled = false;
      installToastUpdateButton.textContent = "Installeren";
      syncUpdateToastVisibility();
      setConnectionDetail(`Update mislukt: ${error.message}`, "error");
    }
  }

  async function installAvailableUpdate() {
    const updateUrl = availableUpdate?.updateUrl || pendingUpdateUrl;
    if (!updateUrl) {
      const found = await checkForUpdate(true);
      if (!found) return;
    }
    await runSilentUpdate(availableUpdate?.updateUrl || pendingUpdateUrl);
  }

  function notifyUpdateAvailable() {
    if (!("Notification" in window)) return;
    const show = () => {
      const notification = new Notification("Nieuwe update", {
        body: "Klik om de update te openen."
      });
      notification.onclick = async () => {
        await window.kabinette.focusWindow();
        await setOpen(true);
      };
    };

    if (Notification.permission === "granted") {
      show();
    } else if (Notification.permission !== "denied") {
      Notification.requestPermission().then((permission) => {
        if (permission === "granted") show();
      });
    }
  }

  function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!activeChatPeerId || !text) return;
    const item = {
      clientMessageId: makeClientMessageId(),
      toClientId: activeChatPeerId,
      text: text.slice(0, 1000),
      createdAt: new Date().toISOString(),
      lastAttemptAt: null
    };
    chatOutbox.push(item);
    if (chatOutbox.length > 200) chatOutbox.splice(0, chatOutbox.length - 200);
    persistChatOutbox();
    addPendingChatMessage(item);
    flushChatOutbox();
    chatInput.value = "";
  }

  async function saveAndSendNote(notifyAdmin) {
    await window.kabinette.saveNote(latestNote);
    send({ type: "note:update", note: latestNote, notify: Boolean(notifyAdmin) });
    if (notifyAdmin) pendingAdminNotification = false;
  }

  function hello() {
    send({
      type: "hello",
      role: "client",
      id: config.clientId,
      cabinetName: config.cabinetName,
      authToken: config.authToken,
      installedUpdateVersion: config.lastInstalledUpdateVersion || "",
      updateProtocolVersion: 2,
      computerName: meta.computerName,
      userName: meta.userName,
      note: latestNote
    });
  }

  function connect() {
    clearTimeout(reconnectTimer);
    const previousSocket = socket;
    if (previousSocket) {
      previousSocket.skipReconnect = true;
      previousSocket.close();
    }
    connectionState.textContent = "Verbinden...";
    let normalizedUrl;
    try {
      normalizedUrl = normalizeServerUrl(config.serverUrl);
      if (normalizedUrl !== config.serverUrl) {
        setConfig({ ...config, serverUrl: normalizedUrl });
        window.kabinette.updateConfig({ serverUrl: normalizedUrl }).then(setConfig);
      }
      setConnectionDetail(`Verbinden met ${normalizedUrl}`, "pending");
      socket = new WebSocket(normalizedUrl);
    } catch (error) {
      connectionState.textContent = "Ongeldig serveradres";
      setConnectionDetail(error.message, "error");
      return;
    }
    const currentSocket = socket;

    currentSocket.addEventListener("open", () => {
      connectionState.textContent = "Live verbonden";
      setConnectionDetail("WebSocket open, aanmelden...", "pending");
      hello();
    });

    currentSocket.addEventListener("close", async (event) => {
      if (currentSocket.skipReconnect) return;
      if (event.code === 4001 || event.code === 4002) {
        connectionState.textContent = "Dubbele client afgesloten";
        setConnectionDetail("Deze extra instantie is afgesloten door de server.", "error");
        await window.kabinette.quitApp();
        return;
      }
      if (event.code === 1008) {
        connectionState.textContent = "Token geweigerd";
        setConnectionDetail("Token klopt niet of ontbreekt.", "error");
      } else {
        connectionState.textContent = "Offline, opnieuw proberen...";
        setConnectionDetail(`Geen verbinding met ${normalizedUrl || config.serverUrl}. Check firewall/IP/poort.`, "error");
      }
      reconnectTimer = setTimeout(connect, 2000);
    });

    currentSocket.addEventListener("error", () => {
      setConnectionDetail(`Netwerkfout naar ${config.serverUrl}.`, "error");
    });

    currentSocket.addEventListener("message", async (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "ready") {
        setConnectionDetail("Verbonden en aangemeld.", "ok");
        flushChatOutbox();
      }
      if (message.type === "duplicate:closed") {
        await window.kabinette.quitApp();
      }
      if (message.type === "error") {
        setConnectionDetail(message.message, "error");
      }
      if (message.type === "client:update-install") {
        if (message.version) setUpdateAvailable({ updateUrl: message.url, version: message.version });
        else checkForUpdate(false);
      }
      if (message.type === "update:available") {
        setUpdateAvailable(message);
      }
      if (message.type === "peers") {
        peers.clear();
        for (const peer of message.peers || []) peers.set(peer.id, peer);
        updateChatOptions();
        if (activeChatPeerId && !peers.has(activeChatPeerId) && !localPeers.has(activeChatPeerId)) setActiveChatPeer("");
      }
      if (message.type === "chat:history") {
        for (const chatMessage of message.messages || []) addChatMessage(chatMessage, true);
        renderChat();
      }
      if (message.type === "chat:message") {
        addChatMessage(message.message, false);
      }
      if (message.type === "chat:error") {
        discardQueuedChatMessage(message.clientMessageId, message.message);
      }
      if (message.type === "note:set") {
        remoteSet = true;
        latestNote = message.note || "";
        note.value = latestNote;
        await window.kabinette.saveNote(latestNote);
        if (message.notify) notifyAdminReply();
        remoteSet = false;
      }
      if (message.type === "settings") {
        setConfig(await window.kabinette.updateConfig({ cabinetName: message.cabinetName }));
        cabinetName.textContent = config.cabinetName;
      }
    });
  }

  note.addEventListener("input", () => {
    if (remoteSet) return;
    latestNote = note.value;
    pendingAdminNotification = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await saveAndSendNote(false);
    }, 140);
  });

  edgeTab.addEventListener("pointerdown", (event) => {
    if (isOpen) return;
    setInputPassThrough(false);
    edgeDrag = {
      startX: event.screenX,
      startY: event.screenY,
      moved: false
    };
    edgeTab.setPointerCapture(event.pointerId);
    edgeTab.classList.add("is-dragging", "is-visible");
    event.preventDefault();
  });

  edgeTab.addEventListener("pointermove", (event) => {
    if (!edgeDrag) return;
    const deltaX = event.screenX - edgeDrag.startX;
    const deltaY = event.screenY - edgeDrag.startY;
    if (Math.hypot(deltaX, deltaY) > 5) edgeDrag.moved = true;
    if (edgeDrag.moved) previewHiddenEdgeDrag(event.screenX, event.screenY);
  });

  edgeTab.addEventListener("pointerup", (event) => {
    if (!edgeDrag) return;
    edgeTab.releasePointerCapture(event.pointerId);
    edgeTab.classList.remove("is-dragging");
    const wasDragged = edgeDrag.moved;
    edgeDrag = null;
    if (wasDragged) {
      snapHiddenEdgeWindow(event.screenX, event.screenY, true);
      updateHiddenInputPassThrough(event);
      return;
    }
    setOpen(true);
  });

  edgeTab.addEventListener("pointercancel", () => {
    edgeDrag = null;
    edgeTab.classList.remove("is-dragging");
    setInputPassThrough(true);
  });

  edgeTab.addEventListener("mouseenter", () => {
    if (!isOpen) setInputPassThrough(false);
  });

  edgeTab.addEventListener("mouseleave", () => {
    if (!isOpen && !edgeDrag) setInputPassThrough(true);
  });

  settingsButton.addEventListener("click", () => setSettingsOpen(settingsPanel.hidden));
  cancelSettingsButton.addEventListener("click", () => setSettingsOpen(false));
  chatTargetButton.addEventListener("click", (event) => {
    event.stopPropagation();
    updateChatOptions();
    setChatTargetMenuOpen(chatTargetMenu.hidden);
  });
  chatTargetMenu.addEventListener("click", (event) => {
    const option = event.target.closest("button[data-peer-id]");
    if (!option) return;
    setActiveChatPeer(option.dataset.peerId);
  });
  document.addEventListener("click", (event) => {
    if (!chatTargetPicker.contains(event.target)) setChatTargetMenuOpen(false);
  });
  closeChatButton.addEventListener("click", () => setActiveChatPeer(""));
  sendChatButton.addEventListener("click", sendChatMessage);
  chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendChatMessage();
    }
  });

  testConnectionButton.addEventListener("click", async () => {
    const url = normalizeServerUrl(clientServerUrl.value);
    clientServerUrl.value = url;
    setConnectionDetail("Server testen...", "pending");
    try {
      const data = await testServerUrl(url);
      setConnectionDetail(
        `WebSocket OK. Clients: ${data.clients}. Admins: ${data.admins}. Token: ${data.authEnabled ? "aan" : "uit"}.`,
        "ok"
      );
    } catch (error) {
      setConnectionDetail(`Niet bereikbaar: ${error.message}`, "error");
    }
  });

  installToastUpdateButton.addEventListener("click", installAvailableUpdate);

  saveSettingsButton.addEventListener("click", async () => {
    setConfig(await window.kabinette.updateConfig({
      serverUrl: normalizeServerUrl(clientServerUrl.value),
      authToken: clientAuthToken.value,
      cabinetName: clientCabinetName.value.trim() || meta.computerName
    }));
    cabinetName.textContent = config.cabinetName;
    setSettingsOpen(false);
    connect();
  });

  note.addEventListener("blur", () => {
    closeTimer = setTimeout(() => {
      if (isOpen && !panel.contains(document.activeElement)) setOpen(false);
    }, 180);
  });

  window.kabinette.onWindowBlur(() => {
    if (isOpen) setOpen(false);
  });

  window.kabinette.onClientPanelOpen(() => setOpen(true));

  window.addEventListener("resize", () => applyEdgeTop());

  document.body.addEventListener("mousemove", (event) => {
    updateHiddenInputPassThrough(event);
    if (!isOpen && isPointInsideEdgeTab(event)) {
      edgeTab.classList.add("is-visible");
    }
  });

  document.body.addEventListener("mouseleave", () => {
    if (!isOpen) setInputPassThrough(true);
  });

  restoreEdgeTop();
  fillSettings();
  restoreChatHistory();
  restorePendingChatMessages();
  setOpen(false);
  connect();
})();
