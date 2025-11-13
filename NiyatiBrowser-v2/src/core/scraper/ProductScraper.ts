/**
 * Product Scraper Module
 * Extracts product data from IndiaMART leads page
 */

import { BrowserWindow } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Product, ProductLogEntry, ScraperState } from '../../types';

// ============================================================================
// Constants
// ============================================================================

const LEADS_URL = 'https://seller.indiamart.com/bltxn/?pref=recent';
const LOGIN_SELECTOR = '#selsout';
const MIN_INTERVAL_MS = 3000;
const MAX_INTERVAL_MS = 3600000;
const DEFAULT_INTERVAL_MS = 7000;
const SCRAPE_DELAY_MS = 3000;
const MAX_ITEMS = 50;
const MAX_LOG_ENTRIES = 5000;

// ============================================================================
// Product Scraper Class
// ============================================================================

export class ProductScraper {
  private window: BrowserWindow;
  private state: ScraperState;
  private scrapeTimer: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private logEntries: ProductLogEntry[] = [];
  private productKeys: Set<string> = new Set();
  private serial = 1;
  private reportsDir: string;
  private logFile: string;

  constructor(
    window: BrowserWindow,
    reportsDir: string,
    private onLog: (level: string, msg: string) => void = () => {}
  ) {
    this.window = window;
    this.reportsDir = reportsDir;
    this.logFile = path.join(reportsDir, 'products_log.json');

    this.state = {
      enabled: false,
      intervalMs: DEFAULT_INTERVAL_MS,
      userWantedAutoRefresh: false,
      isLoggedIn: null,
      suspendedByAuth: false,
      isNetworkOnline: true,
      lastStartAt: 0,
      lastStopAt: 0,
      lastCycleAt: 0,
      cycles: 0,
    };
  }

  /**
   * Initialize scraper
   */
  async initialize(): Promise<void> {
    // Create reports directory
    await fs.mkdir(this.reportsDir, { recursive: true });

    // Load existing log
    await this.loadLog();

    // Start keepalive
    this.startKeepAlive();

    this.log('info', 'ProductScraper initialized');
  }

  /**
   * Load existing product log
   */
  private async loadLog(): Promise<void> {
    try {
      const data = await fs.readFile(this.logFile, 'utf-8');
      const parsed = JSON.parse(data);

      if (Array.isArray(parsed)) {
        this.logEntries = parsed;

        // Rebuild keys and serial
        for (const entry of this.logEntries) {
          const key = this.makeKey(entry.name, entry.location);
          this.productKeys.add(key);

          const s = parseInt(String(entry.serial), 10);
          if (!isNaN(s)) {
            this.serial = Math.max(this.serial, s + 1);
          }
        }

        this.log('info', `Loaded ${this.logEntries.length} product log entries`);
      }
    } catch (error) {
      // File doesn't exist or invalid JSON, start fresh
      this.logEntries = [];
      this.productKeys.clear();
      this.serial = 1;
    }
  }

  /**
   * Save product log
   */
  private async saveLog(): Promise<void> {
    try {
      // Limit log size
      if (this.logEntries.length > MAX_LOG_ENTRIES) {
        this.logEntries = this.logEntries.slice(0, MAX_LOG_ENTRIES);
      }

      const data = JSON.stringify(this.logEntries, null, 2);
      await fs.writeFile(this.logFile, data, 'utf-8');
    } catch (error) {
      this.log('error', `Failed to save product log: ${error}`);
    }
  }

