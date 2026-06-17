param(
  [switch]$Clean,
  [switch]$SkipInstall,
  [switch]$UseNpmInstall,
  [switch]$NoServer,
  [switch]$NoClient,
  [switch]$NoAdmin,
  [switch]$CheckOnly,
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
    [string[]]$Arguments
  )

  Write-Host ("$FilePath " + ($Arguments -join " ")) -ForegroundColor DarkGray
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath exited with code $LASTEXITCODE."
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

Write-Step "Reading package metadata"
$package = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
$appVersion = if ([string]::IsNullOrWhiteSpace($Version)) { [string]$package.version } else { $Version.Trim() }
if ([string]::IsNullOrWhiteSpace($appVersion)) {
  throw "Package version is empty."
}
$updateVersion = "app:$appVersion"
Write-Host "Version: $appVersion"
Write-Host "Update version: $updateVersion"

Write-Step "Checking local tools"
Invoke-Logged "node" @("--version")
Invoke-Logged "npm" @("--version")

if ($Clean) {
  Write-Step "Cleaning generated output"
  Remove-DirectoryInsideRepo (Join-Path $repoRoot "dist")
  Remove-DirectoryInsideRepo (Join-Path $repoRoot "build\updater-service-publish")
}

if (-not $SkipInstall) {
  Write-Step "Installing npm dependencies"
  if ($UseNpmInstall -or -not (Test-Path -LiteralPath (Join-Path $repoRoot "package-lock.json"))) {
    Invoke-Logged "npm" @("install")
  } else {
    Invoke-Logged "npm" @("ci")
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
  Invoke-Logged "node" @("--check", $file)
}

if ($CheckOnly) {
  Write-Step "Check-only mode complete"
  exit 0
}

if (-not $NoClient) {
  Write-Step "Building updater service"
  $dotnet = Get-Command "dotnet" -ErrorAction SilentlyContinue
  if (-not $dotnet) {
    throw "dotnet SDK is required for the client updater service. Install .NET SDK or use -NoClient."
  }

  $publishDir = Join-Path $repoRoot "build\updater-service-publish"
  New-Item -ItemType Directory -Force -Path $publishDir | Out-Null
  Invoke-Logged "dotnet" @(
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
  Invoke-Logged "npm" @("run", "build:server")
}

if (-not $NoClient) {
  Write-Step "Building client installer"
  Invoke-Logged "npm" @("run", "build:client")

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
  Invoke-Logged "npm" @("run", "build:admin")
}

Write-Step "Build complete"
Write-Host "Server: dist\KabinetteServer.exe"
Write-Host "Client installer: dist\client\Kabinette Notes Client Setup $appVersion.exe"
Write-Host "Client update endpoint files: dist\client-installer.exe and dist\client-setup.exe"
Write-Host "Admin installer: dist\admin\Kabinette Notes Admin Setup $appVersion.exe"
