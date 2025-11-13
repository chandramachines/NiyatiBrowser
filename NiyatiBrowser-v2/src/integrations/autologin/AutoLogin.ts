/**
 * Auto Login Module
 * Handles automatic OTP login for IndiaMART
 */

import { BrowserWindow, clipboard } from 'electron';
import { AppConfig } from '../../types';

// ============================================================================
// Constants
// ============================================================================

const LOGIN_URL = 'https://my.indiamart.com/';
const OTP_PATTERN = /\b\d{4}\b/;
const CHECK_INTERVAL_MS = 1000;
const OTP_TIMEOUT_MS = 120000; // 2 minutes
const PAGE_LOAD_TIMEOUT_MS = 30000;

// ============================================================================
// Auto Login Class
// ============================================================================

export class AutoLogin {
  private window: BrowserWindow;
  private config: AppConfig;
  private checkTimer: NodeJS.Timeout | null = null;
  private isMonitoring = false;
  private otpStartTime = 0;
  private lastClipboard = '';

  constructor(
    window: BrowserWindow,
    config: AppConfig,
    private onLog: (level: string, msg: string) => void = () => {}
  ) {
    this.window = window;
    this.config = config;
  }

  /**
   * Initialize auto login
   */
  async initialize(): Promise<void> {
    this.log('info', 'AutoLogin initialized');
  }

  /**
   * Start auto login process
   */
  async startLogin(): Promise<boolean> {
    if (this.window.isDestroyed()) {
      this.log('error', 'Window is destroyed');
      return false;
    }

    try {
      this.log('info', 'Starting auto login process');

      // Navigate to login page
      await this.window.loadURL(LOGIN_URL, {
        userAgent: this.getUserAgent(),
      });

      // Wait for page to load
      await this.waitForLoad();

      // Check if already logged in
      const isLoggedIn = await this.checkLoginStatus();
      if (isLoggedIn) {
        this.log('info', 'Already logged in');
        return true;
      }

      // Enter mobile number
      const mobileEntered = await this.enterMobile();
      if (!mobileEntered) {
        this.log('error', 'Failed to enter mobile number');
        return false;
      }

      // Wait for OTP page
      await this.wait(2000);

      // Start OTP monitoring
      this.startOtpMonitoring();

      return true;
    } catch (error) {
      this.log('error', `Auto login error: ${error}`);
      return false;
    }
  }

