/**
 * Keyword Matcher Module
 * Matches products against configured keywords
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Product, KeywordMatchResult } from '../../types';

// ============================================================================
// Constants
// ============================================================================

const KEYWORDS_FILE = 'keywords.json';
const CACHE_TTL_MS = 60000; // 1 minute cache

// ============================================================================
// Keyword Matcher Class
// ============================================================================

export class KeywordMatcher {
  private keywords: string[] = [];
  private keywordsFile: string;
  private cache: Map<string, boolean> = new Map();
  private lastLoadTime = 0;

  constructor(
    reportsDir: string,
    private onLog: (level: string, msg: string) => void = () => {}
  ) {
    this.keywordsFile = path.join(reportsDir, KEYWORDS_FILE);
  }

  /**
   * Initialize keyword matcher
   */
  async initialize(): Promise<void> {
    await this.loadKeywords();
    this.log('info', 'KeywordMatcher initialized');
  }

  /**
   * Load keywords from file
   */
  async loadKeywords(): Promise<void> {
    try {
      const data = await fs.readFile(this.keywordsFile, 'utf-8');
      const parsed = JSON.parse(data);

      if (Array.isArray(parsed)) {
        this.keywords = parsed
          .filter((k) => typeof k === 'string' && k.trim().length > 0)
          .map((k) => k.toLowerCase().trim());

        this.lastLoadTime = Date.now();
        this.clearCache();

        this.log('info', `Loaded ${this.keywords.length} keywords`);
      } else {
        this.keywords = [];
        this.log('warning', 'Invalid keywords file format');
      }
    } catch (error) {
      // File doesn't exist or invalid JSON
      this.keywords = [];
      this.log('info', 'No keywords file found, starting with empty list');

      // Create default file
      await this.saveKeywords([]);
    }
  }

  /**
   * Save keywords to file
   */
  async saveKeywords(keywords: string[]): Promise<void> {
    try {
      const cleaned = keywords
        .filter((k) => typeof k === 'string' && k.trim().length > 0)
        .map((k) => k.toLowerCase().trim());

      const data = JSON.stringify(cleaned, null, 2);
      await fs.writeFile(this.keywordsFile, data, 'utf-8');

      this.keywords = cleaned;
      this.lastLoadTime = Date.now();
      this.clearCache();

      this.log('info', `Saved ${this.keywords.length} keywords`);
    } catch (error) {
      this.log('error', `Failed to save keywords: ${error}`);
      throw error;
    }
  }

  /**
   * Add keyword
   */
  async addKeyword(keyword: string): Promise<boolean> {
    const cleaned = keyword.toLowerCase().trim();

    if (!cleaned) {
      this.log('warning', 'Cannot add empty keyword');
      return false;
    }

    if (this.keywords.includes(cleaned)) {
      this.log('warning', `Keyword already exists: ${cleaned}`);
      return false;
    }

    this.keywords.push(cleaned);
    await this.saveKeywords(this.keywords);

    this.log('info', `Added keyword: ${cleaned}`);
    return true;
  }

  /**
   * Remove keyword
   */
  async removeKeyword(keyword: string): Promise<boolean> {
    const cleaned = keyword.toLowerCase().trim();
    const index = this.keywords.indexOf(cleaned);

    if (index === -1) {
      this.log('warning', `Keyword not found: ${cleaned}`);
      return false;
    }

    this.keywords.splice(index, 1);
    await this.saveKeywords(this.keywords);

    this.log('info', `Removed keyword: ${cleaned}`);
    return true;
  }

  /**
   * Clear keyword cache
   */
  private clearCache(): void {
    this.cache.clear();
  }

  /**
   * Check if cache is stale
   */
  private isCacheStale(): boolean {
    return Date.now() - this.lastLoadTime > CACHE_TTL_MS;
  }

  /**
   * Reload keywords if cache is stale
   */
  private async reloadIfStale(): Promise<void> {
    if (this.isCacheStale()) {
      await this.loadKeywords();
    }
  }

  /**
   * Match product title against keywords
   */
  async matchProduct(product: Product | string): Promise<KeywordMatchResult> {
    // Reload if cache is stale
    await this.reloadIfStale();

    // Extract title
    const title = typeof product === 'string' ? product : product.title || '';
    const normalized = title.toLowerCase().trim();

    // Check if no keywords configured
    if (this.keywords.length === 0) {
      return {
        matched: false,
        keyword: null,
        title: title,
      };
    }

    // Check cache
    const cacheKey = normalized;
    if (this.cache.has(cacheKey)) {
      const matched = this.cache.get(cacheKey)!;
      return {
        matched,
        keyword: matched ? this.findMatchingKeyword(normalized) : null,
        title: title,
      };
    }

    // Find matching keyword
    const matchedKeyword = this.findMatchingKeyword(normalized);
    const matched = matchedKeyword !== null;

    // Cache result
    this.cache.set(cacheKey, matched);

    return {
      matched,
      keyword: matchedKeyword,
      title: title,
    };
  }

  /**
   * Find matching keyword in title
   */
  private findMatchingKeyword(normalizedTitle: string): string | null {
    for (const keyword of this.keywords) {
      // Check for whole word match
      const regex = new RegExp(`\\b${this.escapeRegex(keyword)}\\b`, 'i');
      if (regex.test(normalizedTitle)) {
        return keyword;
      }

      // Check for partial match (fallback)
      if (normalizedTitle.includes(keyword)) {
        return keyword;
      }
    }

    return null;
  }

  /**
   * Escape special regex characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Match multiple products
   */
  async matchProducts(products: (Product | string)[]): Promise<KeywordMatchResult[]> {
    const results: KeywordMatchResult[] = [];

    for (const product of products) {
      const result = await this.matchProduct(product);
      results.push(result);
    }

    return results;
  }

  /**
   * Filter matched products
   */
  async filterMatchedProducts(products: Product[]): Promise<Product[]> {
    const matched: Product[] = [];

    for (const product of products) {
      const result = await this.matchProduct(product);
      if (result.matched) {
        matched.push(product);
      }
    }

    return matched;
  }

  /**
   * Get match statistics
   */
  async getMatchStats(products: Product[]): Promise<{
    total: number;
    matched: number;
    unmatched: number;
    matchRate: number;
  }> {
    const results = await this.matchProducts(products);
    const matched = results.filter((r) => r.matched).length;
    const total = results.length;
    const unmatched = total - matched;
    const matchRate = total > 0 ? (matched / total) * 100 : 0;

    return {
      total,
      matched,
      unmatched,
      matchRate: Math.round(matchRate * 100) / 100,
    };
  }

  /**
   * Get keywords
   */
  getKeywords(): string[] {
    return [...this.keywords];
  }

  /**
   * Get keywords count
   */
  getKeywordsCount(): number {
    return this.keywords.length;
  }

  /**
   * Check if keyword exists
   */
  hasKeyword(keyword: string): boolean {
    const cleaned = keyword.toLowerCase().trim();
    return this.keywords.includes(cleaned);
  }

  /**
   * Clear all keywords
   */
  async clearKeywords(): Promise<void> {
    this.keywords = [];
    await this.saveKeywords([]);
    this.log('info', 'All keywords cleared');
  }

  /**
   * Import keywords from array
   */
  async importKeywords(keywords: string[], replace = false): Promise<number> {
    const cleaned = keywords
      .filter((k) => typeof k === 'string' && k.trim().length > 0)
      .map((k) => k.toLowerCase().trim());

    if (replace) {
      this.keywords = [...new Set(cleaned)];
    } else {
      // Merge with existing keywords
      const merged = [...this.keywords, ...cleaned];
      this.keywords = [...new Set(merged)];
    }

    await this.saveKeywords(this.keywords);

    const count = this.keywords.length;
    this.log('info', `Imported keywords, total now: ${count}`);

    return count;
  }

  /**
   * Export keywords to array
   */
  exportKeywords(): string[] {
    return this.getKeywords();
  }

  /**
   * Get cache stats
   */
  getCacheStats(): {
    size: number;
    ageMs: number;
    isStale: boolean;
  } {
    return {
      size: this.cache.size,
      ageMs: Date.now() - this.lastLoadTime,
      isStale: this.isCacheStale(),
    };
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    this.clearCache();
    this.log('info', 'KeywordMatcher cleanup complete');
  }

  /**
   * Log helper
   */
  private log(level: string, msg: string): void {
    this.onLog(level, msg);
  }
}
