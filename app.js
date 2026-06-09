/* ============================================================
   Mis Finanzas — lógica de la aplicación
   ============================================================ */

const STORE_KEY = 'finanzas_v1';

/* ---- Supabase ---- */
const SUPABASE_URL = 'https://qqyxbecgzyyqdpquponn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFxeXhiZWNnenl5cWRwcXVwb25uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwMTQ1NTAsImV4cCI6MjA5NjU5MDU1MH0.x_qrRIPyQxFoLRYWPVY1iwX9IZ5py-Hc-mu0cY0dORs';
const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let _saveTimer = null;
const SCHEMA_VERSION = 3; // v3: tags en transacciones, recurrentes, snapshots de patrimonio y settings

const DEFAULT_CATEGORIES = [
  'Comida', 'Supermercado', 'Transporte', 'Renta', 'Servicios',
  'Entretenimiento', 'Salud', 'Educación', 'Ropa', 'Suscripciones',
  'Salario', 'Freelance', 'Ahorro', 'Otros'
];
// Cuentas por defecto (objetos: nombre + tipo débito/crédito)
const DEFAULT_ACCOUNTS = [
  { id: 'acc-efectivo', name: 'Efectivo', kind: 'debito' },
  { id: 'acc-bbva', name: 'BBVA Débito', kind: 'debito' },
];

let state = load();

/* ---------------- Persistencia ---------------- */
function load() {
  let s;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) s = JSON.parse(raw);
  } catch (e) { console.warn('No se pudo leer el almacenamiento', e); }
  if (!s) s = { transactions: [], goals: [], debts: [], categories: [...DEFAULT_CATEGORIES], accounts: [...DEFAULT_ACCOUNTS] };
  return migrate(s);
}
// Normaliza datos viejos al esquema actual
function migrate(s) {
  s.transactions = s.transactions || [];
  s.goals = s.goals || [];
  s.debts = s.debts || [];
  s.categories = s.categories || [...DEFAULT_CATEGORIES];
  // v2: presupuestos por categoría (mapa nombre→límite mensual) y compras a MSI
  s.budgets = s.budgets || {};
  s.msi = (s.msi || []).map(m => ({ id: m.id || uid(), name: m.name || 'Compra MSI', total: parseFloat(m.total) || 0, term: parseInt(m.term) || 3, startDate: m.startDate || new Date().toISOString().slice(0, 10), account: m.account || '' }));
  // v3: tags por transacción, ajustes configurables y snapshots de patrimonio neto
  s.transactions = s.transactions.map(t => ({ ...t, tags: Array.isArray(t.tags) ? t.tags : (t.tags ? [t.tags] : []) }));
  s.settings = Object.assign({ antThreshold: 100, incomeAmount: 0, incomeFreq: 'mensual' }, s.settings || {}); // umbral de "gasto hormiga" + sueldo fijo
  s.netWorthSnapshots = s.netWorthSnapshots || {}; // { 'YYYY-MM': {assets, liabilities, net} }
  s.ignoredRecurring = Array.isArray(s.ignoredRecurring) ? s.ignoredRecurring : []; // claves de recurrentes descartados manualmente
  s.recurringMeta = (s.recurringMeta && typeof s.recurringMeta === 'object') ? s.recurringMeta : {}; // { key: { payDay, payMonth, amount, frequency, overrides:{periodo:'pagado'|'pendiente'} } }
  s.manualRecurring = Array.isArray(s.manualRecurring) ? s.manualRecurring : []; // recurrentes agregados a mano (no derivados de transacciones)
  s.version = SCHEMA_VERSION;
  // accounts: de string[] a object[]
  s.accounts = (s.accounts || []).map(a => {
    if (typeof a === 'string') return { id: uid(), name: a, kind: 'debito' };
    return { id: a.id || uid(), name: a.name, kind: a.kind || 'debito', limit: a.limit, cutDay: a.cutDay, dueDay: a.dueDay, opening: a.opening, tracksPurchases: a.tracksPurchases };
  });
  if (!s.accounts.length) s.accounts = [...DEFAULT_ACCOUNTS];
  return s;
}
function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    const { data: { user } } = await _sb.auth.getUser();
    if (!user) return;
    await _sb.from('user_data').upsert(
      { user_id: user.id, state, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
  }, 1500);
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/* ---------------- Helpers de cuentas ---------------- */
const sameAcc = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();
function accByName(name) { return state.accounts.find(a => sameAcc(a.name, name)); }
function isCredit(name) { const a = accByName(name); return a && a.kind === 'credito'; }
// Una transferencia a una tarjeta de crédito cuenta como GASTO en el resumen
// (pagas la tarjeta porque hiciste un gasto). A una cuenta de débito es ahorro (neutral).
// ¿Es esta tarjeta una en la que registramos las compras individuales? Si es así,
// el pago a la tarjeta es solo liquidación de deuda (neutral), NO un gasto nuevo.
function cardTracksPurchases(name) { const a = accByName(name); return !!(a && a.tracksPurchases); }
// Una transferencia a una tarjeta de crédito cuenta como GASTO en el resumen,
// salvo que esa tarjeta registre sus compras (entonces el gasto ya se contó en cada compra).
function isCardPayment(t) { return t.type === 'Transferencia' && isCredit(t.toAccount) && !cardTracksPurchases(t.toAccount); }

// Saldo que se debe en una tarjeta de crédito (compras − pagos − devoluciones)
function cardOwed(acc) {
  let owed = parseFloat(acc.opening) || 0;
  state.transactions.forEach(t => {
    if (t.type === 'Gasto' && sameAcc(t.account, acc.name)) owed += t.amount;
    else if (t.type === 'Ingreso' && sameAcc(t.account, acc.name)) owed -= t.amount;
    else if (t.type === 'Transferencia' && sameAcc(t.toAccount, acc.name)) owed -= t.amount;
    else if (t.type === 'Transferencia' && sameAcc(t.account, acc.name)) owed += t.amount;
  });
  return owed;
}
// Saldo disponible de una cuenta de débito
function debitBalance(acc) {
  let bal = parseFloat(acc.opening) || 0;
  state.transactions.forEach(t => {
    if (sameAcc(t.account, acc.name)) {
      if (t.type === 'Ingreso') bal += t.amount;
      else if (t.type === 'Gasto' || t.type === 'Ahorro' || t.type === 'Transferencia') bal -= t.amount;
    }
    if (t.type === 'Transferencia' && sameAcc(t.toAccount, acc.name)) bal += t.amount;
  });
  return bal;
}
// Días hasta la próxima ocurrencia de un día del mes (corte/pago)
function daysUntilDay(day) {
  if (!day) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let d = new Date(today.getFullYear(), today.getMonth(), day);
  if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, day);
  return Math.round((d - today) / 86400000);
}
function nextDateForDay(day) {
  if (!day) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let d = new Date(today.getFullYear(), today.getMonth(), day);
  if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, day);
  return d;
}
// Días sin intereses si compro HOY: días hasta el próximo corte + días del corte al pago.
// Si compro justo después del corte, la compra se va al siguiente ciclo (máximo beneficio).
function interestFreeDaysIfBuyToday(acc) {
  if (!acc.cutDay || !acc.dueDay) return null;
  const cut = nextDateForDay(acc.cutDay);          // próximo corte tras la compra de hoy
  // fecha de pago correspondiente a ESE corte: primer día de pago en/después del corte
  let due = new Date(cut.getFullYear(), cut.getMonth(), acc.dueDay);
  if (due < cut) due = new Date(cut.getFullYear(), cut.getMonth() + 1, acc.dueDay);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((due - today) / 86400000);
}

/* ---------------- Helpers de periodo / presupuesto / MSI ---------------- */
function monthKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function currentMonthKey() { return monthKey(new Date()); }
function monthLabel(key) { const [y, m] = key.split('-'); return new Date(y, m - 1, 1).toLocaleDateString('es-MX', { month: 'long', year: 'numeric' }); }

// Gasto del mes (key 'YYYY-MM') agrupado por categoría
function spentByCategory(mKey) {
  const map = {};
  state.transactions.forEach(t => {
    if (t.date.slice(0, 7) !== mKey) return;
    if (t.type === 'Gasto') {
      const k = t.category || 'Sin categoría';
      map[k] = (map[k] || 0) + t.amount;
    } else if (isCardPayment(t)) {
      // El pago a tarjeta se agrupa bajo el nombre de la tarjeta (no afecta presupuestos por categoría)
      const k = '💳 ' + (t.toAccount || 'Tarjeta');
      map[k] = (map[k] || 0) + t.amount;
    }
  });
  return map;
}

// Promedio de gasto mensual de los últimos n meses (incluye el mes actual)
function avgMonthlyExpenses(n = 3) {
  const keys = lastNMonths(n).map(m => m.key);
  let sum = 0;
  state.transactions.forEach(t => {
    if ((t.type === 'Gasto' || isCardPayment(t)) && keys.includes(t.date.slice(0, 7))) sum += t.amount;
  });
  return sum / n;
}

// Tasa de ahorro y su rango de color
function savingsRate(ingresos, gastos) {
  if (ingresos <= 0) return { pct: null, cls: '', label: '—' };
  const pct = ((ingresos - gastos) / ingresos) * 100;
  const cls = pct < 10 ? 'rate-bad' : pct <= 20 ? 'rate-ok' : 'rate-good';
  const label = pct < 10 ? 'Mejorable' : pct <= 20 ? 'Aceptable' : 'Buena';
  return { pct, cls, label };
}

// --- MSI ---
function msiMonthly(m) { return (m.total || 0) / (m.term || 1); }
function msiMonthsPaid(m) {
  const start = new Date(m.startDate + 'T00:00:00'); const now = new Date();
  if (now < new Date(start.getFullYear(), start.getMonth(), 1)) return 0;
  const elapsed = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  return Math.min(m.term || 0, Math.max(0, elapsed + 1)); // el mes de inicio cuenta como 1er pago
}
function msiPending(m) { return Math.max(0, (m.total || 0) - msiMonthsPaid(m) * msiMonthly(m)); }
function msiActive(m) { return msiMonthsPaid(m) < (m.term || 0); }
// Mapa monthKey→cargo total comprometido en MSI (todas las compras, todos sus meses)
function msiSchedule() {
  const map = {};
  state.msi.forEach(m => {
    const start = new Date(m.startDate + 'T00:00:00');
    for (let i = 0; i < (m.term || 0); i++) {
      const k = monthKey(new Date(start.getFullYear(), start.getMonth() + i, 1));
      map[k] = (map[k] || 0) + msiMonthly(m);
    }
  });
  return map;
}

/* ---------------- v3: Recurrentes / Patrimonio / Hormiga / Tags ---------------- */
// Normaliza una descripción para agrupar movimientos repetidos (sin dígitos ni espacios extra)
const normDesc = (s) => (s || '').toLowerCase().trim().replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
const parseTags = (s) => (s || '').split(',').map(x => x.trim()).filter(Boolean);
function allTags() {
  const set = new Set();
  state.transactions.forEach(t => (t.tags || []).forEach(tag => set.add(tag)));
  return [...set].sort((a, b) => a.localeCompare(b));
}

// Detecta movimientos recurrentes: misma descripción/categoría/tipo que aparecen en ≥2 meses,
// o marcados manualmente como recurrentes.
function detectRecurring() {
  const ignored = new Set(state.ignoredRecurring || []);
  const groups = {};
  state.transactions.forEach(t => {
    if (t.type !== 'Gasto' && t.type !== 'Ingreso') return;
    const key = t.type + '|' + (t.category || '') + '|' + normDesc(t.description);
    (groups[key] = groups[key] || { key, list: [] }).list.push(t);
  });
  const out = [];
  Object.values(groups).forEach(({ key, list }) => {
    if (ignored.has(key)) return; // descartado manualmente por el usuario
    const months = new Set(list.map(t => t.date.slice(0, 7)));
    const manual = list.some(t => t.recurring);
    if (months.size >= 2 || manual) {
      const monthly = list.reduce((s, t) => s + t.amount, 0) / list.length; // promedio por ocurrencia
      const last = list.slice().sort((a, b) => b.date.localeCompare(a.date))[0];
      // Día de pago más frecuente (día del mes); desempata con la ocurrencia más reciente
      const dayCount = {};
      list.forEach(t => { const d = +t.date.slice(8, 10); dayCount[d] = (dayCount[d] || 0) + 1; });
      const dayAuto = +Object.entries(dayCount).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0] || +last.date.slice(8, 10);
      out.push({
        key, description: last.description, category: last.category || '', type: list[0].type,
        monthly, occurrences: list.length, months: months.size, manual,
        private: list.some(t => t.private), ids: list.map(t => t.id), lastDate: last.date,
        monthsList: [...months], dayAuto
      });
    }
  });
  return out.sort((a, b) => b.monthly - a.monthly);
}

// --- Patrimonio neto ---
function computeNetWorth() {
  let assets = 0, liabilities = 0;
  state.accounts.forEach(a => {
    if (a.kind === 'credito') { const o = cardOwed(a); if (o >= 0) liabilities += o; else assets += -o; } // saldo a favor = activo
    else assets += debitBalance(a);
  });
  assets += state.goals.reduce((s, g) => s + (parseFloat(g.saved) || 0), 0);
  state.debts.forEach(d => liabilities += Math.max(0, (d.total || 0) - ((d.paid || 0) + debtAutoPaid(d))));
  state.msi.forEach(m => liabilities += msiPending(m));
  return { assets, liabilities, net: assets - liabilities };
}
function lastDayOfMonthISO(key) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m, 0); // día 0 del mes siguiente = último día de este mes
  return key + '-' + String(d.getDate()).padStart(2, '0');
}
// Saldo de débito / deuda de tarjeta considerando solo movimientos hasta una fecha de corte
function debitBalanceUpTo(acc, cutoffISO) {
  let bal = parseFloat(acc.opening) || 0;
  state.transactions.forEach(t => {
    if (t.date > cutoffISO) return;
    if (sameAcc(t.account, acc.name)) {
      if (t.type === 'Ingreso') bal += t.amount;
      else if (t.type === 'Gasto' || t.type === 'Ahorro' || t.type === 'Transferencia') bal -= t.amount;
    }
    if (t.type === 'Transferencia' && sameAcc(t.toAccount, acc.name)) bal += t.amount;
  });
  return bal;
}
function cardOwedUpTo(acc, cutoffISO) {
  let owed = parseFloat(acc.opening) || 0;
  state.transactions.forEach(t => {
    if (t.date > cutoffISO) return;
    if (t.type === 'Gasto' && sameAcc(t.account, acc.name)) owed += t.amount;
    else if (t.type === 'Ingreso' && sameAcc(t.account, acc.name)) owed -= t.amount;
    else if (t.type === 'Transferencia' && sameAcc(t.toAccount, acc.name)) owed -= t.amount;
    else if (t.type === 'Transferencia' && sameAcc(t.account, acc.name)) owed += t.amount;
  });
  return owed;
}
function msiPendingAt(m, cutoffISO) {
  const start = new Date(m.startDate + 'T00:00:00'), cut = new Date(cutoffISO + 'T00:00:00');
  if (cut < new Date(start.getFullYear(), start.getMonth(), 1)) return m.total || 0;
  const elapsed = (cut.getFullYear() - start.getFullYear()) * 12 + (cut.getMonth() - start.getMonth());
  const paid = Math.min(m.term || 0, Math.max(0, elapsed + 1));
  return Math.max(0, (m.total || 0) - paid * msiMonthly(m));
}
// Estimación de patrimonio al cierre de un mes (cuentas/tarjetas/MSI reconstruidas; metas y deudas manuales como base actual)
function reconstructNetWorthAt(key) {
  const cutoff = lastDayOfMonthISO(key);
  let assets = 0, liabilities = 0;
  state.accounts.forEach(a => {
    if (a.kind === 'credito') { const o = cardOwedUpTo(a, cutoff); if (o >= 0) liabilities += o; else assets += -o; } // saldo a favor = activo
    else assets += debitBalanceUpTo(a, cutoff);
  });
  assets += state.goals.reduce((s, g) => s + (parseFloat(g.saved) || 0), 0);
  state.debts.forEach(d => liabilities += Math.max(0, (d.total || 0) - ((d.paid || 0) + debtAutoPaid(d))));
  state.msi.forEach(m => liabilities += msiPendingAt(m, cutoff));
  return { assets, liabilities, net: assets - liabilities };
}
function netWorthHistory(n = 12) {
  return lastNMonths(n).map(mo => {
    const snap = state.netWorthSnapshots[mo.key];
    const v = snap || reconstructNetWorthAt(mo.key);
    return { key: mo.key, label: mo.label, ...v };
  });
}
function snapshotCurrentMonth() {
  state.netWorthSnapshots[currentMonthKey()] = computeNetWorth();
  save();
}

// --- Gastos hormiga ---
function antExpenses(txs) {
  const threshold = state.settings.antThreshold || 100;
  const micro = txs.filter(t => t.type === 'Gasto' && t.amount <= threshold);
  return { count: micro.length, total: micro.reduce((s, t) => s + t.amount, 0), threshold };
}

// --- Comparativa mes vs mes anterior ---
function monthTotals(mk) {
  let ingresos = 0, gastos = 0;
  state.transactions.forEach(t => {
    if (t.date.slice(0, 7) !== mk) return;
    if (t.type === 'Ingreso') ingresos += t.amount;
    else if (t.type === 'Gasto' || isCardPayment(t)) gastos += t.amount;
  });
  return { ingresos, gastos, balance: ingresos - gastos };
}
function prevMonthKey(mk) { const [y, m] = mk.split('-').map(Number); return monthKey(new Date(y, m - 2, 1)); }
function pctDelta(cur, prev) { if (!prev) return null; return ((cur - prev) / Math.abs(prev)) * 100; }
// Devuelve HTML de un badge de variación. higherIsBad=true → subir es malo (gastos)
function deltaBadge(cur, prev, higherIsBad) {
  const d = pctDelta(cur, prev);
  if (d === null || !isFinite(d)) return `<span class="delta neutral">— vs mes pasado</span>`;
  const up = d > 0;
  const good = higherIsBad ? !up : up;
  const arrow = up ? '↑' : (d < 0 ? '↓' : '→');
  const cls = Math.abs(d) < 0.5 ? 'neutral' : (good ? 'good' : 'bad');
  return `<span class="delta ${cls}">${arrow} ${Math.abs(d).toFixed(0)}% vs mes pasado</span>`;
}

// --- Proyección de saldo a fin de mes (liquidez actual + recurrentes pendientes del mes) ---
function projectionEndOfMonth() {
  const mk = currentMonthKey();
  const monthTx = state.transactions.filter(t => t.date.slice(0, 7) === mk);
  const cash = state.accounts.filter(a => a.kind !== 'credito').reduce((s, a) => s + debitBalance(a), 0);
  let pendingIncome = 0, pendingExpense = 0;
  detectRecurring().forEach(r => {
    const seen = monthTx.some(t => t.type === r.type && normDesc(t.description) === normDesc(r.description));
    if (seen) return;
    if (r.type === 'Ingreso') pendingIncome += r.monthly; else pendingExpense += r.monthly;
  });
  return { cash, pendingIncome, pendingExpense, projected: cash + pendingIncome - pendingExpense };
}

/* ---------------- Utilidades ---------------- */
const fmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 });
const money = (n) => fmt.format(n || 0);
const moneyShort = (n) => {
  const v = Math.abs(n);
  if (v >= 1000000) return '$' + (n / 1000000).toFixed(1) + 'M';
  if (v >= 1000) return '$' + (n / 1000).toFixed(1) + 'k';
  return money(n);
};
const todayISO = () => new Date().toISOString().slice(0, 10);
function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
}
function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }

const COLORS = ['#6366f1','#22c55e','#f43f5e','#06b6d4','#f59e0b','#8b5cf6','#ec4899','#14b8a6','#eab308','#3b82f6','#ef4444','#10b981','#a855f7','#f97316'];

/* ---------------- Toast ---------------- */
let toastTimer;
function toast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
}

/* ============================================================
   NAVEGACIÓN
   ============================================================ */
const labels = { dashboard: 'Resumen', metas: 'Metas', plan: 'Plan', presupuesto: 'Presupuesto', transacciones: 'Transacciones', recurrentes: 'Recurrentes', historial: 'Historial', deudas: 'Deudas', ajustes: 'Ajustes' };

let currentView = 'dashboard';
function navigate(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view)?.classList.add('active');
  document.querySelectorAll('.nav-inline button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.nav-menu li').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.getElementById('navCurrentLabel').textContent = labels[view];
  document.getElementById('navMenu').classList.remove('open');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  renderView(view);
}

function renderView(view) {
  if (view === 'dashboard') renderDashboard();
  if (view === 'metas') renderMetas();
  if (view === 'plan') renderPlan();
  if (view === 'presupuesto') renderPresupuesto();
  if (view === 'transacciones') renderTransacciones();
  if (view === 'recurrentes') renderRecurrentes();
  if (view === 'historial') renderHistorial();
  if (view === 'deudas') renderDeudas();
  if (view === 'ajustes') renderAjustes();
}

document.addEventListener('click', (e) => {
  const navBtn = e.target.closest('[data-view]');
  if (navBtn) { navigate(navBtn.dataset.view); return; }
});
document.getElementById('navToggle').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('navMenu').classList.toggle('open');
});
document.addEventListener('click', () => document.getElementById('navMenu').classList.remove('open'));

/* ============================================================
   MODAL genérico
   ============================================================ */
const overlay = document.getElementById('modalOverlay');
const modalForm = document.getElementById('modalForm');
let submitHandler = null;

function openModal(title, html, onSubmit) {
  document.getElementById('modalTitle').textContent = title;
  modalForm.innerHTML = html;
  initDropdowns(modalForm);            // menús personalizados (combobox/select)
  submitHandler = onSubmit;
  overlay.classList.add('open');
  setTimeout(() => modalForm.querySelector('input,select,textarea')?.focus(), 50);
}
function closeModal() { overlay.classList.remove('open'); submitHandler = null; closeDropdowns(); }
document.getElementById('modalClose').addEventListener('click', closeModal);
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
modalForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (submitHandler) {
    const data = Object.fromEntries(new FormData(modalForm).entries());
    submitHandler(data);
  }
});

/* ============================================================
   DATALISTS (autocompletar)
   ============================================================ */
