'use strict';
/*
 * Búsqueda diaria automática de valores de referencia de pasajes (SOSUNC).
 *
 * Las rutas YA NO son una lista fija en este archivo: se leen de la
 * colección "rutas" de Firestore (cada una configurada a mano desde la
 * página, con origen/destino/modo). Una ruta solo se procesa a partir del
 * día SIGUIENTE a que se creó (ruta.createdDate).
 *
 * Por cada modo:
 *   - "aereo": Aerolíneas Argentinas (aerolineas.com.ar) — tarifa turista
 *     más económica encontrada.
 *   - "terrestre": Central de Pasajes (centraldepasajes.com.ar) — valor del
 *     asiento cama/cama ejecutivo (promedio si hay varios); si esa clase no
 *     aparece en los resultados, se usa el mayor valor encontrado entre
 *     todos los servicios listados.
 *   - "vehiculo": Ruta0 (ruta0.com) — costo estimado de combustible
 *     (10 litros de nafta súper cada 100km, mismo criterio que se usa como
 *     referencia manual) para la distancia de la ruta.
 *
 * Reintentos: cada corrida es UN intento (la Action corre a las 5hs ART y
 * 4 veces más cada 30 min = 5 intentos por día, ver el cron del workflow).
 * Si al 5º intento del día sigue sin poder confirmar un valor, el registro
 * queda con agotado:true — recién ahí la página habilita la carga manual
 * para esa fecha/ruta puntual (antes de eso no se ofrece esa opción).
 * Nunca pisa un valor ya cargado (automático o manual): si el registro de
 * esa fecha/ruta ya tiene empresa y valor, se lo salta.
 *
 * Corre como GitHub Action (ver .github/workflows/actualizacion-diaria.yml),
 * NO dentro de Claude, porque el entorno de Claude no tiene salida a estos
 * sitios. Ninguno de los 3 sitios se pudo probar en vivo desde ahí — si
 * algo de sus selectores no encuentra nada, revisá el log de la Action
 * (queda diagnóstico completo volcado en cada corrida) y las capturas
 * "diag_*" del artifact de debug. El scraper de "vehiculo" (Ruta0) es el
 * más nuevo de los tres y el que más probablemente necesite un ajuste con
 * datos de una corrida real, como pasó antes con Aerolíneas y Central de
 * Pasajes.
 *
 * Variables de entorno requeridas: FIREBASE_API_KEY, FIREBASE_PROJECT_ID,
 * ROBOT_EMAIL, ROBOT_PASSWORD.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DEBUG_DIR = 'debug';
fs.mkdirSync(DEBUG_DIR, { recursive: true });
async function capturarDebug(page, nombre) {
  try { await page.screenshot({ path: path.join(DEBUG_DIR, nombre + '.png'), fullPage: true }); } catch { /* no bloquea el proceso principal */ }
}
async function cerrarBannerCookies(page) {
  const textos = [/aceptar/i, /entendido/i, /de acuerdo/i, /accept/i];
  for (const t of textos) {
    try {
      const btn = page.getByRole('button', { name: t }).first();
      if (await btn.isVisible({ timeout: 1500 })) { await btn.click({ timeout: 1500 }); return; }
    } catch { /* no había banner con ese texto */ }
  }
}

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const ROBOT_EMAIL = process.env.ROBOT_EMAIL;
const ROBOT_PASSWORD = process.env.ROBOT_PASSWORD;

if (!FIREBASE_API_KEY || !FIREBASE_PROJECT_ID || !ROBOT_EMAIL || !ROBOT_PASSWORD) {
  console.error('Faltan variables de entorno (FIREBASE_API_KEY, FIREBASE_PROJECT_ID, ROBOT_EMAIL, ROBOT_PASSWORD).');
  process.exit(1);
}

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const MAX_INTENTOS = 5;

function todayStr() { return new Date().toISOString().slice(0, 10); }
function recordId(fecha, medio, ruta) { return [fecha, medio, ruta].join('|'); }
function recordValid(rec) { return !!(rec && rec.empresa && rec.valor !== null && rec.valor !== undefined && rec.valor !== ''); }

/* ---------- Firestore REST (autenticado con la cuenta robot) ---------- */

async function signIn() {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ROBOT_EMAIL, password: ROBOT_PASSWORD, returnSecureToken: true })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('No se pudo iniciar sesión en Firebase: ' + JSON.stringify(data));
  return data.idToken;
}

