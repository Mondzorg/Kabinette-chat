param(
  [switch]$Clean,
  [switch]$SkipInstall,
  [switch]$UseNpmInstall,
  [switch]$NoServer,
  [switch]$NoClient,
  [switch]$NoAdmin,
  [switch]$CheckOnly,
  [switch]$Cli,
  [string]$ServerUrl,
  [string]$AuthToken,
  [string]$Version
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-Logged {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList = @()
  )

  Write-Host ("$FilePath " + ($ArgumentList -join " ")) -ForegroundColor DarkGray
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath exited with code $LASTEXITCODE."
  }
}

function Resolve-ToolPath {
  param(
    [string]$Name,
    [string[]]$PreferredExtensions = @(".cmd", ".exe", "")
  )

  foreach ($extension in $PreferredExtensions) {
    $commandName = if ($extension) { "$Name$extension" } else { $Name }
    $whereResult = where.exe $commandName 2>$null | Select-Object -First 1
    if ($whereResult) {
      return [string]$whereResult
    }

    $command = Get-Command $commandName -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command -and $command.Source) {
      return $command.Source
    }
    if ($command -and $command.Path) {
      return $command.Path
    }
  }

  throw "$Name was not found in PATH."
}

function Normalize-ServerUrl {
  param([string]$Value)

  $trimmed = ([string]$Value).Trim()
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    return ""
  }

  $withProtocol = if ($trimmed -match "^[a-z]+://") { $trimmed } else { "ws://$trimmed" }
  $uri = [UriBuilder]::new($withProtocol)
  if ($uri.Scheme -ne "ws" -and $uri.Scheme -ne "wss") {
    throw "Server URL must use ws:// or wss://."
  }
  $hasExplicitPort = $withProtocol -match "^[a-z]+://(\[[^\]]+\]|[^/:]+):\d+"
  if (-not $hasExplicitPort) {
    $uri.Port = 4780
  }
  $uri.Path = $uri.Path.TrimEnd("/")
  return $uri.Uri.AbsoluteUri.TrimEnd("/")
}

