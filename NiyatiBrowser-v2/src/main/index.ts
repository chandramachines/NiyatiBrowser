/**
 * NiyatiBrowser v2.0 - Main Process
 * Complete rebuild with modern architecture
 */

import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import * as path from 'path';
import { getConfig } from './config';
import { WindowManager } from './windows';
import { setupIPC } from './ipc';
import { cleanupAuth } from '../core/security/auth';

// ============================================================================
// Application State
// ============================================================================

class NiyatiBrowser {
  private config = getConfig();
  private windowManager: WindowManager | null = null;
  private isQuitting = false;
  private startTime = Date.now();

  /**
   * Initialize application
   */
  async initialize(): Promise<void> {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║                                                      ║');
    console.log('║          Niyati Browser v2.0 Starting...            ║');
    console.log('║          Built from Scratch with TypeScript         ║');
    console.log('║                                                      ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('');

    // Set up Electron app events
    this.setupAppEvents();

    // Wait for app to be ready
    await app.whenReady();

    // Setup IPC handlers
    setupIPC(ipcMain, this.config);

    // Create windows
    this.windowManager = new WindowManager(this.config);
    await this.windowManager.createWindows();

    console.log('✅ Application initialized successfully');
    console.log(`   Uptime: ${this.getUptime()}`);
  }

  /**
   * Setup application event handlers
   */
  private setupAppEvents(): void {
    // macOS: Re-create window when dock icon is clicked
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        this.windowManager?.createWindows();
      }
    });

    // All windows closed
    app.on('window-all-closed', () => {
      // macOS: Don't quit when all windows closed
      if (process.platform !== 'darwin') {
        this.quit();
      }
    });

    // App is quitting
    app.on('before-quit', () => {
      this.isQuitting = true;
    });

    // Cleanup before exit
    app.on('will-quit', async (event) => {
      event.preventDefault();
      await this.cleanup();
      app.exit(0);
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      // Don't quit, just log
    });

    // Handle unhandled rejections
    process.on('unhandledRejection', (reason) => {
      console.error('Unhandled Rejection:', reason);
      // Don't quit, just log
    });
  }

  /**
   * Cleanup resources
   */
  private async cleanup(): Promise<void> {
    console.log('[Cleanup] Starting cleanup...');

    try {
      // Cleanup window manager
      if (this.windowManager) {
        await this.windowManager.cleanup();
      }

      // Cleanup auth
      cleanupAuth();

      console.log('[Cleanup] Cleanup complete');
    } catch (error) {
      console.error('[Cleanup] Error during cleanup:', error);
    }
  }

  /**
   * Quit application
   */
  quit(): void {
    if (!this.isQuitting) {
      app.quit();
    }
  }

  /**
   * Restart application
   */
  restart(): void {
    app.relaunch();
    this.quit();
  }

  /**
   * Get application uptime
   */
  private getUptime(): string {
    const uptimeMs = Date.now() - this.startTime;
    const seconds = Math.floor(uptimeMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}

// ============================================================================
// Application Entry Point
// ============================================================================

const browser = new NiyatiBrowser();

browser.initialize().catch((error) => {
  console.error('Failed to initialize application:', error);
  app.quit();
});

// ============================================================================
// Global Error Handling
// ============================================================================

process.on('SIGTERM', () => {
  console.log('[Signal] SIGTERM received, shutting down...');
  browser.quit();
});

process.on('SIGINT', () => {
  console.log('[Signal] SIGINT received, shutting down...');
  browser.quit();
});

// ============================================================================
// Security
// ============================================================================

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('[Security] Another instance is already running');
  app.quit();
} else {
  app.on('second-instance', () => {
    console.log('[Security] Second instance attempted, focusing existing window');
    // Focus the main window if minimized
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      const mainWindow = windows[0];
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Disable hardware acceleration on Linux (prevents some issues)
if (process.platform === 'linux') {
  app.disableHardwareAcceleration();
}

// Set app user model ID for Windows notifications
if (process.platform === 'win32') {
  app.setAppUserModelId('com.niyati.browser');
}
