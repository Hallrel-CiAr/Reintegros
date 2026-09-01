'use strict';

/* ============================================================
   Datos fijos: rutas, empresas conocidas
   ============================================================ */
const AIR_ROUTES = [
  { code: 'NQN-CABA', label: 'Neuquén → CABA' },
  { code: 'BRC-CABA', label: 'Bariloche → CABA' },
  { code: 'VDM-CABA', label: 'Viedma → CABA' }
];
const BUS_ROUTES = [
  { code: 'NQN-CABA', label: 'Neuquén → CABA' },
  { code: 'BRC-CABA', label: 'Bariloche → CABA' },
  { code: 'VDM-CABA', label: 'Viedma → CABA' },
  { code: 'ROC-CABA', label: 'General Roca → CABA' }
];
// Un solo valor de referencia por ruta y medio: aéreo = tarifa más económica
// encontrada; terrestre = promedio de los servicios disponibles ese día.
const AIR_COMPANIES = ['Aerolíneas Argentinas', 'JetSmart', 'Flybondi'];
const BUS_COMPANIES = ['Chevallier', 'Andesmar', 'Condor Estrella', 'Via Bariloche'];
const OTRA_VALUE = '__otra__';

const FIREBASE_READY = !!(typeof firebaseConfig !== 'undefined' && firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith('YOUR_'));

/* ============================================================
   Estado en memoria
   ============================================================ */
let DB = { records: [] };
let currentUser = null;      // { email, displayName }
let editorsEmails = [];      // lista de emails autorizados a editar (además del owner)
let canEdit = false;
let isOwner = false;
let authReady = false;

/* ============================================================
   Utilidades de fecha / formato
   ============================================================ */
function todayStr() {
  const d = new Date();
  const tz = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return tz.toISOString().slice(0, 10);
}
function addDaysStr(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}
function fmtARS(n) {
  if (n === null || n === undefined || n === '') return '—';
  return '$ ' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: 0 });
}
function fmtDateLong(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-AR');
}
function routesFor(medio) { return medio === 'aereo' ? AIR_ROUTES : BUS_ROUTES; }
function companiesFor(medio) { return medio === 'aereo' ? AIR_COMPANIES : BUS_COMPANIES; }
function routeLabel(medio, code) {
  const r = routesFor(medio).find(r => r.code === code);
  return r ? r.label : code;
}
function medioLabel(medio) { return medio === 'aereo' ? 'Aéreo' : 'Terrestre'; }
function recordValid(rec) { return !!(rec && rec.empresa && rec.valor != null && rec.valor !== ''); }
function recordId(fecha, medio, ruta) { return [fecha, medio, ruta].join('|'); }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }

function findRecord(fecha, medio, ruta) {
  const id = recordId(fecha, medio, ruta);
  return DB.records.find(r => r.id === id);
}
function allRoutesForDate(fecha) {
  const out = [];
  for (const r of AIR_ROUTES) out.push({ medio: 'aereo', ruta: r.code });
  for (const r of BUS_ROUTES) out.push({ medio: 'terrestre', ruta: r.code });
  return out.map(x => ({ ...x, fecha }));
}
function pendingRoutesForDate(fecha) {
  return allRoutesForDate(fecha).filter(s => !recordValid(findRecord(s.fecha, s.medio, s.ruta)));
}
function recordsInRange(desde, hasta, medio, ruta) {
  let rows = DB.records.filter(recordValid);
  if (desde) rows = rows.filter(r => r.fecha >= desde);
  if (hasta) rows = rows.filter(r => r.fecha <= hasta);
  if (medio) rows = rows.filter(r => r.medio === medio);
  if (ruta) rows = rows.filter(r => r.ruta === ruta);
  return rows.slice().sort((a, b) => a.fecha.localeCompare(b.fecha));
}

/* ============================================================
   Historial de cambios: construcción de entradas
   ============================================================ */
function diffSummary(before, after) {
  if (!before) return 'Cargado: ' + after.empresa + ' — ' + fmtARS(after.valor);
  const parts = [];
  if (String(before.empresa || '') !== String(after.empresa || '')) parts.push('empresa: "' + (before.empresa || '—') + '" → "' + (after.empresa || '—') + '"');
  if (String(before.valor ?? '') !== String(after.valor ?? '')) parts.push('valor: "' + fmtARS(before.valor) + '" → "' + fmtARS(after.valor) + '"');
  if (String(before.tipo || '') !== String(after.tipo || '')) parts.push('estado: "' + (before.tipo || '—') + '" → "' + (after.tipo || '—') + '"');
  const fb = (before.fuente && before.fuente.texto) || '';
  const fa = (after.fuente && after.fuente.texto) || '';
  if (fb !== fa) parts.push('fuente: "' + (fb || '—') + '" → "' + (fa || '—') + '"');
  return parts.length ? parts.join('; ') : 'Reguardado sin cambios de valor';
}
function buildHistoryEntry({ id, before, after, accion, user }) {
  const now = new Date();
  const tsIso = now.toISOString();
  return {
    recordId: id, fecha: after.fecha, medio: after.medio, ruta: after.ruta,
    accion, cambios: diffSummary(before, after),
    userEmail: user.email, userName: user.displayName || user.email,
    ts: tsIso, tsDate: tsIso.slice(0, 10)
  };
}
function accionLabel(a) {
  return a === 'crear' ? 'Carga inicial' : a === 'editar' ? 'Corrección manual' : a === 'importar_csv' ? 'Importación CSV' : a || '—';
}

/* ============================================================
   Backend: modo demo (localStorage) vs modo real (Firebase)
   ============================================================ */
const LS_KEYS = {
  records: 'sosunc_demo_records',
  historial: 'sosunc_demo_historial',
  editors: 'sosunc_demo_editors',
  user: 'sosunc_demo_user'
};
function lsGet(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } }
function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* almacenamiento no disponible */ } }

