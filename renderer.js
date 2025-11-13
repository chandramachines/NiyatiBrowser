// ================================================================
// Niyati Browser - FIXED Renderer.js
// Version: 3.0.0 - ALL SECURITY ISSUES FIXED
// Last Updated: 2025-01-06
// FIXED: XSS vulnerability, localStorage quota, batch race conditions
// ================================================================

const CONST = Object.freeze({
  LS_REFRESH:  "niyati:leadsRefresh",
  LS_PRODUCTS: "niyati:products",
  LS_KEYWORDS: "niyati:keywords",
  LOG_CARD_LIMIT: 300,
  BATCH_SIZE_LIMIT: 500,
  MIN_SEC: 3,
  MAX_SEC: 3600,
  DEFAULT_SEC: 7
});

const $ = (s, r=document)=>r.querySelector(s);
const on = (el, ev, fn, opts)=> el.addEventListener(ev, fn, opts);

// ✅ FIX #5: SECURE HTML ESCAPING - No more XSS
const escapeHtml = (str) => {
  const div = document.createElement('div');
  div.textContent = String(str || '');
  return div.innerHTML;
};

// ✅ FIX #5: SAFE HTML BUILDER - Whitelist approach
const h = (tag, cls, content) => { 
  const n = document.createElement(tag); 
  if (cls) n.className = cls;
  
  if (content != null) {
    // ✅ Always use textContent by default (safe)
    n.textContent = String(content);
  }
  
  return n; 
};

// ✅ NEW: Safe HTML setter for specific trusted content
const setTrustedHTML = (element, htmlString) => {
  // Only allow specific safe patterns
  const safePatterns = [
    /<b class="h-title">/g,
    /<\/b>/g,
    /<span class="(?:emo|txt|time|module)">/g,
    /<\/span>/g
  ];
  
  let safe = String(htmlString);
  
  // First escape everything
  const temp = document.createElement('div');
  temp.textContent = safe;
  safe = temp.innerHTML;
  
  // Then only restore whitelisted patterns
  safe = safe
    .replace(/&lt;b class="h-title"&gt;/g, '<b class="h-title">')
    .replace(/&lt;\/b&gt;/g, '</b>')
    .replace(/&lt;span class="(emo|txt|time|module)"&gt;/g, '<span class="$1">')
    .replace(/&lt;\/span&gt;/g, '</span>');
  
  element.innerHTML = safe;
};

const pad2 = n=> String(n).padStart(2,"0");
const fmtTime = (t=Date.now())=>{ const d=new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };

// ✅ FIX #18: LOCALSTORAGE QUOTA HANDLING
const jsonGet = (k, fb=null)=>{ 
  try{ 
    const val=JSON.parse(localStorage.getItem(k)||"null"); 
    return val!==null?val:fb; 
  }catch{ return fb; } 
};

const MAX_STORAGE_ITEMS = 100;
const MAX_STORAGE_SIZE = 1000000; // 1MB

const jsonSet = (k, v)=> {
  try {
    // ✅ Truncate arrays
    if (Array.isArray(v) && v.length > MAX_STORAGE_ITEMS) {
      console.warn(`${k} truncated from ${v.length} to ${MAX_STORAGE_ITEMS}`);
      v = v.slice(0, MAX_STORAGE_ITEMS);
    }
    
    const serialized = JSON.stringify(v);
    
    // ✅ Check size
    if (serialized.length > MAX_STORAGE_SIZE) {
      console.error(`${k} too large (${serialized.length} bytes)`);
      return false;
    }
    
    localStorage.setItem(k, serialized);
    return true;
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      console.error("LocalStorage quota exceeded");
      try {
        // Clear refresh state and retry
        localStorage.removeItem(CONST.LS_REFRESH);
        localStorage.setItem(k, JSON.stringify(v));
        return true;
      } catch {
        console.error("Still can't store after clearing");
        return false;
      }
    }
    console.error(`jsonSet error: ${e.message}`);
    return false;
  }
};

