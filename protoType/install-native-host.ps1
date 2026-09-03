param(
  [Parameter(Mandatory=$true)]
  [string]$ExtensionId,
  [string]$ProjectRoot = ""
)

$ErrorActionPreference = "Stop"
$HostName = "com.projectvision.local_server"
$Proto = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = Split-Path -Parent $Proto
}
$ProjectRoot = (Resolve-Path $ProjectRoot).Path

$python = Get-Command py -ErrorAction SilentlyContinue
$pythonCommand = ""
if ($python) {
  $pythonCommand = $python.Source
} else {
  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($python) { $pythonCommand = $python.Source }
}
if (-not $pythonCommand) { throw "Python was not found. Install Python 3 and ensure 'py' or 'python' is on PATH." }

$InstallRoot = Join-Path $env:LOCALAPPDATA "Project-Vision\native-host"
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
$HostPy = Join-Path $InstallRoot "native_host.py"
$Wrapper = Join-Path $InstallRoot "native_host.cmd"
$Manifest = Join-Path $InstallRoot "$HostName.json"
Copy-Item (Join-Path $Proto "native_host.py") $HostPy -Force

$wrapperText = @"
@echo off
set "PROJECT_VISION_ROOT=$ProjectRoot"
set "PROJECT_VISION_APP=$ProjectRoot\varun\app.py"
"$pythonCommand" -B "$HostPy"
"@
Set-Content -Path $Wrapper -Value $wrapperText -Encoding ASCII

$manifestObject = @{
  name = $HostName
  description = "Project-Vision local server launcher"
  path = $Wrapper
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifestObject | ConvertTo-Json -Depth 5 | Set-Content -Path $Manifest -Encoding UTF8

$RegKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $RegKey -Force | Out-Null
Set-ItemProperty -Path $RegKey -Name '(default)' -Value $Manifest

Write-Host "Project-Vision native host registered."
Write-Host "Extension ID: $ExtensionId"
Write-Host "Project root: $ProjectRoot"
Write-Host "Python:       $pythonCommand"
Write-Host "Host:         $Manifest"
Write-Host "Restart Chrome, then reload the extension."