function Show-BuildGui {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  [System.Windows.Forms.Application]::EnableVisualStyles()

  $form = [System.Windows.Forms.Form]::new()
  $form.Text = "Kabinette Notes Setup & Package Builder"
  $form.StartPosition = "CenterScreen"
  $form.FormBorderStyle = "FixedDialog"
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.ClientSize = [System.Drawing.Size]::new(720, 640)
  $form.Font = [System.Drawing.Font]::new("Segoe UI", 9)

  $title = [System.Windows.Forms.Label]::new()
  $title.Text = "Kabinette Notes setup"
  $title.Font = [System.Drawing.Font]::new("Segoe UI", 15, [System.Drawing.FontStyle]::Bold)
  $title.Location = [System.Drawing.Point]::new(22, 18)
  $title.Size = [System.Drawing.Size]::new(660, 30)
  $form.Controls.Add($title)

  $subtitle = [System.Windows.Forms.Label]::new()
  $subtitle.Text = "Configure the internal server, choose which app parts to compile, and generate deployment helper files."
  $subtitle.ForeColor = [System.Drawing.Color]::FromArgb(85, 85, 85)
  $subtitle.Location = [System.Drawing.Point]::new(24, 52)
  $subtitle.Size = [System.Drawing.Size]::new(660, 22)
  $form.Controls.Add($subtitle)

  $connectionGroup = [System.Windows.Forms.GroupBox]::new()
  $connectionGroup.Text = "1. Internal connection"
  $connectionGroup.Location = [System.Drawing.Point]::new(22, 86)
  $connectionGroup.Size = [System.Drawing.Size]::new(676, 152)
  $form.Controls.Add($connectionGroup)

  $serverLabel = [System.Windows.Forms.Label]::new()
  $serverLabel.Text = "Server URL or IP"
  $serverLabel.Location = [System.Drawing.Point]::new(18, 28)
  $serverLabel.Size = [System.Drawing.Size]::new(160, 22)
  $connectionGroup.Controls.Add($serverLabel)

  $serverInput = [System.Windows.Forms.TextBox]::new()
  $serverInput.Text = $script:ServerUrl
  $serverInput.Location = [System.Drawing.Point]::new(18, 50)
  $serverInput.Size = [System.Drawing.Size]::new(638, 28)
  $connectionGroup.Controls.Add($serverInput)

  $serverHelp = [System.Windows.Forms.Label]::new()
  $serverHelp.Text = "Example: 10.0.0.10 or ws://notes-server:4780. If no port is entered, 4780 is used."
  $serverHelp.ForeColor = [System.Drawing.Color]::FromArgb(95, 95, 95)
  $serverHelp.Location = [System.Drawing.Point]::new(18, 82)
  $serverHelp.Size = [System.Drawing.Size]::new(638, 20)
  $connectionGroup.Controls.Add($serverHelp)

  $tokenLabel = [System.Windows.Forms.Label]::new()
  $tokenLabel.Text = "Optional token"
  $tokenLabel.Location = [System.Drawing.Point]::new(18, 106)
  $tokenLabel.Size = [System.Drawing.Size]::new(160, 22)
  $connectionGroup.Controls.Add($tokenLabel)

  $tokenInput = [System.Windows.Forms.TextBox]::new()
  $tokenInput.Text = $script:AuthToken
  $tokenInput.UseSystemPasswordChar = $true
  $tokenInput.Location = [System.Drawing.Point]::new(146, 104)
  $tokenInput.Size = [System.Drawing.Size]::new(510, 28)
  $connectionGroup.Controls.Add($tokenInput)

  $packagesGroup = [System.Windows.Forms.GroupBox]::new()
  $packagesGroup.Text = "2. Choose packages to compile"
  $packagesGroup.Location = [System.Drawing.Point]::new(22, 252)
  $packagesGroup.Size = [System.Drawing.Size]::new(332, 178)
  $form.Controls.Add($packagesGroup)

  $serverBox = [System.Windows.Forms.CheckBox]::new()
  $serverBox.Text = "Server exe - KabinetteServer.exe"
  $serverBox.Checked = -not [bool]$script:NoServer
  $serverBox.Location = [System.Drawing.Point]::new(18, 30)
  $serverBox.Size = [System.Drawing.Size]::new(290, 24)
  $packagesGroup.Controls.Add($serverBox)

  $serverBoxHelp = [System.Windows.Forms.Label]::new()
  $serverBoxHelp.Text = "Runs the WebSocket server and hosts update files."
  $serverBoxHelp.ForeColor = [System.Drawing.Color]::FromArgb(95, 95, 95)
  $serverBoxHelp.Location = [System.Drawing.Point]::new(38, 54)
  $serverBoxHelp.Size = [System.Drawing.Size]::new(280, 18)
  $packagesGroup.Controls.Add($serverBoxHelp)

  $clientBox = [System.Windows.Forms.CheckBox]::new()
  $clientBox.Text = "Client installer - sidebar app"
  $clientBox.Checked = -not [bool]$script:NoClient
  $clientBox.Location = [System.Drawing.Point]::new(18, 78)
  $clientBox.Size = [System.Drawing.Size]::new(290, 24)
  $packagesGroup.Controls.Add($clientBox)

  $clientBoxHelp = [System.Windows.Forms.Label]::new()
  $clientBoxHelp.Text = "Installs the shared PC note/chat sidebar."
  $clientBoxHelp.ForeColor = [System.Drawing.Color]::FromArgb(95, 95, 95)
  $clientBoxHelp.Location = [System.Drawing.Point]::new(38, 102)
  $clientBoxHelp.Size = [System.Drawing.Size]::new(280, 18)
  $packagesGroup.Controls.Add($clientBoxHelp)

  $adminBox = [System.Windows.Forms.CheckBox]::new()
  $adminBox.Text = "Admin installer - beheer/controller"
  $adminBox.Checked = -not [bool]$script:NoAdmin
  $adminBox.Location = [System.Drawing.Point]::new(18, 126)
  $adminBox.Size = [System.Drawing.Size]::new(290, 24)
  $packagesGroup.Controls.Add($adminBox)

  $adminBoxHelp = [System.Windows.Forms.Label]::new()
  $adminBoxHelp.Text = "Lets admins/managers manage computer notes."
  $adminBoxHelp.ForeColor = [System.Drawing.Color]::FromArgb(95, 95, 95)
  $adminBoxHelp.Location = [System.Drawing.Point]::new(38, 150)
  $adminBoxHelp.Size = [System.Drawing.Size]::new(280, 18)
  $packagesGroup.Controls.Add($adminBoxHelp)

  $actionsGroup = [System.Windows.Forms.GroupBox]::new()
  $actionsGroup.Text = "3. Build actions"
  $actionsGroup.Location = [System.Drawing.Point]::new(366, 252)
  $actionsGroup.Size = [System.Drawing.Size]::new(332, 178)
  $form.Controls.Add($actionsGroup)

  $cleanBox = [System.Windows.Forms.CheckBox]::new()
  $cleanBox.Text = "Clean old dist/build output first"
  $cleanBox.Checked = [bool]$script:Clean
  $cleanBox.Location = [System.Drawing.Point]::new(18, 30)
  $cleanBox.Size = [System.Drawing.Size]::new(290, 24)
  $actionsGroup.Controls.Add($cleanBox)

  $checkOnlyBox = [System.Windows.Forms.CheckBox]::new()
  $checkOnlyBox.Text = "Check only - do not create exe files"
  $checkOnlyBox.Checked = [bool]$script:CheckOnly
  $checkOnlyBox.Location = [System.Drawing.Point]::new(18, 64)
  $checkOnlyBox.Size = [System.Drawing.Size]::new(290, 24)
  $actionsGroup.Controls.Add($checkOnlyBox)

  $skipInstallBox = [System.Windows.Forms.CheckBox]::new()
  $skipInstallBox.Text = "Skip npm install/npm ci"
  $skipInstallBox.Checked = [bool]$script:SkipInstall
  $skipInstallBox.Location = [System.Drawing.Point]::new(18, 98)
  $skipInstallBox.Size = [System.Drawing.Size]::new(290, 24)
  $actionsGroup.Controls.Add($skipInstallBox)

  $actionsHelp = [System.Windows.Forms.Label]::new()
  $actionsHelp.Text = "After you click Build, this window closes and the terminal shows each step."
  $actionsHelp.ForeColor = [System.Drawing.Color]::FromArgb(95, 95, 95)
  $actionsHelp.Location = [System.Drawing.Point]::new(18, 130)
  $actionsHelp.Size = [System.Drawing.Size]::new(292, 36)
  $actionsGroup.Controls.Add($actionsHelp)

  $outputGroup = [System.Windows.Forms.GroupBox]::new()
  $outputGroup.Text = "4. What this creates"
  $outputGroup.Location = [System.Drawing.Point]::new(22, 444)
  $outputGroup.Size = [System.Drawing.Size]::new(676, 96)
  $form.Controls.Add($outputGroup)

  $outputLabel = [System.Windows.Forms.Label]::new()
  $outputLabel.Text = "Server: dist\KabinetteServer.exe`r`nClient: dist\client\Kabinette Notes Client Setup x.y.z.exe plus update files`r`nAdmin: dist\admin\Kabinette Notes Admin Setup x.y.z.exe`r`nHelper config: dist\client-config.example.json and server-run.example.ps1"
  $outputLabel.ForeColor = [System.Drawing.Color]::FromArgb(60, 60, 60)
  $outputLabel.Location = [System.Drawing.Point]::new(18, 24)
  $outputLabel.Size = [System.Drawing.Size]::new(638, 62)
  $outputGroup.Controls.Add($outputLabel)

  $hint = [System.Windows.Forms.Label]::new()
  $hint.Text = "Server URL/token help configure deployment files. They are not hardcoded into the generated exe files."
  $hint.ForeColor = [System.Drawing.Color]::FromArgb(95, 95, 95)
  $hint.Location = [System.Drawing.Point]::new(24, 550)
  $hint.Size = [System.Drawing.Size]::new(520, 34)
  $form.Controls.Add($hint)

  $cancelButton = [System.Windows.Forms.Button]::new()
  $cancelButton.Text = "Cancel"
  $cancelButton.Location = [System.Drawing.Point]::new(486, 592)
  $cancelButton.Size = [System.Drawing.Size]::new(96, 32)
  $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $form.Controls.Add($cancelButton)

  $buildButton = [System.Windows.Forms.Button]::new()
  $buildButton.Text = "Build"
  $buildButton.Location = [System.Drawing.Point]::new(596, 592)
  $buildButton.Size = [System.Drawing.Size]::new(96, 32)
  $buildButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $form.Controls.Add($buildButton)
  $form.AcceptButton = $buildButton
  $form.CancelButton = $cancelButton

  $result = $form.ShowDialog()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
    Write-Host "Build cancelled."
    exit 0
  }

  $script:ServerUrl = $serverInput.Text.Trim()
  $script:AuthToken = $tokenInput.Text
  $script:Clean = $cleanBox.Checked
  $script:SkipInstall = $skipInstallBox.Checked
  $script:NoServer = -not $serverBox.Checked
  $script:NoClient = -not $clientBox.Checked
  $script:NoAdmin = -not $adminBox.Checked
  $script:CheckOnly = $checkOnlyBox.Checked
}