  /**
   * Make unique key for product
   */
  private makeKey(title: string, location: string): string {
    const normTitle = String(title || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    const normLoc = String(location || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    return `${normTitle}|${normLoc || '-'}`;
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
   * Record product if new
   */
  private async recordProduct(title: string, location: string): Promise<boolean> {
    const key = this.makeKey(title, location);

    if (this.productKeys.has(key)) {
      return false;
    }

    // Add to log
    const entry: ProductLogEntry = {
      serial: this.serial++,
      timestamp: this.formatTimestamp(),
      name: title,
      location: location,
    };

    this.logEntries.unshift(entry);
    this.productKeys.add(key);

    // Save to disk
    await this.saveLog();

    this.log('info', `New product: ${title}${location ? ` [${location}]` : ''}`);

    return true;
  }

  /**
   * Start keepalive mechanism
   */
  private startKeepAlive(): void {
    if (this.keepAliveTimer) return;

    this.keepAliveTimer = setInterval(async () => {
      try {
        if (this.window.isDestroyed()) {
          this.stopKeepAlive();
          return;
        }

        await this.window.webContents.executeJavaScript(`
          (function() {
            const now = Date.now();
            const marker = document.getElementById('niyati-keepalive') ||
                          document.createElement('div');
            marker.id = 'niyati-keepalive';
            marker.setAttribute('data-last-ping', now);
            marker.style.display = 'none';
            if (!marker.parentNode) document.body.appendChild(marker);
            return now;
          })();
        `);
      } catch (error) {
        // Silently ignore - page might be navigating
      }
    }, 15000);
  }

  /**
   * Stop keepalive
   */
  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  /**
   * Scrape products from page
   */
  private async scrapeProducts(): Promise<Product[]> {
    if (this.window.isDestroyed()) {
      return [];
    }

    try {
      const result = await this.window.webContents.executeJavaScript(`
        (function() {
          // Check if page is ready
          if (document.readyState !== 'interactive' && document.readyState !== 'complete') {
            return { ready: false, loggedIn: null, items: [] };
          }

          // Check if logged in
          const loginEl = document.querySelector('${LOGIN_SELECTOR}');
          if (!loginEl) {
            return { ready: true, loggedIn: false, items: [] };
          }

          // Extract products
          const items = [];
          const max = ${MAX_ITEMS};

          for (let i = 1; i <= max; i++) {
            const row = document.getElementById('list' + i);
            if (!row) break;

            // Extract title
            const titleEl = row.querySelector('.Bl_Txt a, .Bl_Txt, h2, h3, h4');
            const title = titleEl ? titleEl.textContent.trim() : '';
            if (!title) continue;

            // Extract location from various selectors
            const cityXp = '//*[@id="list' + i + '"]/div[1]/div[1]/div[2]/div/div[1]/div[2]/strong/p/span[1]/text()';
            const stateXp = '//*[@id="list' + i + '"]/div[1]/div[1]/div[2]/div/div[1]/div[2]/strong/p/span[2]/text()';

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

          return { ready: true, loggedIn: true, items };
        })();
      `);

      if (!result.ready) {
        this.log('debug', 'Page not ready for scraping');
        return [];
      }

      if (!result.loggedIn) {
        this.state.isLoggedIn = false;
        this.log('warning', 'Not logged in to IndiaMART');
        return [];
      }

      this.state.isLoggedIn = true;
      return result.items || [];
    } catch (error) {
      this.log('error', `Scrape error: ${error}`);
      return [];
    }
  }

  /**
   * Process scraped products
   */
  private async processProducts(products: Product[]): Promise<void> {
    if (products.length === 0) {
      this.log('info', 'No products found in this cycle');
      return;
    }

    let newCount = 0;

    for (const product of products) {
      const location = product.city && product.state
        ? `${product.city}, ${product.state}`
        : product.location || '';

      const isNew = await this.recordProduct(product.title, location);
      if (isNew) {
        newCount++;
      }
    }

    this.log('info', `Scraped ${products.length} products (${newCount} new)`);
  }

  /**
   * Run scrape cycle
   */
  private async runCycle(): Promise<void> {
    try {
      this.state.cycles++;
      this.state.lastCycleAt = Date.now();

      this.log('info', `Scrape cycle #${this.state.cycles} starting`);

      // Wait for delay
      await new Promise((resolve) => setTimeout(resolve, SCRAPE_DELAY_MS));

      // Scrape products
      const products = await this.scrapeProducts();

      // Process products
      await this.processProducts(products);

      this.log('info', `Scrape cycle #${this.state.cycles} complete`);
    } catch (error) {
      this.log('error', `Cycle error: ${error}`);
    }
  }

  /**
   * Start auto-refresh
   */
  async startAutoRefresh(intervalMs: number): Promise<void> {
    // Validate interval
    const interval = Math.max(
      MIN_INTERVAL_MS,
      Math.min(MAX_INTERVAL_MS, intervalMs)
    );

    // Stop existing timer
    this.stopAutoRefresh();

    // Update state
    this.state.enabled = true;
    this.state.intervalMs = interval;
    this.state.userWantedAutoRefresh = true;
    this.state.lastStartAt = Date.now();

    // Start timer
    this.scrapeTimer = setInterval(() => {
      this.runCycle();
    }, interval);

    // Run first cycle immediately
    this.runCycle();

    this.log('info', `Auto-refresh started @ ${Math.round(interval / 1000)}s`);
  }

  /**
   * Stop auto-refresh
   */
  stopAutoRefresh(): void {
    if (this.scrapeTimer) {
      clearInterval(this.scrapeTimer);
      this.scrapeTimer = null;
    }

    this.state.enabled = false;
    this.state.lastStopAt = Date.now();

    this.log('info', 'Auto-refresh stopped');
  }

  /**
   * Get current state
   */
  getState(): ScraperState {
    return { ...this.state };
  }

  /**
   * Get product count
   */
  getProductCount(): number {
    return this.logEntries.length;
  }

  /**
   * Get new products in last N milliseconds
   */
  getNewProductsLast(ms: number): number {
    const cutoff = Date.now() - ms;
    return this.logEntries.filter((entry) => {
      const timestamp = new Date(entry.timestamp).getTime();
      return timestamp > cutoff;
    }).length;
  }

  /**
   * Reset product log
   */
  async resetLog(): Promise<void> {
    this.logEntries = [];
    this.productKeys.clear();
    this.serial = 1;
    await this.saveLog();
    this.log('info', 'Product log reset');
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    this.stopAutoRefresh();
    this.stopKeepAlive();
    await this.saveLog();
    this.log('info', 'ProductScraper cleanup complete');
  }

  /**
   * Log helper
   */
  private log(level: string, msg: string): void {
    this.onLog(level, msg);
  }
}