function refreshDatalists() {
  const accNames = state.accounts.map(a => a.name);
  document.getElementById('dlCategorias').innerHTML = state.categories.map(c => `<option value="${esc(c)}"></option>`).join('');
  document.getElementById('dlCuentas').innerHTML = accNames.map(c => `<option value="${esc(c)}"></option>`).join('');
  const link = document.getElementById('dlLink');
  if (link) link.innerHTML = [...state.categories, ...accNames].map(c => `<option value="${esc(c)}"></option>`).join('');
  const tags = document.getElementById('dlTags');
  if (tags) tags.innerHTML = allTags().map(c => `<option value="${esc(c)}"></option>`).join('');
}
function esc(s) { return String(s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }

/* ============================================================
   CENSURA de movimientos privados (Fansly/OnlyFans, etc.)
   ============================================================ */
let censorPrivate = true;
function isCensored(t) { return censorPrivate && t && t.private; }
function dispDesc(t) { return isCensored(t) ? '🔒 Movimiento privado' : esc(t.description); }

function updateCensorBtn() {
  const btn = document.getElementById('btnCensor');
  if (btn) { btn.textContent = censorPrivate ? '🙈' : '👁️'; btn.title = censorPrivate ? 'Mostrar privados' : 'Ocultar privados'; }
}

/* ---- PIN overlay ---- */
function createPinOverlay(title, subtitle, onComplete, onCancel) {
  document.getElementById('pinOverlay')?.remove();
  let digits = '';
  const el = document.createElement('div');
  el.id = 'pinOverlay';
  el.className = 'pin-overlay';
  el.innerHTML = `<div class="pin-box">
    <div class="pin-title">${title}</div>
    <div class="pin-subtitle" id="pinSub">${subtitle}</div>
    <div class="pin-dots">
      <div class="pin-dot" id="pd0"></div><div class="pin-dot" id="pd1"></div>
      <div class="pin-dot" id="pd2"></div><div class="pin-dot" id="pd3"></div>
    </div>
    <div class="pin-error" id="pinError"></div>
    <div class="pin-pad">
      ${[1,2,3,4,5,6,7,8,9].map(k=>`<button class="pin-key" data-k="${k}">${k}</button>`).join('')}
      <button class="pin-key cancel" data-k="cancel">Cancelar</button>
      <button class="pin-key" data-k="0">0</button>
      <button class="pin-key del" data-k="del">⌫</button>
    </div>
  </div>`;
  document.body.appendChild(el);

  function updateDots(errorClass) {
    for (let i = 0; i < 4; i++) {
      const d = document.getElementById('pd'+i);
      if (!d) return;
      d.className = 'pin-dot' + (i < digits.length ? (errorClass ? ' error' : ' filled') : '');
    }
  }

  el.addEventListener('click', async (e) => {
    const k = e.target.closest('.pin-key')?.dataset.k;
    if (!k) return;
    if (k === 'cancel') { el.remove(); onCancel?.(); return; }
    if (k === 'del') { digits = digits.slice(0, -1); updateDots(); document.getElementById('pinError').textContent = ''; return; }
    if (digits.length >= 4) return;
    digits += k;
    updateDots();
    if (digits.length === 4) {
      const result = onComplete(digits);
      if (result === false) {
        updateDots(true);
        document.getElementById('pinError').textContent = 'PIN incorrecto, intenta de nuevo';
        setTimeout(() => { digits = ''; updateDots(); document.getElementById('pinError').textContent = ''; }, 800);
      } else if (result === null) {
        setTimeout(() => { digits = ''; updateDots(); }, 300);
      }
    }
  });
}

function toggleCensor() {
  if (censorPrivate) {
    const pin = state.settings?.privatePin;
    if (!pin) {
      // Crear PIN nuevo (2 pasos)
      let step = 1, firstPin = '';
      createPinOverlay('Crear PIN privado', 'Elige un PIN de 4 digitos', (d) => {
        if (step === 1) {
          firstPin = d; step = 2;
          document.querySelector('#pinOverlay .pin-title').textContent = 'Confirmar PIN';
          document.getElementById('pinSub').textContent = 'Repite el PIN para confirmar';
          return null;
        }
        if (d === firstPin) {
          state.settings = state.settings || {};
          state.settings.privatePin = d;
          save();
          document.getElementById('pinOverlay')?.remove();
          censorPrivate = false; updateCensorBtn(); renderView(currentView);
          toast('PIN creado. Ahora puedes ver tus movimientos privados 👁️');
          return true;
        }
        step = 1; firstPin = '';
        document.querySelector('#pinOverlay .pin-title').textContent = 'Crear PIN privado';
        document.getElementById('pinSub').textContent = 'Los PINs no coinciden. Intenta de nuevo';
        return false;
      }, null);
    } else {
      createPinOverlay('PIN privado', 'Ingresa tu PIN de 4 digitos', (d) => {
        if (d === pin) {
          document.getElementById('pinOverlay')?.remove();
          censorPrivate = false; updateCensorBtn(); renderView(currentView);
          return true;
        }
        return false;
      }, null);
    }
  } else {
    censorPrivate = true; updateCensorBtn(); renderView(currentView);
  }
}

window.togglePrivate = (id) => {
  const t = state.transactions.find(x => x.id === id); if (!t) return;
  t.private = !t.private;
  save(); renderTransacciones(); toast(t.private ? 'Marcado como privado 🔒' : 'Ya no es privado');
};
document.getElementById('btnCensor').addEventListener('click', toggleCensor);

/* ============================================================
   TRANSACCIONES
   ============================================================ */
function txModal(existing, preset) {
  const t = existing || Object.assign({ date: todayISO(), type: 'Gasto', category: '', account: '', toAccount: '', amount: '', description: '', notes: '' }, preset || {});
  const html = `
    <div class="field-row">
      <div class="field">
        <label>Fecha</label>
        <input type="date" name="date" value="${t.date}" required />
      </div>
      <div class="field">
        <label>Tipo de movimiento</label>
        <input list="dlTipos" id="txTypeInput" name="type" value="${esc(t.type)}" placeholder="Gasto / Ingreso / Ahorro / Transferencia" required autocomplete="off" oninput="onTxTypeChange()" />
        <div class="hint">Escribe "Ga" → Gasto, "Tr" → Transferencia…</div>
      </div>
    </div>
    <div class="field">
      <label>Descripción</label>
      <input type="text" name="description" value="${esc(t.description)}" placeholder="Ej. Compra en Oxxo" required />
    </div>
    <div class="field-row">
      <div class="field">
        <label>Monto</label>
        <input type="number" name="amount" value="${t.amount}" step="0.01" min="0" placeholder="0.00" required />
      </div>
      <div class="field">
        <label id="accLabel">Cuenta / Tarjeta</label>
        <input list="dlCuentas" name="account" value="${esc(t.account)}" placeholder="Ej. BBVA Débito" autocomplete="off" />
      </div>
    </div>
    <div class="field hidden" id="toAccField">
      <label>Cuenta destino</label>
      <input list="dlCuentas" name="toAccount" value="${esc(t.toAccount || '')}" placeholder="Ej. Rappi (tarjeta de crédito)" autocomplete="off" />
      <div class="hint">A dónde llega el dinero. Una transferencia no cuenta como gasto ni ingreso.</div>
    </div>
    <div class="field">
      <label>Categoría</label>
      <input list="dlCategorias" name="category" value="${esc(t.category)}" placeholder="Ej. Comida" autocomplete="off" />
      <div class="hint" id="catHint">Si no existe, se agregará automáticamente a tu lista.</div>
    </div>
    <div class="field">
      <label>Tags (opcional)</label>
      <input list="dlTags" name="tags" value="${esc((t.tags || []).join(', '))}" placeholder="Ej. viaje-cdmx, trabajo" autocomplete="off" />
      <div class="hint">Sepáralos con comas. Sirven para cortes transversales (ej. un viaje).</div>
    </div>
    <div class="field">
      <label>Notas</label>
      <textarea name="notes" placeholder="Opcional…">${esc(t.notes)}</textarea>
    </div>
    <label class="check-row">
      <input type="checkbox" name="recurring" ${t.recurring ? 'checked' : ''} />
      <span>Marcar como recurrente (suscripción / pago mensual)</span>
    </label>
    <label class="check-row">
      <input type="checkbox" name="private" ${t.private ? 'checked' : ''} />
      <span>🔒 Movimiento privado (censurar el nombre)</span>
    </label>
    <div class="modal-actions">
      <button type="button" class="btn-cancel" onclick="closeModal()">Cancelar</button>
      <button type="submit" class="btn-primary">${existing ? 'Guardar cambios' : 'Agregar'}</button>
    </div>`;
  openModal(existing ? 'Editar transacción' : 'Nueva transacción', html, (data) => {
    data.type = normalizeType(data.type);
    if (!data.type) return toast('Tipo no válido (Gasto, Ingreso, Ahorro o Transferencia)', 'error');
    data.amount = parseFloat(data.amount);
    const registerAccount = (a) => { a = (a||'').trim(); if (a && !accByName(a)) state.accounts.push({ id: uid(), name: a, kind: 'debito' }); return a; };

    if (data.type === 'Transferencia') {
      data.toAccount = (data.toAccount || '').trim();
      if (!data.toAccount) return toast('Indica la cuenta destino', 'error');
      registerAccount(data.toAccount);
      if (!data.category.trim()) data.category = 'Transferencia';
    } else {
      data.toAccount = '';
    }
    // registrar categoría / cuenta nuevas
    const cat = data.category.trim();
    if (cat && !state.categories.some(c => c.toLowerCase() === cat.toLowerCase())) {
      state.categories.push(cat); toast('Categoría "' + cat + '" agregada');
    }
    registerAccount(data.account);
    data.tags = parseTags(data.tags);
    data.recurring = !!data.recurring;
    data.private = !!data.private;

    if (existing) {
      Object.assign(existing, data);
    } else {
      state.transactions.push({ id: uid(), ...data });
    }
    save(); refreshDatalists(); closeModal();
    renderView(currentView);
    toast(existing ? 'Transacción actualizada' : 'Transacción agregada');
  });
  onTxTypeChange();
}

function normalizeType(v) {
  const s = (v || '').trim().toLowerCase();
  if (!s) return '';
  if ('gasto'.startsWith(s)) return 'Gasto';
  if ('ingreso'.startsWith(s)) return 'Ingreso';
  if ('ahorro'.startsWith(s)) return 'Ahorro';
  if ('transferencia'.startsWith(s)) return 'Transferencia';
  return '';
}

// Ajusta el formulario según el tipo elegido (muestra cuenta destino en Transferencias)
window.onTxTypeChange = function () {
  const input = document.getElementById('txTypeInput');
  if (!input) return;
  const isTransfer = normalizeType(input.value) === 'Transferencia';
  document.getElementById('toAccField').classList.toggle('hidden', !isTransfer);
  document.getElementById('accLabel').textContent = isTransfer ? 'Cuenta origen' : 'Cuenta / Tarjeta';
  document.getElementById('catHint').textContent = isTransfer
    ? 'Opcional. Útil para vincular pagos de tarjeta en Deudas.'
    : 'Si no existe, se agregará automáticamente a tu lista.';
};

let selectedTx = new Set(); // ids de transacciones marcadas para sumar

// Interpreta tokens especiales escritos en la barra de búsqueda:
//   >100  >=100  <500  <=500  =250  (monto)   desde:YYYY-MM-DD  hasta:YYYY-MM-DD  (fechas)
// Devuelve { text, amtMin, amtMax, dateFrom, dateTo } con el texto libre restante.
function parseSearchQuery(raw) {
  const r = { text: '', amtMin: null, amtMax: null, dateFrom: '', dateTo: '' };
  const words = (raw || '').trim().split(/\s+/).filter(Boolean);
  const rest = [];
  words.forEach(w => {
    let m;
    if ((m = w.match(/^desde:(\d{4}-\d{2}-\d{2})$/i))) { r.dateFrom = m[1]; }
    else if ((m = w.match(/^hasta:(\d{4}-\d{2}-\d{2})$/i))) { r.dateTo = m[1]; }
    else if ((m = w.match(/^>=?\s*(\d+(?:\.\d+)?)$/))) { r.amtMin = parseFloat(m[1]); }
    else if ((m = w.match(/^<=?\s*(\d+(?:\.\d+)?)$/))) { r.amtMax = parseFloat(m[1]); }
    else if ((m = w.match(/^=\s*(\d+(?:\.\d+)?)$/))) { r.amtMin = r.amtMax = parseFloat(m[1]); }
    else rest.push(w);
  });
  r.text = rest.join(' ').toLowerCase();
  return r;
}

// ¿Cuántos filtros del panel están activos? (no cuenta la barra de búsqueda)
function activeTxFilterCount() {
  return ['txFilterType', 'txFilterCat', 'txFilterAcc', 'txFilterTag', 'txFilterDateFrom', 'txFilterDateTo', 'txFilterAmtMin', 'txFilterAmtMax']
    .filter(id => (document.getElementById(id).value || '').trim() !== '').length;
}

function renderTransacciones() {
  // poblar filtros
  const catSel = document.getElementById('txFilterCat');
  const accSel = document.getElementById('txFilterAcc');
  const tagSel = document.getElementById('txFilterTag');
  const curCat = catSel.value, curAcc = accSel.value, curTag = tagSel.value;
  catSel.innerHTML = '<option value="">Todas las categorías</option>' + state.categories.map(c => `<option ${c===curCat?'selected':''}>${esc(c)}</option>`).join('');
  accSel.innerHTML = '<option value="">Todas las cuentas</option>' + state.accounts.map(a => `<option ${a.name===curAcc?'selected':''}>${esc(a.name)}</option>`).join('');
  const tags = allTags();
  tagSel.innerHTML = '<option value="">Todos los tags</option>' + tags.map(c => `<option ${c===curTag?'selected':''}>${esc(c)}</option>`).join('');
  initDropdowns(document.getElementById('txFilterPanel'));  // menús personalizados en los filtros

  // Búsqueda (texto libre + tokens de monto/fecha) y filtros del panel
  const sq = parseSearchQuery(document.getElementById('txSearch').value);
  const fType = document.getElementById('txFilterType').value;
  const fCat = catSel.value, fAcc = accSel.value, fTag = tagSel.value;
  const fFrom = document.getElementById('txFilterDateFrom').value;
  const fTo = document.getElementById('txFilterDateTo').value;
  const panelMin = parseFloat(document.getElementById('txFilterAmtMin').value);
  const panelMax = parseFloat(document.getElementById('txFilterAmtMax').value);
  // El panel y los tokens de la barra se combinan (gana la restricción más estricta)
  const dateFrom = [fFrom, sq.dateFrom].filter(Boolean).sort().pop() || '';
  const dateTo = [fTo, sq.dateTo].filter(Boolean).sort()[0] || '';
  const amtMin = Math.max(...[panelMin, sq.amtMin].filter(v => v != null && !isNaN(v)), -Infinity);
  const amtMax = Math.min(...[panelMax, sq.amtMax].filter(v => v != null && !isNaN(v)), Infinity);

  let rows = [...state.transactions].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  rows = rows.filter(t =>
    (!sq.text || (t.description + ' ' + (t.notes||'') + ' ' + (t.tags||[]).join(' ')).toLowerCase().includes(sq.text)) &&
    (!fType || t.type === fType) &&
    (!fCat || t.category === fCat) &&
    (!fAcc || t.account === fAcc) &&
    (!fTag || (t.tags||[]).includes(fTag)) &&
    (!dateFrom || t.date >= dateFrom) &&
    (!dateTo || t.date <= dateTo) &&
    (t.amount >= amtMin) &&
    (t.amount <= amtMax)
  );

  // Indicadores visuales: contador en el botón de filtros y estado del botón "Quitar filtros"
  const panelCount = activeTxFilterCount();
  const badge = document.getElementById('txFilterCount');
  badge.textContent = panelCount;
  badge.classList.toggle('hidden', panelCount === 0);
  document.getElementById('txFilterToggle').classList.toggle('has-active', panelCount > 0);
  const anyFilter = panelCount > 0 || document.getElementById('txSearch').value.trim() !== '';
  document.getElementById('txClearAll').disabled = !anyFilter;

  const body = document.getElementById('txBody');
  document.getElementById('txEmpty').classList.toggle('hidden', rows.length > 0);
  body.innerHTML = rows.map(t => {
    const cls = t.type === 'Ingreso' ? 'amount-pos' : t.type === 'Ahorro' ? 'amount-save' : t.type === 'Transferencia' ? 'amount-transfer' : 'amount-neg';
    const sign = t.type === 'Ingreso' ? '+' : t.type === 'Gasto' ? '−' : '';
    const acc = t.type === 'Transferencia'
      ? `${esc(t.account || '—')} <span class="muted">→</span> ${esc(t.toAccount || '—')}`
      : esc(t.account || '—');
    const cens = isCensored(t);
    const tagsHtml = (!cens && (t.tags || []).length) ? `<div class="tag-row">${t.tags.map(tg => `<span class="pill tagchip">#${esc(tg)}</span>`).join('')}</div>` : '';
    const notesHtml = (!cens && t.notes) ? `<div class="muted" style="font-size:12px">${esc(t.notes)}</div>` : '';
    return `<tr class="${cens ? 'tx-private' : ''}">
      <td class="ta-c"><input type="checkbox" class="tx-check" data-id="${t.id}" ${selectedTx.has(t.id) ? 'checked' : ''} /></td>
      <td style="white-space:nowrap">${fmtDate(t.date)}</td>
      <td><div style="font-weight:600">${t.recurring ? '<span class="rec-ico" title="Recurrente">🔁</span> ' : ''}${(t.private && !cens) ? '🔒 ' : ''}${dispDesc(t)}</div>${notesHtml}${tagsHtml}</td>
      <td>${t.category ? `<span class="pill tag">${esc(t.category)}</span>` : '—'}</td>
      <td>${acc}</td>
      <td><span class="pill ${t.type}">${t.type}</span></td>
      <td class="ta-r ${cls}">${sign}${money(t.amount)}</td>
      <td><div class="row-actions">
        <button class="icon-btn" title="${t.private ? 'Quitar privado' : 'Marcar privado'}" onclick="togglePrivate('${t.id}')">${t.private ? '🔓' : '🔒'}</button>
        <button class="icon-btn" title="${t.recurring ? 'Quitar recurrente' : 'Marcar recurrente'}" onclick="toggleRecurring('${t.id}')">🔁</button>
        <button class="icon-btn" onclick="editTx('${t.id}')">✎</button>
        <button class="icon-btn danger" onclick="delTx('${t.id}')">🗑</button>
      </div></td>
    </tr>`;
  }).join('');
  syncTxCheckAll();
  updateTxSelBar();
}

// Suma de transacciones seleccionadas (ingresos +, gastos/ahorro/transferencias −)
function updateTxSelBar() {
  const bar = document.getElementById('txSelBar');
  const sel = [...selectedTx].map(id => state.transactions.find(t => t.id === id)).filter(Boolean);
  if (!sel.length) { bar.classList.add('hidden'); return; }
  let net = 0, ingresos = 0, salidas = 0;
  sel.forEach(t => {
    if (t.type === 'Ingreso') { ingresos += t.amount; net += t.amount; }
    else { salidas += t.amount; net -= t.amount; }
  });
  bar.classList.remove('hidden');
  const cls = net >= 0 ? 'amount-pos' : 'amount-neg';
  document.getElementById('txSelInfo').innerHTML = `
    <span class="sel-left"><span class="sel-count">${sel.length}</span> seleccionada(s)</span>
    <span class="sel-right">
      ${ingresos && salidas ? `<span class="sel-break">ingresos ${money(ingresos)} · salidas ${money(salidas)}</span>` : ''}
      <span class="sel-sum"><span class="sel-sum-lbl">Suma</span><span class="sel-sum-val ${cls}">${money(net)}</span></span>
    </span>`;
}
// Sincroniza la casilla "seleccionar todo" según las filas visibles
function syncTxCheckAll() {
  const head = document.getElementById('txCheckAll'); if (!head) return;
  const boxes = [...document.querySelectorAll('#txBody .tx-check')];
  const all = boxes.length > 0 && boxes.every(cb => cb.checked);
  const some = boxes.some(cb => cb.checked);
  head.checked = all;
  head.indeterminate = some && !all;
}
window.editTx = (id) => txModal(state.transactions.find(t => t.id === id));
window.delTx = (id) => {
  if (!confirm('¿Eliminar esta transacción?')) return;
  state.transactions = state.transactions.filter(t => t.id !== id);
  selectedTx.delete(id);
  save(); renderTransacciones(); toast('Transacción eliminada');
};
window.toggleRecurring = (id) => {
  const t = state.transactions.find(x => x.id === id); if (!t) return;
  t.recurring = !t.recurring;
  // si se vuelve a marcar como recurrente, quitar su grupo de los ignorados
  if (t.recurring && (t.type === 'Gasto' || t.type === 'Ingreso')) {
    const key = t.type + '|' + (t.category || '') + '|' + normDesc(t.description);
    state.ignoredRecurring = (state.ignoredRecurring || []).filter(k => k !== key);
  }
  save(); renderTransacciones(); toast(t.recurring ? 'Marcada como recurrente' : 'Ya no es recurrente');
};
['txSearch','txFilterType','txFilterCat','txFilterAcc','txFilterTag','txFilterDateFrom','txFilterDateTo','txFilterAmtMin','txFilterAmtMax'].forEach(id =>
  document.getElementById(id).addEventListener('input', renderTransacciones));
document.getElementById('btnNuevaTx').addEventListener('click', () => txModal());

// Popover de filtros: abrir/cerrar
const txFilterPanel = document.getElementById('txFilterPanel');
document.getElementById('txFilterToggle').addEventListener('click', (e) => {
  e.stopPropagation();
  txFilterPanel.classList.toggle('open');
});
txFilterPanel.addEventListener('click', (e) => e.stopPropagation()); // no cerrar al interactuar dentro
document.addEventListener('click', () => txFilterPanel.classList.remove('open'));
document.getElementById('txFilterApply').addEventListener('click', () => txFilterPanel.classList.remove('open'));

// Limpiar solo los campos del panel
document.getElementById('txFilterClear').addEventListener('click', () => {
  ['txFilterType','txFilterCat','txFilterAcc','txFilterTag','txFilterDateFrom','txFilterDateTo','txFilterAmtMin','txFilterAmtMax']
    .forEach(id => { document.getElementById(id).value = ''; });
  renderTransacciones();
});
// Quitar TODOS los filtros (incluida la barra de búsqueda) → lista completa
document.getElementById('txClearAll').addEventListener('click', () => {
  ['txSearch','txFilterType','txFilterCat','txFilterAcc','txFilterTag','txFilterDateFrom','txFilterDateTo','txFilterAmtMin','txFilterAmtMax']
    .forEach(id => { document.getElementById(id).value = ''; });
  txFilterPanel.classList.remove('open');
  renderTransacciones();
});

// Selección múltiple para sumar transacciones
document.getElementById('txBody').addEventListener('change', (e) => {
  const cb = e.target.closest('.tx-check'); if (!cb) return;
  if (cb.checked) selectedTx.add(cb.dataset.id); else selectedTx.delete(cb.dataset.id);
  syncTxCheckAll();
  updateTxSelBar();
});
document.getElementById('txCheckAll').addEventListener('change', (e) => {
  document.querySelectorAll('#txBody .tx-check').forEach(cb => {
    cb.checked = e.target.checked;
    if (e.target.checked) selectedTx.add(cb.dataset.id); else selectedTx.delete(cb.dataset.id);
  });
  updateTxSelBar();
});
document.getElementById('txSelClear').addEventListener('click', () => {
  selectedTx.clear();
  document.querySelectorAll('#txBody .tx-check').forEach(cb => cb.checked = false);
  syncTxCheckAll();
  updateTxSelBar();
});

/* ============================================================
   RECURRENTES / SUSCRIPCIONES
   ============================================================ */
let selectedRec = new Set(); // uids de recurrentes seleccionados para proyectar el ahorro

// Lista unificada: recurrentes auto-detectados (con overrides de recurringMeta) + manuales.
function allRecurring() {
  const auto = detectRecurring().map(r => {
    const meta = state.recurringMeta[r.key] || {};
    const frequency = meta.frequency === 'yearly' ? 'yearly' : 'monthly';
    const amount = (meta.amount != null && !isNaN(meta.amount)) ? meta.amount : r.monthly;
    const monthly = frequency === 'yearly' ? amount / 12 : amount;
    return {
      uid: r.key, key: r.key, source: 'auto',
      description: r.description, category: r.category, type: r.type,
      amount, frequency, monthly, annual: monthly * 12,
      payDay: meta.payDay || r.dayAuto || 1,
      payMonth: meta.payMonth || (+r.lastDate.slice(5, 7)) || 1,
      overrides: meta.overrides || {}, monthsList: r.monthsList || [],
      private: r.private, occurrences: r.occurrences,
    };
  });
  const manual = (state.manualRecurring || []).map(m => {
    const frequency = m.frequency === 'yearly' ? 'yearly' : 'monthly';
    const amount = parseFloat(m.amount) || 0;
    const monthly = frequency === 'yearly' ? amount / 12 : amount;
    return {
      uid: 'manual:' + m.id, key: 'manual:' + m.id, source: 'manual', id: m.id,
      description: m.description || 'Recurrente', category: m.category || '', type: m.type === 'Ingreso' ? 'Ingreso' : 'Gasto',
      amount, frequency, monthly, annual: monthly * 12,
      payDay: m.payDay || 1, payMonth: m.payMonth || 1,
      overrides: m.overrides || {}, monthsList: [], private: false, occurrences: 0,
    };
  });
  return [...auto, ...manual].sort((a, b) => b.monthly - a.monthly);
}

function renderRecurrentes() {
  const list = allRecurring();
  const mensualGasto = list.filter(r => r.type === 'Gasto').reduce((s, r) => s + r.monthly, 0);
  const mensualIngreso = list.filter(r => r.type === 'Ingreso').reduce((s, r) => s + r.monthly, 0);
  document.getElementById('recMensual').textContent = money(mensualGasto);
  document.getElementById('recAnual').textContent = money(mensualGasto * 12);
  document.getElementById('recIngreso').textContent = money(mensualIngreso);

  document.getElementById('recEmpty').classList.toggle('hidden', list.length > 0);
  const pills = { pagado: ['Pagado', 'rec-ok'], proximo: ['Próximo a vencer', 'rec-soon'], pendiente: ['Pendiente', 'rec-pend'], vencido: ['Vencido', 'rec-late'] };
  document.getElementById('recBody').innerHTML = list.map(r => {
    const cls = r.type === 'Ingreso' ? 'amount-pos' : 'amount-neg';
    const desc = (r.private && censorPrivate) ? '🔒 Movimiento privado' : esc(r.description);
    const st = recurringStatus(r);
    const fechaTxt = r.frequency === 'yearly'
      ? st.dueDate.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
      : st.dueDate.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
    const [pillTxt, pillCls] = pills[st.status];
    const freqBadge = r.frequency === 'yearly' ? '<span class="pill tagchip">Anual</span>' : '<span class="pill tag">Mensual</span>';
    const srcBadge = r.source === 'manual' ? ' <span class="pill tagchip" title="Agregado manualmente">✋</span>' : '';
    const canSel = r.type === 'Gasto';
    return `<tr>
      <td class="ta-c"><input type="checkbox" class="tx-check rec-check" data-uid="${esc(r.uid)}" ${selectedRec.has(r.uid) ? 'checked' : ''} ${canSel ? '' : 'disabled title="Solo los gastos cuentan para el ahorro"'} /></td>
      <td style="font-weight:600">🔁 ${desc}${srcBadge}</td>
      <td>${r.category ? `<span class="pill tag">${esc(r.category)}</span>` : '—'}</td>
      <td><span class="pill ${r.type}">${r.type}</span></td>
      <td>${freqBadge}</td>
      <td class="ta-r ${cls}">${money(r.monthly)}</td>
      <td class="ta-r ${cls}">${money(r.annual)}</td>
      <td>
        <div style="font-weight:600;white-space:nowrap">${fechaTxt}</div>
        <span class="pill rec-status ${pillCls}">${pillTxt}</span>
      </td>
      <td><div class="row-actions">
        <button class="icon-btn" data-rec-edit="${esc(r.uid)}" title="Editar monto, frecuencia, día y estatus">✎</button>
        <button class="icon-btn danger" data-rec-key="${esc(r.uid)}" title="${r.source === 'manual' ? 'Eliminar recurrente' : 'Quitar de recurrentes (no borra transacciones)'}">🗑</button>
      </div></td>
    </tr>`;
  }).join('');
  syncRecCheckAll();
  updateRecSelBar();
}

// Proyección de ahorro: suma de gastos recurrentes seleccionados (mensual y anual)
function updateRecSelBar() {
  const bar = document.getElementById('recSelBar');
  const sel = allRecurring().filter(r => selectedRec.has(r.uid) && r.type === 'Gasto');
  if (!sel.length) { bar.classList.add('hidden'); return; }
  const mensual = sel.reduce((s, r) => s + r.monthly, 0);
  bar.classList.remove('hidden');
  document.getElementById('recSelInfo').innerHTML = `
    <span class="sel-left"><span class="sel-count">${sel.length}</span> seleccionada(s) — si las cancelas ahorrarías</span>
    <span class="sel-right">
      <span class="sel-sum"><span class="sel-sum-lbl">al mes</span><span class="sel-sum-val amount-pos">${money(mensual)}</span></span>
      <span class="sel-sum"><span class="sel-sum-lbl">al año</span><span class="sel-sum-val amount-pos">${money(mensual * 12)}</span></span>
    </span>`;
}
function syncRecCheckAll() {
  const head = document.getElementById('recCheckAll'); if (!head) return;
  const boxes = [...document.querySelectorAll('#recBody .rec-check:not(:disabled)')];
  const all = boxes.length > 0 && boxes.every(cb => cb.checked);
  head.checked = all;
  head.indeterminate = boxes.some(cb => cb.checked) && !all;
}

// Próximo pago y estatus, soportando frecuencia mensual o anual + overrides manuales.
function recurringStatus(r) {
  const payDay = r.payDay || 1;
  const overrides = r.overrides || {};
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dim = (y, mIdx) => new Date(y, mIdx + 1, 0).getDate();
  if (r.frequency === 'yearly') {
    const pmIdx = (r.payMonth || 1) - 1;
    const txYears = new Set((r.monthsList || []).map(mk => mk.slice(0, 4)));
    const isPaidYear = (y) => overrides['Y' + y] ? overrides['Y' + y] === 'pagado' : txYears.has(String(y));
    let y = today.getFullYear();
    let due = new Date(y, pmIdx, Math.min(payDay, dim(y, pmIdx)));
    if (due < today || isPaidYear(y)) { y++; due = new Date(y, pmIdx, Math.min(payDay, dim(y, pmIdx))); }
    const days = Math.round((due - today) / 86400000);
    let status;
    if (days < 0) status = 'vencido';
    else if (days <= 7) status = 'proximo';
    else if (isPaidYear(today.getFullYear())) status = 'pagado';
    else status = 'pendiente';
    return { payDay, dueDate: due, days, status, curPeriod: 'Y' + today.getFullYear(), periodLabel: String(today.getFullYear()) };
  }
  const txMonths = new Set(r.monthsList || []);
  const isPaid = (mk) => overrides[mk] ? overrides[mk] === 'pagado' : txMonths.has(mk);
  const curKey = currentMonthKey();
  const m = new Date(today.getFullYear(), today.getMonth(), 1);
  let guard = 0;
  while (isPaid(monthKey(m)) && guard < 24) { m.setMonth(m.getMonth() + 1); guard++; }
  const due = new Date(m.getFullYear(), m.getMonth(), Math.min(payDay, dim(m.getFullYear(), m.getMonth())));
  const days = Math.round((due - today) / 86400000);
  let status;
  if (days < 0) status = 'vencido';
  else if (days <= 7) status = 'proximo';
  else if (isPaid(curKey)) status = 'pagado';
  else status = 'pendiente';
  return { payDay, dueDate: due, days, status, curPeriod: curKey, periodLabel: curKey };
}

window.onRecFreqChange = function () {
  const f = document.getElementById('recFreq'); if (!f) return;
  const mf = document.getElementById('recMonthField');
  if (mf) mf.style.display = f.value === 'yearly' ? '' : 'none';
};

// Modal para agregar/editar un recurrente (manual o auto-detectado).
window.recurringModal = (r) => {
  const isNew = !r;
  const src = r ? r.source : 'manual';
  const st = r ? recurringStatus(r) : null;
  const curOv = (r && (r.overrides[st.curPeriod] || 'auto')) || 'auto';
  const freq = r ? r.frequency : 'monthly';
  const editable = isNew || src === 'manual'; // descripción/tipo/categoría editables solo en manuales
  const meses = [...Array(12)].map((_, i) => `<option value="${i + 1}" ${r && r.payMonth === i + 1 ? 'selected' : ''}>${new Date(2026, i, 1).toLocaleDateString('es-MX', { month: 'long' })}</option>`).join('');
  const html = `
    ${editable ? `
    <div class="field">
      <label>Descripción</label>
      <input name="description" value="${r ? esc(r.description) : ''}" placeholder="Ej. Netflix, Gimnasio…" required />
    </div>
    <div class="field-row">
      <div class="field">
        <label>Tipo</label>
        <select name="type">
          <option value="Gasto" ${r && r.type === 'Ingreso' ? '' : 'selected'}>Gasto</option>
          <option value="Ingreso" ${r && r.type === 'Ingreso' ? 'selected' : ''}>Ingreso</option>
        </select>
      </div>
      <div class="field">
        <label>Categoría</label>
        <input name="category" list="dlCategorias" value="${r ? esc(r.category) : ''}" placeholder="Categoría" />
      </div>
    </div>` : `
      <input type="hidden" name="description" value="${esc(r.description)}" />
      <input type="hidden" name="type" value="${esc(r.type)}" />
      <input type="hidden" name="category" value="${esc(r.category)}" />`}
    <div class="field-row">
      <div class="field">
        <label>Monto por cobro</label>
        <input type="number" name="amount" step="0.01" min="0" value="${r ? r.amount : ''}" placeholder="0.00" required />
      </div>
      <div class="field">
        <label>Frecuencia</label>
        <select name="frequency" id="recFreq" onchange="onRecFreqChange()">
          <option value="monthly" ${freq === 'monthly' ? 'selected' : ''}>Mensual</option>
          <option value="yearly" ${freq === 'yearly' ? 'selected' : ''}>Anual</option>
        </select>
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>Día de pago</label>
        <input type="number" name="payDay" min="1" max="31" value="${r ? r.payDay : ''}" placeholder="1–31" />
      </div>
      <div class="field" id="recMonthField">
        <label>Mes (si es anual)</label>
        <select name="payMonth">${meses}</select>
      </div>
    </div>
    ${r ? `<div class="field">
      <label>Estatus de ${st.periodLabel}</label>
      <select name="status">
        <option value="auto" ${curOv === 'auto' ? 'selected' : ''}>Automático (según transacciones)</option>
        <option value="pagado" ${curOv === 'pagado' ? 'selected' : ''}>Pagado</option>
        <option value="pendiente" ${curOv === 'pendiente' ? 'selected' : ''}>Pendiente</option>
      </select>
    </div>` : ''}
    <div class="modal-actions">
      ${r && src === 'manual'
        ? `<button type="button" class="btn-cancel" onclick="delManualRecurring('${r.id}')">Eliminar</button>`
        : `<button type="button" class="btn-cancel" onclick="closeModal()">Cancelar</button>`}
      <button type="submit" class="btn-primary">${isNew ? 'Agregar' : 'Guardar'}</button>
    </div>`;
  const title = isNew ? 'Nuevo recurrente' : 'Editar · ' + esc((r.private && censorPrivate) ? 'privado' : r.description);
  openModal(title, html, (data) => {
    const amount = parseFloat(data.amount) || 0;
    const frequency = data.frequency === 'yearly' ? 'yearly' : 'monthly';
    const payDay = Math.min(31, Math.max(1, parseInt(data.payDay) || 1));
    const payMonth = Math.min(12, Math.max(1, parseInt(data.payMonth) || 1));
    if (isNew) {
      state.manualRecurring.push({ id: uid(), description: (data.description || 'Recurrente').trim(), category: (data.category || '').trim(), type: data.type === 'Ingreso' ? 'Ingreso' : 'Gasto', amount, frequency, payDay, payMonth, overrides: {} });
    } else if (src === 'manual') {
      const m = state.manualRecurring.find(x => x.id === r.id);
      if (m) {
        Object.assign(m, { description: (data.description || 'Recurrente').trim(), category: (data.category || '').trim(), type: data.type === 'Ingreso' ? 'Ingreso' : 'Gasto', amount, frequency, payDay, payMonth });
        m.overrides = m.overrides || {};
        if (data.status === 'auto') delete m.overrides[st.curPeriod]; else if (data.status) m.overrides[st.curPeriod] = data.status;
      }
    } else { // auto: guardar overrides en recurringMeta
      const mt = state.recurringMeta[r.key] = state.recurringMeta[r.key] || {};
      mt.amount = amount; mt.frequency = frequency; mt.payDay = payDay; mt.payMonth = payMonth;
      mt.overrides = mt.overrides || {};
      if (data.status === 'auto') delete mt.overrides[st.curPeriod]; else if (data.status) mt.overrides[st.curPeriod] = data.status;
    }
    save(); refreshDatalists(); renderRecurrentes(); toast(isNew ? 'Recurrente agregado' : 'Recurrente actualizado');
  });
  onRecFreqChange();
};
window.editRecurring = (uid) => { const r = allRecurring().find(x => x.uid === uid); if (r) recurringModal(r); };
window.delManualRecurring = (id) => {
  state.manualRecurring = (state.manualRecurring || []).filter(m => m.id !== id);
  selectedRec.delete('manual:' + id);
  save(); closeModal(); renderRecurrentes(); toast('Recurrente eliminado');
};

// Botones ✎ / 🗑 de cada recurrente (delegación)
document.getElementById('recBody').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-rec-edit]');
  if (edit) { editRecurring(edit.dataset.recEdit); return; }
  const btn = e.target.closest('[data-rec-key]'); if (!btn) return;
  dismissRecurring(btn.dataset.recKey);
});
// Selección para proyectar el ahorro
document.getElementById('recBody').addEventListener('change', (e) => {
  const cb = e.target.closest('.rec-check'); if (!cb) return;
  if (cb.checked) selectedRec.add(cb.dataset.uid); else selectedRec.delete(cb.dataset.uid);
  syncRecCheckAll(); updateRecSelBar();
});
document.getElementById('recCheckAll').addEventListener('change', (e) => {
  document.querySelectorAll('#recBody .rec-check:not(:disabled)').forEach(cb => {
    cb.checked = e.target.checked;
    if (e.target.checked) selectedRec.add(cb.dataset.uid); else selectedRec.delete(cb.dataset.uid);
  });
  updateRecSelBar();
});
document.getElementById('recSelClear').addEventListener('click', () => {
  selectedRec.clear();
  document.querySelectorAll('#recBody .rec-check').forEach(cb => cb.checked = false);
  syncRecCheckAll(); updateRecSelBar();
});
document.getElementById('btnNuevoRecurrente').addEventListener('click', () => recurringModal(null));

