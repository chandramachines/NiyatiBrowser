const CONST = Object.freeze({
  LS_REFRESH:  "niyati:leadsRefresh",
  LS_PRODUCTS: "niyati:products",
  LS_KEYWORDS: "niyati:keywords",
  LOG_CARD_LIMIT: 300,
  BATCH_SIZE_LIMIT: 1000, // Prevent memory leak in batch array
  MIN_SEC: 3,
  MAX_SEC: 3600,
  DEFAULT_SEC: 7
});

const $  = (s, r=document)=>r.querySelector(s);
const on = (el, ev, fn, opts)=> el.addEventListener(ev, fn, opts);
const h  = (tag, cls, html)=>{ const n=document.createElement(tag); if(cls) n.className=cls; if(html!=null) n.innerHTML=html; return n; };
const pad2 = n=> String(n).padStart(2,"0");
const fmtTime = (t=Date.now())=>{ const d=new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const jsonGet = (k, fb=null)=>{ try{ return JSON.parse(localStorage.getItem(k) || "null") ?? fb; }catch{ return fb; } };
const jsonSet = (k, v)=> localStorage.setItem(k, JSON.stringify(v));

// Safe reporter to avoid crashes if preload didn't expose NetBridge yet
const __safeReportNet = (flag) => { try { window.NetBridge?.report?.(!!flag); } catch {} };

const BTN_MIN=$("#min"), BTN_MAX=$("#max"), BTN_CLOSE=$("#close"), MAX_ICON=$("#maxIcon");
const NET_CHIP=$("#netStatus"), NET_LABEL=$(".label", NET_CHIP);
const REF_FORM=$("#refreshForm"), REF_SEC=$("#refreshSec"), BTN_START=$("#refreshStart"), BTN_STOP=$("#refreshStop");
const PROD_FORM=$("#prodForm"), PROD_INPUT=$("#prodInput"), PROD_LIST=$("#prodList"), PROD_COUNT=$("#prodCount");
const KEY_FORM=$("#keyForm"), KEY_INPUT=$("#keyInput"), KEY_INLINE=$("#keyInline"), KEY_COUNT=$("#keyCount");
const BTN_PROD_COL=$("#prodCollapse"), CARD_PRODUCTS=$("#productsCard");
const BTN_KEY_COL=$("#keyCollapse"), CARD_KEYWORDS=$("#keywordsCard");
const LOG_LIST=$("#logList"), LOG_COUNT=$("#logCount");
const BTN_MANUAL=$("#manualMC"); // ✅ NEW: Manual Capture button

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

function setNetState(online){
  NET_CHIP.classList.toggle("online", !!online);
  NET_CHIP.classList.toggle("offline", !online);
  NET_LABEL.textContent = online ? "Online" : "Offline";

  window.NetBridge?.report?.(!!online);
}
setNetState(false); // wait for verified state from main
on(window, "online",  ()=> window.NetBridge?.report?.(true));
on(window, "offline", ()=> window.NetBridge?.report?.(false));

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
    if (!s.isNetworkOnline)                       { BTN_START.textContent="Paused (offline)"; BTN_START.title="Network offline — will reload when online"; }
    else if (s.suspendedByAuth || s.isLoggedIn===false) { BTN_START.textContent="Paused (login)";   BTN_START.title="Login required"; }
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
  await window.LeadsRefresh.start(ms);
  applyRefreshState(await window.LeadsRefresh.getState());
});
on(BTN_STOP, "click", async ()=>{
  await window.LeadsRefresh.stop();
  jsonSet(CONST.LS_REFRESH, { ...(jsonGet(CONST.LS_REFRESH, {})), enabled:false });
  applyRefreshState(await window.LeadsRefresh.getState());
});
(async ()=>{
  window.NetBridge?.report?.(navigator.onLine);
  const pref = jsonGet(CONST.LS_REFRESH);
  if (pref?.enabled) {
    const ms = Math.max(3000, Number(pref.intervalMs)||7000);
    REF_SEC.value = Math.round(ms/1000);
    await window.LeadsRefresh.start(ms);
  } else REF_SEC.value = CONST.DEFAULT_SEC;
  applyRefreshState(await window.LeadsRefresh.getState());
})();