const DemoBackend = {
  mode: 'demo',
  _cb: null,
  init(cb) {
    this._cb = cb;
    cb.onAuthChange(lsGet(LS_KEYS.user, null));
    cb.onRecordsChange(lsGet(LS_KEYS.records, []));
    cb.onEditorsChange(lsGet(LS_KEYS.editors, []));
  },
  async signInDemo(email, name) {
    const user = { email: String(email).trim().toLowerCase(), displayName: (name && name.trim()) || String(email).split('@')[0] };
    lsSet(LS_KEYS.user, user);
    this._cb.onAuthChange(user);
    return user;
  },
  async signIn() { throw Object.assign(new Error('modo demo'), { code: 'demo_no_google' }); },
  async signOut() { localStorage.removeItem(LS_KEYS.user); this._cb.onAuthChange(null); },
  async saveRecord(id, rec, historyEntry) {
    const records = lsGet(LS_KEYS.records, []);
    const idx = records.findIndex(r => r.id === id);
    if (idx >= 0) records[idx] = { ...rec, id }; else records.push({ ...rec, id });
    lsSet(LS_KEYS.records, records);
    const hist = lsGet(LS_KEYS.historial, []);
    hist.unshift({ ...historyEntry, id: 'h' + Date.now() + Math.random().toString(36).slice(2) });
    lsSet(LS_KEYS.historial, hist);
    this._cb.onRecordsChange(records);
  },
  async importRows(items) {
    const records = lsGet(LS_KEYS.records, []);
    const hist = lsGet(LS_KEYS.historial, []);
    let created = 0, updated = 0;
    for (const { id, rec, historyEntry, isNew } of items) {
      const idx = records.findIndex(r => r.id === id);
      if (idx >= 0) records[idx] = { ...rec, id }; else records.push({ ...rec, id });
      hist.unshift({ ...historyEntry, id: 'h' + Date.now() + Math.random().toString(36).slice(2) + created + updated });
      if (isNew) created++; else updated++;
    }
    lsSet(LS_KEYS.records, records);
    lsSet(LS_KEYS.historial, hist);
    this._cb.onRecordsChange(records);
    return { created, updated };
  },
  async fetchHistory(desde, hasta) {
    const hist = lsGet(LS_KEYS.historial, []);
    return hist
      .filter(h => (!desde || h.tsDate >= desde) && (!hasta || h.tsDate <= hasta))
      .sort((a, b) => b.ts.localeCompare(a.ts));
  },
  async addEditor(email) {
    const list = lsGet(LS_KEYS.editors, []);
    if (!list.includes(email)) list.push(email);
    lsSet(LS_KEYS.editors, list);
    this._cb.onEditorsChange(list);
  },
  async removeEditor(email) {
    const list = lsGet(LS_KEYS.editors, []).filter(e => e !== email);
    lsSet(LS_KEYS.editors, list);
    this._cb.onEditorsChange(list);
  }
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = () => resolve(); s.onerror = () => reject(new Error('No se pudo cargar ' + src));
    document.head.appendChild(s);
  });
}

const RealBackend = {
  mode: 'real',
  _cb: null, _db: null, _auth: null, _unsubRecords: null, _unsubEditors: null,
  async init(cb) {
    this._cb = cb;
    await loadScript('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
    await loadScript('https://www.gstatic.com/firebasejs/10.13.2/firebase-auth-compat.js');
    await loadScript('https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore-compat.js');
    firebase.initializeApp(firebaseConfig);
    this._auth = firebase.auth();
    this._db = firebase.firestore();
    this._auth.onAuthStateChanged(user => {
      if (this._unsubRecords) { this._unsubRecords(); this._unsubRecords = null; }
      if (this._unsubEditors) { this._unsubEditors(); this._unsubEditors = null; }
      if (!user) { cb.onAuthChange(null); cb.onRecordsChange([]); cb.onEditorsChange([]); return; }
      cb.onAuthChange({ email: user.email, displayName: user.displayName || user.email });
      this._unsubRecords = this._db.collection('records').onSnapshot(
        snap => cb.onRecordsChange(snap.docs.map(d => ({ ...d.data(), id: d.id }))),
        err => cb.onError && cb.onError(err)
      );
      this._unsubEditors = this._db.collection('config').doc('editors').onSnapshot(
        doc => cb.onEditorsChange((doc.exists && doc.data().emails) || []),
        err => cb.onError && cb.onError(err)
      );
    });
  },
  async signIn() {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await this._auth.signInWithPopup(provider);
  },
  async signOut() { await this._auth.signOut(); },
  async saveRecord(id, rec, historyEntry) {
    await this._db.collection('records').doc(id).set(rec);
    await this._db.collection('historial').add(historyEntry);
  },
  async importRows(items) {
    let created = 0, updated = 0;
    for (let i = 0; i < items.length; i += 200) {
      const chunk = items.slice(i, i + 200);
      const batch = this._db.batch();
      for (const { id, rec, historyEntry, isNew } of chunk) {
        batch.set(this._db.collection('records').doc(id), rec);
        batch.set(this._db.collection('historial').doc(), historyEntry);
        if (isNew) created++; else updated++;
      }
      await batch.commit();
    }
    return { created, updated };
  },
  async fetchHistory(desde, hasta) {
    let q = this._db.collection('historial').orderBy('tsDate', 'desc').limit(500);
    if (desde) q = q.where('tsDate', '>=', desde);
    if (hasta) q = q.where('tsDate', '<=', hasta);
    const snap = await q.get();
    return snap.docs.map(d => ({ ...d.data(), id: d.id }));
  },
  async addEditor(email) {
    const ref = this._db.collection('config').doc('editors');
    await this._db.runTransaction(async tx => {
      const doc = await tx.get(ref);
      const emails = (doc.exists && doc.data().emails) || [];
      if (!emails.includes(email)) emails.push(email);
      tx.set(ref, { emails });
    });
  },
  async removeEditor(email) {
    const ref = this._db.collection('config').doc('editors');
    await this._db.runTransaction(async tx => {
      const doc = await tx.get(ref);
      const emails = ((doc.exists && doc.data().emails) || []).filter(e => e !== email);
      tx.set(ref, { emails });
    });
  }
};

const Backend = FIREBASE_READY ? RealBackend : DemoBackend;

/* ============================================================
   UI: toast / modal
   ============================================================ */
function toast(msg) {
  if (!msg) return;
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), 3200);
}
function showModal({ title, bodyHtml, confirmText, cancelText, onConfirm }) {
  const root = document.getElementById('modalRoot');
  root.innerHTML = '<div class="modal-backdrop" id="modalBackdrop"><div class="modal">' +
    '<h3>' + escapeHtml(title) + '</h3>' + bodyHtml +
    '<div class="actions">' +
    '<button class="btn secondary small" id="modalCancel" type="button">' + escapeHtml(cancelText || 'Cancelar') + '</button>' +
    '<button class="btn small" id="modalConfirm" type="button">' + escapeHtml(confirmText || 'Confirmar') + '</button>' +
    '</div></div></div>';
  const close = () => { root.innerHTML = ''; };
  document.getElementById('modalCancel').addEventListener('click', close);
  document.getElementById('modalBackdrop').addEventListener('click', e => { if (e.target.id === 'modalBackdrop') close(); });
  document.getElementById('modalConfirm').addEventListener('click', async () => { close(); await onConfirm(); });
}

