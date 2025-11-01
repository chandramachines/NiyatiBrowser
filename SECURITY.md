# Security Documentation

## Security Improvements Implemented

### 1. Electron Security Best Practices

#### Context Isolation
- **Status**: ✅ Enabled
- **Implementation**: All `BrowserWindow` instances now use `contextIsolation: true`
- **Benefit**: Prevents renderer processes from accessing Node.js APIs directly

#### Sandbox Mode
- **Status**: ✅ Enabled
- **Implementation**: All windows use `sandbox: true`
- **Benefit**: Isolates renderer processes from system resources

#### Node Integration
- **Status**: ✅ Disabled
- **Implementation**: `nodeIntegration: false` for all windows
- **Benefit**: Prevents direct Node.js access from renderer processes

### 2. Content Security Policy (CSP)

Enhanced CSP in `index.html`:
```
default-src 'self'; 
img-src 'self' data:; 
style-src 'self' 'unsafe-inline'; 
script-src 'self'; 
connect-src 'none'; 
frame-src 'none'; 
object-src 'none'; 
base-uri 'self';
```

**Benefits**:
- Prevents XSS attacks
- Blocks unauthorized script execution
- Prevents clickjacking
- Blocks inline scripts (except styles for UI)

### 3. Path Traversal Protection

#### File Operations
- Implemented path sanitization in `/getfile` command
- Validates all file paths to prevent directory traversal
- Uses `path.basename()` to strip directory components
- Verifies resolved paths stay within allowed directories

#### Upload Handling
- Sanitizes uploaded filenames
- Rejects invalid filenames (`.`, `..`)
- Prevents path injection attacks

### 4. SSRF (Server-Side Request Forgery) Protection

#### `/fetch` Command
- Blocks requests to localhost
- Blocks requests to private IP ranges (192.168.x.x, 10.x.x.x, 172.x.x.x)
- Validates URL format before processing
- Sanitizes output filenames

### 5. Memory Management

#### Event Listeners
- Changed `defaultMaxListeners` from `0` (unlimited) to `30`
- Set `maxListeners` to `20` for webContents
- **Benefit**: Prevents memory leaks from unlimited listeners

#### Batch Processing
- Reduced `BATCH_SIZE_LIMIT` from 1000 to 500
- **Benefit**: Prevents memory exhaustion from large batches

#### Cleanup Improvements
- Enhanced error handling in `gentleMemoryCleanup()`
- Added window validity checks before operations
- Proper resource cleanup on window destruction

### 6. Error Handling

#### Window Operations
- Added `isDestroyed()` checks before window operations
- Graceful degradation when windows are invalid
- Try-catch blocks around all IPC operations

#### JavaScript Execution
- Wrapped all `executeJavaScript` calls with error handlers
- Returns null on failure instead of crashing
- Logs errors for debugging

### 7. IPC (Inter-Process Communication) Security

#### Handler Validation
- All IPC handlers validate input parameters
- Use typed parameters where possible
- Return structured responses

### 8. Credential Management

#### Lock Screen
- Supports password hashing (SHA-256)
- Environment variable configuration
- Secure credential validation

## Configuration

### Environment Variables

Required for secure operation:

```bash
# Telegram Bot (Optional)
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Lock Screen Credentials
LOCK_USER=admin
LOCK_PASS=your_secure_password
# Or use hashed password:
LOCK_PASS_HASH=sha256_hash_of_password

# Auto-login (Optional)
INDIAMART_MOBILE=your_mobile_number

# Lock Persistence
LOCK_PERSIST=1
LOCK_PERSIST_TTL_MS=0

# Other
QUIET=1
```

### Best Practices

1. **Never commit `.env` files** - Use `.env.example` for templates
2. **Use strong passwords** - Minimum 12 characters, mixed case, numbers, symbols
3. **Keep Electron updated** - Regularly update to latest stable version
4. **Review logs** - Monitor application logs for suspicious activity
5. **Limit network access** - Use firewall rules to restrict outbound connections

## Security Checklist

- [x] Context isolation enabled
- [x] Sandbox mode enabled
- [x] Node integration disabled
- [x] Content Security Policy configured
- [x] Path traversal protection
- [x] SSRF protection
- [x] Memory leak prevention
- [x] Event listener limits
- [x] Error handling improvements
- [x] Input validation
- [x] Secure credential management
- [x] `.gitignore` configured

## Reporting Security Issues

If you discover a security vulnerability, please:
1. **Do NOT** open a public issue
2. Contact the maintainers privately
3. Provide detailed information about the vulnerability
4. Allow time for a fix before public disclosure

## References

- [Electron Security Guide](https://www.electronjs.org/docs/latest/tutorial/security)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
