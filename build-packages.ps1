$ErrorActionPreference = "Stop"

$buildScript = Join-Path $PSScriptRoot "scripts\build-packages.ps1"
if (-not (Test-Path -LiteralPath $buildScript)) {
  throw "Build script not found: $buildScript"
}

& $buildScript @args
exit $LASTEXITCODE