/* ============================================================
   Render: selects genéricos
   ============================================================ */
function populateSelect(sel, routes, withAll) {
  sel.innerHTML = '';
  if (withAll) {
    const o = document.createElement('option'); o.value = ''; o.textContent = 'Todas'; sel.appendChild(o);
  }
  for (const r of routes) {
    const o = document.createElement('option'); o.value = r.code; o.textContent = r.label; sel.appendChild(o);
  }
}
function badgeHtml(tipo) {
  const map = { automatico: 'Automático', estimado: 'Estimado', manual: 'Manual', pendiente: 'Pendiente' };
  const t = tipo || 'pendiente';
  return '<span class="badge ' + t + '">' + (map[t] || t) + '</span>';
}

/* ============================================================
   Render: Consulta
   ============================================================ */
function renderConsulta() {
  const fecha = document.getElementById('qFecha').value;
  const rutaSel = document.getElementById('qRuta');
  const ruta = rutaSel.value;
  const wrap = document.getElementById('resultGroups');
  wrap.innerHTML = '';

  if (!DB.records.length) {
    wrap.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><h3>Todavía no hay datos cargados</h3><p>El relevamiento diario y la carga manual todavía no registraron valores.</p></div>';
    return;
  }

  function groupHtml(medio, label, swatchClass) {
    const routes = routesFor(medio);
    const targetRoutes = ruta ? routes.filter(r => r.code === ruta) : routes;
    let html = '<div><div class="group-label"><span class="swatch ' + swatchClass + '"></span>' + label + '</div><div class="fare-list">';
    for (const r of targetRoutes) {
      const rec = findRecord(fecha, medio, r.code);
      if (recordValid(rec)) {
        html += '<div class="fare-card"><div class="who2"><span class="empresa">' + escapeHtml(rec.empresa) + '</span>' +
          '<span class="fuente" title="' + escapeHtml((rec.fuente && rec.fuente.texto) || '') + '">' + escapeHtml(r.label) + (rec.fuente && rec.fuente.texto ? ' · ' + rec.fuente.texto : '') + '</span>' +
          '<button type="button" class="histbtn" data-hist-record="' + escapeAttr(rec.id) + '">Ver historial</button></div>' +
          '<div class="right"><span class="valor num">' + fmtARS(rec.valor) + '</span>' + badgeHtml(rec.tipo) + '</div></div>';
      } else {
        html += '<div class="empty-slot"><span>' + escapeHtml(r.label) + ': sin dato</span></div>';
      }
    }
    if (!targetRoutes.length) html += '<div class="empty-slot"><span>Sin rutas para mostrar.</span></div>';
    html += '</div></div>';
    return html;
  }

  wrap.innerHTML = groupHtml('aereo', 'Aéreo', 'air') + groupHtml('terrestre', 'Terrestre', 'bus');
  wrap.querySelectorAll('[data-hist-record]').forEach(btn => {
    btn.addEventListener('click', () => openRecordHistory(btn.dataset.histRecord));
  });
}

async function openRecordHistory(id) {
  const [fecha, medio, ruta] = id.split('|');
  const rows = await Backend.fetchHistory(null, null);
  const own = rows.filter(r => r.recordId === id).sort((a, b) => b.ts.localeCompare(a.ts));
  const body = own.length
    ? '<div class="table-wrap"><table><thead><tr><th>Cuándo</th><th>Quién</th><th>Acción</th><th>Qué cambió</th></tr></thead><tbody>' +
      own.map(h => '<tr><td>' + fmtDateTime(h.ts) + '</td><td>' + escapeHtml(h.userName) + '</td><td>' + accionLabel(h.accion) + '</td><td>' + escapeHtml(h.cambios) + '</td></tr>').join('') +
      '</tbody></table></div>'
    : '<p class="hint">Sin historial registrado para este valor todavía.</p>';
  showModal({
    title: routeLabel(medio, ruta) + ' · ' + medioLabel(medio) + ' · ' + fmtDateLong(fecha),
    bodyHtml: body,
    confirmText: 'Cerrar', cancelText: '',
    onConfirm: async () => {}
  });
  document.getElementById('modalCancel').style.display = 'none';
}

/* ============================================================
   Render: estado del día / alertas
   ============================================================ */