// ================================================================
// DOM Elements
// ================================================================

const BTN_MIN=$("#min"), BTN_MAX=$("#max"), BTN_CLOSE=$("#close"), MAX_ICON=$("#maxIcon");
const NET_CHIP=$("#netStatus"), NET_LABEL=$(".label", NET_CHIP);
const REF_FORM=$("#refreshForm"), REF_SEC=$("#refreshSec"), BTN_START=$("#refreshStart"), BTN_STOP=$("#refreshStop");
const PROD_FORM=$("#prodForm"), PROD_INPUT=$("#prodInput"), PROD_LIST=$("#prodList"), PROD_COUNT=$("#prodCount");
const KEY_FORM=$("#keyForm"), KEY_INPUT=$("#keyInput"), KEY_INLINE=$("#keyInline"), KEY_COUNT=$("#keyCount");
const BTN_PROD_COL=$("#prodCollapse"), CARD_PRODUCTS=$("#productsCard");
const BTN_KEY_COL=$("#keyCollapse"), CARD_KEYWORDS=$("#keywordsCard");
const LOG_LIST=$("#logList"), LOG_COUNT=$("#logCount");
const BTN_MANUAL=$("#manualMC");

// ================================================================
// Window Controls
// ================================================================

on(BTN_MIN, "click", ()=> window.NiyatiWindow.minimize());
on(BTN_CLOSE, "click", ()=> window.NiyatiWindow.close());
on(BTN_MAX, "click", ()=> window.NiyatiWindow.maximize());

const offWin = window.NiyatiWindow.onState((state)=>{
  const isMax = state === "max";
  BTN_MAX.dataset.state = isMax ? "max" : "restored";
  BTN_MAX.setAttribute("aria-label", isMax ? "Restore" : "Maximize");
  BTN_MAX.title = isMax ? "Restore" : "Maximize";
  MAX_ICON.innerHTML = isMax
    ? `<path d="M8 9.5h7.5v7.5H8z" fill="none" stroke="currentColor" stroke-width="2"></path><path d="M8.5 8.5h7v1" stroke="currentColor" stroke-width="2"></path>`
    : `<rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"></rect>`;
});

// ================================================================
// Network Status
// ================================================================

function setNetState(online){
  NET_CHIP.classList.toggle("online", !!online);
  NET_CHIP.classList.toggle("offline", !online);
  NET_LABEL.textContent = online ? "Online" : "Offline";
  window.NetBridge?.report?.(!!online);
}
setNetState(false);
on(window, "online",  ()=> window.NetBridge?.report?.(true));
on(window, "offline", ()=> window.NetBridge?.report?.(false));

// ================================================================
// Refresh Controls
// ================================================================

const setRunningUI = (running)=>{ BTN_START.disabled=running; REF_SEC.disabled=running; BTN_STOP.disabled=!running; };

let tCountdown=null;
function startCountdown(sec){
  stopCountdown();
  let left=sec;
  BTN_START.textContent=`Next: ${pad2(left)}s`;
  tCountdown=setInterval(()=>{ left = left<=1? sec : left-1; BTN_START.textContent=`Next: ${pad2(left)}s`; }, 1000);
}
function stopCountdown(){ if(tCountdown){ clearInterval(tCountdown); tCountdown=null; } BTN_START.textContent="Start"; }

function applyRefreshState(s){
  try { setNetState(!!s.isNetworkOnline); } catch {};
  if (s.intervalMs) {
    const val = Math.round(s.intervalMs/1000);
    if (+REF_SEC.value !== val) REF_SEC.value = val;
  }
  if (s.enabled) {
    setRunningUI(true);
    startCountdown(Math.round((s.intervalMs||7000)/1000));
    BTN_START.title="Auto-refresh is active";
  } else {
    setRunningUI(false);
    stopCountdown();
    if (!s.isNetworkOnline) { BTN_START.textContent="Paused (offline)"; BTN_START.title="Network offline"; }
    else if (s.suspendedByAuth || s.isLoggedIn===false) { BTN_START.textContent="Paused (login)"; BTN_START.title="Login required"; }
    else { BTN_START.textContent="Start"; BTN_START.title="Start auto-refresh"; }
  }
}
const offRefresh = window.LeadsRefresh.onState(applyRefreshState);

