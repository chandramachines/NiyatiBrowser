/**
 * Status Watcher Module
 * Monitors application status and sends alerts
 */

import { BrowserWindow } from 'electron';
import { TelegramBot } from '../telegram/TelegramBot';

// ============================================================================
// Constants
// ============================================================================

const CHECK_INTERVAL_MS = 30000; // Check every 30 seconds
const OFFLINE_THRESHOLD_MS = 60000; // 1 minute
const HEARTBEAT_INTERVAL_MS = 300000; // 5 minutes

// ============================================================================
// Status State
// ============================================================================

interface StatusState {
  isOnline: boolean;
  isLoggedIn: boolean | null;
  lastOnlineAt: number;
  lastOfflineAt: number;
  lastLoginAt: number;
  lastLogoutAt: number;
  lastHeartbeat: number;
  offlineAlertSent: boolean;
  logoutAlertSent: boolean;
}

// ============================================================================
// Status Watcher Class
// ============================================================================

export class StatusWatcher {
  private window: BrowserWindow;
  private telegramBot: TelegramBot | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isWatching = false;

  private state: StatusState = {
    isOnline: true,
    isLoggedIn: null,
    lastOnlineAt: Date.now(),
    lastOfflineAt: 0,
    lastLoginAt: 0,
    lastLogoutAt: 0,
    lastHeartbeat: Date.now(),
    offlineAlertSent: false,
    logoutAlertSent: false,
  };

  constructor(
    window: BrowserWindow,
    private onLog: (level: string, msg: string) => void = () => {}
  ) {
    this.window = window;
  }

  /**
   * Initialize status watcher
   */
  async initialize(telegramBot: TelegramBot): Promise<void> {
    this.telegramBot = telegramBot;

    // Start watching
    this.startWatching();

    // Start heartbeat
    this.startHeartbeat();

    this.log('info', 'StatusWatcher initialized');
  }

  /**
   * Start watching status
   */
  private startWatching(): void {
    if (this.isWatching) return;

    this.isWatching = true;

    this.checkTimer = setInterval(() => {
      this.checkStatus();
    }, CHECK_INTERVAL_MS);

    // Initial check
    this.checkStatus();

    this.log('info', 'Status watching started');
  }

  /**
   * Stop watching status
   */
  private stopWatching(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }

