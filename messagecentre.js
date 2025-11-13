const { BrowserWindow, clipboard } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const CFG = Object.freeze({
  maxBlocks: 4, 
  clickTimeoutMs: 10_000, 
  betweenClicksMs: 900,
  panelReadyMs: 3000, 
  clipFreshMs: 1800, 
  pollMs: 80,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const writeAtomic = async (file, data, isText=false) => {
  const dir = path.dirname(file);
  try { await fsp.mkdir(dir, { recursive: true }); } catch {}
  const tmp = path.join(dir, `.${path.basename(file)}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  await fsp.writeFile(tmp, isText ? data : Buffer.from(data));
  await fsp.rename(tmp, file);
};

const last10 = (m) => String(m||"").replace(/\D/g,"").slice(-10);
const idKeyOf = (r) => [String(r.product||"").toLowerCase().trim(), String(r.buyer||"").toLowerCase().trim(), last10(r.mobile)].join("|");
const logKeyOf = (r) => idKeyOf(r) + "|" + String(r.time||"").toLowerCase().trim();
const esc = (s) => (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const nowTS = () => { 
  const d=new Date(),p=n=>String(n).padStart(2,"0"); 
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; 
};

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(v||"");
const pickGSTIN = (s)=>((s||"").toUpperCase().replace(/[^A-Z0-9]/g,"").match(/[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]/)||[])[0]||"";
const cleanAddr = (v)=>String(v||"").trim().replace(/\s*\n\s*/g,", ").replace(/\s+/g," ");
const waitFor = async (fn, to)=>{ 
  const t0=Date.now(); 
  while(Date.now()-t0<to){ 
    try{ if(await fn()) return true; }catch{} 
    await sleep(160);
  } 
  return false; 
};

// ✅ FIXED: Safe clipboard reading with size limits and pattern detection
const readClipFresh = async (prev, timeout=CFG.clipFreshMs, log=()=>{})=>{ 
  const end=Date.now()+timeout; 
  while(Date.now()<end){ 
    try {
      const cur = clipboard.readText().trim();
      
      // ✅ Size limit check
      if (cur.length > MAX_SAFE_CLIPBOARD_LENGTH) {
        if (typeof log === 'function') {
          log("warning", `Clipboard content too large (${cur.length} chars), skipping`);
        }
        await sleep(CFG.pollMs);
        continue;
      }
      
      // ✅ Dangerous pattern check
      let isDangerous = false;
      for (const pattern of CLIPBOARD_DANGEROUS_PATTERNS) {
        if (pattern.test(cur)) {
          isDangerous = true;
          break;
        }
      }
      
      if (isDangerous) {
        if (typeof log === 'function') {
          log("warning", "Clipboard contains dangerous patterns, skipping");
        }
        await sleep(CFG.pollMs);
        continue;
      }
      
      // Safe to use
      if(cur && cur!==prev) return cur;
    } catch (e) {
      if (typeof log === 'function') {
        log("error", `Clipboard read error: ${e.message}`);
      }
    }
    await sleep(CFG.pollMs);
  } 
  return ""; 
};

// ✅ Clipboard safety constants
const MAX_SAFE_CLIPBOARD_LENGTH = 10000;
const CLIPBOARD_DANGEROUS_PATTERNS = [/<script|javascript:|data:text\/html|onerror=/i];

// ✅ Safe clipboard operations
function safeReadClipboard(log) {
  try {
    const content = clipboard.readText().trim();
    
    if (content.length > MAX_SAFE_CLIPBOARD_LENGTH) {
      log("warning", `Clipboard too large (${content.length} chars), not preserving`);
      return null;
    }
    
    for (const pattern of CLIPBOARD_DANGEROUS_PATTERNS) {
      if (pattern.test(content)) {
        log("warning", "Clipboard contains potentially dangerous content, not preserving");
        return null;
      }
    }
    
    return content;
  } catch (e) {
    log("error", `Failed to read clipboard: ${e.message}`);
    return null;
  }
}

function safeRestoreClipboard(original, log) {
  if (!original) return;
  try {
    if (clipboard.readText() !== original) {
      clipboard.writeText(original);
    }
  } catch (e) {
    log("error", `Failed to restore clipboard: ${e.message}`);
  }
}

class LeadStore {
  constructor(dir){
    this.outDir = path.join(dir||__dirname, "Reports");
    try { fs.mkdirSync(this.outDir, { recursive: true }); } catch {}
    this.jsonFile = path.join(this.outDir, "messagecentre_log.json");
    this.rows=[]; 
    this.serial=1; 
    this.logKeys=new Set(); 
    this.idIndex=new Map(); 
    this._flushTimer=0;
    this._loadSync();
  }
  
  _loadSync(){
    try { 
      const j = JSON.parse(fs.readFileSync(this.jsonFile, "utf8")); 
      if (Array.isArray(j)) this.rows = j; 
    } catch {}
    
    for (let i=0;i<this.rows.length;i++){
      const r=this.rows[i]||{}, s=parseInt(r.serial,10);
      if(!Number.isNaN(s)) this.serial=Math.max(this.serial,s+1);
      this.logKeys.add(logKeyOf(r));
      const ik=idKeyOf(r); 
      if(!this.idIndex.has(ik)) this.idIndex.set(ik,i);
      if(typeof r.notified!=="boolean") r.notified=false;
      if(typeof r.lastSig!=="string") r.lastSig="";
    }
  }
  
  _debouncedFlush(){ 
    clearTimeout(this._flushTimer); 
    this._flushTimer=setTimeout(()=>this.flush().catch(()=>{}),120); 
  }
  
  async flush(){ 
    await writeAtomic(this.jsonFile, JSON.stringify(this.rows, null, 2), true); 
  }
  
  mergeFill(dst, src){
    const F=["product","buyer","mobile","email","company","gstin","address","time"], changed=[];
    for(const f of F){ 
      const cur=String(dst[f]??""), inc=String(src[f]??""); 
      if((cur.trim()===""||cur==="---") && inc.trim()!==""){ 
        dst[f]=inc; 
        changed.push(f);
      } 
    }
    return changed;
  }
  
  upsert(row){
    const ts=nowTS(), ik=idKeyOf(row);
    if(this.idIndex.has(ik)){
      let idx=this.idIndex.get(ik);
      if (idx < 0 || idx >= this.rows.length || idKeyOf(this.rows[idx]) !== ik) {
        const found = this.rows.findIndex(r => idKeyOf(r) === ik);
        if (found >= 0) { idx = found; this.idIndex.set(ik, found); }
      }
      if (idx >= 0) {
        const changed=this.mergeFill(this.rows[idx], row);
        if(changed.length){ 
          this.rows[idx].timestamp=this.rows[idx].timestamp||ts; 
          this._debouncedFlush(); 
          return {action:"merge", index:idx, changedFields:changed}; 
        }
        return {action:"dup", index:idx};
      }
    }
    if(this.logKeys.has(logKeyOf(row))) return {action:"dup", index:-1};
    
    const rec={ 
      serial:this.serial++, 
      timestamp:ts,
      product:row.product||"", 
      buyer:row.buyer||"", 
      mobile:row.mobile||"",
      email:row.email||"", 
      company:row.company||"", 
      gstin:row.gstin||"",
      address:row.address||"", 
      time:row.time||"", 
      notified:false, 
      lastSig:"" 
    };
    
    for (const [k, v] of this.idIndex) this.idIndex.set(k, v + 1);
    this.rows.unshift(rec); 
    this.logKeys.add(logKeyOf(row)); 
    this.idIndex.set(ik,0); 
    this._debouncedFlush();
    return {action:"new", index:0};
  }
  
  get(i){return this.rows[i]}
  
  markSig(i,sig){ 
    const r=this.rows[i]; 
    if(r){ 
      r.notified=true; 
      r.lastSig=sig; 
      this._debouncedFlush(); 
    } 
  }

  // ✅ NEW: Light reset - rebuild indexes from existing data
  reset() {
    try {
      this.logKeys.clear();
      this.idIndex.clear();
      
      for (let i = 0; i < this.rows.length; i++) {
        const r = this.rows[i] || {};
        this.logKeys.add(logKeyOf(r));
        const ik = idKeyOf(r);
        if (!this.idIndex.has(ik)) this.idIndex.set(ik, i);
      }
      
      console.log(`[LeadStore] Light reset: ${this.rows.length} rows, ${this.logKeys.size} keys, ${this.idIndex.size} index`);
    } catch (e) {
      console.error('[LeadStore] Reset failed:', e);
    }
  }
  
  // ✅ NEW: Deep reset - wipe everything
  deepReset() {
    this.rows = [];
    this.serial = 1;
    this.logKeys.clear();
    this.idIndex.clear();
    this._debouncedFlush();
    console.log('[LeadStore] Deep reset complete');
  }
  
  // ✅ NEW: Get statistics
  getStats() {
    return {
      rowsCount: this.rows.length,
      logKeysSize: this.logKeys.size,
      idIndexSize: this.idIndex.size,
      serial: this.serial
    };
  }
}

async function readTextFields(win, specs){
  const code = `(function(S){
    const $=s=>document.querySelector(s), 
          xp=s=>document.evaluate(s,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue, 
          txt=n=>n?(n.textContent||"").trim().replace(/\\s+/g," "):""; 
    const o={}; 
    for(const f of S){ 
      let v=f.textCss?txt($(f.textCss)):""; 
      if(!v&&f.textXp) v=txt(xp(f.textXp)); 
      o[f.key]=v||'---'; 
    } 
    return o;
  })(${JSON.stringify(specs)})`;
  return win.webContents.executeJavaScript(code,true);
}

async function clickAny(win, css, xp, scopeSel){
  const code = `(function(css,xp,scope){
    const root=scope?document.querySelector(scope):document; 
    if(!root) return false; 
    const vis=e=>e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0; 
    const tap=e=>{
      try{e.scrollIntoView({block:'center',inline:'center'})}catch{}; 
      e.dispatchEvent?.(new MouseEvent('click',{bubbles:true})); 
      e.click?.(); 
      return true;
    }; 
    try{ 
      if(css){ 
        const el=(scope? root.querySelector(css.startsWith(':scope')?css:(':scope '+css)) : document.querySelector(css)); 
        if(vis(el)) return tap(el.ownerSVGElement||el);
      } 
    }catch{} 
    try{ 
      if(xp){ 
        const el=document.evaluate(xp,root,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue; 
        if(vis(el)) return tap(el.ownerSVGElement||el);
      } 
    }catch{} 
    return false;
  })(${JSON.stringify(css)},${JSON.stringify(xp)},${JSON.stringify(scopeSel)})`;
  return win.webContents.executeJavaScript(code,true);
}

function formatLead(label, r){
  const ph=last10(r.mobile), wa=ph?`https://wa.me/91${ph}`:"";
  const maps=r.address&&r.address!=="---"?`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.address)}`:"";
  const L=[
    label,
    r.product && `✨ <b>${esc(r.product)}</b>`,
    r.buyer && `👤 <b>Name:</b> ${esc(r.buyer)}`,
    r.company && `🏢 <b>Company:</b> ${esc(r.company)}`,
    ph && `📞 <b>Mobile:</b> +91${ph}`,
    wa && `💬 <b>WhatsApp:</b> <a href="${wa}">${esc(wa)}</a>`,
    r.gstin && `🧾 <b>GSTIN:</b> ${esc(r.gstin)}`,
    r.email && `✉️ <b>Email:</b> ${esc(r.email)}`,
    r.address && `📍 <b>Address:</b> ${esc(r.address)}`,
    maps && `🗺️ <a href="${maps}">Open in Maps</a>`,
    r.time && `⏰ <b>Time:</b> ${esc(r.time)}`
  ].filter(Boolean).join("\n");
  return { text:L, extra:{ parse_mode:"HTML", disable_web_page_preview:true, link_preview_options:{ is_disabled:true } } };
}

const formatNew = (r)=> formatLead("🆕 <b>New Lead</b>", r);
const formatUpd = (r)=> formatLead("🔁 <b>Updated Lead</b>", r);
const notifSig = (r)=> JSON.stringify({ 
  product:r.product||"", 
  buyer:r.buyer||"", 
  company:r.company||"", 
  m:last10(r.mobile), 
  email:r.email||"", 
  gstin:r.gstin||"", 
  address:r.address||"", 
  time:r.time||"" 
});

function createMessageCentre(opts = {}){
  const {
    log=()=>{}, 
    url="https://seller.indiamart.com/messagecentre/", 
    parent=null,
    windowOptions={ 
      title:"Message Centre", 
      width:1200, 
      height:800, 
      show:false, 
      backgroundColor:"#0f0f10", 
      autoHideMenuBar:true, 
      webPreferences:{ contextIsolation:true, backgroundThrottling:false } 
    },
    maxBlocks=CFG.maxBlocks, 
    clickTimeoutMs=CFG.clickTimeoutMs, 
    betweenClicksMs=CFG.betweenClicksMs, 
    panelReadyTimeoutMs=CFG.panelReadyMs,
    readFreshMs=CFG.clipFreshMs, 
    pollStepMs=CFG.pollMs, 
    autoClose=true, 
    send=async()=>{}
  } = opts;

  const store=new LeadStore(__dirname);

  const FIELDS=[
    { key:"buyer", textCss:"#left-name", textXp:'//*[@id="left-name"]' },
    { key:"product",
      textCss: `#scrollableDiv > div.infinite-scroll-component__outerdiv > div > div.df > div.df.lms_flxdc.lms_aifs.mr20.mxwdth45 > div.left_side_msg > div.df.justifycontentfstart > div > div:nth-child(1)`,
      textXp: '//*[@id="scrollableDiv"]/div[2]/div/div[2]/div[1]/div[1]/div[1]/div/div[1]'
    },
    { key:"mobile", textCss:"#headerMobile > div:nth-child(1) > span:nth-child(2)", textXp:'//*[@id="headerMobile"]/div[1]/span[2]' },
    { key:"company", kind:"company", container:"#headerCompany", copyCss:"div:nth-child(1) svg path:nth-child(1)", copyXp:'//*[@id="headerCompany"]/div/svg/path[1]' },
    { key:"email", kind:"email", container:"#headerEmail", copyCss:"div:nth-child(1) svg path:nth-child(1)", copyXp:'//*[@id="headerEmail"]/div[1]/svg' },
    { key:"gstin", kind:"gstin", container:"#headerGST", copyCss:"div:nth-child(1)", copyXp:'//*[@id="headerGST"]/div' },
    { key:"address", kind:"address", container:"#headerAddress", copyCss:"span.mr2 svg path:nth-child(1)", copyXp:'//*[@id="headerAddress"]/span[1]/svg/path[1]' },
    { key:"time",
      textCss: ".left_side_msg .time_stamp, .time_stamp",
      textXp: '//*[@id="scrollableDiv"]/div[2]/div/div[2]/div[1]/div[1]/div[5]'
    },
  ];
  
  const BOXES = FIELDS.filter(f=>f.container);

  async function readProductFromList(win,i){
    const k=i+1, 
          cssSel=`#splitViewContactList > div > div > div > div:nth-child(${k}) > div > div:nth-child(4) > div.wrd_elip.fl.fs12.fwb.mxwdt75.bgF0F0F0.pd5_20.brdr_rad15 > span`,
          xpSel =`//*[@id="splitViewContactList"]/div/div/div/div[${k}]/div/div[4]/div[1]/span`;
    const code=`(function(css,xp){
      const t=n=>n?(n.textContent||"").trim().replace(/\\s+/g," "):"";
      try{const el=document.querySelector(css);if(el)return t(el);}catch{}
      try{const n=document.evaluate(xp,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;if(n)return t(n);}catch{}
      return "";
    })(${JSON.stringify(cssSel)},${JSON.stringify(xpSel)})`;
    try{ return await win.webContents.executeJavaScript(code,true); }catch{ return ""; }
  }

  async function openOnce(){
    const win = new BrowserWindow({ 
      webPreferences: { 
        contextIsolation: true, 
        nodeIntegration: false, 
        sandbox: true, 
        preload: path.join(__dirname, 'preload.js') 
      }, 
      ...windowOptions, 
      parent 
    });
    
    win.webContents.once("did-finish-load", ()=>log("info","MC: page loaded"));
    win.once("ready-to-show", ()=>{ try{ win.show(); }catch{} });

    const selFor=(i)=>{ 
      const k=i+1; 
      return [
        [`#splitViewContactList > div > div > div > div:nth-child(${k}) > div`, null],
        [null, `//*[@id="splitViewContactList"]/div/div/div/div[${k}]/div`],
        [`#contact-${i}`, null],
        [null, `//*[@id="contact-${i}"]`],
      ];
    };

    try{
      await win.loadURL(url);

      for(let i=maxBlocks-1;i>=0;i--){
        let ok=false; 
        for(const [css,xp] of selFor(i)){ 
          ok = await waitFor(()=>clickAny(win,css,xp), clickTimeoutMs); 
          if(ok) break; 
        }
        if(!ok){ 
          log("info",`MC: contact ${i} not available`); 
          continue; 
        }

        const ready = await win.webContents.executeJavaScript(`(t=>new Promise(res=>{
          const HAS = [
            '#left-name','#headerMobile','#headerCompany','#headerEmail','#headerGST','#headerAddress',
            '.left_side_msg .time_stamp'
          ];
          const has=()=>HAS.some(s=>{const n=document.querySelector(s);return n&&n.textContent&&n.textContent.trim().length>2;});
          if(has()) return res(true);
          const mo=new MutationObserver(()=>{ if(has()){ mo.disconnect(); res(true); } });
          mo.observe(document.body,{subtree:true,childList:true,characterData:true});
          setTimeout(()=>{ try{mo.disconnect()}catch{}; res(false); }, t);
        }))(${JSON.stringify(panelReadyTimeoutMs)})`, true);
        
        if(!ready) log("info","MC: panel not fully ready");

        let base = await readTextFields(win, FIELDS);

        const fromList = await readProductFromList(win, i); 
        if(fromList) base.product = fromList;

        const prev = safeReadClipboard(log);

        async function readTimeNow(winRef){
          const code = `(()=>{
            const pick = (n)=> n ? (n.textContent||'').trim().replace(/\\s+/g,' ') : '';
            const q = (s)=> document.querySelector(s);
            const cands = [
              '.left_side_msg .time_stamp',
              '.time_stamp',
              '#scrollableDiv > div.infinite-scroll-component__outerdiv > div > div.df > div.df.lms_flxdc.lms_aifs.mr20.mxwdth45 > div.left_side_msg > div.df.time_stamp.flxalgn.lms_dflw.mt5.as_fe'
            ];
            for (const sel of cands) {
              try { const n = q(sel); const t = pick(n); if (t) return t; } catch {}
            }
            return '';
          })()`;
          try { return await winRef.webContents.executeJavaScript(code, true); } catch { return ''; }
        }

        if (!base.time || base.time === '---') {
          for (let r = 0; r < 3 && (!base.time || base.time === '---'); r++) {
            await sleep(250);
            const t = await readTimeNow(win);
            if (t) base.time = t;
          }
        }

        const result = { ...base, company:'---', email:'---', gstin:'---', address:'---' };

        for(const f of BOXES){
          const clicked = await clickAny(win, f.copyCss, f.copyXp, f.container);
          let val=""; 
          if(clicked){ 
            await sleep(120); 
            // ✅ Pass log parameter for security warnings
            val = await readClipFresh(prev, readFreshMs, log); 
          }
          if(!val) val = await win.webContents.executeJavaScript(
            `(s=>{const b=document.querySelector(s);return b?(b.textContent||"").trim():"";})(${JSON.stringify(f.container)})`, 
            true
          );

          if (f.kind==="email") val = isEmail(val) ? val : "";
          else if (f.kind==="gstin") val = pickGSTIN(val);
          else if (f.kind==="address")val = pickGSTIN(val) || isEmail(val) ? "" : cleanAddr(val);
          else if (f.kind==="company"){ 
            if(pickGSTIN(val)||isEmail(val)) val=""; 
            val = String(val||"").trim().replace(/\s+/g," "); 
          }

          result[f.key] = val || '---';
          await sleep(110);
        }
        
        safeRestoreClipboard(prev, log);

        const row = {
          product: result.product!=='---'?result.product:"",
          buyer: result.buyer!=='---'?result.buyer:"",
          company: result.company!=='---'?result.company:"",
          email: result.email!=='---'?result.email:"",
          gstin: result.gstin!=='---'?result.gstin:"",
          mobile: result.mobile!=='---'?result.mobile:"",
          address: result.address!=='---'?result.address:"",
          time: result.time!=='---'?result.time:"",
        };

        const up = store.upsert(row);
        const idx = up.index>=0 ? up.index : (store.idIndex.get(idKeyOf(row)) ?? -1);
        const cur = idx>=0 ? store.get(idx) : null;

        if (up.action==="new" && cur){
          const sig = notifSig(cur);
          if (cur.lastSig !== sig) {
            const p = formatNew(cur);
            await send(p.text, p.extra);
            store.markSig(idx, sig);
            log("info","MC: Telegram (new)");
          }
        } else if (up.action==="merge" && cur){
          const sig = notifSig(cur);
          if (cur.lastSig !== sig) {
            const p = formatUpd(cur);
            await send(p.text, p.extra);
            store.markSig(idx, sig);
            log("info","MC: Telegram (update)");
          }
        }

        log("info",`MC: block#${i} → Buyer:${result.buyer} | Product:${result.product} | Company:${result.company} | Email:${result.email} | GSTIN:${result.gstin} | Mobile:${result.mobile} | Address:${result.address} | Time:${result.time}`);
        await sleep(betweenClicksMs);
      }

      if (autoClose && !win.isDestroyed()) try{ win.close(); }catch{}
      return true;
    } catch(e) {
      log("error",`MC: error – ${e.message}`);
      try{ if(!win.isDestroyed()) win.close(); }catch{}
      return false;
    }
  }

  let running=false; 
  const q=[];
  
  function enqueue(meta={}){ 
    return new Promise((resolve,reject)=>{ 
      q.push({meta,resolve,reject}); 
      if(!running) drain(); 
    }); 
  }
  
  async function drain(){ 
    running=true; 
    while(q.length){ 
      const job=q.shift(); 
      try{ job.resolve(await openOnce()); }
      catch(e){ job.reject(e); } 
    } 
    running=false; 
  }

  return { 
    enqueue, 
    get running(){ return running; }, 
    get size(){ return q.length; },
    // ✅ NEW: Expose reset methods
    reset: () => store.reset(),
    deepReset: () => store.deepReset(),
    getStats: () => store.getStats()
  };
}

module.exports = { createMessageCentre };