let notifiedToday = false;
function renderStatus() {
  const fecha = todayStr();
  const rutas = allRoutesForDate(fecha);
  const pendientes = rutas.filter(s => !recordValid(findRecord(s.fecha, s.medio, s.ruta)));

  const banner = document.getElementById('pendingBanner');
  if (pendientes.length === 0) {
    banner.innerHTML = '';
    document.title = 'Pasajes de Referencia SOSUNC';
  } else {
    const notifBtn = ('Notification' in window && Notification.permission === 'default')
      ? '<button class="btn small secondary" id="btnNotif" type="button">Avisarme en este navegador</button>' : '';
    banner.innerHTML = '<div class="day-banner crit"><span>Faltan <strong>' + pendientes.length + '</strong> de ' + rutas.length + ' valores de hoy para cerrar el día.</span>' +
      '<span style="display:flex; gap:8px;"><button class="btn small" id="gotoPending" type="button">Cargar hoy</button>' + notifBtn + '</span></div>';
    document.title = '⚠ Faltan ' + pendientes.length + ' · Pasajes SOSUNC';
    const btnNotif = document.getElementById('btnNotif');
    if (btnNotif) btnNotif.addEventListener('click', async () => {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') { toast('Avisos activados en este navegador.'); new Notification('Pasajes SOSUNC', { body: 'Vas a recibir un aviso acá si quedan valores del día sin cargar.' }); }
    });
    maybeNotify(pendientes.length);
  }

  const done = rutas.length - pendientes.length;
  const countPill = document.getElementById('countPill');
  countPill.hidden = false;
  countPill.textContent = done + '/' + rutas.length + ' de hoy cargados';
}
function maybeNotify(n) {
  if (notifiedToday) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const hour = new Date().getHours();
  if (hour < 15) return;
  notifiedToday = true;
  try { new Notification('Pasajes SOSUNC', { body: 'Todavía faltan ' + n + ' valores de hoy por cargar.' }); } catch { /* ignorado */ }
}

/* ============================================================
   Render: tabla de carga manual
   ============================================================ */
