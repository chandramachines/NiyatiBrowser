/**
 * Window Management
 * Creates and manages Electron windows
 */

import { BrowserWindow, nativeTheme } from 'electron';
import * as path from 'path';
import { AppConfig } from '../types';

// ============================================================================
// Window Manager
// ============================================================================

export class WindowManager {
  private managerWindow: BrowserWindow | null = null;
  private leadsWindow: BrowserWindow | null = null;
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * Create all windows
   */
  async createWindows(): Promise<void> {
    // Create manager window
    this.managerWindow = await this.createManagerWindow();

    // Create leads window
    this.leadsWindow = await this.createLeadsWindow();

    console.log('[Windows] All windows created');
  }

  /**
   * Create Manager window
   */
  private async createManagerWindow(): Promise<BrowserWindow> {
    const win = new BrowserWindow({
      title: 'Niyati Browser - Manager',
      width: 1200,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      show: false,
      frame: false,
      titleBarStyle: 'hidden',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#111111' : '#0f0f10',
      webPreferences: {
        // ✅ Security-first configuration
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
      },
    });

    // Load manager UI
    const indexPath = path.join(__dirname, '..', '..', 'renderer', 'manager', 'index.html');
    await win.loadFile(indexPath);

    // Show when ready
    win.once('ready-to-show', () => {
      if (!this.config.lockOnStart) {
        win.show();
      }
      console.log('[Windows] Manager window ready');
    });

    // Handle window events
    this.setupManagerWindowEvents(win);

    // DevTools in development
    if (process.env.NODE_ENV === 'development') {
      win.webContents.openDevTools({ mode: 'detach' });
    }

    return win;
  }

  /**
   * Create Leads window
   */
  private async createLeadsWindow(): Promise<BrowserWindow> {
    const win = new BrowserWindow({
      title: 'Niyati Browser - Leads',
      width: 1280,
      height: 720,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
      },
    });

    // Maximize window
    win.maximize();

    // Load IndiaMART leads page
    const url = 'https://seller.indiamart.com/bltxn/?pref=recent';
    await win.loadURL(url);

    // Show when ready
    win.once('ready-to-show', () => {
      if (!this.config.lockOnStart) {
        win.show();
      }
      console.log('[Windows] Leads window ready');
    });

    // Handle window events
    this.setupLeadsWindowEvents(win);

    return win;
  }

  /**
   * Setup manager window event handlers
   */
  private setupManagerWindowEvents(win: BrowserWindow): void {
    // Send window state changes
    const sendState = () => {
      win.webContents.send('win:state', win.isMaximized() ? 'max' : 'restored');
    };

    win.on('maximize', sendState);
    win.on('unmaximize', sendState);
    win.on('focus', sendState);
    win.on('enter-full-screen', sendState);
    win.on('leave-full-screen', sendState);

    win.on('closed', () => {
      this.managerWindow = null;
      console.log('[Windows] Manager window closed');
    });
  }

  /**
   * Setup leads window event handlers
   */
  private setupLeadsWindowEvents(win: BrowserWindow): void {
    win.on('show', () => {
      console.log('[Windows] Leads window visible');
    });

    win.on('hide', () => {
      console.log('[Windows] Leads window hidden');
    });

    win.on('closed', () => {
      this.leadsWindow = null;
      console.log('[Windows] Leads window closed');
    });

    // Handle page load events
    win.webContents.on('did-finish-load', () => {
      console.log('[Windows] Leads page loaded');
    });

    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.error(`[Windows] Leads page failed to load: ${errorCode} - ${errorDescription}`);
    });
  }

  /**
   * Get manager window
   */
  getManagerWindow(): BrowserWindow | null {
    return this.managerWindow;
  }

  /**
   * Get leads window
   */
  getLeadsWindow(): BrowserWindow | null {
    return this.leadsWindow;
  }

  /**
   * Focus manager window
   */
  focusManager(): boolean {
    if (this.managerWindow && !this.managerWindow.isDestroyed()) {
      if (this.managerWindow.isMinimized()) {
        this.managerWindow.restore();
      }
      this.managerWindow.focus();
      return true;
    }
    return false;
  }

  /**
   * Focus leads window
   */
  focusLeads(): boolean {
    if (this.leadsWindow && !this.leadsWindow.isDestroyed()) {
      if (this.leadsWindow.isMinimized()) {
        this.leadsWindow.restore();
      }
      this.leadsWindow.focus();
      return true;
    }
    return false;
  }

  /**
   * Toggle manager window maximize
   */
  toggleMaximize(): boolean {
    if (this.managerWindow && !this.managerWindow.isDestroyed()) {
      if (this.managerWindow.isMaximized()) {
        this.managerWindow.unmaximize();
      } else {
        this.managerWindow.maximize();
      }
      return true;
    }
    return false;
  }

  /**
   * Hide all windows (lock)
   */
  hideAll(): void {
    if (this.managerWindow && !this.managerWindow.isDestroyed()) {
      this.managerWindow.hide();
    }
    if (this.leadsWindow && !this.leadsWindow.isDestroyed()) {
      this.leadsWindow.hide();
    }
    console.log('[Windows] All windows hidden (locked)');
  }

  /**
   * Show all windows (unlock)
   */
  showAll(): void {
    if (this.managerWindow && !this.managerWindow.isDestroyed()) {
      this.managerWindow.show();
    }
    if (this.leadsWindow && !this.leadsWindow.isDestroyed()) {
      this.leadsWindow.show();
    }
    console.log('[Windows] All windows shown (unlocked)');
  }

  /**
   * Reload manager window
   */
  reloadManager(): boolean {
    if (this.managerWindow && !this.managerWindow.isDestroyed()) {
      this.managerWindow.webContents.reload();
      return true;
    }
    return false;
  }

  /**
   * Reload leads window
   */
  async reloadLeads(): Promise<boolean> {
    if (this.leadsWindow && !this.leadsWindow.isDestroyed()) {
      this.leadsWindow.webContents.reloadIgnoringCache();
      return true;
    }
    return false;
  }

  /**
   * Cleanup windows
   */
  async cleanup(): Promise<void> {
    console.log('[Windows] Cleaning up windows...');

    if (this.managerWindow && !this.managerWindow.isDestroyed()) {
      this.managerWindow.close();
    }

    if (this.leadsWindow && !this.leadsWindow.isDestroyed()) {
      this.leadsWindow.close();
    }

    this.managerWindow = null;
    this.leadsWindow = null;
  }
}