on(REF_FORM, "submit", async (e)=>{
  e.preventDefault();
  const sec = Math.max(CONST.MIN_SEC, Math.min(CONST.MAX_SEC, Number(REF_SEC.value)||CONST.DEFAULT_SEC));
  REF_SEC.value = sec;
  const ms = sec * 1000;
  jsonSet(CONST.LS_REFRESH, { enabled:true, intervalMs:ms });
  try {
    await window.LeadsRefresh.start(ms);
    applyRefreshState(await window.LeadsRefresh.getState());
  } catch (e) {
    console.error("Failed to start refresh:", e);
  }
});

on(BTN_STOP, "click", async ()=>{
  try {
    await window.LeadsRefresh.stop();
    jsonSet(CONST.LS_REFRESH, { ...(jsonGet(CONST.LS_REFRESH, {})), enabled:false });
    applyRefreshState(await window.LeadsRefresh.getState());
  } catch (e) {
    console.error("Failed to stop refresh:", e);
  }
});

(async ()=>{
  window.NetBridge?.report?.(navigator.onLine);
  const pref = jsonGet(CONST.LS_REFRESH);
  if (pref?.enabled) {
    const ms = Math.max(3000, Number(pref.intervalMs)||7000);
    REF_SEC.value = Math.round(ms/1000);
    try {
      await window.LeadsRefresh.start(ms);
    } catch (e) {
      console.error("Failed to auto-start refresh:", e);
    }
  } else REF_SEC.value = CONST.DEFAULT_SEC;
  applyRefreshState(await window.LeadsRefresh.getState());
})();

// ================================================================
// Products & Keywords Management
// ================================================================

const normSpace = s=> String(s||"").trim().replace(/\s+/g," ");
const toTitle = s=> normSpace(s).toLowerCase().split(" ").map(w=> w? (w[0].toUpperCase()+w.slice(1)):"").join(" ");
const uniqPush = (arr, val, key=(x)=>x.toLowerCase())=>{ if(!val) return; const k=key(val); if(!arr.some(v=>key(v)===k)) arr.push(val); };

const persist = async (type, arr)=>{
  const storageKey = type==="products"? CONST.LS_PRODUCTS : CONST.LS_KEYWORDS;
  jsonSet(storageKey, arr);
  try { 
    if (type==="products") {
      await window.Lists.saveProducts(arr);
    } else {
      await window.Lists.saveKeywords(arr);
    }
  } catch (e) {
    console.error(`Failed to persist ${type}:`, e);
  }
};

let products = jsonGet(CONST.LS_PRODUCTS, []);
let keywords = jsonGet(CONST.LS_KEYWORDS, []);

function renderProducts(arr){
  PROD_LIST.innerHTML="";
  const frag=document.createDocumentFragment();
  arr.forEach((item, idx)=>{
    const li = h("li","pill");
    
    const left = h("div", "left");
    const serial = h("span", "serial", String(idx+1));
    const title = h("span", "title", item);
    left.appendChild(serial);
    left.appendChild(title);
    
    const btn = h("button", "del");
    btn.textContent = "Delete";
    btn.dataset.index = String(idx);
    btn.setAttribute("aria-label", "Delete");
    
    li.appendChild(left);
    li.appendChild(btn);
    frag.appendChild(li);
  });
  PROD_LIST.append(frag); 
  PROD_COUNT.textContent = arr.length;
}

function renderKeywords(arr){
  KEY_INLINE.innerHTML="";
  const frag=document.createDocumentFragment();
  arr.forEach((kw, idx)=>{
    const span = h("span","kw");
    const text = h("span","", kw);
    const btn = h("button","rm");
    btn.textContent="×";
    btn.dataset.index=String(idx);
    btn.setAttribute("aria-label",`Remove ${kw}`);
    span.appendChild(text);
    span.appendChild(btn);
    frag.appendChild(span);
  });
  KEY_INLINE.append(frag); 
  KEY_COUNT.textContent = arr.length;
}