  /**
   * Check if user is logged in
   */
  private async checkLoginStatus(): Promise<boolean> {
    if (this.window.isDestroyed()) return false;

    try {
      const result = await this.window.webContents.executeJavaScript(`
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
          return url.includes('seller.indiamart.com') || url.includes('my.indiamart.com/dashboard');
        })();
      `);

      return result === true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Enter mobile number
   */
  private async enterMobile(): Promise<boolean> {
    if (!this.config.indiamartMobile) {
      this.log('warning', 'Mobile number not configured');
      return false;
    }

    if (this.window.isDestroyed()) return false;

    try {
      const result = await this.window.webContents.executeJavaScript(`
        (function() {
          const mobile = '${this.config.indiamartMobile}';

          // Try different mobile input selectors
          const selectors = [
            'input[name="mobile"]',
            'input[type="tel"]',
            'input[placeholder*="mobile" i]',
            'input[id*="mobile" i]',
            '#username',
          ];

          let mobileInput = null;
          for (const selector of selectors) {
            mobileInput = document.querySelector(selector);
            if (mobileInput) break;
          }

          if (!mobileInput) {
            return { success: false, error: 'Mobile input not found' };
          }

          // Fill mobile number
          mobileInput.value = mobile;
          mobileInput.dispatchEvent(new Event('input', { bubbles: true }));
          mobileInput.dispatchEvent(new Event('change', { bubbles: true }));

          // Find and click submit button
          const buttonSelectors = [
            'button[type="submit"]',
            'input[type="submit"]',
            'button:contains("Continue")',
            'button:contains("Send OTP")',
            '.submit-btn',
          ];

          let submitBtn = null;
          for (const selector of buttonSelectors) {
            submitBtn = document.querySelector(selector);
            if (submitBtn) break;
          }

          if (submitBtn && typeof submitBtn.click === 'function') {
            submitBtn.click();
            return { success: true };
          }

          return { success: false, error: 'Submit button not found' };
        })();
      `);

      if (result.success) {
        this.log('info', 'Mobile number entered successfully');
        return true;
      } else {
        this.log('error', `Failed to enter mobile: ${result.error}`);
        return false;
      }
    } catch (error) {
      this.log('error', `Enter mobile error: ${error}`);
      return false;
    }
  }

  /**
   * Start OTP monitoring
   */
  private startOtpMonitoring(): void {
    if (this.isMonitoring) return;

    this.isMonitoring = true;
    this.otpStartTime = Date.now();
    this.lastClipboard = clipboard.readText();

    this.log('info', 'Started OTP monitoring (watching clipboard)');

    this.checkTimer = setInterval(() => {
      this.checkForOtp();
    }, CHECK_INTERVAL_MS);
  }

  /**
   * Stop OTP monitoring
   */
  private stopOtpMonitoring(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }

    this.isMonitoring = false;
    this.log('info', 'Stopped OTP monitoring');
  }

  /**
   * Check for OTP in clipboard
   */
  private async checkForOtp(): Promise<void> {
    // Check timeout
    if (Date.now() - this.otpStartTime > OTP_TIMEOUT_MS) {
      this.stopOtpMonitoring();
      this.log('warning', 'OTP monitoring timed out');
      return;
    }

    // Read clipboard
    const currentClipboard = clipboard.readText();

    // Check if clipboard changed
    if (currentClipboard === this.lastClipboard) {
      return;
    }

    this.lastClipboard = currentClipboard;

    // Extract OTP
    const match = currentClipboard.match(OTP_PATTERN);
    if (!match) return;

    const otp = match[0];
    this.log('info', `Detected OTP: ${otp}`);

    // Enter OTP
    const success = await this.enterOtp(otp);

    if (success) {
      this.stopOtpMonitoring();
      this.log('info', 'Auto login completed successfully');
    }
  }

  /**
   * Enter OTP
   */
  private async enterOtp(otp: string): Promise<boolean> {
    if (this.window.isDestroyed()) return false;

    try {
      const result = await this.window.webContents.executeJavaScript(`
        (function() {
          const otp = '${otp}';

          // Try different OTP input selectors
          const selectors = [
            'input[name="otp"]',
            'input[type="text"]',
            'input[placeholder*="otp" i]',
            'input[id*="otp" i]',
          ];

          let otpInput = null;
          for (const selector of selectors) {
            const inputs = document.querySelectorAll(selector);
            for (const input of inputs) {
              // Check if input is visible
              const style = window.getComputedStyle(input);
              if (style.display !== 'none' && style.visibility !== 'hidden') {
                otpInput = input;
                break;
              }
            }
            if (otpInput) break;
          }

          if (!otpInput) {
            return { success: false, error: 'OTP input not found' };
          }

          // Fill OTP
          otpInput.value = otp;
          otpInput.dispatchEvent(new Event('input', { bubbles: true }));
          otpInput.dispatchEvent(new Event('change', { bubbles: true }));

          // Find and click verify button
          const buttonSelectors = [
            'button[type="submit"]',
            'input[type="submit"]',
            'button:contains("Verify")',
            'button:contains("Login")',
            '.verify-btn',
          ];

          let verifyBtn = null;
          for (const selector of buttonSelectors) {
            verifyBtn = document.querySelector(selector);
            if (verifyBtn) break;
          }

          if (verifyBtn && typeof verifyBtn.click === 'function') {
            verifyBtn.click();
            return { success: true };
          }

          return { success: false, error: 'Verify button not found' };
        })();
      `);

      if (result.success) {
        this.log('info', 'OTP entered successfully');
        return true;
      } else {
        this.log('error', `Failed to enter OTP: ${result.error}`);
        return false;
      }
    } catch (error) {
      this.log('error', `Enter OTP error: ${error}`);
      return false;
    }
  }

  /**
   * Wait for page load
   */
  private async waitForLoad(): Promise<void> {
    if (this.window.isDestroyed()) return;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Page load timeout'));
      }, PAGE_LOAD_TIMEOUT_MS);

      this.window.webContents.once('did-finish-load', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.window.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
        clearTimeout(timeout);
        reject(new Error(`Page load failed: ${errorDescription} (${errorCode})`));
      });
    });
  }

  /**
   * Wait helper
   */
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get user agent
   */
  private getUserAgent(): string {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    this.stopOtpMonitoring();
    this.log('info', 'AutoLogin cleanup complete');
  }

  /**
   * Log helper
   */
  private log(level: string, msg: string): void {
    this.onLog(level, msg);
  }
}