// Quita un recurrente: si es manual lo elimina; si es auto-detectado lo ignora y desmarca sus transacciones.
window.dismissRecurring = (uid) => {
  if (uid.startsWith('manual:')) {
    if (!confirm('¿Eliminar este recurrente manual?')) return;
    return delManualRecurring(uid.slice(7));
  }
  if (!confirm('¿Quitar este movimiento de la lista de recurrentes?\n\nNo se borrarán las transacciones, solo dejará de detectarse como recurrente.')) return;
  if (!state.ignoredRecurring.includes(uid)) state.ignoredRecurring.push(uid);
  state.transactions.forEach(t => {
    if (t.type !== 'Gasto' && t.type !== 'Ingreso') return;
    const k = t.type + '|' + (t.category || '') + '|' + normDesc(t.description);
    if (k === uid) t.recurring = false;
  });
  save(); renderRecurrentes(); toast('Recurrente quitado');
};

/* ============================================================
   METAS
   ============================================================ */
function metaModal(existing) {
  const g = existing || { name: '', target: '', saved: 0, targetDate: '', note: '' };
  const html = `
    <div class="field">
      <label>Nombre de la meta</label>
      <input type="text" name="name" value="${esc(g.name)}" placeholder="Ej. Apple Watch" required />
    </div>
    <div class="field-row">
      <div class="field">
        <label>Precio objetivo</label>
        <input type="number" name="target" value="${g.target}" step="0.01" min="0" placeholder="0.00" required />
      </div>
      <div class="field">
        <label>Ahorrado hasta ahora</label>
        <input type="number" name="saved" value="${g.saved}" step="0.01" min="0" placeholder="0.00" />
      </div>
    </div>
    <div class="field">
      <label>Fecha objetivo</label>
      <input type="date" name="targetDate" value="${g.targetDate || ''}" />
    </div>
    <div class="field">
      <label>Nota</label>
      <input type="text" name="note" value="${esc(g.note||'')}" placeholder="Opcional…" />
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-cancel" onclick="closeModal()">Cancelar</button>
      <button type="submit" class="btn-primary">${existing ? 'Guardar cambios' : 'Crear meta'}</button>
    </div>`;
  openModal(existing ? 'Editar meta' : 'Nueva meta', html, (data) => {
    data.target = parseFloat(data.target);
    data.saved = parseFloat(data.saved) || 0;
    if (existing) Object.assign(existing, data);
    else state.goals.push({ id: uid(), ...data });
    save(); closeModal(); renderMetas(); toast(existing ? 'Meta actualizada' : 'Meta creada');
  });
}

function addToGoalModal(g) {
  const html = `
    <div class="field">
      <label>Abonar a "${esc(g.name)}"</label>
      <input type="number" name="amount" step="0.01" placeholder="Monto a agregar" required />
      <div class="hint">Usa un número negativo para retirar.</div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-cancel" onclick="closeModal()">Cancelar</button>
      <button type="submit" class="btn-primary">Abonar</button>
    </div>`;
  openModal('Abonar a meta', html, (data) => {
    g.saved = Math.max(0, (parseFloat(g.saved)||0) + (parseFloat(data.amount)||0));
    save(); closeModal(); renderMetas(); toast('Abono registrado');
  });
}

function renderMetas() {
  const grid = document.getElementById('metasGrid');
  if (!state.goals.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">Aún no tienes metas. Crea una para empezar a ahorrar 🎯</div>`;
    return;
  }
  const avgExp = avgMonthlyExpenses(3);
  grid.innerHTML = state.goals.map(g => {
    const saved = parseFloat(g.saved) || 0;
    // Fondo de emergencia: objetivo = promedio gasto mensual (últimos 3 meses) × N meses
    const target = g.emergency ? Math.round(avgExp * (g.months || 3)) : (parseFloat(g.target) || 0);
    const pct = target > 0 ? Math.min(100, (saved / target) * 100) : 0;
    const rest = Math.max(0, target - saved);
    const done = saved >= target && target > 0;
    let cls = 'red'; if (pct >= 100) cls = 'green'; else if (pct >= 50) cls = 'amber'; else if (pct >= 25) cls = '';
    let dateInfo = '';
    if (g.emergency) {
      const cubiertos = avgExp > 0 ? saved / avgExp : 0;
      dateInfo = avgExp > 0
        ? `🛟 ${cubiertos.toFixed(1)} de ${g.months || 3} meses de gastos cubiertos (${money(avgExp)}/mes)`
        : '🛟 Registra gastos para calcular tu objetivo automáticamente';
    } else if (g.targetDate) {
      const d = daysBetween(todayISO(), g.targetDate);
      dateInfo = d >= 0 ? `${fmtDate(g.targetDate)} · faltan ${d} días` : `Venció ${fmtDate(g.targetDate)}`;
      if (rest > 0 && d > 0) {
        const perMonth = rest / (d / 30);
        dateInfo += ` · ${moneyShort(perMonth)}/mes`;
      }
    }
    return `<div class="goal-card ${done ? 'done' : ''} ${g.emergency ? 'emergency' : ''}">
      <div class="goal-top">
        <div>
          <div class="goal-name">${esc(g.name)}${g.emergency ? '<span class="badge">AUTO</span>' : ''} ${done ? '✅' : ''}</div>
          ${g.note ? `<div class="goal-sub">${esc(g.note)}</div>` : ''}
        </div>
        <div class="row-actions">
          <button class="icon-btn" onclick="editMeta('${g.id}')">✎</button>
          <button class="icon-btn danger" onclick="delMeta('${g.id}')">🗑</button>
        </div>
      </div>
      <div class="goal-amounts">
        <div><div class="lbl">Ahorrado</div><div class="big amount-save">${money(saved)}</div></div>
        <div style="text-align:right"><div class="lbl">Objetivo</div><div class="big">${money(target)}</div></div>
      </div>
      <div class="progress ${cls}"><span style="width:${pct}%"></span></div>
      <div class="goal-meta">
        <span>${pct.toFixed(0)}% completado</span>
        <span>${done ? '¡Meta alcanzada!' : 'Faltan ' + money(rest)}</span>
      </div>
      ${dateInfo ? `<div class="goal-meta"><span>📅 ${dateInfo}</span></div>` : ''}
      <div class="goal-actions">
        <button class="btn-sm primary" onclick="abonarMeta('${g.id}')">+ Abonar</button>
      </div>
    </div>`;
  }).join('');
}
window.editMeta = (id) => { const g = state.goals.find(x => x.id === id); g && g.emergency ? emergencyModal(g) : metaModal(g); };
window.abonarMeta = (id) => addToGoalModal(state.goals.find(g => g.id === id));
window.delMeta = (id) => {
  if (!confirm('¿Eliminar esta meta?')) return;
  state.goals = state.goals.filter(g => g.id !== id);
  save(); renderMetas(); toast('Meta eliminada');
};
document.getElementById('btnNuevaMeta').addEventListener('click', () => metaModal());

// --- Fondo de emergencia (meta especial con objetivo automático) ---
function emergencyModal(existing) {
  const g = existing || { name: 'Fondo de emergencia', emergency: true, months: 3, saved: 0, note: '' };
  const avg = avgMonthlyExpenses(3);
  const html = `
    <div class="field">
      <label>Nombre</label>
      <input type="text" name="name" value="${esc(g.name)}" required />
    </div>
    <div class="field-row">
      <div class="field">
        <label>Meses de colchón</label>
        <input type="number" name="months" value="${g.months || 3}" min="1" max="24" step="1" required />
        <div class="hint">Objetivo = gasto mensual promedio × meses.</div>
      </div>
      <div class="field">
        <label>Ahorrado hasta ahora</label>
        <input type="number" name="saved" value="${g.saved || 0}" step="0.01" min="0" placeholder="0.00" />
      </div>
    </div>
    <div class="field">
      <label>Objetivo estimado</label>
      <input type="text" value="${avg > 0 ? money(avg) + '/mes × ' + (g.months || 3) + ' = ' + money(avg * (g.months || 3)) : 'Sin gastos registrados aún'}" disabled />
      <div class="hint">Se recalcula solo con el promedio de gastos de los últimos 3 meses.</div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-cancel" onclick="closeModal()">Cancelar</button>
      <button type="submit" class="btn-primary">${existing ? 'Guardar' : 'Crear fondo'}</button>
    </div>`;
  openModal(existing ? 'Editar fondo de emergencia' : 'Fondo de emergencia', html, (data) => {
    data.emergency = true;
    data.months = parseInt(data.months) || 3;
    data.saved = parseFloat(data.saved) || 0;
    data.target = ''; // el objetivo es dinámico
    if (existing) Object.assign(existing, data);
    else state.goals.push({ id: uid(), ...data });
    save(); closeModal(); renderMetas(); toast(existing ? 'Fondo actualizado' : 'Fondo de emergencia creado');
  });
}
document.getElementById('btnFondoEmergencia').addEventListener('click', () => {
  const existing = state.goals.find(g => g.emergency);
  if (existing) { navigate('metas'); emergencyModal(existing); }
  else emergencyModal();
});

/* ============================================================
   PRESUPUESTO POR CATEGORÍA
   ============================================================ */
// Categorías que se consideran "ingreso" y por tanto no se presupuestan como gasto
const INCOME_CATS = ['salario', 'freelance'];
// Clasificación por defecto para la plantilla 50/30/20
const NEEDS_CATS = ['comida', 'supermercado', 'transporte', 'renta', 'servicios', 'salud', 'educación', 'educacion'];

// Factor de "meses" que abarca un rango (1.0 = un mes completo); para prorratear límites mensuales
function monthsFactor(from, to) {
  const f = new Date(from + 'T00:00:00'), t = new Date(to + 'T00:00:00');
  let factor = 0, cur = new Date(f.getFullYear(), f.getMonth(), 1);
  while (cur <= t) {
    const y = cur.getFullYear(), mi = cur.getMonth(), dim = new Date(y, mi + 1, 0).getDate();
    const ovStart = f > new Date(y, mi, 1) ? f : new Date(y, mi, 1);
    const ovEnd = t < new Date(y, mi, dim) ? t : new Date(y, mi, dim);
    const days = Math.round((ovEnd - ovStart) / 86400000) + 1;
    if (days > 0) factor += days / dim;
    cur = new Date(y, mi + 1, 1);
  }
  return factor || 1;
}
// --- Sueldo fijo ---
// Frecuencias soportadas y su equivalencia a "veces por mes"
const INCOME_FREQ = { semanal: 52 / 12, quincenal: 2, mensual: 1 };
const INCOME_FREQ_LABEL = { semanal: 'semanal', quincenal: 'quincenal', mensual: 'mensual' };
// Sueldo fijo normalizado a un monto MENSUAL (para prorratear por rango como los límites)
function monthlyFixedIncome() {
  const amt = parseFloat(state.settings.incomeAmount) || 0;
  const mult = INCOME_FREQ[state.settings.incomeFreq] || 1;
  return amt * mult;
}
// Gasto por categoría dentro de un rango [from,to]
function spentByCategoryRange(from, to) {
  const map = {};
  state.transactions.forEach(t => {
    if (t.date < from || t.date > to) return;
    if (t.type === 'Gasto') { const k = t.category || 'Sin categoría'; map[k] = (map[k] || 0) + t.amount; }
    else if (isCardPayment(t)) { const k = '💳 ' + (t.toAccount || 'Tarjeta'); map[k] = (map[k] || 0) + t.amount; }
  });
  return map;
}

let budgetRange = currentMonthRange();
function renderPresupuesto() {
  const r = budgetRange || defaultDashRange();
  const factor = monthsFactor(r.from, r.to);
  const spent = spentByCategoryRange(r.from, r.to);
  const cats = Object.keys(state.budgets).filter(c => (state.budgets[c] || 0) > 0);
  // Límite del periodo = límite mensual × meses que abarca el rango
  const limitFor = (c) => (state.budgets[c] || 0) * factor;

  let totalLimit = 0, totalSpent = 0;
  cats.forEach(c => { totalLimit += limitFor(c); totalSpent += spent[c] || 0; });

  // Sueldo fijo prorrateado al periodo seleccionado (mismo factor que los límites)
  const incomeMonthly = monthlyFixedIncome();
  const incomePeriod = incomeMonthly * factor;
  const unassigned = incomePeriod - totalLimit; // "el resto": lo que queda por repartir o guardar

  // Banner de sueldo (editable)
  const incomeEl = document.getElementById('budgetIncome');
  if (incomeMonthly > 0) {
    const freqLbl = INCOME_FREQ_LABEL[state.settings.incomeFreq] || 'mensual';
    const raw = parseFloat(state.settings.incomeAmount) || 0;
    incomeEl.className = 'budget-income';
    incomeEl.innerHTML = `
      <div class="bi-main">
        <div class="bi-amt">${money(incomePeriod)}</div>
        <div class="bi-sub">Sueldo de este periodo · ${money(raw)} ${freqLbl}</div>
      </div>
      <button class="btn-sm" id="btnEditarSueldo">✎ Editar sueldo</button>`;
  } else {
    incomeEl.className = 'budget-income empty-income';
    incomeEl.innerHTML = `
      <div class="bi-main"><div class="bi-sub">Define tu sueldo fijo para ver cuánto te queda por repartir.</div></div>
      <button class="btn-primary btn-sm" id="btnEditarSueldo">💵 Definir sueldo fijo</button>`;
  }
  document.getElementById('btnEditarSueldo').addEventListener('click', incomeModal);

  document.getElementById('budgetTotal').textContent = money(totalLimit);
  document.getElementById('budgetSpent').textContent = money(totalSpent);
  document.getElementById('budgetLeft').textContent = money(totalLimit - totalSpent);
  const unEl = document.getElementById('budgetUnassigned');
  const unFoot = document.getElementById('budgetUnassignedFoot');
  if (incomeMonthly > 0) {
    unEl.textContent = money(unassigned);
    unEl.className = 'stat-value' + (unassigned < 0 ? ' amount-neg' : '');
    const pct = incomePeriod > 0 ? (totalLimit / incomePeriod) * 100 : 0;
    unFoot.textContent = unassigned >= 0
      ? `Has repartido ${pct.toFixed(0)}% de tu sueldo`
      : `Sobreasignado por ${money(-unassigned)}`;
  } else {
    unEl.textContent = '—';
    unEl.className = 'stat-value';
    unFoot.textContent = 'Define tu sueldo fijo';
  }

  const grid = document.getElementById('budgetGrid');
  if (!cats.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">Aún no asignas límites. Usa <b>+ Asignar límite</b> o la <b>plantilla 50/30/20</b> ⚡</div>`;
    return;
  }
  // ordenar por % usado descendente
  cats.sort((a, b) => ((spent[b] || 0) / limitFor(b)) - ((spent[a] || 0) / limitFor(a)));
  grid.innerHTML = cats.map(c => {
    const limit = limitFor(c);
    const used = spent[c] || 0;
    const rest = limit - used;
    const pct = limit > 0 ? (used / limit) * 100 : 0;
    const cls = pct > 100 ? 'red' : pct >= 80 ? 'amber' : 'green';
    // Movimientos del rango que componen el gasto de esta categoría
    const movs = state.transactions
      .filter(t => t.type === 'Gasto' && (t.category || 'Sin categoría') === c && t.date >= r.from && t.date <= r.to)
      .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    const movsHtml = movs.length
      ? movs.map(t => `<div class="btx-row">
          <span class="muted">${fmtDate(t.date)}</span>
          <span class="btx-desc">${dispDesc(t)}${t.account ? ` <span class="muted">· ${esc(t.account)}</span>` : ''}</span>
          <span class="ta-r amount-neg">${money(t.amount)}</span>
        </div>`).join('')
      : `<div class="btx-row muted">Sin movimientos en el periodo.</div>`;
    return `<div class="goal-card">
      <div class="goal-top">
        <div><div class="goal-name">${esc(c)}</div></div>
        <div class="row-actions">
          <button class="icon-btn" onclick="editBudget('${esc(c)}')">✎</button>
          <button class="icon-btn danger" onclick="delBudget('${esc(c)}')">🗑</button>
        </div>
      </div>
      <div class="goal-amounts">
        <div><div class="lbl">Gastado</div><div class="big ${pct > 100 ? 'amount-neg' : ''}">${money(used)}</div></div>
        <div style="text-align:right"><div class="lbl">Límite</div><div class="big">${money(limit)}</div></div>
      </div>
      <div class="progress ${cls}"><span style="width:${Math.min(100, pct)}%"></span></div>
      <div class="budget-foot">
        <span>${pct.toFixed(0)}% usado</span>
        <span class="${rest < 0 ? 'over' : ''}">${rest >= 0 ? 'Restante ' + money(rest) : 'Excedido ' + money(-rest)}</span>
      </div>
      <details class="budget-tx">
        <summary>Ver movimientos (${movs.length})</summary>
        <div class="btx-list">${movsHtml}</div>
      </details>
    </div>`;
  }).join('');
}

function budgetModal(existingCat) {
  const cat = existingCat || '';
  const limit = existingCat ? state.budgets[existingCat] : '';
  const html = `
    <div class="field">
      <label>Categoría</label>
      <input list="dlCategorias" name="category" value="${esc(cat)}" placeholder="Ej. Comida" ${existingCat ? 'readonly' : ''} required autocomplete="off" />
      <div class="hint">Si no existe, se agregará a tu lista de categorías.</div>
    </div>
    <div class="field">
      <label>Límite mensual</label>
      <input type="number" name="limit" value="${limit ?? ''}" step="0.01" min="0" placeholder="0.00" required />
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-cancel" onclick="closeModal()">Cancelar</button>
      <button type="submit" class="btn-primary">${existingCat ? 'Guardar' : 'Asignar'}</button>
    </div>`;
  openModal(existingCat ? 'Editar límite' : 'Asignar límite', html, (data) => {
    const c = (data.category || '').trim();
    if (!c) return toast('Indica una categoría', 'error');
    const lim = parseFloat(data.limit) || 0;
    if (!state.categories.some(x => x.toLowerCase() === c.toLowerCase())) state.categories.push(c);
    state.budgets[c] = lim;
    save(); refreshDatalists(); closeModal(); renderPresupuesto();
    toast(existingCat ? 'Límite actualizado' : 'Límite asignado');
  });
}
// Configurar el sueldo fijo (monto + frecuencia)
function incomeModal() {
  const raw = parseFloat(state.settings.incomeAmount) || '';
  const freq = state.settings.incomeFreq || 'mensual';
  const opt = (v, lbl) => `<option value="${v}" ${freq === v ? 'selected' : ''}>${lbl}</option>`;
  const html = `
    <div class="field">
      <label>Sueldo fijo</label>
      <input type="number" name="amount" value="${raw}" step="0.01" min="0" placeholder="0.00" required autofocus />
    </div>
    <div class="field">
      <label>¿Cada cuánto lo recibes?</label>
      <select name="freq">${opt('semanal', 'Semanal')}${opt('quincenal', 'Quincenal')}${opt('mensual', 'Mensual')}</select>
      <div class="hint">Se ajusta automáticamente al periodo que elijas arriba.</div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-cancel" onclick="closeModal()">Cancelar</button>
      <button type="submit" class="btn-primary">Guardar</button>
    </div>`;
  openModal('Sueldo fijo', html, (data) => {
    state.settings.incomeAmount = parseFloat(data.amount) || 0;
    state.settings.incomeFreq = data.freq || 'mensual';
    save(); closeModal(); renderPresupuesto();
    toast('Sueldo actualizado');
  });
}
window.editBudget = (c) => budgetModal(c);
window.delBudget = (c) => {
  if (!confirm('¿Quitar el límite de "' + c + '"?')) return;
  delete state.budgets[c];
  save(); renderPresupuesto(); toast('Límite eliminado');
};

// Plantilla 50/30/20: 50% necesidades, 30% deseos, 20% ahorro
function aplicarPlantilla503020() {
  const sugerido = Math.round(monthlyFixedIncome() || avgMonthlyIncome(3)) || '';
  const raw = prompt('Plantilla 50/30/20\n\nIngreso mensual neto a repartir:\n(50% necesidades · 30% deseos · 20% ahorro)', sugerido);
  if (raw === null) return;
  const income = parseFloat(raw);
  if (!income || income <= 0) return toast('Ingreso no válido', 'error');
  if (Object.keys(state.budgets).length && !confirm('Esto reemplazará los límites actuales por la repartición 50/30/20. ¿Continuar?')) return;

  const expenseCats = state.categories.filter(c => !INCOME_CATS.includes(c.toLowerCase()) && c.toLowerCase() !== 'ahorro');
  const needs = expenseCats.filter(c => NEEDS_CATS.includes(c.toLowerCase()));
  const wants = expenseCats.filter(c => !NEEDS_CATS.includes(c.toLowerCase()));
  const budgets = {};
  if (needs.length) { const per = (income * 0.5) / needs.length; needs.forEach(c => budgets[c] = Math.round(per)); }
  if (wants.length) { const per = (income * 0.3) / wants.length; wants.forEach(c => budgets[c] = Math.round(per)); }
  // 20% ahorro → categoría "Ahorro"
  const ahorroCat = state.categories.find(c => c.toLowerCase() === 'ahorro') || 'Ahorro';
  if (!state.categories.some(c => c.toLowerCase() === 'ahorro')) state.categories.push('Ahorro');
  budgets[ahorroCat] = Math.round(income * 0.2);

  state.budgets = budgets;
  save(); refreshDatalists(); renderPresupuesto();
  toast('Plantilla 50/30/20 aplicada');
}
// Promedio de ingreso mensual de los últimos n meses
function avgMonthlyIncome(n = 3) {
  const keys = lastNMonths(n).map(m => m.key);
  let sum = 0;
  state.transactions.forEach(t => { if (t.type === 'Ingreso' && keys.includes(t.date.slice(0, 7))) sum += t.amount; });
  return sum / n;
}
createRangePicker(
  { label: 'bpLabel', prev: 'bpPrev', next: 'bpNext', trigger: 'bpTrigger', panel: 'bpPanel', calLeft: 'bpCalLeft', calRight: 'bpCalRight', selLabel: 'bpSelLabel', apply: 'bpApply' },
  (r) => { budgetRange = r; renderPresupuesto(); },
  budgetRange
);
document.getElementById('btnNuevoPresupuesto').addEventListener('click', () => budgetModal());
document.getElementById('btnPlantilla503020').addEventListener('click', aplicarPlantilla503020);

/* ============================================================
   DEUDAS
   ============================================================ */
const DEBT_TYPES = ['Tarjeta de crédito', 'Suscripción', 'Préstamo / Externa', 'Otra'];

function deudaModal(existing) {
  const d = existing || { name: '', dtype: 'Tarjeta de crédito', total: '', paid: 0, monthly: '', dueDate: '', link: '' };
  const html = `
    <div class="field">
      <label>Nombre</label>
      <input type="text" name="name" value="${esc(d.name)}" placeholder="Ej. Tarjeta Nu, Netflix, Préstamo a Juan" required />
    </div>
    <div class="field">
      <label>Tipo</label>
      <select name="dtype">${DEBT_TYPES.map(t => `<option ${t===d.dtype?'selected':''}>${t}</option>`).join('')}</select>
    </div>
    <div class="field-row">
      <div class="field">
        <label>Monto total</label>
        <input type="number" name="total" value="${d.total}" step="0.01" min="0" placeholder="0.00" required />
      </div>
      <div class="field">
        <label>Ya pagado</label>
        <input type="number" name="paid" value="${d.paid}" step="0.01" min="0" placeholder="0.00" />
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>Pago mensual</label>
        <input type="number" name="monthly" value="${d.monthly}" step="0.01" min="0" placeholder="0.00" />
      </div>
      <div class="field">
        <label>Próximo pago / corte</label>
        <input type="date" name="dueDate" value="${d.dueDate || ''}" />
      </div>
    </div>
    <div class="field">
      <label>Vincular a categoría o cuenta (opcional)</label>
      <input list="dlLink" name="link" value="${esc(d.link || '')}" placeholder="Ej. Disney, Rappi…" autocomplete="off" />
      <div class="hint">Los gastos con esta categoría y las transferencias a esta cuenta se descontarán solos de esta deuda.</div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-cancel" onclick="closeModal()">Cancelar</button>
      <button type="submit" class="btn-primary">${existing ? 'Guardar cambios' : 'Agregar deuda'}</button>
    </div>`;
  openModal(existing ? 'Editar deuda' : 'Nueva deuda', html, (data) => {
    data.total = parseFloat(data.total) || 0;
    data.paid = parseFloat(data.paid) || 0;
    data.monthly = parseFloat(data.monthly) || 0;
    data.link = (data.link || '').trim();
    if (existing) Object.assign(existing, data);
    else state.debts.push({ id: uid(), ...data });
    save(); closeModal(); renderDeudas(); toast(existing ? 'Deuda actualizada' : 'Deuda agregada');
  });
}

