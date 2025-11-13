/**
 * Configuration Management
 * Loads and validates environment configuration
 */

import * as fs from 'fs';
import * as path from 'path';
import { AppConfig } from '../types';
import { hashPassword } from '../core/security/auth';

// ============================================================================
// Constants
// ============================================================================

const MAX_ENV_FILE_SIZE = 10 * 1024; // 10KB
const ALLOWED_ENV_VARS = new Set([
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'INDIAMART_MOBILE',
  'LOCK_USER',
  'LOCK_PASS',
  'LOCK_PASS_HASH',
  'LOCK_PERSIST',
  'LOCK_PERSIST_TTL_MS',
  'LOCK_ON_START',
  'DAILY_TZ',
  'DAILY_REPORT_TIMES',
  'DAILY_CATCHUP_MINS',
  'NODE_ENV',
  'QUIET',
]);

// ============================================================================
// Environment Loading
// ============================================================================

/**
 * Load environment variables from .env file
 */
function loadEnvFile(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) {
      console.log('[Config] No .env file found, using defaults');
      return;
    }

    const stats = fs.statSync(filePath);
    if (stats.size > MAX_ENV_FILE_SIZE) {
      console.warn(`[Config] .env file too large (${stats.size} bytes), skipping`);
      return;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      // Skip if not in allowed list
      if (!ALLOWED_ENV_VARS.has(key)) {
        console.warn(`[Config] Ignoring unauthorized env var: ${key}`);
        continue;
      }

      // Remove quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // Size limit
      if (value.length > 500) {
        console.warn(`[Config] ${key} value too long, truncating`);
        value = value.slice(0, 500);
      }

      // Set environment variable
      process.env[key] = value;
    }

    console.log('[Config] Environment loaded from .env');
  } catch (error) {
    console.error('[Config] Failed to load .env:', error);
  }
}

// ============================================================================
// Configuration Builder
// ============================================================================

/**
 * Build application configuration from environment
 */
export function buildConfig(): AppConfig {
  // Load .env file
  const envPath = path.join(process.cwd(), '.env');
  loadEnvFile(envPath);

  // Get values with defaults
  const lockUser = process.env.LOCK_USER || 'admin';
  const lockPass = process.env.LOCK_PASS || 'admin';
  const lockPassHash = process.env.LOCK_PASS_HASH;

  // Warn about default credentials in production
  if (process.env.NODE_ENV === 'production') {
    if (lockUser === 'admin' || lockPass === 'admin') {
      console.error('┌────────────────────────────────────────────┐');
      console.error('│  ⚠️  WARNING: DEFAULT CREDENTIALS IN USE!  │');
      console.error('│  Please set LOCK_USER and LOCK_PASS        │');
      console.error('│  in your .env file for production!         │');
      console.error('└────────────────────────────────────────────┘');
    }
  }

  // Build config object
  const config: AppConfig = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    indiamartMobile: process.env.INDIAMART_MOBILE,
    lockUser,
    lockPass,
    lockPassHash: lockPassHash || hashPassword(lockPass),
    lockPersist: process.env.LOCK_PERSIST !== '0',
    lockPersistTTL: parseInt(process.env.LOCK_PERSIST_TTL_MS || '0', 10),
    lockOnStart: process.env.LOCK_ON_START !== '0',
    dailyTimezone: process.env.DAILY_TZ || 'Asia/Kolkata',
    dailyReportTimes: (process.env.DAILY_REPORT_TIMES || '09:00,18:00')
      .split(',')
      .map(t => t.trim()),
    dailyCatchupMins: parseInt(process.env.DAILY_CATCHUP_MINS || '30', 10),
  };

  return config;
}

// ============================================================================
// Configuration Validation
// ============================================================================

/**
 * Validate configuration
 */
export function validateConfig(config: AppConfig): boolean {
  // Check Telegram config
  if (config.telegramBotToken && !config.telegramChatId) {
    console.warn('[Config] TELEGRAM_BOT_TOKEN set but no TELEGRAM_CHAT_ID');
    return false;
  }

  // Check lock credentials
  if (!config.lockUser || !config.lockPass) {
    console.error('[Config] Lock credentials missing');
    return false;
  }

  // Check daily report times format
  for (const time of config.dailyReportTimes) {
    if (!/^\d{2}:\d{2}$/.test(time)) {
      console.error(`[Config] Invalid daily report time format: ${time}`);
      return false;
    }
  }

  return true;
}

// ============================================================================
// Export Default Config
// ============================================================================

let cachedConfig: AppConfig | null = null;

/**
 * Get application configuration (cached)
 */
export function getConfig(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = buildConfig();

    if (!validateConfig(cachedConfig)) {
      console.warn('[Config] Configuration validation failed, using defaults');
    }

    // Log configuration (hide sensitive data)
    if (process.env.QUIET !== '1') {
      console.log('[Config] Application configuration:');
      console.log('  - Telegram:', cachedConfig.telegramBotToken ? 'Enabled' : 'Disabled');
      console.log('  - Lock User:', cachedConfig.lockUser);
      console.log('  - Lock on Start:', cachedConfig.lockOnStart);
      console.log('  - Lock Persist:', cachedConfig.lockPersist);
      console.log('  - Daily Timezone:', cachedConfig.dailyTimezone);
      console.log('  - Daily Reports:', cachedConfig.dailyReportTimes.join(', '));
    }
  }

  return cachedConfig;
}

/**
 * Reload configuration
 */
export function reloadConfig(): AppConfig {
  cachedConfig = null;
  return getConfig();
}
