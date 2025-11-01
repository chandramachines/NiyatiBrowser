// telegram.js — Niyati Browser (fancy replies edition)
// Drop-in replacement providing:
//   - createTelegramClient({ token, chatId, commands, onUnknown, dropPendingOnStart, onCommand, onCommandResult })
//   - buildDefaultCommands(deps)
//
// Notes:
// - Uses Telegram Bot API via long-poll getUpdates + deleteWebhook(drop_pending_updates)
// - Sets slash commands (setMyCommands) with validated names/descriptions
// - Fancy, user-friendly replies with emojis for all commands

const DEFAULT_TIMEOUT = 25;


// === Fancy /help (HTML) ===
const HELP_TEXT_HTML = `<b>🤖 NiyatiBrowser — Help</b>

⏱ Refresh
• /startref – ✅ Auto-refresh ON
• /stopref – 🛑 Auto-refresh OFF
• /setref &lt;sec&gt; – ⏱ Interval set

🧩 Products
• /addprod &lt;name&gt; – ➕ Add product
• /delprod &lt;name&gt; – ➖ Remove product
• /prodlist – 🗂️ List products

🧠 Keywords
• /addkey &lt;word&gt; – ➕ Add keyword
• /delkey &lt;word&gt; – ➖ Remove keyword
• /keylist – 🧾 List keywords

📸 Screenshots
• /ss – Both windows (album)
• /sswin1 – Leads window (photo)
• /sswin2 – Manager window (photo)

📊 Status &amp; Maintenance
• /status – Send status
• /clean – 🧹 Clean up
• /cleanall – 🧨 Deep clean (careful)
• /restart – 🔄 Restart app
• /quit – 📴 Quit app

🪟 Windows / UI
• /manager – Focus Manager
• /leads – Focus Leads
• /togglemax – Toggle maximize
• /reload – Reload Manager UI

🔐 Login / OTP
• /autologin – Start auto-login
• /otp &lt;1234&gt; – Submit OTP
• /resend – Request new OTP

🔒 Lock
• /lock – Hide all windows
• /unlock &lt;user,pass&gt; – Unlock (if creds enabled)

🧰 Utilities
• /ping – 🏓 pong
• /sync – 🔧 Re-sync slash commands

📦 Reports
• /runreports – Trigger daily report now`;

