param(
  [Parameter(Mandatory=$true)]
  [string]$ExtensionId
)

$Prototype = Split-Path -Parent $MyInvocation.MyCommand.Path
$NativeHostName = "com.projectvision.local_server"
$InstallRoot = Join-Path $env:LOCALAPPDATA "Project-Vision"
$HostDir = Join-Path $InstallRoot "native-host"
$ManifestPath = Join-Path $HostDir "$NativeHostName.json"
$NativeHostPath = Join-Path $Prototype "native_host.py"

if (-not (Test-Path $NativeHostPath)) { throw "Missing $NativeHostPath" }
New-Item -ItemType Directory -Force -Path $HostDir | Out-Null

$Wrapper = Join-Path $HostDir "native_host.cmd"
"@echo off`r`npython `"$NativeHostPath`"" | Set-Content -Encoding ASCII $Wrapper

$manifest = @{
  name = $NativeHostName
  description = "Project-Vision local server launcher"
  path = $Wrapper
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $ManifestPath

$regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$NativeHostName"
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name '(default)' -Value $ManifestPath

Write-Host "Native Messaging registered for extension: $ExtensionId"
Write-Host "Manifest: $ManifestPath"
Write-Host "The extension will now be able to start app.py automatically."
Write-Host "Restart Chrome, then reload Project-Vision."