function empresaSelectHtml(medio, empresaActual) {
  const known = companiesFor(medio);
  const isKnown = empresaActual && known.includes(empresaActual);
  const isOtra = empresaActual && !isKnown;
  let html = '<select class="cell-input empresa-select">';
  html += '<option value=""' + (!empresaActual ? ' selected' : '') + ' disabled>Elegí…</option>';
  for (const c of known) html += '<option value="' + escapeAttr(c) + '"' + (empresaActual === c ? ' selected' : '') + '>' + escapeHtml(c) + '</option>';
  html += '<option value="' + OTRA_VALUE + '"' + (isOtra ? ' selected' : '') + '>Otra…</option>';
  html += '</select>';
  html += '<input class="cell-input empresa-otra" type="text" placeholder="Nombre de la empresa o &quot;Promedio&quot;" value="' + (isOtra ? escapeAttr(empresaActual) : '') + '" style="display:' + (isOtra ? 'block' : 'none') + ';" />';
  return html;
}
function manualRowHtml(fecha, medio, ruta) {
  const rec = findRecord(fecha, medio, ruta) || { empresa: '', valor: '', fuente: { texto: '', url: '' }, tipo: '' };
  const tipoDefault = rec.tipo || 'manual';
  const rid = recordId(fecha, medio, ruta);
  return '<tr data-rid="' + rid + '">' +
    '<td>' + medioLabel(medio) + '</td>' +
    '<td>' + escapeHtml(routeLabel(medio, ruta)) + '</td>' +
    '<td>' + empresaSelectHtml(medio, rec.empresa) + '</td>' +
    '<td><input class="cell-input num-input valor-input" type="number" min="0" step="1" value="' + escapeAttr(rec.valor === '' || rec.valor == null ? '' : rec.valor) + '" placeholder="0" /></td>' +
    '<td><input class="cell-input fuente-input" type="text" value="' + escapeAttr((rec.fuente && rec.fuente.texto) || '') + '" placeholder="Sitio o fuente" /></td>' +
    '<td><select class="cell-input tipo-input">' +
    ['automatico', 'estimado', 'manual'].map(t => '<option value="' + t + '"' + (tipoDefault === t ? ' selected' : '') + '>' + (t === 'automatico' ? 'Automático' : t === 'estimado' ? 'Estimado' : 'Manual') + '</option>').join('') +
    '</select></td>' +
    '<td><button type="button" class="btn small row-save" data-action="save-row">Guardar</button></td>' +
    '</tr>';
}
function renderManualTable() {
  const fecha = document.getElementById('mFecha').value || todayStr();
  const tbody = document.getElementById('manualTbody');
  let html = '';
  for (const r of AIR_ROUTES) html += manualRowHtml(fecha, 'aereo', r.code);
  for (const r of BUS_ROUTES) html += manualRowHtml(fecha, 'terrestre', r.code);
  tbody.innerHTML = html;
  tbody.querySelectorAll('tr').forEach(tr => {
    const rec = findRecord(...tr.dataset.rid.split('|'));
    if (!recordValid(rec)) tr.classList.add('pending-row');
  });
  applyEditLock();
}
function wireManualTable() {
  const tbody = document.getElementById('manualTbody');
  tbody.addEventListener('input', e => { const tr = e.target.closest('tr'); if (tr) tr.classList.add('dirty'); });
  tbody.addEventListener('change', e => {
    const tr = e.target.closest('tr'); if (tr) tr.classList.add('dirty');
    if (!e.target.classList.contains('empresa-select')) return;
    const otra = tr.querySelector('.empresa-otra');
    if (e.target.value === OTRA_VALUE) { otra.style.display = 'block'; otra.focus(); } else { otra.style.display = 'none'; otra.value = ''; }
  });
  tbody.addEventListener('click', async e => {
    if (e.target.dataset.action !== 'save-row') return;
    if (!canEdit) { toast('No tenés permisos de edición.'); return; }
    const tr = e.target.closest('tr');
    const [fecha, medio, ruta] = tr.dataset.rid.split('|');
    const empresaSel = tr.querySelector('.empresa-select').value;
    const empresa = empresaSel === OTRA_VALUE ? tr.querySelector('.empresa-otra').value.trim() : empresaSel;
    const valorRaw = tr.querySelector('.valor-input').value;
    const fuenteTexto = tr.querySelector('.fuente-input').value.trim();
    const tipo = tr.querySelector('.tipo-input').value;
    if (!empresa || valorRaw === '') { toast('Elegí la empresa y completá el valor antes de guardar.'); return; }
    const id = recordId(fecha, medio, ruta);
    const before = findRecord(fecha, medio, ruta) || null;
    const after = {
      fecha, medio, ruta, empresa, valor: Number(valorRaw),
      fuente: { texto: fuenteTexto, url: /^https?:\/\//.test(fuenteTexto) ? fuenteTexto : null },
      tipo, updatedAt: new Date().toISOString(), updatedBy: currentUser.email, updatedByName: currentUser.displayName
    };
    const historyEntry = buildHistoryEntry({ id, before, after, accion: before ? 'editar' : 'crear', user: currentUser });
    try {
      await Backend.saveRecord(id, after, historyEntry);
      tr.classList.remove('dirty');
      toast('Valor guardado.');
    } catch (err) {
      toast('No se pudo guardar: ' + (err && err.message ? err.message : 'error'));
    }
  });
}

/* ============================================================
   Historial + exportación (registros)
   ============================================================ */
function renderHistorial() {
  const desde = document.getElementById('hDesde').value;
  const hasta = document.getElementById('hHasta').value;
  const medio = document.getElementById('hMedio').value;
  const ruta = document.getElementById('hRuta').value;
  const rows = recordsInRange(desde, hasta, medio, ruta);
  document.getElementById('hCount').textContent = rows.length + ' registro' + (rows.length === 1 ? '' : 's') + ' en el rango seleccionado.';
}

/* ============================================================
   CSV: helpers, export, import
   ============================================================ */
function csvEscape(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function downloadCsvRows(filename, headerArr, dataRows2D) {
  const lines = [headerArr.map(csvEscape).join(',')];
  for (const row of dataRows2D) lines.push(row.map(csvEscape).join(','));
  const csv = '﻿' + lines.join('\r\n');
  downloadBlob(filename, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
}
function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Archivo descargado: ' + filename);
}
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = []; let field = ''; let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignorado */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
}

async function exportCsv() {
  const desde = document.getElementById('hDesde').value;
  const hasta = document.getElementById('hHasta').value;
  const medio = document.getElementById('hMedio').value;
  const ruta = document.getElementById('hRuta').value;
  const rows = recordsInRange(desde, hasta, medio, ruta);
  if (!rows.length) { toast('No hay registros para exportar en ese rango.'); return; }
  const header = ['Fecha', 'Medio', 'Ruta', 'Empresa', 'Valor ARS por pasajero', 'Fuente', 'URL fuente', 'Estado'];
  const data = rows.map(r => [r.fecha, medioLabel(r.medio), routeLabel(r.medio, r.ruta), r.empresa, r.valor, (r.fuente && r.fuente.texto) || '', (r.fuente && r.fuente.url) || '', r.tipo || '']);
  downloadCsvRows('pasajes_sosunc_' + desde + '_a_' + hasta + '.csv', header, data);
}
async function generarCompletitud() {
  const desde = document.getElementById('rcDesde').value;
  const hasta = document.getElementById('rcHasta').value;
  if (!desde || !hasta) { toast('Elegí un rango de fechas.'); return; }
  if (desde > hasta) { toast('El rango de fechas no es válido.'); return; }
  const missing = []; let cursor = desde; let guard = 0;
  while (cursor <= hasta && guard < 400) {
    for (const s of allRoutesForDate(cursor)) if (!recordValid(findRecord(s.fecha, s.medio, s.ruta))) missing.push(s);
    cursor = addDaysStr(cursor, 1); guard++;
  }
  if (!missing.length) { toast('Sin pendientes: todos los días del rango están completos.'); return; }
  const header = ['Fecha', 'Medio', 'Ruta', 'Estado'];
  const data = missing.map(s => [s.fecha, medioLabel(s.medio), routeLabel(s.medio, s.ruta), 'Pendiente']);
  downloadCsvRows('completitud_sosunc_' + desde + '_a_' + hasta + '.csv', header, data);
}

const MEDIO_FROM_LABEL = { 'Aéreo': 'aereo', 'Terrestre': 'terrestre' };
const TIPO_FROM_LABEL = { 'Automático': 'automatico', 'Estimado': 'estimado', 'Manual': 'manual' };
let pendingImportItems = null;
function parseImportFile(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { items: [], errors: ['El archivo está vacío.'] };
  const body = rows.slice(1); // se asume la primera fila como encabezado
  const items = []; const errors = [];
  body.forEach((cols, i) => {
    const lineNo = i + 2;
    const [fechaRaw, medioLbl, rutaLbl, empresa, valorRaw] = cols;
    const fuenteTexto = cols[5] || ''; const fuenteUrl = cols[6] || ''; const estadoLbl = cols[7] || '';
    if (!fechaRaw || !/^\d{4}-\d{2}-\d{2}$/.test(fechaRaw.trim())) { errors.push('Fila ' + lineNo + ': fecha inválida ("' + fechaRaw + '").'); return; }
    const medio = MEDIO_FROM_LABEL[(medioLbl || '').trim()];
    if (!medio) { errors.push('Fila ' + lineNo + ': medio desconocido ("' + medioLbl + '").'); return; }
    const route = routesFor(medio).find(r => r.label === (rutaLbl || '').trim());
    if (!route) { errors.push('Fila ' + lineNo + ': ruta desconocida ("' + rutaLbl + '") para ' + medioLbl + '.'); return; }
    if (!empresa || !empresa.trim()) { errors.push('Fila ' + lineNo + ': falta la empresa.'); return; }
    const valor = Number(String(valorRaw).replace(',', '.'));
    if (!Number.isFinite(valor) || valor < 0) { errors.push('Fila ' + lineNo + ': valor inválido ("' + valorRaw + '").'); return; }
    const tipo = TIPO_FROM_LABEL[(estadoLbl || '').trim()] || 'manual';
    const fecha = fechaRaw.trim();
    const id = recordId(fecha, medio, route.code);
    const before = findRecord(fecha, medio, route.code) || null;
    const after = {
      fecha, medio, ruta: route.code, empresa: empresa.trim(),
      valor, fuente: { texto: fuenteTexto.trim(), url: fuenteUrl.trim() || null }, tipo,
      updatedAt: new Date().toISOString(), updatedBy: currentUser.email, updatedByName: currentUser.displayName
    };
    const historyEntry = buildHistoryEntry({ id, before, after, accion: 'importar_csv', user: currentUser });
    items.push({ id, rec: after, historyEntry, isNew: !before });
  });
  return { items, errors };
}
function wireImport() {
  const fileInput = document.getElementById('importFile');
  const btn = document.getElementById('btnImport');
  const status = document.getElementById('importStatus');
  fileInput.addEventListener('change', () => { btn.disabled = !fileInput.files.length || !canEdit; status.textContent = ''; });
  btn.addEventListener('click', async () => {
    if (!canEdit) { toast('No tenés permisos de edición.'); return; }
    const file = fileInput.files[0];
    if (!file) return;
    const text = await file.text();
    const { items, errors } = parseImportFile(text);
    const nuevos = items.filter(i => i.isNew).length;
    const reemplazos = items.length - nuevos;
    pendingImportItems = items;
    const errHtml = errors.length ? '<p class="hint">' + errors.length + ' fila(s) con problemas, se van a omitir:</p><ul class="hint" style="margin:0 0 8px 18px; max-height:120px; overflow:auto;">' + errors.slice(0, 12).map(e => '<li>' + escapeHtml(e) + '</li>').join('') + (errors.length > 12 ? '<li>… y ' + (errors.length - 12) + ' más.</li>' : '') + '</ul>' : '';
    if (!items.length) { status.textContent = 'Nada para importar: ' + errors.length + ' fila(s) inválida(s).'; return; }
    showModal({
      title: 'Confirmar importación',
      bodyHtml: '<p>Se van a cargar <strong>' + nuevos + '</strong> valor(es) nuevo(s) y <strong>reemplazar ' + reemplazos + '</strong> valor(es) ya existentes.</p>' + errHtml,
      confirmText: 'Importar', cancelText: 'Cancelar',
      onConfirm: async () => {
        try {
          const res = await Backend.importRows(pendingImportItems);
          status.textContent = 'Importación completa: ' + res.created + ' nuevo(s), ' + res.updated + ' actualizado(s).';
          toast('CSV importado.');
          fileInput.value = ''; btn.disabled = true;
        } catch (err) {
          toast('No se pudo importar: ' + (err && err.message ? err.message : 'error'));
        }
      }
    });
  });
}

/* ============================================================
   Auditoría (historial de cambios global)
   ============================================================ */
async function renderAudit() {
  const desde = document.getElementById('auDesde').value;
  const hasta = document.getElementById('auHasta').value;
  const tbody = document.getElementById('auditTbody');
  tbody.innerHTML = '<tr><td colspan="6" class="hint" style="padding:14px 8px;">Cargando…</td></tr>';
  const rows = await Backend.fetchHistory(desde || null, hasta || null);
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="6" class="hint" style="padding:14px 8px;">Sin cambios registrados en ese rango.</td></tr>'; return; }
  tbody.innerHTML = rows.map(h => '<tr>' +
    '<td>' + fmtDateTime(h.ts) + '</td>' +
    '<td>' + escapeHtml(h.userName || h.userEmail) + '</td>' +
    '<td>' + accionLabel(h.accion) + '</td>' +
    '<td>' + escapeHtml(fmtDateLong(h.fecha)) + '</td>' +
    '<td>' + escapeHtml(medioLabel(h.medio)) + ' · ' + escapeHtml(routeLabel(h.medio, h.ruta)) + '</td>' +
    '<td>' + escapeHtml(h.cambios || '') + '</td>' +
    '</tr>').join('');
  renderAudit._last = rows;
}
async function exportAudit() {
  const desde = document.getElementById('auDesde').value;
  const hasta = document.getElementById('auHasta').value;
  const rows = renderAudit._last || await Backend.fetchHistory(desde || null, hasta || null);
  if (!rows.length) { toast('No hay cambios para exportar en ese rango.'); return; }
  const header = ['Cuándo', 'Quién', 'Acción', 'Fecha de viaje', 'Medio', 'Ruta', 'Qué cambió'];
  const data = rows.map(h => [fmtDateTime(h.ts), h.userName || h.userEmail, accionLabel(h.accion), h.fecha, medioLabel(h.medio), routeLabel(h.medio, h.ruta), h.cambios || '']);
  downloadCsvRows('historial_cambios_sosunc_' + (desde || 'inicio') + '_a_' + (hasta || 'hoy') + '.csv', header, data);
}

/* ============================================================
   Comprobante PDF
   ============================================================ */
async function generarComprobante() {
  const fecha = document.getElementById('cFecha').value;
  const medio = document.getElementById('cMedio').value;
  const ruta = document.getElementById('cRuta').value;
  if (!fecha || !ruta) { toast('Elegí fecha y ruta para el comprobante.'); return; }
  const rec = findRecord(fecha, medio, ruta);
  if (!recordValid(rec)) { toast('No hay valor cargado para esa fecha y ruta. Cargalo en la carga manual antes de generar el comprobante.'); return; }
  const emitido = new Date().toLocaleString('es-AR');
  const tipoMap = { automatico: 'Automático', estimado: 'Estimado', manual: 'Manual' };
  const org = 'SOSUNC · Reintegros (Dirección Social)';
  const lineas = [
    ['Fecha de viaje', fmtDateLong(fecha)], ['Medio', medioLabel(medio)], ['Ruta', routeLabel(medio, ruta)],
    ['Empresa', rec.empresa], ['Valor por pasajero (ARS)', fmtARS(rec.valor)],
    ['Fuente', ((rec.fuente && rec.fuente.texto) || '—') + ((rec.fuente && rec.fuente.url) ? ' — ' + rec.fuente.url : '')],
    ['Estado del dato', tipoMap[rec.tipo] || rec.tipo || '—']
  ];
  const foot = 'Este comprobante documenta el valor de referencia relevado por Reintegros (Dirección Social) de SOSUNC para el cálculo de reintegros por derivación, correspondiente a la fecha de viaje indicada. Emitido el ' + emitido + '.';
  const filenameBase = 'comprobante_sosunc_' + fecha + '_' + medio + '_' + ruta;

  if (window.jspdf && window.jspdf.jsPDF) {
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      let y = 56;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(92, 109, 100);
      doc.text(org, 48, y); y += 26;
      doc.setFontSize(16); doc.setTextColor(27, 36, 32);
      doc.text('Constancia de valor de referencia para reintegro', 48, y); y += 30;
      doc.setFontSize(11);
      for (const [k, v] of lineas) {
        doc.setTextColor(92, 109, 100); doc.text(String(k) + ':', 48, y);
        doc.setTextColor(27, 36, 32);
        const vLines = doc.splitTextToSize(String(v), 380);
        doc.text(vLines, 220, y);
        y += 18 * Math.max(1, vLines.length);
      }
      y += 18;
      doc.setFontSize(9); doc.setTextColor(140, 150, 145);
      doc.text(doc.splitTextToSize(foot, 500), 48, y);
      downloadBlob(filenameBase + '.pdf', doc.output('blob'));
      return;
    } catch { /* cae al texto plano abajo */ }
  }
  toast('No se pudo generar el PDF: se descarga como texto.');
  const texto = org + '\nConstancia de valor de referencia para reintegro\n\n' + lineas.map(([k, v]) => k + ': ' + v).join('\n') + '\n\n' + foot + '\n';
  downloadBlob(filenameBase + '.txt', new Blob([texto], { type: 'text/plain;charset=utf-8' }));
}