function fsValueToJs(v) {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.mapValue) return fsMapToJs(v.mapValue);
  return null;
}
function fsMapToJs(mapValue) {
  const out = {};
  const fields = (mapValue && mapValue.fields) || {};
  for (const k of Object.keys(fields)) out[k] = fsValueToJs(fields[k]);
  return out;
}
function jsToFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'object') return { mapValue: { fields: jsToFsFields(v) } };
  throw new Error('Tipo no soportado: ' + typeof v);
}
function jsToFsFields(obj) {
  const fields = {};
  for (const k of Object.keys(obj)) fields[k] = jsToFsValue(obj[k]);
  return fields;
}

async function getRecord(idToken, id) {
  const res = await fetch(`${FIRESTORE_BASE}/records/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${idToken}` }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return fsMapToJs(await res.json());
}

async function writeRecord(idToken, id, rec) {
  const res = await fetch(`${FIRESTORE_BASE}/records/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: jsToFsFields(rec) })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + await res.text());
}

async function writeHistoryEntry(idToken, entry) {
  const res = await fetch(`${FIRESTORE_BASE}/historial`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: jsToFsFields(entry) })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + await res.text());
}

async function obtenerRutas(idToken) {
  const res = await fetch(`${FIRESTORE_BASE}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'rutas' }] } })
  });
  if (!res.ok) { console.log('No se pudieron leer las rutas configuradas: HTTP ' + res.status); return []; }
  const rows = await res.json();
  return (rows || [])
    .filter(r => r.document)
    .map(r => ({ id: r.document.name.split('/').pop(), ...fsMapToJs(r.document) }));
}

