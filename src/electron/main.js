const { app, BrowserWindow, ipcMain, screen } = require("electron");
const fs = require("fs/promises");
const fsSync = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");

function resolveMode() {
  if (process.env.APP_MODE === "admin" || process.env.APP_MODE === "client") return process.env.APP_MODE;
  const exeName = path.basename(process.execPath).toLowerCase();
  if (exeName.includes("admin")) return "admin";
  if (exeName.includes("client")) return "client";
  try {
    const appPackage = JSON.parse(fsSync.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"));
    if (appPackage.kabinetteMode === "admin" || appPackage.kabinetteMode === "client") {
      return appPackage.kabinetteMode;
    }
  } catch {
    return "client";
  }
  return "client";
}

const mode = resolveMode();
const appDisplayName = mode === "admin" ? "Kabinette Notes Admin" : "Kabinette Notes Client";
app.setName(appDisplayName);
if (process.platform === "win32") {
  app.setAppUserModelId(mode === "admin" ? "be.kabinette.notes.admin" : "be.kabinette.notes.client");
}
const legacyUserDataDir = path.join(app.getPath("appData"), "KabinetteNotes");
const usesSharedWindowsData = process.platform === "win32" && process.env.PROGRAMDATA;
const sharedDataRoot = usesSharedWindowsData
  ? process.env.PROGRAMDATA
  : app.getPath("appData");
const userDataDir = path.join(sharedDataRoot, "KabinetteNotes");
const configPath = path.join(userDataDir, "config.json");
const notePath = path.join(userDataDir, "note.txt");
const chatOutboxPath = path.join(userDataDir, "chat-outbox.json");
const chatHistoryPath = path.join(userDataDir, "chat-history.json");
const defaultServerUrl = process.env.KABINETTE_DEFAULT_SERVER_URL || "ws://localhost:4780";
const currentAppUpdateVersion = `app:${app.getVersion()}`;
const clientOpenWidth = 320;
const clientHiddenWidth = 52;
const clientHiddenHeight = 88;
let mainWindow = null;
let edgeWindow = null;
let clientPanelOpen = false;
let clientWantsInputPassThrough = false;
let clientTopmostTimer = null;
let clientPanelRevealTimer = null;
let clientEdgePlacement = {
  top: null,
  side: "right",
  displayBounds: null
};

function stableClientId() {
  const computerName = os.hostname().trim().toLowerCase();
  return `computer:${computerName || "unknown"}`;
}

function isLegacyGeneratedClientId(clientId) {
  const computerName = os.hostname().trim();
  const escapedComputerName = computerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapedComputerName}-[a-f0-9]+$`, "i").test(String(clientId || ""));
}

function normalizePreviousClientIds(items, currentClientId) {
  if (!Array.isArray(items)) return [];
  return [...new Set(items.map((item) => String(item || "").trim()).filter((item) => item && item !== currentClientId))]
    .slice(-10);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock({ mode });
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", () => {
  focusMainWindow();
});

function cleanupLegacyClientAutostart() {
  if (mode !== "client" || !app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: false, path: process.execPath });
  } catch {
    // Machine-wide autostart is managed by the NSIS installer in HKLM.
  }
}

function clampClientEdgeTabTop(top, displayBounds) {
  const fallback = Math.round(displayBounds.height * 0.46);
  const rawTop = Number.isFinite(top) ? top : fallback;
  const maxTop = Math.max(8, displayBounds.height - clientHiddenHeight - 8);
  return Math.min(Math.max(8, Math.round(rawTop)), maxTop);
}

function getDisplayFromBounds(bounds) {
  if (!bounds || !Number.isFinite(Number(bounds.x)) || !Number.isFinite(Number(bounds.y))) return null;
  return screen.getDisplayMatching({
    x: Number(bounds.x),
    y: Number(bounds.y),
    width: Number(bounds.width) || 1,
    height: Number(bounds.height) || 1
  });
}

function getClientDisplay() {
  const placementDisplay = getDisplayFromBounds(clientEdgePlacement.displayBounds);
  if (placementDisplay) return placementDisplay;
  if (!mainWindow || mainWindow.isDestroyed()) return screen.getPrimaryDisplay();
  return screen.getDisplayMatching(mainWindow.getBounds());
}

function clientWindowBounds(display, side, open = true) {
  const { x, y, width, height } = display.bounds;
  if (!open) {
    return {
      x: side === "left" ? x - clientOpenWidth + clientHiddenWidth : x + width - clientHiddenWidth,
      y,
      width: clientOpenWidth,
      height
    };
  }
  return {
    x: side === "left" ? x : x + width - clientOpenWidth,
    y,
    width: clientOpenWidth,
    height
  };
}

function clientEdgeWindowBounds(display, side) {
  const { x, y, width } = display.bounds;
  return {
    x: side === "left" ? x : x + width - clientHiddenWidth,
    y: y + clientEdgePlacement.top,
    width: clientHiddenWidth,
    height: clientHiddenHeight
  };
}

function applyClientWindowBounds(display, side) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBounds(clientWindowBounds(display, side, clientPanelOpen), false);
  applyClientWindowShape(display, side);
}

function applyClientEdgeWindowBounds(display, side) {
  if (!edgeWindow || edgeWindow.isDestroyed()) return;
  edgeWindow.setBounds(clientEdgeWindowBounds(display, side), false);
}

function clientWindowShape(display, side) {
  if (clientPanelOpen) {
    return [{ x: 0, y: 0, width: clientOpenWidth, height: display.bounds.height }];
  }
  return [{
    x: side === "left" ? clientOpenWidth - clientHiddenWidth : 0,
    y: clampClientEdgeTabTop(clientEdgePlacement.top, display.bounds),
    width: clientHiddenWidth,
    height: clientHiddenHeight
  }];
}

function applyClientWindowShape(display, side) {
  if (!mainWindow || mainWindow.isDestroyed() || typeof mainWindow.setShape !== "function") return false;
  try {
    mainWindow.setShape(clientWindowShape(display, side));
    return true;
  } catch {
    return false;
  }
}

function clearClientPanelRevealTimer() {
  if (clientPanelRevealTimer) {
    clearTimeout(clientPanelRevealTimer);
    clientPanelRevealTimer = null;
  }
}

function revealClientPanelWhenSettled() {
  clearClientPanelRevealTimer();
  clientPanelRevealTimer = setTimeout(() => {
    clientPanelRevealTimer = null;
    if (mode !== "client" || !clientPanelOpen || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.focus();
    mainWindow.webContents.focus();
  }, 90);
}

function setClientEdgePlacement(patch = {}) {
  if (mode !== "client") return { ok: false };
  let display = getDisplayFromBounds(patch.displayBounds) || getClientDisplay();
  if (Number.isFinite(Number(patch.screenX)) && Number.isFinite(Number(patch.screenY))) {
    display = screen.getDisplayNearestPoint({ x: Number(patch.screenX), y: Number(patch.screenY) });
  }

  const side = patch.side === "left" || patch.side === "right"
    ? patch.side
    : Number.isFinite(Number(patch.screenX))
      ? (Number(patch.screenX) < display.bounds.x + (display.bounds.width / 2) ? "left" : "right")
      : clientEdgePlacement.side;
  const top = Number.isFinite(Number(patch.screenY))
    ? Number(patch.screenY) - display.bounds.y - Math.round(clientHiddenHeight / 2)
    : Number(patch.top);

  clientEdgePlacement = {
    top: clampClientEdgeTabTop(top, display.bounds),
    side,
    displayBounds: { ...display.bounds }
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    applyClientWindowBounds(display, side);
  }
  applyClientEdgeWindowBounds(display, side);
  keepClientWindowOnTop();
  return {
    ok: true,
    edgeTabTop: clientEdgePlacement.top,
    edgeTabSide: clientEdgePlacement.side,
    edgeDisplayBounds: clientEdgePlacement.displayBounds
  };
}

function previewClientEdgeDrag(position = {}) {
  if (mode !== "client" || !mainWindow || mainWindow.isDestroyed() || clientPanelOpen) return { ok: false };
  if (!Number.isFinite(Number(position.screenX)) || !Number.isFinite(Number(position.screenY))) return { ok: false };

  const display = screen.getDisplayNearestPoint({
    x: Number(position.screenX),
    y: Number(position.screenY)
  });
  const side = Number(position.screenX) < display.bounds.x + (display.bounds.width / 2) ? "left" : "right";
  clientEdgePlacement = {
    top: clampClientEdgeTabTop(
      Number(position.screenY) - display.bounds.y - Math.round(clientHiddenHeight / 2),
      display.bounds
    ),
    side,
    displayBounds: { ...display.bounds }
  };
  applyClientWindowBounds(display, side);
  applyClientEdgeWindowBounds(display, side);
  keepClientWindowOnTop();
  return {
    ok: true,
    edgeTabTop: clientEdgePlacement.top,
    edgeTabSide: clientEdgePlacement.side,
    edgeDisplayBounds: clientEdgePlacement.displayBounds
  };
}

function setClientWindowOpen(open) {
  if (mode !== "client" || !mainWindow) return { ok: false };
  clientPanelOpen = Boolean(open);
  clientWantsInputPassThrough = !clientPanelOpen;
  clearClientPanelRevealTimer();
  const display = getClientDisplay();
  const side = clientEdgePlacement.side === "left" ? "left" : "right";
  clientEdgePlacement.top = clampClientEdgeTabTop(clientEdgePlacement.top, display.bounds);
  clientEdgePlacement.displayBounds = { ...display.bounds };
  applyClientWindowBounds(display, side);
  applyClientEdgeWindowBounds(display, side);
  applyClientInputPassThrough();
  if (clientPanelOpen) {
    if (edgeWindow && !edgeWindow.isDestroyed()) edgeWindow.hide();
    mainWindow.setAlwaysOnTop(false);
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.focus();
    revealClientPanelWhenSettled();
  } else {
    mainWindow.setAlwaysOnTop(true);
    if (typeof mainWindow.showInactive === "function") mainWindow.showInactive();
    else mainWindow.show();
    keepClientWindowOnTop();
  }
  keepClientWindowOnTop();
  return {
    ok: true,
    edgeTabTop: clientEdgePlacement.top,
    edgeTabSide: clientEdgePlacement.side,
    edgeDisplayBounds: clientEdgePlacement.displayBounds
  };
}

function keepClientWindowOnTop() {
  if (mode !== "client") return;
  if (mainWindow && !mainWindow.isDestroyed() && !clientPanelOpen) {
    mainWindow.setAlwaysOnTop(true);
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  if (!edgeWindow || edgeWindow.isDestroyed()) return;
  edgeWindow.setAlwaysOnTop(true);
  edgeWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function startClientTopmostGuard(win) {
  clearInterval(clientTopmostTimer);
  clientTopmostTimer = setInterval(keepClientWindowOnTop, 1500);
  if (typeof clientTopmostTimer.unref === "function") clientTopmostTimer.unref();
  win.on("closed", () => {
    clearInterval(clientTopmostTimer);
    clientTopmostTimer = null;
  });
}

function applyClientInputPassThrough() {
  if (mode !== "client" || !mainWindow || mainWindow.isDestroyed()) return { ok: false };
  const shapedHitArea = typeof mainWindow.setShape === "function";
  const passThrough = shapedHitArea ? false : (!clientPanelOpen && clientWantsInputPassThrough);
  if (shapedHitArea) {
    mainWindow.setIgnoreMouseEvents(false);
  } else {
    try {
      mainWindow.setIgnoreMouseEvents(passThrough, { forward: true });
    } catch {
      mainWindow.setIgnoreMouseEvents(passThrough);
    }
  }
  if (edgeWindow && !edgeWindow.isDestroyed()) edgeWindow.setIgnoreMouseEvents(false);
  return { ok: true, passThrough, shapedHitArea };
}

function setClientInputPassThrough(passThrough) {
  clientWantsInputPassThrough = Boolean(passThrough);
  return applyClientInputPassThrough();
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mode === "client") {
    mainWindow.webContents.send("client-panel:open");
    keepClientWindowOnTop();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  keepClientWindowOnTop();
  mainWindow.focus();
}

function downloadFile(url, destination) {
  const transport = url.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Download mislukt: HTTP ${response.statusCode}`));
        response.resume();
        return;
      }

      const file = fsSync.createWriteStream(destination);
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    });
    request.on("error", reject);
    request.setTimeout(30000, () => {
      request.destroy(new Error("Download timeout."));
    });
  });
}

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function powershellPath() {
  return process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

function postUpdateToService(updateUrl, updateVersion) {
  const payload = JSON.stringify({ url: updateUrl, version: updateVersion });
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: 4787,
      path: "/update",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      },
      timeout: 2500
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          resolve(body);
          return;
        }
        reject(new Error(`Updater service HTTP ${response.statusCode}: ${body}`));
      });
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Updater service timeout.")));
    request.write(payload);
    request.end();
  });
}