const normSpace = s=> String(s||"").trim().replace(/\s+/g," ");
const toTitle   = s=> normSpace(s).toLowerCase().split(" ").map(w=> w? (w[0].toUpperCase()+w.slice(1)):"").join(" ");
const uniqPush  = (arr, val, key=(x)=>x.toLowerCase())=>{ if(!val) return; const k=key(val); if(!arr.some(v=>key(v)===k)) arr.push(val); };

const persist = async (type, arr)=>{
  localStorage.setItem(type==="products"? CONST.LS_PRODUCTS : CONST.LS_KEYWORDS, JSON.stringify(arr));
  try { type==="products" ? await window.Lists.saveProducts(arr) : await window.Lists.saveKeywords(arr); } catch {}
};

let products = jsonGet(CONST.LS_PRODUCTS, []);
let keywords = jsonGet(CONST.LS_KEYWORDS, []);

function renderProducts(arr){
  PROD_LIST.innerHTML="";
  const frag=document.createDocumentFragment();
  arr.forEach((item, idx)=>{
    frag.append(h("li","pill",`
      <div class="left"><span class="serial">${idx+1}</span><span class="title">${item}</span></div>
      <button class="del" data-index="${idx}" aria-label="Delete">Delete</button>`));
  });
  PROD_LIST.append(frag); PROD_COUNT.textContent = arr.length;
}
function renderKeywords(arr){
  KEY_INLINE.innerHTML="";
  const frag=document.createDocumentFragment();
  arr.forEach((kw, idx)=> frag.append(h("span","kw",`<span class="txt">${kw}</span><button class="rm" data-index="${idx}" title="Remove">×</button>`)));
  KEY_INLINE.append(frag); KEY_COUNT.textContent = arr.length;
}
renderProducts(products); renderKeywords(keywords);

window.RendererLists = {
  refresh(){
    try{
      products = jsonGet(CONST.LS_PRODUCTS, []);
      keywords = jsonGet(CONST.LS_KEYWORDS, []);
      renderProducts(products);
      renderKeywords(keywords);
    }catch{}
  }
};

on(PROD_FORM, "submit", async (e)=>{
  e.preventDefault();
  const chunks = normSpace(PROD_INPUT.value).split(",").map(normSpace).filter(Boolean);
  if (!chunks.length) return;
  chunks.forEach(raw=> uniqPush(products, toTitle(raw)));
  PROD_INPUT.value=""; renderProducts(products); await persist("products", products);
});
on(KEY_FORM, "submit", async (e)=>{
  e.preventDefault();
  const chunks = normSpace(KEY_INPUT.value).split(",").map(normSpace).filter(Boolean);
  if (!chunks.length) return;
  chunks.forEach(raw=> uniqPush(keywords, normSpace(raw).toLowerCase(), s=>s));
  KEY_INPUT.value=""; renderKeywords(keywords); await persist("keywords", keywords);
});
on(PROD_LIST, "click", async (e)=>{
  const btn = e.target.closest(".del"); if(!btn) return;
  const i = +btn.dataset.index; if (!Number.isInteger(i)) return;
  products.splice(i,1); renderProducts(products); await persist("products", products);
});
on(KEY_INLINE, "click", async (e)=>{
  const btn = e.target.closest(".rm"); if(!btn) return;
  const i = +btn.dataset.index; if (!Number.isInteger(i)) return;
  keywords.splice(i,1); renderKeywords(keywords); await persist("keywords", keywords);
});
function wireCollapse(btn, card){
  on(btn, "click", ()=>{
    const open = btn.getAttribute("aria-expanded")==="true";
    card.classList.toggle("is-collapsed", open);
    btn.setAttribute("aria-expanded", String(!open));
    btn.textContent = open ? "Expand" : "Collapse";
  });
}
wireCollapse(BTN_PROD_COL, CARD_PRODUCTS);
wireCollapse(BTN_KEY_COL,  CARD_KEYWORDS);