function pagarDeudaModal(d) {
  const html = `
    <div class="field">
      <label>Registrar pago a "${esc(d.name)}"</label>
      <input type="number" name="amount" step="0.01" value="${d.monthly || ''}" placeholder="Monto pagado" required />
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-cancel" onclick="closeModal()">Cancelar</button>
      <button type="submit" class="btn-primary">Registrar pago</button>
    </div>`;
  openModal('Registrar pago', html, (data) => {
    d.paid = Math.min(d.total, (parseFloat(d.paid)||0) + (parseFloat(data.amount)||0));
    save(); closeModal(); renderDeudas(); toast('Pago registrado');
  });
}

// Suma de pagos automáticos según la categoría/cuenta vinculada a la deuda
function debtAutoPaid(d) {
  if (!d.link) return 0;
  const L = d.link.toLowerCase();
  let sum = 0;
  state.transactions.forEach(t => {
    if (t.type === 'Gasto' && (t.category || '').toLowerCase() === L) sum += t.amount;
    else if (t.type === 'Transferencia' && (t.toAccount || '').toLowerCase() === L) sum += t.amount;
  });
  return sum;
}

function renderDeudas() {
  const grid = document.getElementById('deudasGrid');
  const cards = state.accounts.filter(a => a.kind === 'credito');

  // ----- Totales (deudas manuales + tarjetas de crédito) -----
  let manualPend = 0;
  state.debts.forEach(d => { manualPend += Math.max(0, (d.total||0) - ((d.paid||0) + debtAutoPaid(d))); });
  let cardsOwed = 0, cardsLimit = 0;
  cards.forEach(a => { cardsOwed += Math.max(0, cardOwed(a)); cardsLimit += (parseFloat(a.limit) || 0); });
  const disponible = Math.max(0, cardsLimit - cardsOwed);
  document.getElementById('deudaTotal').textContent = money(manualPend + cardsOwed);
  document.getElementById('deudaMensual').textContent = money(cardsOwed);
  document.getElementById('deudaPagado').textContent = money(disponible);

  // ----- Tarjetas de crédito -----
  const tgrid = document.getElementById('tarjetasGrid');
  if (!cards.length) {
    tgrid.innerHTML = `<div class="empty" style="grid-column:1/-1">No tienes tarjetas de crédito. Agrégalas en Ajustes ⚙️.</div>`;
  } else {
    tgrid.innerHTML = cards.map(a => {
      const owedRaw = cardOwed(a);                 // puede ser negativo = saldo a favor
      const owed = Math.max(0, owedRaw);
      const credit = Math.max(0, -owedRaw);        // saldo a favor (pagaste de más)
      const limit = parseFloat(a.limit) || 0;
      const avail = Math.max(0, limit - owedRaw);  // si hay saldo a favor, suma al disponible
      const pct = limit > 0 ? Math.min(100, (owed / limit) * 100) : 0;
      const cls = pct >= 90 ? 'red' : pct >= 60 ? 'amber' : 'green';
      const dc = daysUntilDay(a.cutDay), dp = daysUntilDay(a.dueDay);
      const cutDate = nextDateForDay(a.cutDay), dueDate = nextDateForDay(a.dueDay);
      const freeDays = interestFreeDaysIfBuyToday(a);
      const corte = a.cutDay ? `Corte ${fmtDate(cutDate.toISOString().slice(0, 10))} · en ${dc}d` : 'Sin día de corte';
      const pago = a.dueDay ? `Pago ${fmtDate(dueDate.toISOString().slice(0, 10))} · en ${dp}d` : 'Sin día de pago';
      const warnPago = dp !== null && dp <= 5 && owed > 0;
      return `<div class="goal-card">
        <div class="goal-top">
          <div>
            <div class="goal-name">💳 ${esc(a.name)}</div>
            <div class="goal-sub">Tarjeta de crédito</div>
          </div>
          <div class="row-actions">
            <button class="icon-btn" onclick="editAccount('${a.id}')">✎</button>
          </div>
        </div>
        <div class="goal-amounts">
          <div><div class="lbl">${credit > 0 ? 'A favor' : 'Debes'}</div><div class="big ${credit > 0 ? 'amount-pos' : 'amount-neg'}">${money(credit > 0 ? credit : owed)}</div></div>
          <div style="text-align:right"><div class="lbl">Disponible</div><div class="big amount-pos">${money(avail)}</div></div>
        </div>
        <div class="progress ${cls}"><span style="width:${pct}%"></span></div>
        <div class="goal-meta"><span>${pct.toFixed(0)}% del límite (${money(limit)})</span></div>
        <div class="goal-meta"><span>🗓️ ${corte}</span></div>
        <div class="goal-meta"><span class="${warnPago ? 'warn-text' : ''}">💰 ${pago}</span></div>
        ${freeDays !== null ? `<div class="goal-meta"><span>✨ Si compras hoy: <b style="color:var(--text)">${freeDays} días</b> sin intereses</span></div>` : ''}
        ${credit > 0
          ? `<div class="pay-note ok">Tienes <b>${money(credit)}</b> a favor en esta tarjeta 🎉</div>`
          : owed > 0
            ? `<div class="pay-note ${warnPago ? 'warn' : ''}">Para no generar intereses paga <b>${money(owed)}</b>${a.dueDay ? ' antes del ' + fmtDate(dueDate.toISOString().slice(0, 10)) : ''}.</div>`
            : `<div class="pay-note ok">Sin saldo pendiente 🎉</div>`}
        <div class="goal-actions">
          <button class="btn-sm primary" onclick="pagarTarjeta('${a.id}')">Pagar tarjeta</button>
        </div>
      </div>`;
    }).join('');
  }

  // ----- Compras a Meses Sin Intereses -----
  renderMSI();

  // ----- Deudas manuales (suscripciones, préstamos…) -----
  if (!state.debts.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">Sin otras deudas registradas. 🎉</div>`;
    return;
  }
  const icons = { 'Tarjeta de crédito':'💳', 'Suscripción':'🔁', 'Préstamo / Externa':'🤝', 'Otra':'📄' };
  grid.innerHTML = state.debts.map(d => {
    const total = d.total||0;
    const auto = debtAutoPaid(d);
    const paid = (d.paid||0) + auto;
    const pct = total > 0 ? Math.min(100, (paid/total)*100) : 0;
    const rest = Math.max(0, total - paid);
    const cls = pct >= 100 ? 'green' : pct >= 50 ? 'amber' : 'red';
    const done = rest <= 0 && total > 0;
    return `<div class="goal-card ${done?'done':''}">
      <div class="goal-top">
        <div>
          <div class="goal-name">${icons[d.dtype]||'📄'} ${esc(d.name)} ${done ? '✅' : ''}</div>
          <div class="goal-sub">${esc(d.dtype)}${d.dueDate ? ' · vence ' + fmtDate(d.dueDate) : ''}${d.link ? ' · 🔗 ' + esc(d.link) : ''}</div>
        </div>
        <div class="row-actions">
          <button class="icon-btn" onclick="editDeuda('${d.id}')">✎</button>
          <button class="icon-btn danger" onclick="delDeuda('${d.id}')">🗑</button>
        </div>
      </div>
      <div class="goal-amounts">
        <div><div class="lbl">Pendiente</div><div class="big amount-neg">${money(rest)}</div></div>
        <div style="text-align:right"><div class="lbl">Total</div><div class="big">${money(total)}</div></div>
      </div>
      <div class="progress ${cls}"><span style="width:${pct}%"></span></div>
      <div class="goal-meta">
        <span>${pct.toFixed(0)}% pagado</span>
        ${d.monthly ? `<span>${money(d.monthly)}/mes</span>` : ''}
      </div>
      ${auto > 0 ? `<div class="goal-meta"><span>↳ ${money(auto)} desde transacciones vinculadas</span></div>` : ''}
      <div class="goal-actions">
        <button class="btn-sm primary" onclick="pagarDeuda('${d.id}')">Registrar pago manual</button>
      </div>
    </div>`;
  }).join('');
}
window.editDeuda = (id) => deudaModal(state.debts.find(d => d.id === id));
window.pagarDeuda = (id) => pagarDeudaModal(state.debts.find(d => d.id === id));
window.pagarTarjeta = (id) => {
  const a = state.accounts.find(x => x.id === id); if (!a) return;
  const owed = Math.max(0, cardOwed(a));
  txModal(null, { type: 'Transferencia', toAccount: a.name, amount: owed || '', description: 'Pago a ' + a.name, category: 'Transferencia' });
};
window.delDeuda = (id) => {
  if (!confirm('¿Eliminar esta deuda?')) return;
  state.debts = state.debts.filter(d => d.id !== id);
  save(); renderDeudas(); toast('Deuda eliminada');
};
document.getElementById('btnNuevaDeuda').addEventListener('click', () => deudaModal());

/* ============================================================
   MSI — Meses Sin Intereses
   ============================================================ */
const MSI_TERMS = [3, 6, 9, 12, 18, 24];

function msiModal(existing) {
  const m = existing || { name: '', total: '', term: 12, startDate: todayISO(), account: '' };
  const html = `
    <div class="field">
      <label>Descripción de la compra</label>
      <input name="name" value="${esc(m.name)}" placeholder="Ej. Laptop, Refrigerador" required />
    </div>
    <div class="field-row">
      <div class="field">
        <label>Monto total</label>
        <input type="number" name="total" value="${m.total}" step="0.01" min="0" placeholder="0.00" required />
      </div>
      <div class="field">
        <label>Plazo (meses)</label>
        <select name="term">${MSI_TERMS.map(t => `<option ${t === m.term ? 'selected' : ''} value="${t}">${t} MSI</option>`).join('')}</select>
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>Fecha de la compra</label>
        <input type="date" name="startDate" value="${m.startDate}" required />
      </div>
      <div class="field">
        <label>Tarjeta (opcional)</label>
        <input list="dlCuentas" name="account" value="${esc(m.account || '')}" placeholder="Ej. Rappi" autocomplete="off" />
      </div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-cancel" onclick="closeModal()">Cancelar</button>
      <button type="submit" class="btn-primary">${existing ? 'Guardar cambios' : 'Registrar compra'}</button>
    </div>`;
  openModal(existing ? 'Editar compra a MSI' : 'Nueva compra a MSI', html, (data) => {
    data.total = parseFloat(data.total) || 0;
    data.term = parseInt(data.term) || 12;
    data.account = (data.account || '').trim();
    if (existing) Object.assign(existing, data);
    else state.msi.push({ id: uid(), ...data });
    save(); closeModal(); renderDeudas(); toast(existing ? 'Compra actualizada' : 'Compra a MSI registrada');
  });
}

function renderMSI() {
  const grid = document.getElementById('msiGrid');
  const summary = document.getElementById('msiSummary');
  if (!state.msi.length) {
    summary.innerHTML = '';
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">Sin compras a meses sin intereses. 🎉</div>`;
    return;
  }

  // Resumen: cargo comprometido por mes (desde el mes actual en adelante)
  const sched = msiSchedule();
  const curKey = currentMonthKey();
  const upcoming = Object.keys(sched).filter(k => k >= curKey).sort().slice(0, 6);
  const totalPendiente = state.msi.reduce((s, m) => s + msiPending(m), 0);
  const cargoMesActual = sched[curKey] || 0;
  summary.innerHTML = `
    <div class="stat-grid three" style="margin-bottom:14px">
      <div class="stat-card debt"><div class="stat-label">Comprometido este mes</div><div class="stat-value">${money(cargoMesActual)}</div></div>
      <div class="stat-card expense"><div class="stat-label">Saldo pendiente total</div><div class="stat-value">${money(totalPendiente)}</div></div>
      <div class="stat-card saving"><div class="stat-label">Compras activas</div><div class="stat-value">${state.msi.filter(msiActive).length}</div></div>
    </div>
    <div class="msi-strip">${upcoming.map(k => `<div class="msi-month ${k === curKey ? 'current' : ''}"><div class="m-lbl">${monthLabel(k)}</div><div class="m-amt">${money(sched[k])}</div></div>`).join('')}</div>`;

  grid.innerHTML = state.msi.map(m => {
    const monthly = msiMonthly(m);
    const paid = msiMonthsPaid(m);
    const pending = msiPending(m);
    const pct = m.term > 0 ? (paid / m.term) * 100 : 0;
    const done = paid >= m.term;
    return `<div class="goal-card ${done ? 'done' : ''}">
      <div class="goal-top">
        <div>
          <div class="goal-name">🧾 ${esc(m.name)} ${done ? '✅' : ''}</div>
          <div class="goal-sub">${m.term} MSI${m.account ? ' · ' + esc(m.account) : ''} · desde ${fmtDate(m.startDate)}</div>
        </div>
        <div class="row-actions">
          <button class="icon-btn" onclick="editMSI('${m.id}')">✎</button>
          <button class="icon-btn danger" onclick="delMSI('${m.id}')">🗑</button>
        </div>
      </div>
      <div class="goal-amounts">
        <div><div class="lbl">Pendiente</div><div class="big amount-neg">${money(pending)}</div></div>
        <div style="text-align:right"><div class="lbl">Total</div><div class="big">${money(m.total)}</div></div>
      </div>
      <div class="progress ${done ? 'green' : 'amber'}"><span style="width:${Math.min(100, pct)}%"></span></div>
      <div class="goal-meta">
        <span>${paid}/${m.term} pagados</span>
        <span>${money(monthly)}/mes</span>
      </div>
    </div>`;
  }).join('');
}
window.editMSI = (id) => msiModal(state.msi.find(m => m.id === id));
window.delMSI = (id) => {
  if (!confirm('¿Eliminar esta compra a MSI?')) return;
  state.msi = state.msi.filter(m => m.id !== id);
  save(); renderDeudas(); toast('Compra eliminada');
};
document.getElementById('btnNuevaMSI').addEventListener('click', () => msiModal());

/* ============================================================
   AJUSTES — Cuentas y Categorías
   ============================================================ */
function accountModal(existing) {
  const a = existing || { name: '', kind: 'debito', limit: '', cutDay: '', dueDay: '', opening: '' };
  const html = `
    <div class="field">
      <label>Nombre de la cuenta / cartera</label>
      <input name="name" value="${esc(a.name)}" placeholder="Ej. BBVA Débito, Rappi, Didi" required />
    </div>
    <div class="field">
      <label>Tipo de cuenta</label>
      <select name="kind" id="accKind" onchange="onAccKindChange()">
        <option value="debito" ${a.kind === 'debito' ? 'selected' : ''}>Débito / Efectivo</option>
        <option value="credito" ${a.kind === 'credito' ? 'selected' : ''}>Tarjeta de crédito</option>
      </select>
    </div>
    <div id="creditFields" class="hidden">
      <div class="field">
        <label>Límite de crédito</label>
        <input type="number" name="limit" value="${a.limit ?? ''}" step="0.01" min="0" placeholder="0.00" />
      </div>
      <div class="field-row">
        <div class="field">
          <label>Día de corte</label>
          <input type="number" name="cutDay" value="${a.cutDay ?? ''}" min="1" max="31" placeholder="1–31" />
        </div>
        <div class="field">
          <label>Día límite de pago</label>
          <input type="number" name="dueDay" value="${a.dueDay ?? ''}" min="1" max="31" placeholder="1–31" />
        </div>
      </div>
    </div>
    <div class="field">
      <label id="saldoLabel">Saldo actual</label>
      <input type="number" name="curBalance" value="${existing ? (Math.round((a.kind === 'credito' ? Math.max(0, cardOwed(a)) : debitBalance(a)) * 100) / 100) : ''}" step="0.01" placeholder="0.00" />
      <div class="hint" id="saldoHint">Ajustamos el saldo inicial para que el saldo mostrado sea éste.</div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-cancel" onclick="closeModal()">Cancelar</button>
      <button type="submit" class="btn-primary">${existing ? 'Guardar cambios' : 'Crear cuenta'}</button>
    </div>`;
  openModal(existing ? 'Editar cuenta' : 'Nueva cuenta', html, (data) => {
    data.name = (data.name || '').trim();
    if (!data.name) return toast('Ponle un nombre a la cuenta', 'error');
    const dup = state.accounts.find(x => sameAcc(x.name, data.name) && (!existing || x.id !== existing.id));
    if (dup) return toast('Ya existe una cuenta con ese nombre', 'error');
    const credit = data.kind === 'credito';
    const fields = {
      kind: data.kind,
      limit: credit ? (parseFloat(data.limit) || 0) : undefined,
      cutDay: credit ? (parseInt(data.cutDay) || null) : undefined,
      dueDay: credit ? (parseInt(data.dueDay) || null) : undefined,
    };
    // "Saldo actual": retro-calcula el saldo inicial (opening) para que el saldo MOSTRADO sea el que tecleó el usuario
    const curStr = (data.curBalance ?? '').toString().trim();
    if (existing) {
      if (curStr === '') {
        fields.opening = existing.opening;
      } else {
        const target = parseFloat(curStr) || 0;
        const flow = (credit ? cardOwed(existing) : debitBalance(existing)) - (parseFloat(existing.opening) || 0);
        fields.opening = Math.round((target - flow) * 100) / 100;
      }
    } else {
      fields.opening = curStr === '' ? 0 : (parseFloat(curStr) || 0);
    }
    if (existing) {
      const oldName = existing.name;
      Object.assign(existing, { name: data.name }, fields);
      if (!sameAcc(oldName, data.name)) {
        state.transactions.forEach(t => {
          if (sameAcc(t.account, oldName)) t.account = data.name;
          if (sameAcc(t.toAccount, oldName)) t.toAccount = data.name;
        });
        state.debts.forEach(d => { if (sameAcc(d.link, oldName)) d.link = data.name; });
      }
    } else {
      state.accounts.push({ id: uid(), name: data.name, ...fields });
    }
    save(); refreshDatalists(); closeModal(); renderAjustes(); toast(existing ? 'Cuenta actualizada' : 'Cuenta creada');
  });
  onAccKindChange();
}
window.onAccKindChange = function () {
  const k = document.getElementById('accKind'); if (!k) return;
  const credit = k.value === 'credito';
  document.getElementById('creditFields').classList.toggle('hidden', !credit);
  const lbl = document.getElementById('saldoLabel'), hint = document.getElementById('saldoHint');
  if (lbl) lbl.textContent = credit ? 'Saldo actual que debes hoy' : 'Saldo actual (lo que tienes hoy)';
  if (hint) hint.textContent = credit
    ? 'Ajustamos el saldo inicial para que tu deuda mostrada sea ésta (= límite − disponible).'
    : 'Ajustamos el saldo inicial para que tu saldo mostrado sea éste.';
};
window.editAccount = (id) => accountModal(state.accounts.find(a => a.id === id));
window.delAccount = (id) => {
  const a = state.accounts.find(x => x.id === id); if (!a) return;
  const used = state.transactions.some(t => sameAcc(t.account, a.name) || sameAcc(t.toAccount, a.name));
  const msg = used
    ? 'Esta cuenta tiene movimientos. Si la eliminas, esos movimientos conservarán el nombre pero la cuenta dejará de existir. ¿Continuar?'
    : '¿Eliminar esta cuenta?';
  if (!confirm(msg)) return;
  state.accounts = state.accounts.filter(x => x.id !== id);
  save(); refreshDatalists(); renderAjustes(); toast('Cuenta eliminada');
};

// --- Categorías (orden, renombrar, agregar, eliminar) ---
window.moveCat = (i, dir) => {
  const j = i + dir, c = state.categories;
  if (j < 0 || j >= c.length) return;
  [c[i], c[j]] = [c[j], c[i]];
  save(); refreshDatalists(); renderAjustes();
};
window.renameCat = (i) => {
  const cur = state.categories[i];
  const nv = prompt('Nuevo nombre de la categoría:', cur);
  if (nv === null) return;
  const v = nv.trim(); if (!v) return;
  if (state.categories.some((c, k) => k !== i && c.toLowerCase() === v.toLowerCase())) return toast('Ya existe esa categoría', 'error');
  state.transactions.forEach(t => { if ((t.category || '').toLowerCase() === cur.toLowerCase()) t.category = v; });
  state.debts.forEach(d => { if ((d.link || '').toLowerCase() === cur.toLowerCase()) d.link = v; });
  if (cur in state.budgets) { state.budgets[v] = state.budgets[cur]; delete state.budgets[cur]; }
  state.categories[i] = v;
  save(); refreshDatalists(); renderAjustes(); toast('Categoría renombrada');
};
window.delCat = (i) => {
  const c = state.categories[i];
  if (!confirm('¿Eliminar la categoría "' + c + '"? Los movimientos que la usan conservarán el texto.')) return;
  delete state.budgets[c];
  state.categories.splice(i, 1);
  save(); refreshDatalists(); renderAjustes(); toast('Categoría eliminada');
};
function addCategory() {
  const nv = prompt('Nombre de la nueva categoría:'); if (nv === null) return;
  const v = nv.trim(); if (!v) return;
  if (state.categories.some(c => c.toLowerCase() === v.toLowerCase())) return toast('Ya existe esa categoría', 'error');
  state.categories.push(v);
  save(); refreshDatalists(); renderAjustes(); toast('Categoría agregada');
}

function renderAjustes() {
  const cl = document.getElementById('cuentasList');
  cl.innerHTML = state.accounts.map(a => {
    const info = a.kind === 'credito'
      ? `Crédito · debes ${money(Math.max(0, cardOwed(a)))} de ${money(parseFloat(a.limit) || 0)}`
      : `Débito · saldo ${money(debitBalance(a))}`;
    return `<div class="list-row">
      <div><div class="list-name">${a.kind === 'credito' ? '💳' : '🏦'} ${esc(a.name)}</div><div class="list-sub">${info}</div></div>
      <div class="row-actions">
        <button class="icon-btn" onclick="editAccount('${a.id}')">✎</button>
        <button class="icon-btn danger" onclick="delAccount('${a.id}')">🗑</button>
      </div>
    </div>`;
  }).join('');

  const catl = document.getElementById('categoriasList');
  catl.innerHTML = state.categories.map((c, i) => `<div class="list-row">
    <div class="list-name">${esc(c)}</div>
    <div class="row-actions">
      <button class="icon-btn" onclick="moveCat(${i},-1)" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button class="icon-btn" onclick="moveCat(${i},1)" ${i === state.categories.length - 1 ? 'disabled' : ''}>▼</button>
      <button class="icon-btn" onclick="renameCat(${i})">✎</button>
      <button class="icon-btn danger" onclick="delCat(${i})">🗑</button>
    </div>
  </div>`).join('');
}
document.getElementById('btnNuevaCuenta').addEventListener('click', () => accountModal());
document.getElementById('btnNuevaCategoria').addEventListener('click', addCategory);

/* ============================================================
   HISTORIAL
   ============================================================ */
let histChart;
let histRange = defaultDashRange(); // ventana mostrada (la controla el selector de fechas)

function periodLabel(key, period) {
  if (period === 'year') return key;
  if (period === 'month') {
    const [y, m] = key.split('-');
    return new Date(y, m - 1, 1).toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
  }
  const d = new Date(key + 'T00:00:00');
  const end = new Date(d); end.setDate(end.getDate() + 6);
  return `${d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })} – ${end.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })}`;
}

// Granularidad automática según la duración del rango (sin botones de semanal/mensual/anual)
function autoGranularity(from, to) {
  const days = Math.round((new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000) + 1;
  if (days <= 16) return 'day';
  if (days <= 100) return 'week';
  if (days <= 731) return 'month';
  return 'year';
}
// Filas del historial dentro de [from,to]; incluye periodos vacíos y recorta los bordes al rango
function historyRows(from, to, gran) {
  const rows = [];
  const endD = new Date(to + 'T00:00:00');
  let cur = new Date(from + 'T00:00:00'), guard = 0;
  while (cur <= endD && guard++ < 2000) {
    const y = cur.getFullYear(), mi = cur.getMonth(), d = cur.getDate();
    let bStart, bEnd, key, label, next;
    if (gran === 'day') {
      bStart = new Date(y, mi, d); bEnd = new Date(y, mi, d); key = isoLocal(bStart);
      label = bStart.toLocaleDateString('es-MX', { weekday: 'short', day: '2-digit', month: 'short' });
      next = new Date(y, mi, d + 1);
    } else if (gran === 'week') {
      const mon = new Date(cur); mon.setDate(cur.getDate() - ((cur.getDay() + 6) % 7));
      bStart = mon; bEnd = new Date(mon); bEnd.setDate(mon.getDate() + 6); key = isoLocal(mon); label = periodLabel(key, 'week');
      next = new Date(bEnd); next.setDate(next.getDate() + 1);
    } else if (gran === 'month') {
      bStart = new Date(y, mi, 1); bEnd = new Date(y, mi + 1, 0); key = y + '-' + String(mi + 1).padStart(2, '0'); label = periodLabel(key, 'month');
      next = new Date(y, mi + 1, 1);
    } else {
      bStart = new Date(y, 0, 1); bEnd = new Date(y, 11, 31); key = String(y); label = key; next = new Date(y + 1, 0, 1);
    }
    const cs = isoLocal(bStart) < from ? from : isoLocal(bStart);
    const ce = isoLocal(bEnd) > to ? to : isoLocal(bEnd);
    let ingresos = 0, gastos = 0;
    state.transactions.forEach(t => {
      if (t.date < cs || t.date > ce) return;
      if (t.type === 'Ingreso') ingresos += t.amount;
      else if (t.type === 'Gasto' || isCardPayment(t)) gastos += t.amount;
    });
    rows.push({ key, label, ingresos, gastos, balance: ingresos - gastos, endISO: ce });
    cur = next;
  }
  return rows;
}

function renderHistorial() {
  let from, to;
  if (histRange) { from = histRange.from; to = histRange.to; }
  else { const ds = state.transactions.map(t => t.date).sort(); from = ds[0] || isoLocal(new Date()); to = ds[ds.length - 1] || isoLocal(new Date()); }
  const gran = autoGranularity(from, to);
  const data = historyRows(from, to, gran);
  const granLbl = { day: 'Detalle por día', week: 'Detalle por semana', month: 'Detalle por mes', year: 'Detalle por año' };
  document.getElementById('histChartTitle').textContent = `${granLbl[gran]} · ${rangeLabel(histRange)}`;

  document.getElementById('histEmpty').classList.toggle('hidden', data.length > 0);
  document.getElementById('histBody').innerHTML = [...data].reverse().map(r => {
    const cls = r.balance >= 0 ? 'amount-pos' : 'amount-neg';
    const res = r.balance >= 0
      ? `<span class="pill Ingreso">Ahorraste ${money(r.balance)}</span>`
      : `<span class="pill Gasto">Gastaste de más ${money(-r.balance)}</span>`;
    const end = r.endISO;
    const saldos = state.accounts.map(a => {
      if (a.kind === 'credito') {
        const owed = Math.max(0, cardOwedUpTo(a, end));
        const limit = parseFloat(a.limit) || 0;
        const val = limit ? money(Math.max(0, limit - owed)) : 'debe ' + money(owed);
        return `<div class="hsaldo"><span>💳 ${esc(a.name)}</span><span class="hs-val">${val}</span></div>`;
      }
      const bal = debitBalanceUpTo(a, end);
      return `<div class="hsaldo"><span>🏦 ${esc(a.name)}</span><span class="hs-val ${bal < 0 ? 'amount-neg' : ''}">${money(bal)}</span></div>`;
    }).join('');
    return `<tr>
      <td style="font-weight:600">${r.label}</td>
      <td class="ta-r amount-pos">${money(r.ingresos)}</td>
      <td class="ta-r amount-neg">${money(r.gastos)}</td>
      <td class="ta-r ${cls}">${money(r.balance)}</td>
      <td>${res}</td>
      <td class="hsaldos-cell">${saldos}</td>
    </tr>`;
  }).join('');

  const ctx = document.getElementById('chartHistorial');
  histChart?.destroy();
  histChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(d => d.label),
      datasets: [
        { label: 'Ingresos', data: data.map(d => d.ingresos), backgroundColor: '#22c55e', borderRadius: 6 },
        { label: 'Gastos', data: data.map(d => d.gastos), backgroundColor: '#f43f5e', borderRadius: 6 },
        { label: 'Balance', type: 'line', data: data.map(d => d.balance), borderColor: '#6366f1', backgroundColor: '#6366f1', tension: .3, borderWidth: 2, pointRadius: 3 },
      ]
    },
    options: baseChartOpts(true)
  });
}
createRangePicker(
  { label: 'hpLabel', prev: 'hpPrev', next: 'hpNext', trigger: 'hpTrigger', panel: 'hpPanel', calLeft: 'hpCalLeft', calRight: 'hpCalRight', selLabel: 'hpSelLabel', apply: 'hpApply' },
  (r) => { histRange = r; renderHistorial(); },
  histRange
);

