/**
 * IPC Handlers
 * Main process communication handlers
 */

import { IpcMain, BrowserWindow } from 'electron';
import { AppConfig, IPCResponse } from '../../types';
import { authenticate } from '../../core/security/auth';
import { validateNumber, validateArray, validateString } from '../../core/security/validation';

// ============================================================================
// IPC Setup
// ============================================================================

export function setupIPC(ipcMain: IpcMain, config: AppConfig): void {
  console.log('[IPC] Setting up IPC handlers...');

  // Authentication
  setupAuthHandlers(ipcMain, config);

  // Window controls
  setupWindowHandlers(ipcMain);

  // Lists management
  setupListsHandlers(ipcMain);

  // Refresh control
  setupRefreshHandlers(ipcMain);

  // System
  setupSystemHandlers(ipcMain);

  console.log('[IPC] IPC handlers ready');
}

// ============================================================================
// Authentication Handlers
// ============================================================================

function setupAuthHandlers(ipcMain: IpcMain, config: AppConfig): void {
  // Unlock with credentials
  ipcMain.handle('lock:unlock', async (_event, creds): Promise<IPCResponse<boolean>> => {
    try {
      const result = await authenticate(
        creds,
        config.lockUser,
        config.lockPass,
        'lock-screen'
      );

      return {
        success: result.valid,
        data: result.valid,
        error: result.reason,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Authentication failed',
      };
    }
  });

  // Check if unlocked (persisted state)
  ipcMain.handle('lock:isUnlocked', async (): Promise<IPCResponse<boolean>> => {
    try {
      // TODO: Implement persistence check
      return {
        success: true,
        data: false,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to check lock state',
      };
    }
  });
}

// ============================================================================
// Window Control Handlers
// ============================================================================

function setupWindowHandlers(ipcMain: IpcMain): void {
  // Minimize window
  ipcMain.on('win:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });

  // Maximize/restore window
  ipcMain.on('win:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;

    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  // Close window
  ipcMain.on('win:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
  });
}

// ============================================================================
// Lists Management Handlers
// ============================================================================

function setupListsHandlers(ipcMain: IpcMain): void {
  // Save products list
  ipcMain.handle('lists:saveProducts', async (_event, items): Promise<IPCResponse<boolean>> => {
    try {
      // Validate input
      const validation = validateArray(items, {
        maxLength: 1000,
        itemValidator: (item) => validateString(item, { maxLength: 200 }),
      });

      if (!validation.valid) {
        return {
          success: false,
          error: validation.error,
        };
      }

      // TODO: Implement save logic
      console.log('[IPC] Products saved:', items);

      return {
        success: true,
        data: true,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save products',
      };
    }
  });

  // Save keywords list
  ipcMain.handle('lists:saveKeywords', async (_event, items): Promise<IPCResponse<boolean>> => {
    try {
      // Validate input
      const validation = validateArray(items, {
        maxLength: 1000,
        itemValidator: (item) => validateString(item, { maxLength: 100 }),
      });

      if (!validation.valid) {
        return {
          success: false,
          error: validation.error,
        };
      }

      // TODO: Implement save logic
      console.log('[IPC] Keywords saved:', items);

      return {
        success: true,
        data: true,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save keywords',
      };
    }
  });
}

// ============================================================================
// Refresh Control Handlers
// ============================================================================

function setupRefreshHandlers(ipcMain: IpcMain): void {
  // Enable auto-refresh
  ipcMain.handle('refresh:enable', async (_event, intervalMs): Promise<IPCResponse<boolean>> => {
    try {
      // Validate interval
      const validation = validateNumber(intervalMs, {
        min: 3000,
        max: 3600000,
      });

      if (!validation.valid) {
        return {
          success: false,
          error: validation.error,
        };
      }

      // TODO: Implement enable logic
      console.log('[IPC] Auto-refresh enabled:', intervalMs);

      return {
        success: true,
        data: true,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to enable refresh',
      };
    }
  });

  // Disable auto-refresh
  ipcMain.handle('refresh:disable', async (): Promise<IPCResponse<boolean>> => {
    try {
      // TODO: Implement disable logic
      console.log('[IPC] Auto-refresh disabled');

      return {
        success: true,
        data: true,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to disable refresh',
      };
    }
  });

  // Get refresh state
  ipcMain.handle('refresh:getState', async (): Promise<IPCResponse<Record<string, unknown>>> => {
    try {
      // TODO: Implement get state logic
      const state = {
        enabled: false,
        intervalMs: 7000,
      };

      return {
        success: true,
        data: state,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get refresh state',
      };
    }
  });
}

// ============================================================================
// System Handlers
// ============================================================================

function setupSystemHandlers(ipcMain: IpcMain): void {
  // Get app version
  ipcMain.handle('system:getVersion', async (): Promise<IPCResponse<string>> => {
    try {
      const { version } = require('../../../package.json');
      return {
        success: true,
        data: version,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get version',
      };
    }
  });

  // Get system info
  ipcMain.handle('system:getInfo', async (): Promise<IPCResponse<Record<string, unknown>>> => {
    try {
      const info = {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        electronVersion: process.versions.electron,
        memory: {
          rss: process.memoryUsage().rss,
          heapTotal: process.memoryUsage().heapTotal,
          heapUsed: process.memoryUsage().heapUsed,
        },
      };

      return {
        success: true,
        data: info,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get system info',
      };
    }
  });
}
