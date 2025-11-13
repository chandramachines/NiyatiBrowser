const DEFAULT_TIMEOUT = 25;

// ✅ Input sanitization patterns
const DANGEROUS_CHARS = /[`$(){}[\]<>|&;\\]/g;
const SHELL_INJECTION = /(\$\(|\$\{|`)/g;
const PATH_TRAVERSAL = /\.\.[\/\\]/g;

// ✅ Sanitize user input
function sanitizeInput(str, maxLength = 500) {
  return String(str || "")
    .replace(SHELL_INJECTION, '') // Remove shell injection attempts
    .replace(PATH_TRAVERSAL, '')  // Remove path traversal
    .replace(/[^\p{L}\p{N}\s.,_@+()-]/gu, '') // Allow only safe chars
    .slice(0, maxLength)
    .trim();
}

const HELP_TEXT_HTML = `<b>🤖 NiyatiBrowser – Help</b>

⏱ Refresh
- /startref – ✅ Auto-Refresh ON
- /stopref – 🛑 Auto-Refresh OFF
- /setref &lt;sec&gt; – ⏱ Interval Set

🧩 Products
- /addprod &lt;name&gt; – ➕ Add Product
- /delprod &lt;name&gt; – ➖ Remove Product
- /prodlist – 🗂️ List Products

🧠 Keywords
- /addkey &lt;word&gt; – ➕ Add Keyword
- /delkey &lt;word&gt; – ➖ Remove Keyword
- /keylist – 🧾 List Keywords

📸 Screenshots
- /ss – Both Windows (Album)
- /sswin1 – Leads Window (Photo)
- /sswin2 – Manager Window (Photo)

📊 Status & amp; Maintenance
- /status – Send Status
- /clean – 🧹 Clean up
- /cleanall – 🧨 Deep Clean (Careful)
- /restart – 🔄 Restart App
- /quit – 🔴 Quit App

🪟 Windows / UI
- /manager – Focus Manager
- /leads – Focus Leads
- /togglemax – Toggle Maximize
- /reload – Reload Manager UI

🔐 Login / OTP
- /autologin – Start Auto-login
- /otp &lt;1234&gt; – Submit OTP
- /resend – Request New OTP

🔒 Lock
- /lock – Hide all Windows
- /unlock &lt;user,pass&gt; – Unlock (if Creds Enabled)

🧰 Utilities
- /ping – 🏓 Pong
- /sync – 🔧 Re-sync Slash Commands

📦 Reports
- /runreports – Trigger Daily Report Now`;

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
    return { 
      start() {}, 
      stop() {}, 
      send() {}, 
      syncCommands() {}, 
      sendFile() {} 
    };
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

  async function sendMediaGroupPhotos(photos) {
    if (!chatId) return;
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    const media = [];
    for (const p of photos) {
      const key = p.name || ("photo" + media.length);
      const blob = new Blob([p.buf], { type: "image/jpeg" });
      fd.append(key, blob, `${key}.jpg`);
      media.push({ 
        type: "photo", 
        media: `attach://${key}`, 
        caption: p.caption || undefined 
      });
    }
    fd.append("media", JSON.stringify(media));
    const res = await fetch(`${API}/sendMediaGroup`, { method: "POST", body: fd });
    const data = await res.json();
    if (!data.ok) throw new Error(`sendMediaGroup failed: ${JSON.stringify(data)}`);
    return data.result;
  }

  const wrapSendForCmd = (ctx) => async (text, extra = {}) => {
    await sendRaw(String(text ?? ""), extra);
    try { 
      onCommandResult && onCommandResult({ ...ctx, reply: text }); 
    } catch {}
    return;
  };

  async function downloadFileById(fileId) {
    const info = await call("getFile", { file_id: fileId });
    if (!info?.file_path) throw new Error("No file_path");
    
    if (info.file_size > 50 * 1024 * 1024) {
      throw new Error("File too large (max 50MB)");
    }
    
    const base = API.startsWith("https://api.telegram.org/bot")
      ? "https://api.telegram.org"
      : API.replace(/\/bot$/, '');
    const url = `${base}/file/bot${token}/${info.file_path}`;
    
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed ${res.status}`);
    
    const buf = new Uint8Array(await res.arrayBuffer());
    return { buf, file_path: info.file_path };
  }

  async function saveBufferToDir(buf, saveDir, filename) {
    const fs = require("node:fs/promises");
    const path = require("node:path");
    
    const safeName = String(filename)
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 255);
    
    if (!safeName || safeName.startsWith('.')) {
      throw new Error("Invalid filename");
    }
    
    const p = path.join(saveDir, safeName);
    
    const resolved = path.resolve(p);
    const safeDir = path.resolve(saveDir);
    if (!resolved.startsWith(safeDir)) {
      throw new Error("Invalid path");
    }
    
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, buf);
    return p;
  }

  const ensurePollingMode = () =>
    call("deleteWebhook", { drop_pending_updates: !!dropPendingOnStart }).catch(() => {});

  const drainBacklogToLatest = async () => {
    try {
      for (;;) {
        const batch = await call("getUpdates", { 
          offset: lastUpdateId + 1, 
          timeout: 0, 
          limit: 100 
        });
        if (!Array.isArray(batch) || batch.length === 0) break;
        for (const u of batch) {
          if (typeof u.update_id === "number") {
            lastUpdateId = Math.max(lastUpdateId, u.update_id);
          }
        }
      }
    } catch (e) { 
      console.warn("[Telegram] warm-up drain failed:", e.message); 
    }
  };

  const cleanCmd = (name) =>
    String(name || "")
      .replace(/^\/+/, "")
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 32);

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

      map[cleaned] = inv;
      map[rawCmd] = inv;

      if (hidden) continue;

      if (!seen.has(cleaned)) {
        seen.add(cleaned);
        const desc = (typeof v === "object" && v && (v.desc || v.description)) || cleaned;
        list.push({ 
          command: cleaned, 
          description: cleanDesc(desc, cleaned) 
        });
      }
    }
    return { list, map };
  };

  const { list: commandList, map: handlerMap } = normalize(commands);

  const __helpText = () => {
    const lines = ["🤖 Niyati Bot – Command Menu"];
    const seen = new Set();
    for (const { command, description } of commandList) {
      if (seen.has(command)) continue;
      lines.push(`/${command} – ${description}`);
      seen.add(command);
    }
    return lines.join("\n");
  };
  
  if (!handlerMap["help"] && !handlerMap["/help"]) { 
    handlerMap["help"] = ({ send }) => send(__helpText()); 
    handlerMap["/help"] = handlerMap["help"]; 
  }

  async function syncCommands(notify = false) {
    if (!commandList.length) return;

    const valid = commandList
      .map(c => ({
        command: cleanCmd(c.command),
        description: cleanDesc(c.description, c.command)
      }))
      .filter(c => /^[a-z0-9_]{1,32}$/.test(c.command));

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
        await call("sendChatAction", { 
          chat_id: chatId, 
          action: "typing" 
        }).catch(()=>{});
        if (notify) await sendRaw("🔧 Commands re-synced ✅");
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
          await sendRaw('❌ File Save Failed: ' + e.message);
        }
      })();
    }

    if (!msg.text) return; 
    const text = msg.text.trim();
    if (!text.startsWith("/")) return;

    const [raw, ...rest] = text.split(/\s+/);
    const cmd = cleanCmd(raw.replace(/^\/|@.*$/g, ""));
    
    // ✅ Sanitize arguments
    const rawArgs = rest.join(" ");
    const args = sanitizeInput(rawArgs, 1000);
    
    if (rawArgs !== args && rawArgs.length > 0) {
      console.warn(`[Telegram] Sanitized command args: "${rawArgs}" -> "${args}"`);
      wrapSendForCmd({ cmd, args })("⚠️ Input was Sanitized for Security");
    }

    const ctx = { 
      cmd, 
      args, // Sanitized version
      raw: text, 
      msg, 
      send: wrapSendForCmd({ cmd, args }), 
      sendPhoto: sendPhotoBuffer, 
      sendMediaGroup: sendMediaGroupPhotos, 
      syncCommands,
      downloadFile: downloadFileById,
      incomingFileSaveDir,
      message: msg
    };

    try { onCommand && onCommand({ cmd, args, raw: text }); } catch {}

    const handler = handlerMap[cmd] || handlerMap[raw] || handlerMap[`/${cmd}`];
    if (typeof handler === "function") {
      handler(ctx);
    } else if (typeof onUnknown === "function") {
      onUnknown(ctx);
    } else {
      ctx.send("❓ Unknown Command. Try /sync Then /help");
    }
  };

  async function start() {
    // ✅ Prevent multiple concurrent polling loops
    if (abortCtrl && !abortCtrl.signal.aborted) {
      console.log("[Telegram] Already running, skipping start");
      return;
    }

    try {
      await ensurePollingMode();
      await drainBacklogToLatest();
      await syncCommands(false);
      await sendRaw("🔗 Niyati Browser Connected.");
    } catch (e) {
      console.error("[Telegram] init error:", e.message);
    }

    abortCtrl = new AbortController();
    const { signal } = abortCtrl;

    while (!signal.aborted) {
      try {
        const res = await fetch(`${API}/getUpdates`, {
          method: "POST",
          headers: JSON_HDR,
          body: JSON.stringify({
            offset: lastUpdateId + 1,
            timeout: DEFAULT_TIMEOUT,
            limit: 100
          }),
          signal
        });
        const data = await res.json();
        if (!data.ok) throw new Error("getUpdates not ok: " + JSON.stringify(data));
        for (const upd of data.result) {
          if (typeof upd.update_id === "number") {
            lastUpdateId = Math.max(lastUpdateId, upd.update_id);
          }
          try { dispatch(upd); }
          catch (e) { console.error("[Telegram] dispatch error:", e.message); }
        }
      } catch (err) {
        if (signal.aborted) break;
        console.error("[Telegram] poll error:", err.message);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  const stop = () => { 
    if (abortCtrl) { 
      try { abortCtrl.abort(); } catch {} 
    } 
    abortCtrl = null; 
  };

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
    start, 
    stop,
    send: sendRaw,
    syncCommands,
    sendFile
  };
}

// Replace this section in your telegram.js file

function buildDefaultCommands(deps = {}) {
  const ok = (b) => (b ? "OK" : "Failed");

  const cmds = {
    help: {
      desc: "Show commands",
      handler: ({ send }) => send(HELP_TEXT_HTML, { 
        parse_mode: "HTML", 
        disable_web_page_preview: true 
      })
    },

    startref: { 
      desc: "Start auto-refresh", 
      handler: ({ send }) => send(ok(deps.enableAuto?.(deps.getIntervalSec?.() || 7)) ? "▶️ Auto-Refresh Started." : "❌ Start Failed – Retry.") 
    },
    
    stopref: { 
      desc: "Stop auto-refresh",  
      handler: ({ send }) => send(ok(deps.disableAuto?.()) ? "⏹️ Auto-Refresh Stopped." : "❌ Stop Failed – Retry.") 
    },
    
    setref: {
      desc: "Set refresh seconds",
      handler: ({ args, send }) => {
        const input = String(args || "").trim();
        if (!/^\d+$/.test(input)) {
          return send("❌ Invalid Input. Use: /setref <seconds> (e.g., /setref 10)");
        }
        const sec = Math.max(3, Math.min(3600, parseInt(input, 10) || 7));
        send(ok(deps.enableAuto?.(sec)) ? `⏱️ Auto-Refresh Set to ${sec}s.` : "❌ Couldn't Set Refresh – Try Again.");
      }
    },

    addprod: { 
      desc: "Add product",   
      handler: ({ args, send }) => {
        const safe = sanitizeInput(args, 200);
        if (!safe) return send("❌ Invalid Product Name");
        return send(ok(deps.addProduct?.(safe)) ? `✅ Product Saved: ${safe}` : "❌ Add Failed – Try Again.");
      }
    },
    
    delprod: { 
      desc: "Delete product",
      handler: ({ args, send }) => {
        const safe = sanitizeInput(args, 200);
        if (!safe) return send("❌ Invalid Product Name");
        return send(ok(deps.deleteProduct?.(safe)) ? `✅ Removed Product: ${safe}` : "❌ Delete Failed – Check the Name & Retry.");
      }
    },
    
    prodlist: { 
      desc: "List products", 
      handler: ({ send }) => {
        try {
          const arr = deps.listProducts ? deps.listProducts() : [];
          send(arr.length ? `📦 Products (${arr.length}):\n` + arr.map((x)=>`• ${x}`).join("\n") : "🔭 No Products Yet.");
        } catch { send("❌ Failed."); }
      }
    },

    addkey: { 
      desc: "Add keyword",   
      handler: ({ args, send }) => {
        const safe = sanitizeInput(args, 200);
        if (!safe) return send("❌ Invalid Keyword");
        return send(ok(deps.addKeyword?.(safe)) ? `✅ Added Keyword: ${safe}` : "❌ Couldn't Add – Retry.");
      }
    },
    
    delkey: { 
      desc: "Delete keyword",
      handler: ({ args, send }) => {
        const safe = sanitizeInput(args, 200);
        if (!safe) return send("❌ Invalid Keyword");
        return send(ok(deps.deleteKeyword?.(safe)) ? `✅ Removed: ${safe}` : "❌ Delete Failed – Retry.");
      }
    },
    
    keylist: { 
      desc: "List keywords", 
      handler: ({ send }) => {
        try {
          const arr = deps.listKeywords ? deps.listKeywords() : [];
          send(arr.length ? `🏷️ Keywords (${arr.length}):\n` + arr.map((x)=>`• ${x}`).join("\n") : "🙈 No Keywords Yet.");
        } catch { send("❌ Failed."); }
      }
    },

    ss: { 
      desc: "Both windows (album)",
      handler: async ({ send, sendMediaGroup }) => {
        try {
          await send("📸 Taking Screenshots of Both Windows…");
          const out = await deps.screenshotBothAsJpegs?.({ stayHidden: true, quality: 88 });
          if (out && out.managerBuf && out.leadsBuf) {
            await sendMediaGroup([
              { name: "manager", buf: out.managerBuf, caption: "Manager" },
              { name: "leads", buf: out.leadsBuf, caption: "Leads" }
            ]);
          } else {
            await send("❌ Screenshot Failed – Ensure main.js has ScreenshotBothAsJpegs.");
          }
        } catch (e) {
          await send("⚠️ Screenshot Failed: " + (e?.message || e));
        }
      }
    },
    
    sswin1: { 
      desc: "Screenshot Leads (photo)",
      handler: async ({ send, sendPhoto }) => {
        try {
          await send("📸 Capturing Leads…");
          const buf = await deps.screenshotLeadsAsJpeg?.({ stayHidden: true, quality: 88 });
          if (buf) {
            await sendPhoto(buf, { caption: "Leads", filename: "leads.jpg" });
          } else {
            await send("❌ Screenshot Failed – Ensure main.js has SreenshotLeadsAsJpeg.");
          }
        } catch (e) {
          await send("⚠️ Screenshot Failed " + (e?.message || e));
        }
      }
    },
    
    sswin2: { 
      desc: "Screenshot Manager (photo)",
      handler: async ({ send, sendPhoto }) => {
        try {
          await send("📸 Capturing Manager…");
          const buf = await deps.screenshotManagerAsJpeg?.({ stayHidden: true, quality: 88 });
          if (buf) {
            await sendPhoto(buf, { caption: "Manager", filename: "manager.jpg" });
          } else {
            await send("❌ Screenshot Failed – Ensure main.js has ScreenshotManagerAsJpeg.");
          }
        } catch (e) {
          await send("⚠️ Screenshot Failed: " + (e?.message || e));
        }
      }
    },

    status: { 
      desc: "Send status report",        
      handler: ({ send }) => send((deps.sendStatus && deps.sendStatus()) ? "🧾 Status Shared." : "❌ Status Send Failed – Retry.") 
    },
    
    clean: { 
      desc: "Memory clean",              
      handler: ({ send }) => send((deps.cleanNow && deps.cleanNow()) ? "🧹 Cleanup Complete." : "❌ Cleanup Failed – Retry.") 
    },
    
    cleanall: { 
      desc: "Archive+Truncate+Clean",    
      handler: ({ send }) => send((deps.cleanAll && deps.cleanAll()) ? "🧼 Deep Clean Done."  : "❌ Deep Clean Failed – Retry.") 
    },
    
    restart: { 
      desc: "Relaunch App",
      handler: async ({ send }) => {
        await send("🔄 Restarting…");
        deps.restartApp && deps.restartApp();
      }
    },
    
    quit: { 
      desc: "Quit The App", 
      handler: ({ send }) => { 
        send("🚪 Quitting…"); 
        deps.quitApp?.(); 
      } 
    },

    lock: { 
      desc: "Lock: hide ALL windows (incl. login)", 
      handler: ({ send }) => { 
        try { deps.lockAll && deps.lockAll(); } catch {} 
        return send("🔒 Locked – All Windows Hidden."); 
      } 
    },
    
    unlock: {
      desc: "Unlock (with or without creds)",
      handler: ({ send, args }) => {
        const maybe = deps.unlockNoCreds ? deps.unlockNoCreds() : (deps.unlockWithCreds ? deps.unlockWithCreds(args) : "🚫 Unlock Not Available");
        return send(maybe);
      }
    },

    manager: { 
      desc: "Focus Manager window",     
      handler: ({ send }) => send((deps.focusManager && deps.focusManager()) ? "🗂️ Manager Focused" : "❌ Failed") 
    },
    
    leads: { 
      desc: "Focus Leads window",       
      handler: ({ send }) => send((deps.focusLeads && deps.focusLeads()) ? "👀 Leads Focused"     : "❌ Failed") 
    },
    
    togglemax: { 
      desc: "Toggle maximize Manager",  
      handler: ({ send }) => { 
        try { deps.toggleMax && deps.toggleMax(); return send("🪄 Toggled"); } 
        catch { return send("❌ Failed"); } 
      } 
    },

    autologin: {
      desc: "Start auto-login",
      handler: ({ send }) => {
        if (deps.isLoggedIn && deps.isLoggedIn()) return send("ℹ️ Already Logged in.");
        if (!deps.startAutoLogin?.()) return send("⚠️ Auto-Login Not Ready.");
        return send("⏳ Auto-Login Started.");
      }
    },
    
    otp: {
      desc: "Submit OTP",
      handler: ({ args, send }) => {
        if (deps.isLoggedIn && deps.isLoggedIn()) return send("ℹ️ Already Logged in.");
        const okk = deps.injectOtp && deps.injectOtp(String(args || "").trim());
        return send(okk ? "🔐 OTP Submitted." : "❌ Invalid OTP / No Active Attempt.");
      }
    },
    
    resend: {
      desc: "Request OTP again",
      handler: ({ send }) => {
        if (deps.isLoggedIn && deps.isLoggedIn()) return send("ℹ️ Already Logged in.");
        return send(deps.requestResend?.() ? "🔁 Will Click Request OTP." : "⛔ No Auto-login Attempt is Active.");
      }
    },

    ping: { 
      desc: "Health check", 
      handler: ({ send }) => send("🏓 Pong") 
    },

    sync: {
      desc: "Re-sync slash commands",
      handler: ({ send, syncCommands }) => (async () => {
        try {
          await syncCommands(true);
        } catch (e) {
          await send("❌ Sync Failed: " + (e?.message || e));
        }
      })()
    },

    reload: { 
      desc: "Reload manager UI", 
      handler: ({ send }) => send(deps.reloadManager?.() ? "🔄 Manager Reloaded" : "❌ Reload Failed") 
    },

    // ✅ FIX: These need async handlers with proper send context
    runreports: {
      desc: "Run daily reports",
      handler: async ({ send }) => {
        try {
          // Call the actual function that sends reports
          const result = await new Promise((resolve) => {
            try {
              // This will be wired from main.js
              if (deps.sendDailyReports) {
                deps.sendDailyReports("manual").then(() => resolve(true)).catch(() => resolve(false));
              } else {
                resolve(false);
              }
            } catch {
              resolve(false);
            }
          });
          
          return send(result ? "📊 Reports Sent Successfully" : "❌ Reports Failed - Check Logs");
        } catch (e) {
          return send("❌ Failed: " + e.message);
        }
      }
    },

    memstats: {
      desc: "Show memory stats",
      handler: async ({ send }) => {
        try {
          const stats = {
            products: deps.getProductsCount ? deps.getProductsCount() : 0,
            timers: deps.getActiveTimers ? deps.getActiveTimers() : 0,
            message: "Stats Collected"
          };
          await send(`📊 Memory Stats:\n\`\`\`json\n${JSON.stringify(stats, null, 2)}\n\`\`\``, { parse_mode: 'Markdown' });
        } catch (e) {
          await send('❌ Failed: ' + e.message);
        }
      }
    },

    getfile: {
      desc: "Get a file from server",
      handler: async ({ args, send }) => {
        if (!args) return await send("Usage: /getfile <filename>\nExample: /getfile products.json");
        
        const fname = String(args).trim();
        const safe = fname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
        if (!safe) return await send("❌ Invalid Filename");
        
        try {
          if (deps.sendFile) {
            await deps.sendFile(safe);
            return await send(`✅ Sent: ${safe}`);
          } else {
            return await send("❌ sendFile not Available");
          }
        } catch (e) {
          return await send(`❌ Failed: ${e.message}`);
        }
      }
    },

    requestfile: {
      desc: "Request a file",
      handler: async ({ args, send }) => {
        if (!args) return await send("Usage: /requestfile <filename>");
        
        const fname = String(args).trim();
        const safe = fname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
        if (!safe) return await send("❌ Invalid Filename");
        
        try {
          if (deps.sendFile) {
            await deps.sendFile(safe);
            return await send(`✅ Sent: ${safe}`);
          } else {
            return await send("❌ SendFile Not Available");
          }
        } catch (e) {
          return await send(`❌ Failed: ${e.message}`);
        }
      }
    },

    fetch: {
      desc: "Download file from Telegram",
      handler: async ({ send, message }) => {
        if (!message?.document && !message?.video && !message?.audio) {
          return await send("Reply to a File With /fetch");
        }
        
        return await send("⏳ File Fetch not Fully Implemented Yet");
      }
    }
  };

  // Create aliases
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

module.exports = { 
  createTelegramClient, 
  buildDefaultCommands,
  saveBufferToDir: async (buf, saveDir, filename) => {
    const fs = require("node:fs/promises");
    const path = require("node:path");
    
    const safeName = String(filename)
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 255);
    
    if (!safeName || safeName.startsWith('.')) {
      throw new Error("Invalid filename");
    }
    
    const p = path.join(saveDir, safeName);
    
    const resolved = path.resolve(p);
    const safeDir = path.resolve(saveDir);
    if (!resolved.startsWith(safeDir)) {
      throw new Error("Invalid path");
    }
    
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, buf);
    return p;
  }
};