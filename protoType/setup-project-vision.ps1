param(
  [Parameter(Mandatory=$true)]
  [string]$ExtensionId
)

$Prototype = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $Prototype "register-native-host.ps1") -ExtensionId $ExtensionId

Write-Host ""
Write-Host "IMPORTANT: keep app.py outside protoType, preferably here:"
Write-Host "  $((Split-Path -Parent $Prototype))\varun\app.py"
Write-Host ""
Write-Host "This keeps Python __pycache__ folders out of the Chrome extension directory."
