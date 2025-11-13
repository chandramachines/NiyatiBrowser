/**
 * Manager Window - Renderer Script
 * Handles UI interactions and IPC communication
 */

// ============================================================================
// State Management
// ============================================================================

const State = {
  products: [],
  keywords: [],
  logs: [],
  maxLogs: 100,
  refreshState: {
    enabled: false,
    intervalMs: 7000,
  },
  isOnline: true,
};

// ============================================================================
// DOM Elements
// ============================================================================

const DOM = {
  // Window controls
  btnMin: document.getElementById('btnMin'),
  btnMax: document.getElementById('btnMax'),
  btnClose: document.getElementById('btnClose'),

  // Network status
  netChip: document.getElementById('netChip'),

  // Refresh controls
  refreshInterval: document.getElementById('refreshInterval'),
  btnStartRefresh: document.getElementById('btnStartRefresh'),
  btnStopRefresh: document.getElementById('btnStopRefresh'),

  // Products
  formAddProduct: document.getElementById('formAddProduct'),
  inputProduct: document.getElementById('inputProduct'),
  productsList: document.getElementById('productsList'),
  btnCollapseProducts: document.getElementById('btnCollapseProducts'),

  // Keywords
  formAddKeyword: document.getElementById('formAddKeyword'),
  inputKeyword: document.getElementById('inputKeyword'),
  keywordsList: document.getElementById('keywordsList'),
  btnCollapseKeywords: document.getElementById('btnCollapseKeywords'),

  // Activity log
  activityLog: document.getElementById('activityLog'),
  logCount: document.getElementById('logCount'),
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str || '');
  return div.innerHTML;
}

/**
 * Format timestamp
 */
function formatTime(timestamp) {
  const d = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Show loading indicator
 */
function showLoading() {
  document.getElementById('loadingIndicator').style.display = 'flex';
}

/**
 * Hide loading indicator
 */
function hideLoading() {
  document.getElementById('loadingIndicator').style.display = 'none';
}

/**
 * Show notification
 */
function notify(message, type = 'info') {
  appendLog({
    t: Date.now(),
    level: type,
    msg: message,
  });
}

// ============================================================================
// Products Management
// ============================================================================

/**
 * Render products list
 */
function renderProducts() {
  const list = DOM.productsList;
  list.innerHTML = '';

  if (State.products.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = 'No products yet. Add one above!';
    empty.style.opacity = '0.5';
    empty.style.padding = '10px';
    list.appendChild(empty);
    return;
  }

  State.products.forEach((product, index) => {
    const li = document.createElement('li');
    li.className = 'pill';
    li.setAttribute('role', 'listitem');

    const left = document.createElement('div');
    left.className = 'left';

    const serial = document.createElement('span');
    serial.className = 'serial';
    serial.textContent = index + 1;

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = product;

    left.appendChild(serial);
    left.appendChild(title);

    const btnDel = document.createElement('button');
    btnDel.className = 'del';
    btnDel.textContent = '✕';
    btnDel.title = `Delete ${product}`;
    btnDel.setAttribute('aria-label', `Delete ${product}`);
    btnDel.onclick = () => deleteProduct(product);

    li.appendChild(left);
    li.appendChild(btnDel);
    list.appendChild(li);
  });

  // Save to localStorage
  saveProducts();
}

/**
 * Add product
 */
async function addProduct(name) {
  const trimmed = name.trim();

  if (!trimmed) {
    notify('Product name cannot be empty', 'warning');
    return;
  }

  if (trimmed.length > 200) {
    notify('Product name too long (max 200 characters)', 'warning');
    return;
  }

  // Check duplicates (case-insensitive)
  const exists = State.products.some(
    (p) => p.toLowerCase() === trimmed.toLowerCase()
  );

  if (exists) {
    notify('Product already exists', 'warning');
    return;
  }

  // Add to state
  State.products.push(trimmed);
  renderProducts();

  // Send to main process
  try {
    const result = await window.niyatiAPI.lists.saveProducts(State.products);
    if (result.success) {
      notify(`Added product: ${trimmed}`, 'info');
    } else {
      notify(`Failed to save: ${result.error}`, 'error');
    }
  } catch (error) {
    notify(`Error: ${error.message}`, 'error');
  }

  // Clear input
  DOM.inputProduct.value = '';
  DOM.inputProduct.focus();
}

/**
 * Delete product
 */
async function deleteProduct(name) {
  const index = State.products.indexOf(name);
  if (index === -1) return;

  State.products.splice(index, 1);
  renderProducts();

  // Send to main process
  try {
    const result = await window.niyatiAPI.lists.saveProducts(State.products);
    if (result.success) {
      notify(`Deleted product: ${name}`, 'info');
    } else {
      notify(`Failed to save: ${result.error}`, 'error');
    }
  } catch (error) {
    notify(`Error: ${error.message}`, 'error');
  }
}

/**
 * Save products to localStorage
 */
function saveProducts() {
  try {
    localStorage.setItem('niyati:products', JSON.stringify(State.products));
  } catch (error) {
    console.error('Failed to save products to localStorage:', error);
  }
}

/**
 * Load products from localStorage
 */
function loadProducts() {
  try {
    const stored = localStorage.getItem('niyati:products');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        State.products = parsed;
      }
    }
  } catch (error) {
    console.error('Failed to load products from localStorage:', error);
  }
  renderProducts();
}

