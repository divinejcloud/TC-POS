'use strict';

/* ============================================================
   SECURE SUPABASE CREDENTIAL RESOLVER (GITHUB-SAFE)
   ============================================================ */
const DEFAULT_SUPABASE_URL = 'https://fxhbfwpvxfbphmupaqep.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ4aGJmd3B2eGZicGhtdXBhcWVwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUzMjY4MDksImV4cCI6MjExMDkwMjgwOX0.FWLitjTSL-cGWrh-62tltEj4aAWHpUqLgUfWMo4miwk';

function isPlaceholderCredential(val) {
  const s = String(val || '').trim();
  return !s || s === DEFAULT_SUPABASE_URL || s === DEFAULT_SUPABASE_ANON_KEY || s.includes('YOUR_SUPABASE');
}

function normalizeSupabaseUrl(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '');
  u = u.replace(/\/rest\/v1$/i, '');
  return u;
}

function getSupabaseCredentials() {
  const ext = (window.POS_CONFIG && typeof window.POS_CONFIG === 'object') ? window.POS_CONFIG : {};
  const extUrl = !isPlaceholderCredential(ext.SUPABASE_URL) ? normalizeSupabaseUrl(ext.SUPABASE_URL) : '';
  const extKey = !isPlaceholderCredential(ext.SUPABASE_ANON_KEY) ? String(ext.SUPABASE_ANON_KEY).trim() : '';

  const lsUrl = !isPlaceholderCredential(lsGet('pos_sb_url')) ? normalizeSupabaseUrl(lsGet('pos_sb_url')) : '';
  const lsKey = !isPlaceholderCredential(lsGet('pos_sb_key')) ? String(lsGet('pos_sb_key')).trim() : '';

  return {
    url: extUrl || lsUrl || DEFAULT_SUPABASE_URL,
    key: extKey || lsKey || DEFAULT_SUPABASE_ANON_KEY
  };
}

function hasValidSupabaseCredentials() {
  const { url, key } = getSupabaseCredentials();
  if (isPlaceholderCredential(url) || isPlaceholderCredential(key)) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && key.length > 20;
  } catch (e) {
    return false;
  }
}

let sbClient = null;
function initSb(token) {
  if (!window.supabase || !window.supabase.createClient) {
    throw new Error('Supabase SDK failed to load. Check internet connection and reload.');
  }
  const { url, key } = getSupabaseCredentials();
  if (!hasValidSupabaseCredentials()) {
    throw new Error('Database connection is not configured on this terminal. Please contact Admin.');
  }
  sbClient = window.supabase.createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: token ? { 'x-pos-token': token } : {},
      fetch: async (input, init) => {
        try {
          return await window.fetch(input, init);
        } catch (netErr) {
          const e = new Error(
            'Cannot reach Supabase server (' + url + '). Check internet connection or verify Project URL.'
          );
          e.isNetwork = true;
          throw e;
        }
      }
    },
    realtime: { params: { eventsPerSecond: 10 } }
  });
  return sbClient;
}

function openDbConfigModal() {
  const { url, key } = getSupabaseCredentials();
  if ($('cfgSbUrlInput')) $('cfgSbUrlInput').value = !isPlaceholderCredential(url) ? url : '';
  if ($('cfgSbKeyInput')) $('cfgSbKeyInput').value = !isPlaceholderCredential(key) ? key : '';
  showModal('dbConfigModal');
}

function saveDbConfig() {
  const url = normalizeSupabaseUrl($('cfgSbUrlInput')?.value || '');
  const key = ($('cfgSbKeyInput')?.value || '').trim();
  let validUrl = false;
  try {
    const parsed = new URL(url);
    validUrl = parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch (e) {}

  if (!validUrl) {
    return toast('Enter a valid Supabase URL (https://xxxx.supabase.co).', 'warning');
  }
  if (key.length < 20) {
    return toast('Enter a valid Supabase Anon Public Key.', 'warning');
  }
  lsSet('pos_sb_url', url);
  lsSet('pos_sb_key', key);
  sbClient = null;
  hideModal('dbConfigModal');
  toast('Supabase connection saved locally on this device.', 'success');
}

function clearDbConfig() {
  if (!confirm('Clear saved Supabase credentials from this browser?')) return;
  lsDel('pos_sb_url');
  lsDel('pos_sb_key');
  sbClient = null;
  if ($('cfgSbUrlInput')) $('cfgSbUrlInput').value = '';
  if ($('cfgSbKeyInput')) $('cfgSbKeyInput').value = '';
  toast('Saved credentials cleared.', 'info');
}

/* ============================================================
   CONSTANTS & GLOBAL STATE
   ============================================================ */
const APP_VERSION = 'v4.9.7-RT';
const KDS_STATUSES = ['CONFIRMED_BY_COUNTER', 'ACCEPTED_BY_KITCHEN', 'PREPARING'];
const FOOD_PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150"><rect width="150" height="150" fill="#cccccc"/>' +
  '<text x="75" y="82" font-family="Arial,sans-serif" font-size="22" fill="#969696" text-anchor="middle">Food</text></svg>');

const state = {
  user: null, token: null, activeBranchId: null, branches: [],
  settings: {}, categories: [], menu: [], menuById: {},
  tables: [], orders: [], users: [], stats: {}, currentView: 'waiter', cart: [],
  pollTimer: null, polling: false, realtimeChannel: null, realtimeConnected: false,
  lastSync: null, version: null,
  knownKdsOrderIds: new Set(), knownReadyOrderIds: new Set(), alertsPrimed: false,
  prepInputs: {}, activeCategoryFilter: 'ALL', queue: [], flushing: false, submitting: false, localPayments: {},
  eodGenerated: null
};
state.counterView = (lsGet('pos_counter_view') === 'list') ? 'list' : 'grid';
state.dashView = (lsGet('pos_dash_view') === 'grid') ? 'grid' : 'list';
state.bootVer = null;
state.adminLoadedAt = 0;

/* ============================================================
   LOCAL STORAGE & INDEXEDDB ENGINE
   ============================================================ */
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