/* ============================================================
   Accesos: quién puede editar
   ============================================================ */
function updateEditPill() {
  const dot = document.querySelector('#editPill .dot');
  const txt = document.getElementById('editPillText');
  if (!authReady) { txt.textContent = 'Cargando…'; dot.style.background = 'var(--ink-faint)'; return; }
  if (canEdit) { txt.textContent = 'Podés editar y guardar'; dot.style.background = 'var(--good)'; }
  else { txt.textContent = 'Solo lectura'; dot.style.background = 'var(--crit)'; }
}
function applyEditLock() {
  document.querySelectorAll('#manualTbody button, #manualTbody input, #manualTbody select').forEach(el => { el.disabled = !canEdit; });
  const importBtn = document.getElementById('btnImport');
  const importFile = document.getElementById('importFile');
  if (importBtn) importBtn.disabled = !canEdit || !importFile.files.length;
  if (importFile) importFile.disabled = !canEdit;
}
function renderAuthBox() {
  const mainNav = document.getElementById('mainNav');
  const box = document.getElementById('navUserInfo');
  if (!currentUser) { mainNav.hidden = true; box.innerHTML = ''; return; }
  mainNav.hidden = false;
  const initials = (currentUser.displayName || currentUser.email).slice(0, 1).toUpperCase();
  box.innerHTML = '<span class="avatar">' + escapeHtml(initials) + '</span>' +
    '<span class="who"><span class="name">' + escapeHtml(currentUser.displayName || currentUser.email) + '</span>' +
    '<span class="role">' + (isOwner ? 'Administrador' : canEdit ? 'Puede editar' : 'Solo lectura') + '</span></span>';
}

