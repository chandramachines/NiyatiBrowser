
const fs = require("node:fs");
const path = require("node:path");

function createMatchClicker({
  win,
  log = (...args) => { try { console.log(...args); } catch {} }, // safe default logger
  getProducts = () => [],
  send = () => {},
  dedupeMs = 5 * 60 * 1000,
  recentClickIgnoreCycles = 1,
  silent = true,
  notify = send,
  maxReportRows = 2000,
}) {
  if (!win || win.isDestroyed && win.isDestroyed()) throw new Error("matchClicker: invalid window");

  const OUTPUT_DIR = path.join(__dirname, "Reports");
  const MATCH_JSON = path.join(OUTPUT_DIR, "matchclick.json");
  try { fs.mkdirSync(OUTPUT_DIR, { recursive: true }); } catch (e) { /* ignore */ }

  let _mc_jsonRows = [];
  try {
    if (fs.existsSync(MATCH_JSON)) {
      const _raw = fs.readFileSync(MATCH_JSON, "utf8");
      const _data = JSON.parse(_raw);
      if (Array.isArray(_data)) _mc_jsonRows = _data;
    }
  } catch (e) {
    try { log("error", "matchclicker JSON load failed: " + (e && e.message || e)); } catch {}
  }

  const _mc_writeJson = () => {
    try {
      if (_mc_jsonRows.length > maxReportRows) {
        _mc_jsonRows = _mc_jsonRows.slice(0, maxReportRows);
      }
      fs.writeFileSync(MATCH_JSON, JSON.stringify(_mc_jsonRows, null, 2), "utf8");
    } catch (e) {
      try { log("error", "matchclicker JSON write failed: " + (e && e.message || e)); } catch {}
    }
  };

  const _mc_ts = () => {
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  const norm = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /* Option A plural matching applied */

  function extractLocation(rawTitle) {
    const text = String(rawTitle || "");
    const delims = ["|", "-", ",", "–", "—"];
    for (const delim of delims) {
      const idx = text.lastIndexOf(delim);
      if (idx >= 0) {
        const part = text.slice(idx + 1).trim();
        if (part && /^[\p{L} .,'()-]+$/u.test(part)) {
          return part;
        }
      }
    }
    return "";
  }

  function buildFancyMessage(rawTitle, matched, status) {
    const lines = [];
    lines.push("✨ Product Matched");
    lines.push(`🛒 ${rawTitle}`);
    if (matched) {
      lines.push(`🧩 Matched With: ${String(matched).toLowerCase()}`);
    }
    const loc = extractLocation(rawTitle);
    if (loc) {
      lines.push(`📍 ${loc}`);
    }
    if (status === "ok") {
      lines.push("✅ Click Successful");
    } else if (status === "fail") {
      lines.push("❌ Click Failed");
    } else if (status === "skip") {
      lines.push("⏭️ Click Skipped (recently clicked)");
    }
    return lines.join("\n");
  }

  
// Option A: simple plural-aware token pattern
function tokenPattern(tok) {
  const base = escapeRe(tok);
  // if ends with s/x/z/ch/sh -> allow optional 'es'
  if (/(?:s|x|z|ch|sh)$/i.test(tok)) return base + "(?:es)?";
  // consonant + y -> allow y / ies
  if (/[bcdfghjklmnpqrstvwxyz]y$/i.test(tok)) {
    const stem = tok.slice(0, -1);
    return "(?:" + escapeRe(stem) + "y|" + escapeRe(stem) + "ies)";
  }
  // default: optional 's'
  return base + "s?";
}


function phraseRegex(phrase) {
  const toks = norm(phrase).split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  const pats = toks.map(tokenPattern);
  return new RegExp("\\b" + pats.join("\\W+") + "\\b", "i");
}


  function compileProducts() {
    const src = getProducts() || [];
    return src.map((p) => ({ name: p, re: phraseRegex(p) })).filter(Boolean);
  }

  const exec = (code) => win.webContents.executeJavaScript(code, true);

  async function clickContactBtnForIndex(idx) {
    const js = `
      (function(){
        const idx = ${Number(idx)};
        const sels = [
          '#list' + idx + ' .Slid_CTA span',
          '#list' + idx + ' .Slid_CTA button',
          '#list' + idx + ' [data-action="contact"]',
          '#list' + idx + ' .contact, #list' + idx + ' .btn-contact',
          '#list' + idx + ' > div:nth-child(3) > div.Slid_CTA > div > span'
        ];
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el) { el.click(); return { ok:true, via:s }; }
        }
        try {
          const xp = '//*[@id="list' + idx + '"]/div[3]/div[2]/div/span';
          const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          const el = r.singleNodeValue;
          if (el) { el.click(); return { ok:true, via:'xpath' }; }
        } catch(e) {}
        return { ok:false, via:'none' };
      })();
    `;
    try { const res = await exec(js); return !!(res && res.ok); } catch (e) { try { log("error", "exec click error: " + (e && e.message || e)); } catch {} return false; }
  }

  let lastCycle = -1;
  let cooldown = new Set();

  const recentClicked = new Set();
  function pruneRecent(currentSigs) {
    for (const sig of Array.from(recentClicked)) {
      if (!currentSigs.has(sig)) recentClicked.delete(sig);
    }
  }

  const sentCache = new Map();
  const now = () => Date.now();
  function pruneCache() {
    const t = now();
    for (const [k, ts] of sentCache) if (t - ts > dedupeMs) sentCache.delete(k);
  }
  function shouldSendOnce(key) {
    pruneCache();
    if (sentCache.has(key)) return false;
    sentCache.set(key, now());
    return true;
  }

  function maybeNotify(type, key, msg) {
    if (!notify) return;
    if (silent) {
      if (type !== "match-ok" && type !== "match-fail") return;
    }
    if (shouldSendOnce(key)) {
      try { notify(msg); } catch (e) { try { log("error", "notify failed: " + (e && e.message || e)); } catch {} }
    }
  }

  let inFlight = false;

  async function processCycle(items, cycleId) {
    if (inFlight) {
      try { log("info", "matchClick: cycle skipped — previous cycle still running"); } catch {}
      return;
    }
    inFlight = true;
    try {
      const _mc_newMatches = [];

      if (typeof cycleId === "number" && cycleId !== lastCycle + 1 && lastCycle !== -1) cooldown.clear();
      lastCycle = typeof cycleId === "number" ? cycleId : lastCycle;

      const prods = compileProducts();
      if (!prods.length) { log("info", "matchClick: no products configured"); inFlight = false; return; }

      let useItems = Array.isArray(items) ? items.slice() : [];
      if (!useItems.length) {
        const dom = await exec(`
          (function(){
            const out = [];
            let i = 1;
            for (;;) {
              const row = document.getElementById('list' + i);
              if (!row) break;
              const t1 = row.querySelector('.Bl_Txt a, .Bl_Txt, .bl_text, .title, h3, h4, h2');
              const title = (t1 && t1.textContent || '').trim();
              out.push({ index: i, title });
              i++;
            }
            return out;
          })();
        `);
        useItems = Array.isArray(dom) ? dom : [];
      }
      if (!useItems.length) { log("info", "matchClick: no items found this cycle"); inFlight = false; return; }

      const currentSignatures = new Set();
      for (const it of useItems) {
        const rawTitleSig = it.title || it.name || it.product || "";
        const sig = norm(rawTitleSig);
        if (sig) currentSignatures.add(sig);
      }
      pruneRecent(currentSignatures);

      const seenNow = new Set();
      let clickedKeys = []; // track all clicked keys this cycle

      for (const it of useItems) {
        const idx = Number(it.index ?? it.i ?? it.id ?? 0);
        if (!idx) continue;
        const key = `list#${idx}`;
        seenNow.add(key);
        if (cooldown.has(key)) { log("info", `matchClick: skip ${key} (cooldown)`); continue; }

        const rawTitle = it.title || it.name || it.product || "";
        const title = norm(rawTitle);
        if (!title) continue;

        const titleSig = title;

        let matched = null;
        for (const p of prods) { if (p.re.test(title)) { matched = p.name; break; } }

        if (matched) {
          // moved: only record on actual click success
          // _mc_newMatches.push({ title: rawTitle || title, index: idx, matched, timestamp: _mc_ts() });
          const wasClickedRecently = recentClicked.has(titleSig);
          if (wasClickedRecently) {
            const dedupeKey = `M|${idx}|${title}|recent-skip`;
            const fancyMsg = buildFancyMessage(rawTitle || title, matched, "skip");
            try { log("info", fancyMsg); } catch {}
            maybeNotify("recent-skip", dedupeKey, fancyMsg);
            continue; // continue searching other rows
          }
          let ok = await clickContactBtnForIndex(idx);
          const outcome = ok ? "ok" : "fail";
          const dedupeKey = `M|${idx}|${title}|${outcome}`;
          const fancyMsg = buildFancyMessage(rawTitle || title, matched, outcome);
          try { log(ok ? "info" : "error", fancyMsg); } catch {}
          maybeNotify(ok ? "match-ok" : "match-fail", dedupeKey, fancyMsg);
          if (ok) {
            _mc_newMatches.push({ title: rawTitle || title, index: idx, matched, status: "ok", timestamp: _mc_ts() });
            recentClicked.add(titleSig);
            clickedKeys.push(key);
            try { log("info", `matchClick: Clicked ${key} — "${title}" (matched: ${matched})`); } catch {}
          } else {
            try { log("error", `matchClick: Button not found for ${key}`); } catch {}
          }
        } else {
          const dedupeKey = `N|${idx}|${title}`;
          const msg = `Attempted match for "${rawTitle || title}" (${key}) – matched: no`;
          try { log("info", `matchClick: ${msg}`); } catch {}
          maybeNotify("nomatch", dedupeKey, msg);
        }
      }

      if (_mc_newMatches.length) {
        for (const m of _mc_newMatches) _mc_jsonRows.unshift(m);
        _mc_writeJson();
      }

      cooldown = new Set([...cooldown].filter((k) => seenNow.has(k)));
      for (const ck of clickedKeys) cooldown.add(ck);

      log(clickedKeys.length ? "start" : "info",
          `matchClick: ${clickedKeys.length ? "clicked " + clickedKeys.join(", ") : "no click"} this cycle (cooldown: ${cooldown.size})`);
    } catch (e) {
      try { log("error", `matchClick: ${e && e.message || e}`); } catch {}
    } finally {
      inFlight = false;
    }
  }

  return { processCycle };
}


// --- Injected reset function ---
function clearMatchLog(){
  try { _mc_jsonRows = Array.isArray(_mc_jsonRows) ? [] : []; } catch(e){}
  try { rows = Array.isArray(rows) ? [] : []; } catch(e){}
  try { if (typeof writeJson === 'function') writeJson(); } catch(e){}
  try { if (typeof flush === 'function') flush(); } catch(e){}
  try { if (typeof persistJSON === 'function') persistJSON(); } catch(e){}  const fs = require('fs');
  const path = require('path');
  try { fs.writeFileSync(path.resolve(__dirname, 'Reports/matchclick.json'), '[]', 'utf8'); } catch(e){}
  try { fs.writeFileSync(path.resolve(__dirname, './Reports/matchclick.json'), '[]', 'utf8'); } catch(e){}

}
// --- end injected ---

module.exports = { createMatchClicker };
