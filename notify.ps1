param()
$ErrorActionPreference = 'SilentlyContinue'

# notify.ps1 — Windows desktop toast for watch-pr. Reads a {title, message} JSON payload
# from stdin and shows a toast (falls back to a beep). Bundled with the tool and invoked
# by notify.js on Windows only; the ntfy phone push is handled in notify.js, so this does
# the toast alone. Zero setup.
$inputJson = $null
try { $raw = [Console]::In.ReadToEnd(); $inputJson = $raw | ConvertFrom-Json -ErrorAction SilentlyContinue } catch {}
$message = if ($inputJson -and $inputJson.message) { $inputJson.message } else { "watch-pr" }
$title   = if ($inputJson -and $inputJson.title)   { $inputJson.title }   else { "watch-pr" }

try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $safeMessage = [System.Security.SecurityElement]::Escape($message)
    $safeTitle   = [System.Security.SecurityElement]::Escape($title)
    $xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
    $xml.loadXml("<toast><visual><binding template='ToastGeneric'><text>$safeTitle</text><text>$safeMessage</text></binding></visual></toast>")
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
} catch { [System.Console]::Beep(1000, 300) }
