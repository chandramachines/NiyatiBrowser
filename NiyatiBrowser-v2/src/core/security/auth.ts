/**
 * Authentication Module
 * Timing-safe password verification with rate limiting
 */

import * as crypto from 'crypto';
import { AuthResult, RateLimitRecord, RateLimitError } from '../../types';
import { validateCredentials } from './validation';

// ============================================================================
// Constants
// ============================================================================

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes
const ATTEMPT_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 3600000; // 1 hour

// ============================================================================
// Rate Limiting
// ============================================================================

class RateLimiter {
  private attempts: Map<string, RateLimitRecord> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startCleanup();
  }

  /**
   * Check if request is allowed
   */
  check(identifier: string): AuthResult {
    const now = Date.now();
    const record = this.attempts.get(identifier) || {
      count: 0,
      firstAttempt: now,
      lockedUntil: 0,
    };

    // Check if currently locked out
    if (record.lockedUntil > now) {
      const remaining = Math.ceil((record.lockedUntil - now) / 1000);
      return {
        valid: false,
        reason: `Too many attempts. Locked for ${remaining}s`,
      };
    }

    // Check if max attempts exceeded
    if (record.count >= MAX_ATTEMPTS) {
      record.lockedUntil = now + LOCKOUT_MS;
      this.attempts.set(identifier, record);
      return {
        valid: false,
        reason: `Too many attempts. Locked for ${LOCKOUT_MS / 1000}s`,
      };
    }

    return { valid: true };
  }

  /**
   * Record failed attempt
   */
  recordFailure(identifier: string): void {
    const now = Date.now();
    const record = this.attempts.get(identifier) || {
      count: 0,
      firstAttempt: now,
      lockedUntil: 0,
    };

    // Reset if window expired
    if (now - record.firstAttempt > ATTEMPT_EXPIRY_MS) {
      record.count = 1;
      record.firstAttempt = now;
    } else {
      record.count++;
    }

    this.attempts.set(identifier, record);
  }

  /**
   * Clear attempts for identifier
   */
  clear(identifier: string): void {
    this.attempts.delete(identifier);
  }

  /**
   * Clean up old attempts
   */
  private cleanup(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [identifier, record] of this.attempts.entries()) {
      if (now - record.firstAttempt > ATTEMPT_EXPIRY_MS && record.lockedUntil < now) {
        toDelete.push(identifier);
      }
    }

    for (const id of toDelete) {
      this.attempts.delete(id);
    }
  }

  /**
   * Start periodic cleanup
   */
  private startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  /**
   * Stop cleanup timer
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.attempts.clear();
  }
}

// Global rate limiter instance
const rateLimiter = new RateLimiter();

// ============================================================================
// Timing-Safe Comparison
// ============================================================================

/**
 * Constant-time string comparison to prevent timing attacks
 */
export function timingSafeCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(String(a || ''), 'utf-8');
    const bufB = Buffer.from(String(b || ''), 'utf-8');

    // Pad to fixed length to prevent length-based timing attacks
    const maxLen = 256;
    const paddedA = Buffer.concat([bufA, Buffer.alloc(maxLen)]).slice(0, maxLen);
    const paddedB = Buffer.concat([bufB, Buffer.alloc(maxLen)]).slice(0, maxLen);

    return crypto.timingSafeEqual(paddedA, paddedB);
  } catch {
    return false;
  }
}

// ============================================================================
// Password Hashing
// ============================================================================

/**
 * Hash password using PBKDF2
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .pbkdf2Sync(password, salt, 100000, 64, 'sha512')
    .toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify password against hash
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  try {
    const [salt, hash] = storedHash.split(':');
    if (!salt || !hash) return false;

    const verifyHash = crypto
      .pbkdf2Sync(password, salt, 100000, 64, 'sha512')
      .toString('hex');

    return timingSafeCompare(hash, verifyHash);
  } catch {
    return false;
  }
}

// ============================================================================
// Authentication
// ============================================================================

/**
 * Authenticate credentials with rate limiting
 */
export async function authenticate(
  creds: unknown,
  expectedUser: string,
  expectedPass: string,
  identifier = 'default'
): Promise<AuthResult> {
  try {
    // Validate input
    const validated = validateCredentials(creds);

    // Check rate limit
    const rateLimitCheck = rateLimiter.check(identifier);
    if (!rateLimitCheck.valid) {
      throw new RateLimitError(rateLimitCheck.reason || 'Rate limited', LOCKOUT_MS);
    }

    // Timing-safe comparison for both username and password
    const userMatch = timingSafeCompare(validated.user, expectedUser);
    const passMatch = timingSafeCompare(validated.pass, expectedPass);

    if (userMatch && passMatch) {
      // Success - clear rate limit
      rateLimiter.clear(identifier);
      return { valid: true };
    }

    // Failed - record attempt
    rateLimiter.recordFailure(identifier);
    return {
      valid: false,
      reason: 'Invalid credentials',
    };
  } catch (error) {
    if (error instanceof RateLimitError) {
      throw error;
    }

    // Record failure for validation errors too
    rateLimiter.recordFailure(identifier);

    return {
      valid: false,
      reason: error instanceof Error ? error.message : 'Authentication failed',
    };
  }
}

/**
 * Authenticate against password hash
 */
export async function authenticateWithHash(
  creds: unknown,
  expectedUser: string,
  passwordHash: string,
  identifier = 'default'
): Promise<AuthResult> {
  try {
    // Validate input
    const validated = validateCredentials(creds);

    // Check rate limit
    const rateLimitCheck = rateLimiter.check(identifier);
    if (!rateLimitCheck.valid) {
      throw new RateLimitError(rateLimitCheck.reason || 'Rate limited', LOCKOUT_MS);
    }

    // Check username and password
    const userMatch = timingSafeCompare(validated.user, expectedUser);
    const passMatch = verifyPassword(validated.pass, passwordHash);

    if (userMatch && passMatch) {
      rateLimiter.clear(identifier);
      return { valid: true };
    }

    rateLimiter.recordFailure(identifier);
    return {
      valid: false,
      reason: 'Invalid credentials',
    };
  } catch (error) {
    if (error instanceof RateLimitError) {
      throw error;
    }

    rateLimiter.recordFailure(identifier);

    return {
      valid: false,
      reason: error instanceof Error ? error.message : 'Authentication failed',
    };
  }
}

/**
 * Clear rate limit for identifier
 */
export function clearRateLimit(identifier: string): void {
  rateLimiter.clear(identifier);
}

/**
 * Cleanup authentication resources
 */
export function cleanupAuth(): void {
  rateLimiter.destroy();
}