// ============================================================================
// Keywords Management
// ============================================================================

/**
 * Render keywords list
 */
function renderKeywords() {
  const list = DOM.keywordsList;
  list.innerHTML = '';

  if (State.keywords.length === 0) {
    const empty = document.createElement('span');
    empty.textContent = 'No keywords yet. Add one above!';
    empty.style.opacity = '0.5';
    list.appendChild(empty);
    return;
  }

  State.keywords.forEach((keyword) => {
    const kw = document.createElement('span');
    kw.className = 'kw';

    const text = document.createElement('span');
    text.textContent = keyword;

    const btnRm = document.createElement('button');
    btnRm.className = 'rm';
    btnRm.textContent = '✕';
    btnRm.title = `Remove ${keyword}`;
    btnRm.setAttribute('aria-label', `Remove ${keyword}`);
    btnRm.onclick = () => deleteKeyword(keyword);

    kw.appendChild(text);
    kw.appendChild(btnRm);
    list.appendChild(kw);
  });

  // Save to localStorage
  saveKeywords();
}

/**
 * Add keyword
 */
async function addKeyword(word) {
  const trimmed = word.trim().toLowerCase();

  if (!trimmed) {
    notify('Keyword cannot be empty', 'warning');
    return;
  }

  if (trimmed.length > 100) {
    notify('Keyword too long (max 100 characters)', 'warning');
    return;
  }

  // Check duplicates
  if (State.keywords.includes(trimmed)) {
    notify('Keyword already exists', 'warning');
    return;
  }

  // Add to state
  State.keywords.push(trimmed);
  renderKeywords();

  // Send to main process
  try {
    const result = await window.niyatiAPI.lists.saveKeywords(State.keywords);
    if (result.success) {
      notify(`Added keyword: ${trimmed}`, 'info');
    } else {
      notify(`Failed to save: ${result.error}`, 'error');
    }
  } catch (error) {
    notify(`Error: ${error.message}`, 'error');
  }

  // Clear input
  DOM.inputKeyword.value = '';
  DOM.inputKeyword.focus();
}

/**
 * Delete keyword
 */
async function deleteKeyword(word) {
  const index = State.keywords.indexOf(word);
  if (index === -1) return;

  State.keywords.splice(index, 1);
  renderKeywords();

  // Send to main process
  try {
    const result = await window.niyatiAPI.lists.saveKeywords(State.keywords);
    if (result.success) {
      notify(`Deleted keyword: ${word}`, 'info');
    } else {
      notify(`Failed to save: ${result.error}`, 'error');
    }
  } catch (error) {
    notify(`Error: ${error.message}`, 'error');
  }
}

/**
 * Save keywords to localStorage
 */
function saveKeywords() {
  try {
    localStorage.setItem('niyati:keywords', JSON.stringify(State.keywords));
  } catch (error) {
    console.error('Failed to save keywords to localStorage:', error);
  }
}

/**
 * Load keywords from localStorage
 */
function loadKeywords() {
  try {
    const stored = localStorage.getItem('niyati:keywords');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        State.keywords = parsed;
      }
    }
  } catch (error) {
    console.error('Failed to load keywords from localStorage:', error);
  }
  renderKeywords();
}

// ============================================================================
// Activity Log
// ============================================================================

/**
 * Append log entry
 */
function appendLog(entry) {
  // Add to state
  State.logs.unshift(entry);

  // Limit logs
  if (State.logs.length > State.maxLogs) {
    State.logs = State.logs.slice(0, State.maxLogs);
  }

  // Update count
  DOM.logCount.textContent = State.logs.length;

  // Render
  renderLog(entry);
}

/**
 * Render single log entry
 */
function renderLog(entry) {
  const logbox = document.createElement('div');
  logbox.className = `logbox level-${entry.level}`;

  const header = document.createElement('div');
  header.className = 'loghdr';

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatTime(entry.t);

  const module = document.createElement('span');
  module.className = 'module';
  module.textContent = entry.level.toUpperCase();

  header.appendChild(time);
  header.appendChild(module);

  const msg = document.createElement('div');
  msg.className = 'logmsg';
  msg.textContent = entry.msg;

  logbox.appendChild(header);
  logbox.appendChild(msg);

  // Insert at top
  DOM.activityLog.insertBefore(logbox, DOM.activityLog.firstChild);

  // Remove old entries from DOM
  while (DOM.activityLog.children.length > State.maxLogs) {
    DOM.activityLog.removeChild(DOM.activityLog.lastChild);
  }
}