async function startRestartWatcher(currentExe, updateLogPath) {
  const updateDir = path.join(os.tmpdir(), "KabinetteNotesUpdate");
  await fs.mkdir(updateDir, { recursive: true });
  const watcherPath = path.join(updateDir, "restart-client-after-update.ps1");
  const script = [
    "$ErrorActionPreference = 'Continue'",
    `$logPath = ${psString(updateLogPath)}`,
    `$currentExe = ${psString(currentExe)}`,
    "function Write-UpdateLog($message) {",
    "  $dir = Split-Path -Parent $logPath",
    "  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }",
    "  Add-Content -Path $logPath -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $message)",
    "}",
    "Write-UpdateLog 'Herstart-watcher gestart.'",
    "Start-Sleep -Seconds 5",
    "for ($i = 0; $i -lt 180; $i++) {",
    "  $running = Get-Process 'Kabinette Notes Client' -ErrorAction SilentlyContinue",
    "  if (-not $running) { break }",
    "  Start-Sleep -Seconds 1",
    "}",
    "Write-UpdateLog 'Oude client is gestopt; wachten tot installer klaar is.'",
    "Start-Sleep -Seconds 25",
    "$candidates = @(",
    "  $currentExe,",
    "  (Join-Path $env:ProgramFiles 'Kabinette Notes Client\\Kabinette Notes Client.exe'),",
    "  (Join-Path ${env:ProgramFiles(x86)} 'Kabinette Notes Client\\Kabinette Notes Client.exe')",
    ") | Where-Object { $_ }",
    "for ($i = 0; $i -lt 90; $i++) {",
    "  foreach ($candidate in $candidates) {",
    "    if (Test-Path -LiteralPath $candidate) {",
    "      Write-UpdateLog ('Applicatie herstarten vanuit user context: ' + $candidate)",
    "      Start-Process -FilePath $candidate -WorkingDirectory (Split-Path -Parent $candidate)",
    "      exit 0",
    "    }",
    "  }",
    "  Start-Sleep -Seconds 1",
    "}",
    "Write-UpdateLog 'Herstart mislukt: executable niet gevonden.'"
  ].join("\r\n");

  await fs.writeFile(watcherPath, script, "utf8");
  const child = spawn(powershellPath(), [
    "-NoProfile",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    watcherPath
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

async function installClientUpdate(updateUrl, updateVersion) {
  if (mode !== "client") return { ok: false, message: "Alleen client kan zichzelf updaten." };
  const parsed = new URL(updateUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, message: "Update URL moet http:// of https:// zijn." };
  }

  const currentExe = process.execPath;
  const updateLogPath = path.join(userDataDir, "update.log");
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.appendFile(updateLogPath, `${new Date().toISOString()} Update gevraagd: ${parsed.toString()}\r\n`, "utf8");

  try {
    await startRestartWatcher(currentExe, updateLogPath);
    await postUpdateToService(parsed.toString(), updateVersion);
    await fs.appendFile(updateLogPath, `${new Date().toISOString()} Updater service heeft update geaccepteerd.\r\n`, "utf8");
    return { ok: true, via: "service" };
  } catch (serviceError) {
    await fs.appendFile(
      updateLogPath,
      `${new Date().toISOString()} Updater service niet bruikbaar, fallback UAC: ${serviceError.message}\r\n`,
      "utf8"
    );
  }

  const updateDir = path.join(os.tmpdir(), "KabinetteNotesUpdate");
  await fs.mkdir(updateDir, { recursive: true });
  const installerPath = path.join(updateDir, "KabinetteNotesClientSetup.exe");
  const elevatedScriptPath = path.join(updateDir, "install-update-elevated.ps1");
  const launcherPath = path.join(updateDir, "launch-update.ps1");
  await downloadFile(parsed.toString(), installerPath);

  const elevatedScript = [
    "$ErrorActionPreference = 'Continue'",
    `$logPath = ${psString(updateLogPath)}`,
    `$configPath = ${psString(configPath)}`,
    `$updateVersion = ${psString(updateVersion)}`,
    "function Write-UpdateLog($message) {",
    "  $dir = Split-Path -Parent $logPath",
    "  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }",
    "  Add-Content -Path $logPath -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $message)",
    "}",
    "function Set-InstalledVersion {",
    "  if ([string]::IsNullOrWhiteSpace($updateVersion)) { return }",
    "  try {",
    "    $configDir = Split-Path -Parent $configPath",
    "    if ($configDir -and -not (Test-Path $configDir)) { New-Item -ItemType Directory -Force -Path $configDir | Out-Null }",
    "    if (Test-Path -LiteralPath $configPath) {",
    "      $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json",
    "    } else {",
    "      $config = [pscustomobject]@{}",
    "    }",
    "    $config | Add-Member -NotePropertyName 'lastInstalledUpdateVersion' -NotePropertyValue $updateVersion -Force",
    "    $config | Add-Member -NotePropertyName 'lastNotifiedUpdateVersion' -NotePropertyValue $updateVersion -Force",
    "    $config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath -Encoding UTF8",
    "    Write-UpdateLog ('Updateversie opgeslagen: ' + $updateVersion)",
    "  } catch {",
    "    Write-UpdateLog ('Updateversie opslaan mislukt: ' + $_.Exception.Message)",
    "  }",
    "}",
    "function Restart-Client {",
    "  $candidates = @(",
    "    $currentExe,",
    "    (Join-Path $env:ProgramFiles 'Kabinette Notes Client\\Kabinette Notes Client.exe'),",
    "    (Join-Path ${env:ProgramFiles(x86)} 'Kabinette Notes Client\\Kabinette Notes Client.exe')",
    "  ) | Where-Object { $_ }",
    "  for ($i = 0; $i -lt 60; $i++) {",
    "    foreach ($candidate in $candidates) {",
    "      if (Test-Path -LiteralPath $candidate) {",
    "        Write-UpdateLog ('Applicatie herstarten: ' + $candidate)",
    "        Start-Process -FilePath $candidate -WorkingDirectory (Split-Path -Parent $candidate)",
    "        return",
    "      }",
    "    }",
    "    Start-Sleep -Seconds 1",
    "  }",
    "  Write-UpdateLog 'Herstart mislukt: executable niet gevonden.'",
    "}",
    "Write-UpdateLog 'Elevated update script gestart na volledige download.'",
    `$installer = ${psString(installerPath)}`,
    `$currentExe = ${psString(currentExe)}`,
    "Get-Process 'Kabinette Notes Client' -ErrorAction SilentlyContinue | ForEach-Object {",
    "  try {",
    "    Write-UpdateLog ('Client proces stoppen: ' + $_.Id)",
    "    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue",
    "  } catch {}",
    "}",
    "Start-Sleep -Seconds 3",
    "Write-UpdateLog ('Installer starten: ' + $installer)",
    "try {",
    "  $process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru",
    "  Write-UpdateLog ('Installer klaar met exit code ' + $process.ExitCode)",
    "  if ($process.ExitCode -eq 0) { Set-InstalledVersion }",
    "  Restart-Client",
    "} catch {",
    "  Write-UpdateLog ('Installer kon niet starten: ' + $_.Exception.Message)",
    "  exit 1",
    "}"
  ].join("\r\n");

  const launcherScript = [
    "$ErrorActionPreference = 'Stop'",
    `$logPath = ${psString(updateLogPath)}`,
    `$worker = ${psString(elevatedScriptPath)}`,
    "function Write-UpdateLog($message) {",
    "  $dir = Split-Path -Parent $logPath",
    "  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }",
    "  Add-Content -Path $logPath -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $message)",
    "}",
    "try {",
    "  Write-UpdateLog ('Elevated updater starten: ' + $worker)",
    "  $powerShell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "  $args = '-NoProfile -ExecutionPolicy Bypass -File \"' + $worker + '\"'",
    "  Start-Process -FilePath $powerShell -ArgumentList $args -Verb RunAs",
    "  Write-UpdateLog 'Elevated updater gestart.'",
    "  exit 0",
    "} catch {",
    "  Write-UpdateLog ('Elevated updater starten mislukt: ' + $_.Exception.Message)",
    "  exit 1",
    "}"
  ].join("\r\n");

  await fs.appendFile(updateLogPath, `${new Date().toISOString()} Update gedownload van ${parsed.toString()}\r\n`, "utf8");
  await fs.writeFile(elevatedScriptPath, elevatedScript, "utf8");
  await fs.writeFile(launcherPath, launcherScript, "utf8");

  try {
    await execFileAsync(powershellPath(), [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPath
    ]);
  } catch {
    return { ok: false, message: "Update geannuleerd of UAC werd geweigerd." };
  }

  await startRestartWatcher(currentExe, updateLogPath);
  setTimeout(() => app.quit(), 700);
  return { ok: true };
}

async function ensureConfig() {
  await fs.mkdir(userDataDir, { recursive: true });
  let config = {};
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    config = {};
  }

  const currentClientId = String(config.clientId || "").trim();
  const clientId = currentClientId && !isLegacyGeneratedClientId(currentClientId)
    ? currentClientId
    : stableClientId();
  const previousClientIds = normalizePreviousClientIds(config.previousClientIds, clientId);
  if (currentClientId && currentClientId !== clientId) previousClientIds.push(currentClientId);

  const next = {
    serverUrl: config.serverUrl || defaultServerUrl,
    authToken: config.authToken || "",
    cabinetName: config.cabinetName || os.hostname(),
    clientId,
    previousClientIds: normalizePreviousClientIds(previousClientIds, clientId),
    lastInstalledUpdateVersion: mode === "client" ? currentAppUpdateVersion : String(config.lastInstalledUpdateVersion || ""),
    lastNotifiedUpdateVersion: String(config.lastNotifiedUpdateVersion || ""),
    edgeTabTop: Number.isFinite(config.edgeTabTop) ? config.edgeTabTop : null,
    edgeTabSide: config.edgeTabSide === "left" ? "left" : "right",
    edgeDisplayBounds: config.edgeDisplayBounds || null
  };
  if (mode === "client") {
    clientEdgePlacement = {
      top: Number.isFinite(next.edgeTabTop) ? next.edgeTabTop : null,
      side: next.edgeTabSide,
      displayBounds: next.edgeDisplayBounds
    };
  }
  await fs.writeFile(configPath, JSON.stringify(next, null, 2));
  return next;
}

async function migrateLegacyUserData() {
  if (!usesSharedWindowsData) return;
  if (path.normalize(legacyUserDataDir).toLowerCase() === path.normalize(userDataDir).toLowerCase()) return;

  await fs.mkdir(userDataDir, { recursive: true });
  for (const fileName of ["config.json", "note.txt", "chat-outbox.json", "chat-history.json"]) {
    const legacyPath = path.join(legacyUserDataDir, fileName);
    const sharedPath = path.join(userDataDir, fileName);
    try {
      await fs.access(sharedPath);
    } catch {
      try {
        await fs.copyFile(legacyPath, sharedPath);
      } catch {
        // Missing legacy data is expected on fresh all-users installs.
      }
    }
  }
}

function normalizeChatOutbox(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      clientMessageId: String(item.clientMessageId || "").slice(0, 120),
      toClientId: String(item.toClientId || "").slice(0, 120),
      text: String(item.text || "").slice(0, 1000),
      createdAt: item.createdAt || new Date().toISOString(),
      lastAttemptAt: item.lastAttemptAt || null
    }))
    .filter((item) => item.clientMessageId && item.toClientId && item.text)
    .slice(-200);
}

