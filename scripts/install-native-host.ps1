# Install Manga Translator Native Messaging Host
# Usage (Admin PowerShell):
#   .\scripts\install-native-host.ps1 -ExtensionId "abcdefghijklmnopabcdefghijklmnop"
#
# To find your Extension ID: chrome://extensions -> Developer mode ON -> look at the extension card

param(
    [Parameter(Mandatory = $true)]
    [string]$ExtensionId
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$HostDir = Join-Path $ProjectRoot "native-messaging-host"

# Read the template
$templatePath = Join-Path $HostDir "com.manga.translator.ocr.json"
$manifest = [System.IO.File]::ReadAllText($templatePath, [System.Text.Encoding]::UTF8)

# Replace placeholders
$launcherAbsPath = (Join-Path $HostDir "run_nmh.bat").Replace('\', '\\')
$manifest = $manifest.Replace("__EXTENSION_ID__", $ExtensionId)
$manifest = $manifest.Replace('"path": "nmh_launcher.py"', ('"path": "' + $launcherAbsPath + '"'))

# Save updated manifest next to template
$tempManifest = Join-Path $HostDir "com.manga.translator.ocr.installed.json"
[System.IO.File]::WriteAllText($tempManifest, $manifest, [System.Text.Encoding]::UTF8)

# Copy to user's local app data
$InstallDir = Join-Path $env:LOCALAPPDATA "Com\MangaTranslator\Ocr"
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}
$InstalledManifest = Join-Path $InstallDir "com.manga.translator.ocr.json"

# Update path to installed location
$installedLauncherPath = (Join-Path $InstallDir "nmh_launcher.py").Replace('\', '\\')
$manifest = $manifest.Replace($launcherAbsPath, $installedLauncherPath)
[System.IO.File]::WriteAllText($InstalledManifest, $manifest, [System.Text.Encoding]::UTF8)

# Copy the launcher script
$InstalledLauncher = Join-Path $InstallDir "nmh_launcher.py"
Copy-Item (Join-Path $HostDir "nmh_launcher.py") $InstalledLauncher -Force

# Register in Chrome Native Messaging registry
$RegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.manga.translator.ocr"
if (-not (Test-Path $RegPath)) {
    New-Item -Path $RegPath -Force | Out-Null
}
Set-ItemProperty -Path $RegPath -Name "(default)" -Value $InstalledManifest

Write-Host ""
Write-Host "Done! Installed to: $InstallDir"
Write-Host "Manifest: $InstalledManifest"
Write-Host "Launcher: $InstalledLauncher"
Write-Host "Registry: HKCU\Software\Google\Chrome\NativeMessagingHosts\com.manga.translator.ocr"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Close Chrome completely and reopen"
Write-Host "  2. Open the extension popup -> click Start OCR button"
