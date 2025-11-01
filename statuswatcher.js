function createStatusWatcher({
  win,
  selector = "#selsout",
  checkEveryMs = 1200,
  hostProbe = async () => true,
  onLogin = () => {},
  onLogout = () => {},
  onOffline = () => {},
  onOnline = () => {},
  onError = () => {},
}) {
  const S = {
    selector,
    timer: null,
    inReload: false,

    isOnline: true,
    isOnlineStable: true,
    lastOnlineChangeAt: 0,
    consecProbeFails: 0,
    offlineHysteresisMs: 2000,   // tighter hysteresis
    onlineStableAfterMs: 5000,   // longer stabilization

    lastLoginState: null,
    lastLoginAt: 0,
    missCount: 0,
    REQUIRED_MISSES: 3,
    logoutQuarantineMs: 5000,

    tickBusy: false,
    lastReloadAt: 0,
    maxReloadMs: 20000, // force-clear inReload after 20s if it lingers
  };

  const safe = (fn) => { try { return fn(); } catch {} };
  const now = () => Date.now();
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const exists = async (sel) => safe(() => js(`!!document.querySelector(${JSON.stringify(sel)})`)) ?? false;

  async function checkNetwork() {
    try {
      const ok = await hostProbe();
      if (ok) {
        if (!S.isOnline) {
          S.isOnline = true;
          S.consecProbeFails = 0;
          S.lastOnlineChangeAt = now();
          safe(() => onOnline());
        } else {
          S.consecProbeFails = 0;
        }
      } else if (++S.consecProbeFails >= 3 && S.isOnline) {   // was 2 → 3
        S.isOnline = false;
        S.isOnlineStable = false;
        S.lastOnlineChangeAt = now();
        safe(() => onOffline());
      }
      if (S.isOnline && !S.isOnlineStable && now() - S.lastOnlineChangeAt >= S.onlineStableAfterMs) {
        S.isOnlineStable = true;
      }
    } catch (e) {
      safe(() => onError(e));
    }
  }

  async function checkAuth() {
    if (!S.isOnline || !S.isOnlineStable || S.inReload) return;
    const ready = (await safe(() => js("document.readyState"))) || "";
    if (ready !== "interactive" && ready !== "complete") return;

    if (await exists(S.selector)) {
      S.missCount = 0;
      if (S.lastLoginState !== true) {
        S.lastLoginState = true;
        S.lastLoginAt = now();
        safe(() => onLogin());
      }
      return;
    }

    if (++S.missCount < S.REQUIRED_MISSES) return;
    if (S.lastLoginAt && now() - S.lastLoginAt < S.logoutQuarantineMs) return;
    if (await exists(S.selector)) {
      S.missCount = 0;
      return;
    }

    if (S.lastLoginState !== false) {
      S.lastLoginState = false;
      safe(() => onLogout());
    }
  }

  async function tick() {
    if (S.tickBusy) return;         // NEW: prevent overlaps
    S.tickBusy = true;
    try {
      if (S.inReload && S.lastReloadAt && (now() - S.lastReloadAt > S.maxReloadMs)) {
        S.inReload = false;
      }
      await checkNetwork();
      if (S.isOnline) await checkAuth();
    } catch (e) {
      try { onError(e); } catch {}
    } finally {
      S.tickBusy = false;
    }
  }

  function start() {
    if (!S.timer) S.timer = setInterval(() => { tick().catch(() => {}); }, checkEveryMs);
  }
  function stop() {
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
  }
  function setReloading(flag) {
    S.inReload = !!flag;
    if (flag) S.lastReloadAt = now();
  }

  return {
    start,
    stop,
    setReloading,
    get state() {
      return {
        isOnline: S.isOnline,
        isOnlineStable: S.isOnlineStable,
        inReload: S.inReload,
        lastLoginState: S.lastLoginState,
        missCount: S.missCount,
      };
    },
  };
}

function attachFailLoad(win, errorCodes = new Set([-106, -105, -118]), onOffline = () => {}) {
  try {
    win.webContents.on("did-fail-load", (_e, code) => { if (errorCodes.has(code)) onOffline(); });
  } catch {}
}

module.exports = { createStatusWatcher, attachFailLoad };
