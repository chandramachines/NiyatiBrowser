const fs = require("node:fs");
const path = require("node:path");

function createKeywordMatcher({
  keywordsFile = path.join(__dirname, "List", "keywords.json"),
  log  = () => {},
  send = async (_text, _extra = {}) => {}
} = {}) {

  const norm = s => String(s||"").trim().replace(/\s+/g," ").toLowerCase();
  const normTitle = s => (s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, "")
    .trim();

  const tsNoMs = (d=new Date())=>{
    const p = n=>String(n).padStart(2,"0");
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  const readKeywords = () => {
    try {
      const raw = fs.readFileSync(keywordsFile, "utf8");
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(s => String(s).trim().toLowerCase()).filter(Boolean) : [];
    } catch {
      try {
        const legacy = path.join(__dirname, "keywords.txt");
        const txt = fs.readFileSync(legacy, "utf8");
        return txt.split(/[\n,]/g).map(s => s.trim().toLowerCase()).filter(Boolean);
      } catch { return []; }
    }
  };

  const escHtml = s => String(s||"")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");

  const composeLocation = (it)=>{
    const city = (it?.city||"").trim();
    const state = (it?.state||"").trim();
    const fb = (it?.location||"").trim();
    return (city || state) ? [city, state].filter(Boolean).join(", ") : (fb || "");
  };

  const buildFancyMessage = (title, loc)=>{
    const lines = [ "✨ Keyword Matched", `🛒 ${escHtml(title)}` ];
    if (loc) lines.push(`📍 ${escHtml(loc)}`);
    return { text: lines.join("\n"), extra:{ parse_mode:"HTML", disable_web_page_preview:true } };
  };

  const OUTPUT_DIR = path.join(__dirname, "Reports");
  const MATCH_JSON = path.join(OUTPUT_DIR, "keyword_matches.json");
  try { fs.mkdirSync(OUTPUT_DIR, { recursive: true }); } catch {}

  let persistedKeys = new Set(); // norm(name)|norm(location)
  let serialCounter = 1;
  let jsonRows = [];

  try {
    if (fs.existsSync(MATCH_JSON)) {
      const data = JSON.parse(fs.readFileSync(MATCH_JSON, "utf8"));
      if (Array.isArray(data)) {
        jsonRows = data;
        for (const row of data) {
          const name = row?.name ?? "";
          const loc  = row?.location ?? "";
          if (name) {
            persistedKeys.add(`${norm(name)}|${norm(loc)}`);
            const sNo = parseInt(row?.serial, 10);
            if (!Number.isNaN(sNo)) serialCounter = Math.max(serialCounter, sNo + 1);
          }
        }
      }
    }
  } catch (e) { try { log("error", `keyword JSON load failed: ${e.message}`); } catch {} }

  const writeJson = () => {
    try {
      fs.mkdirSync(path.dirname(MATCH_JSON), { recursive: true });
      fs.writeFileSync(MATCH_JSON, JSON.stringify(jsonRows, null, 2), "utf8");
    } catch (e) { try { log("error", `keyword JSON write failed: ${e.message}`); } catch {} }
  };

  const persistIfNew = (name, location) => {
    const key = `${norm(name)}|${norm(location)}`;
    if (persistedKeys.has(key)) return false;
    const ts = tsNoMs();
    jsonRows.unshift({ serial: serialCounter, timestamp: ts, name, location });
    writeJson();
    serialCounter += 1;
    persistedKeys.add(key);
    try { log("info", `persist(keyword): + "${name}"${location?` [${location}]`:""}`); } catch {}
    return true;
  };

  let lastCycleMatches = new Set();

  async function processCycle(items, _cycleId) {
    const keywords = readKeywords();
    if (!Array.isArray(items)) items = [];
    if (keywords.length === 0) { /* keep lastCycleMatches to preserve dedupe */ return { sent: 0, matched: [] }; }

    const currentMatched = new Set();
    const currentMeta = new Map(); // key → { title, location }

    for (const it of items) {
      const raw = it?.title ? String(it.title) : "";
      if (!raw) continue;
      const t = normTitle(raw);
      if (!keywords.some(kw => kw && t.includes(kw))) continue;

      if (!currentMatched.has(t)) {
        currentMatched.add(t);
        const loc = composeLocation(it);
        currentMeta.set(t, { title: raw, location: loc });
        try { log("info", `keywordMatch: "${raw}"${loc?` [${loc}]`:""}`); } catch {}
      }
    }

    let sent = 0;
    for (const key of currentMatched) {
      const meta = currentMeta.get(key) || { title: key, location: "" };

      const dedupeKey = `${norm(meta.title)}|${norm(meta.location)}`;
      if (!lastCycleMatches.has(key) && !persistedKeys.has(dedupeKey)) {
        const { text, extra } = buildFancyMessage(meta.title, meta.location);
        try { await Promise.resolve(send(text, extra)); sent += 1; }
        catch (e) { try { log("error", `keywordMatch send failed: ${e.message}`); } catch {} }
      }

      persistIfNew(meta.title, meta.location);
    }

    lastCycleMatches = currentMatched.size ? currentMatched : new Set();
    return { sent, matched: Array.from(currentMeta.values()).map(m => m.location ? `${m.title} — ${m.location}` : m.title) };
  }

  return { processCycle };
}


// --- Injected reset function ---
function resetLogs(){
  try { jsonRows = Array.isArray(jsonRows) ? [] : []; } catch(e){}
  try { if (typeof writeJson === 'function') writeJson(); } catch(e){}
  try { if (typeof flush === 'function') flush(); } catch(e){}
  try { if (typeof persistJSON === 'function') persistJSON(); } catch(e){}  const fs = require('fs');
  const path = require('path');
  try { fs.writeFileSync(path.resolve(__dirname, 'Reports/keyword_matches.json'), '[]', 'utf8'); } catch(e){}
  try { fs.writeFileSync(path.resolve(__dirname, './Reports/keyword_matches.json'), '[]', 'utf8'); } catch(e){}

}
// --- end injected ---

module.exports = { createKeywordMatcher };
