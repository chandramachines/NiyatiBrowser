/**
 * Input Validation & Sanitization Module
 * Prevents injection attacks, validates all user input
 */

import { ValidationError, ValidationResult, Credentials } from '../../types';

// ============================================================================
// Constants
// ============================================================================

const MAX_STRING_LENGTH = 1000;
const MAX_ARRAY_LENGTH = 1000;
const MAX_NUMBER = 3600000; // 1 hour in ms
const MIN_NUMBER = 3000; // 3 seconds in ms

// Security patterns
const DANGEROUS_PATTERNS = {
  SHELL_INJECTION: /(\$\(|\$\{|`|;|\||&)/g,
  PATH_TRAVERSAL: /\.\.[\/\\]/g,
  SCRIPT_TAG: /<script|javascript:|data:text\/html|onerror=/i,
  SQL_INJECTION: /(\bor\b|\band\b|union|select|insert|update|delete|drop|create)/gi,
};

// ============================================================================
// String Validation
// ============================================================================

/**
 * Validate and sanitize string input
 */
export function validateString(
  value: unknown,
  options: {
    maxLength?: number;
    minLength?: number;
    allowEmpty?: boolean;
    pattern?: RegExp;
  } = {}
): ValidationResult {
  const {
    maxLength = MAX_STRING_LENGTH,
    minLength = 0,
    allowEmpty = false,
    pattern,
  } = options;

  // Type check
  if (typeof value !== 'string') {
    return {
      valid: false,
      error: 'Value must be a string',
    };
  }

  const str = value.trim();

  // Empty check
  if (!allowEmpty && str.length === 0) {
    return {
      valid: false,
      error: 'String cannot be empty',
    };
  }

  // Length check
  if (str.length < minLength) {
    return {
      valid: false,
      error: `String must be at least ${minLength} characters`,
    };
  }

  if (str.length > maxLength) {
    return {
      valid: false,
      error: `String exceeds maximum length of ${maxLength}`,
    };
  }

  // Pattern check
  if (pattern && !pattern.test(str)) {
    return {
      valid: false,
      error: 'String does not match required pattern',
    };
  }

  return {
    valid: true,
    sanitized: str,
  };
}

/**
 * Sanitize string by removing dangerous characters
 */
export function sanitizeString(value: string, maxLength = MAX_STRING_LENGTH): string {
  let clean = String(value || '');

  // Remove shell injection patterns
  clean = clean.replace(DANGEROUS_PATTERNS.SHELL_INJECTION, '');

  // Remove path traversal
  clean = clean.replace(DANGEROUS_PATTERNS.PATH_TRAVERSAL, '');

  // Remove only unsafe unicode characters, keep international chars
  clean = clean.replace(/[^\p{L}\p{N}\s.,_@+()-]/gu, '');

  // Limit length
  clean = clean.slice(0, maxLength).trim();

  return clean;
}

/**
 * Escape HTML to prevent XSS
 * Works in both Node.js and browser environments
 */
export function escapeHtml(str: string): string {
  const s = String(str || '');

  // If in browser, use DOM API
  // @ts-ignore - document is available in renderer process
  if (typeof globalThis !== 'undefined' && globalThis.document) {
    // @ts-ignore
    const div = globalThis.document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  // Otherwise use manual escaping (Node.js environment)
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

/**
 * Sanitize filename for safe file operations
 */
export function sanitizeFilename(filename: string): string {
  return String(filename)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '') // Remove leading dots
    .slice(0, 255);
}

// ============================================================================
// Number Validation
// ============================================================================

/**
 * Validate numeric input with range checking
 */
export function validateNumber(
  value: unknown,
  options: {
    min?: number;
    max?: number;
    integer?: boolean;
  } = {}
): ValidationResult {
  const { min = MIN_NUMBER, max = MAX_NUMBER, integer = false } = options;

  const num = Number(value);

  // Check if valid number
  if (!Number.isFinite(num)) {
    return {
      valid: false,
      error: 'Value must be a finite number',
    };
  }

  // Integer check
  if (integer && !Number.isInteger(num)) {
    return {
      valid: false,
      error: 'Value must be an integer',
    };
  }

  // Range check
  if (num < min) {
    return {
      valid: false,
      error: `Value must be at least ${min}`,
    };
  }

  if (num > max) {
    return {
      valid: false,
      error: `Value must not exceed ${max}`,
    };
  }

  return {
    valid: true,
    sanitized: num,
  };
}

// ============================================================================
// Array Validation
// ============================================================================

/**
 * Validate array with size limits
 */
export function validateArray<T>(
  value: unknown,
  options: {
    maxLength?: number;
    minLength?: number;
    itemValidator?: (item: unknown) => ValidationResult;
  } = {}
): ValidationResult {
  const { maxLength = MAX_ARRAY_LENGTH, minLength = 0, itemValidator } = options;

  // Type check
  if (!Array.isArray(value)) {
    return {
      valid: false,
      error: 'Value must be an array',
    };
  }

  // Length check
  if (value.length < minLength) {
    return {
      valid: false,
      error: `Array must have at least ${minLength} items`,
    };
  }

  if (value.length > maxLength) {
    return {
      valid: false,
      error: `Array exceeds maximum length of ${maxLength}`,
    };
  }

  // Validate items if validator provided
  if (itemValidator) {
    for (let i = 0; i < value.length; i++) {
      const result = itemValidator(value[i]);
      if (!result.valid) {
        return {
          valid: false,
          error: `Array item at index ${i} is invalid: ${result.error}`,
        };
      }
    }
  }

  return {
    valid: true,
    sanitized: value as T[],
  };
}

// ============================================================================
// Credentials Validation
// ============================================================================

/**
 * Validate and sanitize credentials
 */
export function validateCredentials(creds: unknown): Credentials {
  // Type check
  if (!creds || typeof creds !== 'object') {
    throw new ValidationError('Invalid credentials object');
  }

  const obj = creds as Record<string, unknown>;

  // Extract user
  let user = '';
  if ('user' in obj) {
    if (typeof obj.user === 'string') {
      user = obj.user;
    } else if (obj.user != null) {
      user = String(obj.user);
    }
  }

  // Extract pass
  let pass = '';
  if ('pass' in obj) {
    if (typeof obj.pass === 'string') {
      pass = obj.pass;
    } else if (obj.pass != null) {
      pass = String(obj.pass);
    }
  }

  // Apply length limits
  user = user.slice(0, 100).trim();
  pass = pass.slice(0, 256).trim();

  // Validate not empty
  if (!user || !pass) {
    throw new ValidationError('Username and password are required');
  }

  return { user, pass };
}

// ============================================================================
// Email Validation
// ============================================================================

/**
 * Validate email address
 */
export function isValidEmail(email: string): boolean {
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
  return emailPattern.test(email);
}

// ============================================================================
// Security Checks
// ============================================================================

/**
 * Check if string contains dangerous patterns
 */
export function hasDangerousContent(str: string): boolean {
  const value = String(str);

  for (const pattern of Object.values(DANGEROUS_PATTERNS)) {
    if (pattern.test(value)) {
      return true;
    }
  }

  return false;
}

/**
 * Validate clipboard content for safety
 */
export function validateClipboardContent(
  content: string,
  maxLength = 10000
): ValidationResult {
  if (content.length > maxLength) {
    return {
      valid: false,
      error: `Content too large (${content.length} chars)`,
    };
  }

  if (hasDangerousContent(content)) {
    return {
      valid: false,
      error: 'Content contains dangerous patterns',
    };
  }

  return {
    valid: true,
    sanitized: content,
  };
}

// ============================================================================
// Path Validation
// ============================================================================

/**
 * Validate file path to prevent traversal attacks
 */
export function validatePath(filePath: string, baseDir: string): boolean {
  const path = require('path');

  const resolvedPath = path.resolve(filePath);
  const resolvedBase = path.resolve(baseDir);

  return resolvedPath.startsWith(resolvedBase);
}