function normalizeChatHistory(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      id: String(item.id || "").slice(0, 160),
      clientMessageId: String(item.clientMessageId || "").slice(0, 120),
      fromClientId: String(item.fromClientId || "").slice(0, 120),
      fromName: String(item.fromName || "").slice(0, 120),
      fromComputer: String(item.fromComputer || "").slice(0, 120),
      toClientId: String(item.toClientId || "").slice(0, 120),
      text: String(item.text || "").slice(0, 1000),
      createdAt: item.createdAt || new Date().toISOString()
    }))
    .filter((item) => item.id && item.fromClientId && item.toClientId && item.text)
    .slice(-500);
}

async function createClientWindow() {
  const display = getClientDisplay();
  const side = clientEdgePlacement.side === "left" ? "left" : "right";
  clientEdgePlacement.top = clampClientEdgeTabTop(clientEdgePlacement.top, display.bounds);
  clientEdgePlacement.displayBounds = { ...display.bounds };
  const bounds = clientWindowBounds(display, side, false);
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    title: appDisplayName,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    acceptFirstMouse: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow = win;
  keepClientWindowOnTop();
  startClientTopmostGuard(win);
  win.on("show", keepClientWindowOnTop);
  win.on("restore", keepClientWindowOnTop);
  win.on("blur", () => {
    if (clientPanelOpen) win.webContents.send("window:blur");
    else keepClientWindowOnTop();
  });
  await win.loadFile(path.join(__dirname, "../renderer/client.html"));
  edgeWindow = null;
  setClientWindowOpen(false);
  keepClientWindowOnTop();
}

