$ErrorActionPreference = "Continue"

$dataDir = Join-Path $env:ProgramData "KabinetteNotes"
$updateDir = Join-Path $dataDir "Updates"
$logPath = Join-Path $dataDir "scheduled-update.log"
$installerPath = Join-Path $updateDir "KabinetteNotesClientSetup.exe"
$envUpdateUrl = [string]$env:KABINETTE_UPDATE_URL
$allowedHost = [string]$env:KABINETTE_UPDATE_HOST

function Write-UpdateLog {
  param([string]$Message)
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  Add-Content -Path $logPath -Value ((Get-Date).ToString("yyyy-MM-dd HH:mm:ss") + " " + $Message)
}

function Test-AllowedHost {
  param([Uri]$Uri)
  if ([string]::IsNullOrWhiteSpace($allowedHost)) {
    return $true
  }
  return $Uri.Host -eq $allowedHost
}

function Resolve-UpdateUrl {
  if (-not [string]::IsNullOrWhiteSpace($envUpdateUrl)) {
    try {
      $envUri = [Uri]$envUpdateUrl
      if (Test-AllowedHost $envUri) {
        return $envUri.AbsoluteUri
      }
      Write-UpdateLog "Environment update host '$($envUri.Host)' rejected."
    } catch {
      Write-UpdateLog ("Environment update URL invalid: " + $_.Exception.Message)
    }
  }

  $configPath = Join-Path $dataDir "config.json"
  if (-not (Test-Path $configPath)) {
    throw "No update URL configured. Start the client once or set KABINETTE_UPDATE_URL."
  }

  $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  $serverUrl = [string]$config.serverUrl
  if ([string]::IsNullOrWhiteSpace($serverUrl)) {
    throw "No serverUrl found in $configPath."
  }

  $uri = [Uri]$serverUrl
  if (-not (Test-AllowedHost $uri)) {
    throw "Configured host '$($uri.Host)' rejected by KABINETTE_UPDATE_HOST."
  }

  $builder = [UriBuilder]::new($uri)
  $builder.Scheme = if ($uri.Scheme -eq "wss") { "https" } else { "http" }
  $builder.Path = "/updates/client-setup.exe"
  $builder.Query = ""
  return $builder.Uri.AbsoluteUri
}

try {
  New-Item -ItemType Directory -Force -Path $updateDir | Out-Null
  $updateUrl = Resolve-UpdateUrl
  Write-UpdateLog "Download started: $updateUrl"

  Invoke-WebRequest -Uri $updateUrl -OutFile $installerPath -UseBasicParsing
  $downloaded = Get-Item -LiteralPath $installerPath
  Write-UpdateLog "Download complete: $($downloaded.Length) bytes"

  $clientProcesses = Get-Process "Kabinette Notes Client" -ErrorAction SilentlyContinue
  foreach ($process in $clientProcesses) {
    try {
      Write-UpdateLog "Stopping client process: $($process.Id)"
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    } catch {}
  }

  Start-Sleep -Seconds 2
  Write-UpdateLog "Starting installer as SYSTEM: $installerPath"
  $installer = Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait -PassThru
  Write-UpdateLog "Installer finished with exit code $($installer.ExitCode)"
} catch {
  Write-UpdateLog ("Update failed: " + $_.Exception.Message)
  exit 1
}
