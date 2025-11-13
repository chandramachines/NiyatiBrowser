/**
 * NiyatiBrowser v2.0 - Type Definitions
 * Complete type safety for all modules
 */

// ============================================================================
// Core Types
// ============================================================================

export interface AppConfig {
  readonly telegramBotToken?: string;
  readonly telegramChatId?: string;
  readonly indiamartMobile?: string;
  readonly lockUser: string;
  readonly lockPass: string;
  readonly lockPassHash?: string;
  readonly lockPersist: boolean;
  readonly lockPersistTTL: number;
  readonly lockOnStart: boolean;
  readonly dailyTimezone: string;
  readonly dailyReportTimes: string[];
  readonly dailyCatchupMins: number;
}

export interface WindowConfig {
  title: string;
  width: number;
  height: number;
  show?: boolean;
  frame?: boolean;
  minWidth?: number;
  minHeight?: number;
}

// ============================================================================
// Authentication Types
// ============================================================================

export interface Credentials {
  user: string;
  pass: string;
}

export interface AuthResult {
  valid: boolean;
  reason?: string;
}

export interface RateLimitRecord {
  count: number;
  firstAttempt: number;
  lockedUntil: number;
}

// ============================================================================
// Scraping Types
// ============================================================================

export interface Product {
  index: number;
  title: string;
  city?: string;
  state?: string;
  location?: string;
}

export interface ProductLogEntry {
  serial: number;
  timestamp: string;
  name: string;
  location: string;
}

export interface ScraperConfig {
  delayMs: number;
  maxItems: number;
  loginSelector: string;
}

export interface ScraperState {
  enabled: boolean;
  intervalMs: number;
  userWantedAutoRefresh: boolean;
  isLoggedIn: boolean | null;
  suspendedByAuth: boolean;
  isNetworkOnline: boolean;
  lastStartAt: number;
  lastStopAt: number;
  lastCycleAt: number;
  cycles: number;
}

// ============================================================================
// Keyword Matching Types
// ============================================================================

export interface KeywordMatch {
  title: string;
  location: string;
  keywords: string[];
}

export interface KeywordMatchEntry {
  serial: number;
  timestamp: string;
  name: string;
  location: string;
}

export interface KeywordMatchResult {
  matched: boolean;
  keyword: string | null;
  title: string;
}

// ============================================================================
// Message Centre Types
// ============================================================================

export interface Lead {
  index?: number;
  name?: string;
  mobile?: string;
  email?: string;
  company?: string;
  gstin?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  product?: string;
  message?: string;
}

export interface LeadLogEntry {
  serial: number;
  timestamp: string;
  name: string;
  mobile: string;
  email: string;
  company: string;
  gstin: string;
  address: string;
  city: string;
  state: string;
  country: string;
  product: string;
  message: string;
}

export interface MessageCentreState {
  isLoggedIn: boolean | null;
  lastScrapeAt: number;
  totalLeads: number;
  newLeadsToday: number;
}

// ============================================================================
// Automation Types
// ============================================================================

export interface MatchClickResult {
  clicked: number;
  skipped: number;
  failed: number;
}

export interface ClickRecord {
  title: string;
  index: number;
  matched: string;
  status: 'ok' | 'fail' | 'skip';
  timestamp: string;
}

export interface MatchClickerState {
  enabled: boolean;
  intervalMs: number;
  totalClicks: number;
  clicksToday: number;
  lastClickAt: number;
}

export interface ClickHistoryEntry {
  timestamp: string;
  productTitle: string;
  productIndex: number;
  keyword: string;
  location: string;
}

// ============================================================================
// Telegram Types
// ============================================================================

export interface TelegramMessage {
  text: string;
  extra?: {
    parse_mode?: 'HTML' | 'Markdown';
    disable_web_page_preview?: boolean;
  };
}

export interface TelegramCommand {
  cmd: string;
  args: string;
  raw: string;
}

export interface TelegramCommandHandler {
  desc: string;
  hidden?: boolean;
  handler: (ctx: TelegramCommandContext) => Promise<void> | void;
}

export interface TelegramCommandContext {
  cmd: string;
  args: string;
  raw: string;
  send: (text: string, extra?: Record<string, unknown>) => Promise<void>;
  sendPhoto: (buffer: Buffer, options?: Record<string, unknown>) => Promise<void>;
  sendMediaGroup: (photos: Array<{ name: string; buf: Buffer; caption?: string }>) => Promise<void>;
}

// ============================================================================
// IPC Types
// ============================================================================

export interface IPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface LogEntry {
  t: number;
  level: 'info' | 'error' | 'warning' | 'debug' | 'start' | 'stop';
  msg: string;
}

// ============================================================================
// Lock Screen Types
// ============================================================================

export interface LockState {
  unlocked: boolean;
  at?: string;
  source?: string;
  expiresAt?: number;
}

// ============================================================================
// Status Types
// ============================================================================

export interface StatusReport {
  uptime: number;
  memory: number;
  isLoggedIn: boolean | null;
  isNetworkOnline: boolean;
  refreshEnabled: boolean;
  refreshInterval: number;
  lastScrapedProduct: string | null;
  lastKeywordMatch: string | null;
  newProductsLast30Min: number;
  clicksLast30Min: number;
}

// ============================================================================
// Validation Types
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  error?: string;
  sanitized?: unknown;
}

// ============================================================================
// File Operation Types
// ============================================================================

export interface FileCache<T> {
  data: T | null;
  timestamp: number;
}

export interface WriteOptions {
  atomic?: boolean;
  backup?: boolean;
  mode?: number;
}

// ============================================================================
// Error Types
// ============================================================================

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class RateLimitError extends Error {
  constructor(message: string, public readonly retryAfter: number) {
    super(message);
    this.name = 'RateLimitError';
  }
}

// ============================================================================
// Utility Types
// ============================================================================

export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;
export type AsyncFunction<T = void> = () => Promise<T>;
export type Callback<T = void> = (data: T) => void;
export type ErrorCallback = (error: Error) => void;

// ============================================================================
// Module Exports
// ============================================================================

export interface NiyatiModule {
  readonly name: string;
  readonly version: string;
  initialize(): Promise<void>;
  cleanup(): Promise<void>;
}
