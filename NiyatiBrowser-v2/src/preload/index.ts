/**
 * Preload Script
 * Secure IPC bridge between renderer and main process
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

// ============================================================================
// Validation Helpers
// ============================================================================

function validateNumber(n: unknown, min = 0, max = Infinity): number {
  const num = Number(n);
  if (!Number.isFinite(num) || num < min || num > max) {
    throw new TypeError(`Invalid number: ${n} (must be between ${min} and ${max})`);
  }
  return num;
}

function validateArray<T>(arr: unknown, maxLen = 1000): T[] {
  if (!Array.isArray(arr)) {
    throw new TypeError('Expected array');
  }
  if (arr.length > maxLen) {
    throw new Error(`Array exceeds max length ${maxLen}`);
  }
  return arr as T[];
}

function validateCredentials(creds: unknown): { user: string; pass: string } {
  if (!creds || typeof creds !== 'object') {
    throw new TypeError('Invalid credentials object');
  }

  const obj = creds as Record<string, unknown>;

  let user = '';
  if ('user' in obj) {
    user = typeof obj.user === 'string' ? obj.user : String(obj.user || '');
  }

  let pass = '';
  if ('pass' in obj) {
    pass = typeof obj.pass === 'string' ? obj.pass : String(obj.pass || '');
  }

  // Length limits
  user = user.slice(0, 100).trim();
  pass = pass.slice(0, 256).trim();

  // Validate not empty
  if (!user || !pass) {
    throw new Error('Username and password are required');
  }

  return { user, pass };
}

// ============================================================================
// API Exposure
// ============================================================================

const api = {
  // ============================================================================
  // Authentication
  // ============================================================================
  auth: {
    unlock: async (creds: unknown) => {
      const validated = validateCredentials(creds);
      return await ipcRenderer.invoke('lock:unlock', validated);
    },

    isUnlocked: async () => {
      return await ipcRenderer.invoke('lock:isUnlocked');
    },
  },

  // ============================================================================
  // Window Controls
  // ============================================================================
  window: {
    minimize: () => {
      ipcRenderer.send('win:minimize');
    },

    maximize: () => {
      ipcRenderer.send('win:maximize');
    },

    close: () => {
      ipcRenderer.send('win:close');
    },

    onStateChange: (callback: (state: string) => void) => {
      const listener = (_event: IpcRendererEvent, state: string) => callback(state);
      ipcRenderer.on('win:state', listener);
      return () => ipcRenderer.removeListener('win:state', listener);
    },
  },

  // ============================================================================
  // Lists Management
  // ============================================================================
  lists: {
    saveProducts: async (items: unknown) => {
      const validated = validateArray<string>(items, 1000);
      return await ipcRenderer.invoke('lists:saveProducts', validated);
    },

    saveKeywords: async (items: unknown) => {
      const validated = validateArray<string>(items, 1000);
      return await ipcRenderer.invoke('lists:saveKeywords', validated);
    },
  },

  // ============================================================================
  // Refresh Control
  // ============================================================================
  refresh: {
    enable: async (intervalMs: unknown) => {
      const validated = validateNumber(intervalMs, 3000, 3600000);
      return await ipcRenderer.invoke('refresh:enable', validated);
    },

    disable: async () => {
      return await ipcRenderer.invoke('refresh:disable');
    },

    getState: async () => {
      return await ipcRenderer.invoke('refresh:getState');
    },

    onStateChange: (callback: (state: unknown) => void) => {
      const listener = (_event: IpcRendererEvent, state: unknown) => callback(state);
      ipcRenderer.on('refresh:state', listener);
      return () => ipcRenderer.removeListener('refresh:state', listener);
    },
  },

  // ============================================================================
  // Logging
  // ============================================================================
  log: {
    onAppend: (callback: (entry: unknown) => void) => {
      const listener = (_event: IpcRendererEvent, entry: unknown) => callback(entry);
      ipcRenderer.on('log:append', listener);
      return () => ipcRenderer.removeListener('log:append', listener);
    },
  },

  // ============================================================================
  // System
  // ============================================================================
  system: {
    getVersion: async () => {
      return await ipcRenderer.invoke('system:getVersion');
    },

    getInfo: async () => {
      return await ipcRenderer.invoke('system:getInfo');
    },
  },
};

// ============================================================================
// Expose API to Renderer
// ============================================================================

contextBridge.exposeInMainWorld('niyatiAPI', api);

// ============================================================================
// TypeScript Declarations (for renderer)
// ============================================================================

declare global {
  interface Window {
    niyatiAPI: typeof api;
  }
}

export type NiyatiAPI = typeof api;
