
// productScraper.js — updated e2e (dedupe fixed, atomic writes, load-time compaction)
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

function createProductScraper({
  win,
  log = () => {},
  delayMs = 3000,
  maxItems = 50,
  loginSelector = "#selsout",
  onItems = null,
}) {
  if (!win || win.isDestroyed()) throw new Error("productScraper: invalid window");

  // ---- Paths & files ----
  const DIR_APP = __dirname;
  const DIR_USER = path.join(app.getPath("userData"), "Niyati");
  const DIR_LOG = path.join(DIR_APP, "Reports");
  const F_STATE = path.join(DIR_USER, "refresh_state.json");

  const LIST_DIR = path.join(DIR_APP, "List");
  const F_PRODUCTS = path.join(LIST_DIR, "products.json");
  const F_KEYWORDS = path.join(LIST_DIR, "keywords.json");

  const F_LOG_JSON = path.join(DIR_LOG, "products_log.json");
  try { fs.mkdirSync(DIR_LOG, { recursive: true }); } catch {}
  try { fs.mkdirSync(LIST_DIR, { recursive: true }); } catch {}

  // ---- Constants ----
  const URL_DEFAULT = "https://seller.indiamart.com/bltxn/?pref=recent";
  const MIN_MS = 3000, DEF_MS = 7000, RETRY_MS = 1000, BLANKS_BREAK = 5;

  // ---- Helpers ----
  const now = () => Date.now();
  const ts = () => new Date().toISOString();
  const safe = (fn, fb) => { try { return fn(); } catch { return fb; } };
  const exec = (code) => win.webContents.executeJavaScript(code, true);
  const ensureDir = (p) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {} };

  // unified normalization (commas/pipes -> space, collapse whitespace, lowercase)
  const normStr = (s) => String(s || "")
    .toLowerCase()
    .replace(/[,|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const makeKey = (title, location) => `${normStr(title)}|${normStr(location) || "-"}`;

  // atomic JSON write
  const writeJSON = (file, data) => {
    try {
      ensureDir(file);
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, file);
    } catch (e) {
      log("error", `json write failed (${path.basename(file)}): ${e.message}`);
    }
  };
  const readJSON = (file, fb) => safe(() => JSON.parse(fs.readFileSync(file, "utf8")), fb);

  // ---- Refresh state ----
  let refresh = readJSON(F_STATE, {
    enabled: false, intervalMs: DEF_MS, userWantedAutoRefresh: false,
    lastStartAt: 0, lastStopAt: 0, lastCycleAt: 0, cycles: 0,
  });
  const persistState = () => writeJSON(F_STATE, refresh);

  let tReload = null;
  function enableAutoReload(ms = refresh.intervalMs, beforeReload = () => {}) {
    disableAutoReload();
    refresh.intervalMs = Math.max(MIN_MS, Number(ms) || DEF_MS);
    refresh.userWantedAutoRefresh = true;
    refresh.enabled = true;
    refresh.lastStartAt = now();
    persistState();
    tReload = setInterval(() => {
      try { beforeReload(); } catch (e) { log("error", "beforeReload error: " + (e?.message || e)); }
      try {
        if (!win || win.isDestroyed()) { log("error", "refresh skipped: Leads window invalid"); return; }
        win.webContents.reloadIgnoringCache();
        log("refresh", `Leads refreshed (${Math.round(refresh.intervalMs/1000)}s)`);
      } catch (e) { log("error", "reloadIgnoringCache failed: " + (e?.message || e)); }
    }, refresh.intervalMs);
    log("start", `Auto-refresh started @ ${Math.round(refresh.intervalMs/1000)}s`);
  }
  function disableAutoReload(reason) {
    if (tReload) clearInterval(tReload);
    tReload = null;
    if (refresh.enabled) { refresh.enabled = false; refresh.lastStopAt = now(); persistState(); }
    log("stop", `Auto-refresh stopped${reason ? ` — ${reason}` : ""}`);
  }
  const getReloadState = () => ({ ...refresh });

  // ---- Product list (Set) ----
  let productSet = new Set();
  safe(() => {
    if (fs.existsSync(F_PRODUCTS)) {
      const arr = readJSON(F_PRODUCTS, []);
      if (Array.isArray(arr)) productSet = new Set(arr.map(normStr));
      return;
    }
    const legacyTxt = path.join(DIR_APP, "products.txt");
    if (fs.existsSync(legacyTxt)) {
      const txt = fs.readFileSync(legacyTxt, "utf8");
      const arr = (txt || "").split(",").map(s => s.trim()).filter(Boolean);
      writeJSON(F_PRODUCTS, arr);
      productSet = new Set(arr.map(normStr));
      log("info", "migrated products.txt -> List/products.json");
    }
  });
  const getProducts = () => Array.from(productSet);
  const writeListJSON = (file, items = []) => { ensureDir(file); writeJSON(file, Array.isArray(items) ? items : []); log("info", `${path.basename(file)} updated (${(items||[]).length} items)`); };
  function setProducts(items = []) {
    try {
      writeListJSON(F_PRODUCTS, Array.isArray(items) ? items : []);
      productSet = new Set((items || []).map(normStr));
      log("info", `products.json updated (${productSet.size}) [setProducts]`);
      return true;
    } catch (e) { log("error", "setProducts failed: " + e.message); return false; }
  }
  function wireListsIPC(ipcMain) {
    ipcMain.handle("lists:saveProducts", (_e, items = []) => { safe(() => { writeListJSON(F_PRODUCTS, items); productSet = new Set((items || []).map(normStr)); }); return { ok: true }; });
    ipcMain.handle("lists:saveKeywords", (_e, items = []) => { try { writeListJSON(F_KEYWORDS, items); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
  }

  // ---- Keywords migrate (legacy -> json) ----
  safe(() => {
    if (!fs.existsSync(F_KEYWORDS)) {
      const legacy = path.join(DIR_APP, "keywords.txt");
      if (fs.existsSync(legacy)) {
        const txt = fs.readFileSync(legacy, "utf8");
        const arr = (txt||"").split(/[, \n]+/).map(s=>s.trim().toLowerCase()).filter(Boolean);
        writeJSON(F_KEYWORDS, arr);
        log("info","migrated keywords.txt -> List/keywords.json");
      }
    }
  });

  // ---- Location compose ----
  const composeLoc = (it) => {
    const city = String(it.city || "").trim();
    const state = String(it.state || "").trim();
    const fb = String(it.location || "").trim();
    return (city || state) ? [city, state].filter(Boolean).join(", ") : (fb || "");
  };

  // ---- Log + dedupe state ----
  let keys = new Set(), serial = 1, rows = [];
  safe(() => {
    if (!fs.existsSync(F_LOG_JSON)) return;
    const data = readJSON(F_LOG_JSON, []);
    if (!Array.isArray(data)) return;

    // Deduplicate on load (keep earliest per key)
    const parseTs = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : Infinity; };
    data.sort((a,b) => parseTs(a?.timestamp) - parseTs(b?.timestamp));
    const seen = new Set();
    const dedupRows = [];
    for (const r of data) {
      const k = makeKey(r?.name, r?.location);
      if (seen.has(k)) continue;
      seen.add(k);
      dedupRows.push(r);
    }
    rows = dedupRows;
    for (const r of rows) {
      keys.add(makeKey(r?.name, r?.location));
      const s = parseInt(r?.serial, 10);
      if (!Number.isNaN(s)) serial = Math.max(serial, s + 1);
    }
    // persist if compaction changed length
    if (rows.length !== data.length) { writeJSON(F_LOG_JSON, rows); }
  });

  const persistJSON = () => writeJSON(F_LOG_JSON, rows);

  function recordIfNew(title, location) {
    const key = makeKey(title, location);
    if (keys.has(key)) return false;
    rows.unshift({ serial, timestamp: ts(), name: title, location });
    persistJSON();
    keys.add(key);
    log("info", `persist: + "${title}"${location ? ` [${location}]` : ""}`);
    serial += 1;
    return true;
  }

  // ---- Scheduler state ----
  let active = false, scheduled = null, cycleId = 0, paused = false;
  const clearScheduled = () => { if (scheduled) { clearTimeout(scheduled); scheduled = null; } };
  const bumpCycle = () => { cycleId += 1; refresh.cycles = (refresh.cycles|0) + 1; refresh.lastCycleAt = now(); persistState(); return cycleId; };

  // ---- Scraper ----
  async function scrapeOnce(currentCycleId) {
    try {
      if (paused) { log("info","scrape: paused – skip"); return { ran:false }; }
      if (!win || win.isDestroyed()) return { ran: false };

      const js = `(function(max, loginSel){
        if (document.readyState !== 'interactive' && document.readyState !== 'complete')
          return { ready:false, items:[] };
        const loggedIn = !!document.querySelector(loginSel);
        if (!loggedIn) return { ready:true, loggedIn:false, items:[] };

        const txt = n => (n ? (n.textContent||"").trim() : "");
        const qs = sel => { try { const n = document.querySelector(sel); return txt(n); } catch { return ""; } };
        const xpS = xp => { try { return String(document.evaluate(xp, document, null, XPathResult.STRING_TYPE, null).stringValue||"").trim(); } catch { return ""; } };
        const firstNodeTxt = xp => { try { const n = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; return txt(n); } catch { return ""; } };

        const titleCss = i => qs('#list'+i+' div.lstNwLft > div.lstNwLftImg.lstNwDflx.lstNwPr > div > h2') || qs('#list'+i+' h2');
        const titleXp  = i => firstNodeTxt('//*[@id="list'+i+'"]//h2');
        const cityXp   = i => '//*[@id="list'+i+'"]/div[1]/div[1]/div[2]/div/div[1]/div[2]/strong/p/span[1]/text()';
        const stateXp  = i => '//*[@id="list'+i+'"]/div[1]/div[1]/div[2]/div/div[1]/div[2]/strong/p/span[2]/text()';
        const fbXp     = i => '//*[@id="list'+i+'"]/div[1]/div[1]/div[2]/div/div[1]/div[2]/strong/p/span/span/text()';

        const items = [];
        let blanks = 0;
        for (let i=1; i<=max; i++){
          const title = titleCss(i) || titleXp(i);
          if (title) {
            const city = xpS(cityXp(i)), state = xpS(stateXp(i));
            const location = (city || state) ? "" : xpS(fbXp(i));
            items.push({ index:i, title, city: city||"", state: state||"", location: location||"" });
            blanks = 0;
          } else if (++blanks >= ${BLANKS_BREAK} && items.length) break;
        }
        return { ready:true, loggedIn:true, items };
      })(${Number(maxItems)}, ${JSON.stringify(loginSelector)})`;

      const res = await exec(js);
      if (!res || res.ready === false) { log("info", "scrape: not ready (will retry)"); return { ran: false, retry: true }; }
      if (res.loggedIn === false)      { log("info", "scrape: not logged in"); onItems && safe(() => onItems([], currentCycleId)); return { ran: true }; }

      const items = Array.isArray(res.items) ? res.items : [];
      if (!items.length) log("info", "scrape: no products found");
      else {
        for (const it of items) {
          const loc = composeLoc(it);
          log("scrape", `#list${it.index}: ${it.title}${loc ? ` [${loc}]` : ""}`);
          if (it.title) recordIfNew(it.title, loc);
        }
        log("info", `scrape: ${items.length} product(s)`);
      }
      onItems && safe(() => onItems(items, currentCycleId));
      return { ran: true };
    } catch (e) {
      log("error", `scrape error: ${e.message}`);
      return { ran: false };
    }
  }

  const onDidFinishLoad = () => { if (active && refresh.enabled && !paused) scheduleAfterDelay(bumpCycle()); };
  function scheduleAfterDelay(cId) {
    clearScheduled();
    const wait = Math.max(0, Number(delayMs) || DEF_MS);
    scheduled = setTimeout(async () => {
      scheduled = null;
      if (!active || !refresh.enabled || paused) return;
      const r = await scrapeOnce(cId);
      if (active && refresh.enabled && r && r.retry) {
        scheduled = setTimeout(async () => {
          scheduled = null;
          if (active && refresh.enabled && !paused) await scrapeOnce(cId);
        }, RETRY_MS);
      }
    }, wait);
  }

  function enable() {
    if (active) return;
    active = true;
    safe(() => win.webContents.on("did-finish-load", onDidFinishLoad));
    const isLoading = safe(() => (typeof win.webContents.isLoadingMainFrame === "function")
      ? win.webContents.isLoadingMainFrame()
      : win.webContents.isLoading(), false);
    if (refresh.enabled && !isLoading && !paused) scheduleAfterDelay(bumpCycle());
    log("info", "scrape: enabled");
  }
  function disable() {
    if (!active) return;
    active = false;
    clearScheduled();
    safe(() => win.webContents.removeListener("did-finish-load", onDidFinishLoad));
    log("info", "scrape: disabled");
  }
  async function navigateToDefault({ hard = false } = {}) {
    if (!win || win.isDestroyed()) return;
    try {
      const href = await exec("location.href");
      const onDefault = typeof href === "string" && href.startsWith(URL_DEFAULT);
      if (hard || !onDefault) win.loadURL(URL_DEFAULT);
      else win.webContents.reloadIgnoringCache();
    } catch { win.loadURL(URL_DEFAULT); }
  }

  return {
    enable, disable, scrapeOnce,
    enableAutoReload, disableAutoReload, getReloadState,
    wireListsIPC, getProducts, setProducts, navigateToDefault,
    setPaused(flag = true) {
      paused = !!flag;
      if (paused) { clearScheduled(); }
      else if (active && refresh.enabled) { scheduleAfterDelay(bumpCycle()); }
    },
    isPaused() { return !!paused; }
  };
}


// --- Injected reset function ---
function clearProductLog(){
  try { rows = Array.isArray(rows) ? [] : []; } catch(e){}
  try { products = Array.isArray(products) ? [] : []; } catch(e){}
  try { items = Array.isArray(items) ? [] : []; } catch(e){}
  try { if (typeof writeJson === 'function') writeJson(); } catch(e){}
  try { if (typeof flush === 'function') flush(); } catch(e){}
  try { if (typeof persistJSON === 'function') persistJSON(); } catch(e){}  const fs = require('fs');
  const path = require('path');
  try { fs.writeFileSync(path.resolve(__dirname, 'Reports/products_log.json'), '[]', 'utf8'); } catch(e){}
  try { fs.writeFileSync(path.resolve(__dirname, './Reports/products_log.json'), '[]', 'utf8'); } catch(e){}

}
// --- end injected ---

module.exports = { createProductScraper };
