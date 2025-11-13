/**
 * Lock Screen - Renderer Script
 * Handles lock screen authentication
 */

// ============================================================================
// State Management
// ============================================================================

const State = {
  isUnlocking: false,
  attempts: 0,
  maxAttempts: 5,
  lockoutTime: 0,
};

// ============================================================================
// DOM Elements
// ============================================================================

const DOM = {
  form: document.getElementById('lockForm'),
  username: document.getElementById('username'),
  password: document.getElementById('password'),
  btnUnlock: document.getElementById('btnUnlock'),
  errorMessage: document.getElementById('errorMessage'),
  attemptsInfo: document.getElementById('attemptsInfo'),
  version: document.getElementById('version'),
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Show error message
 */
function showError(message) {
  DOM.errorMessage.textContent = message;
  DOM.errorMessage.classList.add('show');

  // Hide after 5 seconds
  setTimeout(() => {
    hideError();
  }, 5000);
}

/**
 * Hide error message
 */
function hideError() {
  DOM.errorMessage.classList.remove('show');
  DOM.errorMessage.textContent = '';
}

/**
 * Update attempts info
 */
function updateAttemptsInfo() {
  const remaining = State.maxAttempts - State.attempts;

  if (State.attempts === 0) {
    DOM.attemptsInfo.textContent = '';
    DOM.attemptsInfo.classList.remove('warning');
    return;
  }

  if (remaining <= 0) {
    DOM.attemptsInfo.textContent = 'Too many failed attempts. Please wait...';
    DOM.attemptsInfo.classList.add('warning');
  } else if (remaining <= 2) {
    DOM.attemptsInfo.textContent = `${remaining} attempt${remaining === 1 ? '' : 's'} remaining`;
    DOM.attemptsInfo.classList.add('warning');
  } else {
    DOM.attemptsInfo.textContent = `${remaining} attempts remaining`;
    DOM.attemptsInfo.classList.remove('warning');
  }
}

/**
 * Set loading state
 */
function setLoading(loading) {
  State.isUnlocking = loading;

  const btnText = DOM.btnUnlock.querySelector('.btn-text');
  const btnSpinner = DOM.btnUnlock.querySelector('.btn-spinner');

  if (loading) {
    btnText.style.display = 'none';
    btnSpinner.style.display = 'inline-block';
    DOM.btnUnlock.disabled = true;
    DOM.username.disabled = true;
    DOM.password.disabled = true;
  } else {
    btnText.style.display = 'inline-block';
    btnSpinner.style.display = 'none';
    DOM.btnUnlock.disabled = false;
    DOM.username.disabled = false;
    DOM.password.disabled = false;
  }
}

/**
 * Validate inputs
 */
function validateInputs(username, password) {
  if (!username || username.trim().length === 0) {
    showError('Please enter username');
    return false;
  }

  if (!password || password.length === 0) {
    showError('Please enter password');
    return false;
  }

  if (username.length > 50) {
    showError('Username too long');
    return false;
  }

  if (password.length > 100) {
    showError('Password too long');
    return false;
  }

  return true;
}

/**
 * Format time remaining
 */
function formatTimeRemaining(ms) {
  const seconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

/**
 * Check lockout status
 */
function checkLockout() {
  if (State.lockoutTime === 0) return false;

  const now = Date.now();
  if (now < State.lockoutTime) {
    const remaining = State.lockoutTime - now;
    showError(`Too many failed attempts. Try again in ${formatTimeRemaining(remaining)}`);
    setLoading(true);

    // Schedule unlock
    setTimeout(() => {
      State.lockoutTime = 0;
      State.attempts = 0;
      setLoading(false);
      hideError();
      updateAttemptsInfo();
    }, remaining);

    return true;
  }

  // Lockout expired
  State.lockoutTime = 0;
  State.attempts = 0;
  updateAttemptsInfo();
  return false;
}

// ============================================================================
// Authentication
// ============================================================================

/**
 * Handle unlock
 */
async function handleUnlock(e) {
  e.preventDefault();

  // Check if already unlocking
  if (State.isUnlocking) return;

  // Check lockout
  if (checkLockout()) return;

  // Get credentials
  const username = DOM.username.value;
  const password = DOM.password.value;

  // Validate
  if (!validateInputs(username, password)) {
    return;
  }

  // Hide previous error
  hideError();

  // Set loading state
  setLoading(true);

  try {
    // Call IPC to unlock
    const result = await window.niyatiAPI.auth.unlock({
      user: username,
      pass: password,
    });

    if (result.success) {
      // Success
      showSuccess();

      // Clear form
      DOM.username.value = '';
      DOM.password.value = '';

      // Reset attempts
      State.attempts = 0;
      updateAttemptsInfo();

      // Window will close automatically
    } else {
      // Failed
      State.attempts++;
      updateAttemptsInfo();

      if (State.attempts >= State.maxAttempts) {
        // Trigger lockout
        State.lockoutTime = Date.now() + 5 * 60 * 1000; // 5 minutes
        checkLockout();
      } else {
        showError(result.error || 'Invalid credentials');
        setLoading(false);
      }

      // Clear password
      DOM.password.value = '';
      DOM.password.focus();
    }
  } catch (error) {
    showError(`Error: ${error.message || 'Unknown error'}`);
    setLoading(false);
  }
}

/**
 * Show success message
 */
function showSuccess() {
  DOM.errorMessage.textContent = '✅ Unlocked!';
  DOM.errorMessage.style.color = 'var(--color-success)';
  DOM.errorMessage.style.borderColor = 'var(--color-success)';
  DOM.errorMessage.style.background = 'rgba(16, 185, 129, 0.1)';
  DOM.errorMessage.classList.add('show');
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize lock screen
 */
async function initialize() {
  console.log('Niyati Browser v2.0 - Lock Screen');

  // Get version
  try {
    const versionResult = await window.niyatiAPI.system.getVersion();
    if (versionResult.success && versionResult.data) {
      DOM.version.textContent = `v${versionResult.data}`;
    }
  } catch (error) {
    console.error('Failed to get version:', error);
  }

  // Setup form handler
  DOM.form.addEventListener('submit', handleUnlock);

  // Focus username input
  DOM.username.focus();

  // Check initial lockout status
  checkLockout();

  // Clear any previous values
  DOM.username.value = '';
  DOM.password.value = '';
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
