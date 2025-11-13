/**
 * Match Clicker Module
 * Automatically clicks on matched products
 */

import { BrowserWindow } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Product, MatchClickerState, ClickHistoryEntry } from '../../types';
import { KeywordMatcher } from './KeywordMatcher';

// ============================================================================
// Constants
// ============================================================================

const CLICK_DELAY_MS = 2000;
const MIN_CLICK_INTERVAL_MS = 5000;
const MAX_CLICK_INTERVAL_MS = 30000;
const DEFAULT_CLICK_INTERVAL_MS = 10000;
const MAX_HISTORY_ENTRIES = 1000;
const REGEX_CACHE_SIZE = 100;

// ============================================================================
// Match Clicker Class
// ============================================================================

export class MatchClicker {
  private window: BrowserWindow;
  private state: MatchClickerState;
  private keywordMatcher: KeywordMatcher;
  private clickTimer: NodeJS.Timeout | null = null;
  private clickHistory: ClickHistoryEntry[] = [];
  private clickedIndices: Set<number> = new Set();
  private regexCache: Map<string, RegExp> = new Map();
  private reportsDir: string;
  private historyFile: string;

  constructor(
    window: BrowserWindow,
    keywordMatcher: KeywordMatcher,
    reportsDir: string,
    private onLog: (level: string, msg: string) => void = () => {}
  ) {
    this.window = window;
    this.keywordMatcher = keywordMatcher;
    this.reportsDir = reportsDir;
    this.historyFile = path.join(reportsDir, 'click_history.json');

    this.state = {
      enabled: false,
      intervalMs: DEFAULT_CLICK_INTERVAL_MS,
      totalClicks: 0,
      clicksToday: 0,
      lastClickAt: 0,
    };
  }

  /**
   * Initialize match clicker
   */
  async initialize(): Promise<void> {
    // Load click history
    await this.loadHistory();

    this.log('info', 'MatchClicker initialized');
  }

  /**
   * Load click history
   */
  private async loadHistory(): Promise<void> {
    try {
      const data = await fs.readFile(this.historyFile, 'utf-8');
      const parsed = JSON.parse(data);

      if (Array.isArray(parsed)) {
        this.clickHistory = parsed;
        this.state.totalClicks = this.clickHistory.length;

        // Calculate today's clicks
        const todayClicks = this.getTodaysClicks();
        this.state.clicksToday = todayClicks.length;

        this.log('info', `Loaded ${this.clickHistory.length} click history entries`);
      }
    } catch (error) {
      // File doesn't exist or invalid JSON
      this.clickHistory = [];
      this.state.totalClicks = 0;
      this.state.clicksToday = 0;
    }
  }

  /**
   * Save click history
   */
  private async saveHistory(): Promise<void> {
    try {
      // Limit history size
      if (this.clickHistory.length > MAX_HISTORY_ENTRIES) {
        this.clickHistory = this.clickHistory.slice(0, MAX_HISTORY_ENTRIES);
      }

      const data = JSON.stringify(this.clickHistory, null, 2);
      await fs.writeFile(this.historyFile, data, 'utf-8');
    } catch (error) {
      this.log('error', `Failed to save click history: ${error}`);
    }
  }