/* ============================================================
   Navegación por menú (una vista visible a la vez)
   ============================================================ */
let activeView = 'consulta';
function closeAllMenus() {
  document.querySelectorAll('.navitem.open').forEach(el => el.classList.remove('open'));
}
function showView(view) {
  if (view === 'accesos' && !isOwner) view = 'consulta';
  document.querySelectorAll('.view-panel').forEach(p => { p.hidden = p.dataset.view !== view; });
  activeView = view;
  closeAllMenus();
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (view === 'historial-auditoria') renderAudit();
}
function wireNav() {
  document.querySelectorAll('.navitem').forEach(item => {
    const btn = item.querySelector('.navbtn');
    btn.addEventListener('click', e => {
      if (btn.dataset.view) { showView(btn.dataset.view); return; }
      e.stopPropagation();
      const wasOpen = item.classList.contains('open');
      closeAllMenus();
      if (!wasOpen) item.classList.add('open');
    });
  });
  document.querySelectorAll('.dropdown-item[data-view]').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));
  document.addEventListener('click', () => closeAllMenus());
  document.querySelector('[data-action="sign-out"]').addEventListener('click', () => Backend.signOut());
  document.querySelector('[data-action="switch-user"]').addEventListener('click', async () => {
    await Backend.signOut();
    try { await Backend.signIn(); } catch { /* la persona puede iniciar sesión desde la pantalla de acceso */ }
  });
  document.getElementById('brandHome').addEventListener('click', () => showView('consulta'));
  document.getElementById('brandHome').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showView('consulta'); } });
}
function renderEditorList() {
  const wrap = document.getElementById('editorList');
  if (!editorsEmails.length) { wrap.innerHTML = '<p class="hint">Todavía no agregaste a nadie más. Por ahora solo vos podés editar.</p>'; return; }
  wrap.innerHTML = editorsEmails.map(email => '<div class="editor-row"><span>' + escapeHtml(email) + '</span><button class="btn small danger" data-remove-editor="' + escapeAttr(email) + '" type="button">Quitar</button></div>').join('');
  wrap.querySelectorAll('[data-remove-editor]').forEach(btn => btn.addEventListener('click', async () => {
    await Backend.removeEditor(btn.dataset.removeEditor);
    toast('Acceso quitado.');
  }));
}
function wireAdminPanel() {
  document.getElementById('btnAddEditor').addEventListener('click', async () => {
    const input = document.getElementById('newEditorEmail');
    const email = input.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('Ingresá un email válido.'); return; }
    await Backend.addEditor(email);
    input.value = '';
    toast('Acceso agregado.');
  });
}

