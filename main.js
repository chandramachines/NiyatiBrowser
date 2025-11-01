// Auto-added: Handle child-process crashes (GPU/Utility/etc)
const { app, BrowserWindow, ipcMain, nativeTheme, net, Tray, Menu, nativeImage } = require('electron');
app.on('child-process-gone', (_event, details) => {
  console.error('[child-process-gone]', details.type, details.reason, details.exitCode);
  if (details.type === 'GPU' && details.reason !== 'clean-exit') {
    app.relaunch();
    app.exit(0);
  }
});


// --- Auto-refresh queuing flags (injected) ---
let pendingStartMs = null;   // if leads:start arrives before productScraper is ready
let pendingResume  = false;  // set true when online verified but scraper not yet created
// main.js (E2E) — adds robust Daily Reports scheduler (IST) with catch-up + de-dup
// Baseline behavior preserved; only additions are clearly marked “// === Daily Reports ===”

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("path");

app.commandLine.appendSwitch("disable-logging");
if (String(process.env.QUIET ?? "1") === "1") {
  const noop = () => {}; console.log = console.info = console.debug = console.warn = noop;
}
require("events").defaultMaxListeners = 30; // Increased from 0 to prevent memory leaks while allowing needed listeners

(() => { try {
  const env = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  for (const ln of env.split(/\r?\n/)) {
    const m = ln.trim().match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
} catch {} })();

const { createStatusWatcher } = require("./statuswatcher");
const { createTelegramClient, buildDefaultCommands } = require("./telegram");
const { createAutoLogin } = require("./autologin");
const { createProductScraper } = require("./productScraper");
const { createMessageCentre } = require("./messagecentre");
const { createMatchClicker } = require("./matchclicker");
const { createKeywordMatcher } = require("./keywordmatcher");
const { createLockScreen } = require("./lockscreen");

const EXISTS = fs.existsSync;
const REPORTS_DIR  = path.join(__dirname, "Reports");


/** Count new products in the last 30 minutes from products_log.json */
function parseProductTs(s) {
  try {
    if (!s) return 0;
    if (/^\d{4}-\d{2}-\d{2}T/.test(String(s))) {
      const t = Date.parse(String(s));
      return Number.isFinite(t) ? t : 0;
    }
    const t = Date.parse(String(s).replace(' ', 'T') + '+05:30'); // legacy local format
    return Number.isFinite(t) ? t : 0;
  } catch { return 0; }
}

function countNewProductsLast(ms = 30 * 60 * 1000) {
  try {
    const p = path.join(REPORTS_DIR, "products_log.json");
    const raw = fs.readFileSync(p, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return 0;
    const now = Date.now();
    let n = 0;
    for (const r of arr) {
      const t = parseProductTs(r && (r.timestamp || r.time));
      if (t && (now - t) <= ms) n++;
    }
    return n;
  } catch { return 0; }
}

const SEND_FILES   = [
  path.join(REPORTS_DIR,  "messagecentre_log.json"),
  path.join(REPORTS_DIR,  "keyword_matches.json"),
  path.join(REPORTS_DIR, "products_log.json"),
  path.join(REPORTS_DIR, "matchclick.json"),
];
const CLEANUP_FILES = [...SEND_FILES];
const LEADS_DEFAULT_URL = "https://seller.indiamart.com/bltxn/?pref=recent";
const SCHED = { times:[{h:8,m:0,label:"08:00"},{h:20,m:0,label:"20:00"}], lastKey:null };

let winLeads, winManager, autoLogin, productScraper, watcher, mc, matcher, kwMatcher, tg;
let isLoggedIn = null, isNetworkOnline = true, suspendedByAuth = false;
let tray = null;
let lockScreen = null;

// === Daily Reports (config) ===================================================
const DAILY_TZ = process.env.DAILY_TZ || "Asia/Kolkata";
const DAILY_REPORT_TIMES = (process.env.DAILY_REPORT_TIMES || "08:00,20:00")
  .split(",").map(s => s.trim()).filter(Boolean);  // e.g. "08:00,20:00"
const DAILY_CATCHUP_MINS = parseInt(String(process.env.DAILY_CATCHUP_MINS ?? "120"), 10) || 120;
let dailyTimer = null;
function _dailyStatePath() {
  try { return path.join(app.getPath("userData"), "daily_report_state.json"); }
  catch { return path.join(__dirname, "daily_report_state.json"); }
}
function _loadDailyState() { try { return JSON.parse(fs.readFileSync(_dailyStatePath(), "utf8")); } catch { return {}; } }
function _saveDailyState(s) { try { fs.writeFileSync(_dailyStatePath(), JSON.stringify(s)); } catch {} }
function _markDailyRun(state, dayKey, slot) {
  state[dayKey] ||= {};
  state[dayKey][slot] = Date.now();
  _saveDailyState(state);
}
function _fmtParts(date, tz, opts) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}
function _todayKey(tz = DAILY_TZ) {
  const p = _fmtParts(new Date(), tz, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`; // YYYY-MM-DD
}
function _nowHHMM(tz = DAILY_TZ) {
  const p = _fmtParts(new Date(), tz, { hour12: false, hour: "2-digit", minute: "2-digit" });
  return `${p.hour}:${p.minute}`; // HH:MM
}
const _hhmmNum = (hhmm) => parseInt(String(hhmm).replace(":", ""), 10);
function _shouldRunSlot(state, dayKey, slot, catchUpMins = DAILY_CATCHUP_MINS) {
  if (state?.[dayKey]?.[slot]) return false;               // already ran
  const nowNum = _hhmmNum(_nowHHMM());
  const slotNum = _hhmmNum(slot);
  if (nowNum === slotNum) return true;                     // exact tick
  if (nowNum > slotNum) {
    const h = Math.floor(catchUpMins / 60), m = catchUpMins % 60;
    const units = h * 100 + m;                             // 120m -> 200
    return (nowNum - slotNum) <= units;                    // within catch-up window
  }
  return false;
}
// ============================================================================

const LOCK_PERSIST = String(process.env.LOCK_PERSIST ?? "1") === "1";
const LOCK_PERSIST_TTL_MS = parseInt(String(process.env.LOCK_PERSIST_TTL_MS ?? "0"), 10) || 0;
function _lockStorePath() {
  try { return path.join(app.getPath("userData"), "lockstate.json"); }
  catch { return path.join(__dirname, "lockstate.json"); }
}
function _readLockState() {
  try {
    const raw = fs.readFileSync(_lockStorePath(), "utf8");
    const s = JSON.parse(raw);
    return (s && typeof s === "object") ? s : { unlocked:false };
  } catch { return { unlocked:false }; }
}
function isUnlockedPersisted() {
  try {
    const s = _readLockState();
    if (!s.unlocked) return false;
    if (!s.expiresAt || s.expiresAt === 0) return true;
    return Date.now() < Number(s.expiresAt);
  } catch { return false; }
}
function persistUnlock(source) {
  if (!LOCK_PERSIST) return;
  try {
    const p = _lockStorePath();
    const dir = path.dirname(p);
    try { fs.mkdirSync(dir, { recursive:true }); } catch {}
    const expiresAt = LOCK_PERSIST_TTL_MS > 0 ? (Date.now() + LOCK_PERSIST_TTL_MS) : 0;
    const payload = { unlocked:true, at:new Date().toISOString(), source: source||"unknown", expiresAt };
    fs.writeFileSync(p + ".tmp", JSON.stringify(payload), "utf8");
    fs.renameSync(p + ".tmp", p);
  } catch {}
}
function clearPersist() {
  try {
    const p = _lockStorePath();
    fs.writeFileSync(p + ".tmp", JSON.stringify({ unlocked:false, at:new Date().toISOString() }), "utf8");
    fs.renameSync(p + ".tmp", p);
  } catch {}
}

const START_LOCK = String(process.env.LOCK_ON_START ?? "1") === "1";
const shouldShowWindows = () => !(lockScreen?.isLocked?.() || START_LOCK);

const statusExtras = { cycleId:null, lastScrapedProduct:null, lastKeywordMatchProduct:null, cycleNewCount:0, cycleClicks:0 };

let productsLogCount = (function(){ try { const f=require("node:path").join(__dirname,"Reports","products_log.json"); const d=require("node:fs").readFileSync(f,"utf-8"); const j=JSON.parse(d); return Array.isArray(j)?j.length:0; } catch { return 0; } })();
function _readProductsLogCount(){ try { const f=require("node:path").join(__dirname,"Reports","products_log.json"); const d=require("node:fs").readFileSync(f,"utf-8"); const j=JSON.parse(d); return Array.isArray(j)?j.length:0; } catch { return 0; } }
let unstickTimer = null, waitLoadPromise = null, queuedReload = null;
function requestReload(reason){
  // Circuit-breaker: don't queue reloads while offline
  if (isNetworkOnline === false) { log("debug", `skip reload — offline (${reason})`); return; }
  if (queuedReload) return;
  queuedReload = setTimeout(() => {
    queuedReload = null;
    if (isNetworkOnline === false) { log("debug","skip reload dispatch — offline"); return; }
    try { safeReloadLeads(reason).catch(()=>{}); } catch {}
  }, 200);
}
function waitForFinishOnce(wc, timeoutMs=10000){
  if (waitLoadPromise) return waitLoadPromise;
  waitLoadPromise = new Promise((resolve,reject)=>{
    const onOk=()=>{cleanup();resolve();}, onErr=(e)=>{cleanup();reject(e instanceof Error?e:new Error(String(e)));};
    const cleanup=()=>{ clearTimeout(t); try{wc.off("did-finish-load",onOk);}catch{} try{wc.off("did-fail-load",onErr);}catch{} try{wc.off("render-process-gone",onErr);}catch{} waitLoadPromise=null; };
    wc.once("did-finish-load", onOk); wc.once("did-fail-load", onErr); wc.once("render-process-gone", onErr);
    const t=setTimeout(()=>{cleanup();reject(new Error("timeout"));},timeoutMs);
  });
  return waitLoadPromise;
}
const log = (level, msg) => { const p = { t: Date.now(), level, msg:`LM: ${msg}` }; try { winManager?.webContents?.send("log:append", p); } catch {} };
const debounce = (fn, ms=300) => { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };
const webPrefs = () => ({ contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, preload: path.join(__dirname,"preload.js") });
const onShow = (w, cb) => w.once("ready-to-show", ()=>{ try{ if (shouldShowWindows()) w.show(); }catch{} cb?.(); });
const pad2=n=>String(n).padStart(2,"0");
const fmtDate=(d=new Date())=>`${pad2(d.getDate())}-${pad2(d.getMonth()+1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const fmtHMS=(d=new Date())=>`${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const esc=s=>String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const fmtDur=(ms)=>{const s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60);return [d?`${d}d`:null,h?`${h}h`:null,`${m}m`].filter(Boolean).join(" ");};
const fmtMB=(b)=>`${Math.round((Number(b)||0)/(1024*1024))} MB`;

const CLICK_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
let clickTimes = []; // timestamps (ms) for auto "matchClick: Clicked" events

function countClicksLast(ms = CLICK_WINDOW_MS) {
  const now = Date.now();
  let firstFreshIdx = 0;
  if (clickTimes.length) {
    let found = false;
    for (let i = 0; i < clickTimes.length; i++) {
      if (now - clickTimes[i] <= ms) { firstFreshIdx = i; found = true; break; }
    }
    if (!found) firstFreshIdx = clickTimes.length; // all stale
    if (firstFreshIdx > 0) clickTimes.splice(0, firstFreshIdx);
  }
  return clickTimes.length;
}

function findFirstKeywordMatch(items){ try{
  const kws = loadKeywords().map(s=>String(s||"").toLowerCase()).filter(Boolean);
  if(!kws.length) return null;
  for (const it of items||[]) {
    const title = String(it.title || it.product || "").toLowerCase(); if(!title) continue;
    for (const kw of kws) if (title.includes(kw)) return it.product || it.title || null;
  }
} catch{} return null; }

const APP_START_TS = Date.now();
const buildState = ()=>{ const rs = productScraper?.getReloadState?.() || {};
  return { enabled:!!rs.enabled, intervalMs:rs.intervalMs||7000, isLoggedIn, suspendedByAuth,
           userWantedAutoRefresh:!!rs.userWantedAutoRefresh, isNetworkOnline,
           lastStartAt:rs.lastStartAt||0, lastStopAt:rs.lastStopAt||0, lastCycleAt:rs.lastCycleAt||0, cycles:rs.cycles||0 }; };
const broadcast = ()=>{ const s=buildState(); try{ winManager?.webContents?.send("refresh:state",s); winManager?.webContents?.send("leads:state",s);}catch{} };

function readLatestMC(){ try { const p=path.join(REPORTS_DIR,"messagecentre_log.json"); if(!EXISTS(p)) return null; const arr=JSON.parse(fs.readFileSync(p,"utf8")); return Array.isArray(arr) && arr[0] || null; } catch { return null; } }
function fmtLeadHTML(label,r){
  const last10=v=>String(v||"").replace(/\D/g,"").slice(-10);
  const ph=last10(r.mobile), wa = ph ? `https://wa.me/91${ph}`:"";
  const maps=r.address?`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.address)}`:"";
  return [label,
    r.product&&`✨ <b>${esc(r.product)}</b>`,
    r.buyer&&`👤 <b>Name:</b> ${esc(r.buyer)}`,
    r.company&&`🏢 <b>Company:</b> ${esc(r.company)}`,
    ph&&`📞 <b>Mobile:</b> +91${ph}`,
    wa&&`💬 <b>WhatsApp:</b> <a href="${wa}">${esc(wa)}</a>`,
    r.gstin&&`🧾 <b>GSTIN:</b> ${esc(r.gstin)}`,
    r.email&&`✉️ <b>Email:</b> ${esc(r.email)}`,
    r.address&&`📍 <b>Address:</b> ${esc(r.address)}`,
    maps&&`🗺️ <a href="${maps}">Open in Maps</a>`,
    r.time&&`⏰ <b>Time:</b> ${esc(r.time)}`
  ].filter(Boolean).join("\n");
}
function buildStatus(){
  const up=fmtDur(Date.now()-APP_START_TS), mem=process.memoryUsage?.().rss??0, st=productScraper?.getReloadState?.()||{};
  const auth=(isLoggedIn===true)?"Logged IN":(isLoggedIn===false?"Logged OUT":"Unknown");
  const refresh=st.enabled?`Running @${Math.round((st.intervalMs||7000)/1000)}s`:"Stopped";
  const net=isNetworkOnline?"Online":"Offline";
  const lastScraped=statusExtras.lastScrapedProduct||"—";
  const lastKWMatch=statusExtras.lastKeywordMatchProduct||"—";
  const newCount = countNewProductsLast();
  const clickCount=statusExtras.cycleClicks||0;
  const last30=countClicksLast();
  const head=[
    "🛰️ <b>Status</b>",
    `⏱️ <b>Uptime:</b> ${esc(up)}`,
    `🧮 <b>Memory (RSS):</b> ${esc(fmtMB(mem))}`,
    `🔐 <b>Auth:</b> ${esc(auth)}`,
    `🔄 <b>Refresh:</b> ${esc(refresh)}`,
    `🌐 <b>Network:</b> ${esc(net)}`,
    `📦 <b>Last Scraped Product:</b> ${esc(lastScraped)}`,
    `🔑 <b>Last Keyword Match Product:</b> ${esc(lastKWMatch)}`,
    `🆕 <b>New Products (Last 30 Min):</b> ${esc(String(newCount))}`,
    `🕧 <b>Clicks (last 30 min):</b> ${esc(String(last30))}`,
  ].join("\n");
  const latest = readLatestMC();
  return head + (latest ? "\n\n"+fmtLeadHTML("🆕 <b>Latest Message Centre</b>", latest) : "\n\nℹ️ No Message Centre entries yet.");
}
async function sendStatusReport(tag="30-min"){ try{ await tg?.send?.(buildStatus(),{parse_mode:"HTML",disable_web_page_preview:true}); log("info",`Reports: status (${tag}) sent`);} catch(e){ log("error",`Reports: status send failed — ${e.message}`);} }
function scheduleEvery30Min(){ const now=new Date(),min=now.getMinutes(),nextMin=min<30?30:60;
  const ms=(nextMin-min)*60*1000 - now.getSeconds()*1000 - now.getMilliseconds();
  setTimeout(()=>{ sendStatusReport("aligned").then(()=>{ statusExtras.cycleNewCount = 0; }).catch(()=>{}); setInterval(()=>sendStatusReport("interval").catch(()=>{}),30*60*1000); }, Math.max(1000, ms));
}

const LIST_DIR=path.join(__dirname,"List");
const F_PRODUCTS=path.join(LIST_DIR,"products.json");
const F_KEYWORDS=path.join(__dirname,"List","keywords.json");
const normSpace=s=>String(s||"").trim().replace(/\s+/g," ");
const toTitle=s=>normSpace(s).toLowerCase().split(" ").map(w=>w?w[0].toUpperCase()+w.slice(1):"").join(" ");
const readJSON=(f,fb)=>{ try { return JSON.parse(fs.readFileSync(f,"utf8")); } catch { return fb; } };
const writeJSON=(f,d)=>{ try { fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f, JSON.stringify(d,null,2),"utf8"); return true; } catch { return false; } };
const loadProducts=()=>Array.isArray(readJSON(F_PRODUCTS,[]))?readJSON(F_PRODUCTS,[]):[];
const loadKeywords=()=>Array.isArray(readJSON(F_KEYWORDS,[]))?readJSON(F_KEYWORDS,[]):[];
const saveProducts=a=>writeJSON(F_PRODUCTS,Array.isArray(a)?a:[]);
const saveKeywords=a=>writeJSON(F_KEYWORDS,Array.isArray(a)?a:[]);
async function updateManagerLists({products:prodList,keywords:keyList}={}){
  if (!winManager) return false;
  const setK=(k,v)=>`localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(JSON.stringify(v))});`;
  const js = `(function(){try{${typeof prodList!=="undefined"?setK("niyati:products", prodList):""}${typeof keyList!=="undefined"?setK("niyati:keywords", keyList):""}if(window.RendererLists?.refresh)window.RendererLists.refresh();true;}catch(e){false;}})();`;
  try { return await winManager.webContents.executeJavaScript(js, true); } catch { return false; }
}
function addProduct(name){ name=toTitle(name); if(!name) return false; const arr=loadProducts(); if(!arr.some(v=>v.toLowerCase()===name.toLowerCase())) arr.push(name); const ok=saveProducts(arr);
  try { productScraper?.setProducts?.(arr); } catch {}
  updateManagerLists({products:arr}).catch(()=>{}); log("info",`Lists: product added — ${name}`); return ok; }
function deleteProduct(name){ const arr=loadProducts(); const key=String(name||"").toLowerCase(); const next=arr.filter(v=>v.toLowerCase()!==key); const ok=saveProducts(next);
  try { productScraper?.setProducts?.(next); } catch {}
  updateManagerLists({products:next}).catch(()=>{}); log("info",`Lists: product deleted — ${name}`); return ok && next.length!==arr.length; }
function addKeyword(kw){ kw=normSpace(kw).toLowerCase(); if(!kw) return false; const arr=loadKeywords(); if(!arr.includes(kw)) arr.push(kw); const ok=saveKeywords(arr); updateManagerLists({keywords:arr}).catch(()=>{}); log("info",`Lists: keyword added — ${kw}`); return ok; }
function deleteKeyword(kw){ kw=normSpace(kw).toLowerCase(); const arr=loadKeywords(); const next=arr.filter(v=>v!==kw); const ok=saveKeywords(next); updateManagerLists({keywords:next}).catch(()=>{}); log("info",`Lists: keyword deleted — ${kw}`); return ok && next.length!==arr.length; }

let leadsReloading=false;
async function safeReloadLeads(reason="manual"){
  if (!winLeads || leadsReloading) return false;
  leadsReloading = true;
  try {
    if (isNetworkOnline === false) { log("info", `safeReload ignored — offline (${reason})`); leadsReloading=false; return false; }
    log("start",`Leads:safeReload → ${reason}`);
    const wc = winLeads.webContents;
    try{ wc.stop(); }catch{}
    try{ watcher?.setReloading(true);}catch{}
    wc.reloadIgnoringCache();
    try {
      await waitForFinishOnce(wc, 10000);
      log("info","safeReload soft OK");
      return true;
    } catch(e) {
      log("info",`safeReload soft timeout — hard nav (${e.message})`);
      if (isNetworkOnline === false) { log("info","hard nav skipped — offline"); return false; }
      wc.loadURL(LEADS_DEFAULT_URL);
      try {
        await waitForFinishOnce(wc, 12000);
        log("info","safeReload hard OK");
        return true;
      } catch(e2) {
        log("error",`safeReload hard failed — ${e2.message || e2}`);
        return false;
      }
    }
  } finally { try{ watcher?.setReloading(false);}catch{} leadsReloading=false; }
}
async function archiveAndTruncate(files, tag=""){ try {
  const ts=new Date(), stamp=`${ts.getFullYear()}-${pad2(ts.getMonth()+1)}-${pad2(ts.getDate())}_${pad2(ts.getHours())}${pad2(ts.getMinutes())}`;
  const dir=path.join(__dirname,"reports_archive",stamp); await fsp.mkdir(dir,{recursive:true});
  log("start",`Cleanup: Archiving ${files.length} files → ${path.basename(dir)} ${tag?`(${tag})`:""}`);
  for (const src of files) { try { await fsp.copyFile(src, path.join(dir, path.basename(src))); await fsp.writeFile(src,""); log("info",`Cleanup: ${path.basename(src)} archived & truncated`);} catch(e){ log("error",`Cleanup: ${path.basename(src)} failed — ${e.message}`);} }
} catch(e){ log("error",`Cleanup archive error: ${e.message}`);} }
async function sendDailyReports(whenLabel){ try {
  const toSend=SEND_FILES.filter(EXISTS);
  log("start",`Reports: ${whenLabel} — preparing (${toSend.length} files)`);
  if (toSend.length) {
    tg?.send?.(`📤 ${whenLabel} — Reports (${toSend.length} files)`).catch(()=>{});
    for (const pth of toSend) { try { await tg?.sendFile?.(pth, `Niyati • ${path.basename(pth)} • ${fmtDate()}`); log("info",`Report sent: ${path.basename(pth)}`);} catch(e){ log("error",`Report send failed: ${path.basename(pth)} — ${e.message}`);} }
  } else { tg?.send?.(`ℹ️ ${whenLabel}: No report files to send.`).catch(()=>{}); }
  const all = CLEANUP_FILES.filter(EXISTS);
  if (all.length) { await archiveAndTruncate(all, whenLabel); }
  await resetReportsMemory(); // injected post-archive reset

} catch(e){ log("error",`sendDailyReports error: ${e.message}`);} }
async function gentleMemoryCleanup(reason=""){ try {
  log("start",`Cleanup: Memory cleanup starting${reason?` (${reason})`:""}`);
  const ses=winLeads?.webContents?.session;
  if (ses && !winLeads?.isDestroyed?.()) { 
    try { await ses.clearCache(); } catch(e) { log("error", `clearCache failed: ${e.message}`); }
    if (typeof ses.clearCodeCaches==="function") { 
      try { await ses.clearCodeCaches({}); } catch(e) { log("error", `clearCodeCaches failed: ${e.message}`); }
    }
  }
  if (winLeads && !winLeads.isDestroyed()) {
    try { await winLeads.webContents.executeJavaScript("try{ if(globalThis.gc) gc(); }catch{}; void 0;", true);} catch(e) { log("error", `GC trigger failed: ${e.message}`); }
  }
  log("info",`Memory cleanup done${reason?` — ${reason}`:""}`);
} catch(e){ log("error",`Memory cleanup failed: ${e.message}`);} }

let _scraperPausedReason = null;
function pauseScraper(reason) {
  try {
    productScraper?.disableAutoReload?.(reason || "pause");
    productScraper?.disable?.();
    _scraperPausedReason = reason || "pause";
    log("stop", `Scraper paused — ${_scraperPausedReason}`);
  } catch (e) {
    log("error", `Pause scraper failed: ${e?.message || e}`);
  }
}
function resumeScraperIfAllowed() {
  try {
    productScraper?.enable?.();

    const st = productScraper?.getReloadState?.() || {};
    if (st.userWantedAutoRefresh && !st.enabled && isNetworkOnline && isLoggedIn !== false) {
      productScraper.enableAutoReload(st.intervalMs || 7000, () => watcher?.setReloading(true));
      log("start", `Scraper resumed${_scraperPausedReason ? ` (was: ${_scraperPausedReason})` : ""}`);
    } else {
      log("info", "Scraper enable checked — constraints not met (no auto-resume).");
    }
  } catch (e) {
    log("error", `Resume scraper failed: ${e?.message || e}`);
  } finally {
    _scraperPausedReason = null;
  }
}

function createManagerWindow(){
  winManager = new BrowserWindow({
    title:"Manager", width:1200, height:800, minWidth:900, minHeight:600,
    frame:false, titleBarStyle:"hidden",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111111" : "#0f0f10",
    webPreferences: webPrefs(),
    show: false
  });
  winManager.loadFile(path.join(__dirname,"index.html"));
  winManager.once("ready-to-show", ()=>{try{ if (shouldShowWindows()) winManager.show(); }catch{} broadcast();});
  const sendState=()=>{ if(!winManager || winManager.isDestroyed()) return; winManager.webContents.send("win:state", winManager.isMaximized()?"max":"restored"); };
  ["maximize","unmaximize","focus","enter-full-screen","leave-full-screen"].forEach(ev=>winManager.on(ev, sendState));
  winManager.on("closed", ()=>{ winManager=null; });
}

function createLeadsWindow(){
  winLeads = new BrowserWindow({ title:"Leads", show:false, webPreferences:webPrefs() });
  winLeads.maximize();
  const wc=winLeads.webContents;
  wc.setMaxListeners(20); wc.removeAllListeners("did-fail-load"); wc.removeAllListeners("render-process-gone");
  winLeads.loadURL(LEADS_DEFAULT_URL);
  winLeads.on("closed", ()=>{ winLeads=null; });
  wc.on("did-start-loading", ()=>{ clearTimeout(unstickTimer); unstickTimer=setTimeout(()=>{ try{watcher?.setReloading(false);}catch{} log("info","Failsafe: clearing inReload (12s)"); },12000); });
  wc.on("did-finish-load", ()=>{ clearTimeout(unstickTimer); try{watcher?.setReloading(false);}catch{} log("info","Leads page loaded"); });

  const OFFLINE_CODES=new Set([-106,-105,-118]);
  wc.on("did-fail-load", (_e, code, desc, _url, isMainFrame)=>{
    clearTimeout(unstickTimer);
    if (OFFLINE_CODES.has(code) && isNetworkOnline!==false) {
      isNetworkOnline=false;
      const st=productScraper?.getReloadState?.()||{};
      if(st.enabled) productScraper.disableAutoReload("network offline");
      pauseScraper("network offline");
    }
    if (isMainFrame) { log("error",`Leads: did-fail-load ${code} ${desc}`); requestReload("did-fail-load"); }
    broadcast();
  });
  wc.on("render-process-gone", (_e,d)=>{ log("error",`Leads: render-process-gone (${d?.reason||"unknown"})`); requestReload("render-process-gone"); });

  onShow(winLeads, ()=>{
    productScraper = createProductScraper({
      win:winLeads, delayMs:3000, maxItems:50, loginSelector:"#selsout",
      log:(lvl,msg)=>{ log(lvl,msg); if (lvl==="info" && /^persist:\s*\+/.test(String(msg))) { statusExtras.cycleNewCount = (statusExtras.cycleNewCount||0) + 1; } },
      onItems:(items,cycleId)=>{
        statusExtras.cycleId = cycleId;
        statusExtras.cycleClicks = 0;
        statusExtras.lastScrapedProduct = (items && items[0]) ? (items[0].product || items[0].title || null) : null;
        try { const curr=_readProductsLogCount(); const delta=Math.max(0, curr - productsLogCount); if (delta) { statusExtras.cycleNewCount = (statusExtras.cycleNewCount||0) + delta; } productsLogCount = curr; } catch {}

        const kwHit = findFirstKeywordMatch(items);
        if (kwHit) statusExtras.lastKeywordMatchProduct = kwHit;

        try {
          matcher?.processCycle(items, cycleId);
        } catch (e) {
          log("error", "matcher error: " + (e?.message || e));
        }

        try {
          kwMatcher?.processCycle(items, cycleId).catch(err => log("error", "kwMatcher error: " + (err?.message || err)));
        } catch (e) {
          log("error", "kwMatcher invoke error: " + (e?.message || e));
        }
      }
    });

// --- Auto-refresh queue drain / resume persisted state (injected) ---
if (pendingStartMs) {
  productScraper.enableAutoReload(pendingStartMs, () => watcher?.setReloading(true));
  log("start", `Auto-refresh started (queued) @ ${Math.round(pendingStartMs/1000)}s`);
  pendingStartMs = null;
} else {
  try { resumeScraperIfAllowed(); } catch {}
}
if (pendingResume) {
  try { resumeScraperIfAllowed(); } catch {}
  pendingResume = false;
}
broadcast();

    productScraper.wireListsIPC(ipcMain);

    matcher = createMatchClicker({
      win:winLeads,
      log:(lvl,msg)=>{
        log(lvl,msg);
        if (lvl==="info" && /^matchClick:\s*Clicked/i.test(String(msg))) {
          statusExtras.cycleClicks = (statusExtras.cycleClicks || 0) + 1;
          const now = Date.now();
          clickTimes.push(now);
          countClicksLast(); // prune + keep count fresh
        }

        if (lvl==="info" && /^matchClick:\s*Clicked/.test(String(msg))) {
          const m=String(msg).match(/list#(\d+)\s*[—-]\s*"([^"]+)"/);
          (async ()=>{
            try {
              await mc?.enqueue?.({ reason: m ? `#list${Number(m[1])} ${m[2]}` : "click" });
            } catch(e) {
              log("error","MC enqueue failed: "+e.message);
            }
            try {
              await safeReloadLeads("post-click");
            } catch(e) {
              log("error","post-click refresh failed: "+e.message);
            }
          })();
        }
      },
      getProducts:()=>productScraper.getProducts(),
      send: (text, extra) => { try { tg?.send?.(text, extra); } catch {} }
    });

    kwMatcher = createKeywordMatcher({
      log:(lvl,msg)=>log(lvl,msg),
      send:(text,extra)=>{ try{ tg?.send?.(text,extra);}catch{}; log("start",`KW-Notify → ${String(text).replace(/\n/g," | ")}`); },
      keywordsFile: path.join(LIST_DIR,"keywords.json")
    });

    try{
      productScraper.enable();
      const st=productScraper.getReloadState?.()||{};
      if (st.userWantedAutoRefresh && isNetworkOnline && isLoggedIn !== false) {
        productScraper.enableAutoReload(st.intervalMs||7000, ()=>watcher?.setReloading(true));
        log("start","Auto-refresh enabled");
        broadcast();
      }
    } catch(e){ log("error","scraper init failed: "+(e?.message || e)); }

    autoLogin = createAutoLogin({
      win:winLeads, log:(lvl,msg)=>log(lvl,msg),
      notify:(m)=>{ log("info",`[AutoLogin] ${m}`); tg?.send?.(`[AutoLogin] ${m}`).catch(()=>{}); },
      onSuccess: ()=>{
        productScraper.navigateToDefault({hard:true}); try{ winManager?.reload(); }catch{}
        const st=productScraper.getReloadState?.()||{};
        if (st.userWantedAutoRefresh && !st.enabled && isLoggedIn !== false && isNetworkOnline) {
          productScraper.enableAutoReload(st.intervalMs||7000, ()=>watcher?.setReloading(true));
        }
        productScraper.enable?.();
      },
      onFail: ()=>{ log("error","Auto-login failed after 3 attempts"); tg?.send?.("❌ Auto-login failed after 3 attempts. Use /autologin to retry.").catch(()=>{}); }
    });
  });
}

function getTrayIcon() {
  const p = path.join(__dirname,"icon.png");
  if (EXISTS(p)) return nativeImage.createFromPath(p);
  const b64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/aq0be8AAAAASUVORK5CYII=";
  return nativeImage.createFromDataURL(`data:image/png;base64,${b64}`);
}
function ensureLeadsWindow(){ if (winLeads && !winLeads.isDestroyed()) return winLeads; createLeadsWindow(); return winLeads; }
function ensureManagerWindow(){ if (winManager && !winManager.isDestroyed()) return winManager; createManagerWindow(); return winManager; }
function restartLeadsWindow(){ try{ productScraper?.disableAutoReload?.("leads restart"); productScraper?.disable?.(); }catch{} productScraper=null; try{ if(winLeads && !winLeads.isDestroyed()) winLeads.destroy(); }catch{} createLeadsWindow(); log("start","Tray: Leads Restart"); }
function restartManagerWindow(){ try{ if(winManager && !winManager.isDestroyed()) winManager.destroy(); }catch{} createManagerWindow(); log("start","Tray: Manager Restart"); }
function createTray(){
  try{
    tray?.destroy(); tray=new Tray(getTrayIcon()); tray.setToolTip("Niyati Browser");
    const menu=Menu.buildFromTemplate([
      { label:"Leads Restart", click: ()=> restartLeadsWindow() },
      { label:"Manager Restart", click: ()=> restartManagerWindow() },
      { type:"separator" },
      { label:"Lock",   click: ()=> lockScreen?.lockSilent?.() },
      { label:"Unlock", click: ()=> lockScreen?.show?.() },
      { type:"separator" },
      { label:"Browser Quit", click: ()=>{ try{ tg?.send?.("🚪 🚪 Quitting…").catch(()=>{});}catch{} app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    tray.on("click", ()=>{
      if (lockScreen?.isLocked?.()) { lockScreen.show?.(); return; }
      const w=ensureManagerWindow(); try{ w.show(); w.focus(); }catch{}
    });
  }catch(e){ console.error("Tray init failed:", e.message); }
}

function wireStatusWatcher(){
  if (!winLeads) return;
  const probe=(url="https://seller.indiamart.com/favicon.ico", timeoutMs=4000)=>new Promise((resolve)=>{
    try{
      const req=net.request({method:"HEAD",url}); const t=setTimeout(()=>{ try{req.abort();}catch{} resolve(false); },timeoutMs);
      req.on("response",(res)=>{ clearTimeout(t); resolve(res.statusCode>=200 && res.statusCode<500); });
      req.on("error",()=>{ clearTimeout(t); resolve(false); }); req.end();
    } catch { resolve(false); }
  });
  const oneShotReload=debounce(async()=>{ if(await probe()) requestReload("online-recover"); },2000);

  watcher=createStatusWatcher({
    win:winLeads, selector:"#selsout", checkEveryMs:3000, hostProbe:()=>probe(),
    onLogin: ()=>{
      suspendedByAuth=false; isLoggedIn=true; log("auth","Login detected ✓");
      productScraper.navigateToDefault(); if (autoLogin?.running) autoLogin.cancel();
      resumeScraperIfAllowed();
      broadcast();
    },
    onLogout: async ()=>{
      isLoggedIn=false; log("auth","Logout detected ✗ — auto-refresh suspended");
      const st=productScraper.getReloadState?.()||{}; suspendedByAuth=st.userWantedAutoRefresh;
      if (st.enabled) productScraper.disableAutoReload("auth logout");
      pauseScraper("auth logout");
      try{
        const still=await winLeads.webContents.executeJavaScript('!!document.querySelector("#selsout")',true);
        if (still) {
          log("info","Suppressing false logout"); isLoggedIn=true;
          const s2=productScraper.getReloadState?.()||{};
          if (s2.userWantedAutoRefresh && !s2.enabled && isNetworkOnline) {
            productScraper.enableAutoReload(s2.intervalMs||7000, ()=>watcher?.setReloading(true));
            log("start","Auto-refresh resumed after false logout");
          }
          productScraper.enable?.();
          broadcast(); return;
        }
      } catch {}
      if (autoLogin && !autoLogin.running && isNetworkOnline) autoLogin.start();
      broadcast();
    },
    onOffline: ()=>{
      if (isNetworkOnline!==false){
        isNetworkOnline=false; log("info","Network offline (watcher)");
        const st=productScraper.getReloadState?.()||{};
        if (st.enabled) productScraper.disableAutoReload("network offline");
        pauseScraper("network offline");
        broadcast();
      }
    },
    onOnline: ()=>{
      if (isNetworkOnline!==true){
        isNetworkOnline=true; log("info","Network online (watcher)");
        resumeScraperIfAllowed();
        oneShotReload(); broadcast();
      }
    },
    onError: (e)=>log("error",`Watcher error: ${e.message}`)
  });
  watcher.start();
}

const gotLock=app.requestSingleInstanceLock?.(); if(!gotLock) app.quit();
else app.on("second-instance", ()=>{ const w=winManager||winLeads; try{ w?.show(); w?.focus(); }catch{}; });



// === Screenshot helpers (JPEG buffers for Telegram photos) ===================
async function captureAsJpegBuffer(win, { rect = undefined, stayHidden = true, quality = 90 } = {}) {
  if (!win || win.isDestroyed?.()) throw new Error('Window not available');
  const nativeImg = await win.webContents.capturePage(rect, { stayHidden });
  return nativeImg.toJPEG(quality);
}
async function screenshotLeadsAsJpeg(opts = {}) {
  const w = ensureLeadsWindow();
  return captureAsJpegBuffer(w, { stayHidden: true, quality: 88, ...opts });
}
async function screenshotManagerAsJpeg(opts = {}) {
  const w = ensureManagerWindow();
  return captureAsJpegBuffer(w, { stayHidden: true, quality: 88, ...opts });
}
async function screenshotBothAsJpegs(opts = {}) {
  const [managerBuf, leadsBuf] = await Promise.all([
    screenshotManagerAsJpeg(opts),
    screenshotLeadsAsJpeg(opts),
  ]);
  return { managerBuf, leadsBuf };
}
// ============================================================================

app.whenReady().then(()=>{
  lockScreen = createLockScreen({
    getVisibleWindows: ()=> BrowserWindow.getAllWindows().filter(w=>!w.isDestroyed() && w.isVisible()),
    onLock: ()=>{ try{ clearPersist(); }catch{} },
    onUnlock: ()=>{ try{ persistUnlock("ui"); }catch{} }
  });

  createLeadsWindow();
  createManagerWindow();
  createTray();
  updateManagerLists({ products: loadProducts(), keywords: loadKeywords() }).catch(()=>{});

  if (START_LOCK && !isUnlockedPersisted()) lockScreen.lock(); // startup → show login

  mc = createMessageCentre({ log:(l,m)=>log(l,m), parent: winManager, send:(text,extra)=> tg?.send?.(text,extra) });
  wireStatusWatcher();

  const deps = {
    focusLeads: ()=>{ const w=ensureLeadsWindow(); if(w){w.show(); w.focus(); return true;} return false; },
    focusManager: ()=>{ const w=ensureManagerWindow(); if(w){w.show(); w.focus(); return true;} return false; },
    toggleMax: ()=>{ const w=ensureManagerWindow(); if(w){ w.isMaximized()?w.unmaximize():w.maximize(); } },
    reloadManager: ()=>{ try{ ensureManagerWindow()?.reload(); return true; } catch { return false; } },
    isLoggedIn: ()=> !!isLoggedIn,
    startAutoLogin: ()=> { if (!autoLogin) return false; autoLogin.start(); return true; },
    injectOtp: (code)=> !!autoLogin?.running && /^\d{4,8}$/.test((code||"").trim()) && (autoLogin.injectOtp(code), true),
    requestResend: ()=> !!autoLogin?.running && (autoLogin.requestResend(), true),
    quitApp: ()=> app.quit(),
    sendStatus: ()=> { try { sendStatusReport("manual"); return true; } catch { return false; } },

    enableAuto: (sec)=>{ const ms=Math.max(3000, Number(sec||7)*1000); if(!productScraper) return false; productScraper.enable?.(); productScraper.enableAutoReload(ms, ()=>watcher?.setReloading(true)); broadcast(); return true; },
    disableAuto: ()=>{ if(!productScraper) return false; productScraper.disableAutoReload("manual"); productScraper.disable?.(); broadcast(); return true; },

    addProduct, deleteProduct, addKeyword, deleteKeyword,
    listProducts: ()=> loadProducts(), listKeywords: ()=> loadKeywords(),

    screenshotLeads: async ()=>{
      try { const w=ensureLeadsWindow(); if(!w) return false; const buf=(await w.webContents.capturePage()).toPNG();
        const dir=path.join(REPORTS_DIR,"screens"); await fsp.mkdir(dir,{recursive:true});
        const file=path.join(dir,`Leads_${Date.now()}.png`); await fsp.writeFile(file,buf); await tg?.sendFile?.(file,`win1 ${fmtHMS()}`); return true;
      } catch { return false; }
    },
    screenshotManager: async ()=>{
      try { const w=ensureManagerWindow(); if(!w) return false; const buf=(await w.webContents.capturePage()).toPNG();
        const dir=path.join(REPORTS_DIR,"screens"); await fsp.mkdir(dir,{recursive:true});
        const file=path.join(dir,`Manager_${Date.now()}.png`); await fsp.writeFile(file,buf); await tg?.sendFile?.(file,`win2 ${fmtHMS()}`); return true;
      } catch { return false; }
    },

    // --- JPEG buffer helpers for Telegram photos ---
    screenshotLeadsAsJpeg: async (opts = {}) => { try { return await screenshotLeadsAsJpeg(opts); } catch { return null; } },
    screenshotManagerAsJpeg: async (opts = {}) => { try { return await screenshotManagerAsJpeg(opts); } catch { return null; } },
    screenshotBothAsJpegs: async (opts = {}) => { try { return await screenshotBothAsJpegs(opts); } catch { return null; } },


    restartApp: ()=>{ try{ tg?.send?.("🔄 🔄 Restarting…").catch(()=>{}); app.relaunch(); app.exit(0); return true; } catch { return false; } },
    cleanNow: ()=> { gentleMemoryCleanup("manual").catch(()=>{}); return true; },
    cleanAll: async ()=>{ try{ await archiveAndTruncate(CLEANUP_FILES,"manual");
      await resetReportsMemory(); await gentleMemoryCleanup("post-cleanall"); return true; } catch { return false; } },

    lockUI: ()=>{ lockScreen?.lockSilent?.(); return true; },
    unlockUI: ()=>{ lockScreen?.show?.(); return true; },

    lockAll: ()=>{ clearPersist(); lockScreen?.lockSilent?.(); return true; },
    unlockWithCreds: (args)=>{
      try{
        const raw = String(args ?? "").trim();
        if (!raw) return "Usage: /unlock userid,password";

        let user="", pass="";
        const csv = raw.match(/^\s*(?:"([^"]+)"|([^,\s]+))\s*,\s*(?:"([^"]+)"|(.+))\s*$/);
        if (csv) {
          user = (csv[1] ?? csv[2] ?? "").trim();
          pass = (csv[3] ?? csv[4] ?? "").trim();
        } else {
          const sp = raw.match(/^\s*(?:"([^"]+)"|(\S+))\s+(?:"([^"]+)"|(.+))\s*$/);
          if (sp) {
            user = (sp[1] ?? sp[2] ?? "").trim();
            pass = (sp[3] ?? sp[4] ?? "").trim();
          } else {
            const i = raw.indexOf(",") >= 0 ? raw.indexOf(",") : raw.indexOf(" ");
            if (i <= 0) return "Usage: /unlock userid,password";
            user = raw.slice(0, i).trim();
            pass = raw.slice(i + 1).trim();
          }
        }

        if (!user || !pass) return "Usage: /unlock userid,password";
        const ok = lockScreen?._validateAndUnlock?.({ user, pass });
        return ok ? "Unlocked ✅" : "Invalid credentials ❌";
      } catch {
        return "Unlock failed";
      }
    },

    unlockNoCreds: ()=>{ try{ lockScreen?.unlock?.(); persistUnlock("telegram"); return "Unlocked ✅"; } catch(e){ return "Unlock failed"; } },

    // === Daily Reports: manual trigger exposed to Telegram defaults ===========
    runReportsNow: async () => { try { await sendDailyReports("manual"); return true; } catch { return false; } }
    // =========================================================================
  };

  const baseCmds = buildDefaultCommands(deps);
  const extraCmds = {
    
manager:   async () => (deps.focusManager?.() ? "🗂️ Manager focused" : "Failed"),
leads:     async () => (deps.focusLeads?.() ? "👀 Leads focused" : "Failed"),
togglemax: async () => { try { deps.toggleMax?.(); return "🪄 Toggled"; } catch { return "Failed"; } },
lock: async () => { clearPersist(); deps.lockAll(); return "🔒 Locked — all windows hidden."; },
    unlock: async (_args) => deps.unlockNoCreds ? deps.unlockNoCreds() : "Unlock not available",
    
    // === File utility commands ===============================================
    // /requestfile <expected_name>  -> prompt user to upload a file (ForceReply UI)
    requestfile: async (_ignored, ctx) => {
      const expected = String((ctx?.args || "").trim());
      const hint = expected ? `named <b>${expected}</b>` : "with the desired filename";
      await ctx.send(
        `📤 Please attach the file ${hint} as a Telegram <b>Document</b> now.\nIt will be saved to <code>${__dirname}</code> and <b>replaced</b> if it already exists.`,
        { parse_mode: "HTML", reply_markup: { force_reply: true } }
      );
      // telegram.js will auto-save any incoming file to incomingFileSaveDir
      return; // we already sent a custom message
    },

    // /getfile <filename> -> send a file from app dir back to Telegram
    getfile: async (args) => {
      const fsp = require("node:fs/promises");
      const path = require("node:path");
      const name = String(args || "").trim();
      if (!name) return "Usage: /getfile <filename>";
      
      // Prevent path traversal by only allowing basenames
      const safeName = path.basename(name);
      if (!safeName || safeName === '.' || safeName === '..' || safeName !== name) {
        return "❌ Invalid filename (no paths allowed)";
      }
      
      const p = path.join(__dirname, safeName);
      // Ensure resolved path is still within __dirname
      const resolvedPath = path.resolve(p);
      if (!resolvedPath.startsWith(path.resolve(__dirname))) {
        return "❌ Access denied";
      }
      
      try {
        await fsp.access(p);
        await tg?.sendFile?.(p, `📦 ${safeName}`);
        return `📨 Sent: ${safeName}`;
      } catch {
        return `❌ Not found: ${safeName}`;
      }
    },

    // /fetch <url> [filename] -> download from Internet and save/replace
    fetch: async (args) => {
      try {
        const path = require("node:path");
        const urlish = String(args || "").trim();
        if (!urlish) return "Usage: /fetch <url> [filename]";
        const parts = urlish.split(/\s+/);
        const url = parts[0];
        const specifiedName = parts.slice(1).join(" ").trim();
        if (!/^https?:\/\//i.test(url)) return "Usage: /fetch <url> [filename]";
        
        // Validate URL is not localhost/private IP to prevent SSRF
        try {
          const urlObj = new URL(url);
          const hostname = urlObj.hostname.toLowerCase();
          if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || 
              hostname.startsWith('192.168.') || hostname.startsWith('10.') || hostname.startsWith('172.')) {
            return "❌ Cannot fetch from localhost or private networks";
          }
        } catch { return "❌ Invalid URL"; }
        
        const res = await fetch(url);
        if (!res.ok) return `❌ Download failed: ${res.status}`;
        const buf = new Uint8Array(await res.arrayBuffer());
        const fallback = (() => { try { return decodeURIComponent(new URL(url).pathname.split("/").pop() || "download.bin"); } catch { return "download.bin"; } })();
        const safeName = path.basename(specifiedName || fallback);
        if (!safeName || safeName === '.' || safeName === '..') return "❌ Invalid filename";
        const savePath = path.join(__dirname, safeName);
        const fsp = require("node:fs/promises");
        await fsp.mkdir(path.dirname(savePath), { recursive: true });
        await fsp.writeFile(savePath, buf); // overwrite
        await tg?.send?.(`✅ Saved <b>${safeName}</b> (${(buf.length/1024).toFixed(1)} KB)`, { parse_mode: "HTML" });
        return;
      } catch (e) {
        return "❌ " + (e?.message || e);
      }
    },
    // =========================================================================
// === Daily Reports: /runreports command ==================================
    runreports: async () => { await deps.runReportsNow(); return "📣 Daily reports triggered."; }
    // =========================================================================
  };
  const withAliases = (cmds) => {
    const out = { ...cmds };
    out["/lock"]   = cmds.lock;
    out["/unlock"] = cmds.unlock;
    out["Lock"]    = cmds.lock;
    out["Unlock"]  = cmds.unlock;
    out["LOCK"]    = cmds.lock;
    out["UNLOCK"]  = cmds.unlock;
    out["/runreports"] = cmds.runreports;
    out["RunReports"]  = cmds.runreports;
    
out["/manager"]   = cmds.manager;
out["/leads"]     = cmds.leads;
out["/togglemax"] = cmds.togglemax;
    out["/requestfile"] = cmds.requestfile;
    out["RequestFile"]  = cmds.requestfile;
    out["/getfile"]     = cmds.getfile;
    out["/fetch"]       = cmds.fetch;

return out;

  };
  let allCommands = { ...baseCmds, ...withAliases(extraCmds) };
  allCommands["unlock"]  = extraCmds.unlock;
  allCommands["/unlock"] = extraCmds.unlock;
  allCommands["lock"]    = extraCmds.lock;
  allCommands["/lock"]   = extraCmds.lock;

  tg = createTelegramClient({
    incomingFileSaveDir: __dirname,
    token:process.env.TELEGRAM_BOT_TOKEN, chatId:process.env.TELEGRAM_CHAT_ID,
    commands: allCommands,

    onUnknown: async ({ cmd, args, send, raw }) => {
      const text = String(raw || `/${cmd}${args ? " " + args : ""}`).trim();
      const norm = (s) => s.replace(/^\/+/, "").toLowerCase();

      if (norm(cmd) === "lock" || /^\/?lock\b/i.test(text)) {
        await send(await extraCmds.lock());
        return;
      }
      if (norm(cmd) === "unlock" || /^\/?unlock\b/i.test(text)) {
        let a = args;
        if (!a || !a.trim()) {
          const m = text.match(/^\s*\/?unlock\b\s*(.+)$/i);
          a = m ? m[1] : "";
        }
        await send(await extraCmds.unlock(a));
        return;
      }
      if (norm(cmd) === "runreports" || /^\/?runreports\b/i.test(text)) {
        await send(await extraCmds.runreports());
        return;
      }
      await send(`🤷 Unknown command: /${cmd}. Try /sync then /help`);
    },

    dropPendingOnStart:false,
    onCommand: ({ cmd, args }) => { log("start", `Telegram: /${cmd}${args ? " " + args : ""}`); },
    onCommandResult: ({ cmd, args, reply }) => { const s = String(reply || "").replace(/\s+/g, " ").slice(0, 300); log("info", `Telegram: /${cmd} → ${s}`); }
  });
  tg.start();

  sendStatusReport("startup").catch(()=>{});
  scheduleEvery30Min();
  gentleMemoryCleanup("startup").catch(()=>{});

  // === Daily Reports: start scheduler ========================================
  startDailyReportsScheduler();
  // ===========================================================================

  log("info","Niyati started"); broadcast();
});

app.on("before-quit", ()=>{ try{ watcher?.stop(); }catch{} try{ productScraper?.disableAutoReload?.("quit"); productScraper?.disable?.(); }catch{} try{ tg?.stop(); }catch{}; try{ clearInterval(dailyTimer); }catch{} });
app.on("window-all-closed", ()=>{ app.quit(); });

// === Daily Reports: IPC for manual trigger ===================================
ipcMain.handle("reports:run", async () => { try { await sendDailyReports("manual"); return { ok: true }; } catch { return { ok:false }; } });
// ============================================================================

ipcMain.handle("win:minimize",(e)=>BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.handle("win:maximize",(e)=>{ const w=BrowserWindow.fromWebContents(e.sender); if(!w) return; w.isMaximized()?w.unmaximize():w.maximize(); });
ipcMain.handle("win:close",(e)=>{ const w=BrowserWindow.fromWebContents(e.sender); if(!w) return; try{ w.removeAllListeners("close"); }catch{} try{ w.destroy(); }catch{} });
ipcMain.handle("leads:getState",()=>buildState());

ipcMain.handle("leads:start", (_e, ms) => {
  const startMs = Math.max(3000, Number(ms) || 7000);
  if (productScraper && typeof productScraper.enableAutoReload === "function") {
    productScraper.enableAutoReload(startMs, () => watcher?.setReloading(true));
    log("start", `Auto-refresh started @ ${Math.round(startMs/1000)}s`);
    pendingStartMs = null;
    broadcast();
    return { ok: true, queued: false };
  }
  // Leads window / productScraper not ready yet — queue it
  pendingStartMs = startMs;
  log("info", `Auto-refresh start queued @ ${Math.round(startMs/1000)}s (Leads not ready)`);
  broadcast();
  return { ok: true, queued: true };
});
ipcMain.handle("leads:stop", ()=>{ productScraper?.disableAutoReload("ui stop"); productScraper?.disable?.(); broadcast(); return {ok:true}; });

ipcMain.handle("lockscreen:tryUnlock", (_e, body) => lockScreen?._validateAndUnlock(body) ?? false);
ipcMain.handle("lockscreen:lock",   () => { try { lockScreen?.lockSilent?.(); return true; } catch { return false; } });
ipcMain.handle("lockscreen:unlock", () => { try { lockScreen?.show?.(); return true; } catch { return false; } });

// Removed duplicate handler - keeping only the improved version below at line 1014


ipcMain.handle("mc:manual", async () => {
  try {
    await mc?.enqueue?.({ reason: "manual" });   // run Message Centre
  } catch (e) {
    log("error", "MC enqueue (manual) failed: " + (e?.message || e));
  }
  try {
    await safeReloadLeads("manual");             // instant refresh
  } catch (e) {
    log("error", "manual refresh failed: " + (e?.message || e));
  }
  return { ok: true };
});

try {
  const { ipcMain, net } = require("electron");
  const PROBE_URLS = [
  "https://seller.indiamart.com/favicon.ico",
  "https://www.gstatic.com/generate_204"
];
async function probeOne(url, timeoutMs = 4000) {
  return await new Promise((resolve) => {
    try {
      const req = net.request({ method: "HEAD", url });
      const t = setTimeout(() => { try { req.abort(); } catch {} resolve(false); }, timeoutMs);
      req.on("response", (res) => { clearTimeout(t); resolve(res.statusCode >= 200 && res.statusCode < 500); });
      req.on("error", () => { clearTimeout(t); resolve(false); });
      req.end();
    } catch { resolve(false); }
  });
}
async function probeOnline() {
  for (const u of PROBE_URLS) { if (await probeOne(u)) return true; }
  return false;
}
  try { ipcMain.removeAllListeners("net:status"); } catch {}

  ipcMain.on("net:status", async (_e, online) => {
    try {
      if (!online) {
        if (typeof isNetworkOnline === "undefined" || isNetworkOnline !== false) {
          isNetworkOnline = false;
          try { productScraper?.disableAutoReload?.("renderer offline"); } catch {}
          try { pauseScraper?.("renderer offline"); } catch {}
          log("info", "Renderer reports offline → set offline");
          try { broadcast?.(); } catch {}
        }
        return;
      }

      const ok = await probeOnline();
      if (ok) {
        if (typeof isNetworkOnline === "undefined" || isNetworkOnline !== true) {
          isNetworkOnline = true;
          log("info", "Renderer reports online (verified) → resume if allowed");
    if (!productScraper) pendingResume = true;
          try { resumeScraperIfAllowed?.(); } catch {}
          try { broadcast?.(); } catch {}
        }
      } else {
        if (typeof isNetworkOnline === "undefined" || isNetworkOnline !== false) {
          isNetworkOnline = false;
          try { productScraper?.disableAutoReload?.("probe failed"); } catch {}
          try { pauseScraper?.("probe failed"); } catch {}
          log("info", "Renderer reports online but probe failed → keep offline");
          try { broadcast?.(); } catch {}
        }
      }
    } catch (e) {
      log("error", `net:status handler error: ${e?.message || e}`);
    }
  });
} catch {}

// === Daily Reports: scheduler loop ===========================================
function startDailyReportsScheduler() {
  try { clearInterval(dailyTimer); } catch {}
  const state = _loadDailyState();
  const slots = DAILY_REPORT_TIMES.length ? DAILY_REPORT_TIMES : (SCHED.times || []).map(t => t.label).filter(Boolean);
  const tickMs = 30_000;

  const loop = async () => {
    const day = _todayKey(DAILY_TZ);
    for (const slot of slots) {
      if (_shouldRunSlot(state, day, slot, DAILY_CATCHUP_MINS)) {
        try {
          log("start", `Daily: running slot ${slot} (${DAILY_TZ})`);
          await sendDailyReports(slot);
          log("info", `Daily: done ${slot}`);
        } catch (e) {
          log("error", `Daily: slot ${slot} failed — ${e?.message || e}`);
        } finally {
          _markDailyRun(state, day, slot);
        }
      }
    }
  };

  loop(); // catch-up on boot
  dailyTimer = setInterval(loop, tickMs);
  log("info", `Daily: scheduler started @${DAILY_TZ} slots=[${slots.join(", ")}], catchUp=${DAILY_CATCHUP_MINS}m`);
}
// ============================================================================


// --- Injected by Patch: resetReportsMemory ---
async function resetReportsMemory(){
  try { if (globalThis.mc && typeof globalThis.mc.resetLogs === 'function') await globalThis.mc.resetLogs(); } catch(e){}
  try { if (globalThis.km && typeof globalThis.km.resetLogs === 'function') await globalThis.km.resetLogs(); } catch(e){}
  try { if (globalThis.productScraper && typeof globalThis.productScraper.clearProductLog === 'function') await globalThis.productScraper.clearProductLog(); } catch(e){}
  try { if (globalThis.matchClicker && typeof globalThis.matchClicker.clearMatchLog === 'function') await globalThis.matchClicker.clearMatchLog(); } catch(e){}
  // Fallback: clear require cache for modules if no reset available
  try {
    const toClear = ['messagecentre.js','keywordmatcher.js','productScraper.js','matchclicker.js'];
    const path = require('path');
    Object.keys(require.cache).forEach(k => {
      try { if (toClear.some(n => k.endsWith(path.sep + n))) delete require.cache[k]; } catch{}
    });
  } catch(e){}
}
// --- end injected ---

