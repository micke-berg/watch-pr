// notify.js — cross-platform, zero-dependency notifications for watch-pr.
//
// Desktop toast: Windows via the bundled notify.ps1, macOS via `osascript`, Linux via
// `notify-send`. Phone push (optional): an ntfy topic (config.ntfyTopic), done in pure
// Node so it is identical on every OS. The OS is auto-detected from process.platform —
// there is nothing to configure or accept to make this work.
//
// Everything here is best-effort and fire-and-forget: a failed or missing notifier must
// never disturb the poller. (The first desktop notification on macOS may trigger the
// OS's own "allow notifications?" permission dialog — that is macOS, not this tool.)
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");
const https = require("https");
const config = require("./config.js");

const NOTIFY_PS1 = path.join(__dirname, "notify.ps1");

// AppleScript string literal: collapse newlines (a raw newline is a syntax error inside an
// -e string and would drop the notification), then wrap in quotes and escape backslash + quote.
function asAppleString(s) {
  return '"' + String(s == null ? "" : s).replace(/[\r\n]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function desktop(title, message) {
  try {
    if (process.platform === "win32") {
      // JSON over stdin => nothing to escape into a PowerShell command line.
      const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", NOTIFY_PS1],
        { detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      child.on("error", () => {});
      child.stdin.on("error", () => {});
      child.stdin.write(JSON.stringify({ title, message }));
      child.stdin.end();
      child.unref();
    } else if (process.platform === "darwin") {
      const script = `display notification ${asAppleString(message)} with title ${asAppleString(title)}`;
      const child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
    } else {
      // Linux best-effort; silently skipped if notify-send isn't installed.
      const child = spawn("notify-send", [String(title || ""), String(message || "")], { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
    }
  } catch (e) { /* best-effort */ }
}

function phone(title, message) {
  const topic = config.ntfyTopic;
  if (!topic) return; // no topic configured => no phone push
  try {
    const base = (config.ntfyServer || "https://ntfy.sh").replace(/\/+$/, "");
    const url = new URL(base + "/" + topic);
    const lib = url.protocol === "http:" ? http : https;
    const body = Buffer.from(String(message == null ? "" : message), "utf8");
    const req = lib.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": body.length,
        "Title": String(title || "").replace(/[^\x20-\x7E]/g, ""), // ntfy headers must be ASCII
        "Priority": "default",
      },
      timeout: 8000,
    });
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.write(body);
    req.end();
  } catch (e) { /* best-effort */ }
}

function notify(title, message) {
  desktop(title, message);
  phone(title, message);
}

module.exports = { notify };
