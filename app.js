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
const APP_VERSION = 'v4.9.2-RT';
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
        const nextStatus = o.PaymentStatus === 'PAID' ? 'COMPLETED' : 'SERVED';
        await sbClient.from('orders').update({ OrderStatus: nextStatus, Status: nextStatus === 'COMPLETED' ? 'Paid' : 'Open' }).eq('OrderID', orderId);
        if (o.TableID) await sbClient.from('restaurant_tables').update({ Status: 'Needs Cleaning', CurrentOrderID: null }).eq('TableID', o.TableID);
      }
      await logActivity(action, 'Order', orderId, JSON.stringify(params));
      return { success: true };
    }
    case 'processPayment': {
      const [, p] = args;
      const { data: o } = await sbClient.from('orders').select('*').eq('OrderID', p.orderId).single();
      if (!o) throw new Error('Order not found');
      const t = p.computedTotals || {};
      const totalDue = Number(t.total ?? o.GrandTotal ?? 0);
      const changeAmount = Math.max(0, Number(p.amountReceived || 0) - totalDue);
      const nextOrderStatus = o.OrderStatus === 'PENDING_COUNTER'
        ? (isKdsDisabled() ? 'READY' : 'CONFIRMED_BY_COUNTER')
        : (o.OrderStatus === 'SERVED' ? 'COMPLETED' : o.OrderStatus);

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
      await logActivity('PAYMENT', 'Order', p.orderId, `${p.paymentMethod} ${totalDue.toFixed(2)}`);
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
      return { success: true, message: 'Table is now Available' };
    }
    case 'toggleTableReservation': {
      const [, tableId, isReserved, note] = args;
      await sbClient.from('restaurant_tables').update({
        Status: isReserved ? 'Reserved' : 'Available',
        ReservedFor: isReserved ? (note || 'Reserved') : null
      }).eq('TableID', tableId);
      return { success: true, message: isReserved ? 'Table marked Reserved' : 'Reservation cleared' };
    }
    case 'transferReservation': {
      const [, fromId, toId] = args;
      const { data: src } = await sbClient.from('restaurant_tables').select('ReservedFor').eq('TableID', fromId).single();
      await sbClient.from('restaurant_tables').update({ Status: 'Reserved', ReservedFor: src?.ReservedFor || 'Reserved' }).eq('TableID', toId);
      await sbClient.from('restaurant_tables').update({ Status: 'Available', ReservedFor: null }).eq('TableID', fromId);
      return { success: true, message: 'Reservation transferred!' };
    }
    case 'transferTableOrder': {
      const [, orderId, newTableId, newTableNumber] = args;
      const { data: o } = await sbClient.from('orders').select('TableID').eq('OrderID', orderId).single();
      const { data: oldTbl } = o?.TableID ? await sbClient.from('restaurant_tables').select('Status').eq('TableID', o.TableID).single() : { data: { Status: 'Occupied' } };
      await sbClient.from('orders').update({ TableID: newTableId, TableNumber: newTableNumber }).eq('OrderID', orderId);
      await sbClient.from('restaurant_tables').update({ Status: oldTbl?.Status || 'Occupied', CurrentOrderID: orderId }).eq('TableID', newTableId);
      if (o?.TableID) await sbClient.from('restaurant_tables').update({ Status: 'Available', CurrentOrderID: null }).eq('TableID', o.TableID);
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
      return { success: true };
    }
    case 'deleteTable': {
      const [, tableId] = args;
      const { error } = await sbClient.from('restaurant_tables').delete().eq('TableID', tableId);
      if (error) throw new Error(error.message);
      return { success: true, message: 'Table deleted' };
    }
    case 'saveCategory': {
      const [, c] = args;
      const newCatId = uuid();
      const { error } = await sbClient.from('categories').insert({
        CategoryID: newCatId,
        CategoryName: c.CategoryName,
        Description: c.Description || '',
        SortOrder: (state.categories.length || 0) + 1
      });
      if (error) throw new Error(error.message);
      return { success: true, CategoryID: newCatId };
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
      if (state.user?.role === 'Manager') {
        if (u.Role === 'Admin') {
          throw new Error('Managers are not allowed to assign or create the Admin role.');
        }
        if (u.UserID) {
          const existing = (state.users || []).find(x => String(x.UserID) === String(u.UserID));
          if (existing && existing.Role === 'Admin') {
            throw new Error('Managers cannot edit Admin accounts.');
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
      return data;
    }
    case 'deleteUser': {
      const [, userId] = args;
      if (!userId) throw new Error('Invalid user ID.');
      if (state.user && String(state.user.userId) === String(userId)) {
        throw new Error('You cannot delete your currently logged-in account.');
      }
      const targetUser = (state.users || []).find(u => String(u.UserID) === String(userId));
      if (state.user?.role === 'Manager' && targetUser && targetUser.Role === 'Admin') {
        throw new Error('Managers cannot delete Admin accounts.');
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
      const { data } = await sbClient.from('activity_logs').select('*').order('Timestamp', { ascending: false }).limit(300);
      return data || [];
    }
    case 'getSalesReport': {
      const [, opts = {}] = args;
      const allBranches = opts.allBranches === true && state.user?.role === 'Admin';
      let oQuery = sbClient.from('orders').select('*');
      let iQuery = sbClient.from('order_items').select('*');
      if (!allBranches) {
        oQuery = oQuery.eq('BranchID', bId);
        iQuery = iQuery.eq('BranchID', bId);
      }
      if (opts.startDate) oQuery = oQuery.gte('CreatedAt', `${opts.startDate}T00:00:00`);
      if (opts.endDate) oQuery = oQuery.lte('CreatedAt', `${opts.endDate}T23:59:59`);

      const [{ data: allOrds }, { data: allItms }] = await Promise.all([
        oQuery.order('CreatedAt', { ascending: false }),
        iQuery
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
          total: Number(o.GrandTotal || 0)
        };
      });

      return {
        currency: curr(),
        allBranches,
        range: { start: opts.startDate, end: opts.endDate },
        totals: { sales: totalSales, subtotal: totalSub, discount: totalDisc, tax: totalTax, service: totalSrv, items: totalItems },
        counts: { paid: paid.length, cancelled: cancelled.length, open: open.length },
        averageOrderValue: paid.length ? totalSales / paid.length : 0,
        branchBreakdown,
        paymentBreakdown,
        topItems,
        daily: Object.values(dailyMap).sort((a, b) => b.date.localeCompare(a.date)),
        orders: orderRows
      };
    }
    case 'getEndOfDayReport': {
      const [, dateVal, openingFloatRaw, actualCashRaw] = args;
      const openingFloat = Math.max(0, Number(openingFloatRaw) || 0);
      const actualCash = (actualCashRaw !== null && actualCashRaw !== undefined && actualCashRaw !== '')
        ? Math.max(0, Number(actualCashRaw) || 0)
        : null;

      const [{ data: ords }, { data: itms }] = await Promise.all([
        sbClient.from('orders').select('*').eq('BranchID', bId).gte('CreatedAt', `${dateVal}T00:00:00`).lte('CreatedAt', `${dateVal}T23:59:59`),
        sbClient.from('order_items').select('*').eq('BranchID', bId)
      ]);
      const orders = ords || [];
      const paid = orders.filter(o => o.PaymentStatus === 'PAID');
      const cancelled = orders.filter(o => ['CANCELLED', 'VOIDED'].includes(o.OrderStatus));
      const openOrders = orders.filter(o => o.PaymentStatus !== 'PAID' && !['CANCELLED', 'VOIDED'].includes(o.OrderStatus));

      const totalSales = paid.reduce((s, o) => s + Number(o.GrandTotal || 0), 0);
      const totalCollected = paid.reduce((s, o) => s + Number(o.AmountTendered || o.GrandTotal || 0), 0);
      const totalChange = paid.reduce((s, o) => s + Number(o.ChangeAmount || 0), 0);

      const methodMap = {};
      let cashSales = 0;
      let cashTendered = 0;
      paid.forEach(o => {
        const label = o.PaymentMethod === 'Delivery' && o.DeliveryPlatform
          ? `Delivery (${o.DeliveryPlatform})`
          : (o.PaymentMethod || 'Cash');
        if (!methodMap[label]) methodMap[label] = { method: label, count: 0, total: 0 };
        methodMap[label].count++;
        methodMap[label].total += Number(o.GrandTotal || 0);
        if ((o.PaymentMethod || 'Cash') === 'Cash') {
          cashSales += Number(o.GrandTotal || 0);
          cashTendered += Number(o.AmountTendered || o.GrandTotal || 0);
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
          itemsQty: totalItemsQty
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
          sales: totalSales
        },
        totalCollected,
        totalChange,
        itemsSold: Object.values(itemMap).sort((a, b) => b.quantity - a.quantity)
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
  if (state.user.role !== 'Admin') {
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
    uBranch.innerHTML = (state.user?.role === 'Admin' ? '<option value="">All Branches (Admin)</option>' : '') +
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
          OrderItemID: '', OrderID: item.id, MenuItemID: i.menuItemId, ItemNameSnapshot: i.itemName,
          UnitPriceSnapshot: i.price, Quantity: i.quantity, Station: i.station || 'Kitchen', Status: 'PENDING'
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
        o.OrderStatus = 'SERVED';
        if (o.TableID) setTableStatus(o.TableID, 'Needs Cleaning');
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
        ChangeAmount: Math.max(0, received - due), ReferenceNumber: p.referenceNumber || ''
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
  const isGlobalAdmin = state.user.role === 'Admin';
  const brTab = $('adminBranchesTabBtn');
  if (brTab) brTab.style.display = isGlobalAdmin ? '' : 'none';
  const rScopeWrap = $('reportScopeWrap');
  if (rScopeWrap) rScopeWrap.style.display = isGlobalAdmin ? '' : 'none';
  if (allowed.length && !allowed.includes(state.currentView)) switchView(allowed[0]);
}

function canServeOrder(o) {
  if (o.OrderStatus === 'READY') return true;
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
  if (state.user?.role === 'Admin' && state.branches.length && !state.branches.some(b => b.BranchID === state.activeBranchId)) {
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
      loadAdminStats(); loadActivityLogs(); loadEodHistory();
    }
    if (!$('eodDate').value) $('eodDate').value = todayStr();
    syncEodDrawerInputs();
  }
  renderCurrentView();
}

function renderCurrentView() {
  const v = state.currentView;
  if (v === 'waiter') { syncDashViewButtons(); renderTables(); renderWaiterOrders(); }
  else if (v === 'counter') { syncCounterViewButtons(); renderCounterQueue(); }
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
   ALERTS, TABLES, RESERVATIONS, WAITER ORDERS, COUNTER, KDS
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
  const serveBtn = canServeOrder(o)
    ? `<button class="btn btn-sm btn-success fw-bold me-1" onclick="serveOrder('${o.OrderID}')"><i class="fa-solid fa-concierge-bell me-1"></i>Serve</button>` : '';
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
  return `<div class="col-12 col-md-4"><div class="card card-pos p-3">
    <div class="d-flex justify-content-between align-items-center border-bottom pb-2 mb-2">
      <h5 class="mb-0">${escapeHtml(o.OrderNumber)}${pendingIcon}</h5>
      <span class="badge bg-secondary fs-6">${escapeHtml(o.TableNumber || 'Takeout')}</span>
    </div>
    <div class="d-flex justify-content-between align-items-center mb-1"><span class="small">${badgeForStatus(o.OrderStatus)}</span>${paidBadge}</div>
    <p class="mb-1"><strong>${escapeHtml(o.CustomerName || 'Walk-In Customer')}</strong></p>
    <p class="mb-2 small text-muted"><i class="fa-solid fa-user-tie text-warning me-1"></i>Waiter: <strong>${escapeHtml(o.WaiterName || '—')}</strong></p>
    <ul class="list-group list-group-flush mb-2">${(o.items || []).map(i => `<li class="list-group-item px-0 py-1 small">${i.Quantity}× ${escapeHtml(i.ItemNameSnapshot)}</li>`).join('')}</ul>
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
    return `<tr>
      <td><strong>${escapeHtml(o.OrderNumber)}</strong>${pendingIcon}</td>
      <td><span class="badge bg-secondary fs-6">${escapeHtml(o.TableNumber || 'Takeout')}</span></td>
      <td>${escapeHtml(o.CustomerName)}</td>
      <td><i class="fa-solid fa-user-tie text-warning me-1"></i>${escapeHtml(o.WaiterName || '—')}</td>
      <td>${(o.items || []).length}</td>
      <td>${curr()}${Number(o.GrandTotal || 0).toFixed(2)}</td>
      <td>${badgeForStatus(o.OrderStatus)}</td>
      <td>${waiterOrderEta(o)}</td>
      <td><div class="d-flex gap-1">${waiterOrderButtons(o)}</div></td>
    </tr>`;
  }).join(''));
  updateEtas();
}

function badgeForStatus(s) {
  const map = { PENDING_COUNTER: 'warning text-dark', CONFIRMED_BY_COUNTER: 'info', ACCEPTED_BY_KITCHEN: 'primary', PREPARING: 'primary', READY: 'success', SERVED: 'secondary', COMPLETED: 'dark', CANCELLED: 'danger', VOIDED: 'danger' };
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
      <ul class="list-group mb-2">${(o.items || []).map(i => `<li class="list-group-item d-flex justify-content-between fw-bold"><span>${i.Quantity}× ${escapeHtml(i.ItemNameSnapshot)}</span><span class="badge bg-light text-dark">${escapeHtml(i.Station || '')}</span></li>`).join('')}</ul>
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
function serveOrder(orderId) { return transition(orderId, 'SERVE', {}, 'Serve order', 'Marking served…', 'Order served!'); }
function confirmCounter(orderId) {
  const o = (state.orders || []).find(x => x.OrderID === orderId);
  if (o) openPaymentModal(o.OrderID, Number(o.GrandTotal || 0), Number(o.AmountPaid || 0));
}
async function rejectCounter(orderId) {
  const reason = prompt('Reason for rejection:');
  if (reason !== null) return transition(orderId, 'REJECT_COUNTER', { reason }, 'Reject order', 'Rejecting…', 'Order rejected.');
}

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
  $('payDeliveryToggle').checked = false;
  togglePayDeliveryUI();
  togglePaySeniorPwdUI();
  recalcPaymentSummary();
  showModal('paymentModal');
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
  const isSeniorPwd = $('paySeniorPwdToggle')?.checked || false;
  const manualDiscount = parseFloat($('payDiscount')?.value) || 0;
  const t = computeTotals(gross, isSeniorPwd, manualDiscount);

  $('paySeniorPctLabel').textContent = t.seniorPct;
  $('paySeniorPctHelp').textContent = t.seniorPct;
  $('paySubtotalDisplay').textContent = `${curr()}${t.subtotal.toFixed(2)}`;
  $('payDiscountAmtDisplay').textContent = `-${curr()}${t.discount.toFixed(2)}`;

  const lvRow = $('payLessVatRowDisplay');
  if (lvRow) {
    lvRow.classList.toggle('d-none', !(t.lessVat > 0));
    $('payLessVatPct').textContent = t.parsedTax;
    $('payLessVatDisplay').textContent = `-${curr()}${t.lessVat.toFixed(2)}`;
  }
  const taxRow = $('payTaxRowDisplay');
  if (taxRow) {
    const showAdded = !(t.enableTax && t.inclusive);
    taxRow.classList.toggle('d-none', !showAdded);
    if (showAdded) {
      taxRow.innerHTML = t.enableTax
        ? `<span class="text-secondary">VAT (${t.parsedTax}%)${isSeniorPwd ? ' - exempt' : ''}:</span><span class="fw-semibold">${curr()}${t.tax.toFixed(2)}</span>`
        : `<span class="text-muted">Tax:</span><span class="badge bg-light text-secondary border">₱0.00 (No Tax)</span>`;
    }
  }
  const srvRow = $('payServiceRowDisplay');
  if (srvRow) {
    srvRow.innerHTML = t.enableSrv
      ? `<span class="text-secondary">Service (${t.parsedSrv}%):</span><span class="fw-semibold">${curr()}${t.srv.toFixed(2)}</span>`
      : `<span class="text-muted">Service Charge:</span><span class="badge bg-light text-secondary border">₱0.00</span>`;
  }
  const info = $('payVatInfoDisplay');
  if (info) {
    if (t.enableTax && t.inclusive) {
      info.classList.remove('d-none');
      info.innerHTML = isSeniorPwd
        ? `<div class="d-flex justify-content-between"><span>VAT-Exempt Sales</span><span>${curr()}${t.vatExemptSales.toFixed(2)}</span></div><div class="d-flex justify-content-between"><span>VAT (${t.parsedTax}%)</span><span>${curr()}0.00</span></div>`
        : `<div class="d-flex justify-content-between"><span>VATable Sales</span><span>${curr()}${t.vatableSales.toFixed(2)}</span></div><div class="d-flex justify-content-between"><span>VAT (${t.parsedTax}%) included</span><span>${curr()}${t.tax.toFixed(2)}</span></div>`;
    } else info.classList.add('d-none');
  }
  $('payGrandTotalDisplay').textContent = `${curr()}${t.total.toFixed(2)}`;
  const remaining = Math.max(0, t.total - (o ? Number(o.AmountPaid || 0) : 0));
  $('payDue').value = remaining.toFixed(2);
  if ($('payDeliveryToggle')?.checked) $('payReceived').value = remaining.toFixed(2);
  calcChange();
}

function calcChange() {
  const due = parseFloat($('payDue').value) || 0;
  const recv = parseFloat($('payReceived').value) || 0;
  $('payChange').value = Math.max(0, recv - due).toFixed(2);
}

async function submitPayment() {
  const orderId = $('payOrderId').value;
  const o = (state.orders || []).find(x => x.OrderID === orderId);
  const gross = o ? Number(o.Subtotal || 0) : 0;
  const isSeniorPwd = $('paySeniorPwdToggle').checked;
  const seniorPwdId = $('paySeniorPwdIdInput').value.trim();
  const manualDiscount = parseFloat($('payDiscount').value) || 0;
  if (isSeniorPwd && !seniorPwdId) return toast('Please enter Senior Citizen / PWD ID #.', 'warning');

  const computedTotals = computeTotals(gross, isSeniorPwd, manualDiscount);
  const due = computedTotals.total - (o ? Number(o.AmountPaid || 0) : 0);
  const isDelivery = $('payDeliveryToggle').checked;
  let deliveryPlatform = '';
  let resolvedPaymentMethod = $('payMethod').value;

  if (isDelivery) {
    resolvedPaymentMethod = 'Delivery';
    deliveryPlatform = $('payDeliveryPlatform').value;
    if (deliveryPlatform === 'Others') deliveryPlatform = $('payDeliveryOther').value.trim();
    if (!deliveryPlatform) return toast('Please enter the delivery platform name.', 'warning');
  } else if (resolvedPaymentMethod === 'Other') {
    resolvedPaymentMethod = ($('payMethodOther')?.value || '').trim();
    if (!resolvedPaymentMethod) {
      $('payMethodOther')?.focus();
      return toast('Please enter the payment method name.', 'warning');
    }
  }

  const received = isDelivery ? Math.max(0, due) : (parseFloat($('payReceived').value) || 0);
  if (received + 0.001 < due) return toast(`Insufficient payment amount. Remaining due: ${due.toFixed(2)}`, 'warning');

  const id = uuid();
  const payload = {
    orderId, amountReceived: received, paymentMethod: resolvedPaymentMethod,
    referenceNumber: $('payRef').value, clientId: id, customerName: $('payCustomerName').value || 'Walk-In Customer',
    isSeniorPwd, seniorPwdId, discount: manualDiscount, discountReason: $('payDiscountReason').value || '',
    computedTotals, isDelivery, deliveryPlatform
  };

  try {
    showLoading('Processing payment…');
    const r = await runAction('processPayment', [payload], id, 'Payment');
    const change = r.queued ? Math.max(0, received - due) : Number(r.res.changeAmount || 0);
    showDone(`Payment complete! Change: ${curr()}${change.toFixed(2)}`, async () => {
      hideModal('paymentModal');
      if (!r.queued) await poll();
      await openReceiptModal(orderId);
    });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

async function openReceiptModal(orderId) {
  try {
    showLoading('Loading receipt preview…');
    const data = await callServerT(20000, 'getReceiptData', state.token, orderId);
    hideLoading();
    renderReceiptPreview(data);
    syncPrintModeSelects();
    showModal('receiptModal');
  } catch (err) { hideLoading(); toast('Error loading receipt: ' + err.message, 'danger'); }
}

function renderReceiptPreview(data) {
  const o = data.order || {}, items = data.items || [], payments = data.payments || [], s = data.settings || {};
  const c = s.CURRENCY_SYMBOL || '₱', fmt = (n) => c + Number(n || 0).toFixed(2);
  const lastPay = payments.length ? payments[payments.length - 1] : {};
  const dt = new Date(o.CreatedAt || Date.now());
  const taxPct = parseFloat(s.TAX_RATE_PERCENT) || 12;
  const inclusive = s.VAT_INCLUSIVE !== 'false';
  const lessVat = Number(o.LessVat || 0), disc = Number(o.Discount || 0), svc = Number(o.ServiceCharge || 0), taxAmt = Number(o.Tax || 0);
  const row = (a, b, bold) => `<div style="display:flex; justify-content:space-between;${bold ? ' font-weight:bold; font-size:0.95rem; margin-top:4px;' : ''}"><span>${a}</span><span>${b}</span></div>`;
  let receiptRows = row('Subtotal', fmt(o.Subtotal));
  if (lessVat > 0) receiptRows += row(`Less: VAT (${taxPct}%)`, '-' + fmt(lessVat));
  if (disc > 0) receiptRows += row(`Discount ${o.DiscountReason ? '(' + escapeHtml(o.DiscountReason) + ')' : ''}`, '-' + fmt(disc));
  if (svc > 0) receiptRows += row('Service Charge', fmt(svc));
  if (!inclusive) receiptRows += row(taxAmt > 0 ? `VAT (${taxPct}%)` : 'Tax', fmt(taxAmt));
  receiptRows += row('Total', fmt(o.GrandTotal), true);
  if (inclusive) {
    receiptRows += '<div style="border-top:1px dashed #000; margin:6px 0 4px;"></div>';
    if (Number(o.VatableSales || 0) > 0) receiptRows += row('VATable Sales', fmt(o.VatableSales));
    if (Number(o.VatExemptSales || 0) > 0) receiptRows += row('VAT-Exempt Sales', fmt(o.VatExemptSales));
    receiptRows += row(`VAT (${taxPct}%)`, fmt(taxAmt));
  }
  $('receiptPreviewContent').innerHTML = `
    <div style="text-align:center; font-weight:bold; font-size:1.1rem;">${escapeHtml(s.RESTAURANT_NAME || 'Tuna Choice POS')}</div>
    <div style="text-align:center; font-size:0.8rem; margin-bottom:4px;">${o.TableNumber ? 'Table: ' + escapeHtml(o.TableNumber) : 'Takeout'}</div>
    <div style="border-bottom:1px dashed #000; margin:6px 0;"></div>
    <div style="font-size:0.8rem; display:flex; justify-content:space-between;"><span>Order: ${escapeHtml(o.OrderNumber)}</span><span>${dt.toLocaleDateString()}</span></div>
    <div style="font-size:0.8rem; display:flex; justify-content:space-between; margin-bottom:4px;"><span>Customer: ${escapeHtml(o.CustomerName || 'Walk-In')}</span><span>${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
    <div style="border-bottom:1px dashed #000; margin:6px 0;"></div>
    <div style="font-size:0.85rem;">${items.map(i => `<div style="display:flex; justify-content:space-between; margin-bottom:2px;"><span>${i.Quantity}x ${escapeHtml(i.ItemNameSnapshot)}</span><span>${fmt(Number(i.UnitPriceSnapshot) * Number(i.Quantity))}</span></div>`).join('')}</div>
    <div style="border-bottom:1px dashed #000; margin:6px 0;"></div>
    <div style="font-size:0.8rem;">${receiptRows}</div>
    <div style="border-bottom:1px dashed #000; margin:6px 0;"></div>
    <div style="font-size:0.8rem;">
      <div style="display:flex; justify-content:space-between;"><span>Paid (${escapeHtml(lastPay.PaymentMethod || 'Cash')})</span><span>${fmt(o.AmountPaid)}</span></div>
      <div style="display:flex; justify-content:space-between;"><span>Change</span><span>${fmt(lastPay.ChangeAmount || 0)}</span></div>
    </div>
    <div style="border-bottom:1px dashed #000; margin:8px 0;"></div>
    <div style="text-align:center; font-size:0.75rem; margin-top:6px;">${escapeHtml(s.RECEIPT_FOOTER || 'Thank you for dining with us!')}</div>`;
}
function printReceipt() {
  const c = $('receiptPreviewContent');
  if (c) printHtmlDocument('Print Receipt', c.innerHTML);
}

function kitchenAccept(orderId) { return transition(orderId, 'ACCEPT_KITCHEN', {}, 'Accept order', 'Accepting…', 'Order accepted!'); }
async function kitchenStartPrep(orderId) {
  const mins = parseInt($(`prep_${orderId}`)?.value || 15, 10) || 15;
  const r = await transition(orderId, 'START_PREP', { prepMinutes: mins }, 'Start prep', 'Starting prep…', 'Prep started!');
  if (r) delete state.prepInputs[orderId];
}
function kitchenReady(orderId) { return transition(orderId, 'MARK_READY', {}, 'Mark ready', 'Marking ready…', 'Order ready!'); }

function openOrderModal() {
  state.cart = []; state.activeCategoryFilter = 'ALL';
  $('menuSearch').value = '';
  const avail = (state.tables || []).filter(t => t.Status === 'Available');
  $('cartTableSelect').innerHTML = `<option value="">-- Takeout / Walk-In --</option>` +
    avail.map(t => `<option value="${escapeHtml(t.TableID)}|${escapeHtml(t.TableNumber)}">${escapeHtml(t.TableNumber)}</option>`).join('');
  renderPOSCategoryTabs(); renderPOSMenu(); updateCartDisplay(); showModal('orderModal');
}
function renderPOSCategoryTabs() {
  const container = $('posCategoryTabs');
  if (!container) return;
  let html = `<button type="button" class="btn btn-sm ${state.activeCategoryFilter === 'ALL' ? 'btn-primary' : 'btn-outline-secondary'} rounded-pill px-3" onclick="selectPOSCategory('ALL')">All</button>`;
  (state.categories || []).forEach(c => {
    html += `<button type="button" class="btn btn-sm ${state.activeCategoryFilter === c.CategoryID ? 'btn-primary' : 'btn-outline-secondary'} rounded-pill px-3" onclick="selectPOSCategory('${escapeHtml(c.CategoryID)}')">${escapeHtml(c.CategoryName)}</button>`;
  });
  container.innerHTML = html;
}
function selectPOSCategory(catId) { state.activeCategoryFilter = catId; renderPOSCategoryTabs(); renderPOSMenu(); }
const onMenuSearch = debounce(() => renderPOSMenu(), 120);
function renderPOSMenu() {
  const term = ($('menuSearch')?.value || '').toLowerCase();
  const items = (state.menu || []).filter(m => {
    const isAvail = m.Available !== false && m.Available !== 'false';
    const name = String(m.ItemName || m.Name || '').toLowerCase();
    const matchesSearch = !term || name.includes(term);
    const matchesCategory = state.activeCategoryFilter === 'ALL' || String(m.CategoryID) === String(state.activeCategoryFilter);
    return isAvail && matchesSearch && matchesCategory;
  });
  const grid = $('posMenuGrid');
  if (!grid) return;
  grid.innerHTML = items.length ? items.map(m => {
    const id = m.MenuItemID || m.ItemID;
    const name = m.ItemName || m.Name || 'Item';
    const price = resolveMenuPrice(m);
    return `<div class="col-6 col-md-4">
      <div class="card card-pos p-2 text-center h-100" style="cursor:pointer" onclick="addToCart('${escapeHtml(id)}')">
        <img src="${escapeHtml(m.ImageURL || FOOD_PLACEHOLDER)}" loading="lazy" class="rounded mb-2" style="height:70px; object-fit:cover; width:100%;">
        <h6 class="small fw-bold mb-1 text-truncate">${escapeHtml(name)}</h6>
        <span class="text-danger fw-bold small">${curr()}${price.toFixed(2)}</span>
      </div>
    </div>`;
  }).join('') : '<div class="col-12 text-center text-muted py-4">No available menu items found.</div>';
}
function addToCart(menuItemId) {
  const item = state.menuById[menuItemId];
  if (!item) return;
  const name = item.ItemName || item.Name || 'Item';
  const price = resolveMenuPrice(item);
  const existing = state.cart.find(c => c.menuItemId === menuItemId);
  if (existing) existing.quantity++;
  else state.cart.push({ menuItemId, itemName: name, price, quantity: 1, station: item.Station });
  updateCartDisplay();
}
function computeTotals(gross, isSeniorPwd, manualDiscount) {
  const s = state.settings;
  const parsedTax = parseFloat(s.TAX_RATE_PERCENT ?? 12);
  const parsedSrv = parseFloat(s.SERVICE_CHARGE_PERCENT ?? 5);
  const enableTax = (s.ENABLE_TAX !== 'false') && (parsedTax > 0);
  const enableSrv = (s.ENABLE_SERVICE_CHARGE !== 'false') && (parsedSrv > 0);
  const inclusive = s.VAT_INCLUSIVE !== 'false';
  const seniorPct = getSeniorPct();
  const vr = parsedTax / 100, sr = enableSrv ? parsedSrv / 100 : 0;
  const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

  gross = r2(gross);
  let discount = 0, lessVat = 0, base = 0, service = 0, vat = 0, total = 0, vatableSales = 0, vatExemptSales = 0;

  if (isSeniorPwd) {
    if (enableTax && inclusive) {
      const vatEx = r2(gross / (1 + vr));
      lessVat = r2(gross - vatEx);
      discount = r2(vatEx * seniorPct / 100);
      base = r2(vatEx - discount);
    } else {
      discount = r2(gross * seniorPct / 100);
      base = r2(gross - discount);
    }
    service = r2(base * sr);
    total = r2(base + service);
    vatExemptSales = total;
  } else {
    const pct = Math.min(Math.max(0, manualDiscount || 0), 50);
    discount = r2(gross * pct / 100);
    base = r2(gross - discount);
    service = r2(base * sr);
    if (enableTax) {
      if (inclusive) {
        total = r2(base + service);
        vatableSales = r2(total / (1 + vr));
        vat = r2(total - vatableSales);
      } else {
        vatableSales = r2(base + service);
        vat = r2(vatableSales * vr);
        total = r2(vatableSales + vat);
      }
    } else total = r2(base + service);
  }
  return { gross, subtotal: gross, discount, lessVat, tax: vat, srv: service, service, total, vatableSales, vatExemptSales, inclusive, parsedTax, parsedSrv, enableTax, enableSrv, seniorPct };
}
function updateCartDisplay() {
  const list = $('cartItemsList');
  if (!list) return;
  list.innerHTML = state.cart.map((it, idx) => `
    <div class="d-flex justify-content-between align-items-center small mb-1">
      <span>${escapeHtml(it.itemName)} ×${it.quantity}</span>
      <div><span class="me-2 fw-bold">${curr()}${(it.price * it.quantity).toFixed(2)}</span><button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="removeFromCart(${idx})">×</button></div>
    </div>`).join('');
  const gross = state.cart.reduce((s, i) => s + i.price * i.quantity, 0);
  $('cartSubtotal').textContent = `${curr()}${gross.toFixed(2)}`;
}
function removeFromCart(idx) { state.cart.splice(idx, 1); updateCartDisplay(); }
async function submitOrder() {
  if (state.submitting || state.cart.length === 0) return toast('Cart is empty.', 'warning');
  const selVal = $('cartTableSelect').value;
  let tableId = '', tableNumber = '';
  if (selVal) { const parts = selVal.split('|'); tableId = parts[0]; tableNumber = parts.slice(1).join('|'); }
  const gross = state.cart.reduce((s, i) => s + i.price * i.quantity, 0);
  const id = uuid();
  state.submitting = true;
  try {
    showLoading('Submitting order…');
    const r = await runAction('createOrder', [{ clientId: id, tableId, tableNumber, subtotal: gross, items: state.cart.map(i => ({ ...i })) }], id, 'New order');
    showDone(`Order ${r.res.orderNumber} submitted!`, () => {
      hideModal('orderModal');
      if (state.user && ['Counter', 'Manager', 'Admin'].includes(state.user.role)) switchView('counter');
      if (!r.queued) poll(true);
    });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
  finally { state.submitting = false; }
}

/* ============================================================
   ADMIN FORMS, MENU CSV IMPORT/EXPORT & REPORTS
   ============================================================ */
function compressImageFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const sc = Math.min(1, 360 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.7));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}
async function previewMenuImage(input) {
  if (input.files && input.files[0]) {
    const dataUrl = await compressImageFile(input.files[0]);
    $('cfgMenuImageUrl').value = dataUrl;
    $('cfgMenuImagePreview').src = dataUrl;
    $('cfgMenuImagePreview').classList.remove('d-none');
    $('cfgMenuNoImgText').classList.add('d-none');
  }
}
function resetMenuForm() {
  $('cfgMenuId').value = '';
  $('cfgMenuName').value = '';
  $('cfgMenuPrice').value = '';
  $('cfgMenuStation').value = 'Kitchen';
  $('cfgMenuAvailable').value = 'true';
  if ($('cfgMenuImageFile')) $('cfgMenuImageFile').value = '';
  $('cfgMenuImageUrl').value = '';
  $('cfgMenuImagePreview').classList.add('d-none');
  $('cfgMenuNoImgText').classList.remove('d-none');
  $('cfgMenuFormTitle').textContent = 'Add / Edit Menu Item';
}
function editMenuItemById(id) {
  const m = state.menuById[id] || (state.menu || []).find(x => (x.MenuItemID || x.ItemID) === id);
  if (!m) return toast('Menu item not found.', 'warning');
  const itemId = m.MenuItemID || m.ItemID;
  const itemName = m.ItemName || m.Name || 'Unnamed Item';
  const itemPrice = resolveMenuPrice(m);

  $('cfgMenuId').value = itemId;
  $('cfgMenuName').value = itemName;
  if (m.CategoryID) $('cfgMenuCategory').value = m.CategoryID;
  $('cfgMenuPrice').value = itemPrice.toFixed(2);
  $('cfgMenuStation').value = m.Station || 'Kitchen';
  $('cfgMenuAvailable').value = (m.Available !== false && m.Available !== 'false') ? 'true' : 'false';
  if ($('cfgMenuImageFile')) $('cfgMenuImageFile').value = '';
  $('cfgMenuImageUrl').value = m.ImageURL || '';

  if (m.ImageURL) {
    $('cfgMenuImagePreview').src = m.ImageURL;
    $('cfgMenuImagePreview').classList.remove('d-none');
    $('cfgMenuNoImgText').classList.add('d-none');
  } else {
    $('cfgMenuImagePreview').classList.add('d-none');
    $('cfgMenuNoImgText').classList.remove('d-none');
  }
  $('cfgMenuFormTitle').textContent = `Edit Menu Item (${itemName})`;
  $('cfgMenuName').focus();
}
async function saveMenuItem(e) {
  e.preventDefault();
  const isEdit = Boolean($('cfgMenuId').value);
  try {
    showLoading(isEdit ? 'Updating menu item…' : 'Adding menu item…');
    await callServer('saveMenuItem', state.token, {
      MenuItemID: $('cfgMenuId').value,
      ItemName: $('cfgMenuName').value,
      CategoryID: $('cfgMenuCategory').value,
      Price: $('cfgMenuPrice').value,
      Station: $('cfgMenuStation').value,
      Available: $('cfgMenuAvailable').value === 'true',
      ImageURL: $('cfgMenuImageUrl').value
    });
    showDone(isEdit ? 'Menu item updated!' : 'Menu item added!', async () => {
      resetMenuForm();
      await loadBootstrap();
    });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}
async function deleteMenuItemById(id, itemName) {
  if (!confirm(`Delete menu item "${itemName}"? This will remove it from all branches.`)) return;
  try {
    showLoading(`Deleting ${itemName}…`);
    const res = await callServer('deleteMenuItem', state.token, id);
    showDone(res.message || 'Menu item deleted!', async () => {
      if ($('cfgMenuId').value === id) resetMenuForm();
      await loadBootstrap();
    });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

function csvEscapeField(val) {
  const s = String(val === undefined || val === null ? '' : val);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(cur);
        cur = '';
      } else if (ch === '\r' && next === '\n') {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter(r => r.some(cell => String(cell).trim() !== ''));
}

function exportMenuCsv() {
  const catById = {};
  (state.categories || []).forEach(c => { catById[c.CategoryID] = c.CategoryName; });
  const header = ['ItemID', 'ItemName', 'Category', 'Price', 'Station', 'Available'];
  const rows = (state.menu || []).map(m => {
    const id = m.MenuItemID || m.ItemID || '';
    const name = m.ItemName || m.Name || '';
    const cat = catById[m.CategoryID] || m.Category || 'General';
    const price = resolveMenuPrice(m).toFixed(2);
    const station = m.Station || 'Kitchen';
    const avail = (m.Available !== false && m.Available !== 'false') ? 'true' : 'false';
    return [id, name, cat, price, station, avail].map(csvEscapeField).join(',');
  });

  const csvContent = '\uFEFF' + [header.join(','), ...rows].join('\r\n');
  const bId = state.activeBranchId || 'branch-main';
  const link = document.createElement('a');
  link.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvContent);
  link.download = `menu_items_${bId}_${todayStr()}.csv`;
  link.click();
  toast(`Exported ${rows.length} menu item(s) to CSV.`, 'success');
}

async function importMenuCsv(input) {
  const file = input?.files?.[0];
  if (!file) return;
  try {
    const rawText = await file.text();
    const cleaned = rawText.replace(/^\uFEFF/, '');
    const rows = parseCsvRows(cleaned);
    if (rows.length < 2) {
      input.value = '';
      return toast('CSV file is empty or missing data rows.', 'warning');
    }

    const headers = rows[0].map(h => String(h || '').trim().toLowerCase());
    const idxId = headers.findIndex(h => ['itemid', 'menuitemid', 'id'].includes(h));
    const idxName = headers.findIndex(h => ['itemname', 'name', 'item'].includes(h));
    const idxCat = headers.findIndex(h => ['category', 'categoryname'].includes(h));
    const idxPrice = headers.findIndex(h => ['price', 'amount', 'unitprice'].includes(h));
    const idxStation = headers.findIndex(h => ['station', 'kitchenstation'].includes(h));
    const idxAvail = headers.findIndex(h => ['available', 'status', 'active'].includes(h));

    if (idxName === -1 || idxPrice === -1) {
      input.value = '';
      return toast('CSV must include "ItemName" (or "Name") and "Price" columns.', 'danger');
    }

    const validStations = ['Kitchen', 'Grill', 'Fryer', 'Drinks', 'Desserts'];
    const dataRows = rows.slice(1);
    if (!confirm(`Import ${dataRows.length} menu row(s) from "${file.name}"? Existing items with matching ID or Name will be updated.`)) {
      input.value = '';
      return;
    }

    showLoading(`Importing ${dataRows.length} menu item(s)…`);

    const existingById = {};
    const existingByName = {};
    (state.menu || []).forEach(m => {
      const mid = m.MenuItemID || m.ItemID;
      const mname = String(m.ItemName || m.Name || '').trim().toLowerCase();
      if (mid) existingById[mid] = m;
      if (mname) existingByName[mname] = m;
    });

    const catByName = {};
    (state.categories || []).forEach(c => {
      catByName[String(c.CategoryName || '').trim().toLowerCase()] = c.CategoryID;
    });

    let importedCount = 0;
    let skippedCount = 0;

    for (const r of dataRows) {
      const rawName = String(r[idxName] || '').trim();
      const rawPrice = parseFloat(String(r[idxPrice] || '').replace(/[^0-9.-]/g, ''));
      if (!rawName || Number.isNaN(rawPrice) || rawPrice < 0) {
        skippedCount++;
        continue;
      }

      const rawId = idxId !== -1 ? String(r[idxId] || '').trim() : '';
      const matched = (rawId && existingById[rawId]) || existingByName[rawName.toLowerCase()] || null;
      const targetId = matched ? (matched.MenuItemID || matched.ItemID) : '';

      const rawCat = idxCat !== -1 ? String(r[idxCat] || '').trim() : '';
      let catId = '';
      if (rawCat) {
        catId = catByName[rawCat.toLowerCase()] || '';
        if (!catId) {
          const createdCat = await callServer('saveCategory', state.token, { CategoryName: rawCat, Description: '' });
          catId = createdCat.CategoryID;
          catByName[rawCat.toLowerCase()] = catId;
          state.categories.push({ CategoryID: catId, CategoryName: rawCat, Description: '', SortOrder: state.categories.length + 1 });
        }
      } else if (matched?.CategoryID) {
        catId = matched.CategoryID;
      } else if (state.categories[0]?.CategoryID) {
        catId = state.categories[0].CategoryID;
      }

      const rawStation = idxStation !== -1 ? String(r[idxStation] || '').trim() : '';
      const stationMatch = validStations.find(st => st.toLowerCase() === rawStation.toLowerCase()) || matched?.Station || 'Kitchen';

      let available = true;
      if (idxAvail !== -1 && r[idxAvail] !== undefined && String(r[idxAvail]).trim() !== '') {
        const avStr = String(r[idxAvail]).trim().toLowerCase();
        available = !['false', '0', 'no', 'unavailable', 'inactive'].includes(avStr);
      } else if (matched) {
        available = matched.Available !== false && matched.Available !== 'false';
      }

      await callServer('saveMenuItem', state.token, {
        MenuItemID: targetId,
        ItemName: rawName,
        CategoryID: catId,
        Price: rawPrice,
        Station: stationMatch,
        Available: available,
        ImageURL: matched?.ImageURL || ''
      });
      importedCount++;
    }

    input.value = '';
    showDone(`Imported ${importedCount} item(s)${skippedCount ? ` (${skippedCount} skipped)` : ''}!`, async () => {
      await loadBootstrap();
    });
  } catch (err) {
    input.value = '';
    hideLoading();
    toast('CSV import failed: ' + err.message, 'danger');
  }
}

function renderAdminMenuTable() {
  const tbody = $('menuTableBody');
  if (!tbody) return;
  const catById = {};
  (state.categories || []).forEach(c => { catById[c.CategoryID] = c; });

  const searchTerm = ($('adminMenuSearch')?.value || '').trim().toLowerCase();
  const catFilter = $('adminMenuCatFilter')?.value || 'ALL';

  const filtered = (state.menu || []).filter(m => {
    const name = String(m.ItemName || m.Name || '').toLowerCase();
    const station = String(m.Station || '').toLowerCase();
    const catName = String(catById[m.CategoryID]?.CategoryName || m.Category || '').toLowerCase();
    const matchesSearch = !searchTerm || name.includes(searchTerm) || station.includes(searchTerm) || catName.includes(searchTerm);
    const matchesCat = catFilter === 'ALL' || String(m.CategoryID) === String(catFilter);
    return matchesSearch && matchesCat;
  });

  if ($('adminMenuCountBadge')) {
    $('adminMenuCountBadge').textContent = `${filtered.length} of ${(state.menu || []).length} items`;
  }

  setHtml(tbody, filtered.length ? filtered.map(m => {
    const id = m.MenuItemID || m.ItemID;
    const name = m.ItemName || m.Name || 'Unnamed Item';
    const price = resolveMenuPrice(m);
    const isAvail = m.Available !== false && m.Available !== 'false';
    return `<tr>
      <td>${m.ImageURL ? `<img src="${escapeHtml(m.ImageURL)}" class="img-preview-thumb">` : `<div class="img-preview-thumb d-flex align-items-center justify-content-center text-muted"><i class="fa-solid fa-utensils"></i></div>`}</td>
      <td><strong>${escapeHtml(name)}</strong></td>
      <td>${escapeHtml(catById[m.CategoryID]?.CategoryName || m.Category || '')}</td>
      <td><strong>${curr()}${price.toFixed(2)}</strong></td>
      <td><span class="badge bg-dark">${escapeHtml(m.Station || 'Kitchen')}</span></td>
      <td>${isAvail ? '<span class="badge bg-success">Available</span>' : '<span class="badge bg-danger">Unavailable</span>'}</td>
      <td class="text-end text-nowrap">
        <button class="btn btn-sm btn-outline-primary fw-bold me-1" onclick="editMenuItemById('${escapeHtml(id)}')"><i class="fa-solid fa-pen-to-square me-1"></i>Edit</button>
        <button class="btn btn-sm btn-outline-danger fw-bold" onclick="deleteMenuItemById('${escapeHtml(id)}', '${escapeHtml(name)}')"><i class="fa-solid fa-trash me-1"></i>Delete</button>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="7" class="text-center text-muted py-3">No menu items match your filter.</td></tr>`);
}

async function deleteCategoryById(catId, catName) {
  if (!confirm(`Delete category "${catName}"?`)) return;
  try {
    showLoading(`Deleting category ${catName}…`);
    const res = await callServer('deleteCategory', state.token, catId);
    showDone(res.message || 'Category deleted!', async () => {
      if ($('adminMenuCatFilter')?.value === catId) $('adminMenuCatFilter').value = 'ALL';
      await loadBootstrap();
    });
  } catch (err) {
    hideLoading();
    toast(err.message, 'danger');
  }
}

function resetTableForm() { $('cfgTableId').value = ''; $('cfgTableName').value = ''; $('cfgTableCapacity').value = 4; }
function editTableById(tableId) {
  const t = (state.tables || []).find(x => x.TableID === tableId);
  if (!t) return;
  $('cfgTableId').value = t.TableID; $('cfgTableName').value = t.TableNumber; $('cfgTableCapacity').value = t.Capacity || 4;
}
async function deleteTableById(tableId, tableNumber) {
  if (!confirm(`Delete "${tableNumber}"?`)) return;
  try {
    showLoading(`Deleting ${tableNumber}…`);
    const res = await callServer('deleteTable', state.token, tableId);
    showDone(res.message, () => { loadBootstrap(); poll(true); });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

function syncUserRoleDropdown() {
  const roleSel = $('cfgUserRole');
  if (!roleSel) return;
  const isManager = state.user?.role === 'Manager';
  const roles = isManager
    ? ['Manager', 'Waiter', 'Counter', 'Kitchen']
    : ['Admin', 'Manager', 'Waiter', 'Counter', 'Kitchen'];
  const currentVal = roleSel.value;
  roleSel.innerHTML = roles.map(r => `<option value="${r}">${r}</option>`).join('');
  if (roles.includes(currentVal)) roleSel.value = currentVal;
  else roleSel.value = 'Waiter';
}

function populateAdminForms() {
  if (!state.user || !['Admin', 'Manager'].includes(state.user.role)) return;
  $('cfgRestaurantName').value = state.settings.RESTAURANT_NAME || '';
  $('cfgTaxRate').value = state.settings.TAX_RATE_PERCENT ?? 12;
  $('cfgServiceCharge').value = state.settings.SERVICE_CHARGE_PERCENT ?? 5;
  $('cfgSeniorPwdDiscount').value = state.settings.SENIOR_PWD_DISCOUNT_PERCENT ?? 20;
  $('cfgEnableTax').checked = state.settings.ENABLE_TAX !== 'false';
  $('cfgVatInclusive').checked = state.settings.VAT_INCLUSIVE !== 'false';
  $('cfgEnableServiceCharge').checked = state.settings.ENABLE_SERVICE_CHARGE !== 'false';
  $('cfgDisableKds').checked = isKdsDisabled();
  $('cfgCurrency').value = state.settings.CURRENCY_SYMBOL || '₱';
  $('cfgTimezone').value = state.settings.TIMEZONE || 'Asia/Manila';
  $('cfgReceiptFooter').value = state.settings.RECEIPT_FOOTER || '';

  const catList = state.categories || [];
  $('cfgMenuCategory').innerHTML = catList.map(c => `<option value="${escapeHtml(c.CategoryID)}">${escapeHtml(c.CategoryName)}</option>`).join('');

  const filterSel = $('adminMenuCatFilter');
  if (filterSel) {
    const prevFilter = filterSel.value || 'ALL';
    filterSel.innerHTML = `<option value="ALL">All Categories</option>` +
      catList.map(c => `<option value="${escapeHtml(c.CategoryID)}">${escapeHtml(c.CategoryName)}</option>`).join('');
    filterSel.value = catList.some(c => String(c.CategoryID) === prevFilter) ? prevFilter : 'ALL';
  }

  renderAdminMenuTable();

  setHtml($('tablesTableBody'), (state.tables || []).map(t => `<tr>
    <td><strong>${escapeHtml(t.TableNumber)}</strong></td>
    <td>${escapeHtml(t.Capacity)} seats</td>
    <td><span class="badge bg-secondary">${escapeHtml(t.Status)}</span></td>
    <td class="text-end">
      <button class="btn btn-sm btn-outline-primary fw-bold me-1" onclick="editTableById('${escapeHtml(t.TableID)}')">Edit</button>
      <button class="btn btn-sm btn-outline-danger fw-bold" onclick="deleteTableById('${escapeHtml(t.TableID)}', '${escapeHtml(t.TableNumber)}')">Delete</button>
    </td>
  </tr>`).join(''));

  setHtml($('categoriesList'), catList.length ? catList.map(c => {
    const itemCount = (state.menu || []).filter(m => String(m.CategoryID) === String(c.CategoryID)).length;
    return `<div class="d-flex justify-content-between align-items-center border-bottom py-2">
      <div>
        <strong>${escapeHtml(c.CategoryName)}</strong>
        <small class="text-muted ms-1">${escapeHtml(c.Description || '')}</small>
      </div>
      <div class="d-flex align-items-center gap-2">
        <span class="badge bg-light text-dark border">${itemCount} item${itemCount === 1 ? '' : 's'}</span>
        <span class="badge bg-info">Sort ${escapeHtml(c.SortOrder)}</span>
        <button class="btn btn-sm btn-outline-danger fw-bold" onclick="deleteCategoryById('${escapeHtml(c.CategoryID)}', '${escapeHtml(c.CategoryName)}')"><i class="fa-solid fa-trash me-1"></i>Delete</button>
      </div>
    </div>`;
  }).join('') : '<div class="text-muted small py-2">No categories configured yet.</div>');

  syncUserRoleDropdown();

  const isManager = state.user.role === 'Manager';
  const branchMap = {}; (state.branches || []).forEach(b => { branchMap[b.BranchID] = b.BranchName; });
  setHtml($('usersTableBody'), (state.users || []).map(u => {
    const isSelf = state.user && String(state.user.userId) === String(u.UserID);
    const isPrimaryAdmin = String(u.Username || '').toLowerCase() === 'admin';
    const isTargetAdmin = u.Role === 'Admin';
    const lockedForManager = isManager && isTargetAdmin;

    const editBtn = lockedForManager
      ? `<button class="btn btn-sm btn-outline-secondary fw-bold me-1" disabled title="Managers cannot edit Admin accounts"><i class="fa-solid fa-lock me-1"></i>Admin</button>`
      : `<button class="btn btn-sm btn-outline-primary fw-bold me-1" onclick="editUserRow('${escapeHtml(u.UserID)}')"><i class="fa-solid fa-pen-to-square me-1"></i>Edit</button>`;

    const delBtn = (isSelf || isPrimaryAdmin || lockedForManager)
      ? `<button class="btn btn-sm btn-outline-secondary fw-bold" disabled title="${lockedForManager ? 'Managers cannot delete Admin accounts' : (isSelf ? 'Cannot delete current user' : 'Primary admin cannot be deleted')}"><i class="fa-solid fa-lock"></i></button>`
      : `<button class="btn btn-sm btn-outline-danger fw-bold" onclick="deleteUserById('${escapeHtml(u.UserID)}', '${escapeHtml(u.FullName)}')"><i class="fa-solid fa-trash me-1"></i>Delete</button>`;

    return `<tr>
      <td>${escapeHtml(u.FullName)}</td>
      <td>${escapeHtml(u.Username)}</td>
      <td class="small">${u.Email ? escapeHtml(u.Email) : '<span class="text-muted">—</span>'}</td>
      <td><span class="badge ${isTargetAdmin ? 'bg-danger' : 'bg-primary'}">${escapeHtml(u.Role)}</span></td>
      <td>${escapeHtml(branchMap[u.BranchID] || (u.Role === 'Admin' ? 'All Branches' : 'Main'))}</td>
      <td>${u.Active ? '✓' : '✗'}</td>
      <td class="small text-muted">${u.LastLogin ? new Date(u.LastLogin).toLocaleString() : '—'}</td>
      <td class="text-end text-nowrap">
        ${editBtn}
        ${delBtn}
      </td>
    </tr>`;
  }).join(''));
}

function editUserRow(uid) {
  const u = (state.users || []).find(x => x.UserID === uid);
  if (!u) return;
  if (state.user?.role === 'Manager' && u.Role === 'Admin') {
    return toast('Managers are not permitted to edit Admin accounts.', 'warning');
  }
  syncUserRoleDropdown();
  $('cfgUserId').value = u.UserID;
  $('cfgUserFullName').value = u.FullName;
  $('cfgUserUsername').value = u.Username;
  if ($('cfgUserEmail')) $('cfgUserEmail').value = u.Email || '';
  $('cfgUserPassword').value = '';
  $('cfgUserRole').value = u.Role;
  if ($('cfgUserBranch')) $('cfgUserBranch').value = u.BranchID || '';
  if ($('cfgUserFormTitle')) $('cfgUserFormTitle').textContent = `Edit User (${u.FullName})`;
}

function resetUserForm() {
  syncUserRoleDropdown();
  $('cfgUserId').value = '';
  $('cfgUserFullName').value = '';
  $('cfgUserUsername').value = '';
  if ($('cfgUserEmail')) $('cfgUserEmail').value = '';
  $('cfgUserPassword').value = '';
  $('cfgUserRole').value = 'Waiter';
  if ($('cfgUserBranch')) $('cfgUserBranch').value = state.activeBranchId || '';
  if ($('cfgUserFormTitle')) $('cfgUserFormTitle').textContent = 'Add / Edit User';
}

async function deleteUserById(userId, fullName) {
  const target = (state.users || []).find(x => String(x.UserID) === String(userId));
  if (state.user?.role === 'Manager' && target && target.Role === 'Admin') {
    return toast('Managers cannot delete Admin accounts.', 'warning');
  }
  if (!confirm(`Delete user "${fullName}"? Their active sessions will be terminated immediately.`)) return;
  try {
    showLoading(`Deleting ${fullName}…`);
    const res = await callServer('deleteUser', state.token, userId);
    if ($('cfgUserId').value === userId) resetUserForm();
    showDone(res.message || 'User deleted!', () => loadBootstrap());
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

function onToggleDisableKds(el) {
  if (el.checked && !confirm('Disable the Kitchen Display System?')) el.checked = false;
}

async function saveSettings(e) {
  e.preventDefault();
  try {
    showLoading('Saving branch settings…');
    await callServer('saveSystemSettings', state.token, {
      RESTAURANT_NAME: $('cfgRestaurantName').value, TAX_RATE_PERCENT: $('cfgTaxRate').value,
      SERVICE_CHARGE_PERCENT: $('cfgServiceCharge').value, SENIOR_PWD_DISCOUNT_PERCENT: $('cfgSeniorPwdDiscount').value,
      ENABLE_TAX: $('cfgEnableTax').checked ? 'true' : 'false', VAT_INCLUSIVE: $('cfgVatInclusive').checked ? 'true' : 'false',
      ENABLE_SERVICE_CHARGE: $('cfgEnableServiceCharge').checked ? 'true' : 'false', DISABLE_KDS: $('cfgDisableKds').checked ? 'true' : 'false',
      CURRENCY_SYMBOL: $('cfgCurrency').value, TIMEZONE: $('cfgTimezone').value, RECEIPT_FOOTER: $('cfgReceiptFooter').value
    });
    showDone('Settings saved!', () => { loadBootstrap(); poll(true); });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

async function saveTable(e) {
  e.preventDefault();
  try {
    showLoading('Saving table…');
    await callServer('saveTable', state.token, { TableID: $('cfgTableId').value, TableNumber: $('cfgTableName').value, Capacity: $('cfgTableCapacity').value });
    showDone('Table saved!', () => { resetTableForm(); loadBootstrap(); poll(true); });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

async function saveCategory(e) {
  e.preventDefault();
  try {
    showLoading('Saving…');
    await callServer('saveCategory', state.token, { CategoryName: $('cfgCatName').value, Description: $('cfgCatDesc').value });
    showDone('Category saved!', () => { $('cfgCatName').value = ''; $('cfgCatDesc').value = ''; loadBootstrap(); });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

async function saveUser(e) {
  e.preventDefault();
  const role = $('cfgUserRole').value;
  if (state.user?.role === 'Manager' && role === 'Admin') {
    return toast('Managers are not allowed to assign the Admin role.', 'warning');
  }
  try {
    showLoading('Saving…');
    await callServer('saveUser', state.token, {
      UserID: $('cfgUserId').value,
      FullName: $('cfgUserFullName').value,
      Username: $('cfgUserUsername').value,
      Email: $('cfgUserEmail')?.value.trim() || '',
      Password: $('cfgUserPassword').value,
      Role: role,
      BranchID: $('cfgUserBranch')?.value || null
    });
    showDone('User saved!', () => { resetUserForm(); loadBootstrap(); });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

async function loadAdminStats() {
  try {
    const data = await callServer('getSalesReport', state.token, { summaryOnly: true });
    $('statSales').textContent = `${curr()}${(data.totalSales || 0).toFixed(2)}`;
    $('statOrders').textContent = data.totalOrders || 0;
    $('statAvg').textContent = `${curr()}${(data.averageOrderValue || 0).toFixed(2)}`;
    $('statTax').textContent = `${curr()}${(data.totalTax || 0).toFixed(2)}`;
  } catch (e) {}
}

async function loadActivityLogs() {
  try {
    const logs = await callServer('getActivityLog', state.token, { limit: 300 });
    $('logsTableBody').innerHTML = (logs || []).map(l => `<tr><td class="small">${new Date(l.Timestamp).toLocaleString()}</td><td class="small">${escapeHtml(l.UserID)}</td><td>${escapeHtml(l.Action)}</td><td>${escapeHtml(l.EntityType)} ${escapeHtml(l.EntityID || '')}</td><td class="small text-muted">${escapeHtml(String(l.NewValue || '').slice(0, 80))}</td></tr>`).join('');
  } catch (e) {}
}

let _lastSalesReport = null;
function shiftDate(str, days) { const d = new Date(str + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function setReportRange(kind) {
  const today = todayStr(); let s = '', e = '';
  if (kind === 'today') { s = today; e = today; }
  else if (kind === '7d') { s = shiftDate(today, -6); e = today; }
  else if (kind === 'month') { s = today.slice(0, 8) + '01'; e = today; }
  $('reportStart').value = s; $('reportEnd').value = e;
  loadSalesReport();
}

async function loadSalesReport() {
  try {
    showLoading('Generating report…');
    const allBranches = ($('reportBranchScope')?.value === 'ALL') && state.user?.role === 'Admin';
    const data = await callServer('getSalesReport', state.token, {
      startDate: $('reportStart').value,
      endDate: $('reportEnd').value,
      allBranches
    });
    _lastSalesReport = data;
    const c = data.currency || curr(), fmt = n => `${c}${Number(n || 0).toFixed(2)}`;
    const t = data.totals || {}, cnt = data.counts || {};
    const activeBr = (state.branches || []).find(b => b.BranchID === state.activeBranchId);
    if ($('reportScopeBadge')) {
      $('reportScopeBadge').textContent = allBranches ? 'All Branches (Consolidated)' : (activeBr ? `${activeBr.BranchName} (${activeBr.BranchCode})` : 'Current Branch');
    }

    $('reportSummary').innerHTML = `
      <div class="row g-2 mb-2">
        <div class="col-6 col-md-3"><div class="stat-card bg-primary"><h6>Total Sales</h6><h4>${fmt(t.sales)}</h4></div></div>
        <div class="col-6 col-md-3"><div class="stat-card bg-success"><h6>Paid Orders</h6><h4>${cnt.paid || 0}</h4></div></div>
        <div class="col-6 col-md-3"><div class="stat-card bg-warning"><h6>Avg Order</h6><h4>${fmt(data.averageOrderValue)}</h4></div></div>
        <div class="col-6 col-md-3"><div class="stat-card bg-info"><h6>Items Sold</h6><h4>${t.items || 0}</h4></div></div>
      </div>
      <div class="table-responsive"><table class="table table-sm table-bordered mb-0">
        <tr><th>Gross Subtotal</th><td>${fmt(t.subtotal)}</td><th>Discounts</th><td class="text-danger">-${fmt(t.discount)}</td><th>Tax</th><td>${fmt(t.tax)}</td></tr>
        <tr><th>Service Charge</th><td>${fmt(t.service)}</td><th>Cancelled / Voided</th><td>${cnt.cancelled || 0}</td><th>Open Orders</th><td>${cnt.open || 0}</td></tr>
      </table></div>`;

    if (allBranches) {
      const bRows = (data.branchBreakdown || []).map(b => `<tr>
        <td><strong>${escapeHtml(b.branchName)}</strong></td>
        <td class="text-end">${b.orders}</td>
        <td class="text-end">${fmt(b.subtotal)}</td>
        <td class="text-end text-danger">-${fmt(b.discount)}</td>
        <td class="text-end">${fmt(b.tax)}</td>
        <td class="text-end">${fmt(b.avgOrder)}</td>
        <td class="text-end fw-bold text-primary">${fmt(b.sales)}</td>
        <td class="text-end"><span class="badge bg-primary">${b.share}%</span></td>
      </tr>`).join('');
      $('reportBranchComparison').innerHTML = `
        <h6 class="mt-3 fw-bold"><i class="fa-solid fa-store text-primary me-1"></i>Branch Sales Breakdown</h6>
        <div class="table-responsive">
          <table class="table table-sm table-hover align-middle">
            <thead>
              <tr>
                <th>Branch</th>
                <th class="text-end">Orders</th>
                <th class="text-end">Gross</th>
                <th class="text-end">Discounts</th>
                <th class="text-end">Tax</th>
                <th class="text-end">Avg Order</th>
                <th class="text-end">Total Sales</th>
                <th class="text-end">Share</th>
              </tr>
            </thead>
            <tbody>${bRows || '<tr><td colspan="8" class="text-muted text-center">No branch sales recorded.</td></tr>'}</tbody>
          </table>
        </div>`;
    } else {
      $('reportBranchComparison').innerHTML = '';
    }

    $('reportPaymentMethods').innerHTML = `<h6 class="mt-3 fw-bold">Payment Method Breakdown</h6><table class="table table-sm"><thead><tr><th>Method</th><th class="text-end">Orders</th><th class="text-end">Total</th><th class="text-end">Share</th></tr></thead><tbody>${(data.paymentBreakdown || []).map(p => `<tr><td>${escapeHtml(p.method)}</td><td class="text-end">${p.orders}</td><td class="text-end">${fmt(p.sales)}</td><td class="text-end">${p.share}%</td></tr>`).join('') || '<tr><td colspan="4" class="text-muted">No paid orders.</td></tr>'}</tbody></table>`;
    $('reportTopItems').innerHTML = `<table class="table table-sm"><thead><tr><th>#</th><th>Item</th><th class="text-end">Qty</th><th class="text-end">Avg Price</th><th class="text-end">Sales</th><th class="text-end">Share</th></tr></thead><tbody>${(data.topItems || []).map((x, idx) => `<tr><td>${idx + 1}</td><td>${escapeHtml(x.name)}</td><td class="text-end">${x.quantity}</td><td class="text-end">${fmt(x.avgPrice)}</td><td class="text-end">${fmt(x.sales)}</td><td class="text-end">${x.share}%</td></tr>`).join('') || '<tr><td colspan="6" class="text-muted">No items sold.</td></tr>'}</tbody></table>`;
    $('reportDaily').innerHTML = `<table class="table table-sm"><thead><tr><th>Date</th><th class="text-end">Orders</th><th class="text-end">Subtotal</th><th class="text-end">Discount</th><th class="text-end">Tax</th><th class="text-end">Service</th><th class="text-end">Total</th></tr></thead><tbody>${(data.daily || []).map(d => `<tr><td>${escapeHtml(d.date)}</td><td class="text-end">${d.orders}</td><td class="text-end">${fmt(d.subtotal)}</td><td class="text-end">-${fmt(d.discount)}</td><td class="text-end">${fmt(d.tax)}</td><td class="text-end">${fmt(d.service)}</td><td class="text-end fw-bold">${fmt(d.sales)}</td></tr>`).join('') || '<tr><td colspan="7" class="text-muted">No sales in selected range.</td></tr>'}</tbody></table>`;
    $('reportOrders').innerHTML = `<div class="table-responsive" style="max-height:360px; overflow:auto;"><table class="table table-sm table-hover"><thead><tr><th>Date</th><th>Time</th>${allBranches ? '<th>Branch</th>' : ''}<th>Order #</th><th>Table</th><th>Customer</th><th>Payment</th><th class="text-end">Items</th><th class="text-end">Subtotal</th><th class="text-end">Discount</th><th class="text-end">Tax</th><th class="text-end">Service</th><th class="text-end">Total</th></tr></thead><tbody>${(data.orders || []).map(o => `<tr><td class="small">${escapeHtml(o.date)}</td><td class="small">${escapeHtml(o.time)}</td>${allBranches ? `<td class="small"><span class="badge bg-dark">${escapeHtml(o.branch)}</span></td>` : ''}<td><strong>${escapeHtml(o.orderNumber)}</strong></td><td>${escapeHtml(o.table)}</td><td>${escapeHtml(o.customer)}</td><td class="small">${escapeHtml(o.method)}</td><td class="text-end">${o.itemQty}</td><td class="text-end">${fmt(o.subtotal)}</td><td class="text-end">-${fmt(o.discount)}</td><td class="text-end">${fmt(o.tax)}</td><td class="text-end">${fmt(o.service)}</td><td class="text-end fw-bold">${fmt(o.total)}</td></tr>`).join('') || `<tr><td colspan="${allBranches ? 13 : 12}" class="text-muted">No paid orders.</td></tr>`}</tbody></table></div>`;
    hideLoading();
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

function printSalesReport() {
  if (!_lastSalesReport) return toast('Generate a sales report first.', 'warning');
  const d = _lastSalesReport, c = d.currency || curr(), fmt = n => `${c}${Number(n || 0).toFixed(2)}`;
  const t = d.totals || {}, cnt = d.counts || {};
  const activeBr = (state.branches || []).find(b => b.BranchID === state.activeBranchId);
  const scopeTitle = d.allBranches ? 'ALL BRANCHES (CONSOLIDATED)' : (activeBr ? `${activeBr.BranchName} (${activeBr.BranchCode})` : 'CURRENT BRANCH');
  const r = (a, b, bold) => `<div style="display:flex; justify-content:space-between;${bold ? ' font-weight:bold; font-size:1.05em;' : ''}"><span>${a}</span><span>${b}</span></div>`;

  const branchSection = d.allBranches ? `
    <div style="border-bottom:1px dashed #000; margin:6px 0;"></div>
    <div style="font-weight:bold;">BY BRANCH</div>
    ${(d.branchBreakdown || []).map(b => r(`${escapeHtml(b.branchName)} (${b.orders})`, `${fmt(b.sales)} (${b.share}%)`)).join('') || '<div>None</div>'}
  ` : '';

  const body = `
    <div style="text-align:center; font-weight:bold; font-size:1.1em;">${escapeHtml(state.settings.RESTAURANT_NAME || 'Tuna Choice POS')}</div>
    <div style="text-align:center; font-weight:bold;">SALES REPORT</div>
    <div style="text-align:center; font-size:0.85em;">${escapeHtml(scopeTitle)}</div>
    <div style="text-align:center; font-size:0.85em;">${escapeHtml(d.range?.start || 'All Time')} to ${escapeHtml(d.range?.end || 'Present')}</div>
    <div style="border-bottom:1px dashed #000; margin:6px 0;"></div>
    ${r('Paid Orders', cnt.paid || 0)}${r('Cancelled / Voided', cnt.cancelled || 0)}${r('Open Orders', cnt.open || 0)}${r('Items Sold', t.items || 0)}
    <div style="border-bottom:1px dashed #000; margin:6px 0;"></div>
    ${r('Gross Subtotal', fmt(t.subtotal))}${r('Discounts', '-' + fmt(t.discount))}${r('Tax', fmt(t.tax))}${r('Service Charge', fmt(t.service))}
    <div style="border-bottom:1px dashed #000; margin:6px 0;"></div>
    ${r('TOTAL SALES', fmt(t.sales), true)}${r('Average Order', fmt(d.averageOrderValue))}
    ${branchSection}
    <div style="border-bottom:1px dashed #000; margin:6px 0;"></div>
    <div style="font-weight:bold;">BY PAYMENT METHOD</div>${(d.paymentBreakdown || []).map(p => r(`${escapeHtml(p.method)} (${p.orders})`, fmt(p.sales))).join('') || '<div>None</div>'}
    <div style="border-bottom:1px dashed #000; margin:6px 0;"></div>
    <div style="font-weight:bold;">TOP SELLING ITEMS</div>${(d.topItems || []).slice(0, 15).map(x => r(`${x.quantity}x ${escapeHtml(x.name)}`, fmt(x.sales))).join('') || '<div>None</div>'}
    <div style="border-bottom:1px dashed #000; margin:6px 0;"></div>
    <div style="text-align:center; font-size:0.85em;">Printed ${new Date().toLocaleString()}</div>`;
  printHtmlDocument('Sales Report', body);
}

function exportSalesReportCsv() {
  if (!_lastSalesReport) return toast('Generate a sales report first.', 'warning');
  const d = _lastSalesReport, esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Date', 'Time', 'Branch', 'Order #', 'Table', 'Customer', 'Payment Method', 'Items', 'Subtotal', 'Discount', 'Tax', 'Service Charge', 'Total'].map(esc).join(',')];
  (d.orders || []).forEach(o => lines.push([o.date, o.time, o.branch, o.orderNumber, o.table, o.customer, o.method, o.itemQty, o.subtotal.toFixed(2), o.discount.toFixed(2), o.tax.toFixed(2), o.service.toFixed(2), o.total.toFixed(2)].map(esc).join(',')));
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(lines.join('\n'));
  a.download = `sales_report_${d.allBranches ? 'ALL_BRANCHES' : (state.activeBranchId || 'branch')}_${d.range?.start || 'all'}_to_${d.range?.end || 'now'}.csv`;
  a.click();
}

/* ============================================================
   END OF DAY Z-READING REPORT, CASH DRAWER & POS CLOSE
   ============================================================ */
function buildEODReceiptHtml(r) {
  const c = r.currency || curr();
  const fmt = n => `${c}${Number(n || 0).toFixed(2)}`;
  const row = (l, v, bold) => `<div style="display:flex; justify-content:space-between; margin:2px 0;${bold ? ' font-weight:bold;' : ''}"><span>${l}</span><span>${v}</span></div>`;
  const cd = r.cashDrawer || {};
  const hasActual = cd.actualCash !== null && cd.actualCash !== undefined;
  const varianceVal = hasActual ? Number(cd.variance || 0) : 0;
  const varianceLabel = !hasActual
    ? 'Not Counted'
    : (Math.abs(varianceVal) < 0.005
      ? `${fmt(0)} (BALANCED)`
      : (varianceVal > 0 ? `+${fmt(varianceVal)} (OVER)` : `-${fmt(Math.abs(varianceVal))} (SHORT)`));
  const varianceColor = !hasActual ? '#64748b' : (Math.abs(varianceVal) < 0.005 ? '#16a34a' : (varianceVal > 0 ? '#0284c7' : '#dc2626'));

  return `
    <div style="text-align:center; font-weight:bold; font-size:1.12rem;">${escapeHtml(r.restaurantName || 'Tuna Choice POS')}</div>
    <div style="text-align:center; font-size:0.82rem; font-weight:bold;">${escapeHtml(r.branchName || '')}</div>
    ${r.branchAddress ? `<div style="text-align:center; font-size:0.75rem;">${escapeHtml(r.branchAddress)}</div>` : ''}
    <div style="border-bottom:2px solid #000; margin:6px 0;"></div>
    <div style="text-align:center; font-weight:bold; font-size:0.98rem;">END OF DAY Z-READING</div>
    <div style="text-align:center; font-size:0.78rem;">Report #: ${escapeHtml(r.reportNo || '')}</div>
    <div style="border-bottom:1px dashed #000; margin:6px 0;"></div>
    <div style="font-size:0.78rem;">
      ${row('Business Date:', escapeHtml(r.date))}
      ${row('Printed At:', escapeHtml(r.printedAt || new Date().toLocaleString()))}
      ${row('Generated By:', escapeHtml(r.generatedBy || 'Admin'))}
    </div>
    <div style="border-bottom:1px dashed #000; margin:6px 0;"></div>
    <div style="font-size:0.8rem;">
      <div style="font-weight:bold; margin-bottom:2px;">TRANSACTION SUMMARY</div>
      ${row('Paid Transactions:', r.counts?.paid || 0)}
      ${row('Cancelled / Voided:', r.counts?.cancelled || 0)}
      ${row('Open / Unpaid Orders:', r.counts?.open || 0)}
      ${row('Total Items Sold:', r.counts?.itemsQty || 0)}
    </div>
    <div style="border-bottom:1px dashed #000; margin:6px 0;"></div>
    <div style="font-size:0.8rem;">
      <div style="font-weight:bold; margin-bottom:2px;">SALES &amp; TAX BREAKDOWN</div>
      ${row('Gross Sales (Subtotal):', fmt(r.totals?.subtotal))}
      ${Number(r.totals?.lessVat || 0) > 0 ? row('Less VAT (SC/PWD):', '-' + fmt(r.totals?.lessVat)) : ''}
      ${row('Total Discounts:', '-' + fmt(r.totals?.discount))}
      ${Number(r.totals?.serviceCharge || 0) > 0 ? row('Service Charge:', fmt(r.totals?.serviceCharge)) : ''}
      ${row('VATable Sales:', fmt(r.totals?.vatableSales))}
      ${row('VAT-Exempt Sales:', fmt(r.totals?.vatExemptSales))}
      ${row('VAT Amount:', fmt(r.totals?.tax))}
      <div style="border-top:1px solid #000; margin-top:4px; padding-top:4px; font-size:0.95rem;">
        ${row('NET TOTAL SALES:', fmt(r.totals?.sales), true)}
      </div>
    </div>
    <div style="border-bottom:1px dashed #000; margin:6px 0;"></div>
    <div style="font-size:0.8rem;">
      <div style="font-weight:bold; margin-bottom:2px;">TENDER / PAYMENT BREAKDOWN</div>
      ${(r.paymentBreakdown || []).map(p => row(`${escapeHtml(p.method)} (${p.count})`, fmt(p.total))).join('') || '<div style="color:#666;">No paid transactions</div>'}
      <div style="border-top:1px dashed #999; margin-top:4px; padding-top:3px;">
        ${row('Total Amount Tendered:', fmt(r.totalCollected))}
        ${row('Total Change Given:', fmt(r.totalChange))}
      </div>
    </div>
    <div style="border-bottom:1px dashed #000; margin:6px 0;"></div>
    <div style="font-size:0.8rem;">
      <div style="font-weight:bold; margin-bottom:2px;">CASH DRAWER RECONCILIATION</div>
      ${row('Opening Cash Float:', fmt(cd.openingFloat))}
      ${row('(+) Cash Sales:', fmt(cd.cashSales))}
      ${row('Expected Cash in Drawer:', fmt(cd.expectedCash), true)}
      ${row('Actual Cash Counted:', hasActual ? fmt(cd.actualCash) : '—')}
      <div style="display:flex; justify-content:space-between; margin:3px 0; font-weight:bold; color:${varianceColor};">
        <span>Over / (Short) Variance:</span>
        <span>${varianceLabel}</span>
      </div>
    </div>
    <div style="border-bottom:1px dashed #000; margin:6px 0;"></div>
    <div style="font-size:0.78rem;">
      <div style="font-weight:bold; margin-bottom:2px;">ITEMS SOLD SUMMARY</div>
      ${(r.itemsSold || []).map(i => row(`${i.quantity}x ${escapeHtml(i.name)}`, fmt(i.total))).join('') || '<div style="color:#666;">None</div>'}
    </div>
    <div style="border-bottom:2px solid #000; margin:8px 0;"></div>
    <div style="text-align:center; font-size:0.75rem;">*** END OF Z-READING REPORT ***</div>`;
}

function renderEODReportHtml(r) {
  const c = r.currency || curr();
  const fmt = n => `${c}${Number(n || 0).toFixed(2)}`;
  const cd = r.cashDrawer || {};
  const hasActual = cd.actualCash !== null && cd.actualCash !== undefined;
  const varianceVal = hasActual ? Number(cd.variance || 0) : 0;
  const varianceBadge = !hasActual
    ? '<span class="badge bg-secondary">Enter Actual Cash above to check variance</span>'
    : (Math.abs(varianceVal) < 0.005
      ? `<span class="badge bg-success">${fmt(0)} — BALANCED</span>`
      : (varianceVal > 0
        ? `<span class="badge bg-info text-dark">+${fmt(varianceVal)} — OVER</span>`
        : `<span class="badge bg-danger">-${fmt(Math.abs(varianceVal))} — SHORT</span>`));

  const openBadge = $('eodOpenWarningBadge');
  if (openBadge) {
    if ((r.counts?.open || 0) > 0) {
      openBadge.style.display = 'inline-block';
      openBadge.textContent = `${r.counts.open} Open Order(s) Remaining`;
    } else {
      openBadge.style.display = 'none';
    }
  }

  $('eodReport').innerHTML = `
    <div class="row g-3 align-items-start">
      <div class="col-lg-5">
        <div class="receipt-preview shadow-sm" id="eodThermalPreviewBox">
          ${buildEODReceiptHtml(r)}
        </div>
      </div>
      <div class="col-lg-7">
        <div class="row g-2 mb-3">
          <div class="col-6 col-md-4"><div class="stat-card bg-primary"><h6>Net Sales</h6><h4>${fmt(r.totals?.sales)}</h4></div></div>
          <div class="col-6 col-md-4"><div class="stat-card bg-success"><h6>Paid Orders</h6><h4>${r.counts?.paid || 0}</h4></div></div>
          <div class="col-6 col-md-4"><div class="stat-card bg-info"><h6>Items Sold</h6><h4>${r.counts?.itemsQty || 0}</h4></div></div>
        </div>

        <div class="card border mb-3">
          <div class="card-header bg-light fw-bold d-flex justify-content-between align-items-center">
            <span><i class="fa-solid fa-cash-register text-success me-2"></i>Cash Drawer Reconciliation</span>
            ${varianceBadge}
          </div>
          <div class="card-body p-2">
            <table class="table table-sm mb-0">
              <tbody>
                <tr><td>Opening Cash Float</td><td class="text-end fw-semibold">${fmt(cd.openingFloat)}</td></tr>
                <tr><td>(+) Cash Sales</td><td class="text-end fw-semibold text-success">${fmt(cd.cashSales)}</td></tr>
                <tr class="table-light"><td><strong>Expected Cash in Drawer</strong></td><td class="text-end fw-bold">${fmt(cd.expectedCash)}</td></tr>
                <tr><td>Actual Cash Counted</td><td class="text-end fw-semibold">${hasActual ? fmt(cd.actualCash) : '<span class="text-muted">Not entered</span>'}</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="card border mb-3">
          <div class="card-header bg-light fw-bold"><i class="fa-solid fa-wallet text-primary me-2"></i>Tender Breakdown</div>
          <div class="card-body p-2">
            <table class="table table-sm mb-0">
              <thead><tr><th>Payment Method</th><th class="text-end">Orders</th><th class="text-end">Total</th></tr></thead>
              <tbody>
                ${(r.paymentBreakdown || []).map(p => `<tr><td>${escapeHtml(p.method)}</td><td class="text-end">${p.count}</td><td class="text-end fw-bold">${fmt(p.total)}</td></tr>`).join('') || '<tr><td colspan="3" class="text-muted text-center">No paid transactions for this date.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card border">
          <div class="card-header bg-light fw-bold"><i class="fa-solid fa-utensils text-warning me-2"></i>Items Sold (${(r.itemsSold || []).length} menu items)</div>
          <div class="card-body p-2" style="max-height:240px; overflow:auto;">
            <table class="table table-sm mb-0">
              <thead><tr><th>Item</th><th class="text-end">Qty</th><th class="text-end">Total</th></tr></thead>
              <tbody>
                ${(r.itemsSold || []).map(i => `<tr><td>${escapeHtml(i.name)}</td><td class="text-end">${i.quantity}</td><td class="text-end">${fmt(i.total)}</td></tr>`).join('') || '<tr><td colspan="3" class="text-muted text-center">No items sold.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;
}

async function loadEODReport() {
  try {
    const dateVal = $('eodDate').value || todayStr();
    saveEodDrawerValues();
    const openingFloat = getEodOpeningFloat();
    const actualCash = getEodActualCash();

    showLoading('Generating End of Day Z-Reading…');
    const r = await callServer('getEndOfDayReport', state.token, dateVal, openingFloat, actualCash);
    window._lastEOD = r;
    state.eodGenerated = dateVal;
    renderEODReportHtml(r);
    await loadEodHistory();
    hideLoading();
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

function printEODReport() {
  if (!window._lastEOD) return toast('Generate the Z-Reading report first.', 'warning');
  printHtmlDocument(`Z-Reading ${window._lastEOD.date}`, buildEODReceiptHtml(window._lastEOD));
}

async function loadEodHistory() {
  const tbody = $('eodHistoryBody');
  if (!tbody) return;
  try {
    const rows = await callServer('getEodHistory', state.token);
    const c = curr(), fmt = n => `${c}${Number(n || 0).toFixed(2)}`;
    if (!rows || !rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-muted small text-center py-2">No Z-Reading closings recorded for this branch yet.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => `<tr>
      <td><strong>${escapeHtml(r.BusinessDate || '')}</strong></td>
      <td class="small text-muted">${r.CreatedAt ? new Date(r.CreatedAt).toLocaleString() : '—'}</td>
      <td class="text-end fw-bold text-primary">${fmt(r.CashSales)}</td>
      <td class="text-end text-danger">-${fmt(r.SeniorPwdDiscounts)}</td>
      <td class="text-end">${fmt(r.VatableSales)}</td>
      <td class="text-end">${fmt(r.VatExemptSales)}</td>
      <td class="text-end">${fmt(r.VatAmount)}</td>
    </tr>`).join('');
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-muted small text-center py-2">Unable to load Z-Reading history.</td></tr>';
  }
}

async function closePOS() {
  const dateVal = $('eodDate').value || todayStr();
  if (state.eodGenerated !== dateVal || !window._lastEOD) {
    showModal('eodRequiredModal');
    return;
  }
  const openCount = window._lastEOD.counts?.open || 0;
  const warnText = openCount > 0 ? `\n\nWARNING: There are still ${openCount} open/unpaid order(s) today.` : '';
  if (!confirm(`Close POS for ${dateVal}?${warnText}\n\nThis will archive the Z-Reading report and reset all branch tables to Available.`)) return;
  try {
    showLoading('Closing POS & archiving Z-Reading…');
    const res = await callServer('archiveAndResetPOS', state.token, dateVal);
    showDone(res.message, async () => {
      await loadEodHistory();
      await poll(true);
    });
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

async function downloadZipBackup() {
  try {
    showLoading('Exporting branch backup…');
    const res = await callServer('exportDatabaseAsZip', state.token);
    hideLoading();
    if (res && res.base64Data) {
      const a = document.createElement('a');
      a.href = 'data:application/json;base64,' + res.base64Data;
      a.download = res.fileName;
      a.click();
      toast('Backup exported!', 'success');
    }
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

function openHelpModal() { showModal('helpModal'); }
function printSystemHelpGuide() {
  printHtmlDocument('System Operations Guide', '<div style="text-align:center;font-weight:bold;">Tuna Choice POS GUIDE</div><div>All screens update instantaneously via Supabase Realtime.</div>');
}
function openChangePasswordModal() { $('cpOldPw').value = ''; $('cpNewPw').value = ''; $('cpNewPw2').value = ''; showModal('changePwModal'); }
async function submitChangePassword() {
  if ($('cpNewPw').value !== $('cpNewPw2').value) return toast('Passwords do not match', 'warning');
  try {
    showLoading('Updating…');
    const r = await callServer('changePassword', state.token, $('cpOldPw').value, $('cpNewPw').value);
    if (!r.success) throw new Error(r.message);
    showDone('Password changed!', () => hideModal('changePwModal'));
  } catch (err) { hideLoading(); toast(err.message, 'danger'); }
}

function triggerDbSetup() {
  toast('Database schema is managed in Supabase SQL Editor.', 'info');
}

/* ============================================================
   BOOT SEQUENCE
   ============================================================ */
(async function boot() {
  $('loginVersion').textContent = APP_VERSION;
  try {
    if (await resumeSession()) await initSession();
  } catch (e) {}
})();
