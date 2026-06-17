const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const imageDir = path.join(root, "docs", "images");
const appCss = fs.readFileSync(path.join(root, "src", "renderer", "styles.css"), "utf8");

function html(bodyClass, body, extraHead = "") {
  return `<!doctype html>
<html lang="nl">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>${appCss}</style>
    ${extraHead}
  </head>
  <body class="${bodyClass}">
    ${body}
  </body>
</html>`;
}

function clientPanelHtml({ settings = false, chat = false, update = false } = {}) {
  return html("client-shell is-panel-open", `
    <button class="edge-tab" id="edgeTab" title="Notitie openen">
      <span class="edge-arrow">‹</span>
      <span class="edge-badge" id="edgeBadge" hidden></span>
    </button>
    <div class="update-toast" id="updateToast"${update ? "" : " hidden"}>
      <span>Nieuwe update</span>
      <button id="installToastUpdateButton" type="button">Installeren</button>
    </div>
    <main class="client-panel${settings ? " is-settings-open" : ""}${chat ? " is-chat-open" : ""}" id="panel">
      <header class="client-header">
        <div>
          <strong id="cabinetName">Demo Kabinet</strong>
          <span id="connectionState">Live verbonden</span>
        </div>
        <div class="client-actions">
          <div class="chat-target-picker" id="chatTargetPicker">
            <button id="chatTargetButton" type="button" title="Chat met collega" aria-haspopup="listbox" aria-expanded="false">Chat met...</button>
            <div class="chat-target-menu" id="chatTargetMenu" role="listbox" hidden></div>
          </div>
          <button id="settingsButton" title="Instellingen" aria-label="Instellingen">⚙</button>
        </div>
      </header>
      <section class="client-settings" id="settingsPanel"${settings ? "" : " hidden"}>
        <label>
          Server
          <input id="clientServerUrl" value="ws://internal-server:4780" />
        </label>
        <p class="connection-detail" id="clientConnectionDetail" data-state="ok">Verbonden en aangemeld.</p>
        <label>
          Token
          <input id="clientAuthToken" type="password" placeholder="Optionele token" />
        </label>
        <label>
          Kabinetnaam
          <input id="clientCabinetName" value="Demo Kabinet" />
        </label>
        <div class="client-identity">
          <span id="clientComputerName">PC: PC-DEMO-01</span>
          <span id="clientUserName">Gebruiker: demo.user</span>
        </div>
        <div class="settings-actions">
          <button id="cancelSettingsButton">Annuleren</button>
          <button id="testConnectionButton">Test</button>
          <button id="saveSettingsButton">Opslaan</button>
        </div>
      </section>
      <section class="client-chat" id="chatPanel"${chat ? "" : " hidden"}>
        <header>
          <strong id="chatPeerName">Demo Collega (PC-DEMO-02)</strong>
          <button id="closeChatButton" title="Chat sluiten">×</button>
        </header>
        <div class="chat-messages" id="chatMessages">
          <div class="chat-message">
            <small>Demo Collega · 10:15</small>
            <span>Kan iemand dit even nakijken?</span>
          </div>
          <div class="chat-message outgoing">
            <small>Jij · 10:16</small>
            <span>Ik kijk zo mee.</span>
          </div>
        </div>
        <div class="chat-compose">
          <input id="chatInput" placeholder="Kort bericht..." />
          <button id="sendChatButton">Stuur</button>
        </div>
      </section>
      <textarea id="note" spellcheck="true" placeholder="Typ hier je melding of notitie...">Demo notitie voor deze PC.

Deze notitie blijft gekoppeld aan de computer, ook wanneer een andere Windows gebruiker inlogt.</textarea>
    </main>`);
}

function edgeTabHtml() {
  return html("client-shell is-edge-only", `
    <button class="edge-tab is-visible" id="edgeTab" title="Notitie openen" style="top:0">
      <span class="edge-arrow">‹</span>
      <span class="edge-badge" id="edgeBadge" hidden></span>
    </button>`, `
    <style>
      body { width: 42px; height: 88px; background: transparent; overflow: hidden; }
      .edge-tab { position: fixed; top: 0 !important; right: 0; }
    </style>`);
}

function adminHtml() {
  return html("admin-shell", `
    <header class="admin-topbar">
      <div>
        <h1>Kabinette Admin</h1>
        <p id="adminState">Live verbonden · 3 clients</p>
      </div>
      <div class="server-control">
        <input id="serverUrl" aria-label="Server URL" value="ws://internal-server:4780" />
        <input id="authToken" type="password" aria-label="Token" placeholder="Token" />
        <button id="connectButton">Verbinden</button>
      </div>
    </header>
    <section class="admin-grid" id="clients">
      <article class="note-window is-targeted">
        <header>
          <div>
            <input class="cabinet-input" value="Demo Kabinet" />
            <p class="meta">PC-DEMO-01 · demo.user</p>
          </div>
          <div class="card-actions">
            <button class="remove-client" title="Offline client verwijderen" disabled>Verwijder</button>
            <span class="status-pill online">online</span>
          </div>
        </header>
        <textarea class="admin-note" spellcheck="true">Demo notitie voor deze PC.

Beheerders, managers en teamleden kunnen deze gedeelde notitie gebruiken.</textarea>
      </article>
      <article class="note-window">
        <header>
          <div>
            <input class="cabinet-input" value="Receptie" />
            <p class="meta">PC-DEMO-02 · frontdesk</p>
          </div>
          <div class="card-actions">
            <button class="remove-client" title="Offline client verwijderen" disabled>Verwijder</button>
            <span class="status-pill online">online</span>
          </div>
        </header>
        <textarea class="admin-note" spellcheck="true">Voorbeeldnotitie zonder interne gegevens.</textarea>
      </article>
      <article class="note-window">
        <header>
          <div>
            <input class="cabinet-input" value="Backoffice" />
            <p class="meta">PC-DEMO-03 · team.user</p>
          </div>
          <div class="card-actions">
            <button class="remove-client" title="Offline client verwijderen">Verwijder</button>
            <span class="status-pill">offline</span>
          </div>
        </header>
        <textarea class="admin-note" spellcheck="true">Laatste gedeelde notitie blijft zichtbaar.</textarea>
      </article>
    </section>`);
}

async function capture(name, content, width, height) {
  const window = new BrowserWindow({
    width,
    height,
    show: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(content)}`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const image = await window.webContents.capturePage();
  const output = path.join(imageDir, name);
  fs.writeFileSync(output, image.toPNG());
  window.close();
  console.log(output);
}

app.whenReady().then(async () => {
  fs.mkdirSync(imageDir, { recursive: true });
  await capture("client-sidebar.png", clientPanelHtml({ chat: true }), 320, 720);
  await capture("client-settings.png", clientPanelHtml({ settings: true }), 320, 720);
  await capture("admin-dashboard.png", adminHtml(), 1180, 760);
  await capture("update-prompt.png", clientPanelHtml({ update: true }), 320, 720);
  await capture("edge-tab.png", edgeTabHtml(), 42, 88);
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