on(PROD_FORM, "submit", async (e)=>{
  e.preventDefault();
  const raw = PROD_INPUT.value.trim();
  if (!raw) return;
  const items = raw.split(",").map(toTitle).filter(Boolean);
  for (const it of items) uniqPush(products, it);
  renderProducts(products);
  await persist("products", products);
  PROD_INPUT.value=""; PROD_INPUT.focus();
});

on(PROD_LIST, "click", async (e)=>{
  if (e.target.matches(".del")) {
    const idx = Number(e.target.dataset.index);
    if (!isNaN(idx)) {
      products.splice(idx, 1);
      renderProducts(products);
      await persist("products", products);
    }
  }
});

on(KEY_FORM, "submit", async (e)=>{
  e.preventDefault();
  const raw = KEY_INPUT.value.trim();
  if (!raw) return;
  const items = raw.split(",").map(normSpace).filter(Boolean);
  for (const it of items) uniqPush(keywords, it);
  renderKeywords(keywords);
  await persist("keywords", keywords);
  KEY_INPUT.value=""; KEY_INPUT.focus();
});

on(KEY_INLINE, "click", async (e)=>{
  if (e.target.matches(".rm")) {
    const idx = Number(e.target.dataset.index);
    if (!isNaN(idx)) {
      keywords.splice(idx, 1);
      renderKeywords(keywords);
      await persist("keywords", keywords);
    }
  }
});

on(BTN_PROD_COL,"click",()=>CARD_PRODUCTS.classList.toggle("is-collapsed"));
on(BTN_KEY_COL,"click",()=>CARD_KEYWORDS.classList.toggle("is-collapsed"));

renderProducts(products);
renderKeywords(keywords);
// ✅ ADD THIS BLOCK HERE:
window.RendererLists = Object.freeze({
  refresh: () => {
    try {
      products = jsonGet(CONST.LS_PRODUCTS, []);
      keywords = jsonGet(CONST.LS_KEYWORDS, []);
      renderProducts(products);
      renderKeywords(keywords);
      console.log(`✅ Lists refreshed: ${products.length} products, ${keywords.length} keywords`);
      return true;
    } catch (e) {
      console.error('RendererLists.refresh error:', e);
      return false;
    }
  }
});

// ================================================================
// Log System
// ================================================================

const LOG_CATEGORIES = {
  auth: { emoji:"🔐", module:"Auth" }, start: { emoji:"▶️", module:"Start" }, stop: { emoji:"⏹️", module:"Stop" },
  refresh: { emoji:"🔄", module:"Refresh" }, scrape: { emoji:"🔍", module:"Scrape" },
  telegram: { emoji:"✈️", module:"Telegram" }, error: { emoji:"❌", module:"Error" },
  info: { emoji:"ℹ️", module:"Info" }, warning: { emoji:"⚠️", module:"Warning" },
  debug: { emoji:"🐛", module:"Debug" }
};