const Store = (function () {
  const mem = {};
  let db = null;
  const ready = new Promise(function (resolve) {
    try {
      if (!window.indexedDB) return resolve();
      const req = indexedDB.open('pos_offline_v4', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onsuccess = function () { db = req.result; resolve(); };
      req.onerror = function () { resolve(); };
      req.onblocked = function () { resolve(); };
    } catch (e) { resolve(); }
  });

  async function get(k) {
    await ready;
    if (db) {
      try {
        const v = await new Promise(function (res) {
          const r = db.transaction('kv', 'readonly').objectStore('kv').get(k);
          r.onsuccess = function () { res(r.result); };
          r.onerror = function () { res(undefined); };
        });
        if (v !== undefined) return v;
      } catch (e) {}
    }
    const raw = lsGet('kv_' + k);
    if (raw) { try { return JSON.parse(raw); } catch (e) {} }
    return mem[k];
  }

  async function set(k, v) {
    await ready;
    mem[k] = v;
    if (db) {
      try {
        await new Promise(function (res) {
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(v, k);
          tx.oncomplete = function () { res(); };
          tx.onerror = function () { res(); };
          tx.onabort = function () { res(); };
        });
        return;
      } catch (e) {}
    }
    try { localStorage.setItem('kv_' + k, JSON.stringify(v)); } catch (e) {}
  }

  return { get, set };
})();

function persistQueue() { return Store.set('queue', JSON.parse(JSON.stringify(state.queue))); }

/* ============================================================
   AUDIO ALERTS & UTILITIES
   ============================================================ */
let audioCtx = null;
function initAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
document.addEventListener('click', initAudioContext, { passive: true });
document.addEventListener('touchend', initAudioContext, { passive: true });

function playKdsChime() {
  try {
    initAudioContext();
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const osc1 = audioCtx.createOscillator(), gain1 = audioCtx.createGain();
    osc1.type = 'sine'; osc1.frequency.setValueAtTime(587.33, now);
    gain1.gain.setValueAtTime(0.3, now); gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc1.connect(gain1); gain1.connect(audioCtx.destination); osc1.start(now); osc1.stop(now + 0.3);

    const osc2 = audioCtx.createOscillator(), gain2 = audioCtx.createGain();
    osc2.type = 'sine'; osc2.frequency.setValueAtTime(880.00, now + 0.15);
    gain2.gain.setValueAtTime(0.4, now + 0.15); gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc2.connect(gain2); gain2.connect(audioCtx.destination); osc2.start(now + 0.15); osc2.stop(now + 0.6);
  } catch (e) {}
}

const $ = (id) => document.getElementById(id);
const curr = () => state.settings.CURRENCY_SYMBOL || '₱';

function toast(msg, type = 'info') {
  const colors = { success: 'bg-success', danger: 'bg-danger', info: 'bg-primary', warning: 'bg-warning text-dark' };
  const el = document.createElement('div');
  el.className = `toast align-items-center text-white ${colors[type] || 'bg-dark'} border-0 mb-2`;
  el.innerHTML = `<div class="d-flex"><div class="toast-body">${escapeHtml(msg)}</div>
    <button class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
  $('toastContainer').appendChild(el);
  new bootstrap.Toast(el, { delay: 3500 }).show();
  el.addEventListener('hidden.bs.toast', () => el.remove());
}

function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function setHtml(el, html) { if (!el) return; if (el._h !== html) { el.innerHTML = html; el._h = html; } }

function debounce(fn, ms) {
  let t = null; return function () { clearTimeout(t); t = setTimeout(fn, ms); };
}

function uuid() {
  try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (e) {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  });
}

function todayStr() {
  try {
    const tz = state.settings.TIMEZONE || 'Asia/Manila';
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch (e) {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
}

function getSeniorPct() {
  const raw = state.settings.SENIOR_PWD_DISCOUNT_PERCENT;
  if (raw === undefined || raw === null || raw === '') return 20;
  const p = parseFloat(raw);
  return isNaN(p) ? 20 : Math.min(100, Math.max(0, p));
}

function resolveMenuPrice(m) {
  if (!m) return 0;
  const raw = m.EffectivePrice ?? m.PriceOverride ?? m.Price ?? 0;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

function isManagerOrAdmin() {
  return state.user && ['Manager', 'Admin'].includes(state.user.role);
}

function isGlobalAdmin() {
  return state.user && state.user.role === 'Admin';
}

function getServedItemQty(it) {
  const totalQty = Number(it.Quantity || it.Qty || 1);
  if (it.ServedQty !== undefined && it.ServedQty !== null && !isNaN(Number(it.ServedQty))) {
    return Math.min(totalQty, Math.max(0, Number(it.ServedQty)));
  }
  const m = String(it.KitchenStatus || '').match(/^Partial\s+(\d+)\/(\d+)$/i);
  if (m) return Math.min(totalQty, Math.max(0, parseInt(m[1], 10)));
  return it.Status === 'SERVED' ? totalQty : 0;
}

function showLoading(msg) {
  $('loadingOverlay').style.display = 'flex';
  $('loadingSpinner').style.display = 'inline-block';
  $('doneIcon').style.display = 'none';
  $('overlayText').textContent = msg || 'Processing…';
}
function hideLoading() { $('loadingOverlay').style.display = 'none'; }
function showDone(msg, cb) {
  $('loadingSpinner').style.display = 'none';
  $('doneIcon').style.display = 'block';
  $('overlayText').textContent = msg || 'Done!';
  setTimeout(() => { $('loadingOverlay').style.display = 'none'; cb && cb(); }, 400);
}
function showModal(id) { bootstrap.Modal.getOrCreateInstance($(id)).show(); }
function hideModal(id) { const m = bootstrap.Modal.getInstance($(id)); if (m) m.hide(); }

/* ============================================================
   OPENING CASH FLOAT & ACTUAL CASH COUNTED HELPERS (EOD Z-READING)
   ============================================================ */
function getEodFloatKey(dateVal) {
  const bId = state.activeBranchId || (state.user && state.user.branchId) || 'branch-main';
  return `pos_eod_float_${bId}_${dateVal || todayStr()}`;
}

function getEodActualKey(dateVal) {
  const bId = state.activeBranchId || (state.user && state.user.branchId) || 'branch-main';
  return `pos_eod_actual_${bId}_${dateVal || todayStr()}`;
}

function syncEodDrawerInputs() {
  const dateVal = $('eodDate')?.value || todayStr();
  const c = curr();
  if ($('eodFloatCurrencyPrefix')) $('eodFloatCurrencyPrefix').textContent = c;
  if ($('eodActualCurrencyPrefix')) $('eodActualCurrencyPrefix').textContent = c;

  const floatInput = $('eodOpeningFloat');
  if (floatInput) {
    const savedFloat = lsGet(getEodFloatKey(dateVal));
    floatInput.value = savedFloat !== null ? savedFloat : '';
  }

  const actualInput = $('eodActualCash');
  if (actualInput) {
    const savedActual = lsGet(getEodActualKey(dateVal));
    actualInput.value = savedActual !== null ? savedActual : '';
  }
}

function saveEodDrawerValues() {
  const dateVal = $('eodDate')?.value || todayStr();
  const rawFloat = $('eodOpeningFloat')?.value ?? '';
  if (rawFloat === '') {
    lsDel(getEodFloatKey(dateVal));
  } else {
    lsSet(getEodFloatKey(dateVal), Math.max(0, parseFloat(rawFloat) || 0).toFixed(2));
  }

  const rawActual = $('eodActualCash')?.value ?? '';
  if (rawActual === '') {
    lsDel(getEodActualKey(dateVal));
  } else {
    lsSet(getEodActualKey(dateVal), Math.max(0, parseFloat(rawActual) || 0).toFixed(2));
  }
}

function getEodOpeningFloat() {
  const raw = $('eodOpeningFloat')?.value;
  if (raw !== undefined && raw !== '') return Math.max(0, parseFloat(raw) || 0);
  const dateVal = $('eodDate')?.value || todayStr();
  const saved = lsGet(getEodFloatKey(dateVal));
  return saved ? Math.max(0, parseFloat(saved) || 0) : 0;
}

function getEodActualCash() {
  const raw = $('eodActualCash')?.value;
  if (raw !== undefined && raw !== '') return Math.max(0, parseFloat(raw) || 0);
  const dateVal = $('eodDate')?.value || todayStr();
  const saved = lsGet(getEodActualKey(dateVal));
  return saved !== null && saved !== '' ? Math.max(0, parseFloat(saved) || 0) : null;
}

function onEodCashInputChange() {
  saveEodDrawerValues();
  const dateVal = $('eodDate')?.value || todayStr();
  if (window._lastEOD && window._lastEOD.date === dateVal) {
    const openingFloat = getEodOpeningFloat();
    const actualCash = getEodActualCash();
    const cashSales = Number(window._lastEOD.cashDrawer?.cashSales || 0);
    const expectedCash = openingFloat + cashSales;
    const variance = actualCash !== null ? (actualCash - expectedCash) : null;
    window._lastEOD.cashDrawer = {
      ...window._lastEOD.cashDrawer,
      openingFloat,
      expectedCash,
      actualCash,
      variance
    };
    renderEODReportHtml(window._lastEOD);
  }
}

/* ============================================================
   SUPABASE BACKEND ADAPTER
   ============================================================ */
async function callServer(fnName, ...args) {
  if (!sbClient) initSb(state.token);
  const bId = state.activeBranchId || (state.user && state.user.branchId) || 'branch-main';

  switch (fnName) {
    case 'loginUser': {
      const [u, p] = args;
      const { data, error } = await sbClient.rpc('pos_login', { p_username: u, p_password: p });
      if (error) throw new Error(error.message);
      return data;
    }
    case 'logoutUser': {
      const [tok] = args;
      if (tok) await sbClient.from('sessions').delete().eq('Token', tok);
      return { success: true };
    }
    case 'heartbeat': {
      const [tok] = args;
      const { data } = await sbClient.from('sessions').select('UserID, ExpiresAt').eq('Token', tok).maybeSingle();
      if (!data || new Date(data.ExpiresAt) <= new Date()) return { valid: false };
      return { valid: true };
    }
    case 'getBootstrapData': {
      const [setRes, mainSetRes, catRes, menuRes, tblRes, usrRes, brRes] = await Promise.all([
        sbClient.from('system_settings').select('*').eq('BranchID', bId),
        sbClient.from('system_settings').select('*').eq('BranchID', 'branch-main'),
        sbClient.from('categories').select('*').order('SortOrder', { ascending: true }),
        sbClient.from('v_branch_menu').select('*').eq('BranchID', bId).order('Name', { ascending: true }),
        sbClient.from('restaurant_tables').select('*').eq('BranchID', bId).order('TableNumber', { ascending: true }),
        sbClient.from('users').select('*').order('FullName', { ascending: true }),
        sbClient.from('branches').select('*').eq('Active', true).order('BranchName', { ascending: true })
      ]);
      const settings = {};
      (mainSetRes.data || []).forEach(r => { settings[r.Key] = r.Value; });
      (setRes.data || []).forEach(r => { settings[r.Key] = r.Value; });
      return {
        settings,
        categories: catRes.data || [],
        menuItems: menuRes.data || [],
        tables: tblRes.data || [],
        users: usrRes.data || [],
        branches: brRes.data || [],
        version: Date.now()
      };
    }
    case 'getPolledUpdates': {
      const [tblRes, ordRes, itmRes] = await Promise.all([
        sbClient.from('restaurant_tables').select('*').eq('BranchID', bId).order('TableNumber', { ascending: true }),
        sbClient.from('orders').select('*').eq('BranchID', bId).not('OrderStatus', 'in', '("COMPLETED","CANCELLED","VOIDED")').order('CreatedAt', { ascending: true }),
        sbClient.from('order_items').select('*').eq('BranchID', bId)
      ]);
      const itemsByOrder = {};
      (itmRes.data || []).forEach(it => {
        (itemsByOrder[it.OrderID] = itemsByOrder[it.OrderID] || []).push(it);
      });
      const orders = (ordRes.data || []).map(o => ({ ...o, items: itemsByOrder[o.OrderID] || [] }));
      const servedCount = (ordRes.data || []).filter(o => o.OrderStatus === 'SERVED').length;
      return {
        tables: tblRes.data || [],
        orders,
        stats: { served: servedCount },
        version: Date.now()
      };
    }
    case 'createOrder': {
      const [, p] = args;
      const orderId = p.clientId || uuid();
      const orderNum = 'ORD-' + Date.now().toString().slice(-6);
      const { error: oErr } = await sbClient.from('orders').insert({
        OrderID: orderId,
        OrderNumber: orderNum,
        BranchID: bId,
        TableID: p.tableId || null,
        TableNumber: p.tableNumber || 'Takeout',
        OrderType: p.tableId ? 'Dine-In' : 'Takeout',
        CustomerName: 'Walk-In Customer',
        WaiterID: state.user?.userId || null,
        WaiterName: state.user?.fullName || 'Staff',
        Subtotal: p.subtotal,
        GrandTotal: p.subtotal,
        Status: 'Open',
        OrderStatus: 'PENDING_COUNTER',
        PaymentStatus: 'UNPAID',
        CreatedBy: state.user?.userId || null
      });
      if (oErr) throw new Error(oErr.message);

      if (p.items && p.items.length) {
        const rows = p.items.map(i => ({
          OrderItemID: uuid(),
          OrderID: orderId,
          BranchID: bId,
          ItemID: i.menuItemId,
          ItemName: i.itemName,
          ItemNameSnapshot: i.itemName,
          Station: i.station || 'Kitchen',
          Qty: i.quantity,
          Quantity: i.quantity,
          UnitPrice: i.price,
          UnitPriceSnapshot: i.price,
          LineTotal: i.price * i.quantity,
          KitchenStatus: 'Pending',
          Status: 'PENDING'
        }));
        const { error: iErr } = await sbClient.from('order_items').insert(rows);
        if (iErr) throw new Error(iErr.message);
      }

      if (p.tableId) {
        await sbClient.from('restaurant_tables').update({ Status: 'Waiting for Counter Confirmation', CurrentOrderID: orderId }).eq('TableID', p.tableId);
      }
      await logActivity('CREATE_ORDER', 'Order', orderId, `${orderNum} (${p.tableNumber || 'Takeout'})`);
      return { success: true, orderId, orderNumber: orderNum };
    }
    case 'transitionOrder': {
      const [, orderId, action, params = {}] = args;
      const { data: o } = await sbClient.from('orders').select('*').eq('OrderID', orderId).single();
      if (!o) throw new Error('Order not found');

      if (action === 'REJECT_COUNTER') {
        await sbClient.from('orders').update({ OrderStatus: 'CANCELLED', Status: 'Cancelled', DiscountReason: params.reason || 'Rejected' }).eq('OrderID', orderId);
        if (o.TableID) await sbClient.from('restaurant_tables').update({ Status: 'Available', CurrentOrderID: null }).eq('TableID', o.TableID);
      } else if (action === 'ACCEPT_KITCHEN') {
        await sbClient.from('orders').update({ OrderStatus: 'ACCEPTED_BY_KITCHEN' }).eq('OrderID', orderId);
      } else if (action === 'START_PREP') {
        const mins = parseInt(params.prepMinutes, 10) || 15;
        const eta = new Date(Date.now() + mins * 60000).toISOString();
        await sbClient.from('orders').update({ OrderStatus: 'PREPARING', EstimatedPreparationMinutes: mins, EstimatedCompletionTime: eta }).eq('OrderID', orderId);
        if (o.TableID) await sbClient.from('restaurant_tables').update({ Status: 'Preparing' }).eq('TableID', o.TableID);
      } else if (action === 'MARK_READY') {
        await sbClient.from('orders').update({ OrderStatus: 'READY' }).eq('OrderID', orderId);
        if (o.TableID) await sbClient.from('restaurant_tables').update({ Status: 'Ready to Serve' }).eq('TableID', o.TableID);
      } else if (action === 'SERVE') {
        const itemUpdates = Array.isArray(params.itemUpdates) ? params.itemUpdates : null;
        if (itemUpdates !== null) {
          const { data: orderItems } = await sbClient.from('order_items').select('*').eq('OrderID', orderId);
          const updMap = {};
          itemUpdates.forEach(u => { updMap[u.orderItemId] = Math.max(0, parseInt(u.servedQty, 10) || 0); });

          let allFullyServed = (orderItems || []).length > 0;
          for (const it of (orderItems || [])) {
            const totalQty = Number(it.Quantity || it.Qty || 1);
            const servedQty = Math.min(totalQty, updMap[it.OrderItemID] ?? 0);
            const isFull = servedQty >= totalQty;
            if (!isFull) allFullyServed = false;
            const statusStr = isFull ? 'SERVED' : 'PREPARING';
            const kStatusStr = isFull ? 'Served' : (servedQty > 0 ? `Partial ${servedQty}/${totalQty}` : 'Preparing');
            await sbClient.from('order_items').update({
              Status: statusStr,
              KitchenStatus: kStatusStr
            }).eq('OrderItemID', it.OrderItemID);
          }

          const nextStatus = allFullyServed ? 'SERVED' : 'PREPARING';
          await sbClient.from('orders').update({
            OrderStatus: nextStatus,
            Status: o.PaymentStatus === 'PAID' ? 'Paid' : 'Open'
          }).eq('OrderID', orderId);

          if (o.TableID) {
            await sbClient.from('restaurant_tables').update({
              Status: allFullyServed ? 'Served' : 'Preparing',
              CurrentOrderID: orderId
            }).eq('TableID', o.TableID);
          }
        } else {
          await sbClient.from('orders').update({
            OrderStatus: 'SERVED',
            Status: o.PaymentStatus === 'PAID' ? 'Paid' : 'Open'
          }).eq('OrderID', orderId);
          if (o.TableID) {
            await sbClient.from('restaurant_tables').update({ Status: 'Served', CurrentOrderID: orderId }).eq('TableID', o.TableID);
          }
        }
      }
      await logActivity(action, 'Order', orderId, `${o.OrderNumber} | ${JSON.stringify(params)}`);
      return { success: true };
    }
    case 'refundOrderItems': {
      const [, p] = args;
      if (!isManagerOrAdmin()) {
        throw new Error('Only a Manager or Admin can edit or refund counter orders.');
      }
      const { orderId, refunds, reason, fullVoid } = p;
      const { data: o } = await sbClient.from('orders').select('*').eq('OrderID', orderId).single();
      if (!o) throw new Error('Order not found.');
      const { data: items } = await sbClient.from('order_items').select('*').eq('OrderID', orderId);

      if (fullVoid) {
        const voidAmt = Number(o.GrandTotal || o.Subtotal || 0);
        await sbClient.from('orders').update({
          OrderStatus: 'VOIDED',
          Status: 'Voided',
          PaymentStatus: o.PaymentStatus === 'PAID' ? 'REFUNDED' : 'UNPAID',
          DiscountReason: `FULL REFUND/VOID (${state.user.fullName}): ${reason}`
        }).eq('OrderID', orderId);
        if (o.TableID) {
          await sbClient.from('restaurant_tables').update({ Status: 'Available', CurrentOrderID: null }).eq('TableID', o.TableID);
        }
        await logActivity('FULL_ORDER_REFUND', 'Order', orderId, `${o.OrderNumber} | Refunded ${curr()}${voidAmt.toFixed(2)} | Reason: ${reason} | By: ${state.user.fullName}`);
        return { success: true, message: `Order ${o.OrderNumber} refunded & voided.` };
      }

      let refundedSubtotal = 0;
      const refundedItemLabels = [];
      const refundMap = {};
      (refunds || []).forEach(r => { refundMap[r.orderItemId] = parseInt(r.refundQty, 10) || 0; });

      for (const it of (items || [])) {
        const curQty = Number(it.Quantity || it.Qty || 0);
        const unitPrice = Number(it.UnitPriceSnapshot || it.UnitPrice || 0);
        const itemName = it.ItemNameSnapshot || it.ItemName || 'Item';
        const rQty = Math.min(curQty, Math.max(0, refundMap[it.OrderItemID] || 0));
        if (rQty > 0) {
          refundedSubtotal += rQty * unitPrice;
          refundedItemLabels.push(`${rQty}x ${itemName}`);
          const remQty = curQty - rQty;
          if (remQty <= 0) {
            await sbClient.from('order_items').delete().eq('OrderItemID', it.OrderItemID);
          } else {
            await sbClient.from('order_items').update({
              Qty: remQty,
              Quantity: remQty,
              LineTotal: remQty * unitPrice
            }).eq('OrderItemID', it.OrderItemID);
          }
        }
      }

      const itemsSummaryTxt = refundedItemLabels.join(', ');
      const { data: remainingItems } = await sbClient.from('order_items').select('*').eq('OrderID', orderId);
      if (!remainingItems || remainingItems.length === 0) {
        await sbClient.from('orders').update({
          Subtotal: 0,
          GrandTotal: 0,
          OrderStatus: 'VOIDED',
          Status: 'Voided',
          PaymentStatus: o.PaymentStatus === 'PAID' ? 'REFUNDED' : 'UNPAID',
          DiscountReason: `ALL ITEMS REFUNDED (${state.user.fullName}): ${reason}`
        }).eq('OrderID', orderId);
        if (o.TableID) {
          await sbClient.from('restaurant_tables').update({ Status: 'Available', CurrentOrderID: null }).eq('TableID', o.TableID);
        }
        await logActivity('ITEM_REFUND_VOID', 'Order', orderId, `${o.OrderNumber} | Items: ${itemsSummaryTxt} | Refunded ${curr()}${refundedSubtotal.toFixed(2)} | Reason: ${reason} | By: ${state.user.fullName}`);
        return { success: true, message: `All items refunded. Order ${o.OrderNumber} closed.` };
      }

      const newSub = remainingItems.reduce((s, it) => s + (Number(it.Quantity || it.Qty || 0) * Number(it.UnitPriceSnapshot || it.UnitPrice || 0)), 0);
      const isSeniorPwd = o.DiscountType === 'Senior/PWD';
      const oldSub = Number(o.Subtotal || 0);
      const manualPct = (!isSeniorPwd && oldSub > 0 && Number(o.Discount || 0) > 0)
        ? Math.min(50, (Number(o.Discount || 0) / oldSub) * 100)
        : 0;
      const t = computeTotals(newSub, isSeniorPwd, manualPct);

      const newPaid = o.PaymentStatus === 'PAID' ? Math.min(Number(o.AmountPaid || t.total), t.total) : Number(o.AmountPaid || 0);
      const notePrefix = o.DiscountReason ? `${o.DiscountReason} | ` : '';
      await sbClient.from('orders').update({
        Subtotal: t.subtotal,
        Discount: t.discount,
        DiscountAmount: t.discount,
        DiscountReason: `${notePrefix}Item Refund (${curr()}${refundedSubtotal.toFixed(2)} - ${itemsSummaryTxt}): ${reason}`,
        LessVat: t.lessVat,
        VatableSales: t.vatableSales,
        VatExemptSales: t.vatExemptSales,
        Tax: t.tax,
        VatAmount: t.tax,
        ServiceCharge: t.srv,
        GrandTotal: t.total,
        AmountPaid: newPaid
      }).eq('OrderID', orderId);

      await logActivity('ITEM_REFUND', 'Order', orderId, `${o.OrderNumber} | Items: ${itemsSummaryTxt} | Refunded ${curr()}${refundedSubtotal.toFixed(2)} | Reason: ${reason} | By: ${state.user.fullName}`);
      return { success: true, message: `Refunded ${curr()}${refundedSubtotal.toFixed(2)} on ${o.OrderNumber}.` };
    }
    case 'processPayment': {
      const [, p] = args;
      const { data: o } = await sbClient.from('orders').select('*').eq('OrderID', p.orderId).single();
      if (!o) throw new Error('Order not found');
      const t = p.computedTotals || {};
      const totalDue = Number(t.total ?? o.GrandTotal ?? 0);
      const changeAmount = p.changeAmount !== undefined
        ? Number(p.changeAmount)
        : Math.max(0, Number(p.amountReceived || 0) - totalDue);
      const nextOrderStatus = o.OrderStatus === 'PENDING_COUNTER'
        ? (isKdsDisabled() ? 'READY' : 'CONFIRMED_BY_COUNTER')
        : (o.OrderStatus === 'SERVED' ? 'SERVED' : o.OrderStatus);

      const { error } = await sbClient.from('orders').update({
        CustomerName: p.customerName || 'Walk-In Customer',
        CounterID: state.user?.userId || null,
        CounterName: state.user?.fullName || 'Counter',
        Subtotal: t.subtotal ?? o.Subtotal,
        DiscountType: p.isSeniorPwd ? 'Senior/PWD' : (p.discount > 0 ? 'Manual' : 'None'),
        SeniorPwdId: p.seniorPwdId || null,
        Discount: t.discount ?? 0,
        DiscountAmount: t.discount ?? 0,
        DiscountReason: p.isSeniorPwd ? `SC/PWD (${p.seniorPwdId})` : (p.discountReason || ''),
        LessVat: t.lessVat ?? 0,
        VatableSales: t.vatableSales ?? 0,
        VatExemptSales: t.vatExemptSales ?? 0,
        Tax: t.tax ?? 0,
        VatAmount: t.tax ?? 0,
        ServiceCharge: t.srv ?? 0,
        GrandTotal: totalDue,
        PaymentMethod: p.paymentMethod,
        DeliveryPlatform: p.deliveryPlatform || null,
        ReferenceNumber: p.referenceNumber || null,
        AmountTendered: p.amountReceived,
        AmountPaid: totalDue,
        ChangeAmount: changeAmount,
        PaymentStatus: 'PAID',
        Status: 'Paid',
        OrderStatus: nextOrderStatus,
        PaidAt: new Date().toISOString()
      }).eq('OrderID', p.orderId);
      if (error) throw new Error(error.message);

      if (o.TableID && o.OrderStatus === 'PENDING_COUNTER') {
        await sbClient.from('restaurant_tables').update({ Status: isKdsDisabled() ? 'Ready to Serve' : 'Occupied' }).eq('TableID', o.TableID);
      }
      await logActivity('PAYMENT', 'Order', p.orderId, `${o.OrderNumber} | ${p.paymentMethod} ${curr()}${totalDue.toFixed(2)}`);
      return { success: true, changeAmount };
    }
    case 'getReceiptData': {
      const [, orderId] = args;
      const [{ data: o }, { data: items }] = await Promise.all([
        sbClient.from('orders').select('*').eq('OrderID', orderId).single(),
        sbClient.from('order_items').select('*').eq('OrderID', orderId)
      ]);
      return {
        order: o,
        items: items || [],
        payments: [{
          PaymentMethod: o.PaymentMethod || 'Cash',
          DeliveryPlatform: o.DeliveryPlatform || '',
          AmountPaid: o.AmountTendered || o.AmountPaid || o.GrandTotal,
          ChangeAmount: o.ChangeAmount || 0,
          ReferenceNumber: o.ReferenceNumber || ''
        }],
        settings: state.settings
      };
    }
    case 'cleanTable': {
      const [, tableId] = args;
      await sbClient.from('restaurant_tables').update({ Status: 'Available', CurrentOrderID: null, ReservedFor: null }).eq('TableID', tableId);
      await logActivity('CLEAN_TABLE', 'Table', tableId, 'Marked table Available');
      return { success: true, message: 'Table is now Available' };
    }
    case 'toggleTableReservation': {
      const [, tableId, isReserved, note] = args;
      await sbClient.from('restaurant_tables').update({
        Status: isReserved ? 'Reserved' : 'Available',
        ReservedFor: isReserved ? (note || 'Reserved') : null
      }).eq('TableID', tableId);
      await logActivity('RESERVE_TABLE', 'Table', tableId, isReserved ? `Reserved (${note || 'Reserved'})` : 'Cleared reservation');
      return { success: true, message: isReserved ? 'Table marked Reserved' : 'Reservation cleared' };
    }
    case 'transferReservation': {
      const [, fromId, toId] = args;
      const { data: src } = await sbClient.from('restaurant_tables').select('ReservedFor').eq('TableID', fromId).single();
      await sbClient.from('restaurant_tables').update({ Status: 'Reserved', ReservedFor: src?.ReservedFor || 'Reserved' }).eq('TableID', toId);
      await sbClient.from('restaurant_tables').update({ Status: 'Available', ReservedFor: null }).eq('TableID', fromId);
      await logActivity('TRANSFER_RESERVATION', 'Table', toId, `From ${fromId} to ${toId}`);
      return { success: true, message: 'Reservation transferred!' };
    }
    case 'transferTableOrder': {
      const [, orderId, newTableId, newTableNumber] = args;
      const { data: o } = await sbClient.from('orders').select('TableID, OrderNumber').eq('OrderID', orderId).single();
      const { data: oldTbl } = o?.TableID ? await sbClient.from('restaurant_tables').select('Status').eq('TableID', o.TableID).single() : { data: { Status: 'Occupied' } };
      await sbClient.from('orders').update({ TableID: newTableId, TableNumber: newTableNumber }).eq('OrderID', orderId);
      await sbClient.from('restaurant_tables').update({ Status: oldTbl?.Status || 'Occupied', CurrentOrderID: orderId }).eq('TableID', newTableId);
      if (o?.TableID) await sbClient.from('restaurant_tables').update({ Status: 'Available', CurrentOrderID: null }).eq('TableID', o.TableID);
      await logActivity('TRANSFER_TABLE', 'Order', orderId, `${o?.OrderNumber || orderId} moved to ${newTableNumber}`);
      return { success: true, message: `Transferred to ${newTableNumber}` };
    }
    case 'mergeTableOrders': {
      const [, srcTableId, tgtTableId] = args;
      const srcOrder = state.orders.find(o => o.TableID === srcTableId);
      const tgtOrder = state.orders.find(o => o.TableID === tgtTableId);
      if (!srcOrder || !tgtOrder) throw new Error('Active orders not found for selected tables.');
      await sbClient.from('order_items').update({ OrderID: tgtOrder.OrderID }).eq('OrderID', srcOrder.OrderID);
      const newSub = Number(tgtOrder.Subtotal || 0) + Number(srcOrder.Subtotal || 0);
      await sbClient.from('orders').update({ Subtotal: newSub, GrandTotal: newSub }).eq('OrderID', tgtOrder.OrderID);
      await sbClient.from('orders').update({ OrderStatus: 'CANCELLED', Status: 'Cancelled', DiscountReason: `Merged into ${tgtOrder.OrderNumber}` }).eq('OrderID', srcOrder.OrderID);
      await sbClient.from('restaurant_tables').update({ Status: 'Available', CurrentOrderID: null }).eq('TableID', srcTableId);
      await logActivity('MERGE_TABLES', 'Order', tgtOrder.OrderID, `Merged ${srcOrder.TableNumber} (${srcOrder.OrderNumber}) into ${tgtOrder.TableNumber} (${tgtOrder.OrderNumber})`);
      return { success: true, message: `Merged ${srcOrder.TableNumber} into ${tgtOrder.TableNumber}` };
    }
    case 'saveSystemSettings': {
      const [, cfg] = args;
      const rows = Object.keys(cfg).map(k => ({ BranchID: bId, Key: k, Value: String(cfg[k]) }));
      const { error } = await sbClient.from('system_settings').upsert(rows, { onConflict: 'BranchID,Key' });
      if (error) throw new Error(error.message);
      await logActivity('UPDATE_SETTINGS', 'Settings', bId, 'Updated branch POS settings');
      return { success: true };
    }
    case 'deleteBranch': {
      const [, branchId] = args;
      if (!branchId || branchId === 'branch-main') {
        throw new Error('The Main Branch cannot be deleted.');
      }
      const { count: orderCount } = await sbClient
        .from('orders')
        .select('OrderID', { count: 'exact', head: true })
        .eq('BranchID', branchId);
      if ((orderCount || 0) > 0) {
        throw new Error(`Cannot delete this branch because it has ${orderCount} recorded order(s).`);
      }
      const { count: userCount } = await sbClient
        .from('users')
        .select('UserID', { count: 'exact', head: true })
        .eq('BranchID', branchId);
      if ((userCount || 0) > 0) {
        throw new Error(`Cannot delete this branch while ${userCount} user(s) are still assigned to it.`);
      }

      await sbClient.from('system_settings').delete().eq('BranchID', branchId);
      await sbClient.from('branch_menu_items').delete().eq('BranchID', branchId);
      await sbClient.from('restaurant_tables').delete().eq('BranchID', branchId);
      await sbClient.from('eod_reports').delete().eq('BranchID', branchId);

      const { error } = await sbClient.from('branches').delete().eq('BranchID', branchId);
      if (error) throw new Error(error.message);

      await logActivity('DELETE_BRANCH', 'Branch', branchId, 'Deleted branch');
      return { success: true, message: 'Branch deleted!' };
    }
    case 'saveMenuItem': {
      const [, m] = args;
      const cat = state.categories.find(c => c.CategoryID === m.CategoryID);
      const isNew = !m.MenuItemID;
      const itemId = m.MenuItemID || uuid();
      const parsedPrice = parseFloat(m.Price) || 0;

      const { error } = await sbClient.from('menu_items').upsert({
        ItemID: itemId,
        Name: m.ItemName.trim(),
        CategoryID: m.CategoryID,
        Category: cat ? cat.CategoryName : 'General',
        Price: parsedPrice,
        Station: m.Station,
        ImageURL: m.ImageURL || null,
        Available: m.Available
      }, { onConflict: 'ItemID' });
      if (error) throw new Error(error.message);

      if (isNew && (state.branches || []).length > 0) {
        const branchRows = state.branches.map(br => ({
          BranchMenuID: uuid(),
          BranchID: br.BranchID,
          ItemID: itemId,
          PriceOverride: parsedPrice,
          Available: m.Available
        }));
        const { error: bmErr } = await sbClient.from('branch_menu_items').upsert(branchRows, { onConflict: 'BranchID,ItemID' });
        if (bmErr) throw new Error(bmErr.message);
      } else {
        const { error: bmErr } = await sbClient.from('branch_menu_items').upsert({
          BranchMenuID: uuid(),
          BranchID: bId,
          ItemID: itemId,
          PriceOverride: parsedPrice,
          Available: m.Available
        }, { onConflict: 'BranchID,ItemID' });
        if (bmErr) throw new Error(bmErr.message);
      }

      await logActivity(isNew ? 'CREATE_MENU_ITEM' : 'UPDATE_MENU_ITEM', 'MenuItem', itemId, `${m.ItemName} (${parsedPrice.toFixed(2)})`);
      return { success: true };
    }
    case 'deleteMenuItem': {
      const [, itemId] = args;
      await sbClient.from('branch_menu_items').delete().eq('ItemID', itemId);
      const { error } = await sbClient.from('menu_items').delete().eq('ItemID', itemId);
      if (error) throw new Error(error.message);
      await logActivity('DELETE_MENU_ITEM', 'MenuItem', itemId, 'Deleted menu item');
      return { success: true, message: 'Menu item deleted!' };
    }
    case 'saveTable': {
      const [, t] = args;
      const payload = {
        TableID: t.TableID || uuid(),
        BranchID: bId,
        TableNumber: t.TableNumber,
        Capacity: parseInt(t.Capacity, 10) || 4
      };
      if (!t.TableID) payload.Status = 'Available';
      const { error } = await sbClient.from('restaurant_tables').upsert(payload);
      if (error) throw new Error(error.message);
      await logActivity('SAVE_TABLE', 'Table', payload.TableID, `${t.TableNumber} (${payload.Capacity} seats)`);
      return { success: true };
    }
    case 'deleteTable': {
      const [, tableId] = args;
      const { error } = await sbClient.from('restaurant_tables').delete().eq('TableID', tableId);
      if (error) throw new Error(error.message);
      await logActivity('DELETE_TABLE', 'Table', tableId, 'Deleted table');
      return { success: true, message: 'Table deleted' };
    }
    case 'saveCategory': {
      const [, c] = args;
      const isUpdate = Boolean(c.CategoryID);
      const catId = c.CategoryID || uuid();
      const sortOrder = c.SortOrder !== undefined && c.SortOrder !== null
        ? parseInt(c.SortOrder, 10)
        : ((state.categories.length || 0) + 1);
      const { error } = await sbClient.from('categories').upsert({
        CategoryID: catId,
        CategoryName: c.CategoryName,
        Description: c.Description || '',
        SortOrder: isNaN(sortOrder) ? 1 : sortOrder
      }, { onConflict: 'CategoryID' });
      if (error) throw new Error(error.message);
      await logActivity(isUpdate ? 'UPDATE_CATEGORY' : 'CREATE_CATEGORY', 'Category', catId, c.CategoryName);
      return { success: true, CategoryID: catId };
    }
    case 'deleteCategory': {
      const [, catId] = args;
      const inUse = (state.menu || []).some(m => String(m.CategoryID) === String(catId));
      if (inUse) throw new Error('Cannot delete category while menu items are still assigned to it.');
      const { error } = await sbClient.from('categories').delete().eq('CategoryID', catId);
      if (error) throw new Error(error.message);
      await logActivity('DELETE_CATEGORY', 'Category', catId, 'Deleted category');
      return { success: true, message: 'Category deleted!' };
    }
    case 'saveUser': {
      const [, u] = args;
      if (!isGlobalAdmin()) {
        if (u.Role === 'Admin') {
          throw new Error('Only Admin users can assign or create the Admin role.');
        }
        if (u.UserID) {
          const existing = (state.users || []).find(x => String(x.UserID) === String(u.UserID));
          if (existing && existing.Role === 'Admin') {
            throw new Error('Non-Admin users cannot edit Admin accounts.');
          }
        }
      }
      const rpcParams = {
        p_user_id: u.UserID || null,
        p_full_name: u.FullName,
        p_username: u.Username,
        p_role: u.Role,
        p_password: u.Password || null,
        p_branch_id: u.BranchID || null,
        p_active: true,
        p_email: u.Email || null
      };
      let { data, error } = await sbClient.rpc('pos_admin_save_user', rpcParams);
      if (error && /p_email/i.test(error.message)) {
        const legacyParams = { ...rpcParams };
        delete legacyParams.p_email;
        const retry = await sbClient.rpc('pos_admin_save_user', legacyParams);
        data = retry.data;
        error = retry.error;
        if (!error && u.Username) {
          await sbClient.from('users').update({ Email: u.Email || null }).eq('Username', u.Username.trim());
        }
      }
      if (error) throw new Error(error.message);
      if (data && data.success === false) throw new Error(data.message || 'Unable to save user.');
      await logActivity('SAVE_USER', 'User', u.Username, `${u.FullName} (${u.Role})`);
      return data;
    }
    case 'deleteUser': {
      const [, userId] = args;
      if (!userId) throw new Error('Invalid user ID.');
      if (state.user && String(state.user.userId) === String(userId)) {
        throw new Error('You cannot delete your currently logged-in account.');
      }
      const targetUser = (state.users || []).find(u => String(u.UserID) === String(userId));
      if (!isGlobalAdmin() && targetUser && targetUser.Role === 'Admin') {
        throw new Error('Non-Admin users cannot delete Admin accounts.');
      }
      if (targetUser && String(targetUser.Username).toLowerCase() === 'admin') {
        throw new Error('The primary admin account cannot be deleted.');
      }
      await sbClient.from('sessions').delete().eq('UserID', userId);
      await sbClient.from('activity_logs').update({ UserID: null }).eq('UserID', userId);
      const { error } = await sbClient.from('users').delete().eq('UserID', userId);
      if (error) throw new Error(error.message);
      await logActivity('DELETE_USER', 'User', userId, `Deleted user ${targetUser ? targetUser.Username : userId}`);
      return { success: true, message: 'User deleted!' };
    }
    case 'resetPasswordByEmail': {
      const [username, email, newPassword] = args;
      const { data, error } = await sbClient.rpc('pos_reset_password_by_email', {
        p_username: username,
        p_email: email,
        p_new_password: newPassword
      });
      if (error) throw new Error(error.message);
      return data;
    }
    case 'changePassword': {
      const [, oldPw, newPw] = args;
      const { data, error } = await sbClient.rpc('pos_change_password', { p_old_pw: oldPw, p_new_pw: newPw });
      if (error) throw new Error(error.message);
      return data;
    }
    case 'getActivityLog': {
      if (!isGlobalAdmin()) return [];
      const { data } = await sbClient.from('activity_logs').select('*').order('Timestamp', { ascending: false }).limit(300);
      return data || [];
    }
    case 'getSalesReport': {
      const [, opts = {}] = args;
      // Only Admin can view All Branches; non-Admin always sees their assigned Branch only
      const allBranches = isGlobalAdmin() && (opts.allBranches === true);
      let oQuery = sbClient.from('orders').select('*');
      let iQuery = sbClient.from('order_items').select('*');
      let lQuery = sbClient.from('activity_logs').select('*').in('Action', ['ITEM_REFUND', 'ITEM_REFUND_VOID', 'FULL_ORDER_REFUND', 'REJECT_COUNTER']);

      if (!allBranches) {
        oQuery = oQuery.eq('BranchID', bId);
        iQuery = iQuery.eq('BranchID', bId);
      }
      if (opts.startDate) {
        oQuery = oQuery.gte('CreatedAt', `${opts.startDate}T00:00:00`);
        lQuery = lQuery.gte('Timestamp', `${opts.startDate}T00:00:00`);
      }
      if (opts.endDate) {
        oQuery = oQuery.lte('CreatedAt', `${opts.endDate}T23:59:59`);
        lQuery = lQuery.lte('Timestamp', `${opts.endDate}T23:59:59`);
      }

      const [{ data: allOrds }, { data: allItms }, { data: refundLogs }] = await Promise.all([
        oQuery.order('CreatedAt', { ascending: false }),
        iQuery,
        lQuery.order('Timestamp', { ascending: false }).limit(300)
      ]);
      const orders = allOrds || [];
      const paid = orders.filter(o => o.PaymentStatus === 'PAID');
      const cancelled = orders.filter(o => ['CANCELLED', 'VOIDED'].includes(o.OrderStatus));
      const open = orders.filter(o => o.PaymentStatus !== 'PAID' && !['CANCELLED', 'VOIDED'].includes(o.OrderStatus));

      const totalSales = paid.reduce((s, o) => s + Number(o.GrandTotal || 0), 0);
      const totalSub = paid.reduce((s, o) => s + Number(o.Subtotal || 0), 0);
      const totalDisc = paid.reduce((s, o) => s + Number(o.Discount || 0), 0);
      const totalTax = paid.reduce((s, o) => s + Number(o.Tax || 0), 0);
      const totalSrv = paid.reduce((s, o) => s + Number(o.ServiceCharge || 0), 0);

      const paidIds = new Set(paid.map(o => o.OrderID));
      const items = (allItms || []).filter(i => paidIds.has(i.OrderID));
      const totalItems = items.reduce((s, i) => s + Number(i.Quantity || i.Qty || 0), 0);

      if (opts.summaryOnly) {
        return {
          totalSales,
          totalOrders: paid.length,
          averageOrderValue: paid.length ? totalSales / paid.length : 0,
          totalTax
        };
      }

      const branchNameMap = {};
      (state.branches || []).forEach(b => { branchNameMap[b.BranchID] = `${b.BranchName} (${b.BranchCode})`; });

      const userNameMap = {};
      (state.users || []).forEach(u => { userNameMap[u.UserID] = `${u.FullName} (${u.Role})`; });

      const orderByIdMap = {};
      orders.forEach(o => { orderByIdMap[o.OrderID] = o; });

      // Build comprehensive Edit Order / Item Refund & Void audit rows
      const refundAuditRows = [];
      const seenLogOrderIds = new Set();
      (refundLogs || []).forEach(l => {
        const linkedOrder = orderByIdMap[l.EntityID];
        if (!allBranches && !linkedOrder) return;
        if (l.EntityID) seenLogOrderIds.add(l.EntityID);
        const dt = new Date(l.Timestamp);
        const amtMatch = String(l.NewValue || '').match(/Refunded\s*[^\d.-]*([0-9]+(?:\.[0-9]+)?)/i);
        const parsedAmt = amtMatch ? parseFloat(amtMatch[1]) : (linkedOrder ? Number(linkedOrder.GrandTotal || 0) : 0);
        refundAuditRows.push({
          dateTime: `${dt.toLocaleDateString()} ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
          branch: linkedOrder ? (branchNameMap[linkedOrder.BranchID] || linkedOrder.BranchID || 'Main') : 'Current Branch',
          orderNumber: linkedOrder ? linkedOrder.OrderNumber : (String(l.NewValue || '').split('|')[0]?.trim() || '—'),
          table: linkedOrder ? (linkedOrder.TableNumber || 'Takeout') : '—',
          action: l.Action,
          amount: Number.isFinite(parsedAmt) ? parsedAmt : 0,
          details: l.NewValue || linkedOrder?.DiscountReason || '—',
          staff: userNameMap[l.UserID] || l.UserID || 'Manager/Admin'
        });
      });

      orders.forEach(o => {
        const hasRefundNote = /refund|void/i.test(String(o.DiscountReason || '')) || ['VOIDED', 'CANCELLED'].includes(o.OrderStatus) || o.PaymentStatus === 'REFUNDED';
        if (hasRefundNote && !seenLogOrderIds.has(o.OrderID)) {
          const dt = new Date(o.UpdatedAt || o.CreatedAt);
          const amtMatch = String(o.DiscountReason || '').match(/Refund\s*\([^\d.-]*([0-9]+(?:\.[0-9]+)?)/i);
          const parsedAmt = amtMatch ? parseFloat(amtMatch[1]) : Number(o.GrandTotal || 0);
          refundAuditRows.push({
            dateTime: `${dt.toLocaleDateString()} ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
            branch: branchNameMap[o.BranchID] || o.BranchID || 'Main',
            orderNumber: o.OrderNumber,
            table: o.TableNumber || 'Takeout',
            action: o.OrderStatus === 'VOIDED' ? 'FULL_ORDER_REFUND' : (o.OrderStatus === 'CANCELLED' ? 'CANCELLED' : 'ITEM_REFUND'),
            amount: Number.isFinite(parsedAmt) ? parsedAmt : 0,
            details: o.DiscountReason || o.OrderStatus,
            staff: o.CounterName || o.WaiterName || 'Manager/Admin'
          });
        }
      });

      const totalRefundedAmount = refundAuditRows.reduce((s, r) => s + Number(r.amount || 0), 0);

      const branchMap = {};
      (state.branches || []).forEach(b => {
        branchMap[b.BranchID] = { branchId: b.BranchID, branchName: `${b.BranchName} (${b.BranchCode})`, orders: 0, subtotal: 0, discount: 0, tax: 0, sales: 0 };
      });
      paid.forEach(o => {
        const bid = o.BranchID || 'branch-main';
        if (!branchMap[bid]) branchMap[bid] = { branchId: bid, branchName: branchNameMap[bid] || bid, orders: 0, subtotal: 0, discount: 0, tax: 0, sales: 0 };
        branchMap[bid].orders++;
        branchMap[bid].subtotal += Number(o.Subtotal || 0);
        branchMap[bid].discount += Number(o.Discount || 0);
        branchMap[bid].tax += Number(o.Tax || 0);
        branchMap[bid].sales += Number(o.GrandTotal || 0);
      });
      const branchBreakdown = Object.values(branchMap)
        .sort((a, b) => b.sales - a.sales)
        .map(b => ({
          ...b,
          avgOrder: b.orders ? b.sales / b.orders : 0,
          share: totalSales ? ((b.sales / totalSales) * 100).toFixed(1) : '0.0'
        }));

      const paymentMap = {};
      paid.forEach(o => {
        const label = o.PaymentMethod === 'Delivery' && o.DeliveryPlatform
          ? `Delivery (${o.DeliveryPlatform})`
          : (o.PaymentMethod || 'Cash');
        if (!paymentMap[label]) paymentMap[label] = { method: label, orders: 0, sales: 0 };
        paymentMap[label].orders++;
        paymentMap[label].sales += Number(o.GrandTotal || 0);
      });
      const paymentBreakdown = Object.values(paymentMap)
        .sort((a, b) => b.sales - a.sales)
        .map(p => ({
          ...p,
          share: totalSales ? ((p.sales / totalSales) * 100).toFixed(1) : '0.0'
        }));

      const topMap = {};
      items.forEach(i => {
        const name = i.ItemNameSnapshot || i.ItemName;
        const qty = Number(i.Quantity || i.Qty || 0);
        const line = Number(i.LineTotal || (qty * Number(i.UnitPriceSnapshot || i.UnitPrice || 0)));
        if (!topMap[name]) topMap[name] = { name, quantity: 0, sales: 0 };
        topMap[name].quantity += qty;
        topMap[name].sales += line;
      });
      const topItems = Object.values(topMap).sort((a, b) => b.sales - a.sales).map(x => ({
        ...x,
        avgPrice: x.quantity ? x.sales / x.quantity : 0,
        share: totalSub ? ((x.sales / totalSub) * 100).toFixed(1) : '0.0'
      }));

      const dailyMap = {};
      paid.forEach(o => {
        const dKey = (o.PaidAt || o.CreatedAt || '').slice(0, 10);
        if (!dailyMap[dKey]) dailyMap[dKey] = { date: dKey, orders: 0, subtotal: 0, discount: 0, tax: 0, service: 0, sales: 0 };
        dailyMap[dKey].orders++;
        dailyMap[dKey].subtotal += Number(o.Subtotal || 0);
        dailyMap[dKey].discount += Number(o.Discount || 0);
        dailyMap[dKey].tax += Number(o.Tax || 0);
        dailyMap[dKey].service += Number(o.ServiceCharge || 0);
        dailyMap[dKey].sales += Number(o.GrandTotal || 0);
      });

      const orderRows = paid.slice(0, 1000).map(o => {
        const dt = new Date(o.PaidAt || o.CreatedAt);
        const oItems = items.filter(i => i.OrderID === o.OrderID);
        return {
          date: dt.toLocaleDateString(),
          time: dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          branch: branchNameMap[o.BranchID] || o.BranchID || 'Main',
          orderNumber: o.OrderNumber,
          table: o.TableNumber || 'Takeout',
          customer: o.CustomerName || 'Walk-In',
          method: o.PaymentMethod === 'Delivery' && o.DeliveryPlatform ? `Delivery (${o.DeliveryPlatform})` : (o.PaymentMethod || 'Cash'),
          itemQty: oItems.reduce((s, i) => s + Number(i.Quantity || i.Qty || 0), 0),
          subtotal: Number(o.Subtotal || 0),
          discount: Number(o.Discount || 0),
          tax: Number(o.Tax || 0),
          service: Number(o.ServiceCharge || 0),
          total: Number(o.GrandTotal || 0),
          notes: o.DiscountReason || ''
        };
      });

      return {
        currency: curr(),
        allBranches,
        range: { start: opts.startDate, end: opts.endDate },
        totals: { sales: totalSales, subtotal: totalSub, discount: totalDisc, tax: totalTax, service: totalSrv, items: totalItems, refunded: totalRefundedAmount },
        counts: { paid: paid.length, cancelled: cancelled.length, open: open.length, refunds: refundAuditRows.length },
        averageOrderValue: paid.length ? totalSales / paid.length : 0,
        branchBreakdown,
        paymentBreakdown,
        topItems,
        daily: Object.values(dailyMap).sort((a, b) => b.date.localeCompare(a.date)),
        orders: orderRows,
        refunds: refundAuditRows
      };
    }
    case 'getEndOfDayReport': {
      const [, dateVal, openingFloatRaw, actualCashRaw] = args;
      const openingFloat = Math.max(0, Number(openingFloatRaw) || 0);
      const actualCash = (actualCashRaw !== null && actualCashRaw !== undefined && actualCashRaw !== '')
        ? Math.max(0, Number(actualCashRaw) || 0)
        : null;

      const [{ data: ords }, { data: itms }, { data: actLogs }] = await Promise.all([
        sbClient.from('orders').select('*').eq('BranchID', bId).gte('CreatedAt', `${dateVal}T00:00:00`).lte('CreatedAt', `${dateVal}T23:59:59`).order('CreatedAt', { ascending: true }),
        sbClient.from('order_items').select('*').eq('BranchID', bId),
        sbClient.from('activity_logs').select('*').gte('Timestamp', `${dateVal}T00:00:00`).lte('Timestamp', `${dateVal}T23:59:59`).order('Timestamp', { ascending: true }).limit(500)
      ]);
      const orders = ords || [];
      const paid = orders.filter(o => o.PaymentStatus === 'PAID');
      const cancelled = orders.filter(o => ['CANCELLED', 'VOIDED'].includes(o.OrderStatus));
      const openOrders = orders.filter(o => o.PaymentStatus !== 'PAID' && !['CANCELLED', 'VOIDED'].includes(o.OrderStatus));

      const userNameMap = {};
      (state.users || []).forEach(u => { userNameMap[u.UserID] = u.FullName; });

      const orderMap = {};
      orders.forEach(o => { orderMap[o.OrderID] = o; });

      // Build Edit Order / Item Refunds & Voids Log for the Business Date
      const refundLogs = [];
      const seenRefundOrders = new Set();
      (actLogs || []).forEach(l => {
        if (!['ITEM_REFUND', 'ITEM_REFUND_VOID', 'FULL_ORDER_REFUND', 'REJECT_COUNTER'].includes(l.Action)) return;
        const ord = orderMap[l.EntityID];
        if (!ord) return;
        seenRefundOrders.add(ord.OrderID);
        const dt = new Date(l.Timestamp);
        const amtMatch = String(l.NewValue || '').match(/Refunded\s*[^\d.-]*([0-9]+(?:\.[0-9]+)?)/i);
        const amt = amtMatch ? parseFloat(amtMatch[1]) : Number(ord.GrandTotal || 0);
        refundLogs.push({
          time: dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          orderNumber: ord.OrderNumber,
          table: ord.TableNumber || 'Takeout',
          action: l.Action,
          amount: Number.isFinite(amt) ? amt : 0,
          details: l.NewValue || ord.DiscountReason || '—',
          staff: userNameMap[l.UserID] || ord.CounterName || 'Manager/Admin'
        });
      });

      orders.forEach(o => {
        const hasRefundOrVoid = /refund|void/i.test(String(o.DiscountReason || '')) || ['VOIDED', 'CANCELLED'].includes(o.OrderStatus) || o.PaymentStatus === 'REFUNDED';
        if (hasRefundOrVoid && !seenRefundOrders.has(o.OrderID)) {
          const dt = new Date(o.UpdatedAt || o.CreatedAt);
          const amtMatch = String(o.DiscountReason || '').match(/Refund\s*\([^\d.-]*([0-9]+(?:\.[0-9]+)?)/i);
          const amt = amtMatch ? parseFloat(amtMatch[1]) : Number(o.GrandTotal || 0);
          refundLogs.push({
            time: dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            orderNumber: o.OrderNumber,
            table: o.TableNumber || 'Takeout',
            action: o.OrderStatus === 'VOIDED' ? 'FULL_ORDER_REFUND' : (o.OrderStatus === 'CANCELLED' ? 'CANCELLED' : 'ITEM_REFUND'),
            amount: Number.isFinite(amt) ? amt : 0,
            details: o.DiscountReason || o.OrderStatus,
            staff: o.CounterName || o.WaiterName || 'Manager/Admin'
          });
        }
      });

      const totalRefunded = refundLogs.reduce((s, r) => s + Number(r.amount || 0), 0);

      // Full Transaction Log (all branch orders + branch activity logs for the date)
      const branchOrderIds = new Set(orders.map(o => o.OrderID));
      const transactionLogs = orders.map(o => {
        const dt = new Date(o.PaidAt || o.CreatedAt);
        const pm = o.PaymentMethod === 'Delivery' && o.DeliveryPlatform
          ? `Delivery (${o.DeliveryPlatform})`
          : (o.PaymentMethod || 'Unpaid');
        return {
          time: dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          orderNumber: o.OrderNumber,
          table: o.TableNumber || 'Takeout',
          customer: o.CustomerName || 'Walk-In',
          method: pm,
          status: o.OrderStatus,
          paymentStatus: o.PaymentStatus,
          total: Number(o.GrandTotal || 0),
          staff: o.CounterName || o.WaiterName || '—',
          note: o.DiscountReason || ''
        };
      });

      const activityEvents = (actLogs || [])
        .filter(l => !l.EntityID || l.EntityType !== 'Order' || branchOrderIds.has(l.EntityID))
        .map(l => ({
          time: new Date(l.Timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          user: userNameMap[l.UserID] || l.UserID || 'System',
          action: l.Action,
          entity: l.EntityType || '',
          details: l.NewValue || ''
        }));

      const totalSales = paid.reduce((s, o) => s + Number(o.GrandTotal || 0), 0);
      const totalCollected = paid.reduce((s, o) => s + Number(o.AmountTendered || o.GrandTotal || 0), 0);
      const totalChange = paid.reduce((s, o) => s + Number(o.ChangeAmount || 0), 0);

      // Separate Hybrid payments (e.g., Hybrid (Cash + GCash)) into individual payment methods
      const methodMap = {};
      const addMethodSplit = (methodLabel, amount) => {
        const amt = Number(amount || 0);
        if (amt <= 0) return;
        const key = String(methodLabel || 'Cash').trim();
        if (!methodMap[key]) methodMap[key] = { method: key, count: 0, total: 0 };
        methodMap[key].count++;
        methodMap[key].total += amt;
      };

      let cashSales = 0;
      let cashTendered = 0;
      paid.forEach(o => {
        const pm = String(o.PaymentMethod || 'Cash').trim();
        const grandTotal = Number(o.GrandTotal || 0);
        const changeAmt = Number(o.ChangeAmount || 0);

        if (pm.startsWith('Hybrid (')) {
          const refStr = String(o.ReferenceNumber || '');
          const mCash = refStr.match(/Cash:\s*([0-9.]+)/i);
          const hybridInner = pm.match(/^Hybrid\s*\(\s*Cash\s*\+\s*([^)]+)\)/i);
          const secondName = hybridInner ? hybridInner[1].trim() : 'E-Wallet / Card';

          const escapedSecond = secondName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const mSecond = refStr.match(new RegExp(`${escapedSecond}:\\s*([0-9.]+)`, 'i'));

          const rawCash = mCash ? parseFloat(mCash[1]) : 0;
          const netCash = Math.max(0, rawCash - changeAmt);
          const secondAmt = mSecond
            ? parseFloat(mSecond[1])
            : Math.max(0, grandTotal - netCash);

          if (netCash > 0) {
            addMethodSplit('Cash', netCash);
            cashSales += netCash;
          }
          if (rawCash > 0) {
            cashTendered += rawCash;
          }
          if (secondAmt > 0) {
            addMethodSplit(secondName, secondAmt);
          }
        } else {
          const label = pm === 'Delivery' && o.DeliveryPlatform
            ? `Delivery (${o.DeliveryPlatform})`
            : pm;
          addMethodSplit(label, grandTotal);

          if (pm === 'Cash') {
            cashSales += grandTotal;
            cashTendered += Number(o.AmountTendered || grandTotal);
          }
        }
      });

      const expectedCash = openingFloat + cashSales;
      const variance = actualCash !== null ? (actualCash - expectedCash) : null;

      const paidIds = new Set(paid.map(o => o.OrderID));
      const soldItems = (itms || []).filter(i => paidIds.has(i.OrderID));
      const itemMap = {};
      let totalItemsQty = 0;
      soldItems.forEach(i => {
        const nm = i.ItemNameSnapshot || i.ItemName;
        const q = Number(i.Quantity || i.Qty || 0);
        const up = Number(i.UnitPriceSnapshot || i.UnitPrice || 0);
        totalItemsQty += q;
        if (!itemMap[nm]) itemMap[nm] = { name: nm, quantity: 0, unitPrice: up, total: 0 };
        itemMap[nm].quantity += q;
        itemMap[nm].total += Number(i.LineTotal || (q * up));
      });

      const activeBr = (state.branches || []).find(b => b.BranchID === bId);
      return {
        restaurantName: state.settings.RESTAURANT_NAME || 'Tuna Choice POS',
        branchName: activeBr ? `${activeBr.BranchName} (${activeBr.BranchCode})` : 'Main Branch',
        branchAddress: activeBr?.Address || '',
        generatedBy: state.user?.fullName || 'Admin',
        printedAt: new Date().toLocaleString(),
        reportNo: 'Z-' + dateVal.replace(/-/g, ''),
        date: dateVal,
        currency: curr(),
        counts: {
          paid: paid.length,
          cancelled: cancelled.length,
          open: openOrders.length,
          itemsQty: totalItemsQty,
          refunds: refundLogs.length
        },
        paymentBreakdown: Object.values(methodMap).sort((a, b) => b.total - a.total),
        cashDrawer: {
          openingFloat,
          cashSales,
          cashTendered,
          changeGiven: totalChange,
          expectedCash,
          actualCash,
          variance
        },
        totals: {
          subtotal: paid.reduce((s, o) => s + Number(o.Subtotal || 0), 0),
          lessVat: paid.reduce((s, o) => s + Number(o.LessVat || 0), 0),
          discount: paid.reduce((s, o) => s + Number(o.Discount || 0), 0),
          serviceCharge: paid.reduce((s, o) => s + Number(o.ServiceCharge || 0), 0),
          tax: paid.reduce((s, o) => s + Number(o.Tax || 0), 0),
          vatableSales: paid.reduce((s, o) => s + Number(o.VatableSales || 0), 0),
          vatExemptSales: paid.reduce((s, o) => s + Number(o.VatExemptSales || 0), 0),
          sales: totalSales,
          refunded: totalRefunded
        },
        totalCollected,
        totalChange,
        itemsSold: Object.values(itemMap).sort((a, b) => b.quantity - a.quantity),
        refundLogs,
        transactionLogs,
        activityEvents
      };
    }
    case 'getEodHistory': {
      const { data, error } = await sbClient
        .from('eod_reports')
        .select('*')
        .eq('BranchID', bId)
        .order('BusinessDate', { ascending: false })
        .limit(30);
      if (error) throw new Error(error.message);
      return data || [];
    }
    case 'archiveAndResetPOS': {
      const [, dateVal] = args;
      const r = window._lastEOD;
      if (r) {
        const baseRecord = {
          ReportID: uuid(),
          BranchID: bId,
          BusinessDate: dateVal,
          ClosedBy: state.user?.userId || null,
          CashSales: r.totals?.sales || 0,
          SeniorPwdDiscounts: r.totals?.discount || 0,
          VatExemptSales: r.totals?.vatExemptSales || 0,
          VatableSales: r.totals?.vatableSales || 0,
          VatAmount: r.totals?.tax || 0
        };
        const extendedRecord = {
          ...baseRecord,
          OpeningFloat: r.cashDrawer?.openingFloat ?? 0,
          ActualCash: r.cashDrawer?.actualCash ?? null
        };
        const { error: extErr } = await sbClient.from('eod_reports').insert(extendedRecord);
        if (extErr) {
          const { error: baseErr } = await sbClient.from('eod_reports').insert(baseRecord);
          if (baseErr) throw new Error(baseErr.message);
        }
      }
      await sbClient.from('orders').update({ OrderStatus: 'COMPLETED' }).eq('BranchID', bId).eq('PaymentStatus', 'PAID');
      await sbClient.from('restaurant_tables').update({ Status: 'Available', CurrentOrderID: null, ReservedFor: null }).eq('BranchID', bId);
      await logActivity('CLOSE_POS', 'EOD', dateVal, `Closed POS for ${dateVal} (Sales: ${Number(r?.totals?.sales || 0).toFixed(2)})`);
      return { success: true, message: `POS closed and Z-Reading archived for ${dateVal}` };
    }
    case 'exportDatabaseAsZip': {
      const dump = {
        exportedAt: new Date().toISOString(),
        branchId: bId,
        settings: state.settings,
        tables: state.tables,
        menu: state.menu,
        orders: state.orders
      };
      const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(dump, null, 2))));
      return { base64Data: b64, fileName: `pos_backup_${bId}_${todayStr()}.json` };
    }
    case 'setupDatabase':
      return { success: true };
    default:
      throw new Error(`Unknown operation: ${fnName}`);
  }
}

function callServerT(timeoutMs, fnName, ...args) {
  return Promise.race([
    callServer(fnName, ...args),
    new Promise((_, reject) => setTimeout(() => {
      const e = new Error('Request timed out'); e.isNetwork = true; reject(e);
    }, timeoutMs))
  ]);
}

async function logActivity(action, entityType, entityId, details) {
  try {
    await sbClient.from('activity_logs').insert({
      LogID: uuid(),
      Timestamp: new Date().toISOString(),
      UserID: state.user?.userId || null,
      Action: action,
      EntityType: entityType,
      EntityID: entityId,
      NewValue: details
    });
  } catch (e) {}
}

/* ============================================================
   SUPABASE REALTIME INSTANT SYNC ENGINE
   ============================================================ */
const triggerRealtimeRefresh = debounce(() => {
  if (state.token) poll(true);
}, 180);

function startRealtime() {
  stopRealtime();
  if (!sbClient || !state.token) return;
  const bId = state.activeBranchId || (state.user && state.user.branchId) || 'branch-main';

  state.realtimeChannel = sbClient
    .channel(`pos-branch-${bId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `BranchID=eq.${bId}` }, () => {
      triggerRealtimeRefresh();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items', filter: `BranchID=eq.${bId}` }, () => {
      triggerRealtimeRefresh();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'restaurant_tables', filter: `BranchID=eq.${bId}` }, () => {
      triggerRealtimeRefresh();
    })
    .subscribe((status) => {
      state.realtimeConnected = (status === 'SUBSCRIBED');
      updateSyncIndicator(navigator.onLine);
    });
}

function stopRealtime() {
  if (state.realtimeChannel && sbClient) {
    try { sbClient.removeChannel(state.realtimeChannel); } catch (e) {}
  }
  state.realtimeChannel = null;
  state.realtimeConnected = false;
}

/* ============================================================
   MULTI-BRANCH SWITCHER & MANAGEMENT
   ============================================================ */
function renderBranchSwitcher() {
  const wrap = $('branchSwitcherWrap');
  if (!wrap || !state.user) return;
  if (!isGlobalAdmin()) {
    wrap.innerHTML = `<span class="badge bg-warning text-dark"><i class="fa-solid fa-store me-1"></i>${escapeHtml(state.user.branchName || 'Main Branch')}</span>`;
    return;
  }
  const branches = state.branches || [];
  wrap.innerHTML = `
    <select class="form-select form-select-sm bg-dark text-warning border-warning fw-bold" style="max-width:190px;" onchange="switchBranch(this.value)">
      ${branches.map(b => `<option value="${escapeHtml(b.BranchID)}" ${b.BranchID === state.activeBranchId ? 'selected' : ''}>${escapeHtml(b.BranchName)} (${escapeHtml(b.BranchCode)})</option>`).join('')}
    </select>`;
}

async function switchBranch(branchId) {
  state.activeBranchId = branchId;
  state.eodGenerated = null;
  state.alertsPrimed = false;
  state.knownKdsOrderIds.clear();
  state.knownReadyOrderIds.clear();
  lsSet('pos_admin_branch', branchId);
  showLoading('Switching branch…');
  await loadBootstrap();
  startRealtime();
  await poll(true);
  if (state.currentView === 'admin') {
    loadAdminStats();
    syncEodDrawerInputs();
    loadEodHistory();
    if ($('eodReport')) $('eodReport').innerHTML = '';
  }
  hideLoading();
}

function renderBranchesAdminTable() {
  const tbody = $('branchesTableBody');
  if (!tbody) return;
  tbody.innerHTML = (state.branches || []).map(b => {
    const isMain = b.BranchID === 'branch-main';
    const delBtn = isMain
      ? `<button class="btn btn-sm btn-outline-secondary fw-bold" disabled title="Main Branch cannot be deleted"><i class="fa-solid fa-lock me-1"></i>Protected</button>`
      : `<button class="btn btn-sm btn-outline-danger fw-bold" onclick="deleteBranchById('${escapeHtml(b.BranchID)}', '${escapeHtml(b.BranchName)}')"><i class="fa-solid fa-trash me-1"></i>Delete</button>`;
    return `
    <tr>
      <td><strong>${escapeHtml(b.BranchName)}</strong></td>
      <td><span class="badge bg-dark">${escapeHtml(b.BranchCode)}</span></td>
      <td>${escapeHtml(b.Address || '—')}</td>
      <td>${b.Active ? '<span class="badge bg-success">Active</span>' : '<span class="badge bg-secondary">Inactive</span>'}</td>
      <td class="text-end text-nowrap">
        <button class="btn btn-sm btn-outline-primary fw-bold me-1" onclick="editBranch('${escapeHtml(b.BranchID)}')"><i class="fa-solid fa-pen-to-square me-1"></i>Edit</button>
        ${delBtn}
      </td>
    </tr>`;
  }).join('');

  const uBranch = $('cfgUserBranch');
  if (uBranch) {
    uBranch.innerHTML = (isGlobalAdmin() ? '<option value="">All Branches (Admin)</option>' : '') +
      (state.branches || []).map(b => `<option value="${escapeHtml(b.BranchID)}">${escapeHtml(b.BranchName)}</option>`).join('');
  }
}

function editBranch(id) {
  const b = (state.branches || []).find(x => x.BranchID === id);
  if (!b) return;
  $('cfgBranchId').value = b.BranchID;
  $('cfgBranchName').value = b.BranchName;
  $('cfgBranchCode').value = b.BranchCode;
  $('cfgBranchAddress').value = b.Address || '';
  $('cfgBranchFormTitle').textContent = `Edit Branch (${b.BranchName})`;
}

function resetBranchForm() {
  $('cfgBranchId').value = '';
  $('cfgBranchName').value = '';
  $('cfgBranchCode').value = '';
  $('cfgBranchAddress').value = '';
  $('cfgBranchFormTitle').textContent = 'Add / Edit Branch';
}

async function saveBranch(e) {
  e.preventDefault();
  const isNew = !$('cfgBranchId').value;
  try {
    showLoading(isNew ? 'Creating branch & copying Main Branch settings…' : 'Updating branch…');
    const { error } = await sbClient.rpc('pos_admin_save_branch', {
      p_branch_id: $('cfgBranchId').value || null,
      p_branch_name: $('cfgBranchName').value.trim(),
      p_branch_code: $('cfgBranchCode').value.trim(),
      p_address: $('cfgBranchAddress').value.trim(),
      p_active: true
    });
    if (error) throw new Error(error.message);
    showDone(isNew ? 'Branch created with Main Branch settings!' : 'Branch updated!', () => {
      resetBranchForm();
      loadBootstrap();
    });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

async function deleteBranchById(branchId, branchName) {
  if (branchId === 'branch-main') return toast('The Main Branch cannot be deleted.', 'warning');
  if (!confirm(`Delete branch "${branchName}"? This will remove its branch settings, tables, and menu overrides.`)) return;
  try {
    showLoading(`Deleting ${branchName}…`);
    const res = await callServer('deleteBranch', state.token, branchId);
    if ($('cfgBranchId').value === branchId) resetBranchForm();
    if (state.activeBranchId === branchId) {
      state.activeBranchId = 'branch-main';
      lsSet('pos_admin_branch', 'branch-main');
    }
    showDone(res.message || 'Branch deleted!', async () => {
      await loadBootstrap();
      await poll(true);
    });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

/* ============================================================
   OFFLINE QUEUE & OPTIMISTIC UPDATES
   ============================================================ */
function setTableStatus(tableId, status) {
  const t = (state.tables || []).find(x => x.TableID === tableId);
  if (t) t.Status = status;
}

function applyOptimistic(item) {
  try {
    const a = item.args || [];
    if (item.fn === 'createOrder') {
      const p = a[0] || {};
      if (state.orders.some(o => o.OrderID === item.id)) return;
      const sub = p.subtotal || 0;
      const iso = new Date(item.ts).toISOString();
      state.orders.push({
        OrderID: item.id,
        OrderNumber: 'OFFLINE-' + item.id.replace(/-/g, '').slice(0, 4).toUpperCase(),
        TableID: p.tableId || '', TableNumber: p.tableNumber || '',
        CustomerName: 'Walk-In Customer',
        WaiterID: state.user ? state.user.userId : '', WaiterName: state.user ? state.user.fullName : '',
        CounterID: '', CounterName: '',
        Subtotal: sub, Discount: 0, DiscountReason: '',
        Tax: 0, ServiceCharge: 0, GrandTotal: sub,
        OrderStatus: 'PENDING_COUNTER', PaymentStatus: 'UNPAID', AmountPaid: 0,
        EstimatedPreparationMinutes: 15, EstimatedCompletionTime: '',
        CreatedAt: iso, UpdatedAt: iso, _offline: true,
        items: (p.items || []).map(i => ({
          OrderItemID: uuid(), OrderID: item.id, MenuItemID: i.menuItemId, ItemNameSnapshot: i.itemName,
          UnitPriceSnapshot: i.price, Quantity: i.quantity, Station: i.station || 'Kitchen', Status: 'PENDING', KitchenStatus: 'Pending'
        }))
      });
      if (p.tableId) setTableStatus(p.tableId, 'Waiting for Counter Confirmation');
    } else if (item.fn === 'transitionOrder') {
      const o = state.orders.find(x => x.OrderID === a[0]);
      if (!o) return;
      const action = a[1], params = a[2] || {};
      if (action === 'REJECT_COUNTER') {
        state.orders = state.orders.filter(x => x.OrderID !== o.OrderID);
        if (o.TableID) setTableStatus(o.TableID, 'Available');
      } else if (action === 'ACCEPT_KITCHEN') {
        o.OrderStatus = 'ACCEPTED_BY_KITCHEN';
      } else if (action === 'START_PREP') {
        const mins = parseFloat(params.prepMinutes) || 15;
        o.OrderStatus = 'PREPARING'; o.EstimatedPreparationMinutes = mins;
        o.EstimatedCompletionTime = new Date(item.ts + mins * 60000).toISOString();
        if (o.TableID) setTableStatus(o.TableID, 'Preparing');
      } else if (action === 'MARK_READY') {
        o.OrderStatus = 'READY';
        if (o.TableID) setTableStatus(o.TableID, 'Ready to Serve');
      } else if (action === 'SERVE') {
        const itemUpdates = Array.isArray(params.itemUpdates) ? params.itemUpdates : null;
        if (itemUpdates !== null && Array.isArray(o.items)) {
          const updMap = {};
          itemUpdates.forEach(u => { updMap[u.orderItemId] = Math.max(0, parseInt(u.servedQty, 10) || 0); });
          let allFull = o.items.length > 0;
          o.items.forEach(it => {
            const totalQty = Number(it.Quantity || it.Qty || 1);
            const sQty = Math.min(totalQty, updMap[it.OrderItemID] ?? 0);
            const isFull = sQty >= totalQty;
            if (!isFull) allFull = false;
            it.ServedQty = sQty;
            it.Status = isFull ? 'SERVED' : 'PREPARING';
            it.KitchenStatus = isFull ? 'Served' : (sQty > 0 ? `Partial ${sQty}/${totalQty}` : 'Preparing');
          });
          o.OrderStatus = allFull ? 'SERVED' : 'PREPARING';
          if (o.TableID) setTableStatus(o.TableID, allFull ? 'Served' : 'Preparing');
        } else {
          o.OrderStatus = 'SERVED';
          if (o.TableID) setTableStatus(o.TableID, 'Served');
        }
      }
    } else if (item.fn === 'processPayment') {
      const p = a[0] || {};
      const o = state.orders.find(x => x.OrderID === p.orderId);
      if (!o) return;
      const received = Number(p.amountReceived || 0);
      const computed = p.computedTotals || {};
      if (computed.total !== undefined) {
        o.Subtotal = computed.subtotal; o.Discount = computed.discount;
        o.DiscountReason = p.discountReason || ''; o.Tax = computed.tax;
        o.ServiceCharge = computed.srv; o.LessVat = computed.lessVat;
        o.VatableSales = computed.vatableSales; o.VatExemptSales = computed.vatExemptSales;
        o.GrandTotal = computed.total;
      }
      if (p.customerName) o.CustomerName = p.customerName;
      const due = Math.max(0, Number(o.GrandTotal || 0) - Number(o.AmountPaid || 0));
      state.localPayments[o.OrderID] = [{
        PaymentMethod: p.paymentMethod || 'Cash', AmountPaid: received,
        ChangeAmount: p.changeAmount !== undefined ? Number(p.changeAmount) : Math.max(0, received - due),
        ReferenceNumber: p.referenceNumber || ''
      }];
      if (o.OrderStatus === 'PENDING_COUNTER') {
        o.OrderStatus = 'CONFIRMED_BY_COUNTER';
        if (o.TableID) setTableStatus(o.TableID, 'Occupied');
      }
      o.PaymentStatus = 'PAID'; o.AmountPaid = Number(o.GrandTotal || 0);
      o.CounterName = state.user ? state.user.fullName : '';
    } else if (item.fn === 'cleanTable') {
      setTableStatus(a[0], 'Available');
    } else if (item.fn === 'toggleTableReservation') {
      setTableStatus(a[0], a[1] ? 'Reserved' : 'Available');
      const rt = (state.tables || []).find(x => x.TableID === a[0]);
      if (rt) rt.ReservedFor = a[1] ? String(a[2] || '').trim() : '';
    } else if (item.fn === 'transferReservation') {
      const ft = (state.tables || []).find(x => x.TableID === a[0]);
      const tt = (state.tables || []).find(x => x.TableID === a[1]);
      if (ft && tt) {
        tt.Status = 'Reserved'; tt.ReservedFor = ft.ReservedFor || '';
        ft.Status = 'Available'; ft.ReservedFor = '';
      }
    }
  } catch (e) {}
}

function applyQueueToState() { state.queue.forEach(applyOptimistic); }

function enqueue(item) {
  state.queue.push(item); applyOptimistic(item); persistQueue(); updateSyncIndicator(false);
  if (!navigator.onLine) showOffline();
  renderCurrentView();
}

async function runAction(fn, args, id, label) {
  const item = { id: id || uuid(), fn: fn, args: args, ts: Date.now(), label: label || fn };
  if (state.queue.length > 0 || !navigator.onLine) {
    enqueue(item);
    if (navigator.onLine) setTimeout(() => poll(true), 200);
    return { queued: true };
  }
  try {
    const res = await callServerT(25000, fn, state.token, ...args);
    return { queued: false, res: res };
  } catch (err) {
    if (err.isNetwork) { enqueue(item); return { queued: true }; }
    throw err;
  }
}

async function flushQueue() {
  if (state.flushing || !state.token || !navigator.onLine || state.queue.length === 0) return;
  state.flushing = true; let synced = 0;
  try {
    while (state.queue.length) {
      const item = state.queue[0];
      try {
        const res = await callServerT(30000, item.fn, state.token, ...item.args);
        state.queue.shift(); synced++; await persistQueue();
        if (item.fn === 'createOrder' && res && res.orderNumber) toast(`Offline order synced as ${res.orderNumber}`, 'success');
      } catch (err) {
        if (err.isNetwork) break;
        state.queue.shift(); await persistQueue();
        toast(`Could not sync "${item.label}": ${err.message}`, 'danger');
      }
    }
  } finally {
    state.flushing = false;
    if (synced > 0) state.version = null;
    updateSyncIndicator(state.queue.length === 0);
  }
}

/* ============================================================
   AUTH, SESSION & PASSWORD RECOVERY
   ============================================================ */
async function handleLogin(e) {
  e.preventDefault();
  const btn = $('btnLoginSubmit');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    initSb('');
    const u = $('loginUsername').value.trim();
    const p = $('loginPassword').value;
    const res = await callServer('loginUser', u, p);
    if (!res || !res.success) {
      $('loginAlert').textContent = (res && res.message) || 'Invalid username or password.';
      $('loginAlert').classList.remove('d-none');
      return;
    }
    state.user = res.user;
    state.token = res.token;
    state.activeBranchId = res.user.branchId || lsGet('pos_admin_branch') || 'branch-main';
    initSb(state.token);
    lsSet('pos_auth', JSON.stringify({ token: res.token, user: res.user, expiresAt: res.expiresAt }));
    $('loginAlert').classList.add('d-none');
    await initSession();
  } catch (err) {
    const msg = /failed to fetch/i.test(err.message)
      ? 'Cannot reach database server. Please check your internet connection.'
      : err.message;
    $('loginAlert').textContent = msg;
    $('loginAlert').classList.remove('d-none');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

function openForgotPasswordModal() {
  const alertEl = $('resetPwAlert');
  if (alertEl) {
    alertEl.classList.add('d-none');
    alertEl.textContent = '';
  }
  $('fpUsername').value = $('loginUsername')?.value.trim() || '';
  $('fpEmail').value = '';
  $('fpNewPassword').value = '';
  $('fpConfirmPassword').value = '';
  showModal('forgotPasswordModal');
}

async function submitForgotPassword(e) {
  e.preventDefault();
  const alertEl = $('resetPwAlert');
  const btn = $('btnFpSubmit');
  const username = $('fpUsername').value.trim();
  const email = $('fpEmail').value.trim();
  const newPw = $('fpNewPassword').value;
  const confirmPw = $('fpConfirmPassword').value;

  const showFpAlert = (msg, isError) => {
    alertEl.className = `alert ${isError ? 'alert-danger' : 'alert-success'}`;
    alertEl.textContent = msg;
    alertEl.classList.remove('d-none');
  };

  if (newPw.length < 6) return showFpAlert('New password must be at least 6 characters.', true);
  if (newPw !== confirmPw) return showFpAlert('Passwords do not match.', true);

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i>Resetting…';
  try {
    initSb('');
    const res = await callServer('resetPasswordByEmail', username, email, newPw);
    if (!res || !res.success) {
      showFpAlert((res && res.message) || 'Could not reset password. Verify your username and recovery email.', true);
      return;
    }
    showFpAlert(res.message || 'Password reset successful!', false);
    if ($('loginUsername')) $('loginUsername').value = username;
    if ($('loginPassword')) $('loginPassword').value = '';
    setTimeout(() => {
      hideModal('forgotPasswordModal');
      toast('Password reset! Sign in with your new password.', 'success');
    }, 1100);
  } catch (err) {
    showFpAlert(err.message || 'Password reset failed.', true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-rotate me-1"></i>Reset Password';
  }
}

async function logout(opts) {
  opts = opts || {};
  if (!opts.force && state.queue.length > 0 &&
      !confirm(`You have ${state.queue.length} unsynced change(s) saved on this device.\nLogout anyway?`)) {
    return;
  }
  try {
    if (state.token && !opts.expired && navigator.onLine) await callServerT(8000, 'logoutUser', state.token);
  } catch (e) {}

  lsDel('pos_auth'); stopPolling(); stopRealtime();
  state.token = null; state.user = null; state.cart = []; state.queue = [];
  state.version = null; state.bootVer = null; state.adminLoadedAt = 0; state.alertsPrimed = false; state.eodGenerated = null;
  state.knownKdsOrderIds.clear(); state.knownReadyOrderIds.clear();

  $('loginUsername').value = ''; $('loginPassword').value = '';
  $('loginAlert').classList.add('d-none');
  hideOffline();
  $('appLayout').style.display = 'none'; $('loginScreen').style.display = 'flex';
}

async function resumeSession() {
  const saved = lsGet('pos_auth');
  if (!saved) return false;
  try {
    const auth = JSON.parse(saved);
    if (!auth || !auth.token || !auth.user) return false;
    if (!hasValidSupabaseCredentials()) return false;
    initSb(auth.token);
    if (navigator.onLine) {
      const v = await callServerT(15000, 'heartbeat', auth.token);
      if (!v || !v.valid) return false;
    }
    state.token = auth.token;
    state.user = auth.user;
    state.activeBranchId = auth.user.branchId || lsGet('pos_admin_branch') || 'branch-main';
    return true;
  } catch (e) { return false; }
}

async function initSession() {
  $('loginScreen').style.display = 'none';
  $('appLayout').style.display = 'block';
  $('userDisplayName').textContent = `${state.user.fullName} (${state.user.role})`;

  await restoreCache();
  applyRoleNav();
  const allowed = allowedViews();
  switchView(allowed[0] || 'counter');
  await loadBootstrap();
  startRealtime();
  startPolling();
}

function isKdsDisabled() {
  const v = state.settings.DISABLE_KDS;
  return v === 'true' || v === true;
}

function allowedViews() {
  if (!state.user) return [];
  const kds = !isKdsDisabled();
  const roleViews = {
    Waiter: ['waiter'],
    Counter: ['counter', 'waiter'],
    Kitchen: kds ? ['kitchen'] : [],
    Manager: kds ? ['waiter', 'counter', 'kitchen', 'admin'] : ['waiter', 'counter', 'admin'],
    Admin: kds ? ['waiter', 'counter', 'kitchen', 'admin'] : ['waiter', 'counter', 'admin']
  };
  return roleViews[state.user.role] || ['waiter'];
}

function applyRoleNav() {
  if (!state.user) return;
  const allowed = allowedViews();
  document.querySelectorAll('.navMenu .nav-link').forEach(el => {
    el.style.display = allowed.includes(el.dataset.view) ? '' : 'none';
    el.onclick = (ev) => { ev.preventDefault(); switchView(el.dataset.view); };
  });

  const adminOnly = isGlobalAdmin();
  const brTab = $('adminBranchesTabBtn');
  if (brTab) brTab.style.display = adminOnly ? '' : 'none';

  // Activity Log tab visible ONLY if Admin is logged in
  const logsTabItem = $('adminLogsTabItem');
  const logsTabPane = $('tabLogs');
  if (logsTabItem) logsTabItem.style.display = adminOnly ? '' : 'none';
  if (logsTabPane && !adminOnly) logsTabPane.classList.remove('show', 'active');

  // Sales Report: Non-admin sees only their Branch; Admin sees All Branches option
  const rScopeWrap = $('reportScopeWrap');
  const rScopeSel = $('reportBranchScope');
  if (rScopeWrap) rScopeWrap.style.display = adminOnly ? '' : 'none';
  if (rScopeSel) {
    if (!adminOnly) {
      rScopeSel.value = 'CURRENT';
    } else if (!rScopeSel.dataset.initialized) {
      rScopeSel.value = 'ALL';
      rScopeSel.dataset.initialized = 'true';
    }
  }

  if (allowed.length && !allowed.includes(state.currentView)) switchView(allowed[0]);
}

function canServeOrder(o) {
  if (['READY', 'SERVED'].includes(o.OrderStatus)) return true;
  return isKdsDisabled() && ['CONFIRMED_BY_COUNTER', 'ACCEPTED_BY_KITCHEN', 'PREPARING'].includes(o.OrderStatus);
}

async function restoreCache() {
  try {
    state.queue = (await Store.get('queue')) || [];
    const b = await Store.get('bootstrap');
    if (b) { applyBootstrap(b); state.bootVer = b.version || null; }
    const p = await Store.get('poll');
    if (p) applyPoll(p, true);
  } catch (e) {}
}

function applyBootstrap(data) {
  state.settings = data.settings || state.settings || {};
  state.categories = data.categories || [];
  state.menu = (data.menuItems || []).map(m => {
    const resolvedPrice = resolveMenuPrice(m);
    return {
      ...m,
      MenuItemID: m.MenuItemID || m.ItemID,
      ItemName: m.ItemName || m.Name || 'Unnamed Item',
      Price: resolvedPrice
    };
  });
  state.menuById = {};
  state.menu.forEach(m => { state.menuById[m.MenuItemID] = m; });
  if (data.tables) state.tables = data.tables;
  state.users = data.users || [];
  state.branches = data.branches || [];
  if (isGlobalAdmin() && state.branches.length && !state.branches.some(b => b.BranchID === state.activeBranchId)) {
    state.activeBranchId = state.branches[0].BranchID;
  }
  $('brandName').textContent = state.settings.RESTAURANT_NAME || 'Tuna Choice POS';
  document.title = state.settings.RESTAURANT_NAME || 'Tuna Choice POS';
  const activeBr = (state.branches || []).find(b => b.BranchID === state.activeBranchId);
  if ($('settingsBranchBadge')) {
    $('settingsBranchBadge').textContent = activeBr ? `Branch: ${activeBr.BranchName} (${activeBr.BranchCode})` : 'Current Branch Settings';
  }
  if ($('eodFloatCurrencyPrefix')) $('eodFloatCurrencyPrefix').textContent = curr();
  if ($('eodActualCurrencyPrefix')) $('eodActualCurrencyPrefix').textContent = curr();
  renderBranchSwitcher();
  renderBranchesAdminTable();
  populateAdminForms();
  applyRoleNav();
}

function applyPoll(data, silent) {
  state.tables = data.tables || [];
  state.orders = data.orders || [];
  state.stats = data.stats || {};
  state.version = silent ? null : data.version;
  if (state.queue.length) applyQueueToState();
  applyRoleNav();
  checkAlerts(silent);
  renderCurrentView();
}

function switchView(view) {
  state.currentView = view;
  document.querySelectorAll('.spa-view').forEach(el => el.style.display = 'none');
  const el = $(`view-${view}`);
  if (el) el.style.display = 'block';

  document.querySelectorAll('.navMenu .nav-link').forEach(x => {
    x.classList.toggle('active', x.dataset.view === view);
  });

  if (view === 'admin') {
    if (navigator.onLine && Date.now() - (state.adminLoadedAt || 0) > 15000) {
      state.adminLoadedAt = Date.now();
      loadAdminStats();
      if (isGlobalAdmin()) loadActivityLogs();
      loadEodHistory();
    }
    if (!$('eodDate').value) $('eodDate').value = todayStr();
    syncEodDrawerInputs();
  }
  renderCurrentView();
}

function renderCurrentView() {
  const v = state.currentView;
  if (v === 'waiter') { syncDashViewButtons(); renderTables(); renderWaiterOrders(); }
  else if (v === 'counter') { syncCounterViewButtons(); renderCounterQueue(); renderCounterOrderListTable(); }
  else if (v === 'kitchen') renderKitchenDisplay();
  if ($('orderModal').classList.contains('show')) { renderPOSMenu(); updateCartDisplay(); }
}

async function loadBootstrap() {
  try {
    const data = await callServer('getBootstrapData', state.token, state.bootVer || null);
    applyBootstrap(data); state.bootVer = data.version; Store.set('bootstrap', data); renderCurrentView();
  } catch (err) {
    if (!err.isNetwork) toast(err.message, 'danger');
  }
}

async function poll(force) {
  if (!state.token || state.polling) return;
  if (!navigator.onLine) { updateSyncIndicator(false); showOffline(); return; }
  state.polling = true;
  try {
    if (state.queue.length) {
      await flushQueue();
      if (!state.token || state.queue.length) { updateSyncIndicator(false); showOffline(); return; }
    }
    const data = await callServer('getPolledUpdates', state.token, state.user.role, force ? null : state.version);
    state.lastSync = new Date();
    Store.set('poll', data);
    applyPoll(data, false);
    updateSyncIndicator(true); hideOffline();
  } catch (err) {
    updateSyncIndicator(false);
    showOffline();
  } finally { state.polling = false; }
}

function startPolling() {
  stopPolling();
  const loop = async () => {
    if (!state.token) return;
    await poll();
    if (!state.token) return;
    const interval = state.realtimeConnected ? 20000 : (document.hidden ? 15000 : 4000);
    state.pollTimer = setTimeout(loop, interval);
  };
  loop();
}

function stopPolling() {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.token) {
    if (!state.realtimeConnected) startRealtime();
    poll(true);
  }
});
window.addEventListener('online', () => { if (!state.token) return; updateSyncIndicator(false); startRealtime(); poll(true); });
window.addEventListener('offline', () => { updateSyncIndicator(false); if (state.token) showOffline(); });

function updateSyncIndicator(ok) {
  const el = $('syncStatus');
  if (!el) return;
  const q = state.queue.length ? ` · ${state.queue.length} queued` : '';
  if (!ok || !navigator.onLine) {
    el.innerHTML = navigator.onLine
      ? `<i class="fa-solid fa-triangle-exclamation text-warning me-1"></i>Retrying…${q}`
      : `<i class="fa-solid fa-triangle-exclamation text-warning me-1"></i>Offline${q}`;
    return;
  }
  el.innerHTML = state.realtimeConnected
    ? `<i class="fa-solid fa-bolt text-success me-1"></i>Realtime Live${q}`
    : `<i class="fa-solid fa-check text-success me-1"></i>Synced ${state.lastSync ? state.lastSync.toLocaleTimeString() : ''}${q}`;
}

function showOffline() {
  const q = state.queue.length;
  $('offlineBanner').innerHTML = `<i class="fa-solid fa-wifi me-2"></i>Offline — reconnecting…${q ? ` ${q} change(s) saved on this device` : ''}`;
  $('offlineBanner').style.display = 'block';
}
function hideOffline() { $('offlineBanner').style.display = 'none'; }

/* ============================================================
   ALERTS, TABLES, RESERVATIONS, WAITER ORDERS & SERVE CHECKLIST
   ============================================================ */
function checkAlerts(silent) {
  const role = state.user && state.user.role;
  const list = Array.isArray(state.orders) ? state.orders : [];
  const readyNow = new Set(), newlyReady = [], kdsNow = new Set();
  let hasNewKds = false;

  list.forEach(o => {
    if (o.OrderStatus === 'READY') {
      readyNow.add(o.OrderID);
      if (!state.knownReadyOrderIds.has(o.OrderID)) newlyReady.push(o);
    }
    if (KDS_STATUSES.includes(o.OrderStatus)) {
      kdsNow.add(o.OrderID);
      if (!state.knownKdsOrderIds.has(o.OrderID)) hasNewKds = true;
    }
  });

  if (!silent && state.alertsPrimed) {
    if (newlyReady.length > 0 && ['Waiter', 'Counter', 'Manager', 'Admin'].includes(role)) showReadyAlert(newlyReady);
    if (hasNewKds && !isKdsDisabled() && ['Kitchen', 'Manager', 'Admin'].includes(role)) {
      playKdsChime(); toast('🔔 New order confirmed by counter!', 'warning');
    }
  }

  state.knownReadyOrderIds = readyNow; state.knownKdsOrderIds = kdsNow;
  if (!silent) state.alertsPrimed = true;
}

function showReadyAlert(newlyReady) {
  playKdsChime();
  const orderInfo = newlyReady.map(o =>
    `<div class="alert alert-success border-success text-start mb-2 shadow-sm">
      <div class="d-flex justify-content-between align-items-center mb-1">
        <h5 class="fw-bold mb-0 text-success"><i class="fa-solid fa-utensils me-2"></i>${escapeHtml(o.OrderNumber)}</h5>
        <span class="badge bg-dark fs-6">${escapeHtml(o.TableNumber || 'Takeout')}</span>
      </div>
      <p class="mb-1 small">Customer: <strong>${escapeHtml(o.CustomerName || 'Walk-In')}</strong></p>
      <p class="mb-0 small text-muted"><i class="fa-solid fa-list me-1"></i>Items: ${(o.items || []).map(i => `${i.Quantity}× ${escapeHtml(i.ItemNameSnapshot)}`).join(', ')}</p>
    </div>`
  ).join('');

  const modalBody = $('orderReadyModalBody');
  if (modalBody) {
    modalBody.innerHTML = `<h6 class="text-success fw-bold mb-3"><i class="fa-solid fa-circle-check me-1"></i>Kitchen finished cooking! Ready for pickup:</h6>${orderInfo}`;
    showModal('orderReadyModal');
  }
  newlyReady.forEach(o => { toast(`🔔 ${o.OrderNumber} (${o.TableNumber || 'Takeout'}) is READY TO SERVE!`, 'success'); });
}

function renderTables() {
  const el = $('tableGrid');
  if (!el) return;
  const tableList = Array.isArray(state.tables) ? state.tables : [];

  setHtml(el, tableList.map(t => {
    let border = 'success', badge = 'success', bgStyle = '';
    if (t.Status === 'Occupied' || t.Status === 'Waiting for Counter Confirmation') { border = 'danger'; badge = 'danger'; }
    else if (t.Status === 'Preparing') { border = 'info'; badge = 'info'; }
    else if (t.Status === 'Served' || t.Status === 'Ready to Serve') { border = 'primary'; badge = 'primary'; }
    else if (t.Status === 'Needs Cleaning') { border = 'warning'; badge = 'warning text-dark'; }
    else if (t.Status === 'Reserved') { border = 'purple'; badge = 'purple'; bgStyle = 'border-top-color: #6f42c1;'; }

    const needsClean = ['Needs Cleaning', 'Served', 'Ready to Serve', 'Occupied', 'Preparing', 'Waiting for Counter Confirmation'].includes(t.Status);
    const isReserved = t.Status === 'Reserved';

    return `<div class="col-6 col-md-3 col-lg-2">
      <div class="card card-pos table-card p-3 text-center position-relative"
           style="${bgStyle || `border-top-color: var(--bs-${border});`}"
           onclick="${needsClean ? `cleanTable('${escapeHtml(t.TableID)}')` : `openReservationModal('${escapeHtml(t.TableID)}')`}">
        ${isReserved ? '<i class="fa-solid fa-bookmark position-absolute top-0 end-0 m-2" style="color: #6f42c1;"></i>' : ''}
        <h5 class="fw-bold mb-1">${escapeHtml(t.TableNumber)}</h5>
        <small class="text-muted">${escapeHtml(t.Capacity)} seats</small>
        <div class="mt-2">
          <span class="badge ${isReserved ? 'text-white' : `bg-${badge}`}" style="${isReserved ? 'background-color: #6f42c1;' : ''}">
            ${escapeHtml(t.Status)}
          </span>
        </div>
        ${isReserved && t.ReservedFor ? `<div class="mt-2 small fw-bold text-truncate" style="color: #6f42c1;"><i class="fa-solid fa-user me-1"></i>${escapeHtml(t.ReservedFor)}</div>` : ''}
        ${t.Status === 'Available' ? '<div class="mt-2 small text-muted"><i class="fa-solid fa-bookmark me-1"></i>Tap to Reserve</div>' : ''}
        ${isReserved ? '<div class="mt-2 small fw-bold" style="color: #6f42c1;"><i class="fa-solid fa-pen me-1"></i>Manage Reservation</div>' : ''}
        ${t.Status === 'Needs Cleaning' ? '<div class="mt-2 small text-success fw-bold"><i class="fa-solid fa-broom me-1"></i>Tap to clean</div>' : ''}
        ${needsClean && t.Status !== 'Needs Cleaning' ? '<div class="mt-2 small text-muted"><i class="fa-solid fa-rotate-left me-1"></i>Tap to free</div>' : ''}
      </div></div>`;
  }).join(''));
}

async function cleanTable(tableId) {
  const t = (state.tables || []).find(x => x.TableID === tableId);
  if (!confirm(`Mark ${t ? t.TableNumber : 'this table'} as Available (cleaned)?`)) return;
  try {
    showLoading('Cleaning table…');
    const r = await runAction('cleanTable', [tableId], null, 'Clean table');
    showDone(r.queued ? 'Saved offline — will sync' : (r.res.message || 'Table is now Available'), () => { if (!r.queued) poll(); });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

function openReservationModal(tableId) {
  const t = (state.tables || []).find(x => x.TableID === tableId);
  if (!t) return;
  $('resTableId').value = tableId;
  $('resTableNumber').value = t.TableNumber;
  const isReserved = t.Status === 'Reserved';
  $('resCustomerNote').value = isReserved ? (t.ReservedFor || '') : '';
  $('btnUnreserve').style.display = isReserved ? 'inline-block' : 'none';

  const box = $('resTransferBox'), sel = $('resTransferSelect');
  if (box && sel) {
    const free = (state.tables || []).filter(x => x.Status === 'Available' && x.TableID !== tableId);
    sel.innerHTML = free.length
      ? free.map(x => `<option value="${escapeHtml(x.TableID)}">${escapeHtml(x.TableNumber)} (${escapeHtml(x.Capacity)} seats)</option>`).join('')
      : '<option value="">-- No tables currently available --</option>';
    box.classList.toggle('d-none', !isReserved);
  }
  showModal('reservationModal');
}

async function submitReservation(isReserved) {
  try {
    showLoading('Updating reservation status…');
    const r = await runAction('toggleTableReservation', [$('resTableId').value, isReserved, $('resCustomerNote').value], null, 'Table Reservation');
    showDone(r.queued ? 'Saved offline — will sync' : (r.res.message || 'Status updated'), () => {
      hideModal('reservationModal');
      if (!r.queued) poll(true);
    });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

async function submitReservationTransfer() {
  const toId = $('resTransferSelect').value;
  if (!toId) return toast('Please select an available table.', 'warning');
  try {
    showLoading('Transferring reservation…');
    const r = await runAction('transferReservation', [$('resTableId').value, toId], null, 'Reservation Transfer');
    showDone(r.queued ? 'Saved offline — will sync' : (r.res.message || 'Reservation transferred!'), () => {
      hideModal('reservationModal');
      if (!r.queued) poll(true);
    });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

function setDashboardView(mode) {
  state.dashView = mode === 'grid' ? 'grid' : 'list';
  lsSet('pos_dash_view', state.dashView);
  syncDashViewButtons();
  renderWaiterOrders();
}
function syncDashViewButtons() {
  const g = $('btnDashGrid'), l = $('btnDashList');
  if (g) g.classList.toggle('active', state.dashView === 'grid');
  if (l) l.classList.toggle('active', state.dashView !== 'grid');
}
function waiterOrderButtons(o) {
  const isServed = o.OrderStatus === 'SERVED';
  const serveBtn = canServeOrder(o)
    ? (isServed
      ? `<button class="btn btn-sm btn-outline-success fw-bold me-1" onclick="serveOrder('${o.OrderID}')" title="Review served items checklist"><i class="fa-solid fa-check-double me-1"></i>Served</button>`
      : `<button class="btn btn-sm btn-success fw-bold me-1" onclick="serveOrder('${o.OrderID}')"><i class="fa-solid fa-concierge-bell me-1"></i>Serve</button>`)
    : '';
  const isClosed = ['COMPLETED', 'CANCELLED', 'VOIDED'].includes(o.OrderStatus);
  const transferBtn = !isClosed
    ? `<button class="btn btn-sm btn-outline-primary fw-semibold" onclick="openTransferModal('${o.OrderID}')"><i class="fa-solid fa-arrows-rotate me-1"></i>Transfer</button>` : '';
  return serveBtn + transferBtn;
}
function waiterOrderEta(o) {
  return o.EstimatedCompletionTime ? `<span class="eta-countdown" data-eta="${o.EstimatedCompletionTime}">${formatEta(o.EstimatedCompletionTime)}</span>` : '—';
}
function waiterOrderCard(o) {
  const pendingIcon = o._offline ? ' <i class="fa-solid fa-cloud-arrow-up text-warning"></i>' : '';
  const paidBadge = o.PaymentStatus === 'PAID' ? '<span class="badge bg-success"><i class="fa-solid fa-check me-1"></i>PAID</span>' : '<span class="badge bg-danger">UNPAID</span>';
  return `<div class="col-12 col-md-4"><div class="card card-pos p-3 ${o.OrderStatus === 'SERVED' ? 'border border-success' : ''}">
    <div class="d-flex justify-content-between align-items-center border-bottom pb-2 mb-2">
      <h5 class="mb-0">${escapeHtml(o.OrderNumber)}${pendingIcon}</h5>
      <span class="badge bg-secondary fs-6">${escapeHtml(o.TableNumber || 'Takeout')}</span>
    </div>
    <div class="d-flex justify-content-between align-items-center mb-1"><span class="small">${badgeForStatus(o.OrderStatus)}</span>${paidBadge}</div>
    <p class="mb-1"><strong>${escapeHtml(o.CustomerName || 'Walk-In Customer')}</strong></p>
    <p class="mb-2 small text-muted"><i class="fa-solid fa-user-tie text-warning me-1"></i>Waiter: <strong>${escapeHtml(o.WaiterName || '—')}</strong></p>
    <ul class="list-group list-group-flush mb-2">${(o.items || []).map(i => {
      const tq = Number(i.Quantity || i.Qty || 1);
      const sq = getServedItemQty(i);
      const badge = sq >= tq
        ? '<span class="badge bg-success">Served</span>'
        : (sq > 0 ? `<span class="badge bg-warning text-dark">Served ${sq}/${tq}</span>` : '<span class="badge bg-light text-dark border">Pending</span>');
      return `<li class="list-group-item px-0 py-1 small d-flex justify-content-between"><span>${tq}× ${escapeHtml(i.ItemNameSnapshot)}</span>${badge}</li>`;
    }).join('')}</ul>
    <div class="d-flex justify-content-between mb-1"><span>Total:</span><strong class="text-danger">${curr()}${Number(o.GrandTotal || 0).toFixed(2)}</strong></div>
    <div class="d-flex justify-content-between small mb-2"><span class="text-muted">ETA:</span><span>${waiterOrderEta(o)}</span></div>
    <div class="d-flex gap-1">${waiterOrderButtons(o)}</div>
  </div></div>`;
}
function renderWaiterOrders() {
  const body = $('waiterOrdersBody');
  if (!body) return;
  const orderList = Array.isArray(state.orders) ? state.orders : [];
  const isGrid = state.dashView === 'grid';
  const wrap = $('waiterOrdersListWrap'), grid = $('waiterOrdersGrid');
  if (wrap) wrap.classList.toggle('d-none', isGrid);
  if (grid) grid.classList.toggle('d-none', !isGrid);

  if (isGrid) {
    setHtml(grid, orderList.length ? orderList.map(waiterOrderCard).join('') : '<div class="col-12 text-center text-muted py-4">No active orders.</div>');
    updateEtas();
    return;
  }
  setHtml(body, orderList.map(o => {
    const pendingIcon = o._offline ? ' <i class="fa-solid fa-cloud-arrow-up text-warning"></i>' : '';
    const servedQtySum = (o.items || []).reduce((s, i) => s + getServedItemQty(i), 0);
    const totalQtySum = (o.items || []).reduce((s, i) => s + Number(i.Quantity || i.Qty || 1), 0);
    return `<tr class="${o.OrderStatus === 'SERVED' ? 'table-success' : ''}">
      <td><strong>${escapeHtml(o.OrderNumber)}</strong>${pendingIcon}</td>
      <td><span class="badge bg-secondary fs-6">${escapeHtml(o.TableNumber || 'Takeout')}</span></td>
      <td>${escapeHtml(o.CustomerName)}</td>
      <td><i class="fa-solid fa-user-tie text-warning me-1"></i>${escapeHtml(o.WaiterName || '—')}</td>
      <td>${(o.items || []).length} <small class="text-muted">(${servedQtySum}/${totalQtySum} served)</small></td>
      <td>${curr()}${Number(o.GrandTotal || 0).toFixed(2)}</td>
      <td>${badgeForStatus(o.OrderStatus)}</td>
      <td>${waiterOrderEta(o)}</td>
      <td><div class="d-flex gap-1">${waiterOrderButtons(o)}</div></td>
    </tr>`;
  }).join(''));
  updateEtas();
}

/* ============================================================
   SERVE ITEMS CHECKLIST MODAL (SUPPORTS EDITING PARTIAL QUANTITIES)
   ============================================================ */
function serveOrder(orderId) {
  const o = (state.orders || []).find(x => x.OrderID === orderId);
  if (!o) return toast('Order not found.', 'warning');

  $('serveCheckOrderId').value = o.OrderID;
  $('serveCheckOrderNum').textContent = o.OrderNumber;
  $('serveCheckTable').textContent = o.TableNumber || 'Takeout';

  const items = o.items || [];
  const defaultAllReady = o.OrderStatus !== 'SERVED' && !items.some(it => getServedItemQty(it) > 0);

  $('serveChecklistContainer').innerHTML = items.length
    ? items.map(it => {
      const totalQty = Number(it.Quantity || it.Qty || 1);
      const initialServed = defaultAllReady ? totalQty : getServedItemQty(it);
      const checked = initialServed > 0;
      return `
        <div class="list-group-item d-flex justify-content-between align-items-center gap-2">
          <label class="form-check mb-0 flex-grow-1" style="cursor:pointer;">
            <input class="form-check-input serve-item-checkbox me-2" type="checkbox"
                   data-item-id="${escapeHtml(it.OrderItemID)}"
                   data-total-qty="${totalQty}"
                   ${checked ? 'checked' : ''}
                   onchange="onServeItemCheckboxChange(this)">
            <span class="fw-bold">${totalQty}× ${escapeHtml(it.ItemNameSnapshot || it.ItemName)}</span>
            <span class="badge bg-light text-dark border ms-1">${escapeHtml(it.Station || 'Kitchen')}</span>
          </label>
          <div class="d-flex align-items-center gap-1">
            <span class="small text-muted">Served:</span>
            <input type="number"
                   class="form-control form-control-sm text-center fw-bold serve-item-qty-input"
                   style="width:66px;"
                   data-item-id="${escapeHtml(it.OrderItemID)}"
                   data-total-qty="${totalQty}"
                   min="0" max="${totalQty}" value="${initialServed}"
                   oninput="onServeItemQtyInput(this)">
            <span class="small text-muted fw-semibold">/ ${totalQty}</span>
          </div>
        </div>`;
    }).join('')
    : '<div class="text-muted small py-2">No line items recorded for this order.</div>';

  updateServeChecklistNote();
  showModal('serveChecklistModal');
}

function onServeItemCheckboxChange(cb) {
  const itemId = cb.dataset.itemId;
  const totalQty = parseInt(cb.dataset.totalQty, 10) || 1;
  const qtyInp = document.querySelector(`.serve-item-qty-input[data-item-id="${itemId}"]`);
  if (qtyInp) {
    qtyInp.value = cb.checked ? totalQty : 0;
  }
  updateServeChecklistNote();
}

function onServeItemQtyInput(inp) {
  const itemId = inp.dataset.itemId;
  const totalQty = parseInt(inp.dataset.totalQty, 10) || 1;
  let val = parseInt(inp.value, 10);
  if (isNaN(val) || val < 0) val = 0;
  if (val > totalQty) { val = totalQty; inp.value = totalQty; }
  const cb = document.querySelector(`.serve-item-checkbox[data-item-id="${itemId}"]`);
  if (cb) {
    cb.checked = val > 0;
  }
  updateServeChecklistNote();
}

function toggleAllServeChecklist(checked) {
  document.querySelectorAll('.serve-item-checkbox').forEach(cb => {
    cb.checked = checked;
    const itemId = cb.dataset.itemId;
    const totalQty = parseInt(cb.dataset.totalQty, 10) || 1;
    const qtyInp = document.querySelector(`.serve-item-qty-input[data-item-id="${itemId}"]`);
    if (qtyInp) qtyInp.value = checked ? totalQty : 0;
  });
  updateServeChecklistNote();
}

function updateServeChecklistNote() {
  const qtyInputs = Array.from(document.querySelectorAll('.serve-item-qty-input'));
  const noteEl = $('serveChecklistStatusNote');
  if (!noteEl) return;

  let totalOrdered = 0;
  let totalServed = 0;
  qtyInputs.forEach(inp => {
    const maxQ = parseInt(inp.dataset.totalQty, 10) || 1;
    const curQ = Math.min(maxQ, Math.max(0, parseInt(inp.value, 10) || 0));
    totalOrdered += maxQ;
    totalServed += curQ;
  });

  const remaining = Math.max(0, totalOrdered - totalServed);
  if (totalOrdered === 0 || remaining === 0) {
    noteEl.className = 'alert alert-success small py-2 mb-3';
    noteEl.innerHTML = `<i class="fa-solid fa-circle-check me-1"></i>All ${totalOrdered} item quantity served. Order status will be marked as <strong>SERVED</strong>.`;
  } else {
    noteEl.className = 'alert alert-warning small py-2 mb-3';
    noteEl.innerHTML = `<i class="fa-solid fa-fire me-1"></i>Served <strong>${totalServed} of ${totalOrdered}</strong> (${remaining} short/pending). Order status will stay in <strong>PREPARING</strong> until all items are served.`;
  }
}

async function submitServeChecklist() {
  const orderId = $('serveCheckOrderId').value;
  const qtyInputs = Array.from(document.querySelectorAll('.serve-item-qty-input'));
  let allFull = true;
  const itemUpdates = qtyInputs.map(inp => {
    const totalQty = parseInt(inp.dataset.totalQty, 10) || 1;
    const servedQty = Math.min(totalQty, Math.max(0, parseInt(inp.value, 10) || 0));
    if (servedQty < totalQty) allFull = false;
    return { orderItemId: inp.dataset.itemId, servedQty, totalQty };
  });

  const doneMsg = allFull
    ? 'All items served — order marked as SERVED!'
    : 'Partial serve saved — order remains in PREPARING until remaining items are served.';

  const r = await transition(
    orderId,
    'SERVE',
    { itemUpdates },
    'Serve checklist',
    'Updating serve checklist…',
    doneMsg
  );
  if (r) hideModal('serveChecklistModal');
}

function badgeForStatus(s) {
  const map = { PENDING_COUNTER: 'warning text-dark', CONFIRMED_BY_COUNTER: 'info', ACCEPTED_BY_KITCHEN: 'primary', PREPARING: 'primary', READY: 'success', SERVED: 'success', COMPLETED: 'dark', CANCELLED: 'danger', VOIDED: 'danger' };
  return `<span class="badge bg-${map[s] || 'secondary'} badge-status">${escapeHtml(String(s).replace(/_/g, ' '))}</span>`;
}
function formatEta(iso) { const diff = new Date(iso) - new Date(); return diff <= 0 ? 'LATE' : `${Math.floor(diff / 60000)}m`; }
function updateEtas() {
  document.querySelectorAll('.eta-countdown').forEach(el => {
    const eta = el.dataset.eta; if (!eta) return;
    const txt = formatEta(eta); el.textContent = txt; el.classList.toggle('late', txt === 'LATE');
  });
}
setInterval(() => { if (!document.hidden) updateEtas(); }, 15000);

function openTransferModal(orderId) {
  const o = (state.orders || []).find(x => x.OrderID === orderId);
  if (!o) return toast('Order not found.', 'warning');
  $('transferOrderId').value = orderId;
  $('transferOrderNum').textContent = o.OrderNumber;
  $('transferCurrentTable').textContent = o.TableNumber || 'Takeout';
  const availableTables = (state.tables || []).filter(t => t.Status === 'Available');
  $('transferTargetTableSelect').innerHTML = availableTables.length === 0
    ? '<option value="">-- No tables currently available --</option>'
    : availableTables.map(t => `<option value="${escapeHtml(t.TableID)}|${escapeHtml(t.TableNumber)}">${escapeHtml(t.TableNumber)} (${escapeHtml(t.Capacity)} seats)</option>`).join('');
  showModal('transferTableModal');
}

async function submitTableTransfer() {
  const selVal = $('transferTargetTableSelect').value;
  if (!selVal) return toast('Please select an available target table.', 'warning');
  const parts = selVal.split('|');
  try {
    showLoading('Transferring table…');
    const r = await runAction('transferTableOrder', [$('transferOrderId').value, parts[0], parts.slice(1).join('|')], null, 'Table Transfer');
    showDone(r.queued ? 'Saved offline — will sync' : (r.res.message || 'Table transferred!'), () => { hideModal('transferTableModal'); if (!r.queued) poll(true); });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

function openMergeModal() {
  const occupiedOrders = (state.orders || []).filter(o => o.TableID && !['CANCELLED', 'VOIDED', 'COMPLETED'].includes(o.OrderStatus));
  if (occupiedOrders.length < 2) return toast('You need at least 2 active occupied tables to perform a merge.', 'warning');
  $('mergeSourceTableSelect').innerHTML = occupiedOrders.map(o => `<option value="${escapeHtml(o.TableID)}">${escapeHtml(o.TableNumber)} (${escapeHtml(o.OrderNumber)} - ${escapeHtml(o.CustomerName)})</option>`).join('');
  onMergeSourceTableChange();
  showModal('mergeTablesModal');
}
function onMergeSourceTableChange() {
  const sel = $('mergeSourceTableSelect').value;
  const targets = (state.orders || []).filter(o => o.TableID && o.TableID !== sel && !['CANCELLED', 'VOIDED', 'COMPLETED'].includes(o.OrderStatus));
  $('mergeTargetTableSelect').innerHTML = targets.map(o => `<option value="${escapeHtml(o.TableID)}">${escapeHtml(o.TableNumber)} (${escapeHtml(o.OrderNumber)} - ${escapeHtml(o.CustomerName)})</option>`).join('');
}
async function submitTableMerge() {
  const src = $('mergeSourceTableSelect').value, tgt = $('mergeTargetTableSelect').value;
  if (!src || !tgt || src === tgt) return toast('Please select two distinct active tables.', 'warning');
  try {
    showLoading('Merging table orders…');
    const r = await runAction('mergeTableOrders', [src, tgt], null, 'Table Merge');
    showDone(r.queued ? 'Saved offline — will sync' : (r.res.message || 'Tables merged!'), () => { hideModal('mergeTablesModal'); if (!r.queued) poll(true); });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

/* ============================================================
   COUNTER VIEW, ORDER LIST TABLE & MANAGER/ADMIN ITEM REFUND
   ============================================================ */
function setCounterView(mode) { state.counterView = mode === 'list' ? 'list' : 'grid'; lsSet('pos_counter_view', state.counterView); syncCounterViewButtons(); renderCounterQueue(); }
function syncCounterViewButtons() {
  const g = $('btnCounterGrid'), l = $('btnCounterList');
  if (g) g.classList.toggle('active', state.counterView !== 'list');
  if (l) l.classList.toggle('active', state.counterView === 'list');
}
function counterPendingCard(o) {
  return `<div class="col-12 col-md-4"><div class="card card-pos p-3 border-warning">
    <div class="d-flex justify-content-between align-items-center border-bottom pb-2 mb-2"><h5 class="mb-0">${escapeHtml(o.OrderNumber)}</h5><span class="badge bg-primary">${escapeHtml(o.TableNumber || 'Takeout')}</span></div>
    <p class="mb-1"><strong>${escapeHtml(o.CustomerName || 'Walk-In Customer')}</strong></p>
    <p class="mb-2 small text-muted"><i class="fa-solid fa-user-tie me-1"></i>Server: <strong>${escapeHtml(o.WaiterName || '—')}</strong></p>
    <ul class="list-group list-group-flush mb-2">${(o.items || []).map(i => `<li class="list-group-item px-0 py-1 small">${i.Quantity}× ${escapeHtml(i.ItemNameSnapshot)}</li>`).join('')}</ul>
    <div class="d-flex justify-content-between mb-2"><span>Subtotal:</span><strong class="text-danger">${curr()}${Number(o.Subtotal || 0).toFixed(2)}</strong></div>
    <div class="d-flex gap-2 mb-2">
      <button class="btn btn-success flex-grow-1 fw-bold" onclick="confirmCounter('${o.OrderID}')">Pay &amp; Confirm</button>
      <button class="btn btn-outline-danger" onclick="rejectCounter('${o.OrderID}')">Reject</button>
    </div>
    <button class="btn btn-sm btn-outline-dark w-100" onclick="printKitchenTicket('${o.OrderID}')"><i class="fa-solid fa-print me-1"></i>Print Kitchen Ticket</button>
  </div></div>`;
}
function counterPaidCard(o, kdsOff) {
  return `<div class="col-12 col-md-4"><div class="card card-pos p-3 border-info">
    <div class="d-flex justify-content-between align-items-center border-bottom pb-2 mb-2"><h5 class="mb-0">${escapeHtml(o.OrderNumber)}</h5><span class="badge bg-secondary">${escapeHtml(o.TableNumber || 'Takeout')}</span></div>
    <div class="d-flex justify-content-between align-items-center mb-1"><span class="small">Status: ${badgeForStatus(o.OrderStatus)}</span><span class="badge bg-success"><i class="fa-solid fa-check me-1"></i>PAID</span></div>
    <p class="mb-1 small text-muted"><i class="fa-solid fa-user-tie me-1"></i>Server: <strong>${escapeHtml(o.WaiterName || '—')}</strong></p>
    <p class="mb-2 small text-muted"><i class="fa-solid fa-cash-register me-1"></i>Counter: <strong>${escapeHtml(o.CounterName || '—')}</strong></p>
    <div class="d-flex justify-content-between mb-2"><span>Total Paid:</span><strong class="text-success">${curr()}${Number(o.GrandTotal || 0).toFixed(2)}</strong></div>
    ${kdsOff ? '' : `<div class="alert alert-light border p-2 text-center mb-2 small text-primary fw-semibold"><i class="fa-solid fa-clock me-1"></i>Waiting for Kitchen / Serving…</div>`}
    <div class="d-flex gap-2">
      <button class="btn btn-sm btn-outline-secondary flex-grow-1" onclick="openReceiptModal('${o.OrderID}')"><i class="fa-solid fa-receipt me-1"></i>Reprint Receipt</button>
      <button class="btn btn-sm btn-outline-dark" onclick="printKitchenTicket('${o.OrderID}')"><i class="fa-solid fa-print me-1"></i>Kitchen Ticket</button>
    </div>
  </div></div>`;
}
function counterUnpaidCard(o) {
  return `<div class="col-12 col-md-4"><div class="card card-pos p-3 border-danger">
    <div class="d-flex justify-content-between align-items-center border-bottom pb-2 mb-2"><h5 class="mb-0">${escapeHtml(o.OrderNumber)}</h5><span class="badge bg-secondary">${escapeHtml(o.TableNumber || 'Takeout')}</span></div>
    <p class="mb-1 small">Status: ${badgeForStatus(o.OrderStatus)} • <span class="badge bg-danger">UNPAID</span></p>
    <div class="d-flex justify-content-between mb-2"><span>Amount Due:</span><strong class="text-danger">${curr()}${Number(o.GrandTotal || 0).toFixed(2)}</strong></div>
    <button class="btn btn-primary w-100 fw-bold mb-2" onclick="openPaymentModal('${o.OrderID}', ${Number(o.GrandTotal || 0)}, ${Number(o.AmountPaid || 0)})"><i class="fa-solid fa-money-bill me-1"></i>Process Payment</button>
    <button class="btn btn-sm btn-outline-dark w-100" onclick="printKitchenTicket('${o.OrderID}')"><i class="fa-solid fa-print me-1"></i>Print Kitchen Ticket</button>
  </div></div>`;
}
function counterListRow(o, kind) {
  const itemsTxt = (o.items || []).map(i => `${i.Quantity}× ${escapeHtml(i.ItemNameSnapshot)}`).join(', ');
  const ticketBtn = `<button class="btn btn-sm btn-outline-dark" onclick="printKitchenTicket('${o.OrderID}')"><i class="fa-solid fa-print"></i></button>`;
  let total, status, actions, border;
  if (kind === 'pending') {
    border = 'warning'; total = `<strong class="text-danger">${curr()}${Number(o.Subtotal || 0).toFixed(2)}</strong>`; status = badgeForStatus(o.OrderStatus);
    actions = `<button class="btn btn-sm btn-success fw-bold" onclick="confirmCounter('${o.OrderID}')">Pay &amp; Confirm</button><button class="btn btn-sm btn-outline-danger" onclick="rejectCounter('${o.OrderID}')">Reject</button>${ticketBtn}`;
  } else if (kind === 'paid') {
    border = 'info'; total = `<strong class="text-success">${curr()}${Number(o.GrandTotal || 0).toFixed(2)}</strong>`; status = `${badgeForStatus(o.OrderStatus)} <span class="badge bg-success">PAID</span>`;
    actions = `<button class="btn btn-sm btn-outline-secondary" onclick="openReceiptModal('${o.OrderID}')">Receipt</button>${ticketBtn}`;
  } else {
    border = 'danger'; total = `<strong class="text-danger">${curr()}${Number(o.GrandTotal || 0).toFixed(2)}</strong>`; status = `${badgeForStatus(o.OrderStatus)} <span class="badge bg-danger">UNPAID</span>`;
    actions = `<button class="btn btn-sm btn-primary fw-bold" onclick="openPaymentModal('${o.OrderID}', ${Number(o.GrandTotal || 0)}, ${Number(o.AmountPaid || 0)})">Pay</button>${ticketBtn}`;
  }
  return `<tr style="border-left:4px solid var(--bs-${border});"><td><strong>${escapeHtml(o.OrderNumber)}</strong></td><td><span class="badge bg-secondary">${escapeHtml(o.TableNumber || 'Takeout')}</span></td><td>${escapeHtml(o.CustomerName || 'Walk-In')}</td><td class="small">${escapeHtml(o.WaiterName || '—')}</td><td class="small text-muted">${itemsTxt || '—'}</td><td>${total}</td><td>${status}</td><td class="small">${escapeHtml(o.CounterName || '—')}</td><td class="text-end"><div class="d-flex gap-1 justify-content-end">${actions}</div></td></tr>`;
}
function renderCounterQueue() {
  const el = $('counterQueue');
  if (!el) return;
  const orderList = Array.isArray(state.orders) ? state.orders : [];
  const kdsOff = isKdsDisabled();
  const pending = orderList.filter(o => o.OrderStatus === 'PENDING_COUNTER');
  const inKitchenOrReady = orderList.filter(o => ['CONFIRMED_BY_COUNTER', 'ACCEPTED_BY_KITCHEN', 'PREPARING', 'READY'].includes(o.OrderStatus) && o.PaymentStatus === 'PAID');
  const readyToPay = orderList.filter(o => ['READY', 'SERVED'].includes(o.OrderStatus) && o.PaymentStatus !== 'PAID');

  if (!pending.length && !inKitchenOrReady.length && !readyToPay.length) {
    setHtml(el, '<div class="col-12 text-center text-muted py-5"><h5>No active orders at counter.</h5></div>');
  } else if (state.counterView === 'list') {
    const rows = [].concat(pending.map(o => counterListRow(o, 'pending')), inKitchenOrReady.map(o => counterListRow(o, 'paid')), readyToPay.map(o => counterListRow(o, 'unpaid')));
    setHtml(el, `<div class="col-12"><div class="card card-pos p-2"><div class="table-responsive"><table class="table table-hover align-middle mb-0"><thead><tr><th>Order #</th><th>Table</th><th>Customer</th><th>Server</th><th>Items</th><th>Total</th><th>Status</th><th>Counter</th><th class="text-end">Actions</th></tr></thead><tbody>${rows.join('')}</tbody></table></div></div></div>`);
  } else {
    setHtml(el, pending.map(counterPendingCard).join('') + inKitchenOrReady.map(o => counterPaidCard(o, kdsOff)).join('') + readyToPay.map(counterUnpaidCard).join(''));
  }

  const statsEl = $('counterStats');
  if (statsEl) {
    setHtml(statsEl, `
      <div class="col-6 col-md-3"><div class="stat-card bg-warning"><h6>Pending Confirmation</h6><h3>${pending.length}</h3></div></div>
      <div class="col-6 col-md-3"><div class="stat-card bg-info"><h6>${kdsOff ? 'Paid / To Serve' : 'In Kitchen / Serving'}</h6><h3>${inKitchenOrReady.length}</h3></div></div>
      <div class="col-6 col-md-3"><div class="stat-card bg-danger"><h6>Unpaid Orders</h6><h3>${readyToPay.length}</h3></div></div>
      <div class="col-6 col-md-3"><div class="stat-card bg-primary"><h6>Served Total</h6><h3>${state.stats.served || 0}</h3></div></div>
    `);
  }
}

function renderCounterOrderListTable() {
  const tbody = $('counterOrdersTableBody');
  if (!tbody) return;
  const orderList = Array.isArray(state.orders) ? state.orders : [];
  const canEdit = isManagerOrAdmin();

  if ($('counterOrderListCount')) {
    $('counterOrderListCount').textContent = `${orderList.length} order${orderList.length === 1 ? '' : 's'}`;
  }

  if (!orderList.length) {
    setHtml(tbody, '<tr><td colspan="9" class="text-center text-muted py-3">No orders in the current branch queue.</td></tr>');
    return;
  }

  setHtml(tbody, orderList.map(o => {
    const itemsSummary = (o.items || []).map(i => `${i.Quantity || i.Qty}× ${escapeHtml(i.ItemNameSnapshot || i.ItemName)}`).join(', ');
    const payBadge = o.PaymentStatus === 'PAID'
      ? `<span class="badge bg-success">PAID</span>`
      : `<span class="badge bg-danger">UNPAID</span>`;

    const editBtn = canEdit
      ? `<button class="btn btn-sm btn-warning fw-bold text-dark me-1" onclick="openCounterEditOrderModal('${escapeHtml(o.OrderID)}')" title="Edit Order or Refund Unserved Item"><i class="fa-solid fa-pen-to-square me-1"></i>Edit / Refund</button>`
      : `<button class="btn btn-sm btn-outline-secondary me-1" disabled title="Only Manager or Admin can edit or refund orders"><i class="fa-solid fa-lock me-1"></i>Mgr/Admin</button>`;

    const receiptBtn = o.PaymentStatus === 'PAID'
      ? `<button class="btn btn-sm btn-outline-secondary" onclick="openReceiptModal('${escapeHtml(o.OrderID)}')" title="Receipt"><i class="fa-solid fa-receipt"></i></button>`
      : `<button class="btn btn-sm btn-outline-primary" onclick="openPaymentModal('${escapeHtml(o.OrderID)}')" title="Pay"><i class="fa-solid fa-money-bill"></i></button>`;

    return `
      <tr>
        <td><strong>${escapeHtml(o.OrderNumber)}</strong></td>
        <td><span class="badge bg-secondary">${escapeHtml(o.TableNumber || 'Takeout')}</span></td>
        <td>${escapeHtml(o.CustomerName || 'Walk-In')}</td>
        <td class="small">${escapeHtml(o.WaiterName || '—')}</td>
        <td class="small text-muted" style="max-width:240px;">${itemsSummary || '—'}</td>
        <td><strong class="text-danger">${curr()}${Number(o.GrandTotal || 0).toFixed(2)}</strong></td>
        <td>${badgeForStatus(o.OrderStatus)}</td>
        <td>${payBadge}</td>
        <td class="text-end text-nowrap">${editBtn}${receiptBtn}</td>
      </tr>`;
  }).join(''));
}

function openCounterEditOrderModal(orderId) {
  if (!isManagerOrAdmin()) {
    return toast('Only Manager or Admin can edit orders or refund items.', 'warning');
  }
  const o = (state.orders || []).find(x => x.OrderID === orderId);
  if (!o) return toast('Order not found.', 'warning');

  $('editRefundOrderId').value = o.OrderID;
  $('editRefundOrderNum').textContent = o.OrderNumber;
  $('editRefundTable').textContent = o.TableNumber || 'Takeout';
  $('editRefundCustomer').textContent = o.CustomerName || 'Walk-In Customer';
  $('editRefundCurrentTotal').textContent = `${curr()}${Number(o.GrandTotal || 0).toFixed(2)}`;
  $('editRefundStatusBadges').innerHTML = `${badgeForStatus(o.OrderStatus)} ${o.PaymentStatus === 'PAID' ? '<span class="badge bg-success">PAID</span>' : '<span class="badge bg-danger">UNPAID</span>'}`;
  $('editRefundReason').value = '';

  const tbody = $('editRefundItemsBody');
  const items = o.items || [];
  tbody.innerHTML = items.length ? items.map(it => {
    const qty = Number(it.Quantity || it.Qty || 0);
    const price = Number(it.UnitPriceSnapshot || it.UnitPrice || 0);
    return `
      <tr>
        <td>
          <strong>${escapeHtml(it.ItemNameSnapshot || it.ItemName)}</strong>
          <div class="small text-muted">${escapeHtml(it.Station || 'Kitchen')} • ${escapeHtml(it.KitchenStatus || it.Status || 'PENDING')}</div>
        </td>
        <td class="text-center fw-bold">${qty}</td>
        <td class="text-end">${curr()}${price.toFixed(2)}</td>
        <td class="text-center">
          <input type="number" class="form-control form-control-sm text-center fw-bold refund-qty-input"
                 data-item-id="${escapeHtml(it.OrderItemID)}"
                 data-unit-price="${price}"
                 data-max-qty="${qty}"
                 min="0" max="${qty}" value="0"
                 oninput="recalcCounterRefundPreview()">
        </td>
        <td class="text-end text-danger fw-bold refund-line-amt">${curr()}0.00</td>
      </tr>`;
  }).join('') : '<tr><td colspan="5" class="text-center text-muted">No items on this order.</td></tr>';

  recalcCounterRefundPreview();
  showModal('counterEditOrderModal');
}

function recalcCounterRefundPreview() {
  const orderId = $('editRefundOrderId')?.value;
  const o = (state.orders || []).find(x => x.OrderID === orderId);
  const currentTotal = o ? Number(o.GrandTotal || 0) : 0;
  let totalRefund = 0;

  document.querySelectorAll('.refund-qty-input').forEach(inp => {
    const maxQty = parseInt(inp.dataset.maxQty, 10) || 0;
    const unitPrice = parseFloat(inp.dataset.unitPrice) || 0;
    let rQty = parseInt(inp.value, 10) || 0;
    if (rQty < 0) { rQty = 0; inp.value = 0; }
    if (rQty > maxQty) { rQty = maxQty; inp.value = maxQty; }
    const lineAmt = rQty * unitPrice;
    totalRefund += lineAmt;
    const cell = inp.closest('tr')?.querySelector('.refund-line-amt');
    if (cell) cell.textContent = `${curr()}${lineAmt.toFixed(2)}`;
  });

  const newTotal = Math.max(0, currentTotal - totalRefund);
  if ($('editRefundAmountPreview')) $('editRefundAmountPreview').textContent = `-${curr()}${totalRefund.toFixed(2)}`;
  if ($('editRefundNewTotalPreview')) $('editRefundNewTotalPreview').textContent = `${curr()}${newTotal.toFixed(2)}`;
}

async function submitCounterItemRefund() {
  if (!isManagerOrAdmin()) return toast('Only Manager or Admin can process refunds.', 'warning');
  const orderId = $('editRefundOrderId').value;
  const reason = ($('editRefundReason').value || '').trim();
  if (!reason) {
    $('editRefundReason').focus();
    return toast('Please enter a reason for the item refund.', 'warning');
  }

  const refunds = [];
  document.querySelectorAll('.refund-qty-input').forEach(inp => {
    const rQty = parseInt(inp.value, 10) || 0;
    if (rQty > 0) {
      refunds.push({ orderItemId: inp.dataset.itemId, refundQty: rQty });
    }
  });

  if (!refunds.length) {
    return toast('Enter a refund quantity (greater than 0) for at least one item.', 'warning');
  }

  if (!confirm('Confirm item refund? This will adjust the order items and totals.')) return;

  try {
    showLoading('Processing item refund…');
    const res = await callServer('refundOrderItems', state.token, { orderId, refunds, reason, fullVoid: false });
    showDone(res.message || 'Item refund processed!', async () => {
      hideModal('counterEditOrderModal');
      await poll(true);
    });
  } catch (err) {
    hideLoading();
    toast(err.message, 'danger');
  }
}

async function submitFullOrderRefund() {
  if (!isManagerOrAdmin()) return toast('Only Manager or Admin can void/refund orders.', 'warning');
  const orderId = $('editRefundOrderId').value;
  const reason = ($('editRefundReason').value || '').trim();
  if (!reason) {
    $('editRefundReason').focus();
    return toast('Please enter a reason for the full order refund.', 'warning');
  }
  if (!confirm('Refund and void the ENTIRE order? The table will be freed immediately.')) return;

  try {
    showLoading('Refunding and voiding order…');
    const res = await callServer('refundOrderItems', state.token, { orderId, refunds: [], reason, fullVoid: true });
    showDone(res.message || 'Order refunded and voided!', async () => {
      hideModal('counterEditOrderModal');
      await poll(true);
    });
  } catch (err) {
    hideLoading();
    toast(err.message, 'danger');
  }
}

function buildKitchenTicketHtml(o) {
  const items = o.items || [];
  const dt = new Date(o.CreatedAt || Date.now());
  return `
    <div style="text-align:center; font-weight:bold; font-size:16px;">*** KITCHEN TICKET ***</div>
    <div style="text-align:center; font-weight:bold; font-size:14px;">${escapeHtml(o.TableNumber ? 'Table: ' + o.TableNumber : 'TAKEOUT')}</div>
    <div style="border-bottom:2px solid #000; margin:6px 0;"></div>
    <div style="display:flex; justify-content:space-between; font-size:12px;"><span>Ticket #: ${escapeHtml(o.OrderNumber)}</span><span>${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
    <div style="display:flex; justify-content:space-between; font-size:12px;"><span>Customer: ${escapeHtml(o.CustomerName || 'Walk-In')}</span><span>${dt.toLocaleDateString()}</span></div>
    <div style="border-bottom:1px dashed #000; margin:6px 0;"></div>
    <div style="margin-top:6px;">${items.map(i => `<div style="display:flex; justify-content:space-between; margin-bottom:4px; font-weight:bold; font-size:14px;"><span>${i.Quantity}x ${escapeHtml(i.ItemNameSnapshot)}</span><span style="font-size:11px; border:1px solid #000; padding:1px 4px;">${escapeHtml(i.Station || 'Kitchen')}</span></div>`).join('')}</div>
    <div style="border-bottom:2px solid #000; margin:6px 0;"></div>
    <div style="text-align:center; font-weight:bold; font-size:11px; margin-top:6px;">Please prepare promptly</div>`;
}
function printKitchenTicket(orderId) {
  const o = (state.orders || []).find(x => x.OrderID === orderId);
  if (!o) return toast('Order not found.', 'warning');
  state.kitchenTicketOrderNum = o.OrderNumber;
  $('kitchenTicketPreviewContent').innerHTML = buildKitchenTicketHtml(o);
  syncPrintModeSelects();
  showModal('kitchenTicketModal');
}
function getPrintMode() { return lsGet('pos_print_mode') === 'standard' ? 'standard' : 'thermal'; }
function setPrintMode(mode) { lsSet('pos_print_mode', mode === 'standard' ? 'standard' : 'thermal'); syncPrintModeSelects(); }
function syncPrintModeSelects() { const m = getPrintMode(); document.querySelectorAll('.print-mode-select').forEach(s => { s.value = m; }); }
function printHtmlDocument(title, bodyHtml) {
  const standard = getPrintMode() === 'standard';
  const win = window.open('', '_blank', standard ? 'width=820,height=900' : 'width=400,height=600');
  if (!win) { toast('Pop-up blocked. Allow pop-ups to print.', 'warning'); return false; }
  const css = standard
    ? `@page { size: A4; margin: 15mm; } body { font-family: Arial, sans-serif; font-size: 13px; max-width: 720px; margin: 0 auto; color: #000; } table { width: 100%; border-collapse: collapse; margin-bottom: 12px; } th, td { border: 1px solid #cbd5e1; padding: 5px 8px; text-align: left; } th { background: #f1f5f9; }`
    : `@page { size: 80mm auto; margin: 0; } body { font-family: 'Courier New', monospace; font-size: 12px; padding: 10px; width: 280px; color: #000; }`;
  win.document.write(`<!DOCTYPE html><html><head><title>${escapeHtml(title)}</title><style>${css}</style></head><body onload="window.print(); window.close();">${bodyHtml}</body></html>`);
  win.document.close();
  return true;
}
function printKitchenTicketNow() {
  const content = $('kitchenTicketPreviewContent');
  if (content) printHtmlDocument('Kitchen Ticket', content.innerHTML);
}

function renderKitchenDisplay() {
  const el = $('kdsGrid');
  if (!el) return;
  const orders = (state.orders || []).filter(o => KDS_STATUSES.includes(o.OrderStatus));
  $('kdsPendingCount').textContent = `${orders.length} Active`;
  const ae = document.activeElement;
  if (ae && ae.tagName === 'INPUT' && el.contains(ae)) return;

  setHtml(el, orders.map(o => {
    const prepVal = state.prepInputs[o.OrderID] !== undefined ? state.prepInputs[o.OrderID] : (o.EstimatedPreparationMinutes || 15);
    const dt = o.CreatedAt ? new Date(o.CreatedAt) : new Date();
    const actionBtn = o.OrderStatus === 'CONFIRMED_BY_COUNTER'
      ? `<button class="btn btn-warning w-100 fw-bold" onclick="kitchenAccept('${o.OrderID}')">Accept Order</button>`
      : o.OrderStatus === 'ACCEPTED_BY_KITCHEN'
      ? `<div class="input-group"><input type="number" id="prep_${o.OrderID}" class="form-control" value="${escapeHtml(prepVal)}" oninput="state.prepInputs['${o.OrderID}'] = this.value"><button class="btn btn-danger" onclick="kitchenStartPrep('${o.OrderID}')">Start Prep</button></div>`
      : `<button class="btn btn-success w-100 fw-bold" onclick="kitchenReady('${o.OrderID}')">Mark Ready</button>`;

    return `<div class="col-12 col-md-4"><div class="card card-pos kds-card ${o.OrderStatus} p-3">
      <div class="d-flex justify-content-between align-items-center mb-1"><h5 class="mb-0 text-primary">${escapeHtml(o.OrderNumber)}</h5><span class="badge bg-dark">${escapeHtml(o.TableNumber || 'Takeout')}</span></div>
      <div class="d-flex justify-content-between text-muted small border-bottom pb-1 mb-2"><span><i class="fa-regular fa-clock me-1 text-warning"></i>${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span>${dt.toLocaleDateString()}</span></div>
      <ul class="list-group mb-2">${(o.items || []).map(i => {
        const tq = Number(i.Quantity || i.Qty || 1);
        const sq = getServedItemQty(i);
        const rem = Math.max(0, tq - sq);
        const remLabel = sq > 0 ? ` <span class="badge bg-warning text-dark">(${rem} left)</span>` : '';
        return `<li class="list-group-item d-flex justify-content-between fw-bold"><span>${tq}× ${escapeHtml(i.ItemNameSnapshot)}${remLabel}</span><span class="badge bg-light text-dark">${escapeHtml(i.Station || '')}</span></li>`;
      }).join('')}</ul>
      ${o.EstimatedCompletionTime ? `<div class="small mb-2 fw-semibold text-danger">ETA: <span class="eta-countdown" data-eta="${o.EstimatedCompletionTime}">${formatEta(o.EstimatedCompletionTime)}</span></div>` : ''}
      ${actionBtn}
    </div></div>`;
  }).join(''));
  updateEtas();
}

async function transition(orderId, action, params, label, loadingMsg, doneMsg) {
  try {
    showLoading(loadingMsg);
    const r = await runAction('transitionOrder', [orderId, action, params || {}], null, label);
    showDone(r.queued ? 'Saved offline — will sync' : doneMsg, () => { if (!r.queued) poll(); });
    return r;
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}
function confirmCounter(orderId) {
  const o = (state.orders || []).find(x => x.OrderID === orderId);
  if (o) openPaymentModal(o.OrderID, Number(o.GrandTotal || 0), Number(o.AmountPaid || 0));
}
async function rejectCounter(orderId) {
  const reason = prompt('Reason for rejection:');
  if (reason !== null) return transition(orderId, 'REJECT_COUNTER', { reason }, 'Reject order', 'Rejecting…', 'Order rejected.');
}

/* ============================================================
   PAYMENT MODAL & HYBRID PAYMENT LOGIC
   ============================================================ */
function openPaymentModal(orderId) {
  const o = (state.orders || []).find(x => x.OrderID === orderId);
  $('payOrderId').value = orderId;
  $('payCustomerName').value = o ? (o.CustomerName || '') : '';
  $('paySeniorPwdToggle').checked = false;
  $('paySeniorPwdIdInput').value = '';
  $('payDiscount').value = 0;
  $('payDiscountReason').value = '';
  $('payReceived').value = '';
  $('payChange').value = '';
  $('payMethod').value = 'Cash';
  if ($('payMethodOther')) {
    $('payMethodOther').value = '';
    $('payMethodOther').classList.add('d-none');
  }
  $('payRef').value = '';

  if ($('payHybridToggle')) $('payHybridToggle').checked = false;
  if ($('payHybridCash')) $('payHybridCash').value = '';
  if ($('payHybridSecondAmt')) $('payHybridSecondAmt').value = '';
  if ($('payHybridMethod')) $('payHybridMethod').value = 'GCash';
  if ($('payHybridMethodOther')) {
    $('payHybridMethodOther').value = '';
    $('payHybridMethodOther').classList.add('d-none');
  }
  if ($('payHybridRef')) $('payHybridRef').value = '';
  toggleHybridPaymentUI();

  $('payDeliveryToggle').checked = false;
  togglePayDeliveryUI();
  togglePaySeniorPwdUI();
  recalcPaymentSummary();
  showModal('paymentModal');
}

function toggleHybridPaymentUI() {
  const isHybrid = $('payHybridToggle')?.checked || false;
  $('singlePaymentFields')?.classList.toggle('d-none', isHybrid);
  $('hybridPaymentFields')?.classList.toggle('d-none', !isHybrid);
  if (isHybrid) {
    if ($('payDeliveryToggle')) $('payDeliveryToggle').checked = false;
    $('payDeliveryFields')?.classList.add('d-none');
    recalcHybridPayment();
  }
}

function onHybridMethodChange() {
  const isOther = $('payHybridMethod')?.value === 'Other';
  const otherEl = $('payHybridMethodOther');
  if (otherEl) {
    otherEl.classList.toggle('d-none', !isOther);
    if (isOther) otherEl.focus();
  }
}

function onHybridAmountInput(source) {
  const due = parseFloat($('payDue')?.value) || 0;
  if (source === 'cash') {
    const cash = Math.max(0, parseFloat($('payHybridCash')?.value) || 0);
    const rem = Math.max(0, due - cash);
    if ($('payHybridSecondAmt')) $('payHybridSecondAmt').value = rem.toFixed(2);
  }
  recalcHybridPayment();
}

function recalcHybridPayment() {
  const due = parseFloat($('payDue')?.value) || 0;
  const cash = Math.max(0, parseFloat($('payHybridCash')?.value) || 0);
  const secondAmt = Math.max(0, parseFloat($('payHybridSecondAmt')?.value) || 0);
  const totalPaid = cash + secondAmt;
  const change = Math.max(0, totalPaid - due);
  if ($('payHybridTotalPaid')) $('payHybridTotalPaid').textContent = `${curr()}${totalPaid.toFixed(2)}`;
  if ($('payHybridChange')) $('payHybridChange').textContent = `${curr()}${change.toFixed(2)}`;
}

function onPaymentMethodChange() {
  const isOther = $('payMethod')?.value === 'Other';
  const otherEl = $('payMethodOther');
  if (otherEl) {
    otherEl.classList.toggle('d-none', !isOther);
    if (isOther) otherEl.focus();
  }
}

function togglePaySeniorPwdUI() {
  const on = $('paySeniorPwdToggle').checked;
  $('paySeniorPwdFields').classList.toggle('d-none', !on);
  $('payManualDiscountGroup').classList.toggle('d-none', on);
  recalcPaymentSummary();
}
function togglePayDeliveryUI() {
  const on = $('payDeliveryToggle').checked;
  if (on && $('payHybridToggle')?.checked) {
    $('payHybridToggle').checked = false;
    toggleHybridPaymentUI();
  }
  $('payDeliveryFields').classList.toggle('d-none', !on);
  $('payMethod').disabled = on;
  const otherEl = $('payMethodOther');
  if (otherEl) {
    if (on) otherEl.classList.add('d-none');
    else onPaymentMethodChange();
  }
  if (on) { onDeliveryPlatformChange(); $('payReceived').value = $('payDue').value; calcChange(); }
}
function onDeliveryPlatformChange() {
  $('payDeliveryOther').classList.toggle('d-none', $('payDeliveryPlatform').value !== 'Others');
}

function recalcPaymentSummary() {
  const o = (state.orders || []).find(x => x.OrderID === $('payOrderId').value);
  const gross = o ? Number(o.Subtotal || 0) : 0;
  const alreadyPaid = o ? Number(o.AmountPaid || 0) : 0;
  const isSenior = $('paySeniorPwdToggle').checked;
  const seniorPct = getSeniorPct();
  $('paySeniorPctLabel').textContent = seniorPct;
  $('paySeniorPctHelp').textContent = seniorPct;

  const pct = isSenior ? seniorPct : Math.min(50, Math.max(0, parseFloat($('payDiscount').value) || 0));
  const t = computeTotals(gross, isSenior, pct);

  $('paySubtotalDisplay').textContent = `${curr()}${gross.toFixed(2)}`;
  $('payLessVatRowDisplay').classList.toggle('d-none', !t.vatExempt);
  $('payLessVatPct').textContent = t.taxPct;
  $('payLessVatDisplay').textContent = `-${curr()}${t.lessVat.toFixed(2)}`;
  $('payDiscountAmtDisplay').textContent = `-${curr()}${t.discount.toFixed(2)}`;
  $('payTaxRowDisplay').classList.toggle('d-none', !t.taxOn);
  $('payTaxDisplay').textContent = `${curr()}${t.tax.toFixed(2)}`;
  $('payServiceRowDisplay').classList.toggle('d-none', !t.srvOn);
  $('payServiceDisplay').textContent = `${curr()}${t.srv.toFixed(2)}`;
  $('payGrandTotalDisplay').textContent = `${curr()}${t.total.toFixed(2)}`;

  const vatInfo = $('payVatInfoDisplay');
  if (t.taxOn) {
    vatInfo.classList.remove('d-none');
    vatInfo.innerHTML = `<div class="d-flex justify-content-between"><span>VATable Sales:</span><span>${curr()}${t.vatableSales.toFixed(2)}</span></div><div class="d-flex justify-content-between"><span>VAT-Exempt Sales:</span><span>${curr()}${t.vatExemptSales.toFixed(2)}</span></div><div class="d-flex justify-content-between"><span>VAT Amount (${t.taxPct}%):</span><span>${curr()}${t.tax.toFixed(2)}</span></div>`;
  } else vatInfo.classList.add('d-none');

  const due = Math.max(0, t.total - alreadyPaid);
  $('payDue').value = due.toFixed(2);
  if ($('payDeliveryToggle').checked) $('payReceived').value = due.toFixed(2);
  calcChange();
  if ($('payHybridToggle')?.checked) recalcHybridPayment();
  return { t, due };
}
function calcChange() {
  const due = parseFloat($('payDue').value) || 0, rec = parseFloat($('payReceived').value) || 0;
  $('payChange').value = Math.max(0, rec - due).toFixed(2);
}

async function submitPayment() {
  if (state.submitting) return;
  const orderId = $('payOrderId').value;
  const isSenior = $('paySeniorPwdToggle').checked;
  const seniorId = $('paySeniorPwdIdInput').value.trim();
  if (isSenior && !seniorId) return toast('Enter the Senior Citizen / PWD ID number.', 'warning');

  const isDelivery = $('payDeliveryToggle').checked;
  const isHybrid = $('payHybridToggle')?.checked || false;
  let deliveryPlatform = '';
  let paymentMethod = '';
  let referenceNumber = '';
  let rec = 0;
  let changeAmount = 0;

  const summary = recalcPaymentSummary();
  const due = parseFloat($('payDue').value) || 0;

  if (isHybrid) {
    const cashAmt = Math.max(0, parseFloat($('payHybridCash')?.value) || 0);
    const secondAmt = Math.max(0, parseFloat($('payHybridSecondAmt')?.value) || 0);
    const secondRaw = $('payHybridMethod')?.value || 'GCash';
    const secondCustom = ($('payHybridMethodOther')?.value || '').trim();
    if (secondRaw === 'Other' && !secondCustom) {
      $('payHybridMethodOther')?.focus();
      return toast('Enter the second payment method name.', 'warning');
    }
    const secondLabel = secondRaw === 'Other' ? secondCustom : secondRaw;
    rec = cashAmt + secondAmt;

    if (rec + 0.001 < due) {
      return toast('Combined Cash + ' + secondLabel + ' payment is less than Amount Due.', 'warning');
    }
    changeAmount = Math.max(0, rec - due);
    paymentMethod = `Hybrid (Cash + ${secondLabel})`;
    const refInput = ($('payHybridRef')?.value || '').trim();
    const splitNote = `Cash: ${cashAmt.toFixed(2)}, ${secondLabel}: ${secondAmt.toFixed(2)}`;
    referenceNumber = refInput ? `${splitNote} | Ref: ${refInput}` : splitNote;
  } else {
    rec = parseFloat($('payReceived').value) || 0;
    if (rec + 0.001 < due) return toast('Amount received is less than Amount Due.', 'warning');
    changeAmount = Math.max(0, rec - due);

    const selectedMethod = $('payMethod').value;
    const customMethod = ($('payMethodOther')?.value || '').trim();
    if (!isDelivery && selectedMethod === 'Other' && !customMethod) {
      $('payMethodOther')?.focus();
      return toast('Please enter the payment method name.', 'warning');
    }

    if (isDelivery) {
      const sel = $('payDeliveryPlatform').value;
      deliveryPlatform = sel === 'Others' ? $('payDeliveryOther').value.trim() : sel;
      if (!deliveryPlatform) return toast('Enter the delivery platform name.', 'warning');
    }

    paymentMethod = isDelivery ? 'Delivery' : (selectedMethod === 'Other' ? customMethod : selectedMethod);
    referenceNumber = $('payRef').value.trim();
  }

  state.submitting = true;
  const payload = {
    orderId,
    customerName: $('payCustomerName').value.trim(),
    isSeniorPwd: isSenior,
    seniorPwdId: isSenior ? seniorId : '',
    discount: isSenior ? getSeniorPct() : (parseFloat($('payDiscount').value) || 0),
    discountReason: isSenior ? '' : $('payDiscountReason').value.trim(),
    deliveryPlatform,
    paymentMethod,
    amountReceived: rec,
    changeAmount,
    referenceNumber,
    computedTotals: summary.t
  };

  try {
    showLoading('Processing payment…');
    const r = await runAction('processPayment', [payload], null, 'Process payment');
    showDone(r.queued ? 'Payment saved offline — will sync' : `Payment complete! Change: ${curr()}${Number(r.res.changeAmount || 0).toFixed(2)}`, () => {
      hideModal('paymentModal'); openReceiptModal(orderId); if (!r.queued) poll();
    });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); } finally { state.submitting = false; }
}

function kitchenAccept(id) { return transition(id, 'ACCEPT_KITCHEN', {}, 'Accept order', 'Accepting…', 'Order accepted!'); }
function kitchenStartPrep(id) {
  const inp = $(`prep_${id}`); const mins = (inp && inp.value) || state.prepInputs[id] || 15; delete state.prepInputs[id];
  return transition(id, 'START_PREP', { prepMinutes: mins }, 'Start prep', 'Starting preparation…', 'Preparation started!');
}
function kitchenReady(id) { return transition(id, 'MARK_READY', {}, 'Mark ready', 'Marking ready…', 'Order marked READY!'); }

/* ============================================================
   ORDER MODAL & BASKET
   ============================================================ */
function openOrderModal() {
  state.cart = [];
  const ts = $('cartTableSelect');
  ts.innerHTML = '<option value="|Takeout">Takeout</option>' + (state.tables || []).map(t => `<option value="${escapeHtml(t.TableID)}|${escapeHtml(t.TableNumber)}">${escapeHtml(t.TableNumber)} (${escapeHtml(t.Status)})</option>`).join('');
  state.activeCategoryFilter = 'ALL';
  $('menuSearch').value = '';
  renderPOSCategoryTabs(); renderPOSMenu(); updateCartDisplay();
  showModal('orderModal');
}

function renderPOSCategoryTabs() {
  const c = $('posCategoryTabs'); if (!c) return;
  const cats = [{ id: 'ALL', name: 'All Items' }].concat((state.categories || []).map(x => ({ id: String(x.CategoryID), name: x.CategoryName })));
  setHtml(c, cats.map(x => `<button type="button" class="btn btn-sm ${state.activeCategoryFilter === x.id ? 'btn-warning fw-bold' : 'btn-outline-secondary'} text-nowrap" onclick="selectPOSCategory('${escapeHtml(x.id)}')">${escapeHtml(x.name)}</button>`).join(''));
}
function selectPOSCategory(id) { state.activeCategoryFilter = id; renderPOSCategoryTabs(); renderPOSMenu(); }
const onMenuSearch = debounce(() => renderPOSMenu(), 120);

function renderPOSMenu() {
  const q = ($('menuSearch')?.value || '').toLowerCase();
  const catFilter = state.activeCategoryFilter || 'ALL';
  const items = (state.menu || []).filter(m =>
    (m.Available === true || String(m.Available).toLowerCase() === 'true') &&
    (catFilter === 'ALL' || String(m.CategoryID) === String(catFilter)) &&
    (!q || String(m.ItemName || '').toLowerCase().includes(q) || String(m.Category || '').toLowerCase().includes(q))
  );
  setHtml($('posMenuGrid'), items.length ? items.map(m => {
    const price = resolveMenuPrice(m);
    const imgSrc = m.ImageURL && String(m.ImageURL).trim() ? escapeHtml(m.ImageURL.trim()) : FOOD_PLACEHOLDER;
    return `<div class="col-6 col-md-4"><div class="card card-pos p-2 h-100 text-center" style="cursor:pointer;" onclick="addToCart('${escapeHtml(m.MenuItemID)}')">
      <img src="${imgSrc}" class="img-fluid rounded mb-2" style="height:80px; object-fit:cover; background:#e2e8f0;" onerror="this.onerror=null;this.src='${FOOD_PLACEHOLDER}'">
      <h6 class="mb-1 small fw-bold">${escapeHtml(m.ItemName)}</h6><span class="text-danger fw-bold">${curr()}${price.toFixed(2)}</span>
    </div></div>`;
  }).join('') : '<div class="col-12 text-center text-muted py-4">No menu items found.</div>');
}

function addToCart(id) {
  const item = state.menuById[id];
  if (!item) return;
  const price = resolveMenuPrice(item);
  const existing = state.cart.find(c => c.menuItemId === id);
  if (existing) existing.quantity++;
  else state.cart.push({ menuItemId: id, itemName: item.ItemName, price, quantity: 1, station: item.Station || 'Kitchen' });
  updateCartDisplay();
}

function updateCartDisplay() {
  const list = $('cartItemsList');
  if (!state.cart.length) { setHtml(list, '<p class="text-muted text-center">Basket is empty</p>'); $('cartSubtotal').textContent = `${curr()}0.00`; return; }
  let sub = 0;
  setHtml(list, state.cart.map((c, idx) => {
    const unitPrice = Number(c.price || 0);
    sub += unitPrice * c.quantity;
    return `<div class="d-flex justify-content-between align-items-center mb-2 border-bottom pb-1">
      <div><strong>${escapeHtml(c.itemName)}</strong><br><small class="text-muted">${curr()}${unitPrice.toFixed(2)} × ${c.quantity}</small></div>
      <div class="btn-group btn-group-sm"><button class="btn btn-outline-secondary" onclick="changeQty(${idx}, -1)">-</button><button class="btn btn-outline-secondary" onclick="changeQty(${idx}, 1)">+</button></div>
    </div>`;
  }).join(''));
  $('cartSubtotal').textContent = `${curr()}${sub.toFixed(2)}`;
}
function changeQty(idx, d) { state.cart[idx].quantity += d; if (state.cart[idx].quantity <= 0) state.cart.splice(idx, 1); updateCartDisplay(); }

async function submitOrder() {
  if (state.submitting) return;
  if (!state.cart.length) return toast('Add items to the basket first.', 'warning');
  state.submitting = true;
  const tv = $('cartTableSelect').value.split('|');
  const subtotal = state.cart.reduce((s, c) => s + Number(c.price || 0) * c.quantity, 0);
  const clientId = uuid();
  const payload = {
    clientId, tableId: tv[0] || '', tableNumber: tv.slice(1).join('|'),
    items: state.cart.map(c => ({ menuItemId: c.menuItemId, itemName: c.itemName, price: Number(c.price || 0), quantity: c.quantity, station: c.station })),
    subtotal
  };
  try {
    showLoading('Submitting order…');
    const r = await runAction('createOrder', [payload], clientId, 'New order');
    const createdOrderId = (r && r.res && r.res.orderId) ? r.res.orderId : clientId;
    showDone(r.queued ? 'Order saved offline — will sync' : `Order ${r.res.orderNumber} placed!`, async () => {
      state.cart = [];
      hideModal('orderModal');
      if (!r.queued) await poll(true);
      openPaymentModal(createdOrderId);
    });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); } finally { state.submitting = false; }
}

/* ============================================================
   VAT & TOTALS COMPUTATION + RECEIPT RENDERING
   ============================================================ */
function computeTotals(gross, isSeniorPwd, manualDiscountPct) {
  const s = state.settings;
  const taxPct = parseFloat(s.TAX_RATE) || 0;
  const srvPct = parseFloat(s.SERVICE_CHARGE_PERCENT) || 0;
  const taxOn = (s.ENABLE_TAX === 'true' || s.ENABLE_TAX === true) && taxPct > 0;
  const srvOn = (s.ENABLE_SERVICE_CHARGE === 'true' || s.ENABLE_SERVICE_CHARGE === true) && srvPct > 0;
  const vatInc = s.VAT_INCLUSIVE !== 'false' && s.VAT_INCLUSIVE !== false;
  const r2 = n => Math.round(n * 100) / 100;

  if (isSeniorPwd) {
    const seniorPct = getSeniorPct();
    const base = (taxOn && vatInc) ? gross / (1 + taxPct / 100) : gross;
    const lessVat = r2(gross - base), discount = r2(base * seniorPct / 100), net = Math.max(0, r2(base - discount));
    const srv = srvOn ? r2(net * srvPct / 100) : 0;
    return { subtotal: r2(gross), vatExempt: true, lessVat, discount, vatableSales: 0, vatExemptSales: net, tax: 0, srv, total: r2(net + srv), taxOn, srvOn, taxPct, srvPct };
  }
  const discount = r2(gross * (manualDiscountPct || 0) / 100), afterDisc = Math.max(0, r2(gross - discount));
  const srv = srvOn ? r2(afterDisc * srvPct / 100) : 0;
  let vatableSales = 0, tax = 0, total = 0;
  if (taxOn) {
    if (vatInc) { vatableSales = r2(afterDisc / (1 + taxPct / 100)); tax = r2(afterDisc - vatableSales); total = r2(afterDisc + srv); }
    else { vatableSales = afterDisc; tax = r2(afterDisc * taxPct / 100); total = r2(afterDisc + tax + srv); }
  } else { total = r2(afterDisc + srv); }
  return { subtotal: r2(gross), vatExempt: false, lessVat: 0, discount, vatableSales, vatExemptSales: 0, tax, srv, total, taxOn, srvOn, taxPct, srvPct };
}

function buildReceiptHtml(data) {
  const o = data.order || {}, items = data.items || [], payments = data.payments || [], s = data.settings || {};
  const c = s.CURRENCY_SYMBOL || '₱', d = o.CreatedAt ? new Date(o.CreatedAt) : new Date();
  const num = v => Number(v || 0), r2 = v => Math.round(num(v) * 100) / 100;
  const row = (l, v, b) => `<div style="display:flex;justify-content:space-between;${b ? 'font-weight:bold;' : ''}"><span>${l}</span><span>${v}</span></div>`;
  const paid = payments.reduce((sum, p) => sum + num(p.AmountPaid), 0);
  const change = payments.reduce((sum, p) => sum + num(p.ChangeAmount), 0);
  const sub = num(o.Subtotal), disc = num(o.Discount), tax = num(o.Tax), srv = num(o.ServiceCharge), total = num(o.GrandTotal);
  const isSenior = o.DiscountType === 'Senior/PWD';
  const taxPct = parseFloat(s.TAX_RATE) || 0, taxOn = (s.ENABLE_TAX === 'true' || s.ENABLE_TAX === true) && taxPct > 0;
  const vatInc = s.VAT_INCLUSIVE !== 'false' && s.VAT_INCLUSIVE !== false;
  const lessVat = o.LessVat !== undefined && o.LessVat !== '' ? num(o.LessVat) : (isSenior && taxOn && vatInc ? r2(sub - sub / (1 + taxPct / 100)) : 0);
  const vatExemptSales = o.VatExemptSales !== undefined && o.VatExemptSales !== '' ? num(o.VatExemptSales) : (isSenior ? r2(sub - lessVat - disc) : 0);
  const vatableSales = o.VatableSales !== undefined && o.VatableSales !== '' ? num(o.VatableSales) : (!isSenior && taxOn ? r2(vatInc ? (sub - disc) / (1 + taxPct / 100) : (sub - disc)) : 0);
  const activeBr = (state.branches || []).find(b => b.BranchID === (o.BranchID || state.activeBranchId));

  return `
    <div style="text-align:center;font-weight:bold;font-size:15px;">${escapeHtml(s.RESTAURANT_NAME || 'Tuna Choice POS')}</div>
    ${activeBr ? `<div style="text-align:center;font-size:11px;">${escapeHtml(activeBr.BranchName)} (${escapeHtml(activeBr.BranchCode)})</div>` : ''}
    ${activeBr?.Address ? `<div style="text-align:center;font-size:10px;">${escapeHtml(activeBr.Address)}</div>` : ''}
    <div style="text-align:center;font-size:11px;">OFFICIAL RECEIPT</div><div style="border-bottom:1px dashed #000;margin:6px 0;"></div>
    <div style="font-size:11px;">
      ${row('Order #:', escapeHtml(o.OrderNumber))} ${row('Date:', `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)}
      ${row('Table:', escapeHtml(o.TableNumber || 'Takeout'))} ${row('Customer:', escapeHtml(o.CustomerName || 'Walk-In'))}
      ${o.SeniorPwdId ? row('SC/PWD ID:', escapeHtml(o.SeniorPwdId)) : ''}
    </div><div style="border-bottom:1px dashed #000;margin:6px 0;"></div>
    <div style="font-size:12px;">${items.map(i => `<div style="margin-bottom:3px;"><div style="font-weight:bold;">${escapeHtml(i.ItemNameSnapshot)}</div>${row(`${i.Quantity} x ${c}${num(i.UnitPriceSnapshot).toFixed(2)}`, `${c}${(i.Quantity * num(i.UnitPriceSnapshot)).toFixed(2)}`)}</div>`).join('')}</div>
    <div style="border-bottom:1px dashed #000;margin:6px 0;"></div>
    <div style="font-size:12px;">
      ${row('Subtotal:', `${c}${sub.toFixed(2)}`)}
      ${lessVat > 0 ? row(`Less: VAT-Exempt (${taxPct}%):`, `-${c}${lessVat.toFixed(2)}`) : ''}
      ${disc > 0 ? row(`Discount${o.DiscountReason ? ' (' + escapeHtml(o.DiscountReason) + ')' : ''}:`, `-${c}${disc.toFixed(2)}`) : ''}
      ${tax > 0 ? row(`Tax (${taxPct}%):`, `${c}${tax.toFixed(2)}`) : ''}
      ${srv > 0 ? row(`Service (${s.SERVICE_CHARGE_PERCENT || 0}%):`, `${c}${srv.toFixed(2)}`) : ''}
      <div style="border-top:1px solid #000;margin-top:4px;padding-top:4px;font-size:14px;">${row('TOTAL:', `${c}${total.toFixed(2)}`, true)}</div>
    </div>
    ${taxOn || isSenior ? `<div style="border-top:1px dashed #000;margin:6px 0;padding-top:4px;font-size:11px;">${row('VATable Sales:', `${c}${vatableSales.toFixed(2)}`)}${row('VAT-Exempt Sales:', `${c}${vatExemptSales.toFixed(2)}`)}${row(`VAT Amount (${taxPct}%):`, `${c}${tax.toFixed(2)}`)}</div>` : ''}
    ${payments.length ? `<div style="border-top:1px dashed #000;margin:6px 0;padding-top:4px;font-size:11px;">${payments.map(p => row('Paid (' + escapeHtml(p.PaymentMethod) + '):', `${c}${num(p.AmountPaid).toFixed(2)}`) + (p.ReferenceNumber ? `<div style="font-size:10px;color:#333;">${escapeHtml(p.ReferenceNumber)}</div>` : '')).join('')}${row('Change:', `${c}${change.toFixed(2)}`, true)}</div>` : ''}
    <div style="text-align:center;font-size:11px;margin-top:10px;">${escapeHtml(s.RECEIPT_FOOTER || 'Thank you!')}</div>`;
}

async function openReceiptModal(orderId) {
  try {
    showLoading('Loading receipt…');
    let data = null;
    if (navigator.onLine) {
      try { data = await callServerT(12000, 'getReceiptData', state.token, orderId); } catch (e) { if (!e.isNetwork) throw e; }
    }
    if (!data) {
      const o = (state.orders || []).find(x => x.OrderID === orderId);
      if (!o) throw new Error('Order not found');
      data = { order: o, items: o.items || [], payments: state.localPayments[orderId] || [], settings: state.settings };
    }
    hideLoading();
    $('receiptPreviewContent').innerHTML = buildReceiptHtml(data);
    syncPrintModeSelects(); showModal('receiptModal');
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}
function printReceipt() { printHtmlDocument('Receipt', $('receiptPreviewContent').innerHTML); }
function printSystemHelpGuide() { const body = document.querySelector('#helpModal .modal-body'); if (body) printHtmlDocument('Tuna Choice POS — Operations Guide', body.innerHTML); }

/* ============================================================
   ADMIN: SETTINGS, MENU, TABLES, CATEGORIES, USERS, REPORTS, EOD
   ============================================================ */
function populateAdminForms() {
  const s = state.settings;
  $('cfgRestaurantName').value = s.RESTAURANT_NAME || 'Tuna Choice POS';
  $('cfgTaxRate').value = s.TAX_RATE || '12';
  $('cfgEnableTax').checked = s.ENABLE_TAX === 'true' || s.ENABLE_TAX === true;
  $('cfgServiceCharge').value = s.SERVICE_CHARGE_PERCENT || '5';
  $('cfgEnableServiceCharge').checked = s.ENABLE_SERVICE_CHARGE === 'true' || s.ENABLE_SERVICE_CHARGE === true;
  $('cfgCurrency').value = s.CURRENCY_SYMBOL || '₱';
  $('cfgTimezone').value = s.TIMEZONE || 'Asia/Manila';
  $('cfgDisableKds').checked = isKdsDisabled();
  $('cfgReceiptFooter').value = s.RECEIPT_FOOTER || '';
  $('cfgSeniorPwdDiscount').value = s.SENIOR_PWD_DISCOUNT_PERCENT || '20';
  $('cfgVatInclusive').checked = s.VAT_INCLUSIVE !== 'false' && s.VAT_INCLUSIVE !== false;

  // Populate Role dropdown: only Admin can assign Admin role
  const roleSel = $('cfgUserRole');
  if (roleSel) {
    const roles = isGlobalAdmin()
      ? ['Waiter', 'Counter', 'Kitchen', 'Manager', 'Admin']
      : ['Waiter', 'Counter', 'Kitchen', 'Manager'];
    roleSel.innerHTML = roles.map(r => `<option value="${r}">${r}</option>`).join('');
  }

  $('cfgMenuCategory').innerHTML = (state.categories || []).map(c => `<option value="${escapeHtml(c.CategoryID)}">${escapeHtml(c.CategoryName)}</option>`).join('');

  const catFilterEl = $('adminMenuCatFilter');
  if (catFilterEl) {
    const prevVal = catFilterEl.value || 'ALL';
    catFilterEl.innerHTML = '<option value="ALL">All Categories</option>' +
      (state.categories || []).map(c => `<option value="${escapeHtml(c.CategoryID)}">${escapeHtml(c.CategoryName)}</option>`).join('');
    catFilterEl.value = prevVal;
  }

  renderAdminMenuTable();

  $('tablesTableBody').innerHTML = (state.tables || []).map(t => `
    <tr>
      <td><strong>${escapeHtml(t.TableNumber)}</strong></td>
      <td>${escapeHtml(t.Capacity)} seats</td>
      <td><span class="badge bg-${t.Status === 'Available' ? 'success' : 'secondary'}">${escapeHtml(t.Status)}</span></td>
      <td class="text-end text-nowrap">
        <button class="btn btn-sm btn-outline-primary fw-bold me-1" onclick="editTable('${escapeHtml(t.TableID)}')">
          <i class="fa-solid fa-pen-to-square me-1"></i>Edit
        </button>
        <button class="btn btn-sm btn-outline-danger fw-bold" onclick="deleteTable('${escapeHtml(t.TableID)}')">
          <i class="fa-solid fa-trash me-1"></i>Delete
        </button>
      </td>
    </tr>`).join('');

  $('categoriesList').innerHTML = (state.categories || []).map(c => `
    <span class="badge bg-secondary me-2 mb-2 p-2 d-inline-flex align-items-center gap-2">
      <span>${escapeHtml(c.CategoryName)}</span>
      <button type="button" class="btn-close btn-close-white" style="font-size:0.65rem;" title="Delete Category" onclick="deleteCategory('${escapeHtml(c.CategoryID)}', '${escapeHtml(c.CategoryName)}')"></button>
    </span>`).join('');

  const brMap = {};
  (state.branches || []).forEach(b => { brMap[b.BranchID] = b.BranchName; });
  $('usersTableBody').innerHTML = (state.users || []).map(u => {
    const isSelf = state.user && String(state.user.userId) === String(u.UserID);
    const isTargetAdmin = u.Role === 'Admin';
    const isPrimaryAdmin = String(u.Username).toLowerCase() === 'admin';
    const canModifyTarget = isGlobalAdmin() || !isTargetAdmin;

    const editBtn = canModifyTarget
      ? `<button class="btn btn-sm btn-outline-primary fw-bold me-1" onclick="editUser('${escapeHtml(u.UserID)}')"><i class="fa-solid fa-pen-to-square me-1"></i>Edit</button>`
      : `<button class="btn btn-sm btn-outline-secondary fw-bold me-1" disabled title="Only Admin can edit Admin accounts"><i class="fa-solid fa-lock me-1"></i>Admin</button>`;

    const deleteDisabled = !canModifyTarget || isSelf || isPrimaryAdmin;
    const deleteTitle = !canModifyTarget
      ? 'Only Admin can delete Admin accounts'
      : (isSelf ? 'Cannot delete your active session user' : (isPrimaryAdmin ? 'Primary admin account is protected' : 'Delete user'));
    const deleteBtn = `<button class="btn btn-sm btn-outline-danger fw-bold" ${deleteDisabled ? `disabled title="${deleteTitle}"` : `onclick="deleteUserById('${escapeHtml(u.UserID)}', '${escapeHtml(u.FullName)}')"`}><i class="fa-solid fa-trash me-1"></i>Delete</button>`;

    return `
    <tr>
      <td><strong>${escapeHtml(u.FullName)}</strong></td>
      <td>${escapeHtml(u.Username)}</td>
      <td class="small">${u.Email ? `<i class="fa-solid fa-envelope text-primary me-1"></i>${escapeHtml(u.Email)}` : '<span class="text-muted">Not set</span>'}</td>
      <td><span class="badge bg-${isTargetAdmin ? 'danger' : 'dark'}">${escapeHtml(u.Role)}</span></td>
      <td><span class="badge bg-light text-dark border">${escapeHtml(u.BranchID ? (brMap[u.BranchID] || u.BranchID) : 'All Branches')}</span></td>
      <td>${u.Active ? '<span class="badge bg-success">Yes</span>' : '<span class="badge bg-secondary">No</span>'}</td>
      <td class="small text-muted">${u.LastLogin ? new Date(u.LastLogin).toLocaleString() : '—'}</td>
      <td class="text-end text-nowrap">
        ${editBtn}
        ${deleteBtn}
      </td>
    </tr>`;
  }).join('');
}

function renderAdminMenuTable() {
  const tbody = $('menuTableBody');
  if (!tbody) return;
  const search = ($('adminMenuSearch')?.value || '').trim().toLowerCase();
  const catFilter = $('adminMenuCatFilter')?.value || 'ALL';

  const filtered = (state.menu || []).filter(m => {
    const matchesCat = catFilter === 'ALL' || String(m.CategoryID) === String(catFilter);
    const matchesSearch = !search ||
      String(m.ItemName || '').toLowerCase().includes(search) ||
      String(m.Category || '').toLowerCase().includes(search) ||
      String(m.Station || '').toLowerCase().includes(search);
    return matchesCat && matchesSearch;
  });

  if ($('adminMenuCountBadge')) {
    $('adminMenuCountBadge').textContent = `${filtered.length} of ${(state.menu || []).length} items`;
  }

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-3">No matching menu items found.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(m => {
    const imgSrc = m.ImageURL && String(m.ImageURL).trim() ? escapeHtml(m.ImageURL.trim()) : FOOD_PLACEHOLDER;
    const isAvail = m.Available === true || String(m.Available).toLowerCase() === 'true';
    const price = resolveMenuPrice(m);
    return `<tr>
      <td><img src="${imgSrc}" class="img-preview-thumb" onerror="this.onerror=null;this.src='${FOOD_PLACEHOLDER}'"></td>
      <td><strong>${escapeHtml(m.ItemName)}</strong></td>
      <td>${escapeHtml(m.Category || '—')}</td>
      <td><strong class="text-primary">${curr()}${price.toFixed(2)}</strong></td>
      <td><span class="badge bg-light text-dark border">${escapeHtml(m.Station || 'Kitchen')}</span></td>
      <td><span class="badge bg-${isAvail ? 'success' : 'secondary'}">${isAvail ? 'Available' : 'Unavailable'}</span></td>
      <td class="text-end text-nowrap">
        <button type="button" class="btn btn-sm btn-outline-primary fw-bold me-1" onclick="editMenuItem('${escapeHtml(m.MenuItemID)}')">
          <i class="fa-solid fa-pen-to-square me-1"></i>Edit
        </button>
        <button type="button" class="btn btn-sm btn-outline-danger fw-bold" onclick="deleteMenuItemById('${escapeHtml(m.MenuItemID)}', '${escapeHtml(m.ItemName)}')">
          <i class="fa-solid fa-trash me-1"></i>Delete
        </button>
      </td>
    </tr>`;
  }).join('');
}

function editTable(tableId) {
  const t = (state.tables || []).find(x => x.TableID === tableId);
  if (!t) return toast('Table not found.', 'warning');
  $('cfgTableId').value = t.TableID;
  $('cfgTableName').value = t.TableNumber;
  $('cfgTableCapacity').value = t.Capacity || 4;
  $('cfgTableFormTitle').textContent = `Edit Table (${t.TableNumber})`;
  $('cfgTableSubmitBtn').innerHTML = '<i class="fa-solid fa-floppy-disk me-1"></i>Update Table';
  $('cfgTableName').focus();
}

function resetTableForm() {
  $('cfgTableId').value = '';
  $('cfgTableName').value = '';
  $('cfgTableCapacity').value = '4';
  $('cfgTableFormTitle').textContent = 'Add / Edit Table';
  $('cfgTableSubmitBtn').innerHTML = '<i class="fa-solid fa-floppy-disk me-1"></i>Save Table';
}

function onToggleDisableKds(cb) {
  if (!cb.checked && !confirm('Enabling Kitchen Display System will send confirmed orders to the Kitchen screen.\n\nProceed?')) cb.checked = true;
}

async function saveSettings(e) {
  e.preventDefault();
  const cfg = {
    RESTAURANT_NAME: $('cfgRestaurantName').value.trim(), TAX_RATE: $('cfgTaxRate').value,
    ENABLE_TAX: $('cfgEnableTax').checked ? 'true' : 'false', SERVICE_CHARGE_PERCENT: $('cfgServiceCharge').value,
    ENABLE_SERVICE_CHARGE: $('cfgEnableServiceCharge').checked ? 'true' : 'false',
    CURRENCY_SYMBOL: $('cfgCurrency').value.trim(), TIMEZONE: $('cfgTimezone').value.trim(),
    DISABLE_KDS: $('cfgDisableKds').checked ? 'true' : 'false',
    RECEIPT_FOOTER: $('cfgReceiptFooter').value.trim(),
    SENIOR_PWD_DISCOUNT_PERCENT: $('cfgSeniorPwdDiscount').value,
    VAT_INCLUSIVE: $('cfgVatInclusive').checked ? 'true' : 'false'
  };
  try { showLoading('Saving settings…'); await callServer('saveSystemSettings', state.token, cfg); showDone('Settings saved!', () => loadBootstrap()); }
  catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

function previewMenuImage(input) {
  const file = input.files && input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = function (ev) {
    const img = new Image();
    img.onload = function () {
      const canvas = document.createElement('canvas'); let w = img.width, h = img.height, max = 300;
      if (w > max || h > max) { if (w > h) { h = Math.round(h * max / w); w = max; } else { w = Math.round(w * max / h); h = max; } }
      canvas.width = w; canvas.height = h; canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const b64 = canvas.toDataURL('image/jpeg', 0.72);
      $('cfgMenuImageUrl').value = b64; $('cfgMenuImagePreview').src = b64;
      $('cfgMenuImagePreview').classList.remove('d-none'); $('cfgMenuNoImgText').classList.add('d-none');
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

function editMenuItem(id) {
  const m = state.menuById[id];
  if (!m) return toast('Menu item not found.', 'warning');
  $('cfgMenuId').value = m.MenuItemID;
  $('cfgMenuName').value = m.ItemName;
  $('cfgMenuCategory').value = m.CategoryID;
  $('cfgMenuPrice').value = resolveMenuPrice(m).toFixed(2);
  $('cfgMenuStation').value = m.Station || 'Kitchen';
  const isAvail = m.Available === true || String(m.Available).toLowerCase() === 'true';
  $('cfgMenuAvailable').value = isAvail ? 'true' : 'false';
  $('cfgMenuImageUrl').value = m.ImageURL || '';
  if (m.ImageURL) {
    $('cfgMenuImagePreview').src = m.ImageURL;
    $('cfgMenuImagePreview').classList.remove('d-none');
    $('cfgMenuNoImgText').classList.add('d-none');
  } else {
    $('cfgMenuImagePreview').classList.add('d-none');
    $('cfgMenuNoImgText').classList.remove('d-none');
  }
  $('cfgMenuFormTitle').textContent = `Edit Menu Item (${m.ItemName})`;
  $('cfgMenuName').focus();
}

function resetMenuForm() {
  $('cfgMenuId').value = ''; $('cfgMenuName').value = ''; $('cfgMenuPrice').value = ''; $('cfgMenuAvailable').value = 'true';
  $('cfgMenuImageUrl').value = ''; $('cfgMenuImageFile').value = ''; $('cfgMenuImagePreview').classList.add('d-none'); $('cfgMenuNoImgText').classList.remove('d-none');
  $('cfgMenuFormTitle').textContent = 'Add / Edit Menu Item';
}

async function saveMenuItem(e) {
  e.preventDefault();
  const item = {
    MenuItemID: $('cfgMenuId').value, ItemName: $('cfgMenuName').value, CategoryID: $('cfgMenuCategory').value,
    Price: $('cfgMenuPrice').value, Station: $('cfgMenuStation').value, Available: $('cfgMenuAvailable').value === 'true', ImageURL: $('cfgMenuImageUrl').value
  };
  try {
    showLoading('Saving menu item…');
    await callServer('saveMenuItem', state.token, item);
    showDone('Menu item saved!', async () => {
      resetMenuForm();
      await loadBootstrap();
    });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

async function deleteMenuItemById(itemId, itemName) {
  if (!confirm(`Delete menu item "${itemName}" from all branches?`)) return;
  try {
    showLoading(`Deleting ${itemName}…`);
    const res = await callServer('deleteMenuItem', state.token, itemId);
    if ($('cfgMenuId').value === itemId) resetMenuForm();
    showDone(res.message || 'Menu item deleted!', async () => {
      await loadBootstrap();
    });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

/* ============================================================
   CSV PARSER & MENU / CATEGORY CSV IMPORT & EXPORT
   ============================================================ */
function parseCsvRows(text) {
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  const clean = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i], next = clean[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { cell += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { cell += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { row.push(cell.trim()); cell = ''; }
      else if (ch === '\r' && next === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; i++; }
      else if (ch === '\n' || ch === '\r') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
      else { cell += ch; }
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows.filter(r => r.some(v => v !== ''));
}

function downloadCsvFile(filename, headers, rows) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [headers.map(esc).join(',')].concat(rows.map(r => r.map(esc).join(','))).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}

function exportMenuCsv() {
  const activeBr = (state.branches || []).find(b => b.BranchID === state.activeBranchId);
  const brCode = activeBr ? activeBr.BranchCode : 'MAIN';
  const headers = ['ItemID', 'ItemName', 'Category', 'Price', 'Station', 'Available', 'ImageURL'];
  const rows = (state.menu || []).map(m => [
    m.MenuItemID || '',
    m.ItemName || '',
    m.Category || '',
    resolveMenuPrice(m).toFixed(2),
    m.Station || 'Kitchen',
    (m.Available === true || String(m.Available).toLowerCase() === 'true') ? 'true' : 'false',
    (m.ImageURL && !String(m.ImageURL).startsWith('data:')) ? m.ImageURL : ''
  ]);
  downloadCsvFile(`menu_items_${brCode}_${todayStr()}.csv`, headers, rows);
  toast(`Downloaded ${rows.length} menu item(s) to CSV.`, 'success');
}

async function importMenuCsv(inputEl) {
  const file = inputEl?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const rows = parseCsvRows(text);
    if (rows.length < 2) {
      inputEl.value = '';
      return toast('CSV file must include a header row and at least one menu item row.', 'warning');
    }

    const headerMap = {};
    rows[0].forEach((h, idx) => { headerMap[h.toLowerCase().replace(/[^a-z0-9]/g, '')] = idx; });

    const nameIdx = headerMap.itemname ?? headerMap.name;
    const priceIdx = headerMap.price;
    if (nameIdx === undefined || priceIdx === undefined) {
      inputEl.value = '';
      return toast('CSV header must contain "ItemName" (or "Name") and "Price" columns.', 'danger');
    }

    const idIdx = headerMap.itemid ?? headerMap.menuitemid ?? headerMap.id;
    const catIdx = headerMap.category ?? headerMap.categoryname;
    const stationIdx = headerMap.station;
    const availIdx = headerMap.available ?? headerMap.status;
    const imgIdx = headerMap.imageurl ?? headerMap.image;

    const dataRows = rows.slice(1);
    if (!confirm(`Import ${dataRows.length} menu row(s) from "${file.name}" into the current branch? Matching item IDs or names will be updated.`)) {
      inputEl.value = '';
      return;
    }

    showLoading(`Importing ${dataRows.length} menu item(s)…`);

    const catByName = {};
    (state.categories || []).forEach(c => { catByName[String(c.CategoryName || '').trim().toLowerCase()] = c; });

    const menuByName = {};
    (state.menu || []).forEach(m => { menuByName[String(m.ItemName || '').trim().toLowerCase()] = m; });

    let imported = 0;
    for (let rIdx = 0; rIdx < dataRows.length; rIdx++) {
      const cols = dataRows[rIdx];
      const rawName = (cols[nameIdx] || '').trim();
      if (!rawName) continue;

      const rawPrice = parseFloat(String(cols[priceIdx] || '0').replace(/[^0-9.-]/g, ''));
      const price = Number.isFinite(rawPrice) && rawPrice >= 0 ? rawPrice : 0;
      const rawCat = catIdx !== undefined ? (cols[catIdx] || '').trim() : '';
      const rawStation = stationIdx !== undefined && cols[stationIdx] ? cols[stationIdx].trim() : 'Kitchen';
      const rawAvail = availIdx !== undefined ? String(cols[availIdx] || 'true').trim().toLowerCase() : 'true';
      const isAvail = !['false', '0', 'no', 'unavailable', 'inactive'].includes(rawAvail);
      const rawImg = imgIdx !== undefined ? (cols[imgIdx] || '').trim() : '';

      let catObj = rawCat ? catByName[rawCat.toLowerCase()] : null;
      if (!catObj && rawCat) {
        const createdCat = await callServer('saveCategory', state.token, { CategoryName: rawCat, Description: '' });
        catObj = { CategoryID: createdCat.CategoryID, CategoryName: rawCat };
        catByName[rawCat.toLowerCase()] = catObj;
        state.categories.push(catObj);
      } else if (!catObj) {
        catObj = (state.categories || [])[0];
        if (!catObj) {
          const createdCat = await callServer('saveCategory', state.token, { CategoryName: 'General', Description: '' });
          catObj = { CategoryID: createdCat.CategoryID, CategoryName: 'General' };
          catByName['general'] = catObj;
          state.categories.push(catObj);
        }
      }

      const csvId = idIdx !== undefined ? (cols[idIdx] || '').trim() : '';
      const existingById = csvId ? state.menuById[csvId] : null;
      const existingByName = menuByName[rawName.toLowerCase()];
      const targetId = existingById ? existingById.MenuItemID : (existingByName ? existingByName.MenuItemID : '');
      const preservedImg = rawImg || (existingById?.ImageURL || existingByName?.ImageURL || '');

      await callServer('saveMenuItem', state.token, {
        MenuItemID: targetId,
        ItemName: rawName,
        CategoryID: catObj.CategoryID,
        Price: price.toFixed(2),
        Station: rawStation || 'Kitchen',
        Available: isAvail,
        ImageURL: preservedImg
      });
      imported++;
    }

    inputEl.value = '';
    showDone(`Imported ${imported} menu item(s)!`, async () => {
      await loadBootstrap();
    });
  } catch (err) {
    hideLoading();
    if (inputEl) inputEl.value = '';
    toast(err.message || 'Failed to import menu CSV.', 'danger');
  }
}

function exportCategoryCsv() {
  const headers = ['CategoryID', 'CategoryName', 'Description', 'SortOrder'];
  const rows = (state.categories || []).map((c, idx) => [
    c.CategoryID || '',
    c.CategoryName || '',
    c.Description || '',
    c.SortOrder ?? (idx + 1)
  ]);
  downloadCsvFile(`menu_categories_${todayStr()}.csv`, headers, rows);
  toast(`Downloaded ${rows.length} category row(s) to CSV.`, 'success');
}

async function importCategoryCsv(inputEl) {
  const file = inputEl?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const rows = parseCsvRows(text);
    if (rows.length < 2) {
      inputEl.value = '';
      return toast('CSV file must include a header row and at least one category row.', 'warning');
    }

    const headerMap = {};
    rows[0].forEach((h, idx) => { headerMap[h.toLowerCase().replace(/[^a-z0-9]/g, '')] = idx; });

    const nameIdx = headerMap.categoryname ?? headerMap.name ?? headerMap.category;
    if (nameIdx === undefined) {
      inputEl.value = '';
      return toast('CSV header must contain a "CategoryName" (or "Name") column.', 'danger');
    }

    const idIdx = headerMap.categoryid ?? headerMap.id;
    const descIdx = headerMap.description ?? headerMap.desc;
    const sortIdx = headerMap.sortorder ?? headerMap.sort ?? headerMap.order;

    const dataRows = rows.slice(1);
    if (!confirm(`Import ${dataRows.length} category row(s) from "${file.name}"? Matching categories will be updated.`)) {
      inputEl.value = '';
      return;
    }

    showLoading(`Importing ${dataRows.length} category row(s)…`);

    const catById = {};
    const catByName = {};
    (state.categories || []).forEach(c => {
      catById[String(c.CategoryID)] = c;
      catByName[String(c.CategoryName || '').trim().toLowerCase()] = c;
    });

    let imported = 0;
    for (let i = 0; i < dataRows.length; i++) {
      const cols = dataRows[i];
      const name = (cols[nameIdx] || '').trim();
      if (!name) continue;

      const csvId = idIdx !== undefined ? (cols[idIdx] || '').trim() : '';
      const desc = descIdx !== undefined ? (cols[descIdx] || '').trim() : '';
      const rawSort = sortIdx !== undefined ? parseInt(cols[sortIdx], 10) : NaN;

      const existing = (csvId && catById[csvId]) || catByName[name.toLowerCase()];
      const targetId = existing ? existing.CategoryID : '';
      const sortOrder = !isNaN(rawSort) ? rawSort : (existing?.SortOrder ?? ((state.categories.length || 0) + imported + 1));

      await callServer('saveCategory', state.token, {
        CategoryID: targetId,
        CategoryName: name,
        Description: desc || (existing?.Description || ''),
        SortOrder: sortOrder
      });
      imported++;
    }

    inputEl.value = '';
    showDone(`Imported ${imported} category row(s)!`, async () => {
      await loadBootstrap();
    });
  } catch (err) {
    hideLoading();
    if (inputEl) inputEl.value = '';
    toast(err.message || 'Failed to import category CSV.', 'danger');
  }
}

async function saveTable(e) {
  e.preventDefault();
  const tableId = $('cfgTableId').value;
  try {
    showLoading(tableId ? 'Updating table…' : 'Saving table…');
    await callServer('saveTable', state.token, {
      TableID: tableId || null,
      TableNumber: $('cfgTableName').value,
      Capacity: $('cfgTableCapacity').value
    });
    showDone(tableId ? 'Table updated!' : 'Table saved!', () => {
      resetTableForm();
      loadBootstrap();
    });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

async function deleteTable(tableId) {
  const t = (state.tables || []).find(x => x.TableID === tableId);
  if (t && t.Status !== 'Available') {
    return toast(`Cannot delete ${t.TableNumber} while status is "${t.Status}". Free/clean it first.`, 'warning');
  }
  if (!confirm(`Delete ${t ? t.TableNumber : 'this table'}?`)) return;
  try {
    showLoading('Deleting table…');
    const r = await callServer('deleteTable', state.token, tableId);
    if ($('cfgTableId').value === tableId) resetTableForm();
    showDone(r.message || 'Table deleted', () => loadBootstrap());
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

async function saveCategory(e) {
  e.preventDefault();
  try { showLoading('Saving category…'); await callServer('saveCategory', state.token, { CategoryName: $('cfgCatName').value, Description: $('cfgCatDesc').value }); showDone('Category saved!', () => { $('cfgCatName').value = ''; $('cfgCatDesc').value = ''; loadBootstrap(); }); }
  catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

async function deleteCategory(catId, catName) {
  if (!confirm(`Delete category "${catName}"?`)) return;
  try {
    showLoading(`Deleting ${catName}…`);
    const res = await callServer('deleteCategory', state.token, catId);
    showDone(res.message || 'Category deleted!', () => loadBootstrap());
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

function editUser(id) {
  const u = (state.users || []).find(x => String(x.UserID) === String(id));
  if (!u) return toast('User not found.', 'warning');
  if (!isGlobalAdmin() && u.Role === 'Admin') {
    return toast('Only Admin users can edit Admin accounts.', 'warning');
  }
  $('cfgUserId').value = u.UserID;
  $('cfgUserFullName').value = u.FullName;
  $('cfgUserUsername').value = u.Username;
  $('cfgUserEmail').value = u.Email || '';
  $('cfgUserPassword').value = '';
  $('cfgUserPassword').placeholder = 'Leave blank to keep password';
  $('cfgUserRole').value = u.Role;
  $('cfgUserBranch').value = u.BranchID || '';
  $('cfgUserFormTitle').textContent = `Edit User (${u.FullName})`;
  $('cfgUserFullName').focus();
}

function resetUserForm() {
  $('cfgUserId').value = '';
  $('cfgUserFullName').value = '';
  $('cfgUserUsername').value = '';
  $('cfgUserEmail').value = '';
  $('cfgUserPassword').value = '';
  $('cfgUserPassword').placeholder = 'Password';
  $('cfgUserFormTitle').textContent = 'Add / Edit User';
}

async function saveUser(e) {
  e.preventDefault();
  const isNew = !$('cfgUserId').value;
  if (isNew && !$('cfgUserPassword').value) return toast('Password is required for a new user.', 'warning');
  try {
    showLoading('Saving user…');
    await callServer('saveUser', state.token, {
      UserID: $('cfgUserId').value || null,
      FullName: $('cfgUserFullName').value,
      Username: $('cfgUserUsername').value,
      Email: $('cfgUserEmail').value.trim(),
      Password: $('cfgUserPassword').value,
      Role: $('cfgUserRole').value,
      BranchID: $('cfgUserBranch').value || null
    });
    showDone('User saved!', () => {
      resetUserForm();
      loadBootstrap();
    });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

async function deleteUserById(userId, fullName) {
  if (!confirm(`Delete user "${fullName}"? This will revoke their login access immediately.`)) return;
  try {
    showLoading(`Deleting ${fullName}…`);
    const res = await callServer('deleteUser', state.token, userId);
    if (String($('cfgUserId').value) === String(userId)) resetUserForm();
    showDone(res.message || 'User deleted!', () => loadBootstrap());
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

function openChangePasswordModal() { $('cpOldPw').value = ''; $('cpNewPw').value = ''; $('cpNewPw2').value = ''; showModal('changePwModal'); }
async function submitChangePassword() {
  const oldPw = $('cpOldPw').value, newPw = $('cpNewPw').value;
  if (newPw.length < 6) return toast('New password must be at least 6 characters.', 'warning');
  if (newPw !== $('cpNewPw2').value) return toast('New passwords do not match.', 'warning');
  try { showLoading('Updating password…'); await callServer('changePassword', state.token, oldPw, newPw); showDone('Password updated!', () => hideModal('changePwModal')); }
  catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

async function loadAdminStats() {
  try {
    const s = await callServer('getSalesReport', state.token, { summaryOnly: true, allBranches: false });
    $('statSales').textContent = `${curr()}${Number(s.totalSales || 0).toFixed(2)}`;
    $('statOrders').textContent = s.totalOrders || 0;
    $('statAvg').textContent = `${curr()}${Number(s.averageOrderValue || 0).toFixed(2)}`;
    $('statTax').textContent = `${curr()}${Number(s.totalTax || 0).toFixed(2)}`;
  } catch (err) {}
}

async function loadActivityLogs() {
  if (!isGlobalAdmin()) {
    if ($('logsTableBody')) $('logsTableBody').innerHTML = '';
    return;
  }
  try {
    const logs = await callServer('getActivityLog', state.token);
    const userMap = {};
    (state.users || []).forEach(u => { userMap[u.UserID] = u.FullName; });
    $('logsTableBody').innerHTML = (logs || []).map(l => `<tr><td><small>${new Date(l.Timestamp).toLocaleString()}</small></td><td>${escapeHtml(userMap[l.UserID] || l.UserID || 'System')}</td><td><span class="badge bg-info text-dark">${escapeHtml(l.Action)}</span></td><td>${escapeHtml(l.EntityType)}</td><td><small>${escapeHtml(l.NewValue)}</small></td></tr>`).join('');
  } catch (err) { toast(err.message, 'danger'); }
}

function setReportRange(preset) {
  const t = todayStr(), d = new Date(t + 'T12:00:00');
  const iso = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  if (preset === 'today') { $('reportStart').value = t; $('reportEnd').value = t; }
  else if (preset === '7d') { d.setDate(d.getDate() - 6); $('reportStart').value = iso(d); $('reportEnd').value = t; }
  else if (preset === 'month') { $('reportStart').value = t.slice(0, 8) + '01'; $('reportEnd').value = t; }
  else if (preset === 'all') { $('reportStart').value = ''; $('reportEnd').value = ''; }
  loadSalesReport();
}

async function loadSalesReport() {
  try {
    showLoading('Generating report…');
    // Only Admin can select All Branches; non-Admin is strictly restricted to their assigned branch
    const allBranches = isGlobalAdmin() && ($('reportBranchScope')?.value === 'ALL');
    const r = await callServer('getSalesReport', state.token, {
      startDate: $('reportStart').value,
      endDate: $('reportEnd').value,
      allBranches
    });
    hideLoading(); window._lastSalesReport = r;
    const c = r.currency || curr();
    const activeBr = (state.branches || []).find(b => b.BranchID === state.activeBranchId);
    if ($('reportScopeBadge')) {
      $('reportScopeBadge').textContent = allBranches ? 'All Branches (Consolidated)' : (activeBr ? `${activeBr.BranchName} (${activeBr.BranchCode})` : 'Current Branch');
    }

    $('reportSummary').innerHTML = `
      <div class="row g-2">
        <div class="col-6 col-md-2"><div class="card p-2 text-center border-primary"><small class="text-muted">Paid Orders</small><h5>${r.counts.paid}</h5></div></div>
        <div class="col-6 col-md-2"><div class="card p-2 text-center border-success"><small class="text-muted">Total Sales</small><h5 class="text-success">${c}${Number(r.totals.sales || 0).toFixed(2)}</h5></div></div>
        <div class="col-6 col-md-2"><div class="card p-2 text-center border-warning"><small class="text-muted">Avg Order</small><h5>${c}${Number(r.averageOrderValue || 0).toFixed(2)}</h5></div></div>
        <div class="col-6 col-md-2"><div class="card p-2 text-center border-info"><small class="text-muted">Items Sold</small><h5>${r.totals.items}</h5></div></div>
        <div class="col-6 col-md-2"><div class="card p-2 text-center"><small class="text-muted">Discounts / Tax</small><h6>-${c}${Number(r.totals.discount || 0).toFixed(2)} / ${c}${Number(r.totals.tax || 0).toFixed(2)}</h6></div></div>
        <div class="col-6 col-md-2"><div class="card p-2 text-center border-danger"><small class="text-muted">Refunds / Voids (${r.counts.refunds || 0})</small><h6 class="text-danger">${c}${Number(r.totals.refunded || 0).toFixed(2)}</h6></div></div>
      </div>`;

    const brList = r.branchBreakdown || [];
    $('reportBranchComparison').innerHTML = (allBranches && brList.length) ? `
      <h6 class="mt-2 fw-bold text-primary"><i class="fa-solid fa-store me-1"></i>Sales by Branch</h6>
      <div class="table-responsive"><table class="table table-sm table-bordered">
        <thead class="table-light"><tr><th>Branch</th><th class="text-end">Orders</th><th class="text-end">Avg Order</th><th class="text-end">Discounts</th><th class="text-end">Tax</th><th class="text-end">Total Sales</th><th class="text-end">Share</th></tr></thead>
        <tbody>${brList.map(b => `<tr><td><strong>${escapeHtml(b.branchName)}</strong></td><td class="text-end">${b.orders}</td><td class="text-end">${c}${b.avgOrder.toFixed(2)}</td><td class="text-end">-${c}${b.discount.toFixed(2)}</td><td class="text-end">${c}${b.tax.toFixed(2)}</td><td class="text-end text-success fw-bold">${c}${b.sales.toFixed(2)}</td><td class="text-end">${b.share}%</td></tr>`).join('')}</tbody>
      </table></div>` : '';

    const pmList = r.paymentBreakdown || [];
    $('reportPaymentMethods').innerHTML = pmList.length ? `
      <h6 class="mt-2 fw-bold text-secondary"><i class="fa-solid fa-wallet me-1"></i>Payment Method Breakdown</h6>
      <div class="table-responsive"><table class="table table-sm table-bordered">
        <thead class="table-light"><tr><th>Payment Method</th><th class="text-end">Orders</th><th class="text-end">Total Sales</th><th class="text-end">Share</th></tr></thead>
        <tbody>${pmList.map(p => `<tr><td><strong>${escapeHtml(p.method)}</strong></td><td class="text-end">${p.orders}</td><td class="text-end fw-bold">${c}${p.sales.toFixed(2)}</td><td class="text-end">${p.share}%</td></tr>`).join('')}</tbody>
      </table></div>` : '';

    $('reportTopItems').innerHTML = r.topItems.length
      ? `<div class="table-responsive"><table class="table table-sm table-bordered"><thead><tr><th>#</th><th>Item</th><th class="text-end">Qty</th><th class="text-end">Avg Price</th><th class="text-end">Sales</th><th class="text-end">Share</th></tr></thead><tbody>${r.topItems.map((i, idx) => `<tr><td>${idx + 1}</td><td>${escapeHtml(i.name)}</td><td class="text-end">${i.quantity}</td><td class="text-end">${c}${i.avgPrice.toFixed(2)}</td><td class="text-end">${c}${i.sales.toFixed(2)}</td><td class="text-end">${i.share}%</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="text-muted small">No items sold in this period.</p>';

    $('reportDaily').innerHTML = r.daily.length
      ? `<div class="table-responsive"><table class="table table-sm table-bordered"><thead><tr><th>Date</th><th class="text-end">Orders</th><th class="text-end">Subtotal</th><th class="text-end">Discount</th><th class="text-end">Tax</th><th class="text-end">Service</th><th class="text-end">Sales</th></tr></thead><tbody>${r.daily.map(d => `<tr><td>${escapeHtml(d.date)}</td><td class="text-end">${d.orders}</td><td class="text-end">${c}${d.subtotal.toFixed(2)}</td><td class="text-end">-${c}${d.discount.toFixed(2)}</td><td class="text-end">${c}${d.tax.toFixed(2)}</td><td class="text-end">${c}${d.service.toFixed(2)}</td><td class="text-end"><strong>${c}${d.sales.toFixed(2)}</strong></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="text-muted small">No paid orders in this period.</p>';

    $('reportOrders').innerHTML = r.orders.length
      ? `<div class="table-responsive" style="max-height:360px;"><table class="table table-sm table-bordered"><thead><tr><th>Date</th><th>Time</th>${allBranches ? '<th>Branch</th>' : ''}<th>Order #</th><th>Table</th><th>Customer</th><th>Method</th><th class="text-end">Items</th><th class="text-end">Total</th></tr></thead><tbody>${r.orders.map(o => `<tr><td>${escapeHtml(o.date)}</td><td>${escapeHtml(o.time)}</td>${allBranches ? `<td><span class="badge bg-light text-dark border">${escapeHtml(o.branch)}</span></td>` : ''}<td>${escapeHtml(o.orderNumber)}</td><td>${escapeHtml(o.table)}</td><td>${escapeHtml(o.customer)}</td><td>${escapeHtml(o.method)}</td><td class="text-end">${o.itemQty}</td><td class="text-end"><strong>${c}${o.total.toFixed(2)}</strong></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="text-muted small">No orders to list.</p>';

    const refList = r.refunds || [];
    $('reportRefunds').innerHTML = refList.length
      ? `<div class="table-responsive" style="max-height:300px;"><table class="table table-sm table-bordered border-danger">
          <thead class="table-danger"><tr><th>Date / Time</th>${allBranches ? '<th>Branch</th>' : ''}<th>Order #</th><th>Table</th><th>Action</th><th class="text-end">Amount</th><th>Reason / Items</th><th>Processed By</th></tr></thead>
          <tbody>${refList.map(rf => `<tr>
            <td class="small">${escapeHtml(rf.dateTime)}</td>
            ${allBranches ? `<td><span class="badge bg-light text-dark border">${escapeHtml(rf.branch)}</span></td>` : ''}
            <td><strong>${escapeHtml(rf.orderNumber)}</strong></td>
            <td>${escapeHtml(rf.table)}</td>
            <td><span class="badge bg-danger">${escapeHtml(rf.action)}</span></td>
            <td class="text-end text-danger fw-bold">${c}${Number(rf.amount || 0).toFixed(2)}</td>
            <td class="small">${escapeHtml(rf.details)}</td>
            <td class="small">${escapeHtml(rf.staff)}</td>
          </tr>`).join('')}</tbody>
        </table></div>`
      : '<p class="text-muted small">No order edits, item refunds, or voids recorded in this period.</p>';
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

function exportSalesReportCsv() {
  const r = window._lastSalesReport; if (!r) return toast('Generate a report first.', 'warning');
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Sales Report', `${r.range.start || 'All'} to ${r.range.end || 'All'}`].map(esc).join(','),
    ['Paid Orders', r.counts.paid, 'Total Sales', r.totals.sales.toFixed(2), 'Average Order', r.averageOrderValue.toFixed(2), 'Refunded/Voided', Number(r.totals.refunded || 0).toFixed(2)].map(esc).join(','), '',
    ['Branch', 'Orders', 'Avg Order', 'Discounts', 'Tax', 'Total Sales', 'Share %'].map(esc).join(',')];
  (r.branchBreakdown || []).forEach(b => lines.push([b.branchName, b.orders, b.avgOrder.toFixed(2), b.discount.toFixed(2), b.tax.toFixed(2), b.sales.toFixed(2), b.share].map(esc).join(',')));
  lines.push('', ['Item', 'Quantity', 'Avg Price', 'Sales', 'Share %'].map(esc).join(','));
  r.topItems.forEach(i => lines.push([i.name, i.quantity, i.avgPrice.toFixed(2), i.sales.toFixed(2), i.share].map(esc).join(',')));
  lines.push('', ['Date', 'Time', 'Branch', 'Order #', 'Table', 'Customer', 'Method', 'Items', 'Subtotal', 'Discount', 'Tax', 'Service', 'Total'].map(esc).join(','));
  r.orders.forEach(o => lines.push([o.date, o.time, o.branch, o.orderNumber, o.table, o.customer, o.method, o.itemQty, o.subtotal.toFixed(2), o.discount.toFixed(2), o.tax.toFixed(2), o.service.toFixed(2), o.total.toFixed(2)].map(esc).join(',')));
  lines.push('', ['Edit Order / Item Refunds & Voids Log'].map(esc).join(','), ['Date/Time', 'Branch', 'Order #', 'Table', 'Action', 'Amount', 'Details', 'Processed By'].map(esc).join(','));
  (r.refunds || []).forEach(rf => lines.push([rf.dateTime, rf.branch, rf.orderNumber, rf.table, rf.action, Number(rf.amount || 0).toFixed(2), rf.details, rf.staff].map(esc).join(',')));
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `sales_report_${r.range.start || 'all'}_${r.range.end || 'all'}.csv`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}

function buildSalesReportPrintHtml(r) {
  const c = r.currency || curr();
  const s = state.settings || {};
  const brList = r.branchBreakdown || [];
  const pmList = r.paymentBreakdown || [];
  const refList = r.refunds || [];
  return `
    <div style="text-align:center;font-weight:bold;font-size:15px;">${escapeHtml(s.RESTAURANT_NAME || 'Tuna Choice POS')}</div>
    <div style="text-align:center;font-weight:bold;font-size:12px;">SALES REPORT (${r.allBranches ? 'ALL BRANCHES' : 'CURRENT BRANCH'})</div>
    <div style="text-align:center;font-size:11px;">Period: ${escapeHtml(r.range.start || 'Beginning')} to ${escapeHtml(r.range.end || 'Present')}</div>
    <div style="border-bottom:1px dashed #000;margin:6px 0;"></div>
    <div style="font-size:11px;">
      <div style="display:flex;justify-content:space-between;"><span>Paid Orders:</span><strong>${r.counts.paid}</strong></div>
      <div style="display:flex;justify-content:space-between;"><span>Items Sold:</span><strong>${r.totals.items}</strong></div>
      <div style="display:flex;justify-content:space-between;"><span>Subtotal:</span><span>${c}${Number(r.totals.subtotal || 0).toFixed(2)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span>Discounts:</span><span>-${c}${Number(r.totals.discount || 0).toFixed(2)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span>Tax Collected:</span><span>${c}${Number(r.totals.tax || 0).toFixed(2)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span>Refunds / Voids (${r.counts.refunds || 0}):</span><span>${c}${Number(r.totals.refunded || 0).toFixed(2)}</span></div>
      <div style="display:flex;justify-content:space-between;font-weight:bold;font-size:13px;border-top:1px solid #000;padding-top:3px;margin-top:3px;"><span>NET TOTAL SALES:</span><span>${c}${Number(r.totals.sales || 0).toFixed(2)}</span></div>
    </div>
    ${(r.allBranches && brList.length) ? `<div style="border-bottom:1px dashed #000;margin:6px 0;"></div><div style="font-weight:bold;font-size:11px;">SALES BY BRANCH</div>${brList.map(b => `<div style="display:flex;justify-content:space-between;font-size:11px;"><span>${escapeHtml(b.branchName)} (${b.orders})</span><span>${c}${b.sales.toFixed(2)}</span></div>`).join('')}` : ''}
    ${pmList.length ? `<div style="border-bottom:1px dashed #000;margin:6px 0;"></div><div style="font-weight:bold;font-size:11px;">PAYMENT METHODS</div>${pmList.map(p => `<div style="display:flex;justify-content:space-between;font-size:11px;"><span>${escapeHtml(p.method)} (${p.orders})</span><span>${c}${p.sales.toFixed(2)}</span></div>`).join('')}` : ''}
    ${r.topItems.length ? `<div style="border-bottom:1px dashed #000;margin:6px 0;"></div><div style="font-weight:bold;font-size:11px;">TOP SELLING ITEMS</div>${r.topItems.slice(0, 20).map(i => `<div style="display:flex;justify-content:space-between;font-size:11px;"><span>${i.quantity}x ${escapeHtml(i.name)}</span><span>${c}${i.sales.toFixed(2)}</span></div>`).join('')}` : ''}
    ${refList.length ? `<div style="border-bottom:1px dashed #000;margin:6px 0;"></div><div style="font-weight:bold;font-size:11px;">REFUNDS &amp; VOIDS (${refList.length})</div>${refList.map(rf => `<div style="font-size:10px;margin-bottom:3px;"><div style="display:flex;justify-content:space-between;"><strong>${escapeHtml(rf.orderNumber)} (${escapeHtml(rf.action)})</strong><span>${c}${Number(rf.amount || 0).toFixed(2)}</span></div><div>${escapeHtml(rf.details)}</div></div>`).join('')}` : ''}
    <div style="border-bottom:1px dashed #000;margin:6px 0;"></div>
    <div style="text-align:center;font-size:10px;">Generated: ${new Date().toLocaleString()}</div>`;
}

function printSalesReport() {
  const r = window._lastSalesReport;
  if (!r) return toast('Generate a sales report first.', 'warning');
  printHtmlDocument(`Sales Report (${r.range.start || 'All'} - ${r.range.end || 'All'})`, buildSalesReportPrintHtml(r));
}

/* ============================================================
   END OF DAY Z-READING (WITH FULL TRANSACTION & REFUND LOGS)
   ============================================================ */
function buildEodZReadingHtml(r) {
  const c = r.currency || curr();
  const row = (l, v, b) => `<div style="display:flex;justify-content:space-between;${b ? 'font-weight:bold;' : ''}"><span>${l}</span><span>${v}</span></div>`;
  const cd = r.cashDrawer || {
    openingFloat: 0,
    cashSales: 0,
    cashTendered: 0,
    changeGiven: r.totalChange || 0,
    expectedCash: 0,
    actualCash: null,
    variance: null
  };

  let varianceBlock = '';
  if (cd.actualCash !== null && cd.actualCash !== undefined) {
    const v = Number(cd.variance || 0);
    const label = Math.abs(v) < 0.005 ? 'BALANCED (EXACT)' : (v > 0 ? 'CASH OVER (+)' : 'CASH SHORT (-)');
    const color = Math.abs(v) < 0.005 ? '#15803d' : (v > 0 ? '#1d4ed8' : '#b91c1c');
    const sign = v > 0 ? '+' : (v < 0 ? '-' : '');
    varianceBlock = `
      ${row('Actual Cash Counted:', `${c}${Number(cd.actualCash).toFixed(2)}`, true)}
      <div style="display:flex;justify-content:space-between;font-weight:bold;color:${color};margin-top:2px;">
        <span>${label}:</span>
        <span>${sign}${c}${Math.abs(v).toFixed(2)}</span>
      </div>`;
  } else {
    varianceBlock = `<div style="font-size:10px;color:#555;font-style:italic;">Actual cash counted not entered.</div>`;
  }

  const refLogs = r.refundLogs || [];
  const txLogs = r.transactionLogs || [];
  const actEvents = r.activityEvents || [];

  return `
    <div style="text-align:center;font-weight:bold;font-size:15px;">${escapeHtml(r.restaurantName || 'Tuna Choice POS')}</div>
    <div style="text-align:center;font-size:11px;font-weight:bold;">${escapeHtml(r.branchName || 'Main Branch')}</div>
    ${r.branchAddress ? `<div style="text-align:center;font-size:10px;">${escapeHtml(r.branchAddress)}</div>` : ''}
    <div style="text-align:center;font-weight:bold;font-size:13px;margin-top:4px;">*** Z-READING REPORT ***</div>
    <div style="border-bottom:1px dashed #000;margin:6px 0;"></div>
    <div style="font-size:11px;">
      ${row('Z-Report #:', escapeHtml(r.reportNo || 'Z-0000'))}
      ${row('Business Date:', escapeHtml(r.date))}
      ${row('Printed At:', escapeHtml(r.printedAt || new Date().toLocaleString()))}
      ${row('Cashier / Admin:', escapeHtml(r.generatedBy || 'Admin'))}
    </div>
    <div style="border-bottom:1px dashed #000;margin:6px 0;"></div>
    <div style="font-size:11px;font-weight:bold;margin-bottom:3px;">TRANSACTION COUNTS</div>
    <div style="font-size:11px;">
      ${row('Paid Orders:', r.counts.paid)}
      ${row('Cancelled / Voided:', r.counts.cancelled)}
      ${row('Refund / Edit Events:', r.counts.refunds || 0)}
      ${row('Unpaid / Open Orders:', r.counts.open)}
      ${row('Total Items Sold:', r.counts.itemsQty || 0)}
    </div>
    <div style="border-bottom:1px dashed #000;margin:6px 0;"></div>
    <div style="font-size:11px;font-weight:bold;margin-bottom:3px;">SALES &amp; VAT BREAKDOWN</div>
    <div style="font-size:11px;">
      ${row('Gross Sales (Subtotal):', `${c}${Number(r.totals.subtotal || 0).toFixed(2)}`)}
      ${row('Less: VAT-Exempt:', `-${c}${Number(r.totals.lessVat || 0).toFixed(2)}`)}
      ${row('Discounts (SC/PWD/Promo):', `-${c}${Number(r.totals.discount || 0).toFixed(2)}`)}
      ${row('Refunds / Voids Total:', `${c}${Number(r.totals.refunded || 0).toFixed(2)}`)}
      ${row('Service Charge:', `${c}${Number(r.totals.serviceCharge || 0).toFixed(2)}`)}
      <div style="border-top:1px solid #000;margin:4px 0;padding-top:4px;font-size:13px;">
        ${row('NET TOTAL SALES:', `${c}${Number(r.totals.sales || 0).toFixed(2)}`, true)}
      </div>
      ${row('VATable Sales:', `${c}${Number(r.totals.vatableSales || 0).toFixed(2)}`)}
      ${row('VAT-Exempt Sales:', `${c}${Number(r.totals.vatExemptSales || 0).toFixed(2)}`)}
      ${row('VAT Amount:', `${c}${Number(r.totals.tax || 0).toFixed(2)}`)}
    </div>
    <div style="border-bottom:1px dashed #000;margin:6px 0;"></div>
    <div style="font-size:11px;font-weight:bold;margin-bottom:3px;">PAYMENT METHOD BREAKDOWN</div>
    <div style="font-size:11px;">
      ${(r.paymentBreakdown || []).length
        ? r.paymentBreakdown.map(p => row(`${escapeHtml(p.method)} (${p.count}):`, `${c}${Number(p.total || 0).toFixed(2)}`)).join('')
        : '<div>No payments recorded.</div>'}
    </div>
    <div style="border-bottom:1px dashed #000;margin:6px 0;"></div>
    <div style="font-size:11px;font-weight:bold;margin-bottom:3px;">CASH DRAWER RECONCILIATION</div>
    <div style="font-size:11px;">
      ${row('Opening Cash Float:', `${c}${Number(cd.openingFloat || 0).toFixed(2)}`)}
      ${row('(+) Cash Sales:', `${c}${Number(cd.cashSales || 0).toFixed(2)}`)}
      <div style="border-top:1px dashed #000;margin:3px 0;padding-top:3px;">
        ${row('Expected Cash in Drawer:', `${c}${Number(cd.expectedCash || 0).toFixed(2)}`, true)}
      </div>
      ${varianceBlock}
      <div style="border-top:1px dotted #999;margin-top:4px;padding-top:3px;font-size:10px;color:#444;">
        ${row('Total Tendered (All):', `${c}${Number(r.totalCollected || 0).toFixed(2)}`)}
        ${row('Total Change Given:', `${c}${Number(r.totalChange || 0).toFixed(2)}`)}
      </div>
    </div>
    ${(r.itemsSold || []).length ? `
      <div style="border-bottom:1px dashed #000;margin:6px 0;"></div>
      <div style="font-size:11px;font-weight:bold;margin-bottom:3px;">ITEMS SOLD SUMMARY</div>
      <div style="font-size:11px;">
        ${r.itemsSold.map(i => row(`${i.quantity}x ${escapeHtml(i.name)}`, `${c}${Number(i.total || 0).toFixed(2)}`)).join('')}
      </div>` : ''}
    ${refLogs.length ? `
      <div style="border-bottom:1px dashed #000;margin:6px 0;"></div>
      <div style="font-size:11px;font-weight:bold;margin-bottom:3px;">EDIT ORDER / ITEM REFUNDS &amp; VOIDS (${refLogs.length})</div>
      <div style="font-size:10px;">
        ${refLogs.map(rf => `
          <div style="margin-bottom:4px;border-bottom:1px dotted #ccc;padding-bottom:2px;">
            ${row(`${escapeHtml(rf.time)} ${escapeHtml(rf.orderNumber)} [${escapeHtml(rf.action)}]`, `${c}${Number(rf.amount || 0).toFixed(2)}`, true)}
            <div>${escapeHtml(rf.details)}</div>
          </div>`).join('')}
      </div>` : ''}
    ${txLogs.length ? `
      <div style="border-bottom:1px dashed #000;margin:6px 0;"></div>
      <div style="font-size:11px;font-weight:bold;margin-bottom:3px;">TRANSACTION LOG (${txLogs.length} ORDERS)</div>
      <div style="font-size:10px;">
        ${txLogs.map(tx => `
          <div style="margin-bottom:3px;">
            ${row(`${escapeHtml(tx.time)} ${escapeHtml(tx.orderNumber)} (${escapeHtml(tx.table)})`, `${c}${Number(tx.total || 0).toFixed(2)}`, tx.paymentStatus === 'PAID')}
            <div style="color:#444;">${escapeHtml(tx.method)} | ${escapeHtml(tx.status)} | ${escapeHtml(tx.staff)}</div>
          </div>`).join('')}
      </div>` : ''}
    ${actEvents.length ? `
      <div style="border-bottom:1px dashed #000;margin:6px 0;"></div>
      <div style="font-size:11px;font-weight:bold;margin-bottom:3px;">SYSTEM AUDIT TRAIL (${actEvents.length})</div>
      <div style="font-size:10px;">
        ${actEvents.map(ev => `<div style="margin-bottom:2px;"><strong>${escapeHtml(ev.time)} [${escapeHtml(ev.action)}]</strong> ${escapeHtml(ev.user)}: ${escapeHtml(ev.details)}</div>`).join('')}
      </div>` : ''}
    <div style="border-bottom:1px dashed #000;margin:8px 0;"></div>
    <div style="text-align:center;font-size:11px;font-weight:bold;">END OF Z-READING REPORT</div>`;
}

function renderEODReportHtml(r) {
  const c = r.currency || curr();
  const zReceiptHtml = buildEodZReadingHtml(r);
  const openBadge = $('eodOpenWarningBadge');
  if (openBadge) {
    if (r.counts.open > 0) {
      openBadge.style.display = 'inline-block';
      openBadge.textContent = `${r.counts.open} Open Order(s)`;
    } else {
      openBadge.style.display = 'none';
    }
  }

  const refLogs = r.refundLogs || [];
  const txLogs = r.transactionLogs || [];

  $('eodReport').innerHTML = `
    <div class="row g-3 align-items-start">
      <div class="col-md-5">
        <div class="receipt-preview shadow-sm">${zReceiptHtml}</div>
      </div>
      <div class="col-md-7">
        <div class="alert ${r.counts.open > 0 ? 'alert-warning' : 'alert-success'} mb-3">
          <div class="fw-bold mb-1">
            <i class="fa-solid ${r.counts.open > 0 ? 'fa-triangle-exclamation' : 'fa-circle-check'} me-1"></i>
            Z-Reading Ready for ${escapeHtml(r.date)} (${escapeHtml(r.branchName)})
          </div>
          <div class="small">
            ${r.counts.open > 0
              ? `Warning: There are still <strong>${r.counts.open}</strong> unpaid/open order(s) for this date.`
              : `All orders for this business date are settled. Click <strong>Print Z-Reading</strong> or <strong>Close POS</strong> to archive this closing.`}
          </div>
        </div>

        <div class="card border p-3 mb-3">
          <h6 class="fw-bold mb-2"><i class="fa-solid fa-wallet text-primary me-1"></i>Payment Method Breakdown (Hybrid Separated)</h6>
          <div class="table-responsive">
            <table class="table table-sm table-bordered mb-0">
              <thead class="table-light"><tr><th>Method</th><th class="text-end">Count</th><th class="text-end">Total</th></tr></thead>
              <tbody>
                ${(r.paymentBreakdown || []).length
                  ? r.paymentBreakdown.map(p => `<tr><td><strong>${escapeHtml(p.method)}</strong></td><td class="text-end">${p.count}</td><td class="text-end fw-bold">${c}${Number(p.total || 0).toFixed(2)}</td></tr>`).join('')
                  : '<tr><td colspan="3" class="text-center text-muted">No payments recorded</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card border border-danger p-3 mb-3">
          <h6 class="fw-bold text-danger mb-2"><i class="fa-solid fa-rotate-left me-1"></i>Edit Order / Item Refunds &amp; Voids Log (${refLogs.length})</h6>
          <div class="table-responsive" style="max-height:220px;">
            <table class="table table-sm table-bordered mb-0">
              <thead class="table-danger"><tr><th>Time</th><th>Order #</th><th>Action</th><th class="text-end">Amount</th><th>Details</th></tr></thead>
              <tbody>
                ${refLogs.length
                  ? refLogs.map(rf => `<tr><td class="small">${escapeHtml(rf.time)}</td><td><strong>${escapeHtml(rf.orderNumber)}</strong></td><td><span class="badge bg-danger">${escapeHtml(rf.action)}</span></td><td class="text-end text-danger fw-bold">${c}${Number(rf.amount || 0).toFixed(2)}</td><td class="small">${escapeHtml(rf.details)}</td></tr>`).join('')
                  : '<tr><td colspan="5" class="text-center text-muted small">No order edits, item refunds, or voids on this date.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card border p-3">
          <h6 class="fw-bold mb-2"><i class="fa-solid fa-list-ul text-secondary me-1"></i>Full Transaction Log (${txLogs.length} Orders)</h6>
          <div class="table-responsive" style="max-height:260px;">
            <table class="table table-sm table-bordered mb-0">
              <thead class="table-light"><tr><th>Time</th><th>Order #</th><th>Table</th><th>Method</th><th>Status</th><th class="text-end">Total</th></tr></thead>
              <tbody>
                ${txLogs.length
                  ? txLogs.map(tx => `<tr><td class="small">${escapeHtml(tx.time)}</td><td><strong>${escapeHtml(tx.orderNumber)}</strong></td><td>${escapeHtml(tx.table)}</td><td class="small">${escapeHtml(tx.method)}</td><td>${badgeForStatus(tx.status)}</td><td class="text-end fw-bold">${c}${Number(tx.total || 0).toFixed(2)}</td></tr>`).join('')
                  : '<tr><td colspan="6" class="text-center text-muted small">No transactions recorded on this date.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;
}

async function loadEODReport() {
  const dateVal = $('eodDate').value;
  if (!dateVal) return toast('Select a date first.', 'warning');
  saveEodDrawerValues();
  const openingFloat = getEodOpeningFloat();
  const actualCash = getEodActualCash();

  try {
    showLoading('Generating Z-Reading report…');
    const r = await callServer('getEndOfDayReport', state.token, dateVal, openingFloat, actualCash);
    hideLoading();
    window._lastEOD = r;
    state.eodGenerated = { date: dateVal, branchId: state.activeBranchId };
    renderEODReportHtml(r);
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

function printEODReport() {
  const r = window._lastEOD;
  if (!r || !state.eodGenerated || state.eodGenerated.date !== $('eodDate').value) {
    return toast('Generate the Z-Reading report first before printing.', 'warning');
  }
  printHtmlDocument(`Z-Reading Report - ${r.date}`, buildEodZReadingHtml(r));
}

async function loadEodHistory() {
  const tbody = $('eodHistoryBody');
  if (!tbody) return;
  try {
    const rows = await callServer('getEodHistory', state.token);
    const c = curr();
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted small py-2">No closed Z-Readings archived yet for this branch.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td><strong>${escapeHtml(r.BusinessDate)}</strong></td>
        <td class="small text-muted">${r.ClosedAt ? new Date(r.ClosedAt).toLocaleString() : '—'}</td>
        <td class="text-end fw-bold text-success">${c}${Number(r.CashSales || 0).toFixed(2)}</td>
        <td class="text-end text-danger">-${c}${Number(r.SeniorPwdDiscounts || 0).toFixed(2)}</td>
        <td class="text-end">${c}${Number(r.VatableSales || 0).toFixed(2)}</td>
        <td class="text-end">${c}${Number(r.VatExemptSales || 0).toFixed(2)}</td>
        <td class="text-end">${c}${Number(r.VatAmount || 0).toFixed(2)}</td>
      </tr>`).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger small py-2">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function closePOS() {
  const dateVal = $('eodDate').value;
  if (!dateVal) return toast('Select a date first.', 'warning');
  if (!state.eodGenerated || state.eodGenerated.date !== dateVal || state.eodGenerated.branchId !== state.activeBranchId) {
    return showModal('eodRequiredModal');
  }
  if (!confirm(`Close POS for ${dateVal} on the current branch?\n\nThis will archive the Z-Reading report, mark paid orders as COMPLETED, and reset all branch tables to Available.`)) return;
  try {
    showLoading('Closing POS & archiving Z-Reading…');
    const r = await callServer('archiveAndResetPOS', state.token, dateVal);
    showDone(r.message || 'POS Closed & Z-Reading Archived!', async () => {
      state.eodGenerated = null;
      await loadEodHistory();
      await poll(true);
    });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

async function downloadZipBackup() {
  try {
    showLoading('Preparing branch backup…');
    const res = await callServer('exportDatabaseAsZip', state.token);
    hideLoading();
    const a = document.createElement('a'); a.href = 'data:application/json;base64,' + res.base64Data; a.download = res.fileName;
    document.body.appendChild(a); a.click(); a.remove(); toast('Backup downloaded!', 'success');
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

async function triggerDbSetup() {
  if (!confirm('Reload branch data from Supabase?')) return;
  try { showLoading('Reloading…'); await loadBootstrap(); await poll(true); showDone('Database synced!'); }
  catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

function openHelpModal() { showModal('helpModal'); }

/* ============================================================
   INITIALIZATION
   ============================================================ */
(async function init() {
  if ($('loginVersion')) $('loginVersion').textContent = APP_VERSION;
  try {
    if (await resumeSession()) {
      await initSession();
      return;
    }
  } catch (e) {}
  $('loginScreen').style.display = 'flex';
})();
