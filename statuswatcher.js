// ✅ Status Watcher - Enhanced with validation and error handling

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
  // ✅ Input validation
  if (!win || typeof win !== 'object') {
    throw new TypeError('createStatusWatcher: win parameter is required');
  }
  
  if (typeof selector !== 'string' || !selector.trim()) {
    throw new TypeError('createStatusWatcher: selector must be a non-empty string');
  }
  
  if (typeof checkEveryMs !== 'number' || checkEveryMs < 100 || checkEveryMs > 60000) {
    throw new RangeError('createStatusWatcher: checkEveryMs must be between 100 and 60000');
  }
  
  const S = {
    selector,
    timer: null,
    inReload: false,

    isOnline: true,
    isOnlineStable: true,
    lastOnlineChangeAt: 0,
    consecProbeFails: 0,
    offlineHysteresisMs: 2000,
    onlineStableAfterMs: 5000,

    lastLoginState: null,
    lastLoginAt: 0,
    missCount: 0,
    REQUIRED_MISSES: 3,
    logoutQuarantineMs: 5000,

    tickBusy: false,
    lastReloadAt: 0,
    maxReloadMs: 20000,
    
    // ✅ Track errors to prevent spam
    errorCount: 0,
    lastErrorAt: 0,
    errorThrottleMs: 5000,
  };

  // ✅ Enhanced safe wrapper with better error handling
  const safe = (fn) => { 
    try { 
      return fn(); 
    } catch (e) {
      // Log but don't throw
      const now = Date.now();
      if (now - S.lastErrorAt > S.errorThrottleMs) {
        console.error('[statuswatcher] safe() error:', e.message);
        S.lastErrorAt = now;
      }
      return undefined;
    }
  };
  
  const now = () => Date.now();
  
  // ✅ Enhanced JS execution with validation
  const js = async (code) => {
    if (!win || !win.webContents) {
      throw new Error('Window or webContents is not available');
    }
    if (win.isDestroyed && win.isDestroyed()) {
      throw new Error('Window is destroyed');
    }
    return await win.webContents.executeJavaScript(code, true);
  };
  
  // ✅ Enhanced exists check with proper error handling
  const exists = async (sel) => {
    try {
      if (typeof sel !== 'string') return false;
      const result = await js(`!!document.querySelector(${JSON.stringify(sel)})`);
      return Boolean(result);
    } catch (e) {
      return false;
    }
  };

  // ✅ Enhanced network check with timeout
  async function checkNetwork() {
    try {
      // Timeout protection for hostProbe
      const probePromise = hostProbe();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Network probe timeout')), 10000)
      );
      
      const ok = await Promise.race([probePromise, timeoutPromise]);
      
      if (ok) {
        if (!S.isOnline) {
          S.isOnline = true;
          S.consecProbeFails = 0;
          S.lastOnlineChangeAt = now();
          safe(() => onOnline());
        } else {
          S.consecProbeFails = 0;
        }
      } else if (++S.consecProbeFails >= 3 && S.isOnline) {
        S.isOnline = false;
        S.isOnlineStable = false;
        S.lastOnlineChangeAt = now();
        safe(() => onOffline());
      }
      
      // Update stable state
      if (S.isOnline && !S.isOnlineStable && now() - S.lastOnlineChangeAt >= S.onlineStableAfterMs) {
        S.isOnlineStable = true;
      }
    } catch (e) {
      // Don't spam errors
      const n = now();
      if (n - S.lastErrorAt > S.errorThrottleMs) {
        safe(() => onError(e));
        S.lastErrorAt = n;
      }
      
      // Treat timeout as offline
      if (++S.consecProbeFails >= 3 && S.isOnline) {
        S.isOnline = false;
        S.isOnlineStable = false;
        S.lastOnlineChangeAt = n;
        safe(() => onOffline());
      }
    }
  }

  // ✅ Enhanced auth check with better state management
  async function checkAuth() {
    if (!S.isOnline || !S.isOnlineStable || S.inReload) return;
    
    try {
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

      // ✅ Increment miss count carefully
      if (++S.missCount < S.REQUIRED_MISSES) return;
      
      // ✅ Quarantine period to prevent rapid logout triggers
      if (S.lastLoginAt && now() - S.lastLoginAt < S.logoutQuarantineMs) return;
      
      // ✅ Double-check before declaring logout
      if (await exists(S.selector)) {
        S.missCount = 0;
        return;
      }

      if (S.lastLoginState !== false) {
        S.lastLoginState = false;
        safe(() => onLogout());
      }
    } catch (e) {
      // Silently handle auth check errors
      S.errorCount++;
    }
  }

  // ✅ Enhanced tick with better concurrency control
  async function tick() {
    if (S.tickBusy) return;
    S.tickBusy = true;
    try {
      // ✅ Reload timeout protection
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

  // ✅ Enhanced start with duplicate prevention
  function start() {
    if (S.timer) {
      console.warn('[statuswatcher] Already started, ignoring duplicate start()');
      return;
    }
    S.timer = setInterval(() => { 
      tick().catch(e => {
        const n = now();
        if (n - S.lastErrorAt > S.errorThrottleMs) {
          console.error('[statuswatcher] tick error:', e.message);
          S.lastErrorAt = n;
        }
      }); 
    }, checkEveryMs);
  }
  
  // ✅ Enhanced stop with complete cleanup
  function stop() {
    if (S.timer) { 
      clearInterval(S.timer); 
      S.timer = null; 
    }
    // Clean up state
    S.tickBusy = false;
    S.missCount = 0;
    S.errorCount = 0;
    S.consecProbeFails = 0;
  }
  
  // ✅ Enhanced setReloading with validation
  function setReloading(flag) {
    S.inReload = Boolean(flag);
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
        errorCount: S.errorCount,
      };
    },
  };
}

// ✅ Enhanced attachFailLoad with input validation
function attachFailLoad(win, errorCodes = new Set([-106, -105, -118]), onOffline = () => {}) {
  if (!win || !win.webContents) {
    console.error('[statuswatcher] attachFailLoad: invalid window');
    return;
  }
  
  if (!(errorCodes instanceof Set)) {
    console.error('[statuswatcher] attachFailLoad: errorCodes must be a Set');
    return;
  }
  
  try {
    win.webContents.on("did-fail-load", (_e, code) => { 
      if (errorCodes.has(code)) {
        try {
          onOffline();
        } catch (e) {
          console.error('[statuswatcher] onOffline callback error:', e.message);
        }
      }
    });
  } catch (e) {
    console.error('[statuswatcher] attachFailLoad failed:', e.message);
  }
}

module.exports = { createStatusWatcher, attachFailLoad };