/* ============================================================
   DASHBOARD
   ============================================================ */
let chIG, chCat, chTend, chNet;

// Llena el selector de periodos con los meses y años que existen en los datos
function populateDashControls() {
  const accSel = document.getElementById('dashAccount');
  const curA = accSel.value;
  accSel.innerHTML = `<option value="">Todas las cuentas</option>` +
    state.accounts.map(a => `<option value="${esc(a.name)}">${esc(a.name)}${a.kind === 'credito' ? ' 💳' : ''}</option>`).join('');
  accSel.value = curA || '';
  initDropdowns(accSel.parentNode);   // selector de cuenta con el tema de la app
}

/* ---------- Componente reutilizable: selector de rango de fechas ---------- */
// (declaraciones de función para que estén disponibles aunque se instancien pickers antes en el archivo)
function isoLocal(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function fmtRangePart(iso) { return new Date(iso + 'T00:00:00').toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }); }
function rangeLabel(r) { return r ? fmtRangePart(r.from) + ' – ' + fmtRangePart(r.to) : 'Todo el historial'; }

function defaultDashRange() {
  const months = [...new Set(state.transactions.map(t => t.date.slice(0, 7)))].sort();
  const mk = months.length ? months[months.length - 1] : currentMonthKey();
  const [y, m] = mk.split('-').map(Number);
  return { from: mk + '-01', to: isoLocal(new Date(y, m, 0)) };
}
function currentMonthRange() {
  const n = new Date(), y = n.getFullYear(), m = n.getMonth();
  return { from: isoLocal(new Date(y, m, 1)), to: isoLocal(new Date(y, m + 1, 0)) };
}
function presetRange(key) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const y = today.getFullYear(), m = today.getMonth();
  const monday = (d) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  if (key === 'thisWeek') { const s = monday(today), e = new Date(s); e.setDate(e.getDate() + 6); return { from: isoLocal(s), to: isoLocal(e) }; }
  if (key === 'lastWeek') { const s = monday(today); s.setDate(s.getDate() - 7); const e = new Date(s); e.setDate(e.getDate() + 6); return { from: isoLocal(s), to: isoLocal(e) }; }
  if (key === 'thisMonth') return { from: isoLocal(new Date(y, m, 1)), to: isoLocal(new Date(y, m + 1, 0)) };
  if (key === 'lastMonth') return { from: isoLocal(new Date(y, m - 1, 1)), to: isoLocal(new Date(y, m, 0)) };
  if (key === 'thisYear') return { from: y + '-01-01', to: y + '-12-31' };
  if (key === 'lastYear') return { from: (y - 1) + '-01-01', to: (y - 1) + '-12-31' };
  return null; // todo el historial
}
function shiftRange(range, dir) {
  if (!range) return range;
  const f = new Date(range.from + 'T00:00:00'), t = new Date(range.to + 'T00:00:00');
  const lastOf = (y, mi) => new Date(y, mi + 1, 0).getDate();
  const isMonth = f.getDate() === 1 && f.getMonth() === t.getMonth() && f.getFullYear() === t.getFullYear() && t.getDate() === lastOf(t.getFullYear(), t.getMonth());
  const isYear = f.getMonth() === 0 && f.getDate() === 1 && t.getMonth() === 11 && t.getDate() === 31 && f.getFullYear() === t.getFullYear();
  if (isMonth) { const d = new Date(f.getFullYear(), f.getMonth() + dir, 1); return { from: isoLocal(d), to: isoLocal(new Date(d.getFullYear(), d.getMonth() + 1, 0)) }; }
  if (isYear) { const yy = f.getFullYear() + dir; return { from: yy + '-01-01', to: yy + '-12-31' }; }
  const len = Math.round((t - f) / 86400000) + 1; f.setDate(f.getDate() + dir * len); t.setDate(t.getDate() + dir * len);
  return { from: isoLocal(f), to: isoLocal(t) };
}
function buildMonthCells(year, monthIdx) {
  const startIdx = (new Date(year, monthIdx, 1).getDay() + 6) % 7; // lunes = 0
  const start = new Date(year, monthIdx, 1 - startIdx);
  const cells = [];
  for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); cells.push({ date: d, out: d.getMonth() !== monthIdx }); }
  return cells;
}
function calMarkup(year, monthIdx, sel, side) {
  const cells = buildMonthCells(year, monthIdx);
  const title = new Date(year, monthIdx, 1).toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
  const { from, to } = sel;
  const days = cells.map(c => {
    const iso = isoLocal(c.date);
    let cls = 'rp-day' + (c.out ? ' out' : '');
    if (from && to && iso >= from && iso <= to) cls += ' in-range';
    if (iso === from) cls += ' rp-start';
    if (iso === to || (from && !to && iso === from)) cls += ' rp-end';
    return `<button class="${cls}" data-date="${iso}">${c.date.getDate()}</button>`;
  }).join('');
  const nav = (cl, ch) => `<button class="rp-mnav ${cl}">${ch}</button>`;
  return `
    <div class="rp-cal-head">${side === 'left' ? nav('rp-pm', '‹') : '<span class="rp-mnav-sp"></span>'}<span class="rp-cal-title">${title}</span>${side === 'right' ? nav('rp-nm', '›') : '<span class="rp-mnav-sp"></span>'}</div>
    <div class="rp-wk">${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map(d => `<span>${d}</span>`).join('')}</div>
    <div class="rp-days">${days}</div>`;
}

// Crea e instancia un selector de rango. ids: { label, prev, next, trigger, panel, calLeft, calRight, selLabel, apply }
// onChange(range) se llama cada vez que cambia. Devuelve { get, set }.
function createRangePicker(ids, onChange, initial) {
  let range = initial === undefined ? null : initial;
  let view = new Date();
  let sel = { from: null, to: null };
  const el = (id) => document.getElementById(id);
  const trigger = () => { el(ids.label).textContent = rangeLabel(range); };
  const close = () => el(ids.panel).classList.remove('open');
  function renderCals() {
    const ly = view.getFullYear(), lm = view.getMonth();
    const r = new Date(ly, lm + 1, 1);
    el(ids.calLeft).innerHTML = calMarkup(ly, lm, sel, 'left');
    el(ids.calRight).innerHTML = calMarkup(r.getFullYear(), r.getMonth(), sel, 'right');
    if (ids.selLabel) el(ids.selLabel).textContent = sel.from ? fmtRangePart(sel.from) + (sel.to ? ' – ' + fmtRangePart(sel.to) : ' – …') : 'Selecciona un rango';
    const panel = el(ids.panel);
    const pm = panel.querySelector('.rp-pm'), nm = panel.querySelector('.rp-nm');
    if (pm) pm.onclick = (e) => { e.stopPropagation(); view = new Date(ly, lm - 1, 1); renderCals(); };
    if (nm) nm.onclick = (e) => { e.stopPropagation(); view = new Date(ly, lm + 1, 1); renderCals(); };
  }
  function open() {
    sel = range ? { from: range.from, to: range.to } : { from: null, to: null };
    view = new Date((range ? range.from : isoLocal(new Date())) + 'T00:00:00'); view.setDate(1);
    el(ids.panel).classList.add('open');
    renderCals();
  }
  const commit = () => { trigger(); onChange(range); };
  el(ids.prev).addEventListener('click', () => { if (range) { range = shiftRange(range, -1); commit(); } });
  el(ids.next).addEventListener('click', () => { if (range) { range = shiftRange(range, 1); commit(); } });
  el(ids.trigger).addEventListener('click', (e) => { e.stopPropagation(); el(ids.panel).classList.contains('open') ? close() : open(); });
  el(ids.panel).addEventListener('click', (e) => {
    e.stopPropagation();
    const day = e.target.closest('.rp-day');
    if (day) {
      const iso = day.dataset.date;
      if (!sel.from || sel.to) sel = { from: iso, to: null };
      else if (iso < sel.from) sel = { from: iso, to: sel.from };
      else sel.to = iso;
      renderCals();
      return;
    }
    const pre = e.target.closest('[data-preset]');
    if (pre) { range = presetRange(pre.dataset.preset); close(); commit(); }
  });
  el(ids.apply).addEventListener('click', () => { if (sel.from) range = { from: sel.from, to: sel.to || sel.from }; close(); commit(); });
  document.addEventListener('click', close);
  trigger();
  return { get: () => range, set: (r) => { range = r; trigger(); } };
}

// Tarjetas con el saldo de cada cuenta. cutoffISO opcional = saldo "hasta" esa fecha (Historial).
function accountBalanceCardsHTML(cutoffISO) {
  if (!state.accounts.length) return '<div class="muted">Sin cuentas. Agrégalas en Ajustes ⚙️.</div>';
  return state.accounts.map(a => {
    if (a.kind === 'credito') {
      const owedRaw = cutoffISO ? cardOwedUpTo(a, cutoffISO) : cardOwed(a);
      const owed = Math.max(0, owedRaw);
      const credit = Math.max(0, -owedRaw);          // saldo a favor (pagaste de más)
      const limit = parseFloat(a.limit) || 0;
      const avail = limit ? Math.max(0, limit - owedRaw) : null;
      const pct = limit > 0 ? Math.min(100, (owed / limit) * 100) : 0;
      const cls = pct >= 90 ? 'red' : pct >= 60 ? 'amber' : 'green';
      return `<div class="acct-card">
        <div class="acct-name">💳 ${esc(a.name)}</div>
        <div class="acct-big amount-pos">${avail === null ? '—' : money(avail)}</div>
        <div class="acct-sub">${limit ? 'disponible de ' + money(limit) : 'configura el límite en Ajustes'}</div>
        ${limit ? `<div class="progress ${cls}" style="margin:9px 0 7px"><span style="width:${pct}%"></span></div>` : ''}
        <div class="acct-sub">${credit > 0 ? `A favor <b class="amount-pos">${money(credit)}</b>` : `Debes <b>${money(owed)}</b>`}</div>
      </div>`;
    }
    const bal = cutoffISO ? debitBalanceUpTo(a, cutoffISO) : debitBalance(a);
    return `<div class="acct-card">
      <div class="acct-name">🏦 ${esc(a.name)}</div>
      <div class="acct-big ${bal >= 0 ? 'amount-pos' : 'amount-neg'}">${money(bal)}</div>
      <div class="acct-sub">disponible</div>
    </div>`;
  }).join('');
}

function renderDashboard() {
  populateDashControls();
  const ab = document.getElementById('accountBalances');
  if (ab) ab.innerHTML = accountBalanceCardsHTML();
  const accVal = document.getElementById('dashAccount').value;
  const accMatch = (t) => !accVal || sameAcc(t.account, accVal) || sameAcc(t.toAccount, accVal);
  const inRange = (iso) => !dashRange || (iso >= dashRange.from && iso <= dashRange.to);
  const txs = state.transactions.filter(t => inRange(t.date) && accMatch(t));

  renderDashAlerts();

  let ingresos = 0, gastos = 0;
  txs.forEach(t => {
    if (t.type === 'Ingreso') ingresos += t.amount;
    else if (t.type === 'Gasto' || isCardPayment(t)) gastos += t.amount;
  });
  const ahorro = state.goals.reduce((s, g) => s + (parseFloat(g.saved)||0), 0);
  const deudaManual = state.debts.reduce((s, d) => s + Math.max(0, (d.total||0) - ((d.paid||0) + debtAutoPaid(d))), 0);
  const deudaTarjetas = state.accounts.filter(a => a.kind === 'credito').reduce((s, a) => s + Math.max(0, cardOwed(a)), 0);
  const deuda = deudaManual + deudaTarjetas;

  document.getElementById('statIngresos').textContent = money(ingresos);
  document.getElementById('statGastos').textContent = money(gastos);
  const bal = ingresos - gastos;
  const balEl = document.getElementById('statBalance');
  balEl.textContent = money(bal);
  balEl.className = 'stat-value ' + (bal >= 0 ? 'amount-pos' : 'amount-neg');
  document.getElementById('statAhorro').textContent = money(ahorro);
  document.getElementById('statDeuda').textContent = money(deuda);

  // Tasa de ahorro del periodo = (ingresos − gastos) / ingresos
  const sr = savingsRate(ingresos, gastos);
  const tasaEl = document.getElementById('statTasa');
  tasaEl.textContent = sr.pct === null ? '—' : sr.pct.toFixed(0) + '%';
  tasaEl.className = 'stat-value ' + sr.cls;
  document.getElementById('statTasaFoot').textContent = sr.pct === null ? 'Sin ingresos en el periodo' : sr.label;

  // Comparativa vs el periodo anterior de la misma duración (cuando hay rango definido)
  const dIng = document.getElementById('statIngresosDelta');
  const dGas = document.getElementById('statGastosDelta');
  const dBal = document.getElementById('statBalanceDelta');
  if (dashRange) {
    const f = new Date(dashRange.from + 'T00:00:00'), t = new Date(dashRange.to + 'T00:00:00');
    const len = Math.round((t - f) / 86400000) + 1;
    const pTo = new Date(f); pTo.setDate(pTo.getDate() - 1);
    const pFrom = new Date(pTo); pFrom.setDate(pFrom.getDate() - (len - 1));
    let pIng = 0, pGas = 0;
    const pf = isoLocal(pFrom), pt = isoLocal(pTo);
    state.transactions.forEach(x => {
      if (x.date < pf || x.date > pt || !accMatch(x)) return;
      if (x.type === 'Ingreso') pIng += x.amount;
      else if (x.type === 'Gasto' || isCardPayment(x)) pGas += x.amount;
    });
    dIng.innerHTML = deltaBadge(ingresos, pIng, false);
    dGas.innerHTML = deltaBadge(gastos, pGas, true);
    dBal.innerHTML = deltaBadge(ingresos - gastos, pIng - pGas, false);
  } else {
    dIng.innerHTML = dGas.innerHTML = dBal.innerHTML = '';
  }

  renderNetWorth();
  renderProjectionAndAnt(txs);

  const periodLbl = rangeLabel(dashRange);
  const scope = accVal ? accVal + ' · ' + periodLbl : periodLbl;
  document.getElementById('statIngresosFoot').textContent = txs.filter(t=>t.type==='Ingreso').length + ' mov. · ' + scope;
  document.getElementById('statGastosFoot').textContent = txs.filter(t=>t.type==='Gasto'||isCardPayment(t)).length + ' mov. · ' + scope;

  // Chart Ingresos vs Gastos
  chIG?.destroy();
  chIG = new Chart(document.getElementById('chartIngresoGasto'), {
    type: 'doughnut',
    data: { labels: ['Ingresos', 'Gastos'], datasets: [{ data: [ingresos, gastos], backgroundColor: ['#22c55e', '#f43f5e'], borderWidth: 0 }] },
    options: { ...baseChartOpts(false), cutout: '65%' }
  });

  // Chart categorías (gastos). Los pagos a tarjeta de crédito se agrupan bajo el nombre de la tarjeta.
  const catMap = {};
  txs.forEach(t => {
    if (t.type === 'Gasto') {
      const k = t.category || 'Sin categoría';
      catMap[k] = (catMap[k] || 0) + t.amount;
    } else if (isCardPayment(t)) {
      const k = '💳 ' + (t.toAccount || 'Tarjeta');
      catMap[k] = (catMap[k] || 0) + t.amount;
    }
  });
  const catEntries = Object.entries(catMap).sort((a,b)=>b[1]-a[1]).slice(0, 10);
  chCat?.destroy();
  chCat = new Chart(document.getElementById('chartCategorias'), {
    type: 'doughnut',
    data: { labels: catEntries.map(e=>e[0]), datasets: [{ data: catEntries.map(e=>e[1]), backgroundColor: COLORS, borderWidth: 0 }] },
    options: { ...baseChartOpts(false), cutout: '60%' }
  });

  // Chart tendencia (últimos 6 meses)
  const months = lastNMonths(6);
  const mIngreso = {}, mGasto = {};
  state.transactions.filter(accMatch).forEach(t => {
    const k = t.date.slice(0,7);
    if (t.type === 'Ingreso') mIngreso[k] = (mIngreso[k]||0)+t.amount;
    else if (t.type === 'Gasto' || isCardPayment(t)) mGasto[k] = (mGasto[k]||0)+t.amount;
  });
  chTend?.destroy();
  chTend = new Chart(document.getElementById('chartTendencia'), {
    type: 'line',
    data: {
      labels: months.map(m => m.label),
      datasets: [
        { label: 'Ingresos', data: months.map(m => mIngreso[m.key]||0), borderColor: '#22c55e', backgroundColor: '#22c55e22', fill: true, tension: .35, borderWidth: 2, pointRadius: 2 },
        { label: 'Gastos', data: months.map(m => mGasto[m.key]||0), borderColor: '#f43f5e', backgroundColor: '#f43f5e22', fill: true, tension: .35, borderWidth: 2, pointRadius: 2 },
      ]
    },
    options: baseChartOpts(true)
  });

  // Mini metas
  const mg = document.getElementById('dashMetas');
  if (!state.goals.length) mg.innerHTML = `<div class="muted">Sin metas todavía.</div>`;
  else mg.innerHTML = state.goals.slice(0, 6).map(g => {
    const target = parseFloat(g.target)||0, saved = parseFloat(g.saved)||0;
    const pct = target>0 ? Math.min(100,(saved/target)*100) : 0;
    const cls = pct>=100?'green':pct>=50?'amber':'';
    return `<div class="mini-goal">
      <div class="mini-top"><b>${esc(g.name)}</b><span class="muted">${money(saved)} / ${money(target)}</span></div>
      <div class="progress ${cls}"><span style="width:${pct}%"></span></div>
    </div>`;
  }).join('');

  // Recientes
  const recientes = state.transactions.filter(accMatch).sort((a,b)=>b.date.localeCompare(a.date)||b.id.localeCompare(a.id)).slice(0,6);
  const dr = document.getElementById('dashRecientes');
  if (!recientes.length) dr.innerHTML = `<div class="empty">Sin movimientos aún.</div>`;
  else dr.innerHTML = `<div class="table-wrap"><table><tbody>` + recientes.map(t => {
    const cls = t.type==='Ingreso'?'amount-pos':t.type==='Ahorro'?'amount-save':t.type==='Transferencia'?'amount-transfer':'amount-neg';
    const sign = t.type==='Ingreso'?'+':t.type==='Gasto'?'−':'';
    return `<tr>
      <td style="width:1%;white-space:nowrap" class="muted">${fmtDate(t.date)}</td>
      <td style="font-weight:600">${dispDesc(t)}</td>
      <td>${t.category?`<span class="pill tag">${esc(t.category)}</span>`:''}</td>
      <td class="ta-r ${cls}">${sign}${money(t.amount)}</td>
    </tr>`;
  }).join('') + `</tbody></table></div>`;
}
document.getElementById('dashAccount').addEventListener('change', renderDashboard);

// Instancia del selector de rango para el Resumen
let dashRange = defaultDashRange();
createRangePicker(
  { label: 'rpLabel', prev: 'rpPrev', next: 'rpNext', trigger: 'rpTrigger', panel: 'rpPanel', calLeft: 'rpCalLeft', calRight: 'rpCalRight', selLabel: 'rpSelLabel', apply: 'rpApply' },
  (r) => { dashRange = r; renderDashboard(); },
  dashRange
);

// --- Patrimonio neto (tarjeta + gráfico de evolución) ---
function renderNetWorth() {
  const now = computeNetWorth();
  document.getElementById('netWorthNow').textContent = money(now.net);
  document.getElementById('netWorthBreak').innerHTML = `
    <div class="nl"><span class="lbl">Activos</span><span class="val amount-pos">${money(now.assets)}</span></div>
    <div class="nl"><span class="lbl">Pasivos</span><span class="val amount-neg">${money(now.liabilities)}</span></div>
    <div class="nl"><span class="lbl">Patrimonio neto</span><span class="val">${money(now.net)}</span></div>`;
  const hist = netWorthHistory(12);
  chNet?.destroy();
  chNet = new Chart(document.getElementById('chartPatrimonio'), {
    type: 'line',
    data: {
      labels: hist.map(h => h.label),
      datasets: [{ label: 'Patrimonio neto', data: hist.map(h => h.net), borderColor: '#6366f1', backgroundColor: '#6366f122', fill: true, tension: .35, borderWidth: 2, pointRadius: 2 }]
    },
    options: baseChartOpts(true)
  });
}

// --- Proyección de fin de mes + gastos hormiga ---
function renderProjectionAndAnt(txs) {
  const p = projectionEndOfMonth();
  const projCls = p.projected >= 0 ? 'amount-pos' : 'amount-neg';
  document.getElementById('projBlock').innerHTML = `
    <div class="mb-title">🔮 Saldo proyectado a fin de mes</div>
    <div class="mb-value ${projCls}">${money(p.projected)}</div>
    <div class="mb-sub">Liquidez hoy ${money(p.cash)}${p.pendingIncome ? ` · +${money(p.pendingIncome)} ingresos rec.` : ''}${p.pendingExpense ? ` · −${money(p.pendingExpense)} gastos rec.` : ''}</div>`;
  const ant = antExpenses(txs);
  const micros = txs.filter(t => t.type === 'Gasto' && t.amount <= ant.threshold)
    .sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount);
  const microHtml = micros.length
    ? micros.map(t => `<div class="btx-row">
        <span class="muted">${fmtDate(t.date)}</span>
        <span class="btx-desc">${dispDesc(t)}${t.category ? ` <span class="muted">· ${esc(t.category)}</span>` : ''}</span>
        <span class="ta-r amount-neg">${money(t.amount)}</span>
      </div>`).join('')
    : `<div class="btx-row muted">Sin microgastos en el periodo.</div>`;
  document.getElementById('antBlock').innerHTML = `
    <div class="mb-title">🐜 Gastos hormiga <button class="link-btn" onclick="setAntThreshold()">(≤ ${money(ant.threshold)}) ✎</button></div>
    <div class="mb-value">${money(ant.total)}</div>
    <div class="mb-sub">${ant.count} microgasto(s) en el periodo seleccionado</div>
    ${micros.length ? `<details class="budget-tx" style="margin-top:10px"><summary>Ver microgastos (${micros.length})</summary><div class="btx-list">${microHtml}</div></details>` : ''}`;
}
window.setAntThreshold = () => {
  const cur = state.settings.antThreshold || 100;
  const nv = prompt('Umbral de "gasto hormiga" (monto máximo en MXN):', cur);
  if (nv === null) return;
  const v = parseFloat(nv); if (!v || v <= 0) return toast('Valor no válido', 'error');
  state.settings.antThreshold = v; save(); renderDashboard(); toast('Umbral actualizado');
};

/* ============================================================
   REPORTE MENSUAL (imprimible / PDF vía window.print)
   ============================================================ */