function Write-DeploymentHelpers {
  param(
    [string]$DistPath,
    [string]$ResolvedServerUrl,
    [string]$Token,
    [string]$AppVersion
  )

  New-Item -ItemType Directory -Force -Path $DistPath | Out-Null
  $serverUrlForFile = if ($ResolvedServerUrl) { $ResolvedServerUrl } else { "ws://YOUR-SERVER-HOST:4780" }
  $tokenForFile = if ($Token) { $Token } else { "" }
  $publicHost = ""
  $port = "4780"
  if ($ResolvedServerUrl) {
    $uri = [Uri]$ResolvedServerUrl
    $port = if ($uri.Port -gt 0) { [string]$uri.Port } else { "4780" }
    $publicHost = if ($uri.IsDefaultPort) { $uri.Host } else { "$($uri.Host):$($uri.Port)" }
  }

  $clientConfig = [ordered]@{
    serverUrl = $serverUrlForFile
    authToken = $tokenForFile
  }
  $clientConfig | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $DistPath "client-config.example.json") -Encoding UTF8

  $deploySettings = [ordered]@{
    version = $AppVersion
    updateVersion = "app:$AppVersion"
    serverUrl = $serverUrlForFile
    tokenConfigured = -not [string]::IsNullOrWhiteSpace($tokenForFile)
  }
  $deploySettings | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $DistPath "deploy-settings.json") -Encoding UTF8

  $serverRun = @(
    '$ErrorActionPreference = "Stop"',
    '$env:PORT = "' + $port + '"',
    '$env:KABINETTE_TOKEN = "' + ($tokenForFile.Replace('"', '\"')) + '"',
    '$env:KABINETTE_PUBLIC_HOST = "' + ($publicHost.Replace('"', '\"')) + '"',
    '.\KabinetteServer.exe'
  ) -join [Environment]::NewLine
  Set-Content -LiteralPath (Join-Path $DistPath "server-run.example.ps1") -Value $serverRun -Encoding UTF8
}

