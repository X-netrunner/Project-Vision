$HostName = "com.projectvision.local_server"
$RegKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
Remove-Item $RegKey -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:LOCALAPPDATA "Project-Vision\native-host") -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Project-Vision native host unregistered."