function generarReporteMensual() {
  // El reporte refleja EXACTAMENTE el mismo rango y cuenta del Resumen
  const r = dashRange || defaultDashRange();
  const accVal = document.getElementById('dashAccount').value;
  const accMatch = (t) => !accVal || sameAcc(t.account, accVal) || sameAcc(t.toAccount, accVal);
  // Totales y gasto por categoría dentro del rango (mismo criterio que el dashboard)
  let ingresos = 0, gastos = 0;
  const spent = {};
  state.transactions.forEach(t => {
    if (t.date < r.from || t.date > r.to || !accMatch(t)) return;
    if (t.type === 'Ingreso') ingresos += t.amount;
    else if (t.type === 'Gasto') { gastos += t.amount; const k = t.category || 'Sin categoría'; spent[k] = (spent[k] || 0) + t.amount; }
    else if (isCardPayment(t)) { gastos += t.amount; const k = '💳 ' + (t.toAccount || 'Tarjeta'); spent[k] = (spent[k] || 0) + t.amount; }
  });
  const balance = ingresos - gastos;
  const sr = savingsRate(ingresos, gastos);
  const catRows = Object.entries(spent).sort((a, b) => b[1] - a[1]);
  const periodLbl = rangeLabel(r);
  const scopeLbl = accVal ? esc(accVal) + ' · ' + periodLbl : periodLbl;
  const avgExp = avgMonthlyExpenses(3);
  const goalRows = state.goals.map(g => {
    const saved = parseFloat(g.saved) || 0;
    const target = g.emergency ? Math.round(avgExp * (g.months || 3)) : (parseFloat(g.target) || 0);
    const pct = target > 0 ? Math.min(100, saved / target * 100) : 0;
    return `<tr><td>${esc(g.name)}</td><td class="r">${money(saved)}</td><td class="r">${money(target)}</td><td class="r">${pct.toFixed(0)}%</td></tr>`;
  }).join('');
  const win = window.open('', '_blank');
  if (!win) return toast('Permite ventanas emergentes para el reporte', 'error');
  const doc = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Reporte ${periodLbl}</title>
    <style>
      body{font-family:'Segoe UI',Arial,sans-serif;color:#1a2236;max-width:780px;margin:24px auto;padding:0 20px}
      h1{font-size:24px;margin:0 0 2px} h2{font-size:16px;margin:26px 0 8px;border-bottom:2px solid #6366f1;padding-bottom:4px}
      .sub{color:#667;margin-bottom:18px}
      .cards{display:flex;gap:12px;flex-wrap:wrap}
      .c{flex:1;min-width:130px;border:1px solid #dde;border-radius:10px;padding:12px}
      .c .l{font-size:12px;color:#778} .c .v{font-size:20px;font-weight:800;margin-top:4px}
      table{width:100%;border-collapse:collapse;font-size:14px;margin-top:6px}
      th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #e5e8f0} td.r,th.r{text-align:right}
      .pos{color:#16a34a;font-weight:700}.neg{color:#dc2626;font-weight:700}
      .btn{background:#6366f1;color:#fff;border:none;padding:10px 16px;border-radius:8px;cursor:pointer;font-size:14px;margin-top:20px}
      @media print{.btn{display:none}}
    </style></head><body>
    <h1>Reporte financiero</h1>
    <div class="sub">${scopeLbl} · generado el ${fmtDate(todayISO())}</div>
    <div class="cards">
      <div class="c"><div class="l">Ingresos</div><div class="v pos">${money(ingresos)}</div></div>
      <div class="c"><div class="l">Gastos</div><div class="v neg">${money(gastos)}</div></div>
      <div class="c"><div class="l">Balance</div><div class="v">${money(balance)}</div></div>
      <div class="c"><div class="l">Tasa de ahorro</div><div class="v">${sr.pct === null ? '—' : sr.pct.toFixed(0) + '%'}</div></div>
    </div>
    <h2>Gastos por categoría</h2>
    <table><thead><tr><th>Categoría</th><th class="r">Monto</th><th class="r">% del gasto</th></tr></thead><tbody>
      ${catRows.length ? catRows.map(([c, v]) => `<tr><td>${esc(c)}</td><td class="r">${money(v)}</td><td class="r">${gastos > 0 ? (v / gastos * 100).toFixed(0) : 0}%</td></tr>`).join('') : '<tr><td colspan="3">Sin gastos en el periodo.</td></tr>'}
    </tbody></table>
    <h2>Avance de metas</h2>
    <table><thead><tr><th>Meta</th><th class="r">Ahorrado</th><th class="r">Objetivo</th><th class="r">Avance</th></tr></thead><tbody>
      ${goalRows || '<tr><td colspan="4">Sin metas registradas.</td></tr>'}
    </tbody></table>
    <button class="btn" onclick="window.print()">🖨️ Imprimir / Guardar como PDF</button>
    </body></html>`;
  win.document.write(doc); win.document.close();
}
document.getElementById('btnReporte').addEventListener('click', generarReporteMensual);

/* ============================================================
   ANÁLISIS FINANCIERO (reporte extenso)
   buildAnalisisMarkdown(forAI) arma TODO el panorama en Markdown:
   - forAI=false → reporte para humano (se renderiza como HTML imprimible).
   - forAI=true  → el mismo reporte + un prompt con instrucciones para una IA.
   generarAnalisis() abre la ventana del reporte humano, con botón para
   imprimir/PDF y otro para cambiar a la versión lista para pegar en una IA.
   ============================================================ */
function buildAnalisisMarkdown(forAI) {
  const r = dashRange || defaultDashRange();
  const L = [];                                   // líneas de Markdown
  const p = (s = '') => L.push(s);
  const cell = (s) => String(s).replace(/\|/g, '/').replace(/\s*\n\s*/g, ' '); // celdas seguras de tabla
  const m = (n) => money(n || 0);
  const pctStr = (n) => (n === null || !isFinite(n)) ? '—' : n.toFixed(0) + '%';
  // Respeta la censura de movimientos privados activa en la sesión
  const safeDesc = (desc, isPriv) => (censorPrivate && isPriv) ? '🔒 Movimiento privado' : desc;

  /* ---- Totales y gasto por categoría del periodo seleccionado (todas las cuentas) ---- */
  let ing = 0, gas = 0; const spent = {};
  state.transactions.forEach(t => {
    if (t.date < r.from || t.date > r.to) return;
    if (t.type === 'Ingreso') ing += t.amount;
    else if (t.type === 'Gasto') { gas += t.amount; const k = t.category || 'Sin categoría'; spent[k] = (spent[k] || 0) + t.amount; }
    else if (isCardPayment(t)) { gas += t.amount; const k = '💳 ' + (t.toAccount || 'Tarjeta'); spent[k] = (spent[k] || 0) + t.amount; }
  });
  const sr = savingsRate(ing, gas);

  /* ---- Encabezado + prompt para la IA ---- */
  p('# Reporte financiero');
  p('');
  if (forAI) {
    p('> **Instrucciones para la IA:** Eres mi asesor financiero personal. Con base en los datos de abajo, dame una respuesta en español, clara y accionable, con cifras concretas (moneda: pesos mexicanos, MXN). Incluye:');
    p('> 1. Un diagnóstico honesto de mi salud financiera: qué hago bien y qué hago mal.');
    p('> 2. Mis 3 focos rojos más urgentes y cómo resolverlos paso a paso.');
    p('> 3. Recomendaciones para subir mi tasa de ahorro y bajar mi deuda (con montos sugeridos).');
    p('> 4. Si mi fondo de emergencia y mis metas van en buen camino, y cuánto debería abonar al mes.');
    p('> 5. Patrones de gasto preocupantes o gastos hormiga que deba vigilar.');
    p('> 6. Un plan concreto para los próximos 1, 3 y 6 meses.');
    p('');
  }
  p(`*Generado el ${fmtDate(todayISO())} · Periodo analizado: ${fmtRangePart(r.from)} a ${fmtRangePart(r.to)} (todas las cuentas).*`);
  p('');

  /* ---- 1. Patrimonio neto ---- */
  const nw = computeNetWorth();
  p('## 1. Patrimonio neto');
  p('');
  p(`- **Activos:** ${m(nw.assets)}`);
  p(`- **Pasivos (deudas):** ${m(nw.liabilities)}`);
  p(`- **Patrimonio neto:** ${m(nw.net)}`);
  p('');
  const nwHist = netWorthHistory(6);
  p('Evolución (últimos 6 meses):');
  p('');
  p('| Mes | Activos | Pasivos | Patrimonio neto |');
  p('|---|---:|---:|---:|');
  nwHist.forEach(h => p(`| ${cell(h.label)} | ${m(h.assets)} | ${m(h.liabilities)} | ${m(h.net)} |`));
  p('');

  /* ---- 2. Resumen del periodo ---- */
  p('## 2. Resumen del periodo seleccionado');
  p('');
  p(`- **Ingresos:** ${m(ing)}`);
  p(`- **Gastos:** ${m(gas)}`);
  p(`- **Balance (ingresos − gastos):** ${m(ing - gas)}`);
  p(`- **Tasa de ahorro:** ${pctStr(sr.pct)}${sr.pct === null ? '' : ' (' + sr.label + ')'}`);
  p('');

  /* ---- 3. Tendencia últimos 6 meses ---- */
  p('## 3. Tendencia de los últimos 6 meses');
  p('');
  p('| Mes | Ingresos | Gastos | Balance | Tasa de ahorro |');
  p('|---|---:|---:|---:|---:|');
  lastNMonths(6).forEach(mo => {
    const tt = monthTotals(mo.key);
    const s2 = savingsRate(tt.ingresos, tt.gastos);
    p(`| ${cell(mo.label)} | ${m(tt.ingresos)} | ${m(tt.gastos)} | ${m(tt.balance)} | ${pctStr(s2.pct)} |`);
  });
  p('');

  /* ---- 4. Gastos por categoría (periodo) ---- */
  p('## 4. Gastos por categoría (periodo)');
  p('');
  const catRows = Object.entries(spent).sort((a, b) => b[1] - a[1]);
  if (catRows.length) {
    p('| Categoría | Monto | % del gasto |');
    p('|---|---:|---:|');
    catRows.forEach(([c, v]) => p(`| ${cell(c)} | ${m(v)} | ${gas > 0 ? (v / gas * 100).toFixed(0) : 0}% |`));
  } else p('_Sin gastos en el periodo._');
  p('');

  /* ---- 5. Presupuestos ---- */
  const budgetCats = Object.keys(state.budgets).filter(c => (state.budgets[c] || 0) > 0);
  if (budgetCats.length) {
    const factor = monthsFactor(r.from, r.to);
    const spentRange = spentByCategoryRange(r.from, r.to);
    p('## 5. Presupuestos vs. gasto real (periodo)');
    p('');
    p('| Categoría | Límite del periodo | Gastado | Uso |');
    p('|---|---:|---:|---:|');
    budgetCats.forEach(c => {
      const limit = (state.budgets[c] || 0) * factor;
      const used = spentRange[c] || 0;
      p(`| ${cell(c)} | ${m(limit)} | ${m(used)} | ${limit > 0 ? (used / limit * 100).toFixed(0) : 0}% |`);
    });
    p('');
  }

  /* ---- 6. Cuentas de débito ---- */
  const debit = state.accounts.filter(a => a.kind !== 'credito');
  if (debit.length) {
    p('## 6. Cuentas de débito / efectivo');
    p('');
    p('| Cuenta | Saldo disponible |');
    p('|---|---:|');
    debit.forEach(a => p(`| ${cell(a.name)} | ${m(debitBalance(a))} |`));
    p('');
  }

  /* ---- 7. Tarjetas de crédito ---- */
  const cards = state.accounts.filter(a => a.kind === 'credito');
  if (cards.length) {
    p('## 7. Tarjetas de crédito');
    p('');
    p('| Tarjeta | Debes | Límite | Uso | Días a corte | Días a pago | Días sin intereses si compras hoy |');
    p('|---|---:|---:|---:|---:|---:|---:|');
    cards.forEach(a => {
      const owed = Math.max(0, cardOwed(a));
      const limit = parseFloat(a.limit) || 0;
      const use = limit > 0 ? (owed / limit * 100).toFixed(0) + '%' : '—';
      const dc = daysUntilDay(a.cutDay), dp = daysUntilDay(a.dueDay);
      const free = interestFreeDaysIfBuyToday(a);
      p(`| ${cell(a.name)} | ${m(owed)} | ${limit ? m(limit) : '—'} | ${use} | ${dc === null ? '—' : dc + 'd'} | ${dp === null ? '—' : dp + 'd'} | ${free === null ? '—' : free + 'd'} |`);
    });
    p('');
  }

  /* ---- 8. Deudas manuales + MSI ---- */
  const debts = state.debts || [];
  const msiActiveList = (state.msi || []).filter(msiActive);
  if (debts.length || msiActiveList.length) {
    p('## 8. Otras deudas');
    p('');
    if (debts.length) {
      p('**Deudas / préstamos / suscripciones:**');
      p('');
      p('| Deuda | Tipo | Pendiente | Total | Pago mensual |');
      p('|---|---|---:|---:|---:|');
      debts.forEach(d => {
        const paid = (d.paid || 0) + debtAutoPaid(d);
        const rest = Math.max(0, (d.total || 0) - paid);
        p(`| ${cell(d.name)} | ${cell(d.dtype || '—')} | ${m(rest)} | ${m(d.total || 0)} | ${d.monthly ? m(d.monthly) : '—'} |`);
      });
      p('');
    }
    if (msiActiveList.length) {
      p('**Compras a meses sin intereses (MSI) activas:**');
      p('');
      p('| Compra | Mensualidad | Pendiente | Plazo | Pagos hechos |');
      p('|---|---:|---:|---:|---:|');
      msiActiveList.forEach(ms => p(`| ${cell(ms.name)} | ${m(msiMonthly(ms))} | ${m(msiPending(ms))} | ${ms.term} meses | ${msiMonthsPaid(ms)}/${ms.term} |`));
      p('');
    }
  }

  /* ---- 9. Metas de ahorro ---- */
  if (state.goals.length) {
    const avgExp = avgMonthlyExpenses(3);
    p('## 9. Metas de ahorro');
    p('');
    p('| Meta | Ahorrado | Objetivo | Avance |');
    p('|---|---:|---:|---:|');
    state.goals.forEach(g => {
      const saved = parseFloat(g.saved) || 0;
      const target = g.emergency ? Math.round(avgExp * (g.months || 3)) : (parseFloat(g.target) || 0);
      const adv = target > 0 ? Math.min(100, saved / target * 100).toFixed(0) + '%' : '—';
      p(`| ${cell(g.name)}${g.emergency ? ' (fondo de emergencia)' : ''} | ${m(saved)} | ${m(target)} | ${adv} |`);
    });
    p('');
  }

  /* ---- 10. Ingresos y gastos recurrentes (fijos) ---- */
  const rec = detectRecurring();
  if (rec.length) {
    const fixedIncome = rec.filter(x => x.type === 'Ingreso').reduce((s, x) => s + x.monthly, 0);
    const fixedExpense = rec.filter(x => x.type === 'Gasto').reduce((s, x) => s + x.monthly, 0);
    p('## 10. Ingresos y gastos fijos (recurrentes detectados)');
    p('');
    p(`- **Ingreso fijo mensual estimado:** ${m(fixedIncome)}`);
    p(`- **Gasto fijo mensual estimado:** ${m(fixedExpense)}`);
    p('');
    p('| Concepto | Tipo | Aprox./mes | Día | Categoría |');
    p('|---|---|---:|---:|---|');
    rec.forEach(x => p(`| ${cell(safeDesc(x.description, x.private))} | ${x.type} | ${m(x.monthly)} | ${x.dayAuto || '—'} | ${cell(x.category || '—')} |`));
    p('');
  }

  /* ---- 11. Sueldo fijo configurado ---- */
  const incomeRaw = parseFloat(state.settings.incomeAmount) || 0;
  if (incomeRaw > 0) {
    p('## 11. Sueldo fijo configurado');
    p('');
    p(`- ${m(incomeRaw)} ${INCOME_FREQ_LABEL[state.settings.incomeFreq] || 'mensual'} (≈ ${m(monthlyFixedIncome())} al mes)`);
    p('');
  }

  /* ---- 12. Gastos hormiga (periodo) ---- */
  const periodTx = state.transactions.filter(t => t.date >= r.from && t.date <= r.to);
  const ant = antExpenses(periodTx);
  p('## 12. Gastos hormiga (periodo)');
  p('');
  p(`- ${ant.count} microgasto(s) ≤ ${m(ant.threshold)} que suman **${m(ant.total)}**.`);
  p('');

  /* ---- 13. Proyección de fin de mes ---- */
  const proj = projectionEndOfMonth();
  p('## 13. Proyección a fin de mes (mes en curso)');
  p('');
  p(`- Liquidez hoy: ${m(proj.cash)}`);
  p(`- Ingresos recurrentes pendientes: ${m(proj.pendingIncome)}`);
  p(`- Gastos recurrentes pendientes: ${m(proj.pendingExpense)}`);
  p(`- **Saldo proyectado a fin de mes:** ${m(proj.projected)}`);
  p('');
  if (forAI) {
    p('---');
    p('_Fin del reporte. Pega todo este texto en tu IA de preferencia y pídele el análisis._');
  }

  return L.join('\n');
}

/* Abre el reporte extenso para humano (HTML imprimible) con opción de versión para IA */
function generarAnalisis() {
  const humanMd = buildAnalisisMarkdown(false); // reporte para leer / imprimir
  const aiMd = buildAnalisisMarkdown(true);      // el mismo + prompt para la IA
  const win = window.open('', '_blank');
  if (!win) return toast('Permite ventanas emergentes para el reporte', 'error');
  const hPayload = JSON.stringify(humanMd).replace(/</g, '\\u003c'); // evita romper el <script> embebido
  const aPayload = JSON.stringify(aiMd).replace(/</g, '\\u003c');
  const doc = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Análisis financiero</title>
    <style>
      body{font-family:'Segoe UI',Arial,sans-serif;color:#1a2236;max-width:820px;margin:0 auto 40px;padding:0 18px;background:#fff}
      h1{font-size:24px;margin:0 0 2px} h2{font-size:16px;margin:26px 0 8px;border-bottom:2px solid #6366f1;padding-bottom:4px}
      h3{font-size:14px;margin:16px 0 6px} p{margin:6px 0;line-height:1.5}
      ul{margin:6px 0;padding-left:20px} li{margin:3px 0;line-height:1.5}
      em{color:#667;font-style:italic}
      blockquote{margin:10px 0;padding:10px 14px;background:#eef0fb;border-left:4px solid #6366f1;border-radius:6px;color:#3b3f7a;font-size:13.5px}
      table{width:100%;border-collapse:collapse;font-size:13.5px;margin:8px 0 4px}
      th,td{padding:7px 8px;border-bottom:1px solid #e5e8f0} thead th{border-bottom:2px solid #cdd3ea}
      hr{border:none;border-top:1px solid #e5e8f0;margin:18px 0} strong{color:#1a2236}
      .bar{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 14px;position:sticky;top:0;background:#fff;padding:14px 0;z-index:5;border-bottom:1px solid #eef0f6}
      button{background:#6366f1;color:#fff;border:none;padding:10px 16px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600}
      button.sec{background:#e5e7f5;color:#3b3f7a}
      textarea{width:100%;height:62vh;box-sizing:border-box;border:1px solid #cfd4e6;border-radius:10px;padding:14px;font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:12.5px;line-height:1.5;color:#1a2236}
      .tip{background:#eef0fb;border:1px solid #d8dcf3;border-radius:8px;padding:10px 12px;font-size:13px;color:#3b3f7a;margin-bottom:12px}
      @media print{.no-print{display:none!important} #aiView{display:none!important} body{margin:0} .bar{position:static;border:none}}
    </style></head><body>
    <div id="report">
      <div class="bar no-print">
        <button onclick="window.print()">🖨️ Imprimir / Guardar como PDF</button>
        <button class="sec" id="toAI">🤖 Versión para IA</button>
      </div>
      <div id="reportBody"></div>
    </div>
    <div id="aiView" style="display:none">
      <div class="bar no-print">
        <button id="copy">📋 Copiar todo</button>
        <button class="sec" id="dl">⬇️ Descargar .md</button>
        <button class="sec" id="back">← Volver al reporte</button>
      </div>
      <div class="tip">💡 Copia este texto y pégalo en ChatGPT, Claude, Gemini, etc. Ya incluye las instrucciones para que la IA te dé el análisis. Está en Markdown: cualquier IA lo entiende.</div>
      <textarea id="t" readonly spellcheck="false"></textarea>
    </div>
    <script>
      const humanMd = ${hPayload};
      const aiMd = ${aPayload};
      const escH = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const inl = s => escH(s).replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>').replace(/\\*(.+?)\\*/g,'<em>$1</em>');
      function mdToHtml(md){
        const ln = md.split('\\n'); const out = []; let i = 0;
        const cells = r => r.replace(/^\\|/,'').replace(/\\|\\s*$/,'').split('|').map(c => c.trim());
        while(i < ln.length){
          const line = ln[i];
          if(/^### /.test(line)){ out.push('<h3>'+inl(line.slice(4))+'</h3>'); i++; continue; }
          if(/^## /.test(line)){ out.push('<h2>'+inl(line.slice(3))+'</h2>'); i++; continue; }
          if(/^# /.test(line)){ out.push('<h1>'+inl(line.slice(2))+'</h1>'); i++; continue; }
          if(/^---\\s*$/.test(line)){ out.push('<hr>'); i++; continue; }
          if(/^>\\s?/.test(line)){ const b=[]; while(i<ln.length && /^>\\s?/.test(ln[i])){ b.push(inl(ln[i].replace(/^>\\s?/,''))); i++; } out.push('<blockquote>'+b.join('<br>')+'</blockquote>'); continue; }
          if(/^\\|/.test(line)){
            const rows=[]; while(i<ln.length && /^\\|/.test(ln[i])){ rows.push(ln[i]); i++; }
            const al = cells(rows[1]||'').map(s => { const rg=/:$/.test(s), lf=/^:/.test(s); return rg&&lf?'center':rg?'right':'left'; });
            const sty = j => (al[j] && al[j]!=='left') ? ' style="text-align:'+al[j]+'"' : '';
            const head = cells(rows[0]);
            let t = '<table><thead><tr>'+head.map((h,j)=>'<th'+sty(j)+'>'+inl(h)+'</th>').join('')+'</tr></thead><tbody>';
            for(let j=2;j<rows.length;j++){ const c=cells(rows[j]); t += '<tr>'+c.map((x,k)=>'<td'+sty(k)+'>'+inl(x)+'</td>').join('')+'</tr>'; }
            out.push(t+'</tbody></table>'); continue;
          }
          if(/^- /.test(line)){ const b=[]; while(i<ln.length && /^- /.test(ln[i])){ b.push('<li>'+inl(ln[i].slice(2))+'</li>'); i++; } out.push('<ul>'+b.join('')+'</ul>'); continue; }
          if(/^\\s*$/.test(line)){ i++; continue; }
          out.push('<p>'+inl(line)+'</p>'); i++;
        }
        return out.join('\\n');
      }
      document.getElementById('reportBody').innerHTML = mdToHtml(humanMd);
      const ta = document.getElementById('t');
      ta.value = aiMd;
      ta.addEventListener('focus', () => ta.select());
      document.getElementById('toAI').onclick = () => {
        if(!confirm('¿Generar este mismo reporte en formato para una IA (ChatGPT, Claude, etc.)? Podrás copiarlo o descargarlo.')) return;
        document.getElementById('report').style.display = 'none';
        document.getElementById('aiView').style.display = 'block';
        window.scrollTo(0,0);
      };
      document.getElementById('back').onclick = () => {
        document.getElementById('aiView').style.display = 'none';
        document.getElementById('report').style.display = 'block';
        window.scrollTo(0,0);
      };
      document.getElementById('copy').onclick = async () => {
        try { await navigator.clipboard.writeText(aiMd); }
        catch (e) { ta.focus(); ta.select(); document.execCommand('copy'); }
        const b = document.getElementById('copy'); b.textContent = '✅ Copiado'; setTimeout(() => b.textContent = '📋 Copiar todo', 1800);
      };
      document.getElementById('dl').onclick = () => {
        const blob = new Blob([aiMd], { type: 'text/markdown;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'analisis-finanzas-' + new Date().toISOString().slice(0, 10) + '.md';
        a.click(); URL.revokeObjectURL(a.href);
      };
    </script>
    </body></html>`;
  win.document.write(doc); win.document.close();
}
document.getElementById('btnAnalisis').addEventListener('click', generarAnalisis);

/* ============================================================
   SIMULADOR "¿QUÉ PASARÍA SI…?" (sin guardar nada)
   ============================================================ */
function simuladorModal() {
  const html = `
    <div class="field-row">
      <div class="field">
        <label>Tipo</label>
        <select id="simType" onchange="simularPreview()">
          <option value="Gasto">Gasto hipotético</option>
          <option value="Ingreso">Ingreso hipotético</option>
        </select>
      </div>
      <div class="field">
        <label>Monto</label>
        <input type="number" id="simAmount" step="0.01" min="0" placeholder="0.00" oninput="simularPreview()" autocomplete="off" />
      </div>
    </div>
    <div class="field">
      <label>Descripción (opcional)</label>
      <input id="simDesc" placeholder="Ej. Comprar laptop, bono de fin de año" autocomplete="off" />
    </div>
    <div class="sim-preview" id="simResult"></div>
    <div class="hint" style="margin-top:8px">Esto es solo una simulación: no se guarda ningún movimiento.</div>
    <div class="modal-actions">
      <button type="button" class="btn-primary" onclick="closeModal()">Cerrar</button>
    </div>`;
  openModal('🔮 Simulador «¿qué pasaría si…?»', html, () => closeModal());
  simularPreview();
}
window.simularPreview = function () {
  const amt = parseFloat(document.getElementById('simAmount').value) || 0;
  const type = document.getElementById('simType').value;
  const base = monthTotals(currentMonthKey());
  const proj = projectionEndOfMonth();
  let ing = base.ingresos, gas = base.gastos, projected = proj.projected;
  if (type === 'Gasto') { gas += amt; projected -= amt; } else { ing += amt; projected += amt; }
  const balAfter = ing - gas;
  const srBefore = savingsRate(base.ingresos, base.gastos);
  const srAfter = savingsRate(ing, gas);
  const pctTxt = (s) => s.pct === null ? '—' : s.pct.toFixed(0) + '%';
  const row = (label, before, after, cls = '') =>
    `<div class="sim-row"><span>${label}</span><span><span class="sim-arrow">${before} →</span> <span class="sim-after ${cls}">${after}</span></span></div>`;
  document.getElementById('simResult').innerHTML =
    row('Balance del mes', money(base.balance), money(balAfter), balAfter >= 0 ? 'amount-pos' : 'amount-neg') +
    row('Tasa de ahorro', pctTxt(srBefore), pctTxt(srAfter), srAfter.cls) +
    row('Saldo proyectado fin de mes', money(proj.projected), money(projected), projected >= 0 ? 'amount-pos' : 'amount-neg');
};
document.getElementById('btnSimulador').addEventListener('click', simuladorModal);

// Avisos de fechas de corte/pago próximas de tarjetas de crédito
function renderDashAlerts() {
  const items = [];
  state.accounts.filter(a => a.kind === 'credito').forEach(a => {
    const owed = Math.max(0, cardOwed(a));
    const dc = daysUntilDay(a.cutDay), dp = daysUntilDay(a.dueDay);
    if (dp !== null && dp <= 5 && owed > 0) {
      items.push({ danger: true, html: `⚠️ <b>${esc(a.name)}</b>: fecha de pago en ${dp} día(s) (día ${a.dueDay}). Paga <b>${money(owed)}</b>.` });
    } else if (dc !== null && dc <= 5) {
      items.push({ danger: false, html: `🗓️ <b>${esc(a.name)}</b>: fecha de corte en ${dc} día(s) (día ${a.cutDay}).` });
    }
  });
  const spent = spentByCategory(currentMonthKey());
  Object.keys(state.budgets).forEach(c => {
    const lim = state.budgets[c]; if (!lim) return;
    const used = spent[c] || 0, pct = used / lim * 100;
    if (pct >= 100) items.push({ danger: true, html: `🔴 Presupuesto de <b>${esc(c)}</b> superado: ${money(used)} de ${money(lim)} (${pct.toFixed(0)}%).` });
    else if (pct >= 80) items.push({ danger: false, html: `🟠 Presupuesto de <b>${esc(c)}</b> al ${pct.toFixed(0)}%: ${money(used)} de ${money(lim)}.` });
  });

  // Actualizar campana
  const badge = document.getElementById('notifBadge');
  const panel = document.getElementById('notifPanel');
  if (badge) { badge.textContent = items.length || ''; badge.classList.toggle('hidden', items.length === 0); }
  if (panel && !panel.classList.contains('hidden')) {
    panel.innerHTML = items.length
      ? items.map(a => `<div class="notif-item${a.danger ? ' danger' : ''}">${a.html}</div>`).join('')
      : '<div class="notif-empty">Sin alertas activas ✓</div>';
  }
  if (panel && panel.classList.contains('hidden')) {
    panel._items = items; // guardar para cuando se abra
  }
}

function lastNMonths(n) {
  const arr = [], now = new Date();
  for (let i = n-1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    arr.push({ key: d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'), label: d.toLocaleDateString('es-MX',{month:'short'}) });
  }
  return arr;
}

/* ---------------- Opciones base de Chart.js ---------------- */
function baseChartOpts(withGrid) {
  Chart.defaults.color = '#8b97ad';
  Chart.defaults.font.family = "'Inter', sans-serif";
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom', labels: { usePointStyle: true, padding: 16, boxWidth: 8 } },
      tooltip: {
        backgroundColor: '#1c2536', borderColor: '#243049', borderWidth: 1, padding: 12,
        callbacks: { label: (c) => ` ${c.dataset.label ? c.dataset.label + ': ' : ''}${money(c.parsed.y ?? c.parsed)}` }
      }
    },
    scales: withGrid ? {
      x: { grid: { color: '#243049' }, ticks: { maxRotation: 0 } },
      y: { grid: { color: '#243049' }, ticks: { callback: (v) => moneyShort(v) } }
    } : {}
  };
}

/* ============================================================
   EXPORTAR / IMPORTAR
   ============================================================ */
document.getElementById('btnExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mis-finanzas-${todayISO()}.json`;
  a.click();
  toast('Datos exportados');
});
document.getElementById('btnImport').addEventListener('click', () => document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || (!data.transactions && !data.goals && !data.debts)) throw new Error('Formato inválido');
      const merge = confirm('¿Combinar estos datos con los que ya tienes?\n\nAceptar = Combinar (conserva lo actual)\nCancelar = Reemplazar todo');
      if (merge) {
        const added = mergeImport(data);
        save(); refreshDatalists(); navigate('transacciones');
        toast(added + ' transacciones agregadas');
      } else {
        state = migrate({ categories: [...DEFAULT_CATEGORIES], accounts: [...DEFAULT_ACCOUNTS], goals: [], debts: [], transactions: [], ...data });
        save(); refreshDatalists(); navigate('dashboard');
        toast('Datos reemplazados');
      }
    } catch (err) { toast('Archivo no válido', 'error'); }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// Combina datos importados con los actuales (sin duplicar por id)
function mergeImport(data) {
  const existing = new Set(state.transactions.map(t => t.id));
  let added = 0;
  (data.transactions || []).forEach(t => { if (!t.id || !existing.has(t.id)) { state.transactions.push(t); existing.add(t.id); added++; } });
  (data.goals || []).forEach(g => { const i = state.goals.findIndex(x => x.id === g.id); if (i >= 0) state.goals[i] = g; else state.goals.push(g); });
  (data.debts || []).forEach(d => { const i = state.debts.findIndex(x => x.id === d.id); if (i >= 0) state.debts[i] = d; else state.debts.push(d); });
  (data.msi || []).forEach(m => {
    const norm = { id: m.id || uid(), name: m.name || 'Compra MSI', total: parseFloat(m.total) || 0, term: parseInt(m.term) || 3, startDate: m.startDate || todayISO(), account: m.account || '' };
    const i = state.msi.findIndex(x => x.id === norm.id);
    if (i >= 0) state.msi[i] = norm; else state.msi.push(norm);
  });
  // presupuestos: conserva los actuales, agrega los que falten
  Object.entries(data.budgets || {}).forEach(([cat, lim]) => { if (!(cat in state.budgets)) state.budgets[cat] = lim; });
  // snapshots de patrimonio: conserva los actuales, agrega los que falten
  Object.entries(data.netWorthSnapshots || {}).forEach(([mk, v]) => { if (!(mk in state.netWorthSnapshots)) state.netWorthSnapshots[mk] = v; });
  // ajustes: rellena solo lo que no exista localmente
  state.settings = Object.assign({}, data.settings || {}, state.settings);
  const cats = new Set(state.categories.map(c => c.toLowerCase()));
  [...(data.categories || []), ...(data.transactions || []).map(t => t.category)].forEach(c => {
    if (c && !cats.has(c.toLowerCase())) { state.categories.push(c); cats.add(c.toLowerCase()); }
  });
  const accs = new Set(state.accounts.map(a => a.name.toLowerCase()));
  const incomingAccs = [
    ...(data.accounts || []).map(a => typeof a === 'string' ? { name: a, kind: 'debito' } : a),
    ...(data.transactions || []).flatMap(t => [t.account, t.toAccount]).filter(Boolean).map(n => ({ name: n, kind: 'debito' })),
  ];
  incomingAccs.forEach(a => {
    if (!a.name) return;
    const existing = state.accounts.find(x => sameAcc(x.name, a.name));
    if (existing) {
      // actualiza la bandera de "registra compras" en cuentas ya existentes (ej. Rappi)
      if (a.tracksPurchases !== undefined) existing.tracksPurchases = a.tracksPurchases;
    } else {
      state.accounts.push({ id: a.id || uid(), name: a.name, kind: a.kind || 'debito', limit: a.limit, cutDay: a.cutDay, dueDay: a.dueDay, opening: a.opening, tracksPurchases: a.tracksPurchases });
      accs.add(a.name.toLowerCase());
    }
  });
  return added;
}

/* ============================================================
   CALCULADORA FLOTANTE
   ============================================================ */
let calcExpr = '';
let calcPanelOpen = false;

// Evaluador seguro (sin eval): tokeniza, convierte a RPN (shunting-yard) y evalúa. Soporta + - * / % ( )
function calcEvaluate(expr) {
  const tokens = (expr || '').match(/(\d+\.?\d*|\.\d+|[+\-*/%()])/g);
  if (!tokens) return null;
  const prec = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, 'u': 3 }; // 'u' = menos unario (negación)
  const out = [], ops = [];
  let prev = null; // 'num' | 'op' | null
  for (const tk of tokens) {
    if (/^[\d.]/.test(tk)) { out.push(parseFloat(tk)); prev = 'num'; }
    else if (tk === '(') { ops.push(tk); prev = 'op'; }
    else if (tk === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') out.push(ops.pop());
      if (ops.pop() !== '(') return null;
      prev = 'num';
    } else {
      if (tk === '+' && (prev === null || prev === 'op')) { prev = 'op'; continue; } // más unario → ignorar
      const op = (tk === '-' && (prev === null || prev === 'op')) ? 'u' : tk;
      const rightAssoc = op === 'u';
      while (ops.length) {
        const top = ops[ops.length - 1];
        if (top === '(' || !(prec[top] > prec[op] || (prec[top] === prec[op] && !rightAssoc))) break;
        out.push(ops.pop());
      }
      ops.push(op); prev = 'op';
    }
  }
  while (ops.length) { const o = ops.pop(); if (o === '(' || o === ')') return null; out.push(o); }
  const st = [];
  for (const tk of out) {
    if (typeof tk === 'number') { st.push(tk); continue; }
    if (tk === 'u') { const a = st.pop(); if (a === undefined) return null; st.push(-a); continue; }
    const b = st.pop(), a = st.pop();
    if (a === undefined || b === undefined) return null;
    st.push(tk === '+' ? a + b : tk === '-' ? a - b : tk === '*' ? a * b : tk === '/' ? a / b : a % b);
  }
  const r = st.pop();
  if (st.length || r === undefined || !isFinite(r)) return null;
  return r;
}
function calcFormat(n) { return n.toLocaleString('es-MX', { maximumFractionDigits: 8 }); }
function calcRender() {
  document.getElementById('calcExpr').textContent = calcExpr || ' ';
  const r = calcEvaluate(calcExpr);
  document.getElementById('calcResult').textContent = calcExpr === '' ? '0' : (r !== null ? calcFormat(r) : '…');
}
function calcInput(k) {
  if (k === 'C') calcExpr = '';
  else if (k === 'back') calcExpr = calcExpr.slice(0, -1);
  else if (k === '=') { const r = calcEvaluate(calcExpr); if (r !== null) calcExpr = String(r); }
  else calcExpr += k;
  calcRender();
}
function toggleCalc(force) {
  calcPanelOpen = force !== undefined ? force : !calcPanelOpen;
  document.getElementById('calcPanel').classList.toggle('open', calcPanelOpen);
}
document.getElementById('calcFab').addEventListener('click', () => toggleCalc());
document.getElementById('calcClose').addEventListener('click', () => toggleCalc(false));
document.getElementById('calcGrid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-k]'); if (b) calcInput(b.dataset.k);
});
// Teclado (solo cuando el panel está abierto y no estás escribiendo en un campo)
document.addEventListener('keydown', (e) => {
  if (!calcPanelOpen) return;
  if (/^(input|textarea|select)$/i.test(e.target.tagName)) return;
  const k = e.key;
  if (/^[0-9]$/.test(k) || ['+', '-', '*', '/', '%', '(', ')', '.'].includes(k)) { calcInput(k); e.preventDefault(); }
  else if (k === 'Enter' || k === '=') { calcInput('='); e.preventDefault(); }
  else if (k === 'Backspace') { calcInput('back'); e.preventDefault(); }
  else if (k === 'Escape') { toggleCalc(false); }
  else if (k.toLowerCase() === 'c') { calcInput('C'); }
});
calcRender();

/* ============================================================
   MODO PLAN  (capa de SOLO LECTURA sobre los datos actuales)
   Prioriza a dónde va cada peso libre según reglas FIJAS.
   - planConfig            → configuración editable (defaults).
   - evaluarPlan(estado)   → función PURA: sin tocar state/localStorage/DOM.
   - simularPlanETAs       → estima en cuántos meses queda lista cada cosa.
   - construirEstadoPlan() → adaptador (lee state y arma el `estado`).
   - renderPlan()          → pinta la vista (reutiliza tarjetas de metas).
   - pruebasPlan()         → 2-4 pruebas manuales (window.pruebasPlan()).
   ============================================================ */

// Configuración editable. Los números monetarios pueden sobreescribirse por el
// usuario en state.settings.plan (ver mergePlanConfig). Dejar gastosFijos /
// comidaGasolina / sueldoMensual en null = estimarlos automáticamente.
const planConfig = {
  fondoF1: 4800,          // Fondo de emergencia F1
  fondoF2: 14300,         // Fondo de emergencia F2 (se desbloquea cuando F1 está completo)
  abonoMensual: 1500,     // cuánto se abona al mes al objetivo activo
  pagoPC: null,           // pago mensual de la deuda que bloquea metas (null = usar el pago de esa deuda, o 0 si no hay)
  diasAntesCorte: 8,      // si una tarjeta con saldo corta dentro de N días, bloquea todo
  deudaPCMatch: 'pc',     // subcadena para autodetectar la deuda que bloquea metas (vacío = no autodetectar)
  comidaGasolinaCats: ['comida', 'supermercado', 'transporte', 'gasolina'], // categorías estimadas
  // Umbral compartido: las metas de lujo se desbloquean cuando la deuda PC baja de aquí.
  deudaPCBajo: 10000,
  // overrides opcionales (null = auto):
  sueldoMensual: null,
  gastosFijos: null,
  comidaGasolina: null,
  // Las metas que entran al plan las elige el usuario en "Editar supuestos" (checklist).
  // Internamente se guardan los ids EXCLUIDOS en state.settings.plan.metasLujoExcluidas;
  // por defecto, TODAS las metas (excepto el fondo de emergencia) entran al plan.
};

// Simulación hacia adelante (PURA) para estimar el ETA de cada objetivo.
// Cada mes: (1) la deuda PC baja `pagoPC` en paralelo; (2) un único `abonoMensual`
// va al objetivo desbloqueado de mayor prioridad (F1 → F2 → metas de lujo en orden).
// Devuelve un mapa { fondoF1, fondoF2, <claveMeta>: meses } (0 = ya lista, null = inalcanzable).
function simularPlanETAs(estado, cfg) {
  const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : 0;
  let fondo = num(estado.fondoAhorrado);
  let deudaPC = num(estado.deudaPCPendiente);
  const abono = num(cfg.abonoMensual);
  const pagoPC = num(estado.pagoPC);
  const metas = (estado.metasLujo || []).map(m => ({
    clave: m.clave, objetivo: num(m.objetivo), saldo: num(m.ahorrado),
    umbral: (m.requiere && m.requiere.deudaPCBajo != null) ? m.requiere.deudaPCBajo : null,
  }));
  const eta = {};
  // Mes 0: marca lo que ya está completo de entrada.
  if (fondo >= cfg.fondoF1) eta.fondoF1 = 0;
  if (fondo >= cfg.fondoF2) eta.fondoF2 = 0;
  metas.forEach(m => { if (m.objetivo > 0 && m.saldo >= m.objetivo) eta[m.clave] = 0; });

  const faltan = () => (eta.fondoF1 == null) || (eta.fondoF2 == null) || metas.some(m => eta[m.clave] == null);
  const TOPE = 1200; // tope de seguridad: 100 años
  for (let mes = 1; mes <= TOPE && faltan(); mes++) {
    if (pagoPC > 0) deudaPC = Math.max(0, deudaPC - pagoPC);   // deuda PC en paralelo
    // Elige el destino del abono por prioridad de cascada.
    let destino = null;
    if (fondo < cfg.fondoF1) destino = 'F1';
    else if (fondo < cfg.fondoF2) destino = 'F2';
    else {
      for (const m of metas) {
        if (m.objetivo <= 0 || m.saldo >= m.objetivo) continue;          // ya lista / sin objetivo
        if (m.umbral != null && deudaPC >= m.umbral) continue;           // sigue bloqueada por deuda
        destino = m; break;
      }
    }
    if (abono > 0 && destino) {
      if (destino === 'F1' || destino === 'F2') fondo += abono;
      else destino.saldo += abono;
    }
    // Registra lo que se completó este mes.
    if (eta.fondoF1 == null && fondo >= cfg.fondoF1) eta.fondoF1 = mes;
    if (eta.fondoF2 == null && fondo >= cfg.fondoF2) eta.fondoF2 = mes;
    metas.forEach(m => { if (eta[m.clave] == null && m.objetivo > 0 && m.saldo >= m.objetivo) eta[m.clave] = mes; });
    // Si nada puede avanzar, corta para no iterar en vano.
    if (abono <= 0 && (pagoPC <= 0 || deudaPC <= 0)) break;
  }
  // Las claves que nunca se completaron quedan en null (inalcanzable).
  if (eta.fondoF1 == null) eta.fondoF1 = null;
  if (eta.fondoF2 == null) eta.fondoF2 = null;
  metas.forEach(m => { if (eta[m.clave] == null) eta[m.clave] = null; });
  return eta;
}

// Función central PURA. Recibe el `estado` financiero (ya resuelto a números) y la
// `config`; NO toca state, localStorage ni el DOM. Devuelve el plan evaluado.
function evaluarPlan(estado, config = planConfig) {
  const cfg = config;
  const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : 0;
  const sem = (e) => e === 'lista' ? '🟢' : e === 'en_curso' ? '🟡' : '🔒';

  // ---- Dinero libre del mes ----
  const dineroLibreMes = num(estado.sueldoMensual) - num(estado.gastosFijos)
    - num(estado.pagoPC) - num(estado.comidaGasolina);

  // ---- Hechos base ----
  const fondo = num(estado.fondoAhorrado);
  const deudaPC = num(estado.deudaPCPendiente);
  // Nombre real de la deuda que bloquea las metas (cae a un genérico si no hay/ no se pasó).
  const nombreDeuda = estado.deudaNombre || 'tu deuda prioritaria';
  const f1Completo = fondo >= cfg.fondoF1;
  const f2Completo = fondo >= cfg.fondoF2;

  // Tarjetas que "bloquean todo": tienen saldo y su corte cae dentro de la ventana.
  const tarjetas = (estado.tarjetas || []).map(t => ({
    nombre: t.nombre, saldo: num(t.saldo),
    diasParaCorte: (t.diasParaCorte == null ? null : num(t.diasParaCorte)),
  }));
  const tarjetasUrgentes = tarjetas.filter(t =>
    t.saldo > 0 && t.diasParaCorte != null && t.diasParaCorte <= cfg.diasAntesCorte);
  const hayTarjetaUrgente = tarjetasUrgentes.length > 0;
  const totalTarjetasUrg = tarjetasUrgentes.reduce((s, t) => s + t.saldo, 0);
  const razonTarjeta = 'Primero paga tus tarjetas completas antes del corte';

  // ETAs por simulación (respeta cascada + deuda PC en paralelo).
  const etas = simularPlanETAs(estado, cfg);

  const objetivos = [];

  // 1) Tarjetas de crédito (bloquean todo lo demás cuando hay corte cercano).
  objetivos.push({
    clave: 'tarjetas', nombre: 'Tarjetas de crédito (antes del corte)', tipo: 'tarjeta',
    objetivo: totalTarjetasUrg, ahorrado: 0, restante: totalTarjetasUrg, pct: 0,
    estado: hayTarjetaUrgente ? 'en_curso' : 'lista',
    semaforo: hayTarjetaUrgente ? '🟡' : '🟢',
    razon: hayTarjetaUrgente
      ? `Paga ${money(totalTarjetasUrg)} antes del corte para no generar intereses`
      : null,
    etaMeses: hayTarjetaUrgente ? 0 : null,
  });

  // 2) Fondo de emergencia F1.
  {
    const e = hayTarjetaUrgente ? 'bloqueada' : (f1Completo ? 'lista' : 'en_curso');
    objetivos.push({
      clave: 'fondoF1', nombre: 'Fondo de emergencia · F1', tipo: 'fondo',
      objetivo: cfg.fondoF1, ahorrado: Math.min(fondo, cfg.fondoF1),
      restante: Math.max(0, cfg.fondoF1 - fondo),
      pct: cfg.fondoF1 > 0 ? Math.min(100, fondo / cfg.fondoF1 * 100) : 100,
      estado: e, semaforo: sem(e),
      razon: hayTarjetaUrgente ? razonTarjeta : null, etaMeses: etas.fondoF1,
    });
  }

  // 3) Fondo de emergencia F2 (se desbloquea cuando F1 está completo).
  {
    let e, razon = null;
    if (hayTarjetaUrgente) { e = 'bloqueada'; razon = razonTarjeta; }
    else if (!f1Completo) { e = 'bloqueada'; razon = 'Requiere fondo F1 completo'; }
    else if (f2Completo) { e = 'lista'; }
    else { e = 'en_curso'; }
    objetivos.push({
      clave: 'fondoF2', nombre: 'Fondo de emergencia · F2', tipo: 'fondo',
      objetivo: cfg.fondoF2, ahorrado: Math.min(fondo, cfg.fondoF2),
      restante: Math.max(0, cfg.fondoF2 - fondo),
      pct: cfg.fondoF2 > 0 ? Math.min(100, fondo / cfg.fondoF2 * 100) : 100,
      estado: e, semaforo: sem(e), razon, etaMeses: etas.fondoF2,
    });
  }

  // 4) Metas de lujo (bloqueadas hasta: F1 completo Y deuda PC < umbral).
  (estado.metasLujo || []).forEach(m => {
    const objetivo = num(m.objetivo), ahorrado = num(m.ahorrado);
    const completa = objetivo > 0 && ahorrado >= objetivo;
    const umbral = m.requiere && m.requiere.deudaPCBajo;
    let e, razon = null;
    if (completa) { e = 'lista'; }
    else if (hayTarjetaUrgente) { e = 'bloqueada'; razon = razonTarjeta; }
    else if (m.requiere && m.requiere.fondoF1 && !f1Completo) { e = 'bloqueada'; razon = 'Requiere fondo F1 completo'; }
    else if (umbral != null && deudaPC >= umbral) { e = 'bloqueada'; razon = `Requiere bajar ${nombreDeuda} a < ${money(umbral)} (va en ${money(deudaPC)})`; }
    else { e = 'en_curso'; }
    objetivos.push({
      clave: m.clave, nombre: m.nombre, tipo: 'meta',
      objetivo, ahorrado, restante: Math.max(0, objetivo - ahorrado),
      pct: objetivo > 0 ? Math.min(100, ahorrado / objetivo * 100) : 0,
      estado: e, semaforo: sem(e), razon, etaMeses: etas[m.clave],
    });
  });

  // ---- Asignación de este mes ----
  let asignacionMes;
  const lujoBloqueadas = objetivos.filter(o => o.tipo === 'meta' && o.estado === 'bloqueada');
  const notaBloqueo = lujoBloqueadas.length
    ? ' ' + lujoBloqueadas.map(o => `${o.nombre} bloqueado`).join('. ') + '.'
    : '';
  if (hayTarjetaUrgente) {
    asignacionMes = {
      clave: 'tarjetas', nombre: 'Tarjetas de crédito', monto: totalTarjetasUrg,
      mensaje: `Este mes: paga ${money(totalTarjetasUrg)} → Tarjetas antes del corte. Todo lo demás en pausa.`,
    };
  } else {
    // Primer objetivo (sin contar tarjetas) que esté "en_curso".
    const activo = objetivos.find(o => o.clave !== 'tarjetas' && o.estado === 'en_curso');
    if (activo) {
      const monto = Math.min(cfg.abonoMensual, activo.restante || cfg.abonoMensual);
      asignacionMes = {
        clave: activo.clave, nombre: activo.nombre, monto,
        mensaje: `Este mes: ${money(monto)} → ${activo.nombre}.${notaBloqueo}`,
      };
    } else {
      // No hay nada "en curso": o todo está listo, o lo único pendiente está bloqueado.
      const bloqueada = objetivos.find(o => o.clave !== 'tarjetas' && o.estado === 'bloqueada');
      asignacionMes = bloqueada
        ? { clave: null, nombre: bloqueada.nombre, monto: 0, mensaje: `Este mes no hay objetivo que abonar aún: ${bloqueada.nombre} sigue bloqueado — ${bloqueada.razon}.` }
        : { clave: null, nombre: null, monto: 0, mensaje: '¡Tu plan está al día! 🎉 No hay objetivos pendientes.' };
    }
  }

  return {
    dineroLibreMes, fondoAhorrado: fondo, deudaPCPendiente: deudaPC,
    f1Completo, f2Completo, hayTarjetaUrgente, objetivos, asignacionMes,
  };
}

/* ---------------- Adaptador: arma el `estado` desde el state real ---------------- */
// Combina los defaults de planConfig con los overrides guardados por el usuario.
function mergePlanConfig() {
  const ov = (state.settings && state.settings.plan) || {};
  // Solo permitimos sobreescribir números/cadenas simples; las categorías base se conservan.
  const cfg = Object.assign({}, planConfig, ov);
  cfg.comidaGasolinaCats = planConfig.comidaGasolinaCats;
  return cfg;
}
// Promedio mensual de gasto de un conjunto de categorías (últimos n meses).
function avgMonthlyByCategories(cats, n = 3) {
  const set = new Set((cats || []).map(c => c.toLowerCase()));
  const keys = lastNMonths(n).map(m => m.key);
  let sum = 0;
  state.transactions.forEach(t => {
    if (t.type === 'Gasto' && set.has((t.category || '').toLowerCase()) && keys.includes(t.date.slice(0, 7))) sum += t.amount;
  });
  return sum / n;
}
// Localiza la deuda que bloquea las metas: por id elegido a mano, o por nombre que contenga el match.
function encontrarDeudaPC(cfg) {
  const ov = (state.settings && state.settings.plan) || {};
  if (ov.deudaPCId === '__none__') return null;            // el usuario eligió "Ninguna"
  if (ov.deudaPCId) { const d = state.debts.find(x => x.id === ov.deudaPCId); if (d) return d; }
  const m = (cfg.deudaPCMatch || '').toLowerCase().trim();
  if (!m) return null;
  return state.debts.find(d => (d.name || '').toLowerCase().includes(m)) || null;
}
// Construye el `estado` que consume evaluarPlan (impuro: lee state).
function construirEstadoPlan() {
  const cfg = mergePlanConfig();

  const sueldoMensual = (cfg.sueldoMensual != null && cfg.sueldoMensual !== '')
    ? parseFloat(cfg.sueldoMensual) : monthlyFixedIncome();

  const comidaGasolina = (cfg.comidaGasolina != null && cfg.comidaGasolina !== '')
    ? parseFloat(cfg.comidaGasolina) : avgMonthlyByCategories(cfg.comidaGasolinaCats, 3);

  // Deuda que bloquea metas y su pendiente (mismo cálculo que la vista Deudas).
  const deudaPC = encontrarDeudaPC(cfg);
  const deudaPCPendiente = deudaPC
    ? Math.max(0, (deudaPC.total || 0) - ((deudaPC.paid || 0) + debtAutoPaid(deudaPC))) : 0;
  const pagoPC = (cfg.pagoPC != null && cfg.pagoPC !== '')
    ? parseFloat(cfg.pagoPC) : (deudaPC && deudaPC.monthly ? deudaPC.monthly : 0);

  // Gastos fijos: recurrentes de gasto, excluyendo comida/gasolina (se cuentan aparte).
  let gastosFijos;
  if (cfg.gastosFijos != null && cfg.gastosFijos !== '') gastosFijos = parseFloat(cfg.gastosFijos);
  else {
    const excl = new Set(cfg.comidaGasolinaCats.map(c => c.toLowerCase()));
    gastosFijos = detectRecurring()
      .filter(r => r.type === 'Gasto' && !excl.has((r.category || '').toLowerCase()))
      .reduce((s, r) => s + r.monthly, 0);
  }

  // Fondo de emergencia = lo ahorrado en la meta marcada emergency.
  const fondoGoal = state.goals.find(g => g.emergency);
  const fondoAhorrado = fondoGoal ? (parseFloat(fondoGoal.saved) || 0) : 0;

  // Tarjetas de crédito (saldo que debes + días al corte).
  const tarjetas = state.accounts.filter(a => a.kind === 'credito').map(a => ({
    nombre: a.name, saldo: Math.max(0, cardOwed(a)),
    diasParaCorte: a.cutDay ? daysUntilDay(a.cutDay) : null,
  }));

  // Metas de lujo: todas las metas que NO sean el fondo de emergencia y que el
  // usuario no haya excluido del plan (checklist en "Editar supuestos"). Todas
  // comparten la misma regla de desbloqueo: F1 completo Y deuda PC < umbral.
  const ov = (state.settings && state.settings.plan) || {};
  const excluidas = new Set(ov.metasLujoExcluidas || []);
  const requiere = { fondoF1: true, deudaPCBajo: cfg.deudaPCBajo };
  const metasLujo = state.goals
    .filter(g => !g.emergency && !excluidas.has(g.id))
    .map(g => ({
      clave: g.id, nombre: g.name,
      objetivo: parseFloat(g.target) || 0, ahorrado: parseFloat(g.saved) || 0,
      requiere,
    }));

  const estado = {
    sueldoMensual, gastosFijos, pagoPC, comidaGasolina, fondoAhorrado,
    deudaPCPendiente, deudaNombre: deudaPC ? deudaPC.name : null,
    tarjetas, metasLujo,
  };
  return { estado, cfg, deudaPC, fondoGoal };
}

/* ---------------- Vista del Plan ---------------- */
const PLAN_TIPO_LBL = { tarjeta: 'Tarjeta de crédito', fondo: 'Fondo de emergencia', meta: 'Meta de ahorro' };
const etaTexto = (o) => {
  if (o.estado === 'lista') return '✅ Lista';
  if (o.etaMeses == null) return '⏳ Sin estimación';
  const lbl = o.etaMeses === 1 ? 'mes' : 'meses';
  if (o.etaMeses === 0) return '🟡 Disponible ya';
  return (o.estado === 'bloqueada' ? '🔒 Disponible en ~' : '🟡 Lista en ~') + `${o.etaMeses} ${lbl}`;
};
let planChart;
function renderPlan() {
  const { estado, cfg, deudaPC } = construirEstadoPlan();
  const r = evaluarPlan(estado, cfg);
  const umbralLujo = cfg.deudaPCBajo || 10000;

  // ----- Banner "Este mes" -----
  const tm = document.getElementById('planThisMonth');
  const faltaLibre = r.dineroLibreMes < cfg.abonoMensual && !r.hayTarjetaUrgente;
  tm.className = 'plan-banner' + (r.hayTarjetaUrgente ? ' warn' : '');
  tm.innerHTML = `
    <div class="plan-banner-ico">${r.hayTarjetaUrgente ? '⚠️' : '🧭'}</div>
    <div class="plan-banner-body">
      <div class="plan-banner-title">${esc(r.asignacionMes.mensaje)}</div>
      <div class="plan-banner-sub">Dinero libre estimado del mes: <b>${money(r.dineroLibreMes)}</b> · Abono mensual del plan: <b>${money(cfg.abonoMensual)}</b>${faltaLibre ? ` · <span class="warn-text">ojo: tu dinero libre es menor al abono planeado</span>` : ''}</div>
    </div>`;

  // ----- Stat-grid de dinero libre -----
  const tieneDeuda = !!deudaPC;
  document.getElementById('planStats').innerHTML = `
    <div class="stat-card income"><div class="stat-label">Sueldo mensual</div><div class="stat-value">${money(estado.sueldoMensual)}</div></div>
    <div class="stat-card expense"><div class="stat-label">Compromisos del mes</div><div class="stat-value">${money(estado.gastosFijos + estado.comidaGasolina + estado.pagoPC)}</div><div class="stat-foot">Fijos ${moneyShort(estado.gastosFijos)} · Comida/Gas ${moneyShort(estado.comidaGasolina)}${estado.pagoPC > 0 ? ' · Deuda ' + moneyShort(estado.pagoPC) : ''}</div></div>
    <div class="stat-card balance"><div class="stat-label">Dinero libre del mes</div><div class="stat-value ${r.dineroLibreMes < 0 ? 'amount-neg' : ''}">${money(r.dineroLibreMes)}</div><div class="stat-foot">Sueldo − fijos${tieneDeuda ? ' − deuda' : ''} − comida/gas</div></div>
    <div class="stat-card debt"><div class="stat-label">Deuda prioritaria</div><div class="stat-value">${tieneDeuda ? money(r.deudaPCPendiente) : '—'}</div><div class="stat-foot">${tieneDeuda ? esc(deudaPC.name) : 'Ninguna · no bloquea tus metas'}</div></div>`;

  // ----- Gráfica del fondo de emergencia (Chart.js) -----
  const fondo = estado.fondoAhorrado, F1 = cfg.fondoF1, F2 = cfg.fondoF2;
  document.getElementById('planFundNow').textContent = `${money(fondo)} / ${money(F2)}`;
  planChart?.destroy();
  planChart = new Chart(document.getElementById('chartPlanFondo'), {
    type: 'doughnut',
    data: {
      labels: ['Ahorrado', 'Falta para F2'],
      datasets: [{ data: [Math.min(fondo, F2), Math.max(0, F2 - fondo)], backgroundColor: ['#22c55e', '#243049'], borderWidth: 0 }],
    },
    options: { ...baseChartOpts(false), cutout: '70%' },
  });
  const f1ok = fondo >= F1, f2ok = fondo >= F2;
  document.getElementById('planFundLegend').innerHTML = `
    <div class="plan-legrow"><span>${f1ok ? '🟢' : '🟡'} F1 · ${money(F1)}</span><span class="muted">${f1ok ? 'Completo' : money(Math.max(0, F1 - fondo)) + ' por ahorrar'}</span></div>
    <div class="plan-legrow"><span>${f2ok ? '🟢' : (f1ok ? '🟡' : '🔒')} F2 · ${money(F2)}</span><span class="muted">${f2ok ? 'Completo' : (f1ok ? money(Math.max(0, F2 - fondo)) + ' por ahorrar' : 'Requiere F1 primero')}</span></div>`;

  // ----- Cómo funciona el plan (pasos generados según tus datos reales) -----
  const pasos = [];
  if (estado.tarjetas.length) pasos.push(`Paga tus <b>tarjetas</b> completas antes del corte (bloquea todo lo demás).`);
  pasos.push(`Llena el <b>Fondo F1</b> (${money(F1)}).`);
  if (tieneDeuda && estado.pagoPC > 0) pasos.push(`Abona <b>${money(estado.pagoPC)}</b>/mes a <b>${esc(deudaPC.name)}</b> (en paralelo a F1).`);
  pasos.push(`Llena el <b>Fondo F2</b> (${money(F2)}) cuando F1 esté completo.`);
  if (estado.metasLujo.length) {
    pasos.push(tieneDeuda
      ? `Desbloquea tus <b>metas</b> cuando F1 esté completo <u>y</u> <b>${esc(deudaPC.name)}</b> baje de ${money(umbralLujo)}.`
      : `Desbloquea tus <b>metas</b> cuando el <b>Fondo F1</b> esté completo.`);
  } else {
    pasos.push(`Crea <b>metas</b> en la vista Metas y aparecerán aquí en orden de prioridad.`);
  }
  document.getElementById('planExplain').innerHTML = `<ol class="plan-steps">${pasos.map(p => `<li>${p}</li>`).join('')}</ol>`;

  // ----- Objetivos en cascada (reutiliza .goal-card) -----
  const grid = document.getElementById('planGrid');
  grid.innerHTML = r.objetivos.map(o => {
    const locked = o.estado === 'bloqueada';
    const cls = o.estado === 'lista' ? 'green' : o.estado === 'en_curso' ? 'amber' : 'red';
    const activa = r.asignacionMes.clave === o.clave;

    // La tarjeta de "Tarjetas" sin urgencia se muestra simplificada.
    if (o.tipo === 'tarjeta' && o.objetivo === 0) {
      return `<div class="goal-card plan-card done">
        <div class="goal-top"><div><div class="goal-name">🟢 ${esc(o.nombre)}</div><div class="goal-sub">${PLAN_TIPO_LBL.tarjeta}</div></div></div>
        <div class="pay-note ok">Sin tarjetas por pagar antes del corte 🎉</div>
      </div>`;
    }

    const cuerpo = o.tipo === 'tarjeta'
      ? `<div class="goal-amounts">
           <div><div class="lbl">Por pagar</div><div class="big amount-neg">${money(o.restante)}</div></div>
           <div style="text-align:right"><div class="lbl">Antes de</div><div class="big">el corte</div></div>
         </div>`
      : `<div class="goal-amounts">
           <div><div class="lbl">Ahorrado</div><div class="big amount-save">${money(o.ahorrado)}</div></div>
           <div style="text-align:right"><div class="lbl">Objetivo</div><div class="big">${money(o.objetivo)}</div></div>
         </div>
         <div class="progress ${cls}"><span style="width:${o.pct}%"></span></div>
         <div class="goal-meta"><span>${o.pct.toFixed(0)}% completado</span><span>${o.estado === 'lista' ? '¡Logrado!' : 'Faltan ' + money(o.restante)}</span></div>`;

    return `<div class="goal-card plan-card ${locked ? 'locked' : ''} ${o.estado === 'lista' ? 'done' : ''}">
      <div class="goal-top">
        <div>
          <div class="goal-name">${o.semaforo} ${esc(o.nombre)} ${activa ? '<span class="badge plan-now">ESTE MES</span>' : ''}</div>
          <div class="goal-sub">${PLAN_TIPO_LBL[o.tipo] || ''}</div>
        </div>
      </div>
      ${cuerpo}
      <div class="goal-meta"><span>${etaTexto(o)}</span></div>
      ${o.razon ? `<div class="pay-note ${locked ? 'warn' : ''}">${locked ? '🔒 ' : ''}${esc(o.razon)}</div>` : ''}
    </div>`;
  }).join('');
}

// Modal para editar los supuestos del plan (se guardan en state.settings.plan).
function planSupuestosModal() {
  const cfg = mergePlanConfig();
  const ov = (state.settings.plan) || {};
  const optBlank = (v) => (v == null || v === '') ? '' : v;

  // Mini-tarjetas (selección única) de la deuda que bloquea las metas.
  const autoDeuda = encontrarDeudaPC(cfg);
  const autoPago = autoDeuda && autoDeuda.monthly ? autoDeuda.monthly : 0;
  const selDebtId = autoDeuda ? autoDeuda.id : '__none__';   // tarjeta actualmente activa
  const pendDeuda = (d) => Math.max(0, (d.total || 0) - ((d.paid || 0) + debtAutoPaid(d)));
  const deudaHtml = `<div class="plan-pick-grid">`
    + `<div class="plan-pick ${selDebtId === '__none__' ? 'on' : ''}" onclick="selectPlanDebt(this)">
         <input type="radio" name="deudaPCId" value="__none__" ${selDebtId === '__none__' ? 'checked' : ''} tabindex="-1" />
         <div class="pp-top"><span class="pp-name">🚫 Ninguna</span><span class="pp-radio"></span></div>
         <div class="pp-sub">No bloquear metas por deuda</div>
       </div>`
    + state.debts.map(d => {
        const on = selDebtId === d.id;
        return `<div class="plan-pick ${on ? 'on' : ''}" onclick="selectPlanDebt(this)">
          <input type="radio" name="deudaPCId" value="${d.id}" ${on ? 'checked' : ''} tabindex="-1" />
          <div class="pp-top"><span class="pp-name">${esc(d.name)}</span><span class="pp-radio"></span></div>
          <div class="pp-sub">Debes ${money(pendDeuda(d))}${d.monthly ? ` · ${money(d.monthly)}/mes` : ''}</div>
        </div>`;
      }).join('')
    + `</div>`;

  // Mini-tarjetas seleccionables de TUS metas reales (encendida = incluida en el plan).
  const excluidas = new Set(ov.metasLujoExcluidas || []);
  const metas = state.goals.filter(g => !g.emergency);
  const metasHtml = metas.length
    ? `<div class="plan-goal-grid">` + metas.map(g => {
        const objetivo = parseFloat(g.target) || 0, saved = parseFloat(g.saved) || 0;
        const pct = objetivo > 0 ? Math.min(100, saved / objetivo * 100) : 0;
        const cls = pct >= 100 ? 'green' : pct >= 50 ? 'amber' : '';
        const incluida = !excluidas.has(g.id);
        return `<div class="plan-goal ${incluida ? 'on' : ''}" onclick="togglePlanGoal(this)">
          <input type="checkbox" name="incl_${g.id}" value="1" ${incluida ? 'checked' : ''} tabindex="-1" />
          <div class="pg-top"><span class="pg-name">${esc(g.name)}</span><span class="pg-check"></span></div>
          <div class="progress ${cls}"><span style="width:${pct}%"></span></div>
          <div class="pg-foot"><span>${money(saved)} / ${money(objetivo)}</span><span>${pct.toFixed(0)}%</span></div>
        </div>`;
      }).join('') + `</div>`
    : `<p class="muted" style="font-size:13px;margin:0">Aún no tienes metas. Créalas en la vista <b>Metas</b> y aquí podrás incluirlas en el plan.</p>`;

  const html = `<div class="plan-modal">
    <div class="field-row">
      <div class="field"><label>Fondo F1</label><input type="number" name="fondoF1" value="${cfg.fondoF1}" step="100" min="0" /></div>
      <div class="field"><label>Fondo F2</label><input type="number" name="fondoF2" value="${cfg.fondoF2}" step="100" min="0" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Abono mensual</label><input type="number" name="abonoMensual" value="${cfg.abonoMensual}" step="100" min="0" /></div>
      <div class="field"><label>Días antes del corte que bloquean</label><input type="number" name="diasAntesCorte" value="${cfg.diasAntesCorte}" step="1" min="0" max="31" /></div>
    </div>
    <div class="field">
      <label>Deuda que bloquea tus metas</label>
      ${deudaHtml}
      <div class="hint">La deuda elegida debe bajar del umbral de abajo para liberar tus metas. Elige "Ninguna" si no quieres que ninguna deuda las bloquee.</div>
    </div>
    <div class="field-row">
      <div class="field"><label>Liberar metas cuando esa deuda baje de</label><input type="number" name="deudaPCBajo" value="${cfg.deudaPCBajo}" step="500" min="0" /></div>
      <div class="field"><label>Pago mensual de esa deuda</label><input type="number" name="pagoPC" value="${optBlank(ov.pagoPC)}" step="100" min="0" placeholder="Auto: ${money(autoPago)}" /></div>
    </div>
    <div class="field">
      <label>Metas incluidas en el plan</label>
      ${metasHtml}
      <div class="hint">Toca una meta para incluirla o quitarla del plan. Las que dejes fuera siguen en tu vista Metas, pero no aparecen en el Plan.</div>
    </div>
    <p class="muted" style="font-size:13px;margin:4px 0">Deja en blanco lo siguiente para estimarlo automáticamente desde tus datos:</p>
    <div class="field-row">
      <div class="field"><label>Sueldo mensual</label><input type="number" name="sueldoMensual" value="${optBlank(ov.sueldoMensual)}" step="0.01" min="0" placeholder="Auto: ${money(monthlyFixedIncome())}" /></div>
      <div class="field"><label>Gastos fijos / mes</label><input type="number" name="gastosFijos" value="${optBlank(ov.gastosFijos)}" step="0.01" min="0" placeholder="Auto desde recurrentes" /></div>
    </div>
    <div class="field"><label>Comida y gasolina / mes</label><input type="number" name="comidaGasolina" value="${optBlank(ov.comidaGasolina)}" step="0.01" min="0" placeholder="Auto: ${money(avgMonthlyByCategories(cfg.comidaGasolinaCats, 3))}" /></div>
    <div class="modal-actions">
      <button type="button" class="btn-cancel" onclick="closeModal()">Cancelar</button>
      <button type="submit" class="btn-primary">Guardar supuestos</button>
    </div>
  </div>`;
  openModal('Editar supuestos del plan', html, (data) => {
    const numOrNull = (v) => (v === '' || v == null) ? null : (parseFloat(v) || 0);
    const plan = Object.assign({}, state.settings.plan || {});
    plan.fondoF1 = parseFloat(data.fondoF1) || planConfig.fondoF1;
    plan.fondoF2 = parseFloat(data.fondoF2) || planConfig.fondoF2;
    plan.abonoMensual = parseFloat(data.abonoMensual) || planConfig.abonoMensual;
    plan.deudaPCBajo = parseFloat(data.deudaPCBajo);
    if (isNaN(plan.deudaPCBajo)) plan.deudaPCBajo = planConfig.deudaPCBajo;
    plan.diasAntesCorte = parseInt(data.diasAntesCorte, 10);
    if (isNaN(plan.diasAntesCorte)) plan.diasAntesCorte = planConfig.diasAntesCorte;
    plan.pagoPC = numOrNull(data.pagoPC);
    plan.sueldoMensual = numOrNull(data.sueldoMensual);
    plan.gastosFijos = numOrNull(data.gastosFijos);
    plan.comidaGasolina = numOrNull(data.comidaGasolina);
    plan.deudaPCId = data.deudaPCId || null;
    // Metas EXCLUIDAS = las que quedaron SIN marcar (las marcadas llegan como incl_<id>='1').
    // Guardamos exclusiones (no inclusiones) para que las metas nuevas entren al plan por defecto.
    plan.metasLujoExcluidas = state.goals
      .filter(g => !g.emergency && !data['incl_' + g.id])
      .map(g => g.id);
    state.settings.plan = plan;
    save(); closeModal(); renderPlan(); toast('Supuestos del plan actualizados');
  });
}
// Alterna si una meta está incluida en el plan (clic en su mini-tarjeta).
window.togglePlanGoal = (el) => {
  const cb = el.querySelector('input[type=checkbox]');
  if (!cb) return;
  cb.checked = !cb.checked;
  el.classList.toggle('on', cb.checked);
};
// Selecciona la deuda que bloquea las metas (selección única tipo radio).
window.selectPlanDebt = (el) => {
  const grid = el.parentElement;
  if (grid) grid.querySelectorAll('.plan-pick').forEach(x => x.classList.remove('on'));
  el.classList.add('on');
  const r = el.querySelector('input[type=radio]');
  if (r) r.checked = true;
};
document.getElementById('btnPlanSupuestos').addEventListener('click', planSupuestosModal);

/* ---------------- Pruebas manuales del Modo Plan ----------------
   Ejecuta window.pruebasPlan() en la consola del navegador. Son PURAS:
   no dependen de tus datos; construyen estados sintéticos y verifican evaluarPlan. */
function pruebasPlan() {
  // Config base de prueba: dinero libre controlado, sin auto-estimación.
  const cfg = Object.assign({}, planConfig, { gastosFijos: 0, comidaGasolina: 0 });
  let ok = 0, total = 0;
  const check = (nombre, cond) => {
    total++;
    if (cond) { ok++; console.log('✅ PASA:', nombre); }
    else { console.error('❌ FALLA:', nombre); }
  };
  const reglaAW = { fondoF1: true, deudaPCBajo: 10000 };

  // --- Caso A: F1 incompleto, deuda PC alta, sin tarjetas → abono a F1, lujo bloqueado ---
  const A = evaluarPlan({
    sueldoMensual: 12000, gastosFijos: 4000, pagoPC: 1500, comidaGasolina: 2000,
    fondoAhorrado: 1000, deudaPCPendiente: 12000, tarjetas: [],
    metasLujo: [{ clave: 'appleWatch', nombre: 'Apple Watch', objetivo: 8500, ahorrado: 3200, requiere: reglaAW }],
  }, cfg);
  check('A · dinero libre = 12000-4000-1500-2000 = 4500', A.dineroLibreMes === 4500);
  check('A · F1 en curso', A.objetivos.find(o => o.clave === 'fondoF1').estado === 'en_curso');
  check('A · F2 bloqueada (requiere F1)', A.objetivos.find(o => o.clave === 'fondoF2').estado === 'bloqueada');
  check('A · Apple Watch bloqueado', A.objetivos.find(o => o.clave === 'appleWatch').estado === 'bloqueada');
  check('A · asignación de este mes va a F1', A.asignacionMes.clave === 'fondoF1');

  // --- Caso B: F1 completo y deuda PC baja → lujo desbloqueado; abono va a F2 (prioridad) ---
  const B = evaluarPlan({
    sueldoMensual: 12000, gastosFijos: 4000, pagoPC: 1500, comidaGasolina: 2000,
    fondoAhorrado: 6000, deudaPCPendiente: 5000, tarjetas: [],
    metasLujo: [{ clave: 'appleWatch', nombre: 'Apple Watch', objetivo: 8500, ahorrado: 3200, requiere: reglaAW }],
  }, cfg);
  check('B · F1 lista', B.objetivos.find(o => o.clave === 'fondoF1').estado === 'lista');
  check('B · F2 en curso', B.objetivos.find(o => o.clave === 'fondoF2').estado === 'en_curso');
  check('B · Apple Watch en curso (desbloqueado)', B.objetivos.find(o => o.clave === 'appleWatch').estado === 'en_curso');
  check('B · asignación va a F2 (prioridad sobre lujo)', B.asignacionMes.clave === 'fondoF2');

  // --- Caso C: deuda PC alta con F1 y F2 completos → lujo sigue bloqueado por deuda ---
  const C = evaluarPlan({
    sueldoMensual: 12000, gastosFijos: 4000, pagoPC: 1500, comidaGasolina: 2000,
    fondoAhorrado: 20000, deudaPCPendiente: 15000, tarjetas: [],
    metasLujo: [{ clave: 'losCabos', nombre: 'Los Cabos', objetivo: 30000, ahorrado: 0, requiere: reglaAW }],
  }, cfg);
  check('C · F1 y F2 listos', C.f1Completo && C.f2Completo);
  const cLujo = C.objetivos.find(o => o.clave === 'losCabos');
  check('C · Los Cabos bloqueado por deuda alta', cLujo.estado === 'bloqueada' && /deuda/i.test(cLujo.razon || ''));

  // --- Caso D: tarjeta con saldo y corte próximo → bloquea TODO ---
  const D = evaluarPlan({
    sueldoMensual: 12000, gastosFijos: 4000, pagoPC: 1500, comidaGasolina: 2000,
    fondoAhorrado: 0, deudaPCPendiente: 5000,
    tarjetas: [{ nombre: 'Rappi', saldo: 2300, diasParaCorte: 3 }],
    metasLujo: [],
  }, cfg);
  check('D · hay tarjeta urgente', D.hayTarjetaUrgente === true);
  check('D · F1 bloqueada por tarjeta', D.objetivos.find(o => o.clave === 'fondoF1').estado === 'bloqueada');
  check('D · asignación de este mes va a tarjetas', D.asignacionMes.clave === 'tarjetas');

  console.log(`\n🧪 Pruebas del Modo Plan: ${ok}/${total} pasaron.`);
  return ok === total;
}
window.pruebasPlan = pruebasPlan;

/* ============================================================
   DROPDOWNS PERSONALIZADOS (combobox + select)
   Reemplazan los menús nativos del navegador para que combinen con el
   tema y para que el combobox muestre TODAS las opciones aunque ya hayas
   elegido algo. Conservan el <input>/<select> original (el select se
   oculta) para que el envío del formulario no cambie.
   ============================================================ */
let __dropdownOpen = null;
function closeDropdowns(except) {
  document.querySelectorAll('.combo.open, .cselect.open').forEach(w => { if (w !== except) w.classList.remove('open'); });
  if (__dropdownOpen && __dropdownOpen !== except) __dropdownOpen = null;
}
document.addEventListener('click', (e) => { if (!e.target.closest('.combo, .cselect')) closeDropdowns(); });

// Inicializa (idempotente) todos los menús dentro de `root`.
function initDropdowns(root) {
  if (!root) return;
  root.querySelectorAll('input[list]').forEach(enhanceCombo);
  root.querySelectorAll('select').forEach(enhanceSelect);
  root.querySelectorAll('select[data-csel-ready]').forEach(s => { if (s._cselSync) s._cselSync(); });
}

// Coloca el panel arriba o abajo según el espacio dentro del contenedor que recorta,
// y ajusta su alto máximo para que nunca se corte.
function placePanel(wrap, anchor) {
  const panel = wrap.querySelector('.combo-panel');
  const r = anchor.getBoundingClientRect();
  const sc = anchor.closest('.modal-body, .filter-panel');
  const top = sc ? sc.getBoundingClientRect().top : 0;
  const bottom = sc ? sc.getBoundingClientRect().bottom : window.innerHeight;
  const below = bottom - r.bottom, above = r.top - top;
  const up = below < 220 && above > below;
  wrap.classList.toggle('up', up);
  if (panel) panel.style.maxHeight = Math.max(120, (up ? above : below) - 14) + 'px';
}

const COMBO_MULTI = new Set(['dlTags']); // listas que aceptan varios valores separados por comas

// Convierte un <input list="dl…"> en un combobox con el tema de la app.
function enhanceCombo(input) {
  if (input.dataset.comboReady) return;
  const listId = input.getAttribute('list');
  if (!listId) return;
  input.removeAttribute('list');                 // mata el popup nativo del navegador
  input.dataset.comboReady = '1';
  input.setAttribute('autocomplete', 'off');
  const multi = COMBO_MULTI.has(listId);

  const wrap = document.createElement('div');
  wrap.className = 'combo';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const panel = document.createElement('div');
  panel.className = 'combo-panel';
  wrap.appendChild(panel);

  const options = () => { const dl = document.getElementById(listId); return dl ? [...dl.options].map(o => o.value).filter(Boolean) : []; };
  const curToken = () => (multi ? input.value.split(',').pop() : input.value).trim();
  let active = -1;

  // useFilter=false al ABRIR (muestra TODAS las opciones aunque ya haya un valor);
  // useFilter=true mientras se ESCRIBE (filtra por lo tecleado). Así no hay que borrar.
  function render(useFilter) {
    const tok = curToken().toLowerCase();
    let opts = options();
    if (multi) {
      const chosen = new Set(input.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
      opts = opts.filter(o => !chosen.has(o.toLowerCase()));
    }
    const list = (useFilter && tok) ? opts.filter(o => o.toLowerCase().includes(tok)) : opts;
    active = -1;
    panel.innerHTML = list.length
      ? list.map(o => `<div class="combo-opt" data-val="${esc(o)}">${esc(o)}</div>`).join('')
      : `<div class="combo-empty">Sin opciones${multi ? ' nuevas' : ''}</div>`;
  }
  function open() { render(false); closeDropdowns(wrap); wrap.classList.add('open'); placePanel(wrap, input); __dropdownOpen = wrap; }
  function close() { wrap.classList.remove('open'); if (__dropdownOpen === wrap) __dropdownOpen = null; }
  function pick(val) {
    if (multi) {
      const parts = input.value.split(',');
      parts[parts.length - 1] = ' ' + val;
      input.value = parts.join(',').replace(/^\s*,?\s*/, '') + ', ';
    } else {
      input.value = val;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function highlight(items) { items.forEach((it, i) => it.classList.toggle('active', i === active)); if (items[active]) items[active].scrollIntoView({ block: 'nearest' }); }

  input.addEventListener('focus', open);
  input.addEventListener('click', (e) => { e.stopPropagation(); open(); });
  input.addEventListener('input', () => {
    if (!wrap.classList.contains('open')) { closeDropdowns(wrap); wrap.classList.add('open'); __dropdownOpen = wrap; }
    render(true); placePanel(wrap, input);
  });
  input.addEventListener('keydown', (e) => {
    const items = [...panel.querySelectorAll('.combo-opt')];
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!wrap.classList.contains('open')) return open(); active = Math.min(active + 1, items.length - 1); highlight(items); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(items); }
    else if (e.key === 'Enter') { if (wrap.classList.contains('open') && items[active]) { e.preventDefault(); pick(items[active].dataset.val); multi ? (render(false), placePanel(wrap, input)) : close(); } }
    else if (e.key === 'Escape') { if (wrap.classList.contains('open')) { e.stopPropagation(); close(); } }
  });
  panel.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.combo-opt'); if (!opt) return;
    e.preventDefault();                             // no perder el foco antes de procesar el clic
    pick(opt.dataset.val);
    if (multi) { render(false); placePanel(wrap, input); input.focus(); } else close();
  });
}

// Convierte un <select> en un desplegable con el tema de la app (oculta el select real).
function enhanceSelect(select) {
  if (select.dataset.cselReady) return;
  select.dataset.cselReady = '1';
  const wrap = document.createElement('div');
  wrap.className = 'cselect';
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cselect-btn';
  const panel = document.createElement('div');
  panel.className = 'combo-panel';
  wrap.appendChild(btn);
  wrap.appendChild(panel);

  const chevron = `<svg class="cselect-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>`;
  const sync = () => { const o = select.options[select.selectedIndex]; btn.innerHTML = `<span class="cselect-label">${esc(o ? o.text : '')}</span>${chevron}`; };
  select._cselSync = sync;
  const render = () => { panel.innerHTML = [...select.options].map((o, i) => `<div class="combo-opt ${i === select.selectedIndex ? 'sel' : ''}" data-i="${i}">${esc(o.text)}</div>`).join(''); };
  function open() { render(); closeDropdowns(wrap); wrap.classList.add('open'); placePanel(wrap, btn); __dropdownOpen = wrap; }
  function close() { wrap.classList.remove('open'); if (__dropdownOpen === wrap) __dropdownOpen = null; }

  btn.addEventListener('click', (e) => { e.stopPropagation(); wrap.classList.contains('open') ? close() : open(); });
  panel.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.combo-opt'); if (!opt) return;
    e.preventDefault();
    select.selectedIndex = +opt.dataset.i;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    sync(); close();
  });
  select.addEventListener('change', sync);
  sync();
}