function Set-PackagedDefaults {
  param(
    [string]$ResolvedServerUrl,
    [string]$Token
  )

  $defaultsPath = Join-Path $repoRoot "src\electron\build-defaults.generated.json"
  if ([string]::IsNullOrWhiteSpace($ResolvedServerUrl) -and [string]::IsNullOrWhiteSpace($Token)) {
    if (Test-Path -LiteralPath $defaultsPath) {
      Remove-Item -LiteralPath $defaultsPath -Force
    }
    return $false
  }

  $defaults = [ordered]@{
    serverUrl = $ResolvedServerUrl
    authToken = if ($Token) { $Token } else { "" }
  }
  $defaults | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $defaultsPath -Encoding UTF8
  Write-Host "Packaged defaults: server/token will be used by new client/admin installs."
  return $true
}

function Clear-PackagedDefaults {
  $defaultsPath = Join-Path $repoRoot "src\electron\build-defaults.generated.json"
  if (Test-Path -LiteralPath $defaultsPath) {
    Remove-Item -LiteralPath $defaultsPath -Force
  }
}

function Remove-DirectoryInsideRepo {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  $resolvedRoot = [IO.Path]::GetFullPath($repoRoot).TrimEnd('\')
  $resolvedPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if (-not $resolvedPath.StartsWith($resolvedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove path outside repository: $resolvedPath"
  }

  Remove-Item -LiteralPath $resolvedPath -Recurse -Force
}

$scriptDir = Split-Path -Parent $PSCommandPath
$repoRoot = [IO.Path]::GetFullPath((Join-Path $scriptDir ".."))
Set-Location $repoRoot

if (-not $Cli -and $PSBoundParameters.Count -eq 0 -and [Environment]::UserInteractive) {
  Show-BuildGui
}

Write-Step "Reading package metadata"
$package = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
$appVersion = if ([string]::IsNullOrWhiteSpace($Version)) { [string]$package.version } else { $Version.Trim() }
if ([string]::IsNullOrWhiteSpace($appVersion)) {
  throw "Package version is empty."
}
$updateVersion = "app:$appVersion"
Write-Host "Version: $appVersion"
Write-Host "Update version: $updateVersion"

$normalizedServerUrl = Normalize-ServerUrl $ServerUrl
if ($normalizedServerUrl) {
  Write-Host "Deployment server URL: $normalizedServerUrl"
}

Write-Step "Checking local tools"
$nodeTool = Resolve-ToolPath "node" @(".exe", "")
$npmTool = Resolve-ToolPath "npm" @(".cmd", ".exe", "")
$dotnetTool = $null
Invoke-Logged -FilePath $nodeTool -ArgumentList @("--version")
Invoke-Logged -FilePath $npmTool -ArgumentList @("--version")

if ($Clean) {
  Write-Step "Cleaning generated output"
  Remove-DirectoryInsideRepo (Join-Path $repoRoot "dist")
  Remove-DirectoryInsideRepo (Join-Path $repoRoot "build\updater-service-publish")
}

if (-not $SkipInstall) {
  Write-Step "Installing npm dependencies"
  if ($UseNpmInstall -or -not (Test-Path -LiteralPath (Join-Path $repoRoot "package-lock.json"))) {
    Invoke-Logged -FilePath $npmTool -ArgumentList @("install")
  } else {
    Invoke-Logged -FilePath $npmTool -ArgumentList @("ci")
  }
} elseif (-not (Test-Path -LiteralPath (Join-Path $repoRoot "node_modules"))) {
  Write-Warning "node_modules is missing. Remove -SkipInstall before doing a real build."
}

Write-Step "Checking JavaScript syntax"
$jsFiles = @(
  "src\electron\main.js",
  "src\electron\preload.js",
  "src\renderer\admin.js",
  "src\renderer\client.js",
  "src\renderer\tab.js",
  "src\server\server.js"
)
foreach ($file in $jsFiles) {
  Invoke-Logged -FilePath $nodeTool -ArgumentList @("--check", $file)
}

if ($CheckOnly) {
  Write-DeploymentHelpers -DistPath (Join-Path $repoRoot "dist") -ResolvedServerUrl $normalizedServerUrl -Token $AuthToken -AppVersion $appVersion
  Write-Step "Check-only mode complete"
  exit 0
}

$packagedDefaultsWritten = $false
if ((-not $NoClient) -or (-not $NoAdmin)) {
  $packagedDefaultsWritten = Set-PackagedDefaults -ResolvedServerUrl $normalizedServerUrl -Token $AuthToken
}

if (-not $NoClient) {
  Write-Step "Building updater service"
  $dotnetTool = Resolve-ToolPath "dotnet" @(".exe", "")
  if (-not $dotnetTool) {
    throw "dotnet SDK is required for the client updater service. Install .NET SDK or use -NoClient."
  }

  $publishDir = Join-Path $repoRoot "build\updater-service-publish"
  New-Item -ItemType Directory -Force -Path $publishDir | Out-Null
  Invoke-Logged -FilePath $dotnetTool -ArgumentList @(
    "publish",
    "src\updater-service\KabinetteUpdaterService.csproj",
    "-c",
    "Release",
    "-r",
    "win-x64",
    "--self-contained",
    "true",
    "-p:PublishSingleFile=true",
    "-p:PublishTrimmed=false",
    "-o",
    $publishDir
  )

  $serviceExe = Join-Path $publishDir "KabinetteUpdaterService.exe"
  if (-not (Test-Path -LiteralPath $serviceExe)) {
    throw "Updater service build did not produce $serviceExe."
  }
  Copy-Item -LiteralPath $serviceExe -Destination (Join-Path $repoRoot "build\KabinetteUpdaterService.exe") -Force
}

if (-not $NoServer) {
  Write-Step "Building server package"
  Invoke-Logged -FilePath $npmTool -ArgumentList @("run", "build:server")
}

if (-not $NoClient) {
  Write-Step "Building client installer"
  Invoke-Logged -FilePath $npmTool -ArgumentList @("run", "build:client")

  Write-Step "Preparing server-hosted client update files"
  $clientDist = Join-Path $repoRoot "dist\client"
  $setupName = "Kabinette Notes Client Setup $appVersion.exe"
  $setupPath = Join-Path $clientDist $setupName
  if (-not (Test-Path -LiteralPath $setupPath)) {
    $setup = Get-ChildItem -LiteralPath $clientDist -Filter "Kabinette Notes Client Setup *.exe" -File |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if (-not $setup) {
      throw "Client setup executable not found in $clientDist."
    }
    $setupPath = $setup.FullName
  }

  $blockmapPath = "$setupPath.blockmap"
  if (-not (Test-Path -LiteralPath $blockmapPath)) {
    throw "Client blockmap not found: $blockmapPath"
  }

  $dist = Join-Path $repoRoot "dist"
  New-Item -ItemType Directory -Force -Path $dist | Out-Null
  Copy-Item -LiteralPath $setupPath -Destination (Join-Path $dist "client-installer.exe") -Force
  Copy-Item -LiteralPath $setupPath -Destination (Join-Path $dist "client-setup.exe") -Force
  Copy-Item -LiteralPath $blockmapPath -Destination (Join-Path $dist "client-installer.exe.blockmap") -Force
  Copy-Item -LiteralPath $blockmapPath -Destination (Join-Path $dist "client-setup.exe.blockmap") -Force

  $versionFiles = @(
    "client-installer.version",
    "client-installer.exe.version",
    "client-setup.version",
    "client-setup.exe.version"
  )
  foreach ($file in $versionFiles) {
    Set-Content -LiteralPath (Join-Path $dist $file) -Value $updateVersion -NoNewline
  }
}

if (-not $NoAdmin) {
  Write-Step "Building admin installer"
  Invoke-Logged -FilePath $npmTool -ArgumentList @("run", "build:admin")
}

if ($packagedDefaultsWritten) {
  Clear-PackagedDefaults
}

Write-DeploymentHelpers -DistPath (Join-Path $repoRoot "dist") -ResolvedServerUrl $normalizedServerUrl -Token $AuthToken -AppVersion $appVersion

Write-Step "Build complete"
Write-Host "Server: dist\KabinetteServer.exe"
Write-Host "Client installer: dist\client\Kabinette Notes Client Setup $appVersion.exe"
Write-Host "Client update endpoint files: dist\client-installer.exe and dist\client-setup.exe"
Write-Host "Admin installer: dist\admin\Kabinette Notes Admin Setup $appVersion.exe"