function classify(msg){
  const lc = String(msg).toLowerCase();
  
  if (/keyword matched|keywordmatch/i.test(msg)) return { emoji:"✨", module:"Keyword", msg };
  if (/^mc:/i.test(msg) || /messagecentre|block#/i.test(msg)) return { emoji:"📨", module:"MessageCentre", msg };
  
  for (const [key, cat] of Object.entries(LOG_CATEGORIES)) {
    if (lc.includes(key) || lc.startsWith(key+":")) return { ...cat, msg };
  }
  
  return { emoji:"📋", module:"General", msg };
}

const LogFns = (() => {
  const onlyDataMC = (html) => {
    const s = String(html||"").replace(/<\/?b[^>]*>/gi,"").replace(/^MC:\s*/i,"").trim();
    const m = s.match(/^block#\s*\d+\s*→\s*(.+)$/i);
    return m ? m[1].trim() : s;
  };

  const mcParse = (html) => {
    const out = {};
    let s = onlyDataMC(html);
    s = String(s||"").replace(/<\/?b[^>]*>/gi,"").replace(/^MC:\s*/i,"").replace(/^block#\s*\d+\s*→\s*/i,"").trim();
    for (const p of s.split("|").map(x=>x.trim()).filter(Boolean)) {
      const m = p.match(/^(\w+)\s*:\s*(.+)$/); if (!m) continue;
      const k = m[1].toLowerCase(), v = m[2].trim();
      if (k.startsWith("buyer")) out.buyer=v;
      else if (k.startsWith("product")) out.product=v;
      else if (k.startsWith("company")) out.company=v;
      else if (k.startsWith("email")) out.email=v;
      else if (k.startsWith("gstin")) out.gstin=v;
      else if (k.startsWith("mobile")||k==="phone") out.mobile=v;
      else if (k.startsWith("address")) out.address=v.replace(/\s*\n\s*/g,", ");
      else if (k.startsWith("time")) out.time=v;
    }
    return out;
  };

  const extractKeywordTitle = (raw)=>{
    const s=String(raw);
    let m = s.match(/"([^"]+)"/); if (m) return m[1].trim();
    m = s.match(/🛒\s*([^|]+)$/); if (m) return m[1].trim();
    m = s.match(/Keyword matched\s*(?:–|-)?\s*(?:\|\s*)?(?:🛒\s*)?(.+)$/i);
    if (m) { const t=m[1].trim(); if (!/^keyword matched$/i.test(t)) return t; }
    const plain = s.replace(/<\/?[^>]+>/g,"").trim();
    return plain && plain.length<=80 && !/^keyword matched$/i.test(plain) ? plain : null;
  };

  const extractKeywordMeta = (raw)=>{
    const s = String(raw||"").trim();
    let m = s.match(/keywordmatch:\s*"([^"]+)"(?:\s*\[([^\]]+)\])?/i);
    if (m) return { title: m[1].trim(), location: (m[2]||"").trim() };
    m = s.match(/"([^"]+)"(?:\s*\[([^\]]+)\])?/);
    if (m) return { title: m[1].trim(), location: (m[2]||"").trim() };
    m = s.match(/🛒\s*([^|]+?)(?:\s*\|\s*📍\s*([^\|]+))?$/);
    if (m) return { title: m[1].trim(), location: (m[2]||"").trim() };
    const t = extractKeywordTitle(s);
    return t ? { title: t, location: "" } : null;
  };

  const normalizeKey = html => String(html).replace(/<\/?[^>]+>/g,"").replace(/\s+/g," ").trim().toLowerCase();
  const extractTitle = html => String(html).match(/class="h-title">([^<]+)</i)?.[1]?.trim().toLowerCase() || null;

  return { mcParse, extractKeywordTitle, extractKeywordMeta, normalizeKey, extractTitle, onlyDataMC };
})();

// ✅ FIX #17: BATCH FLUSH RACE CONDITION FIXED
let batch = [];
let isFlushScheduled = false;
let isFlushInProgress = false;

function scheduleFlush(){
  if (isFlushScheduled || isFlushInProgress) return;
  
  // ✅ Limit batch size
  if (batch.length > CONST.BATCH_SIZE_LIMIT) {
    batch.splice(0, batch.length - CONST.BATCH_SIZE_LIMIT);
  }
  
  isFlushScheduled = true;
  
  requestAnimationFrame(() => {
    isFlushScheduled = false;
    flushBatch();
  });
}

