// visibility-monitor.js
// Monitors page visibility to detect background throttling

function injectVisibilityMonitor(win, onVisibilityChange) {
  if (!win || win.isDestroyed()) return;
  
  const code = `
    (function() {
      if (window.__niyatiVisibilityMonitor) return;
      window.__niyatiVisibilityMonitor = true;
      
      let lastState = !document.hidden;
      
      function checkVisibility() {
        const nowHidden = document.hidden;
        if (nowHidden !== !lastState) {
          lastState = !nowHidden;
          console.log('[Niyati] Visibility changed:', lastState ? 'VISIBLE' : 'HIDDEN');
        }
        
        // Update marker
        const marker = document.getElementById('niyati-visibility-marker') || 
                      document.createElement('div');
        marker.id = 'niyati-visibility-marker';
        marker.setAttribute('data-visible', String(lastState));
        marker.setAttribute('data-last-check', Date.now());
        marker.style.display = 'none';
        if (!marker.parentNode) document.body.appendChild(marker);
      }
      
      document.addEventListener('visibilitychange', checkVisibility);
      
      // Periodic check as backup
      setInterval(checkVisibility, 5000);
      
      console.log('[Niyati] Visibility monitor installed');
      checkVisibility();
    })();
  `;
  
  try {
    win.webContents.executeJavaScript(code, true);
  } catch (e) {
    console.error('Failed to inject visibility monitor:', e);
  }
}

module.exports = { injectVisibilityMonitor };