  /**
   * Format timestamp in IST
   */
  private formatTimestamp(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /**
   * Record click in history
   */
  private async recordClick(product: Product, keyword: string): Promise<void> {
    const entry: ClickHistoryEntry = {
      timestamp: this.formatTimestamp(),
      productTitle: product.title,
      productIndex: product.index,
      keyword: keyword,
      location: product.location || '',
    };

    this.clickHistory.unshift(entry);
    this.state.totalClicks = this.clickHistory.length;

    // Update today's count
    const todayClicks = this.getTodaysClicks();
    this.state.clicksToday = todayClicks.length;

    // Save to disk
    await this.saveHistory();

    this.log('info', `Clicked: ${product.title} [matched: ${keyword}]`);
  }

  /**
   * Get compiled regex from cache
   */
  private getRegex(pattern: string): RegExp {
    if (this.regexCache.has(pattern)) {
      return this.regexCache.get(pattern)!;
    }

    // Compile regex
    const regex = new RegExp(pattern, 'i');

    // Add to cache
    this.regexCache.set(pattern, regex);

    // Limit cache size
    if (this.regexCache.size > REGEX_CACHE_SIZE) {
      // Remove oldest entry
      const firstKey = this.regexCache.keys().next().value;
      if (firstKey !== undefined) {
        this.regexCache.delete(firstKey);
      }
    }

    return regex;
  }

  /**
   * Check if product was already clicked in this session
   */
  private wasClickedInSession(index: number): boolean {
    return this.clickedIndices.has(index);
  }

  /**
   * Click product by index
   */
  private async clickProduct(index: number): Promise<boolean> {
    if (this.window.isDestroyed()) {
      return false;
    }

    try {
      const result = await this.window.webContents.executeJavaScript(`
        (function() {
          const row = document.getElementById('list${index}');
          if (!row) return { success: false, error: 'Element not found' };

          // Try multiple click targets
          const selectors = [
            '.Bl_Txt a',
            'a[href*="messages"]',
            'a[href*="msg"]',
            'a',
            'button',
          ];

          for (const selector of selectors) {
            const el = row.querySelector(selector);
            if (el && typeof el.click === 'function') {
              el.click();
              return { success: true };
            }
          }

          // Fallback: click the row itself
          if (typeof row.click === 'function') {
            row.click();
            return { success: true };
          }

          return { success: false, error: 'No clickable element found' };
        })();
      `);

      return result.success;
    } catch (error) {
      this.log('error', `Click error: ${error}`);
      return false;
    }
  }

  /**
   * Find and click matched products
   */
  async findAndClickMatched(): Promise<number> {
    if (this.window.isDestroyed()) {
      return 0;
    }

    try {
      // Get products from page
      const products = await this.getProductsFromPage();

      if (products.length === 0) {
        this.log('debug', 'No products found on page');
        return 0;
      }

      // Match products against keywords
      const matchResults = await this.keywordMatcher.matchProducts(products);

      // Filter matched products that haven't been clicked
      const toClick = matchResults.filter(
        (result, index) =>
          result.matched && !this.wasClickedInSession(products[index].index)
      );

      if (toClick.length === 0) {
        this.log('debug', 'No new matched products to click');
        return 0;
      }

      this.log('info', `Found ${toClick.length} matched products to click`);

      // Click matched products
      let clickCount = 0;

      for (let i = 0; i < toClick.length; i++) {
        const result = toClick[i];
        const product = products[matchResults.indexOf(result)];

        // Wait before clicking
        await new Promise((resolve) => setTimeout(resolve, CLICK_DELAY_MS));

        // Click product
        const success = await this.clickProduct(product.index);

        if (success) {
          // Mark as clicked in this session
          this.clickedIndices.add(product.index);

          // Record in history
          await this.recordClick(product, result.keyword || 'unknown');

          // Update state
          this.state.lastClickAt = Date.now();

          clickCount++;
        } else {
          this.log('warning', `Failed to click product: ${product.title}`);
        }
      }

      return clickCount;
    } catch (error) {
      this.log('error', `Find and click error: ${error}`);
      return 0;
    }
  }

  /**
   * Get products from page
   */
  private async getProductsFromPage(): Promise<Product[]> {
    if (this.window.isDestroyed()) {
      return [];
    }

    try {
      const result = await this.window.webContents.executeJavaScript(`
        (function() {
          const items = [];
          const max = 50;

          for (let i = 1; i <= max; i++) {
            const row = document.getElementById('list' + i);
            if (!row) break;

            // Extract title
            const titleEl = row.querySelector('.Bl_Txt a, .Bl_Txt, h2, h3, h4');
            const title = titleEl ? titleEl.textContent.trim() : '';
            if (!title) continue;

            // Extract location
            const getXPathText = (xpath) => {
              try {
                const result = document.evaluate(
                  xpath,
                  document,
                  null,
                  XPathResult.STRING_TYPE,
                  null
                );
                return result.stringValue.trim();
              } catch {
                return '';
              }
            };

            const cityXp = '//*[@id="list' + i + '"]/div[1]/div[1]/div[2]/div/div[1]/div[2]/strong/p/span[1]/text()';
            const stateXp = '//*[@id="list' + i + '"]/div[1]/div[1]/div[2]/div/div[1]/div[2]/strong/p/span[2]/text()';

            const city = getXPathText(cityXp);
            const state = getXPathText(stateXp);
            const location = (city && state) ? city + ', ' + state : (city || state);

            items.push({
              index: i,
              title: title,
              city: city,
              state: state,
              location: location,
            });
          }

          return items;
        })();
      `);

      return result || [];
    } catch (error) {
      this.log('error', `Get products error: ${error}`);
      return [];
    }
  }

  /**
   * Run click cycle
   */
  private async runCycle(): Promise<void> {
    try {
      this.log('info', 'Starting click cycle');

      const clickCount = await this.findAndClickMatched();

      if (clickCount > 0) {
        this.log('info', `Click cycle complete: ${clickCount} clicks`);
      } else {
        this.log('info', 'Click cycle complete: no clicks');
      }
    } catch (error) {
      this.log('error', `Click cycle error: ${error}`);
    }
  }

  /**
   * Start auto-clicking
   */
  async startAutoClick(intervalMs: number): Promise<void> {
    // Validate interval
    const interval = Math.max(
      MIN_CLICK_INTERVAL_MS,
      Math.min(MAX_CLICK_INTERVAL_MS, intervalMs)
    );

    // Stop existing timer
    this.stopAutoClick();

    // Update state
    this.state.enabled = true;
    this.state.intervalMs = interval;

    // Start timer
    this.clickTimer = setInterval(() => {
      this.runCycle();
    }, interval);

    // Run first cycle immediately
    this.runCycle();

    this.log('info', `Auto-click started @ ${Math.round(interval / 1000)}s`);
  }

  /**
   * Stop auto-clicking
   */
  stopAutoClick(): void {
    if (this.clickTimer) {
      clearInterval(this.clickTimer);
      this.clickTimer = null;
    }

    this.state.enabled = false;

    this.log('info', 'Auto-click stopped');
  }

  /**
   * Reset session clicks
   */
  resetSession(): void {
    this.clickedIndices.clear();
    this.log('info', 'Click session reset');
  }

  /**
   * Get today's clicks
   */
  getTodaysClicks(): ClickHistoryEntry[] {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    return this.clickHistory.filter((entry) => {
      return entry.timestamp.startsWith(todayStr);
    });
  }

  /**
   * Get clicks by date range
   */
  getClicksByDateRange(startDate: Date, endDate: Date): ClickHistoryEntry[] {
    return this.clickHistory.filter((entry) => {
      const entryDate = new Date(entry.timestamp);
      return entryDate >= startDate && entryDate <= endDate;
    });
  }

  /**
   * Get current state
   */
  getState(): MatchClickerState {
    return { ...this.state };
  }

  /**
   * Get recent clicks
   */
  getRecentClicks(count: number = 10): ClickHistoryEntry[] {
    return this.clickHistory.slice(0, count);
  }

  /**
   * Export clicks to CSV
   */
  async exportToCSV(outputPath: string): Promise<void> {
    try {
      const headers = ['Timestamp', 'Product Title', 'Product Index', 'Keyword', 'Location'];

      const rows = this.clickHistory.map((entry) => [
        entry.timestamp,
        entry.productTitle,
        entry.productIndex,
        entry.keyword,
        entry.location,
      ]);

      // CSV escape function
      const escape = (str: string | number): string => {
        const s = String(str || '');
        if (s.includes(',') || s.includes('"') || s.includes('\n')) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };

      const csv = [
        headers.map(escape).join(','),
        ...rows.map((row) => row.map(escape).join(',')),
      ].join('\n');

      await fs.writeFile(outputPath, csv, 'utf-8');

      this.log('info', `Exported ${this.clickHistory.length} clicks to CSV`);
    } catch (error) {
      this.log('error', `Failed to export CSV: ${error}`);
      throw error;
    }
  }

  /**
   * Reset click history
   */
  async resetHistory(): Promise<void> {
    this.clickHistory = [];
    this.clickedIndices.clear();
    this.state.totalClicks = 0;
    this.state.clicksToday = 0;
    await this.saveHistory();
    this.log('info', 'Click history reset');
  }

  /**
   * Get regex cache stats
   */
  getRegexCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.regexCache.size,
      maxSize: REGEX_CACHE_SIZE,
    };
  }

  /**
   * Clear regex cache
   */
  clearRegexCache(): void {
    this.regexCache.clear();
    this.log('info', 'Regex cache cleared');
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    this.stopAutoClick();
    this.clearRegexCache();
    await this.saveHistory();
    this.log('info', 'MatchClicker cleanup complete');
  }

  /**
   * Log helper
   */
  private log(level: string, msg: string): void {
    this.onLog(level, msg);
  }
}