async function createAdminWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: appDisplayName,
    backgroundColor: "#17191d",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow = win;
  await win.loadFile(path.join(__dirname, "../renderer/admin.html"));
}

if (gotSingleInstanceLock) {
  app.on("second-instance", () => focusMainWindow());

  app.whenReady().then(async () => {
    await migrateLegacyUserData();
    await ensureConfig();
    cleanupLegacyClientAutostart();
    if (mode === "admin") await createAdminWindow();
    else await createClientWindow();
  });
}

app.on("window-all-closed", () => {
  if (mode === "admin") app.quit();
});

ipcMain.handle("app:meta", async () => {
  const config = await ensureConfig();
  let note = "";
  try {
    note = await fs.readFile(notePath, "utf8");
  } catch {
    note = "";
  }

  return {
    mode,
    config,
    note,
    paths: { configPath, notePath, chatOutboxPath, chatHistoryPath },
    computerName: os.hostname(),
    userName: os.userInfo().username
  };
});

ipcMain.handle("note:save", async (_event, note) => {
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(notePath, String(note || ""), "utf8");
  return { ok: true, notePath };
});

ipcMain.handle("config:update", async (_event, patch) => {
  const config = await ensureConfig();
  const next = { ...config, ...patch };
  const updatesEdgePlacement = Object.prototype.hasOwnProperty.call(patch, "edgeTabTop")
    || Object.prototype.hasOwnProperty.call(patch, "edgeTabSide")
    || Object.prototype.hasOwnProperty.call(patch, "edgeDisplayBounds");
  if (mode === "client" && updatesEdgePlacement) {
    const result = setClientEdgePlacement({
      top: Number(next.edgeTabTop),
      side: next.edgeTabSide,
      displayBounds: next.edgeDisplayBounds
    });
    if (result.ok) {
      next.edgeTabTop = result.edgeTabTop;
      next.edgeTabSide = result.edgeTabSide;
      next.edgeDisplayBounds = result.edgeDisplayBounds;
    }
  }
  await fs.writeFile(configPath, JSON.stringify(next, null, 2));
  return next;
});