/* ============================================================
   Autenticación (real / demo)
   ============================================================ */
function renderDemoSignInBox() {
  const box = document.getElementById('demoSignInBox');
  box.hidden = false;
  box.innerHTML =
    '<button class="btn secondary" id="demoOwner" type="button">Entrar como ' + escapeHtml(OWNER_EMAIL) + ' (dueño, demo)</button>' +
    '<div class="field-row" style="margin-top:6px;">' +
    '<div class="field" style="flex:1;"><label for="demoEmail">Probar con otro Gmail (demo)</label><input type="email" id="demoEmail" placeholder="persona@gmail.com" /></div>' +
    '<button class="btn small secondary" id="demoOther" type="button">Entrar</button>' +
    '</div>';
  document.getElementById('demoOwner').addEventListener('click', () => DemoBackend.signInDemo(OWNER_EMAIL, 'Matías (demo)'));
  document.getElementById('demoOther').addEventListener('click', () => {
    const email = document.getElementById('demoEmail').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('Ingresá un email válido.'); return; }
    DemoBackend.signInDemo(email, '');
  });
}

function onAuthChange(user) {
  currentUser = user;
  authReady = true;
  const gate = document.getElementById('gate');
  const appBody = document.getElementById('appBody');
  if (!user) {
    gate.hidden = false; appBody.hidden = true;
    updateEditPill(); renderAuthBox();
    return;
  }
  gate.hidden = true; appBody.hidden = false;
  isOwner = user.email === OWNER_EMAIL;
  canEdit = isOwner || editorsEmails.includes(user.email);
  document.getElementById('navAccesosItem').hidden = !isOwner;
  if (!isOwner && activeView === 'accesos') showView('consulta');
  renderAuthBox(); updateEditPill(); applyEditLock();
  if (isOwner) renderEditorList();
}
function onRecordsChange(records) {
  DB.records = records;
  document.getElementById('footUpdated').textContent = records.length
    ? fmtDateTime(records.map(r => r.updatedAt).filter(Boolean).sort().slice(-1)[0])
    : 'todavía sin cargar';
  renderConsulta(); renderStatus(); renderManualTable(); renderHistorial();
}
function onEditorsChange(emails) {
  editorsEmails = emails || [];
  if (currentUser) { canEdit = isOwner || editorsEmails.includes(currentUser.email); }
  updateEditPill(); applyEditLock();
  if (isOwner) renderEditorList();
}

/* ============================================================
   Init
   ============================================================ */
function init() {
  document.getElementById('demoBanner').hidden = FIREBASE_READY;

  const today = todayStr();
  const qFecha = document.getElementById('qFecha'); qFecha.value = today; qFecha.max = today;
  const allRoutes = [...new Map([...AIR_ROUTES, ...BUS_ROUTES].map(r => [r.code, r])).values()];
  populateSelect(document.getElementById('qRuta'), allRoutes, true);
  document.getElementById('mFecha').value = today; document.getElementById('mFecha').max = today;
  document.getElementById('hHasta').value = today;
  const d30 = new Date(); d30.setDate(d30.getDate() - 30);
  document.getElementById('hDesde').value = d30.toISOString().slice(0, 10);
  populateSelect(document.getElementById('hRuta'), allRoutes, true);
  document.getElementById('auHasta').value = today;
  document.getElementById('auDesde').value = d30.toISOString().slice(0, 10);

  document.getElementById('cFecha').value = today; document.getElementById('cFecha').max = today;
  populateSelect(document.getElementById('cRuta'), routesFor('aereo'), false);
  document.getElementById('rcDesde').value = d30.toISOString().slice(0, 10);
  document.getElementById('rcHasta').value = today;

  document.getElementById('qFecha').addEventListener('change', renderConsulta);
  document.getElementById('qRuta').addEventListener('change', renderConsulta);
  document.getElementById('mFecha').addEventListener('change', renderManualTable);
  document.getElementById('hDesde').addEventListener('change', renderHistorial);
  document.getElementById('hHasta').addEventListener('change', renderHistorial);
  document.getElementById('hMedio').addEventListener('change', renderHistorial);
  document.getElementById('hRuta').addEventListener('change', renderHistorial);
  document.getElementById('hExport').addEventListener('click', exportCsv);
  document.getElementById('auRefresh').addEventListener('click', renderAudit);
  document.getElementById('auExport').addEventListener('click', exportAudit);
  document.getElementById('cMedio').addEventListener('change', () => {
    const m = document.getElementById('cMedio').value;
    populateSelect(document.getElementById('cRuta'), routesFor(m), false);
  });
  document.getElementById('btnComprobante').addEventListener('click', generarComprobante);
  document.getElementById('btnCompletitud').addEventListener('click', generarCompletitud);
  document.getElementById('pendingBanner').addEventListener('click', e => {
    if (e.target.id !== 'gotoPending') return;
    document.getElementById('mFecha').value = todayStr();
    showView('carga-manual');
    renderManualTable();
    const firstPending = document.querySelector('#manualTbody tr.pending-row .empresa-select');
    if (firstPending) firstPending.focus();
  });
  wireManualTable();
  wireImport();
  wireAdminPanel();
  wireNav();

  document.getElementById('btnSignIn').addEventListener('click', async () => {
    try { await Backend.signIn(); } catch (err) { toast('No se pudo iniciar sesión: ' + (err && err.message ? err.message : 'error')); }
  });
  if (!FIREBASE_READY) renderDemoSignInBox();

  Backend.init({ onAuthChange, onRecordsChange, onEditorsChange, onError: err => toast('Error: ' + (err && err.message ? err.message : 'desconocido')) });
}

document.addEventListener('DOMContentLoaded', init);