function flushBatch(){
  if (isFlushInProgress) return;
  if (!batch.length) return;

  isFlushInProgress = true;
  
  // ✅ Take snapshot to prevent race
  const toFlush = batch.slice();
  batch = [];
  
  try {
    const groups = [];
    let last = null;
    
    for (const it of toFlush) {
      if (!last || last.module !== it.module) {
        groups.push(last = { module: it.module, t: it.t, rows: [it] });
      } else {
        last.rows.push(it);
      }
    }

    const frag = document.createDocumentFragment();

    for (const g of groups) {
      const card = h("li", "logbox");
      
      const hdr = h("div", "loghdr");
      const time = h("span", "time", fmtTime(g.t));
      const mod = h("span", "module", g.module);
      hdr.appendChild(time);
      hdr.appendChild(mod);
      
      const lines = h("ul", "lines");

      if (g.module === "Keyword") {
        const keyLine = h("li");
        const emo = h("span", "emo", "✨");
        const txt = h("span", "txt", "Keyword Matched");
        keyLine.appendChild(emo);
        keyLine.appendChild(txt);
        lines.appendChild(keyLine);

        const seen = new Set();
        for (const it of g.rows) {
          const meta = LogFns.extractKeywordMeta(it.msg);
          if (!meta || !meta.title) continue;

          const key = (meta.title + "|" + (meta.location||"")).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);

          const prodLine = h("li");
          const prodEmo = h("span", "emo", "🛒");
          const prodTxt = h("span", "txt");
          const titleB = h("b", "h-title", meta.title);
          prodTxt.appendChild(titleB);
          prodLine.appendChild(prodEmo);
          prodLine.appendChild(prodTxt);
          lines.appendChild(prodLine);
          
          if (meta.location) {
            const locLine = h("li");
            const locEmo = h("span", "emo", "📍");
            const locTxt = h("span", "txt", meta.location);
            locLine.appendChild(locEmo);
            locLine.appendChild(locTxt);
            lines.appendChild(locLine);
          }
        }

        card.appendChild(hdr);
        card.appendChild(lines);
        frag.prepend(card);
        continue;
      }

      if (g.module === "MessageCentre") {
        let added = 0;
        for (const it of g.rows) {
          const f = LogFns.mcParse(it.msg);
          if (!Object.keys(f).length) continue;

          if (f.product) {
            const line = h("li");
            const emo = h("span", "emo", "🛒");
            const txt = h("span", "txt");
            const titleB = h("b", "h-title", f.product);
            txt.appendChild(titleB);
            line.appendChild(emo);
            line.appendChild(txt);
            lines.appendChild(line);
            added++;
          }
          if (f.buyer) { const line = h("li"); line.appendChild(h("span","emo","👤")); line.appendChild(h("span","txt",f.buyer)); lines.appendChild(line); added++; }
          if (f.mobile) { const line = h("li"); line.appendChild(h("span","emo","📞")); line.appendChild(h("span","txt",f.mobile)); lines.appendChild(line); added++; }
          if (f.email) { const line = h("li"); line.appendChild(h("span","emo","✉️")); line.appendChild(h("span","txt",f.email)); lines.appendChild(line); added++; }
          if (f.company) { const line = h("li"); line.appendChild(h("span","emo","🏢")); line.appendChild(h("span","txt",f.company)); lines.appendChild(line); added++; }
          if (f.gstin) { const line = h("li"); line.appendChild(h("span","emo","🧾")); line.appendChild(h("span","txt",f.gstin)); lines.appendChild(line); added++; }
          if (f.address) { const line = h("li"); line.appendChild(h("span","emo","📍")); line.appendChild(h("span","txt",f.address)); lines.appendChild(line); added++; }
          if (f.time) { const line = h("li"); line.appendChild(h("span","emo","⏰")); line.appendChild(h("span","txt",f.time)); lines.appendChild(line); added++; }

          if (added) {
            const sp = h("li");
            sp.appendChild(h("span","emo",""));
            sp.appendChild(h("span","txt"," "));
            sp.style.opacity = "0.15";
            lines.appendChild(sp);
          }
        }
        if (!added) continue;
        card.appendChild(hdr);
        card.appendChild(lines);
        frag.prepend(card);
        continue;
      }

      const seen = new Set();
      const titleSeen = new Set();
      for (const it of g.rows) {
        const line = h("li");
        
        // ✅ Safe text handling
        let txt = it.msg;
        const titleMatch = txt.match(/"([^"]+)"/);
        if (titleMatch) {
          const before = txt.substring(0, titleMatch.index);
          const title = titleMatch[1];
          const after = txt.substring(titleMatch.index + titleMatch[0].length);
          
          const t = title.trim().toLowerCase();
          if (t) {
            if (titleSeen.has(t)) continue;
            titleSeen.add(t);
          }
          
          const txtSpan = h("span", "txt");
          txtSpan.textContent = before;
          const titleB = h("b", "h-title", title);
          txtSpan.appendChild(titleB);
          const afterText = document.createTextNode(after);
          txtSpan.appendChild(afterText);
          
          const k = LogFns.normalizeKey(it.msg);
          if (seen.has(k)) continue;
          seen.add(k);
          
          line.appendChild(h("span", "emo", it.emoji));
          line.appendChild(txtSpan);
        } else {
          const k = LogFns.normalizeKey(txt);
          if (seen.has(k)) continue;
          seen.add(k);
          
          line.appendChild(h("span", "emo", it.emoji));
          line.appendChild(h("span", "txt", txt));
        }
        
        lines.appendChild(line);
      }
      
      card.appendChild(hdr);
      card.appendChild(lines);
      frag.prepend(card);
    }

    LOG_LIST.prepend(frag);
    
    // ✅ Limit log list size
    while (LOG_LIST.children.length > CONST.LOG_CARD_LIMIT) {
      LOG_LIST.removeChild(LOG_LIST.lastChild);
    }
    
    if (LOG_COUNT) LOG_COUNT.textContent = String(LOG_LIST.children.length);
    
  } finally {
    isFlushInProgress = false;
    
    // ✅ If new items added during flush, schedule again
    if (batch.length > 0) {
      scheduleFlush();
    }
  }
}