/* ============================================================
   INICIO
   ============================================================ */
function seedIfEmpty() {
  if (state.transactions.length || state.goals.length || state.debts.length) return;
  const now = new Date();
  const iso = (offset) => { const d = new Date(now); d.setDate(d.getDate()-offset); return d.toISOString().slice(0,10); };
  state.accounts = [
    { id: 'acc-efectivo', name: 'Efectivo', kind: 'debito' },
    { id: 'acc-bbva', name: 'BBVA Débito', kind: 'debito' },
    { id: 'acc-rappi', name: 'Rappi', kind: 'credito', limit: 15000, cutDay: 2, dueDay: 20, opening: 0 },
  ];
  state.transactions = [
    { id: uid(), date: iso(1), type:'Ingreso', description:'Salario quincenal', amount:9000, account:'BBVA Débito', category:'Salario', notes:'' },
    { id: uid(), date: iso(2), type:'Gasto', description:'Compra en Oxxo', amount:85, account:'BBVA Débito', category:'Comida', notes:'Snacks' },
    { id: uid(), date: iso(3), type:'Gasto', description:'Súper de la semana', amount:1240, account:'Rappi', category:'Supermercado', notes:'' },
    { id: uid(), date: iso(5), type:'Gasto', description:'Gasolina', amount:700, account:'BBVA Debito', category:'Transporte', notes:'' },
    { id: uid(), date: iso(8), type:'Gasto', description:'Netflix', amount:219, account:'Rappi', category:'Suscripciones', notes:'' },
    { id: uid(), date: iso(35), type:'Ingreso', description:'Salario quincenal', amount:9000, account:'BBVA Debito', category:'Salario', notes:'' },
    { id: uid(), date: iso(40), type:'Gasto', description:'Cena restaurante', amount:560, account:'Rappi', category:'Entretenimiento', notes:'' },
  ];
  state.goals = [
    { id: uid(), name:'Apple Watch', target:8500, saved:3200, targetDate: new Date(now.getFullYear(), now.getMonth()+4, 1).toISOString().slice(0,10), note:'Series 10' },
  ];
  state.debts = [
    { id: uid(), name:'Tarjeta Nu', dtype:'Tarjeta de credito', total:6500, paid:2000, monthly:1000, dueDate: new Date(now.getFullYear(), now.getMonth(), 28).toISOString().slice(0,10) },
    { id: uid(), name:'Spotify', dtype:'Suscripcion', total:115, paid:0, monthly:115, dueDate:'' },
  ];
  save();
}