ipcMain.handle("chat-outbox:load", async () => {
  try {
    return normalizeChatOutbox(JSON.parse(await fs.readFile(chatOutboxPath, "utf8")));
  } catch {
    return [];
  }
});

ipcMain.handle("chat-outbox:save", async (_event, items) => {
  await fs.mkdir(userDataDir, { recursive: true });
  const outbox = normalizeChatOutbox(items);
  await fs.writeFile(chatOutboxPath, JSON.stringify(outbox, null, 2), "utf8");
  return { ok: true, chatOutboxPath };
});

ipcMain.handle("chat-history:load", async () => {
  try {
    return normalizeChatHistory(JSON.parse(await fs.readFile(chatHistoryPath, "utf8")));
  } catch {
    return [];
  }
});

ipcMain.handle("chat-history:save", async (_event, items) => {
  await fs.mkdir(userDataDir, { recursive: true });
  const history = normalizeChatHistory(items);
  await fs.writeFile(chatHistoryPath, JSON.stringify(history, null, 2), "utf8");
  return { ok: true, chatHistoryPath };
});

ipcMain.handle("window:focus", async () => {
  if (!mainWindow) return { ok: false };
  if (mode === "client") {
    mainWindow.webContents.send("client-panel:open");
    keepClientWindowOnTop();
    return { ok: true };
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  keepClientWindowOnTop();
  mainWindow.focus();
  return { ok: true };
});

ipcMain.handle("client-window:set-open", async (_event, open) => setClientWindowOpen(Boolean(open)));
ipcMain.handle("client-window:set-input-passthrough", async (_event, passThrough) => (
  setClientInputPassThrough(Boolean(passThrough))
));
ipcMain.handle("client-window:set-edge-tab-top", async (_event, top) => setClientEdgePlacement({ top: Number(top) }));
ipcMain.handle("client-window:preview-edge-drag", async (_event, position) => previewClientEdgeDrag(position || {}));
ipcMain.handle("client-window:set-edge-tab-position", async (_event, position) => setClientEdgePlacement(position || {}));

ipcMain.handle("client:update-install", async (_event, updateUrl, updateVersion) => (
  installClientUpdate(String(updateUrl || ""), String(updateVersion || ""))
));

ipcMain.handle("app:quit", async () => {
  app.quit();
  return { ok: true };
});