async function obtenerSolicitudesPendientes(idToken) {
  const res = await fetch(`${FIRESTORE_BASE}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'solicitudes' }],
        where: { fieldFilter: { field: { fieldPath: 'estado' }, op: 'EQUAL', value: { stringValue: 'pendiente' } } }
      }
    })
  });
  if (!res.ok) { console.log('No se pudieron leer las solicitudes pendientes: HTTP ' + res.status); return []; }
  const rows = await res.json();
  return (rows || []).filter(r => r.document).map(r => ({ name: r.document.name, ...fsMapToJs(r.document) }));
}
async function marcarSolicitudResuelta(idToken, docName) {
  const path = docName.split('/documents/')[1];
  await fetch(`${FIRESTORE_BASE}/${path}?updateMask.fieldPaths=estado&updateMask.fieldPaths=resueltoEn`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: jsToFsFields({ estado: 'resuelto', resueltoEn: new Date().toISOString() }) })
  }).catch(() => {});
}

/* ---------- Búsqueda de tarifas ---------- */

async function volcarDiagnostico(page, etiqueta) {
  try {
    const inputs = await page.locator('input:visible').evaluateAll(els =>
      els.slice(0, 25).map(e => ({ placeholder: e.placeholder || null, aria: e.getAttribute('aria-label'), name: e.name || null, type: e.type }))
    );
    console.log(`  [diagnóstico ${etiqueta}] inputs visibles: ` + JSON.stringify(inputs));
    const botones = await page.locator('button:visible, [role="button"]:visible').evaluateAll(els =>
      els.slice(0, 30).map(e => (e.innerText || e.getAttribute('aria-label') || '').trim()).filter(Boolean)
    );
    console.log(`  [diagnóstico ${etiqueta}] botones visibles: ` + JSON.stringify(botones));
  } catch (err) {
    console.log(`  [diagnóstico ${etiqueta}] no se pudo levantar: ` + err.message);
  }
}

async function ubicarCampoTexto(page, patrones, etiqueta) {
  for (const p of patrones) {
    for (const loc of [page.getByPlaceholder(p), page.getByLabel(p), page.getByRole('textbox', { name: p })]) {
      try {
        if (await loc.first().isVisible({ timeout: 800 })) {
          console.log(`  Campo ${etiqueta} encontrado con patrón ${p}.`);
          return loc.first();
        }
      } catch { /* patrón siguiente */ }
    }
  }
  console.log(`  No se encontró el campo ${etiqueta} con ninguno de los patrones probados.`);
  return null;
}

// Selecciona una sugerencia de un desplegable de autocompletado de ciudad —
// se reutiliza para Aerolíneas Argentinas y Central de Pasajes, que arman
// este tipo de desplegable de forma parecida. Prefiere la opción cuyo texto
// contiene lo buscado (por si aparecen resultados mezclados) y, si no
// aparece ninguna sugerencia visible, cae a navegar con el teclado.
async function seleccionarSugerencia(page, input, texto, etiqueta, opciones_ = {}) {
  const clickTarget = opciones_.clickTarget || input;
  const campoTexto = opciones_.searchField || input;
  let clicEntroNormal = true;
  await clickTarget.click({ timeout: 5000 }).catch(() => { clicEntroNormal = false; return clickTarget.click({ force: true }); });
  if (opciones_.searchField) {
    let abiertos = await page.locator('.select2-container--open').count().catch(() => -1);
    let camposEnDom = await page.locator('.select2-search__field').count().catch(() => -1);
    if (abiertos === 0) {
      console.log(`  [select2 — ${etiqueta}] el desplegable no abrió con el primer clic; se reintenta.`);
      await page.waitForTimeout(500);
      await clickTarget.click({ force: true }).catch(() => {});
      abiertos = await page.locator('.select2-container--open').count().catch(() => -1);
      camposEnDom = await page.locator('.select2-search__field').count().catch(() => -1);
    }
    console.log(`  [diagnóstico select2 — ${etiqueta}] clic normal entró: ${clicEntroNormal}; contenedores select2 abiertos: ${abiertos}; campos de búsqueda en el DOM (visibles o no): ${camposEnDom}`);
    await capturarDebug(page, `select2_${etiqueta.replace(/[^a-z0-9]+/gi, '-')}`);
  }
  await campoTexto.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
  await campoTexto.fill(texto);
  const opciones = page.locator(
    '[role="option"], .MuiAutocomplete-option, .select2-results__option, li[class*="suggest" i], li[class*="option" i], li[class*="autocomplete" i], ul[class*="suggest" i] li, ul[class*="autocomplete" i] li'
  );
  let seleccionado = false;
  try {
    await opciones.first().waitFor({ state: 'visible', timeout: 6000 });
    const total = await opciones.count();
    let candidata = opciones.first();
    for (let i = 0; i < total; i++) {
      const t = (await opciones.nth(i).innerText().catch(() => '')).toLowerCase();
      if (t.includes(texto.toLowerCase())) { candidata = opciones.nth(i); break; }
    }
    await candidata.click({ timeout: 3000 });
    seleccionado = true;
  } catch {
    console.log(`  No aparecieron sugerencias en pantalla para "${texto}" (${etiqueta}); se intenta con el teclado.`);
  }
  if (!seleccionado) {
    await page.waitForTimeout(600);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(400);
  const valorFinal = await input.inputValue().catch(() => '');
  if (!valorFinal.trim()) {
    console.log(`  Atención: el campo ${etiqueta} quedó vacío después de intentar seleccionar "${texto}".`);
  }
  return seleccionado || !!valorFinal.trim();
}

async function buscarAereo(page, origen, destino, codigo, fechaISO) {
  const [y, m, d] = fechaISO.split('-');
  const url = 'https://www.aerolineas.com.ar/';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await cerrarBannerCookies(page);
  await page.waitForTimeout(2500);
  console.log('  Página cargada: "' + (await page.title().catch(() => '?')) + '"');
  await volcarDiagnostico(page, 'home');
  await capturarDebug(page, `diag_aereo_${codigo}_home`);

  try {
    // El buscador arranca en "Ida y vuelta" — el radio para pasar a solo ida
    // dice simplemente "Ida" (visto en una captura real).
    const soloIda = page.getByText('Ida', { exact: true }).first();
    if (await soloIda.count().catch(() => 0)) {
      await soloIda.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
    } else {
      console.log('  No se encontró el botón "Ida" — puede que ya sea el modo por defecto.');
    }

    const origenInput = await ubicarCampoTexto(page, [/origen/i, /desde/i, /ciudad de origen/i, /salida/i], 'Origen');
    const destinoInput = await ubicarCampoTexto(page, [/destino/i, /hasta/i, /ciudad de destino/i, /llegada/i], 'Destino');
    if (!origenInput || !destinoInput) {
      console.log('  No se pudo ubicar el formulario de búsqueda de Aerolíneas Argentinas.');
      return null;
    }
    await seleccionarSugerencia(page, origenInput, origen, 'Origen', {});
    await seleccionarSugerencia(page, destinoInput, destino, 'Destino', {});

    // El campo de fecha de ida tiene name="from-date" (placeholder "dd/mm/aaaa").
    const fechaInput = page.locator('input[name="from-date"]');
    if (await fechaInput.count().catch(() => 0)) {
      await fechaInput.fill(`${d}/${m}/${y}`).catch(async err => {
        console.log('  No se pudo completar la fecha de Aerolíneas Argentinas: ' + err.message);
      });
      // Escribir la fecha suele abrir un calendario propio que puede tapar el
      // botón "Buscar vuelos" — se cierra con Escape y un clic afuera.
      await page.keyboard.press('Escape').catch(() => {});
      await page.locator('body').click({ position: { x: 5, y: 5 }, timeout: 2000 }).catch(() => {});
    } else {
      console.log('  No se encontró el campo de fecha (name="from-date") — se sigue igual por si ya tiene una fecha válida por defecto.');
    }
    await page.waitForTimeout(500);
    await capturarDebug(page, `diag_aereo_${codigo}_formulario-completo`);

    const urlAntes = page.url();
    const botonBuscar = page.getByRole('button', { name: /buscar/i }).first();
    await botonBuscar.click({ timeout: 5000 }).catch(() => botonBuscar.click({ force: true }));
    await page.waitForTimeout(6000);
    // Si la URL no cambió, el formulario probablemente no se envió — los
    // precios que se leerían ahí serían promocionales, no de la ruta buscada.
    if (page.url() === urlAntes) {
      console.log('  La URL no cambió después de "Buscar vuelos" — probablemente el formulario no se envió. Se descarta cualquier precio de esta página.');
      await capturarDebug(page, `diag_aereo_${codigo}_no-navego`);
      return null;
    }
  } catch (err) {
    console.log('  No se pudo completar el formulario de Aerolíneas Argentinas: ' + err.message);
    await capturarDebug(page, `diag_aereo_${codigo}_error`);
    return null;
  }

  await capturarDebug(page, `diag_aereo_${codigo}_resultados`);
  const sinVuelos = page.getByText(/no (hay|encontramos) vuelos|sin disponibilidad/i).first();
  if (await sinVuelos.isVisible({ timeout: 1000 }).catch(() => false)) {
    console.log('  La página indica que no hay vuelos disponibles para la fecha pedida.');
    return null;
  }
  await volcarDiagnostico(page, 'resultados');
  const bodyText = await page.locator('body').innerText().catch(() => '');
  // El resultado por defecto de Aerolíneas es clase Económica/Turista (no
  // hay selector de clase en el buscador simple), así que la tarifa que se
  // lee acá ya corresponde a "valor turista".
  const matches = [...bodyText.matchAll(/\$\s?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?|ARS\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?/g)];
  const precios = matches
    .map(mm => ({ valor: Number(mm[0].replace(/[^\d]/g, '')), index: mm.index }))
    .filter(p => Number.isFinite(p.valor) && p.valor > 1000);
  if (!precios.length) return null;
  const ordenados = precios.map(p => p.valor).sort((a, b) => a - b);
  console.log('  Precios detectados (primeros 8): ' + ordenados.slice(0, 8).join(', '));
  const min = precios.reduce((a, b) => (b.valor < a.valor ? b : a));
  return { valor: min.valor, empresa: 'Aerolíneas Argentinas (turista)', fuente: { texto: 'Aerolíneas Argentinas', url: page.url() } };
}

async function destildarAlojamiento(page) {
  // El buscador tilda "Quiero buscar alojamiento" por defecto: si queda
  // tildado, "Buscar pasajes" manda a resultados de hoteles en vez de micros.
  try {
    const porRol = page.getByRole('checkbox', { name: /alojamiento/i });
    const n = await porRol.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const chk = porRol.nth(i);
      if (await chk.isChecked().catch(() => false)) {
        await chk.uncheck({ timeout: 2000 }).catch(() => chk.click({ timeout: 2000 }).catch(() => {}));
      }
    }
    if (n === 0) {
      const etiqueta = page.locator('label, span, div').filter({ hasText: /quiero buscar alojamiento/i }).first();
      if (await etiqueta.count().catch(() => 0)) {
        const caja = etiqueta.locator('input[type="checkbox"]').first();
        if (await caja.count().catch(() => 0) && await caja.isChecked().catch(() => false)) {
          await caja.click({ timeout: 2000 }).catch(() => {});
        }
      }
    }
  } catch { /* si no aparece el checkbox en esta versión de la página, no hay nada que destildar */ }
}

async function buscarTerrestre(page, origen, destino, codigo, fechaISO) {
  const [y, m, d] = fechaISO.split('-');
  const url = 'https://www.centraldepasajes.com.ar/';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await cerrarBannerCookies(page);
  await page.waitForTimeout(2000);
  console.log('  Página cargada: "' + (await page.title().catch(() => '?')) + '"');
  await volcarDiagnostico(page, 'home');
  await capturarDebug(page, `diag_terrestre_${codigo}_home`);

  try {
    await destildarAlojamiento(page);

    const origenInput = page.locator('input[name="PadOrigen"]');
    const destinoInput = page.locator('input[name="PadDestino"]');
    if (!(await origenInput.count().catch(() => 0)) || !(await destinoInput.count().catch(() => 0))) {
      console.log('  No se encontró el formulario de búsqueda de Central de Pasajes (cambió el markup).');
      return null;
    }
    const origenVisual = page.locator('#select2-PadOrigen-container');
    const destinoVisual = page.locator('#select2-PadDestino-container');
    if (!(await origenVisual.count().catch(() => 0))) {
      console.log('  No se encontró #select2-PadOrigen-container — volcando el HTML alrededor del input para ajustar en la próxima corrida.');
      const html = await origenInput.evaluate(el => el.closest('div,span')?.outerHTML?.slice(0, 1500) || el.outerHTML).catch(() => null);
      console.log('  [diagnóstico] HTML cerca de PadOrigen: ' + html);
    }
    const campoBusquedaSelect2 = page.locator('.select2-search__field:visible').first();
    const hayOrigenVisual = await origenVisual.count().catch(() => 0);
    const hayDestinoVisual = await destinoVisual.count().catch(() => 0);
    await seleccionarSugerencia(page, origenInput, origen, `Origen ${codigo}`, {
      clickTarget: hayOrigenVisual ? origenVisual : origenInput,
      searchField: hayOrigenVisual ? campoBusquedaSelect2 : undefined
    });
    await seleccionarSugerencia(page, destinoInput, destino, `Destino ${codigo}`, {
      clickTarget: hayDestinoVisual ? destinoVisual : destinoInput,
      searchField: hayDestinoVisual ? campoBusquedaSelect2 : undefined
    });

    const fechaInput = page.locator('input[name="fechaPartida"]');
    if (await fechaInput.count().catch(() => 0)) {
      const diaTexto = String(Number(d));
      const esEditable = await fechaInput.isEditable().catch(() => false);
      let escrita = false;
      if (esEditable) {
        try { await fechaInput.fill(`${d}/${m}/${y}`); escrita = true; } catch { /* se prueba con el calendario */ }
      }
      if (!escrita) {
        await fechaInput.click();
        await page.waitForTimeout(800);
        await page.locator('button', { hasText: new RegExp('^' + diaTexto + '$') }).first().click({ timeout: 5000 }).catch(async () => {
          console.log('  No se pudo clickear el día en el calendario de Central de Pasajes.');
          await volcarDiagnostico(page, 'calendario');
        });
      }
    } else {
      console.log('  No se encontró el campo de fecha (name="fechaPartida") — se sigue igual por si ya tiene una fecha válida por defecto.');
    }
    await page.waitForTimeout(500);
    await capturarDebug(page, `diag_terrestre_${codigo}_formulario-completo`);

    const urlAntes = page.url();
    await page.locator('[name="btnCons"]').first().click({ timeout: 5000 });
    await page.waitForTimeout(6000);
    if (page.url() === urlAntes) {
      console.log('  La URL no cambió después de enviar el formulario de Central de Pasajes — probablemente no se envió. Se descarta esta página.');
      await capturarDebug(page, `diag_terrestre_${codigo}_no-navego`);
      return null;
    }
  } catch (err) {
    console.log('  No se pudo completar el formulario de Central de Pasajes: ' + err.message);
    await capturarDebug(page, `diag_terrestre_${codigo}_error`);
    return null;
  }

  await capturarDebug(page, `diag_terrestre_${codigo}_resultados`);
  const sinServicio = page.getByText(/no (hay|disponemos|encontramos) (servicios|resultados|opciones)|sin disponibilidad/i).first();
  if (await sinServicio.isVisible({ timeout: 1000 }).catch(() => false)) {
    console.log('  La página indica que no hay servicios para la fecha pedida.');
    return null;
  }
  await volcarDiagnostico(page, 'resultados');
  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (!/\$|ARS/.test(bodyText)) {
    console.log('  [diagnóstico] La página navegó pero no se detectó ningún "$"/"ARS" en el texto. Título: "' + (await page.title().catch(() => '?')) + '". Primeros 400 caracteres: ' + bodyText.slice(0, 400).replace(/\s+/g, ' '));
  }

  // Se pide específicamente el valor de asiento CAMA/CAMA EJECUTIVO (no el
  // promedio de todas las clases como antes). Como no se conoce la
  // estructura exacta de cada tarjeta de servicio, se aproxima mirando si
  // la palabra "cama" aparece cerca (antes) de cada precio detectado en el
  // texto de la página — así no depende de un selector CSS puntual que
  // nunca se pudo confirmar en vivo. Si ningún precio queda marcado como
  // "cama", se usa el mayor valor encontrado entre todos los servicios,
  // como pidió el usuario.
  const priceRe = /\$\s?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?|ARS\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?/g;
  const matches = [...bodyText.matchAll(priceRe)];
  const precios = matches
    .map(mm => {
      const valor = Number(mm[0].replace(/[^\d]/g, ''));
      const antes = bodyText.slice(Math.max(0, mm.index - 200), mm.index);
      const esCama = /cama\s*ejecutiv[oa]|\bcama\b/i.test(antes);
      return { valor, esCama };
    })
    .filter(p => Number.isFinite(p.valor) && p.valor > 1000);
  if (!precios.length) return null;
  console.log('  Precios detectados: ' + precios.map(p => p.valor + (p.esCama ? '(cama)' : '')).join(', '));
  const camaPrecios = precios.filter(p => p.esCama).map(p => p.valor);
  if (camaPrecios.length) {
    const promedio = Math.round(camaPrecios.reduce((a, b) => a + b, 0) / camaPrecios.length);
    return {
      valor: promedio,
      empresa: 'Cama/Cama Ejecutivo (Central de Pasajes, promedio de ' + camaPrecios.length + ' servicio' + (camaPrecios.length === 1 ? '' : 's') + ')',
      fuente: { texto: 'Central de Pasajes', url: page.url() }
    };
  }
  const mayor = Math.max(...precios.map(p => p.valor));
  return {
    valor: mayor,
    empresa: 'Mayor valor encontrado (Central de Pasajes, sin clase cama en los resultados)',
    fuente: { texto: 'Central de Pasajes', url: page.url() }
  };
}

// Ruta0 (ruta0.com): sitio de cálculo de distancias y costo de viaje en auto
// — nunca se pudo probar en vivo, así que se vuelca el mismo diagnóstico
// completo que ya sirvió para ajustar Aerolíneas y Central de Pasajes.
// Costo = distancia (km) / 100 × 10 litros × precio del litro de nafta
// súper que muestre la propia página — mismo criterio usado como referencia
// manual (10 L/100km).
const CONSUMO_L_CADA_100KM = 10;
async function buscarVehiculo(page, origen, destino, codigo) {
  const url = 'https://www.ruta0.com/';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(async () => {
    await page.goto('https://ruta0.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  });
  await cerrarBannerCookies(page);
  await page.waitForTimeout(1500);
  console.log('  Página cargada: "' + (await page.title().catch(() => '?')) + '"');
  await volcarDiagnostico(page, 'home');
  await capturarDebug(page, `diag_vehiculo_${codigo}_home`);

  try {
    const origenInput = await ubicarCampoTexto(page, [/origen/i, /desde/i, /punto de partida/i, /salida/i, /ciudad/i], 'Origen');
    const destinoInput = await ubicarCampoTexto(page, [/destino/i, /hasta/i, /punto de llegada/i, /llegada/i], 'Destino');
    if (!origenInput || !destinoInput) {
      console.log('  No se pudo ubicar el formulario de Ruta0.');
      return null;
    }
    await origenInput.click({ timeout: 3000 }).catch(() => {});
    await origenInput.fill(origen);
    await page.waitForTimeout(700);
    await page.keyboard.press('ArrowDown').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await destinoInput.click({ timeout: 3000 }).catch(() => {});
    await destinoInput.fill(destino);
    await page.waitForTimeout(700);
    await page.keyboard.press('ArrowDown').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await capturarDebug(page, `diag_vehiculo_${codigo}_formulario-completo`);

    const urlAntes = page.url();
    const botonCalcular = page.getByRole('button', { name: /calcul|buscar|ver ruta|traz|ir\b/i }).first();
    await botonCalcular.click({ timeout: 5000 }).catch(() => botonCalcular.click({ force: true }).catch(() => {}));
    await page.waitForTimeout(4500);
    if (page.url() === urlAntes) {
      console.log('  La URL no cambió después de calcular en Ruta0 (puede ser normal si es una SPA) — se sigue igual y se revisa el contenido.');
    }
  } catch (err) {
    console.log('  No se pudo completar el formulario de Ruta0: ' + err.message);
    await capturarDebug(page, `diag_vehiculo_${codigo}_error`);
    return null;
  }

  await capturarDebug(page, `diag_vehiculo_${codigo}_resultados`);
  await volcarDiagnostico(page, 'resultados');
  const bodyText = await page.locator('body').innerText().catch(() => '');

  const distMatch = bodyText.match(/(\d{1,4}(?:[.,]\d+)?)\s*km/i);
  const distanciaKm = distMatch ? Number(distMatch[1].replace(',', '.')) : null;
  const precioLitroMatch =
    bodyText.match(/(?:nafta\s*s[uú]per|s[uú]per)[^$]{0,60}\$\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)/i) ||
    bodyText.match(/\$\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)[^.]{0,40}(?:nafta\s*s[uú]per|precio.{0,10}litro)/i);
  const precioLitro = precioLitroMatch ? Number(precioLitroMatch[1].replace(/\./g, '').replace(',', '.')) : null;
  console.log(`  [diagnóstico vehículo] distancia detectada: ${distanciaKm} km; precio por litro detectado: ${precioLitro}`);

  if (distanciaKm && precioLitro) {
    const litros = (distanciaKm / 100) * CONSUMO_L_CADA_100KM;
    const valor = Math.round(litros * precioLitro);
    return {
      valor,
      empresa: 'Cálculo de combustible (Ruta0, ' + distanciaKm + ' km, ' + CONSUMO_L_CADA_100KM + ' L/100km)',
      fuente: { texto: 'Ruta0', url: page.url() }
    };
  }

  // Respaldo: si Ruta0 ya muestra un costo total de combustible calculado
  // por su cuenta, se usa eso (aunque puede no ser exactamente nuestro
  // supuesto de 10 L/100km) antes de darse por vencido.
  const totalMatch = bodyText.match(/combustible[^$]{0,40}\$\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)/i);
  if (totalMatch) {
    const valor = Number(totalMatch[1].replace(/\./g, '').replace(',', '.'));
    if (Number.isFinite(valor) && valor > 100) {
      return { valor, empresa: 'Cálculo de combustible (Ruta0, total mostrado por el sitio)', fuente: { texto: 'Ruta0', url: page.url() } };
    }
  }
  console.log('  No se pudo extraer distancia + precio de nafta (ni un total de combustible) de la página de Ruta0.');
  return null;
}

/* ---------- Orquestación ---------- */

// El "codigo" que enlaza con los registros (records.ruta) es ruta.codigo —
// NO ruta.id (que es el id de DOCUMENTO de Firestore, con el modo agregado
// al final para que dos modos de la misma ruta no choquen ahí). Aéreo y
// terrestre de una misma ruta comparten a propósito el mismo codigo, igual
// que en el sistema viejo de rutas fijas (ej. "NQN-CABA").
function codigoDeRuta(ruta) { return ruta.codigo || ruta.id; }

async function buscarPorModo(page, ruta, fecha) {
  const codigo = codigoDeRuta(ruta);
  if (ruta.modo === 'aereo') return buscarAereo(page, ruta.origen, ruta.destino, codigo, fecha);
  if (ruta.modo === 'terrestre') return buscarTerrestre(page, ruta.origen, ruta.destino, codigo, fecha);
  if (ruta.modo === 'vehiculo') return buscarVehiculo(page, ruta.origen, ruta.destino, codigo);
  console.log('  Modo desconocido: ' + ruta.modo);
  return null;
}

async function procesarFecha(idToken, browser, fecha, rutas) {
  const page = await browser.newPage({
    locale: 'es-AR',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
  });
  for (const ruta of rutas) {
    // La ruta solo entra en juego a partir del día siguiente a que se creó.
    if (ruta.createdDate && fecha <= ruta.createdDate) continue;

    const codigo = codigoDeRuta(ruta);
    const id = recordId(fecha, ruta.modo, codigo);
    console.log(`\n[${fecha}] ${ruta.modo} ${codigo} (${ruta.origen} → ${ruta.destino})`);
    let before = null;
    try { before = await getRecord(idToken, id); } catch (err) { console.log('  Error leyendo Firestore: ' + err.message); continue; }
    if (recordValid(before)) { console.log('  Ya tiene un valor cargado, no se toca.'); continue; }
    if (before && before.agotado) { console.log('  Ya agotó sus ' + MAX_INTENTOS + ' intentos de hoy — queda para carga manual. No se reintenta.'); continue; }

    const intentosPrevios = (before && before.intentos) || 0;

    let resultado = null;
    try {
      resultado = await buscarPorModo(page, ruta, fecha);
    } catch (err) {
      console.log('  Error buscando: ' + err.message);
    }
    await capturarDebug(page, `${fecha}_${ruta.modo}_${codigo}${resultado ? '' : '_SIN-RESULTADO'}`);

    const nowIso = new Date().toISOString();
    if (resultado) {
      const after = {
        fecha, medio: ruta.modo, ruta: codigo, empresa: resultado.empresa, valor: resultado.valor,
        fuente: resultado.fuente, tipo: 'automatico', intentos: intentosPrevios + 1, agotado: false,
        updatedAt: nowIso, updatedBy: ROBOT_EMAIL, updatedByName: 'Proceso automático'
      };
      try {
        await writeRecord(idToken, id, after);
        await writeHistoryEntry(idToken, {
          recordId: id, fecha, medio: ruta.modo, ruta: codigo,
          accion: 'crear', cambios: 'Cargado automáticamente: ' + after.empresa + ' — $' + after.valor,
          userEmail: ROBOT_EMAIL, userName: 'Proceso automático',
          ts: nowIso, tsDate: nowIso.slice(0, 10)
        });
        console.log('  Guardado: ' + after.empresa + ' — $' + after.valor);
      } catch (err) {
        console.log('  Error guardando en Firestore: ' + err.message);
      }
      continue;
    }

    // Sin resultado: cuenta como un intento agotado. Al llegar a
    // MAX_INTENTOS se marca agotado:true (recién ahí la página habilita la
    // carga manual excepcional para esta fecha/ruta) y queda constancia en
    // el historial, como pidió el usuario ("debe quedar reportado").
    const nuevosIntentos = intentosPrevios + 1;
    const agotado = nuevosIntentos >= MAX_INTENTOS;
    const pendiente = {
      fecha, medio: ruta.modo, ruta: codigo, empresa: null, valor: null,
      fuente: null, tipo: 'pendiente', intentos: nuevosIntentos, agotado,
      updatedAt: nowIso, updatedBy: ROBOT_EMAIL, updatedByName: 'Proceso automático'
    };
    try {
      await writeRecord(idToken, id, pendiente);
      if (agotado) {
        await writeHistoryEntry(idToken, {
          recordId: id, fecha, medio: ruta.modo, ruta: codigo,
          accion: 'agotado', cambios: 'Se agotaron los ' + MAX_INTENTOS + ' intentos automáticos del día sin poder confirmar un valor. Queda habilitada la carga manual para esta fecha y ruta.',
          userEmail: ROBOT_EMAIL, userName: 'Proceso automático',
          ts: nowIso, tsDate: nowIso.slice(0, 10)
        });
        console.log('  Se agotaron los ' + MAX_INTENTOS + ' intentos de hoy. Queda pendiente para carga manual.');
      } else {
        console.log('  No se pudo confirmar un valor con la fuente (intento ' + nuevosIntentos + ' de ' + MAX_INTENTOS + '). Se reintenta en la próxima corrida.');
      }
    } catch (err) {
      console.log('  Error guardando el estado de intento en Firestore: ' + err.message);
    }
  }
  await page.close();
}

(async () => {
  console.log('=== Actualización automática de pasajes SOSUNC ===');
  const idToken = await signIn();
  console.log('Sesión iniciada como ' + ROBOT_EMAIL);

  const rutas = await obtenerRutas(idToken);
  console.log(`Rutas configuradas: ${rutas.length}`);
  if (!rutas.length) {
    console.log('No hay ninguna ruta configurada todavía (pantalla "Rutas" de la página) — nada para buscar.');
  }

  const fechas = new Set([todayStr()]);
  const solicitudes = await obtenerSolicitudesPendientes(idToken);
  for (const s of solicitudes) if (s.fecha) fechas.add(s.fecha);
  if (solicitudes.length) console.log(`Hay ${solicitudes.length} solicitud(es) de "forzar actualización" pendiente(s).`);

  const browser = await chromium.launch();
  for (const fecha of fechas) {
    console.log(`\n--- Procesando fecha ${fecha} ---`);
    await procesarFecha(idToken, browser, fecha, rutas);
  }
  await browser.close();

  for (const s of solicitudes) await marcarSolicitudResuelta(idToken, s.name);

  console.log('\n=== Fin de la actualización ===');
})().catch(err => {
  console.error('Error fatal: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
