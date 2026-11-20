param()
$ErrorActionPreference = 'SilentlyContinue'

# notify.ps1 — Windows desktop toast for watch-pr. Reads a {title, message, open, urgent} JSON
# payload from stdin and shows a toast (falls back to a beep). Bundled with the tool and invoked
# by notify.js on Windows only; the ntfy phone push is handled in notify.js, so this does the
# toast alone. Zero setup: the app identity below registers itself on first use.
$inputJson = $null
try { $raw = [Console]::In.ReadToEnd(); $inputJson = $raw | ConvertFrom-Json -ErrorAction SilentlyContinue } catch {}
$message = if ($inputJson -and $inputJson.message) { $inputJson.message } else { "watch-pr" }
$title   = if ($inputJson -and $inputJson.title)   { $inputJson.title }   else { "watch-pr" }
$open    = if ($inputJson -and $inputJson.open)    { [string]$inputJson.open } else { "" }
$urgent  = [bool]($inputJson -and $inputJson.urgent)

# Toasts sent under PowerShell's app id look like terminal noise and get overlooked. An
# unpackaged app gets its own name and icon in the toast header only through a Start-menu
# shortcut carrying its app id, so create it on first use. Falls back to PowerShell's id if
# that fails, because a toast under an unregistered id shows the raw id and no icon.
$fallbackAppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$appId = 'WatchPr.PRWatch'
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'PR Watch.lnk'
if (-not (Test-Path $shortcut)) {
    try { & (Join-Path $PSScriptRoot 'register-toast-app.ps1') -AppId $appId | Out-Null } catch {}
    if (-not (Test-Path $shortcut)) { $appId = $fallbackAppId }
}
$logoUri = 'file:///' + ((Join-Path $PSScriptRoot 'icon-192.png') -replace '\\', '/')

function Escape-Xml([string]$text) { [System.Security.SecurityElement]::Escape($text) }

$safeTitle   = Escape-Xml $title
$safeMessage = Escape-Xml $message
$safeOpen    = Escape-Xml $open
$launch      = if ($open) { " activationType='protocol' launch='$safeOpen'" } else { "" }

# Events that need Micke's action use the reminder scenario: it stays on screen until clicked
# instead of sliding away after a few seconds. Windows ignores the scenario unless the toast
# has at least one button, so urgent toasts always get a Dismiss button.
$scenario = ""
$actions  = ""
$audio    = "<audio src='ms-winsoundevent:Notification.Default'/>"
if ($urgent) {
    $scenario = " scenario='reminder'"
    $openButton = if ($open) { "<action content='Open' activationType='protocol' arguments='$safeOpen'/>" } else { "" }
    $actions  = "<actions>$openButton<action content='Dismiss' activationType='system' arguments='dismiss'/></actions>"
    $audio    = "<audio src='ms-winsoundevent:Notification.Reminder'/>"
}

try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
    $xml.loadXml("<toast$launch$scenario><visual><binding template='ToastGeneric'><image placement='appLogoOverride' src='$(Escape-Xml $logoUri)'/><text>$safeTitle</text><text>$safeMessage</text></binding></visual>$actions$audio</toast>")
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
} catch { [System.Console]::Beep(1000, 300) }