// ============================================================================
// Refresh Controls
// ============================================================================

/**
 * Start auto-refresh
 */
async function startRefresh() {
  const intervalSec = parseInt(DOM.refreshInterval.value, 10);

  if (isNaN(intervalSec) || intervalSec < 3 || intervalSec > 60) {
    notify('Invalid interval (3-60 seconds)', 'warning');
    return;
  }

  const intervalMs = intervalSec * 1000;

  try {
    const result = await window.niyatiAPI.refresh.enable(intervalMs);
    if (result.success) {
      State.refreshState.enabled = true;
      State.refreshState.intervalMs = intervalMs;
      updateRefreshUI();
      notify(`Auto-refresh started @ ${intervalSec}s`, 'info');
    } else {
      notify(`Failed to start: ${result.error}`, 'error');
    }
  } catch (error) {
    notify(`Error: ${error.message}`, 'error');
  }
}

/**
 * Stop auto-refresh
 */
async function stopRefresh() {
  try {
    const result = await window.niyatiAPI.refresh.disable();
    if (result.success) {
      State.refreshState.enabled = false;
      updateRefreshUI();
      notify('Auto-refresh stopped', 'info');
    } else {
      notify(`Failed to stop: ${result.error}`, 'error');
    }
  } catch (error) {
    notify(`Error: ${error.message}`, 'error');
  }
}

/**
 * Update refresh UI state
 */
function updateRefreshUI() {
  if (State.refreshState.enabled) {
    DOM.btnStartRefresh.disabled = true;
    DOM.btnStopRefresh.disabled = false;
    DOM.refreshInterval.disabled = true;
  } else {
    DOM.btnStartRefresh.disabled = false;
    DOM.btnStopRefresh.disabled = true;
    DOM.refreshInterval.disabled = false;
  }
}

// ============================================================================
// Network Status
// ============================================================================

/**
 * Update network status UI
 */
function updateNetworkStatus(isOnline) {
  State.isOnline = isOnline;

  if (isOnline) {
    DOM.netChip.classList.add('online');
    DOM.netChip.classList.remove('offline');
    DOM.netChip.querySelector('.label').textContent = 'Online';
  } else {
    DOM.netChip.classList.remove('online');
    DOM.netChip.classList.add('offline');
    DOM.netChip.querySelector('.label').textContent = 'Offline';
  }
}

// ============================================================================
// Card Collapse
// ============================================================================

/**
 * Toggle card collapse
 */
function toggleCardCollapse(card, button) {
  card.classList.toggle('is-collapsed');
  button.textContent = card.classList.contains('is-collapsed') ? '+' : '−';
}

// ============================================================================
// Event Listeners
// ============================================================================

/**
 * Setup all event listeners
 */
function setupEventListeners() {
  // Window controls
  DOM.btnMin.addEventListener('click', () => {
    window.niyatiAPI.window.minimize();
  });

  DOM.btnMax.addEventListener('click', () => {
    window.niyatiAPI.window.maximize();
  });

  DOM.btnClose.addEventListener('click', () => {
    window.niyatiAPI.window.close();
  });

  // Products
  DOM.formAddProduct.addEventListener('submit', (e) => {
    e.preventDefault();
    addProduct(DOM.inputProduct.value);
  });

  DOM.btnCollapseProducts.addEventListener('click', () => {
    toggleCardCollapse(
      DOM.btnCollapseProducts.closest('.card'),
      DOM.btnCollapseProducts
    );
  });

  // Keywords
  DOM.formAddKeyword.addEventListener('submit', (e) => {
    e.preventDefault();
    addKeyword(DOM.inputKeyword.value);
  });

  DOM.btnCollapseKeywords.addEventListener('click', () => {
    toggleCardCollapse(
      DOM.btnCollapseKeywords.closest('.card'),
      DOM.btnCollapseKeywords
    );
  });

  // Refresh controls
  DOM.btnStartRefresh.addEventListener('click', startRefresh);
  DOM.btnStopRefresh.addEventListener('click', stopRefresh);

  // IPC listeners
  window.niyatiAPI.window.onStateChange((state) => {
    console.log('Window state changed:', state);
  });

  window.niyatiAPI.log.onAppend((entry) => {
    appendLog(entry);
  });

  window.niyatiAPI.refresh.onStateChange((state) => {
    State.refreshState = state;
    updateRefreshUI();
  });
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize application
 */
async function initialize() {
  console.log('Niyati Browser v2.0 - Manager Window');

  // Load data
  loadProducts();
  loadKeywords();

  // Setup event listeners
  setupEventListeners();

  // Update UI
  updateRefreshUI();
  updateNetworkStatus(true);

  // Get system info
  try {
    const versionResult = await window.niyatiAPI.system.getVersion();
    if (versionResult.success) {
      console.log('Version:', versionResult.data);
    }
  } catch (error) {
    console.error('Failed to get version:', error);
  }

  // Initial log
  notify('Manager window initialized', 'info');
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
