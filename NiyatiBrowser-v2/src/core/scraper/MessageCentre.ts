/**
 * Message Centre Module
 * Extracts lead data from IndiaMART message centre
 */

import { BrowserWindow } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Lead, LeadLogEntry, MessageCentreState } from '../../types';

// ============================================================================
// Constants
// ============================================================================

const LOGIN_SELECTOR = '#selsout';
const MAX_LEADS = 50;
const MAX_LOG_ENTRIES = 10000;
const SCRAPE_DELAY_MS = 2000;

// ============================================================================
// Message Centre Class
// ============================================================================

export class MessageCentre {
  private window: BrowserWindow;
  private state: MessageCentreState;
  private logEntries: LeadLogEntry[] = [];
  private leadKeys: Set<string> = new Set();
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
    this.logFile = path.join(reportsDir, 'leads_log.json');

    this.state = {
      isLoggedIn: null,
      lastScrapeAt: 0,
      totalLeads: 0,
      newLeadsToday: 0,
    };
  }

  /**
   * Initialize message centre
   */
  async initialize(): Promise<void> {
    // Create reports directory
    await fs.mkdir(this.reportsDir, { recursive: true });

    // Load existing log
    await this.loadLog();

    this.log('info', 'MessageCentre initialized');
  }

  /**
   * Load existing lead log
   */
  private async loadLog(): Promise<void> {
    try {
      const data = await fs.readFile(this.logFile, 'utf-8');
      const parsed = JSON.parse(data);

      if (Array.isArray(parsed)) {
        this.logEntries = parsed;

        // Rebuild keys and serial
        for (const entry of this.logEntries) {
          const key = this.makeKey(entry);
          this.leadKeys.add(key);

          const s = parseInt(String(entry.serial), 10);
          if (!isNaN(s)) {
            this.serial = Math.max(this.serial, s + 1);
          }
        }

        this.state.totalLeads = this.logEntries.length;
        this.log('info', `Loaded ${this.logEntries.length} lead log entries`);
      }
    } catch (error) {
      // File doesn't exist or invalid JSON, start fresh
      this.logEntries = [];
      this.leadKeys.clear();
      this.serial = 1;
      this.state.totalLeads = 0;
    }
  }

  /**
   * Save lead log
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
      this.log('error', `Failed to save lead log: ${error}`);
    }
  }

  /**
   * Make unique key for lead
   */
  private makeKey(lead: LeadLogEntry | Lead): string {
    const name = String(lead.name || '').toLowerCase().trim();
    const mobile = String(lead.mobile || '').replace(/\D/g, '').trim();
    const email = String(lead.email || '').toLowerCase().trim();

    // Use mobile as primary key if available
    if (mobile && mobile.length >= 10) {
      return `mobile:${mobile}`;
    }

    // Otherwise use combination
    return `${name}|${email || mobile || '-'}`;
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
   * Record lead if new
   */
  private async recordLead(lead: Lead): Promise<boolean> {
    const key = this.makeKey(lead);

    if (this.leadKeys.has(key)) {
      return false;
    }

    // Create log entry
    const entry: LeadLogEntry = {
      serial: this.serial++,
      timestamp: this.formatTimestamp(),
      name: lead.name || '',
      mobile: lead.mobile || '',
      email: lead.email || '',
      company: lead.company || '',
      gstin: lead.gstin || '',
      address: lead.address || '',
      city: lead.city || '',
      state: lead.state || '',
      country: lead.country || '',
      product: lead.product || '',
      message: lead.message || '',
    };

    this.logEntries.unshift(entry);
    this.leadKeys.add(key);
    this.state.totalLeads = this.logEntries.length;

    // Save to disk
    await this.saveLog();

    this.log('info', `New lead: ${entry.name}${entry.mobile ? ` [${entry.mobile}]` : ''}`);

    return true;
  }

  /**
   * Scrape leads from page
   */
  async scrapeLeads(): Promise<Lead[]> {
    if (this.window.isDestroyed()) {
      return [];
    }

    try {
      // Wait for page to be ready
      await new Promise((resolve) => setTimeout(resolve, SCRAPE_DELAY_MS));

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

          // Extract leads
          const items = [];
          const max = ${MAX_LEADS};

          // Helper function to get text content safely
          const getText = (selector, parent = document) => {
            const el = parent.querySelector(selector);
            return el ? el.textContent.trim() : '';
          };

          // Helper function to get attribute safely
          const getAttr = (selector, attr, parent = document) => {
            const el = parent.querySelector(selector);
            return el ? (el.getAttribute(attr) || '').trim() : '';
          };

          // Try to find lead rows
          const leadRows = document.querySelectorAll('.bli, .bl, [class*="lead"], [class*="buyer"]');

          for (let i = 0; i < Math.min(leadRows.length, max); i++) {
            const row = leadRows[i];

            // Extract buyer name
            let name = getText('.buyerName, .buyer-name, .bname, h3, h4', row);
            if (!name) {
              // Try data attribute
              name = getAttr('[data-buyer-name]', 'data-buyer-name', row);
            }

            // Extract mobile
            let mobile = getText('.mobile, .phone, .phoneNo, [class*="mobile"]', row);
            if (!mobile) {
              mobile = getAttr('[data-mobile]', 'data-mobile', row);
            }

            // Extract email
            let email = getText('.email, .mail, [class*="email"]', row);
            if (!email) {
              email = getAttr('[data-email]', 'data-email', row);
            }

            // Extract company
            const company = getText('.companyName, .company, .cname, [class*="company"]', row);

            // Extract GSTIN
            const gstin = getText('.gstin, .gst, [class*="gstin"]', row);

            // Extract address
            const address = getText('.address, .addr, [class*="address"]', row);

            // Extract city
            const city = getText('.city, [class*="city"]', row);

            // Extract state
            const state = getText('.state, [class*="state"]', row);

            // Extract country
            const country = getText('.country, [class*="country"]', row);

            // Extract product
            const product = getText('.product, .productName, [class*="product"]', row);

            // Extract message/query
            const message = getText('.message, .query, .msg, [class*="message"]', row);

            // Only add if we have at least name or mobile
            if (name || mobile) {
              items.push({
                index: i + 1,
                name: name,
                mobile: mobile,
                email: email,
                company: company,
                gstin: gstin,
                address: address,
                city: city,
                state: state,
                country: country,
                product: product,
                message: message,
              });
            }
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
      this.state.lastScrapeAt = Date.now();

      return result.items || [];
    } catch (error) {
      this.log('error', `Scrape error: ${error}`);
      return [];
    }
  }

  /**
   * Process scraped leads
   */
  async processLeads(leads: Lead[]): Promise<{ total: number; newCount: number }> {
    if (leads.length === 0) {
      this.log('info', 'No leads found in this scrape');
      return { total: 0, newCount: 0 };
    }

    let newCount = 0;

    for (const lead of leads) {
      const isNew = await this.recordLead(lead);
      if (isNew) {
        newCount++;
      }
    }

    this.log('info', `Processed ${leads.length} leads (${newCount} new)`);

    return { total: leads.length, newCount };
  }

  /**
   * Run full scrape cycle
   */
  async runScrape(): Promise<{ total: number; newCount: number }> {
    try {
      this.log('info', 'Starting lead scrape cycle');

      // Scrape leads
      const leads = await this.scrapeLeads();

      // Process leads
      const result = await this.processLeads(leads);

      this.log('info', 'Lead scrape cycle complete');

      return result;
    } catch (error) {
      this.log('error', `Scrape cycle error: ${error}`);
      return { total: 0, newCount: 0 };
    }
  }

  /**
   * Get lead by mobile number
   */
  getLeadByMobile(mobile: string): LeadLogEntry | null {
    const cleaned = mobile.replace(/\D/g, '');
    if (cleaned.length < 10) return null;

    return this.logEntries.find((entry) => {
      const entryMobile = entry.mobile.replace(/\D/g, '');
      return entryMobile.includes(cleaned) || cleaned.includes(entryMobile);
    }) || null;
  }

  /**
   * Get leads by date range
   */
  getLeadsByDateRange(startDate: Date, endDate: Date): LeadLogEntry[] {
    return this.logEntries.filter((entry) => {
      const entryDate = new Date(entry.timestamp);
      return entryDate >= startDate && entryDate <= endDate;
    });
  }

  /**
   * Get today's leads
   */
  getTodaysLeads(): LeadLogEntry[] {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    return this.getLeadsByDateRange(today, tomorrow);
  }

  /**
   * Get current state
   */
  getState(): MessageCentreState {
    const todayLeads = this.getTodaysLeads();
    this.state.newLeadsToday = todayLeads.length;
    return { ...this.state };
  }

  /**
   * Get recent leads
   */
  getRecentLeads(count: number = 10): LeadLogEntry[] {
    return this.logEntries.slice(0, count);
  }

  /**
   * Search leads
   */
  searchLeads(query: string): LeadLogEntry[] {
    const q = query.toLowerCase().trim();
    if (!q) return [];

    return this.logEntries.filter((entry) => {
      return (
        entry.name.toLowerCase().includes(q) ||
        entry.mobile.includes(q) ||
        entry.email.toLowerCase().includes(q) ||
        entry.company.toLowerCase().includes(q) ||
        entry.city.toLowerCase().includes(q) ||
        entry.state.toLowerCase().includes(q)
      );
    });
  }

  /**
   * Export leads to CSV
   */
  async exportToCSV(outputPath: string): Promise<void> {
    try {
      const headers = [
        'Serial',
        'Timestamp',
        'Name',
        'Mobile',
        'Email',
        'Company',
        'GSTIN',
        'Address',
        'City',
        'State',
        'Country',
        'Product',
        'Message',
      ];

      const rows = this.logEntries.map((entry) => [
        entry.serial,
        entry.timestamp,
        entry.name,
        entry.mobile,
        entry.email,
        entry.company,
        entry.gstin,
        entry.address,
        entry.city,
        entry.state,
        entry.country,
        entry.product,
        entry.message,
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

      this.log('info', `Exported ${this.logEntries.length} leads to CSV`);
    } catch (error) {
      this.log('error', `Failed to export CSV: ${error}`);
      throw error;
    }
  }

  /**
   * Reset lead log
   */
  async resetLog(): Promise<void> {
    this.logEntries = [];
    this.leadKeys.clear();
    this.serial = 1;
    this.state.totalLeads = 0;
    this.state.newLeadsToday = 0;
    await this.saveLog();
    this.log('info', 'Lead log reset');
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    await this.saveLog();
    this.log('info', 'MessageCentre cleanup complete');
  }

  /**
   * Log helper
   */
  private log(level: string, msg: string): void {
    this.onLog(level, msg);
  }
}