function createTelegramClient({
  token,
  chatId,
  commands = {},
  onUnknown,
  dropPendingOnStart = false,
  onCommand,
  onCommandResult,
  incomingFileSaveDir
}) {
  if (!token) {
    console.warn("[Telegram] TELEGRAM_BOT_TOKEN not set; skipping integration.");
    return { start() {}, stop() {}, send() {}, syncCommands() {}, sendFile() {} };
  }

  const API = `https://api.telegram.org/bot${token}`;
  const JSON_HDR = { "Content-Type": "application/json" };
  let lastUpdateId = 0, abortCtrl = null;
  const startTs = Math.floor(Date.now() / 1000);

  const call = async (method, payload = {}) => {
    const res = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: JSON_HDR,
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`${method} failed: ${res.status} ${JSON.stringify(data)}`);
    return data.result;
  };

  const sendRaw = async (text, extra = {}) =>
    chatId && call("sendMessage", { chat_id: chatId, text: String(text ?? ""), ...extra });

  // === Photo helpers for Telegram (sendPhoto / sendMediaGroup) ===
  async function sendPhotoBuffer(buf, { caption = "", filename = "photo.jpg", mime = "image/jpeg" } = {}) {
    if (!chatId) return;
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    if (caption) fd.append("caption", caption);
    const blob = new Blob([buf], { type: mime });
    fd.append("photo", blob, filename);
    const res = await fetch(`${API}/sendPhoto`, { method: "POST", body: fd });
    const data = await res.json();
    if (!data.ok) throw new Error(`sendPhoto failed: ${JSON.stringify(data)}`);
    return data.result;
  }

  async function sendMediaGroupPhotos(photos /* [{name, buf, caption?}, ...] */) {
    if (!chatId) return;
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    const media = [];
    for (const p of photos) {
      const key = p.name || ("photo" + media.length);
      const blob = new Blob([p.buf], { type: "image/jpeg" });
      fd.append(key, blob, `${key}.jpg`);
      media.push({ type: "photo", media: `attach://${key}`, caption: p.caption || undefined });
    }
    fd.append("media", JSON.stringify(media));
    const res = await fetch(`${API}/sendMediaGroup`, { method: "POST", body: fd });
    const data = await res.json();
    if (!data.ok) throw new Error(`sendMediaGroup failed: ${JSON.stringify(data)}`);
    return data.result;
  }


  const wrapSendForCmd = (ctx) => async (text, extra = {}) => {
    await sendRaw(String(text ?? ""), extra);
    try { onCommandResult && onCommandResult({ ...ctx, reply: text }); } catch {}
    return;
  };
  // === Incoming file helpers (download & save) ================================
  async function downloadFileById(fileId) {
    const info = await call("getFile", { file_id: fileId });
    if (!info?.file_path) throw new Error("No file_path from getFile");
    const base = API.startsWith("https://api.telegram.org/bot") ? "https://api.telegram.org" : API.replace(/\/bot$/, '');
    const url = `${base}/file/bot${token}/${info.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    return { buf, file_path: info.file_path };
  }

  async function saveBufferToDir(buf, saveDir, filename) {
    const fs = require("node:fs/promises");
    const path = require("node:path");
    const p = path.join(saveDir, filename);
    await fs.mkdir(require("node:path").dirname(p), { recursive: true });
    await fs.writeFile(p, buf); // overwrite if exists
    return p;
  }


  const ensurePollingMode = () =>
    call("deleteWebhook", { drop_pending_updates: !!dropPendingOnStart }).catch(() => {});

  const drainBacklogToLatest = async () => {
    try {
      for (;;) {
        const batch = await call("getUpdates", { offset: lastUpdateId + 1, timeout: 0, limit: 100 });
        if (!Array.isArray(batch) || batch.length === 0) break;
        for (const u of batch) if (typeof u.update_id === "number") lastUpdateId = Math.max(lastUpdateId, u.update_id);
      }
    } catch (e) { console.warn("[Telegram] warm-up drain failed:", e.message); }
  };

  const cleanCmd = (name) =>
    String(name || "")
      .replace(/^\/+/, "")                // no leading slash
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")        // only a-z0-9_
      .slice(0, 32);                      // max 32 chars

  const cleanDesc = (d, fallback) => {
    let s = String(d ?? "").replace(/\s+/g, " ").trim();
    if (s.length < 3) s = String(fallback || "command");
    if (s.length > 256) s = s.slice(0, 256);
    return s;
  };

  function makeInvoker(v) {
    if (typeof v === "function") {
      return async (ctx) => {
        const { args, send } = ctx;
        try {
          const out = (v.length <= 1) ? v(args) : v(ctx);
          const val = (out && typeof out.then === "function") ? await out : out;
          if (typeof val !== "undefined") await send(String(val));
        } catch (e) {
          await send("Error: " + (e?.message || e));
        }
      };
    }
    if (v && typeof v.handler === "function") {
      return async (ctx) => {
        try {
          const out = v.handler(ctx);
          if (out && typeof out.then === "function") {
            await out;
          } else if (typeof out !== "undefined") {
            await ctx.send(String(out));
          }
        } catch (e) {
          await ctx.send("Error: " + (e?.message || e));
        }
      };
    }
    return null;
  }

  const normalize = (spec) => {
    const list = [], map = {};
    const seen = new Set();

    for (const [rawCmd, v] of Object.entries(spec || {})) {
      const inv = makeInvoker(v);
      if (!inv) continue;

      const hidden = (typeof v === "object" && v && !!v.hidden);
      const cleaned = cleanCmd(rawCmd);
      if (!cleaned) continue;

      map[cleaned] = inv;       // cleaned key
      map[rawCmd]  = inv;       // raw key (aliases like "/lock")

      if (hidden) continue;

      if (!seen.has(cleaned)) {
        seen.add(cleaned);
        const desc = (typeof v === "object" && v && (v.desc || v.description)) || cleaned;
        list.push({ command: cleaned, description: cleanDesc(desc, cleaned) });
      }
    }
    return { list, map };
  };

  const { list: commandList, map: handlerMap } = normalize(commands);

  // Dynamic /help built from current command list (visible only)
  const __helpText = () => {
    const lines = ["🤖 Niyati Bot — Command Menu"];
    const seen = new Set();
    for (const { command, description } of commandList) {
      if (seen.has(command)) continue;
      lines.push(`/${command} — ${description}`);
      seen.add(command);
    }
    return lines.join("\n");
  };
  if (!handlerMap["help"] && !handlerMap["/help"]) { handlerMap["help"] = ({ send }) => send(__helpText()); handlerMap["/help"] = handlerMap["help"]; }

  async function syncCommands(notify = false) {
    if (!commandList.length) return;

    const valid = commandList
      .map(c => ({
        command: cleanCmd(c.command),
        description: cleanDesc(c.description, c.command)
      }))
      .filter(c => /^[a-z0-9_]{1,32}$/.test(c.command)); // Bot API constraints

    if (!valid.length) throw new Error("No valid commands to set.");

    const scopes = [
      { type: "default" },
      { type: "all_private_chats" },
      { type: "all_group_chats" }
    ];

    try {
      for (const scope of scopes) {
        await call("deleteMyCommands", { scope }).catch(()=>{});
      }
      for (const scope of scopes) {
        await call("setMyCommands", { commands: valid, scope });
      }
      if (chatId) {
        await call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(()=>{});
        if (notify) await sendRaw("🔁 Commands re-synced ✅");
      }
    } catch (e) {
      throw new Error("Command sync failed: " + e.message);
    }
  }

  const dispatch = (upd) => {
    const msg = upd.message || upd.edited_message;
    if (!msg) return;
    if (chatId && String(msg.chat.id) !== String(chatId)) return;
    if (typeof msg.date === "number" && msg.date < startTs) return;
    // Handle incoming files (document/photo/video/audio/voice)
    if (incomingFileSaveDir && (msg.document || (msg.photo && msg.photo.length) || msg.video || msg.audio || msg.voice)) {
      (async () => {
        try {
          const kind = msg.document ? 'document' : msg.photo ? 'photo' : msg.video ? 'video' : msg.audio ? 'audio' : 'voice';
          const meta = msg.document || (msg.photo && msg.photo[msg.photo.length - 1]) || msg.video || msg.audio || msg.voice;
          const preferName = meta.file_name || (kind + '-' + (meta.file_unique_id || ''));
          const { buf, file_path } = await downloadFileById(meta.file_id);
          const path = require('node:path');
          const filename = preferName || path.basename(file_path);
          const saved = await saveBufferToDir(buf, incomingFileSaveDir, filename);
          await sendRaw(`📥 Saved <b>${filename}</b> (${(buf.length/1024).toFixed(1)} KB) to <code>${saved}</code>`, { parse_mode: 'HTML' });
        } catch (e) {
          await sendRaw('❌ File save failed: ' + e.message);
        }
      })();
    }


    if (!msg.text) return; const text = msg.text.trim();
    if (!text.startsWith("/")) return;

    const [raw, ...rest] = text.split(/\s+/);
    const cmd = cleanCmd(raw.replace(/^\/|@.*$/g, "")); // sanitize incoming too
    const args = rest.join(" ");

    const ctx = { cmd, args, raw: text, msg, send: wrapSendForCmd({ cmd, args }), sendPhoto: sendPhotoBuffer, sendMediaGroup: sendMediaGroupPhotos, syncCommands };

    try { onCommand && onCommand({ cmd, args, raw: text }); } catch {}

    const handler = handlerMap[cmd] || handlerMap[raw] || handlerMap[`/${cmd}`];
    if (typeof handler === "function") {
      handler(ctx);
    } else if (typeof onUnknown === "function") {
      onUnknown(ctx);
    } else {
      ctx.send("❓ Unknown command. Try /sync then /help");
    }
  };

  async function start() {
    try {
      await ensurePollingMode();
      await drainBacklogToLatest();
      await syncCommands(false);
      await sendRaw("🔗 Niyati Browser connected.");
    } catch (e) { console.error("[Telegram] init error:", e.message); }

    abortCtrl = new AbortController();
    const { signal } = abortCtrl;

    while (!signal.aborted) {
      try {
        const res = await fetch(`${API}/getUpdates`, {
          method: "POST",
          headers: JSON_HDR,
          body: JSON.stringify({ offset: lastUpdateId + 1, timeout: DEFAULT_TIMEOUT, limit: 100 }),
          signal
        });
        const data = await res.json();
        if (!data.ok) throw new Error("getUpdates not ok: " + JSON.stringify(data));
        for (const upd of data.result) {
          if (typeof upd.update_id === "number") {
            lastUpdateId = Math.max(lastUpdateId, upd.update_id);
          }
          try { dispatch(upd); } catch (e) { console.error("[Telegram] dispatch error:", e.message); }
        }
      } catch (err) {
        if (signal.aborted) break;
        console.error("[Telegram] poll error:", err.message);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  const stop = () => { if (abortCtrl) { try { abortCtrl.abort(); } catch {} } abortCtrl = null; };

  const sendDocument = async (filePath, caption = "") => {
    if (!chatId) return;
    const fs = require("node:fs/promises");
    const path = require("node:path");
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    if (caption) fd.append("caption", caption);
    const blob = new Blob([await fs.readFile(filePath)]);
    fd.append("document", blob, path.basename(filePath));
    const res = await fetch(`${API}/sendDocument`, { method: "POST", body: fd });
    const data = await res.json();
    if (!data.ok) throw new Error(`sendDocument failed: ${JSON.stringify(data)}`);
    return data.result;
  };

  const sendFile = (filePath, caption = "") => sendDocument(filePath, caption);

  return {
    start, stop,
    send: sendRaw,
    syncCommands,
    sendFile
  };
}

function buildDefaultCommands(deps = {}) {
  const ok = (b) => (b ? "OK" : "Failed");

  const cmds = {
    help: {
  desc: "Show commands",
  handler: ({ send }) => send(HELP_TEXT_HTML, { parse_mode: "HTML", disable_web_page_preview: true })
},

    // Refresh controls
    startref: { desc: "Start auto-refresh", handler: ({ send }) => send(ok(deps.enableAuto?.(deps.getIntervalSec?.() || 7)) ? "▶️ Auto-refresh started." : "❌ Start failed — retry.") },
    stopref:  { desc: "Stop auto-refresh",  handler: ({ send }) => send(ok(deps.disableAuto?.()) ? "⏹️ Auto-refresh stopped." : "❌ Stop failed — retry.") },
    setref:   {
      desc: "Set refresh seconds",
      handler: ({ args, send }) => {
        const sec = Math.max(3, parseInt(String(args || "").trim(), 10) || 7);
        send(ok(deps.enableAuto?.(sec)) ? `⏱️ Auto-refresh set to ${sec}s.` : "❌ Couldn't set refresh — try again.");
      }
    },

    // Lists: products / keywords
    addprod: { desc: "Add product",   handler: ({ args, send }) => send(ok(deps.addProduct?.(String(args||"").trim())) ? `✅ Product saved: ${String(args||"").trim()}` : "❌ Add failed — try again.") },
    delprod: { desc: "Delete product",handler: ({ args, send }) => send(ok(deps.deleteProduct?.(String(args||"").trim())) ? `✅ Removed product: ${String(args||"").trim()}` : "❌ Delete failed — check the name & retry.") },
    prodlist:{ desc: "List products", handler: ({ send }) => {
      try {
        const arr = deps.listProducts ? deps.listProducts() : [];
        send(arr.length ? `📦 Products (${arr.length}):\n` + arr.map((x)=>`• ${x}`).join("\n") : "📭 No products yet.");
      } catch { send("❌ Failed."); }
    }},

    addkey:  { desc: "Add keyword",   handler: ({ args, send }) => send(ok(deps.addKeyword?.(String(args||"").trim())) ? `✅ Added keyword: ${String(args||"").trim()}` : "❌ Couldn't add — retry.") },
    delkey:  { desc: "Delete keyword",handler: ({ args, send }) => send(ok(deps.deleteKeyword?.(String(args||"").trim())) ? `✅ Removed: ${String(args||"").trim()}` : "❌ Delete failed — retry.") },
    keylist: { desc: "List keywords", handler: ({ send }) => {
      try {
        const arr = deps.listKeywords ? deps.listKeywords() : [];
        send(arr.length ? `🏷️ Keywords (${arr.length}):\n` + arr.map((x)=>`• ${x}`).join("\n") : "🙈 No keywords yet.");
      } catch { send("❌ Failed."); }
    }},

    // Screenshots
    ss: { desc: "Both windows (album)",
      handler: async ({ send, sendMediaGroup }) => {
        try {
          await send("📸 Taking screenshots of both windows…");
          const out = await deps.screenshotBothAsJpegs?.({ stayHidden: true, quality: 88 });
          if (out && out.managerBuf && out.leadsBuf) {
            await sendMediaGroup([
              { name: "manager", buf: out.managerBuf, caption: "Manager" },
              { name: "leads", buf: out.leadsBuf, caption: "Leads" }
            ]);
          } else {
            await send("❌ Screenshot failed — ensure main.js has screenshotBothAsJpegs.");
          }
        } catch (e) {
          await send("⚠️ Screenshot failed: " + (e?.message || e));
        }
      }
    },
    sswin1: { desc: "Screenshot Leads (photo)",
      handler: async ({ send, sendPhoto }) => {
        try {
          await send("📸 Capturing Leads…");
          const buf = await deps.screenshotLeadsAsJpeg?.({ stayHidden: true, quality: 88 });
          if (buf) {
            await sendPhoto(buf, { caption: "Leads", filename: "leads.jpg" });
          } else {
            await send("❌ Screenshot failed — ensure main.js has screenshotLeadsAsJpeg.");
          }
        } catch (e) {
          await send("⚠️ Screenshot failed: " + (e?.message || e));
        }
      }
    },
    sswin2: { desc: "Screenshot Manager (photo)",
      handler: async ({ send, sendPhoto }) => {
        try {
          await send("📸 Capturing Manager…");
          const buf = await deps.screenshotManagerAsJpeg?.({ stayHidden: true, quality: 88 });
          if (buf) {
            await sendPhoto(buf, { caption: "Manager", filename: "manager.jpg" });
          } else {
            await send("❌ Screenshot failed — ensure main.js has screenshotManagerAsJpeg.");
          }
        } catch (e) {
          await send("⚠️ Screenshot failed: " + (e?.message || e));
        }
      }
    },

    // Status & maintenance
    status:   { desc: "Send status report",        handler: ({ send }) => send((deps.sendStatus && deps.sendStatus()) ? "🧾 Status shared." : "❌ Status send failed — retry.") },
    clean:    { desc: "Memory clean",              handler: ({ send }) => send((deps.cleanNow && deps.cleanNow()) ? "🧹 Cleanup complete." : "❌ Cleanup failed — retry.") },
    cleanall: { desc: "Archive+Truncate+Clean",    handler: ({ send }) => send((deps.cleanAll && deps.cleanAll()) ? "🧼 Deep clean done."  : "❌ Deep clean failed — retry.") },
    restart:  { desc: "Relaunch app",              handler: ({ send }) => send((deps.restartApp && deps.restartApp()) ? "🔄 Restarting…"     : "❌ Restart failed — try again.") },

    // Lock / Unlock
    lock:   { desc: "Lock: hide ALL windows (incl. login)", handler: ({ send }) => { try { deps.lockAll && deps.lockAll(); } catch {} return send("🔒 Locked — all windows hidden."); } },
    unlock: {
      desc: "Unlock (with or without creds)",
      handler: ({ send, args }) => {
        const maybe = deps.unlockNoCreds ? deps.unlockNoCreds() : (deps.unlockWithCreds ? deps.unlockWithCreds(args) : "🚫 Unlock not available");
        return send(maybe);
      }
    },

    // Window focus / chrome
    manager:   { desc: "Focus Manager window",     handler: ({ send }) => send((deps.focusManager && deps.focusManager()) ? "🗂️ Manager focused" : "❌ Failed") },
    leads:     { desc: "Focus Leads window",       handler: ({ send }) => send((deps.focusLeads && deps.focusLeads()) ? "👀 Leads focused"     : "❌ Failed") },
    togglemax: { desc: "Toggle maximize Manager",  handler: ({ send }) => { try { deps.toggleMax && deps.toggleMax(); return send("🪄 Toggled"); } catch { return send("❌ Failed"); } } },

    // Auto-login & OTP
    autologin: {
      desc: "Start auto-login",
      handler: ({ send }) => {
        if (deps.isLoggedIn && deps.isLoggedIn()) return send("ℹ️ Already logged in.");
        if (!deps.startAutoLogin?.()) return send("⚠️ Auto-login not ready.");
        return send("⏳ Auto-login started.");
      }
    },
    otp: {
      desc: "Submit OTP",
      handler: ({ args, send }) => {
        if (deps.isLoggedIn && deps.isLoggedIn()) return send("ℹ️ Already logged in.");
        const okk = deps.injectOtp && deps.injectOtp(String(args || "").trim());
        return send(okk ? "🔐 OTP submitted." : "❌ Invalid OTP / no active attempt.");
      }
    },
    resend: {
      desc: "Request OTP again",
      handler: ({ send }) => {
        if (deps.isLoggedIn && deps.isLoggedIn()) return send("ℹ️ Already logged in.");
        return send(deps.requestResend?.() ? "🔁 Will click Request OTP." : "⛔ No auto-login attempt is active.");
      }
    },

    // Misc
    ping:    { desc: "Health check", handler: ({ send }) => send("🏓 pong") },
    quit:    { desc: "Quit the app", handler: ({ send }) => { send("🚪 Quitting…"); deps.quitApp?.(); } },

    // Commands re-sync
    sync: {
      desc: "Re-sync slash commands",
      handler: ({ send, syncCommands }) => (async () => {
        try {
          await syncCommands(true);
        } catch (e) {
          await send("❌ Sync failed: " + (e?.message || e));
        }
      })()
    },

    // Extra: Manager reload (kept from your base)
    reload:  { desc: "Reload manager UI", handler: ({ send }) => send(deps.reloadManager?.() ? "🔄 Manager reloaded" : "❌ Reload failed") },
  };

  const aliases = {
    startrefresh:  { hidden: true, handler: cmds.startref.handler },
    stoprefresh:   { hidden: true, handler: cmds.stopref.handler },
    setrefresh:    { hidden: true, handler: cmds.setref.handler },
    addproduct:    { hidden: true, handler: cmds.addprod.handler },
    deleteproduct: { hidden: true, handler: cmds.delprod.handler },
    productlist:   { hidden: true, handler: cmds.prodlist.handler },
    addkeyword:    { hidden: true, handler: cmds.addkey.handler },
    deletekeyword: { hidden: true, handler: cmds.delkey.handler },
    keywordlist:   { hidden: true, handler: cmds.keylist.handler },
    "/lock":       { hidden: true, handler: cmds.lock.handler },
    "/unlock":     { hidden: true, handler: cmds.unlock.handler },
    "/manager":    { hidden: true, handler: cmds.manager.handler },
    "/leads":      { hidden: true, handler: cmds.leads.handler },
    "/togglemax":  { hidden: true, handler: cmds.togglemax.handler },
  };

  return { ...cmds, ...aliases };
}

module.exports = { createTelegramClient, buildDefaultCommands };