/* ============================================================
   AUTH & INIT
   ============================================================ */
async function initApp() {
  const { data: { session } } = await _sb.auth.getSession();
  if (!session) return;

  const { data } = await _sb.from('user_data')
    .select('state')
    .eq('user_id', session.user.id)
    .single();

  if (data?.state && Object.keys(data.state).length > 0) {
    state = migrate(data.state);
  }

  document.getElementById('loginScreen').style.display = 'none';
  seedIfEmpty();
  snapshotCurrentMonth();
  refreshDatalists();
  navigate('dashboard');
}

_sb.auth.onAuthStateChange((event, session) => {
  if (session) {
    initApp();
  } else {
    document.getElementById('loginScreen').style.display = 'flex';
  }
});

/* ---- Login screen ---- */
(function () {
  let isRegister = false;
  const form = document.getElementById('loginForm');
  const toggleBtn = document.getElementById('toggleAuthMode');
  const loginBtn = document.getElementById('loginBtn');
  const subtitle = document.getElementById('loginSubtitle');
  const errorBox = document.getElementById('loginError');

  function showError(msg, isSuccess) {
    errorBox.style.background = isSuccess ? '#14532d' : '#7f1d1d';
    errorBox.style.color = isSuccess ? '#86efac' : '#fca5a5';
    errorBox.textContent = msg;
    errorBox.style.display = 'block';
  }

  toggleBtn.addEventListener('click', () => {
    isRegister = !isRegister;
    loginBtn.textContent = isRegister ? 'Crear cuenta' : 'Iniciar sesion';
    toggleBtn.textContent = isRegister ? 'Ya tienes cuenta? Inicia sesion' : 'No tienes cuenta? Registrate';
    subtitle.textContent = isRegister ? 'Crea tu cuenta' : 'Inicia sesion para continuar';
    errorBox.style.display = 'none';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.style.display = 'none';
    loginBtn.disabled = true;
    loginBtn.textContent = '...';

    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;

    let result;
    if (isRegister) {
      result = await _sb.auth.signUp({ email, password });
    } else {
      result = await _sb.auth.signInWithPassword({ email, password });
    }

    if (result.error) {
      showError(result.error.message);
      loginBtn.disabled = false;
      loginBtn.textContent = isRegister ? 'Crear cuenta' : 'Iniciar sesion';
    } else if (isRegister && !result.data.session) {
      showError('Revisa tu correo para confirmar tu cuenta.', true);
      loginBtn.disabled = false;
      loginBtn.textContent = 'Crear cuenta';
    }
  });

  document.getElementById('btnLogout')?.addEventListener('click', async () => {
    await _sb.auth.signOut();
    location.reload();
  });

  // Campana de notificaciones
  const btnNotif = document.getElementById('btnNotif');
  const notifPanel = document.getElementById('notifPanel');
  if (btnNotif && notifPanel) {
    btnNotif.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !notifPanel.classList.contains('hidden');
      if (isOpen) { notifPanel.classList.add('hidden'); return; }
      const items = notifPanel._items || [];
      notifPanel.innerHTML = items.length
        ? items.map(a => '<div class="notif-item' + (a.danger ? ' danger' : '') + '">' + a.html + '</div>').join('')
        : '<div class="notif-empty">Sin alertas activas</div>';
      notifPanel.classList.remove('hidden');
    });
    document.addEventListener('click', () => notifPanel.classList.add('hidden'));
  }
})();
