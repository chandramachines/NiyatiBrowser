const { contextBridge, ipcRenderer } = require("electron");

function makeOn(channelA, channelB) {
  return (cb) => {
    if (typeof cb !== "function") throw new TypeError("callback must be a function");
    const fn = (_e, payload) => {
      try { cb(payload); } catch {}
    };
    try { ipcRenderer.on(channelA, fn); } catch {}
    if (channelB) { try { ipcRenderer.on(channelB, fn); } catch {} }
    return () => {
      try { ipcRenderer.removeListener(channelA, fn); } catch {}
      if (channelB) { try { ipcRenderer.removeListener(channelB, fn); } catch {} }
    };
  };
}

const NiyatiWindow = Object.freeze({
  minimize: () => ipcRenderer.invoke("win:minimize"),
  maximize: () => ipcRenderer.invoke("win:maximize"),
  close:    () => ipcRenderer.invoke("win:close"),
  onState:  makeOn("win:state")
});

const LeadsRefresh = Object.freeze({
  getState: () => ipcRenderer.invoke("leads:getState"),
  start:    (ms) => ipcRenderer.invoke("leads:start", ms),
  stop:     () => ipcRenderer.invoke("leads:stop"),
  onState:  makeOn("refresh:state", "leads:state")
});

const Logs = Object.freeze({
  onAppend: makeOn("log:append")
});

const NetBridge = Object.freeze({
  report: (online) => {
    try { ipcRenderer.send("net:status", !!online); } catch {}
  }
});

const Lists = Object.freeze({
  saveProducts: (arr) => ipcRenderer.invoke("lists:saveProducts", Array.isArray(arr) ? arr : []),
  saveKeywords: (arr) => ipcRenderer.invoke("lists:saveKeywords", Array.isArray(arr) ? arr : []),
});

const MC = Object.freeze({
  run: () => ipcRenderer.invoke("mc:manual")
});

try { contextBridge.exposeInMainWorld("NiyatiWindow", NiyatiWindow); } catch {}
try { contextBridge.exposeInMainWorld("LeadsRefresh",  LeadsRefresh); } catch {}
try { contextBridge.exposeInMainWorld("Logs",          Logs); } catch {}
try { contextBridge.exposeInMainWorld("NetBridge",     NetBridge); } catch {}
try { contextBridge.exposeInMainWorld("Lists",         Lists); } catch {}
try { contextBridge.exposeInMainWorld("MC",            MC); } catch {}
