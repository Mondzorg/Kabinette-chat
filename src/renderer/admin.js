(async () => {
  const meta = await window.kabinette.meta();
  const serverUrl = document.getElementById("serverUrl");
  const authToken = document.getElementById("authToken");
  const connectButton = document.getElementById("connectButton");
  const adminState = document.getElementById("adminState");
  const clientsEl = document.getElementById("clients");
  const template = document.getElementById("clientTemplate");

  let socket;
  let clients = new Map();
  const timers = new Map();
  const notifyTimers = new Map();
  const pendingNotify = new Map();

  serverUrl.value = meta.config.serverUrl;
  authToken.value = meta.config.authToken || "";

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

  function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      adminState.textContent = "Niet verbonden met server. Klik eerst op Verbinden.";
      return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
  }

  async function focusClient(clientId) {
    await window.kabinette.focusWindow();
    const card = clientsEl.querySelector(`[data-client-id="${CSS.escape(clientId)}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("is-targeted");
    setTimeout(() => card.classList.remove("is-targeted"), 1800);
    setTimeout(() => card.querySelector(".admin-note")?.focus(), 360);
  }

  function notify(client) {
    if (!("Notification" in window)) return;
    const show = () => {
      const notification = new Notification(`Nieuwe notitie: ${client.cabinetName}`, {
        body: `${client.userName} op ${client.computerName}`
      });
      notification.onclick = () => focusClient(client.id);
    };

    if (Notification.permission === "granted") {
      show();
    } else if (Notification.permission !== "denied") {
      Notification.requestPermission().then((permission) => {
        if (permission === "granted") show();
      });
    }
  }

  function sendAdminNote(clientId, note, notifyUser) {
    send({ type: "admin:note", clientId, note, notify: notifyUser });
    if (notifyUser) pendingNotify.set(clientId, false);
  }

  function scheduleCabinetNotification(clientId, note) {
    clearTimeout(notifyTimers.get(clientId));
    notifyTimers.set(clientId, setTimeout(() => {
      if (pendingNotify.get(clientId)) sendAdminNote(clientId, note, true);
    }, 1500));
  }

  function render() {
    const existing = new Set([...clientsEl.children].map((node) => node.dataset.clientId));

    for (const client of clients.values()) {
      let card = clientsEl.querySelector(`[data-client-id="${CSS.escape(client.id)}"]`);
      if (!card) {
        card = template.content.firstElementChild.cloneNode(true);
        card.dataset.clientId = client.id;
        clientsEl.appendChild(card);

        const nameInput = card.querySelector(".cabinet-input");
        const noteInput = card.querySelector(".admin-note");
        const removeButton = card.querySelector(".remove-client");

        nameInput.addEventListener("change", () => {
          send({ type: "client:rename", clientId: client.id, cabinetName: nameInput.value });
        });

        removeButton.addEventListener("click", () => {
          const current = clients.get(card.dataset.clientId);
          if (!current || current.online) return;
          if (confirm(`${current.cabinetName} verwijderen uit de lijst?`)) {
            send({ type: "client:remove", clientId: current.id });
          }
        });

        noteInput.addEventListener("input", () => {
          pendingNotify.set(client.id, true);
          clearTimeout(timers.get(client.id));
          timers.set(client.id, setTimeout(() => {
            sendAdminNote(client.id, noteInput.value, false);
          }, 180));
          scheduleCabinetNotification(client.id, noteInput.value);
        });

        noteInput.addEventListener("blur", () => {
          clearTimeout(timers.get(client.id));
          clearTimeout(notifyTimers.get(client.id));
          if (pendingNotify.get(client.id)) sendAdminNote(client.id, noteInput.value, true);
        });
      }

      existing.delete(client.id);
      const nameInput = card.querySelector(".cabinet-input");
      const metaEl = card.querySelector(".meta");
      const pill = card.querySelector(".status-pill");
      const noteInput = card.querySelector(".admin-note");
      const removeButton = card.querySelector(".remove-client");

      if (document.activeElement !== nameInput) nameInput.value = client.cabinetName;
      if (document.activeElement !== noteInput) noteInput.value = client.note || "";
      metaEl.textContent = `${client.userName} @ ${client.computerName} · ${new Date(client.updatedAt).toLocaleTimeString()}`;
      pill.textContent = client.online ? "online" : "offline";
      pill.classList.toggle("online", client.online);
      removeButton.disabled = client.online;
    }

    for (const id of existing) clientsEl.querySelector(`[data-client-id="${CSS.escape(id)}"]`)?.remove();

    if (!clients.size) {
      clientsEl.innerHTML = `<p class="empty-state">Nog geen kabinetten verbonden.</p>`;
    } else {
      clientsEl.querySelector(".empty-state")?.remove();
    }
  }

  async function connect() {
    let normalizedUrl;
    try {
      normalizedUrl = normalizeServerUrl(serverUrl.value);
      serverUrl.value = normalizedUrl;
    } catch (error) {
      adminState.textContent = error.message;
      return;
    }

    await window.kabinette.updateConfig({
      serverUrl: normalizedUrl,
      authToken: authToken.value
    });
    if (socket) socket.close();
    adminState.textContent = "Verbinden met server...";
    socket = new WebSocket(normalizedUrl);

    socket.addEventListener("open", () => {
      adminState.textContent = "Live verbonden";
      send({ type: "hello", role: "admin", authToken: authToken.value });
    });

    socket.addEventListener("close", () => {
      adminState.textContent = "Niet verbonden";
    });

    socket.addEventListener("error", () => {
      adminState.textContent = "Verbinding met server mislukt";
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "clients") {
        clients = new Map(message.clients.map((client) => [client.id, client]));
        render();
      }
      if (message.type === "client:update") {
        const previous = clients.get(message.client.id);
        clients.set(message.client.id, message.client);
        if (message.source === "client" && message.notify && previous) notify(message.client);
        render();
      }
      if (message.type === "error") {
        adminState.textContent = message.message;
      }
    });
  }

  connectButton.addEventListener("click", connect);
  connect();
})();