    this.isWatching = false;
    this.log('info', 'Status watching stopped');
  }

  /**
   * Start heartbeat
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);

    // Initial heartbeat
    this.sendHeartbeat();

    this.log('info', 'Heartbeat started');
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.log('info', 'Heartbeat stopped');
  }

  /**
   * Check status
   */
  private async checkStatus(): Promise<void> {
    try {
      // Check network status
      await this.checkNetworkStatus();

      // Check login status
      await this.checkLoginStatus();
    } catch (error) {
      this.log('error', `Status check error: ${error}`);
    }
  }

  /**
   * Check network status
   */
  private async checkNetworkStatus(): Promise<void> {
    if (this.window.isDestroyed()) return;

    try {
      const isOnline = await this.window.webContents.executeJavaScript(`
        navigator.onLine
      `);

      // Detect status change
      if (isOnline !== this.state.isOnline) {
        if (isOnline) {
          this.handleOnline();
        } else {
          this.handleOffline();
        }
      }

      this.state.isOnline = isOnline;
    } catch (error) {
      // Assume offline if error
      if (this.state.isOnline) {
        this.handleOffline();
      }
      this.state.isOnline = false;
    }
  }

  /**
   * Check login status
   */
  private async checkLoginStatus(): Promise<void> {
    if (this.window.isDestroyed()) return;

    try {
      const isLoggedIn = await this.window.webContents.executeJavaScript(`
        (function() {
          // Check for login indicators
          const indicators = [
            '#selsout',
            '.logout',
            '[data-user]',
          ];

          for (const selector of indicators) {
            if (document.querySelector(selector)) {
              return true;
            }
          }

          // Check URL
          const url = window.location.href;
          return url.includes('seller.indiamart.com') && !url.includes('login');
        })();
      `);

      // Detect status change
      if (isLoggedIn !== this.state.isLoggedIn && this.state.isLoggedIn !== null) {
        if (isLoggedIn) {
          this.handleLogin();
        } else {
          this.handleLogout();
        }
      }

      this.state.isLoggedIn = isLoggedIn;
    } catch (error) {
      // Don't change login status on error
    }
  }

  /**
   * Handle online event
   */
  private handleOnline(): void {
    this.state.lastOnlineAt = Date.now();
    this.state.offlineAlertSent = false;

    const offlineDuration = this.formatDuration(
      this.state.lastOnlineAt - this.state.lastOfflineAt
    );

    this.log('info', 'Network is back online');

    // Send notification if was offline for a while
    if (this.state.lastOfflineAt > 0 && this.telegramBot) {
      this.telegramBot.sendNotification(
        `✅ <b>Back Online</b>\n\nConnection restored after ${offlineDuration}`
      );
    }
  }

  /**
   * Handle offline event
   */
  private handleOffline(): void {
    this.state.lastOfflineAt = Date.now();

    this.log('warning', 'Network is offline');

    // Send alert after threshold
    setTimeout(() => {
      if (!this.state.isOnline && !this.state.offlineAlertSent) {
        this.sendOfflineAlert();
      }
    }, OFFLINE_THRESHOLD_MS);
  }

  /**
   * Send offline alert
   */
  private async sendOfflineAlert(): Promise<void> {
    if (!this.telegramBot || this.state.offlineAlertSent) return;

    this.state.offlineAlertSent = true;

    await this.telegramBot.sendNotification(
      `⚠️ <b>Connection Lost</b>\n\nApplication is offline. Please check network connection.`
    );

    this.log('warning', 'Offline alert sent');
  }

  /**
   * Handle login event
   */
  private handleLogin(): void {
    this.state.lastLoginAt = Date.now();
    this.state.logoutAlertSent = false;

    this.log('info', 'User logged in');

    if (this.telegramBot) {
      this.telegramBot.sendNotification('✅ <b>Logged In</b>\n\nSuccessfully logged into IndiaMART');
    }
  }

  /**
   * Handle logout event
   */
  private handleLogout(): void {
    this.state.lastLogoutAt = Date.now();

    this.log('warning', 'User logged out');

    // Send alert
    if (this.telegramBot && !this.state.logoutAlertSent) {
      this.state.logoutAlertSent = true;

      this.telegramBot.sendNotification(
        '⚠️ <b>Logged Out</b>\n\nSession expired or logged out. Please log in again.'
      );
    }
  }

  /**
   * Send heartbeat
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.telegramBot) return;

    this.state.lastHeartbeat = Date.now();

    const uptime = Math.floor(process.uptime());
    const memory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

    const status = this.state.isOnline ? '🟢 Online' : '🔴 Offline';
    const loginStatus = this.state.isLoggedIn
      ? '✅ Logged In'
      : this.state.isLoggedIn === false
      ? '❌ Logged Out'
      : '❓ Unknown';

    const message = `
💓 <b>Heartbeat</b>

${status} | ${loginStatus}
⏱️ Uptime: ${this.formatDuration(uptime * 1000)}
💾 Memory: ${memory} MB
    `.trim();

    await this.telegramBot.sendNotification(message);

    this.log('debug', 'Heartbeat sent');
  }

  /**
   * Format duration in human-readable format
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Get current state
   */
  getState(): StatusState {
    return { ...this.state };
  }

  /**
   * Force status check
   */
  async forceCheck(): Promise<void> {
    await this.checkStatus();
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    this.stopWatching();
    this.stopHeartbeat();
    this.log('info', 'StatusWatcher cleanup complete');
  }

  /**
   * Log helper
   */
  private log(level: string, msg: string): void {
    this.onLog(level, msg);
  }
}
