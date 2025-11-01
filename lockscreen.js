const path = require('path');

const { BrowserWindow } = require("electron");
const crypto = require("node:crypto");

function sha256(s){ return crypto.createHash("sha256").update(String(s||"")).digest("hex"); }

function createLockScreen({ getVisibleWindows, onLock, onUnlock } = {}) {
  const USER = process.env.LOCK_USER || "admin";
  const PASS = process.env.LOCK_PASS || "admin";
  const PASS_HASH = process.env.LOCK_PASS_HASH || ""; // optional sha256; if set, PASS ignored

  let win = null;
  let isLocked = false;
  const hiddenWindows = new Set();

  function validate(u, p) {
    const inUser = String(u ?? "").trim();
    const inPass = String(p ?? "");
    const cfgUser = String(USER ?? "").trim();

    if (inUser.toLowerCase() !== cfgUser.toLowerCase()) return false;
    if (PASS_HASH) return sha256(inPass) === PASS_HASH;
    return inPass === String(PASS ?? "");
  }

  function buildDataURL() {
    const html = `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' data:;">
<title>Niyati — Locked</title>
<style>
  html,body{margin:0;padding:0;height:100%;background:#0f0f10;color:#e6e6e6;font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;}
  .wrap{display:flex;align-items:center;justify-content:center;height:100%;}
  .card{width:360px;background:#141415;border:1px solid #2a2a2d;border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,.5);padding:24px;}
  h1{font-size:18px;margin:0 0 6px;}
  p{opacity:.75;margin:0 0 18px;font-size:13px}
  label{display:block;font-size:12px;margin:10px 0 6px;opacity:.85}
  input{width:100%;box-sizing:border-box;background:#0f0f10;border:1px solid #333;border-radius:10px;color:#e6e6e6;padding:10px 12px;outline:none}
  input:focus{border-color:#6f9cff}
  button{width:100%;margin-top:16px;padding:10px 12px;border:0;border-radius:12px;background:#2e62ff;color:#fff;font-weight:600;cursor:pointer}
  button:disabled{opacity:.5;cursor:not-allowed}
  .msg{height:18px;font-size:12px;margin-top:10px;color:#f66}
  .brand{display:flex;gap:8px;align-items:center;margin-bottom:16px;opacity:.9}
  .dot{width:10px;height:10px;border-radius:50%;background:#2e62ff;box-shadow:0 0 12px #2e62ff}
  .hint{opacity:.6;font-size:11px;margin-top:8px}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="brand"><div class="dot"></div><strong>Niyati Browser</strong></div>
    <h1>Locked</h1>
    <p>Enter your credentials to continue.</p>
    <label>User ID</label>
    <input id="user" autocomplete="username" autofocus />
    <label>Password</label>
    <input id="pass" type="password" autocomplete="current-password" />
    <button id="btn">Unlock</button>
    <div class="msg" id="msg"></div>
    <div class="hint">Tip: Press <kbd>Enter</kbd> to submit.</div>
  </div>
</div>
<script>
  const { ipcRenderer } = require("electron");
  const $ = s => document.querySelector(s);
  const user = $("#user"), pass = $("#pass"), btn = $("#btn"), msg = $("#msg");
  function submit(){
    btn.disabled = true; msg.textContent = "";
    ipcRenderer.invoke("lockscreen:tryUnlock", { user: user.value, pass: pass.value })
      .then(ok=>{ if (ok) return; btn.disabled=false; msg.textContent="Invalid user or password."; })
      .catch(()=>{ btn.disabled=false; msg.textContent="Something went wrong."; });
  }
  btn.addEventListener("click", submit);
  pass.addEventListener("keydown", e=>{ if(e.key==="Enter") submit(); });
  user.addEventListener("keydown", e=>{ if(e.key==="Enter") submit(); });
</script>
</body></html>`;
    return "data:text/html;charset=utf-8," + encodeURIComponent(html);
  }

  function showLockWindow() {
    if (win && !win.isDestroyed()) { try{ win.show(); win.focus(); }catch{}; return win; }
    win = new BrowserWindow({
      title: "Niyati — Locked",
      width: 420, height: 360, resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, movable: true, frame: true,
      backgroundColor: "#0f0f10",
      alwaysOnTop: true,
      webPreferences: {contextIsolation: true, nodeIntegration: false, sandbox: false, preload: path.join(__dirname, 'preload.js')}
    });
    win.setMenuBarVisibility(false);
    win.loadURL(buildDataURL());
    win.on("closed", ()=> { win = null; });
    return win;
  }

  function hideAllWindows(keepLockVisible = true) {
    hiddenWindows.clear();
    const all = BrowserWindow.getAllWindows();
    for (const w of all) {
      if (keepLockVisible && win && w.id === win.id) continue;
      if (!w.isDestroyed() && w.isVisible()) {
        hiddenWindows.add(w.id);
        try { w.hide(); } catch {}
      }
    }
  }

  function restoreHiddenWindows() {
    for (const id of hiddenWindows) {
      const w = BrowserWindow.fromId(id);
      if (w && !w.isDestroyed()) { try { w.show(); } catch {} }
    }
    hiddenWindows.clear();
  }

  function lock({ showLogin = true } = {}) {
    isLocked = true;
    if (showLogin) showLockWindow();

    hideAllWindows(!!showLogin); // if false → login भी hide
    try { onLock?.(); } catch {}
    return true;
  }
  function lockSilent(){ return lock({ showLogin:false }); }

  function unlock() {
    if (!isLocked) return true;
    isLocked = false;
    restoreHiddenWindows();
    try { onUnlock?.(); } catch {}
    try { if (win && !win.isDestroyed()) win.close(); } catch {}
    return true;
  }

  function isLockedNow(){ return !!isLocked; }
  function validateAndUnlock({ user, pass }) { const ok = validate(user, pass); if (ok) unlock(); return ok; }

  return { lock, lockSilent, unlock, isLocked: isLockedNow, show: showLockWindow, _validateAndUnlock: validateAndUnlock };
}

module.exports = { createLockScreen };