function addLog({ t, level, msg }){
  const clean = String(msg ?? "").replace(/^LM:\s*/,'').trim();
  const { module, emoji, msg:renderMsg } = classify(clean);
  batch.push({ t: t||Date.now(), module, emoji, msg: renderMsg });
  
  // ✅ Limit batch size
  if (batch.length > CONST.BATCH_SIZE_LIMIT) {
    batch.splice(0, batch.length - CONST.BATCH_SIZE_LIMIT);
  }
  
  scheduleFlush();
}

const offLogs = window.Logs.onAppend(addLog);

// ================================================================
// Manual Message Centre Button
// ================================================================

if (BTN_MANUAL) {
  on(BTN_MANUAL, "click", async ()=>{
    const old = BTN_MANUAL.textContent;
    BTN_MANUAL.disabled = true;
    BTN_MANUAL.textContent = "Running…";
    try {
      await (window.MC?.run?.() || Promise.resolve());
    } catch (e) {
      console.error("Manual MC failed:", e);
    } finally {
      BTN_MANUAL.disabled = false;
      BTN_MANUAL.textContent = old || "Manual Capture";
    }
  });
}

// ================================================================
// Cleanup on Window Close
// ================================================================

on(window, "beforeunload", ()=>{
  offWin?.(); 
  offLogs?.(); 
  offRefresh?.();
  
  // ✅ Clean up any remaining scheduled tasks
  isFlushScheduled = false;
  isFlushInProgress = false;
  batch = [];
  
  if (tCountdown) {
    clearInterval(tCountdown);
    tCountdown = null;
  }
});

// ================================================================
// Ready Message
// ================================================================

console.log("✅ Niyati Manager UI ready (FIXED v3.0.0 - ALL SECURITY ISSUES RESOLVED)");
console.log("🔒 XSS vulnerabilities: FIXED");
console.log("💾 localStorage quota handling: FIXED");
console.log("🏁 Batch race conditions: FIXED");
console.log("📊 Log Categories:", Object.keys(LOG_CATEGORIES).length);