const LogFns = (()=>{
  const mcFieldRx = /^MC:\s*(?:block#|buyer|product|company|email|gstin|mobile|address|time)\b/i;
  const onlyDataMC = s => /^block#\d+/i.test(s) || mcFieldRx.test(s);

  const mcParse = (s)=>{
    const out={};
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
    m = s.match(/Keyword matched\s*(?:—|-)?\s*(?:\|\s*)?(?:🛒\s*)?(.+)$/i);
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

  const classify = (raw)=>{
    const s = String(raw||"").trim();
    let module="General", emoji="•", msg=s;

    if (/Leads refreshed/i.test(s))                { module="Refresh"; emoji="🔄"; msg = `Refreshed • ${s.match(/\((\d+)s\)/)?.[1]||""}s`.trim(); }
    else if (/Leads page loaded/i.test(s))         { module="Leads";   emoji="📥"; msg="Page ready"; }
    else if (/^scrape:|#list\d+/i.test(s))         { module="Scrape";  emoji=/#list/i.test(s)?"🧾":"📊"; }
    else if (/Memory cleanup/i.test(s) || /^Cleanup:/i.test(s)) { module="Cleanup"; emoji="🧹"; }
    else if (/matchClick/i.test(s))                { module="Click";   emoji=/Clicked/.test(s)?"👆":"•"; }
    else if (/keywordMatch|KW-Notify|Keyword Matched/i.test(s)) { module="Keyword"; emoji="✨"; msg=s.replace(/keywordMatch:\s*/i,"").replace(/^.*Keyword Matched.*$/i,"Keyword matched"); }
    else if (/^Reports?:\b|^Scheduler:|Daily \d{2}:\d{2}/i.test(s) || /Report sent|Report send failed/i.test(s)) { module="Reports"; emoji="🗓️"; }
    else if (onlyDataMC(s))                        { module="MessageCentre"; }
    else if (/\bAuto-login\b|\[AutoLogin\]/i.test(s)) { module="AutoLogin"; }
    else if (/Network (online|offline)|Watcher/i.test(s)) { module="Network"; }
    else if (/Login detected|Logout detected/i.test(s))   { module="Auth"; }

    if (/Telegram notified/i.test(s)) { emoji="📣"; msg="Telegram sent"; }
    if (/#list(\d+):\s*(.+)$/i.test(s)) { const m=s.match(/#list(\d+):\s*(.+)$/i); msg=`#${m[1]}  ${m[2]}`; }

    msg = msg.replace(/^LM:\s*|^MC:\s*/,"").trim();
    return { module, emoji, msg };
  };

  return { mcParse, extractKeywordTitle, extractKeywordMeta, normalizeKey, extractTitle, classify };
})();

let batch=[], rafId=0, flushTimer=0;
function scheduleFlush(){
  if (flushTimer) return;
  flushTimer = setTimeout(()=>{ if (!rafId) rafId = requestAnimationFrame(flushBatch); }, 100);
}

function flushBatch(){
  flushTimer=0; rafId=0;
  if (!batch.length) return;

  const groups=[]; let last=null;
  for (const it of batch) {
    if (!last || last.module!==it.module) groups.push(last={ module:it.module, t:it.t, rows:[it] });
    else last.rows.push(it);
  }
  batch.length=0;

  const frag=document.createDocumentFragment();

  for (const g of groups) {
    const card = h("li","logbox", `
      <div class="loghdr"><span class="time">${fmtTime(g.t)}</span><span class="module">${g.module}</span></div>
      <ul class="lines"></ul>`);
    const lines = $(".lines", card);

    if (g.module === "Keyword") {
      lines.append(h("li","", `<span class="emo">✨</span><span class="txt">Keyword matched</span>`));

      const seen = new Set();
      for (const it of g.rows) {
        const meta = LogFns.extractKeywordMeta(it.msg);
        if (!meta || !meta.title) continue;

        const key = (meta.title + "|" + (meta.location||"")).toLowerCase();
        if (seen.has(key)) continue; seen.add(key);

        const titleHTML = `<b class="h-title">${meta.title}</b>`;
        if (meta.location) {
          lines.append(h("li","", `<span class="emo">🛒</span><span class="txt">${titleHTML}</span>`));
          lines.append(h("li","", `<span class="emo">📍</span><span class="txt">${meta.location}</span>`));
        } else {
          lines.append(h("li","", `<span class="emo">🛒</span><span class="txt">${titleHTML}</span>`));
        }
      }

      frag.prepend(card); continue;
    }

    if (g.module === "MessageCentre") {
      let added=0;
      for (const it of g.rows) {
        const f = LogFns.mcParse(it.msg); if (!Object.keys(f).length) continue;

        if (f.product){ lines.append(h("li","", `<span class="emo">🛒</span><span class="txt"><b class="h-title">${f.product}</b></span>`)); added++; }
        if (f.buyer)  { lines.append(h("li","", `<span class="emo">👤</span><span class="txt">${f.buyer}</span>`)); added++; }
        if (f.mobile) { lines.append(h("li","", `<span class="emo">📞</span><span class="txt">${f.mobile}</span>`)); added++; }
        if (f.email)  { lines.append(h("li","", `<span class="emo">✉️</span><span class="txt">${f.email}</span>`)); added++; }
        if (f.company){ lines.append(h("li","", `<span class="emo">🏢</span><span class="txt">${f.company}</span>`)); added++; }
        if (f.gstin)  { lines.append(h("li","", `<span class="emo">🧾</span><span class="txt">${f.gstin}</span>`)); added++; }
        if (f.address){ lines.append(h("li","", `<span class="emo">📍</span><span class="txt">${f.address}</span>`)); added++; }

        if (f.time)    { lines.append(h("li","", `<span class="emo">⏰</span><span class="txt">${f.time}</span>`)); added++; }

        if (added) { const sp=h("li","", `<span class="emo"></span><span class="txt">&nbsp;</span>`); sp.style.opacity=.15; lines.append(sp); }
      }
      if (!added) continue;
      frag.prepend(card); continue;
    }

    const seen = new Set(), titleSeen = new Set();
    for (const it of g.rows) {
      let txt = it.msg.replace(/"([^"]+)"/g, '<b class="h-title">$1</b>');
      const t  = LogFns.extractTitle(txt); if (t){ if (titleSeen.has(t)) continue; titleSeen.add(t); }
      const k  = LogFns.normalizeKey(txt); if (seen.has(k)) continue; seen.add(k);
      lines.append(h("li","", `<span class="emo">${it.emoji}</span><span class="txt">${txt}</span>`));
    }
    frag.prepend(card);
  }

  LOG_LIST.prepend(frag);
  while (LOG_LIST.children.length > CONST.LOG_CARD_LIMIT) LOG_LIST.removeChild(LOG_LIST.lastChild);
  if (LOG_COUNT) LOG_COUNT.textContent = String(LOG_LIST.children.length);
}

function addLog({ t, level, msg }){
  const clean = String(msg ?? "").replace(/^LM:\s*/,'').trim();
  const { module, emoji, msg:renderMsg } = LogFns.classify(clean);
  batch.push({ t: t||Date.now(), module, emoji, msg: renderMsg });
  
  // Prevent memory leak: limit batch size
  if (batch.length > CONST.BATCH_SIZE_LIMIT) {
    batch.splice(0, batch.length - CONST.BATCH_SIZE_LIMIT);
  }
  
  scheduleFlush();
}
const offLogs = window.Logs.onAppend(addLog);

if (BTN_MANUAL) {
  on(BTN_MANUAL, "click", async ()=>{
    const old = BTN_MANUAL.textContent;
    BTN_MANUAL.disabled = true;
    BTN_MANUAL.textContent = "Running…";
    try {
      await (window.MC?.run?.() || Promise.resolve()); // main: MC.enqueue() → refresh
    } catch (e) {
      console.error("Manual MC failed:", e);
    } finally {
      BTN_MANUAL.disabled = false;
      BTN_MANUAL.textContent = old || "Manual Capture";
    }
  });
}

on(window, "beforeunload", ()=>{
  offWin?.(); offLogs?.(); offRefresh?.();
  if (tCountdown) clearInterval(tCountdown);
});
