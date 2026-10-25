/* Insumos PWA — interfaz. La lógica de búsqueda está en core.js */
(function () {
  'use strict';

  // URL de la aplicación web de Apps Script (se puede cambiar desde Ajustes sin tocar el código)
  const API_URL = 'https://script.google.com/macros/s/AKfycbzS4Sj09WqzBiJrUM22bJ0t5VG4H0XvkgEfxwFP8d6gJGgYBHPgOVnejo_ULgTdeHvXaA/exec';

  const LS = { pin: 'ins_pin', url: 'ins_url', data: 'ins_data', ver: 'ins_version', time: 'ins_time', pend: 'ins_pending' };
  const CATEGORIAS = ['Toner', 'Tambor', 'Almohadilla', 'Cabezal', 'Caja de mantenimiento'];
  const KINDS = [
    ['orig', 'es el original de'],
    ['alt', 'es el alternativo de'],
    ['tambor', 'tiene como tambor a'],
    ['esTambor', 'es el tambor de'],
    ['eq', 'equivale a']
  ];

  const $ = function (s, el) { return (el || document).querySelector(s); };
  const $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
  const esc = function (s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* nada */ } }

  const state = {
    data: null, idx: null, syncing: false, seg: 'productos', view: 'buscar',
    logged: new Set(), sheetOpen: false, installEvt: null, lastError: '', logTimer: null, toastTimer: null
  };

  // ------------------------------------------------------------------ mensajes y estado

  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast-msg' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { t.hidden = true; }, isErr ? 5000 : 2600);
  }

  function fmtTime(ms) {
    const d = new Date(Number(ms));
    if (isNaN(d.getTime())) return '';
    const hoy = new Date();
    const hora = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === hoy.toDateString() ? hora : d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) + ' ' + hora;
  }

  function setStatus(text, cls) {
    const el = $('#status');
    el.textContent = text;
    el.className = 'status' + (cls ? ' ' + cls : '');
  }

  function refreshStatus() {
    if (!lsGet(LS.pin)) return setStatus('Falta el PIN', 'warn');
    if (state.syncing) return setStatus('Sincronizando…');
    if (state.lastError) return setStatus(state.lastError, 'err');
    const t = lsGet(LS.time);
    if (!navigator.onLine) return setStatus('Sin conexión' + (t ? ' · datos de ' + fmtTime(t) : ''), 'warn');
    setStatus(t ? 'Actualizado ' + fmtTime(t) : 'Sin datos', t ? '' : 'warn');
  }

  // ------------------------------------------------------------------ API

  async function api(action, payload) {
    const pin = lsGet(LS.pin);
    if (!pin) throw new Error('Falta el PIN (Ajustes)');
    const url = lsGet(LS.url) || API_URL;
    const ctl = new AbortController();
    const to = setTimeout(function () { ctl.abort(); }, 40000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ pin: pin, action: action }, payload || {})),
        signal: ctl.signal,
        redirect: 'follow'
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('El script tardó demasiado en responder');
      if (!navigator.onLine) throw new Error('Sin conexión');
      throw new Error('No se pudo conectar con el script. Revisá la URL y que el acceso sea "Cualquier persona"');
    } finally {
      clearTimeout(to);
    }
    let j;
    try { j = JSON.parse(await res.text()); }
    catch (e) { throw new Error('El script no devolvió datos. Revisá la URL y que el acceso sea "Cualquier persona"'); }
    if (!j.ok) throw new Error(j.error || 'Error del servidor');
    return j.data;
  }

  // ------------------------------------------------------------------ datos locales y sincronización

  function buildIdx() {
    state.idx = state.data ? Core.buildIndex(state.data, typeof Fuse !== 'undefined' ? Fuse : null) : null;
  }

  function loadCache() {
    const raw = lsGet(LS.data);
    if (!raw) return;
    try { state.data = JSON.parse(raw); buildIdx(); } catch (e) { state.data = null; state.idx = null; }
  }

  function applyData(d) {
    state.data = { productos: d.productos, impresoras: d.impresoras, compatibilidad: d.compatibilidad, equivalencias: d.equivalencias };
    lsSet(LS.data, JSON.stringify(state.data));
    lsSet(LS.ver, d.version);
    buildIdx();
    rerender();
  }

  async function sync(force) {
    if (state.syncing) return;
    if (!lsGet(LS.pin)) { refreshStatus(); return; }
    state.syncing = true;
    state.lastError = '';
    refreshStatus();
    try {
      let need = !!force || !state.data;
      if (!need) need = (await api('version')) !== lsGet(LS.ver);
      if (need) applyData(await api('getAll'));
      lsSet(LS.time, String(Date.now()));
      await flushPending();
    } catch (e) {
      if (/PIN incorrecto/.test(e.message)) {
        state.lastError = 'PIN incorrecto';
        showView('ajustes');
      } else if (e.message !== 'Sin conexión') {
        state.lastError = e.message.length > 60 ? 'No se pudo sincronizar' : e.message;
        toast(e.message, true);
      }
    } finally {
      state.syncing = false;
      refreshStatus();
      rerender();
    }
  }

  // ------------------------------------------------------------------ búsquedas sin resultado

  function pendList() { try { return JSON.parse(lsGet(LS.pend) || '[]'); } catch (e) { return []; } }

  async function flushPending() {
    let list = pendList();
    while (list.length) {
      try { await api('registrarBusqueda', { texto: list[0] }); } catch (e) { break; }
      list.shift();
      lsSet(LS.pend, JSON.stringify(list));
    }
  }

  async function logNoResult(q) {
    const n = Core.norm(q);
    if (!n || state.logged.has(n) || !lsGet(LS.pin)) return;
    state.logged.add(n);
    try {
      if (!navigator.onLine) throw new Error('offline');
      await api('registrarBusqueda', { texto: q.trim() });
    } catch (e) {
      const list = pendList();
      list.push(q.trim());
      lsSet(LS.pend, JSON.stringify(list.slice(-100)));
    }
  }

  // ------------------------------------------------------------------ vistas

  function showView(name) {
    state.view = name;
    ['buscar', 'cargar', 'ajustes'].forEach(function (v) { $('#view-' + v).hidden = v !== name; });
    $$('.bottom-nav button').forEach(function (b) { b.classList.toggle('active', b.dataset.view === name); });
    if (name === 'buscar') renderResults();
    if (name === 'cargar') renderList();
    if (name === 'ajustes') renderInfo();
    window.scrollTo(0, 0);
  }

  function rerender() {
    if (state.view === 'buscar') renderResults();
    if (state.view === 'cargar') renderList();
    if (state.view === 'ajustes') renderInfo();
  }

  function tipoBadge(p) {
    if (p.tipo === 'Original') return '<span class="badge text-bg-primary badge-tipo">Original</span>';
    if (p.tipo === 'Alternativo') return '<span class="badge text-bg-secondary badge-tipo">Alternativo</span>';
    return '';
  }

  function chipProd(p, small, rol) {
    const cls = p.categoria === 'Toner' ? 't-toner' : p.categoria === 'Tambor' ? 't-tambor' : 't-otro';
    const orig = p.tipo === 'Original' ? ' t-original' : '';
    const partes = [rol || '', p.tipo === 'Original' ? 'Orig.' : p.tipo === 'Alternativo' ? 'Alt.' : '', p.categoria !== 'Toner' ? p.categoria : ''].filter(Boolean);
    return '<button type="button" class="chip ' + cls + orig + (small ? ' chip-sm' : '') + '" data-prod="' + esc(p.id) + '">' +
      esc(p.codigo) + (partes.length ? '<small>' + esc(partes.join(' · ')) + '</small>' : '') + '</button>';
  }

  function chipPrinter(p) {
    return '<button type="button" class="chip chip-sm" data-pr="' + esc(p.id) + '">' + esc(p.marca) + ' ' + esc(p.modelo) + '</button>';
  }

  function printerCard(pr) {
    const prods = Core.productsForPrinter(state.idx, pr.id);
    return '<div class="rcard"><div class="rhead" data-pr="' + esc(pr.id) + '"><div><div class="rtitle">' + esc(pr.marca) + ' ' + esc(pr.modelo) +
      '</div></div><div class="rsub">' + prods.length + (prods.length === 1 ? ' insumo' : ' insumos') + '</div></div>' +
      (prods.length ? '<div class="chips">' + prods.map(function (p) { return chipProd(p, false); }).join('') + '</div>'
        : '<div class="rsub mt-2">Sin insumos cargados para este modelo</div>') + '</div>';
  }

  function productCard(p) {
    const n = (state.idx.byProduct.get(p.id) || []).length;
    const rels = Core.relationsOf(state.idx, p.id);
    const extra = [p.rendimiento ? Number(p.rendimiento).toLocaleString('es-AR') + ' págs.' : '', p.color || ''].filter(Boolean).join(' · ');
    return '<div class="rcard"><div class="rhead" data-prod="' + esc(p.id) + '"><div><div class="rtitle">' + esc(p.codigo) + ' ' + tipoBadge(p) +
      '</div><div class="rsub">' + esc([p.categoria, p.marca].filter(Boolean).join(' · ')) + (extra ? ' · ' + esc(extra) : '') +
      '</div></div><div class="rsub">' + n + (n === 1 ? ' impresora' : ' impresoras') + '</div></div>' +
      (rels.length ? '<div class="chips">' + rels.map(function (r) { return chipProd(r.producto, false, r.rol); }).join('') + '</div>' : '') + '</div>';
  }

  function section(titulo, total, cards, limite) {
    let h = '<div class="sec-title">' + esc(titulo) + ' (' + total + ')</div>' + cards.join('');
    if (total > limite) h += '<div class="rsub mb-2">Mostrando los primeros ' + limite + '. Escribí más para acotar.</div>';
    return h;
  }

  function renderResults() {
    const box = $('#results');
    const qv = $('#q').value;
    $('#qclear').hidden = !qv;
    if (!state.idx) {
      box.innerHTML = '<div class="alert alert-info">' + (lsGet(LS.pin)
        ? (state.syncing ? 'Descargando el catálogo…' : 'Todavía no hay datos en este teléfono. Conectate y tocá "Sincronizar ahora" en Ajustes.')
        : 'Ingresá el PIN en Ajustes para empezar.') + '</div>';
      return;
    }
    const r = Core.search(state.idx, qv);
    if (r.empty) {
      box.innerHTML = '<div class="text-body-secondary small px-1">Escribí el código del insumo (por ejemplo <b>283</b>) o el modelo de la impresora (por ejemplo <b>m127</b> o <b>hl-1110</b>). No hace falta respetar guiones ni espacios.</div>';
      return;
    }
    const sinNada = !r.prodHits.length && !r.prHits.length;
    if (sinNada || r.fuzzy || (r.via && r.via.type === 'code')) {
      clearTimeout(state.logTimer);
      if (r.nq.length >= 3) {
        state.logTimer = setTimeout(function () { if (Core.norm($('#q').value) === r.nq) logNoResult($('#q').value); }, 1600);
      }
    }
    if (sinNada) {
      box.innerHTML = '<div class="alert alert-warning">No encontré nada para <b>' + esc(qv.trim()) + '</b>. Quedó anotado para cargarlo después.</div>';
      return;
    }
    const LIM = 30;
    let h = '';
    if (r.fuzzy) h = '<div class="alert alert-warning py-2 small">No hay coincidencias exactas. Estos resultados son parecidos:</div>';
    else if (r.via && r.via.type === 'token') h = '<div class="alert alert-info py-2 small">Busqué por <b>' + esc(r.via.text) + '</b>, la parte del modelo que sí figura.</div>';
    else if (r.via && r.via.type === 'code') h = '<div class="alert alert-info py-2 small">Ese código no está tal cual. Contiene el código <b>' + esc(r.via.text) + '</b>, que probablemente es el compatible. Quedó anotado.</div>';
    const bloqueI = r.prHits.length ? section('Impresoras', r.prHits.length, r.prHits.slice(0, LIM).map(function (x) { return printerCard(x.item); }), LIM) : '';
    const bloqueP = r.prodHits.length ? section('Productos', r.prodHits.length, r.prodHits.slice(0, LIM).map(function (x) { return productCard(x.item); }), LIM) : '';
    const prodPrimero = r.prodHits.length && (!r.prHits.length || r.prodHits[0].score <= r.prHits[0].score);
    h += prodPrimero ? bloqueP + bloqueI : bloqueI + bloqueP;
    box.innerHTML = h;
  }

  // ------------------------------------------------------------------ pestaña Cargar

  function renderList() {
    const box = $('#list');
    $$('[data-seg]').forEach(function (b) { b.classList.toggle('active', b.dataset.seg === state.seg); });
    if (!state.idx) { box.innerHTML = '<div class="alert alert-info">Sin datos todavía. Sincronizá desde Ajustes.</div>'; return; }
    const f = Core.norm($('#lf').value);
    let rows = [], total = 0;
    if (state.seg === 'productos') {
      const all = state.idx.products.filter(function (p) {
        return !f || p._n.indexOf(f) >= 0 || Core.norm(p.marca).indexOf(f) >= 0 || Core.norm(p.categoria).indexOf(f) >= 0;
      }).sort(function (a, b) { return String(a.codigo).localeCompare(String(b.codigo), 'es', { numeric: true }); });
      total = all.length;
      rows = all.slice(0, 120).map(function (p) {
        const n = (state.idx.byProduct.get(p.id) || []).length;
        return '<button type="button" class="list-row" data-prod="' + esc(p.id) + '"><span><strong>' + esc(p.codigo) + '</strong> ' + tipoBadge(p) +
          '<div class="sub">' + esc([p.categoria, p.marca].filter(Boolean).join(' · ')) + '</div></span><span class="sub">' + n + '</span></button>';
      });
    } else {
      const all = state.idx.printers.filter(function (p) { return !f || p._nm.indexOf(f) >= 0; })
        .sort(function (a, b) { return (String(a.marca).localeCompare(String(b.marca), 'es')) || String(a.modelo).localeCompare(String(b.modelo), 'es', { numeric: true }); });
      total = all.length;
      rows = all.slice(0, 120).map(function (p) {
        const n = (state.idx.byPrinter.get(p.id) || []).length;
        return '<button type="button" class="list-row" data-pr="' + esc(p.id) + '"><span><strong>' + esc(p.modelo) + '</strong><div class="sub">' + esc(p.marca) +
          '</div></span><span class="sub">' + n + '</span></button>';
      });
    }
    box.innerHTML = '<div class="rsub mb-2">' + total + (state.seg === 'productos' ? ' productos' : ' impresoras') + '</div>' + rows.join('') +
      (total > 120 ? '<div class="rsub">Mostrando los primeros 120. Usá el filtro.</div>' : '');
  }

  // ------------------------------------------------------------------ Ajustes

  function renderInfo() {
    const d = state.data;
    const t = lsGet(LS.time);
    $('#info').innerHTML = d
      ? d.productos.length + ' productos · ' + d.impresoras.length + ' impresoras · ' + d.compatibilidad.length + ' compatibilidades' +
        (t ? '<br>Última sincronización: ' + esc(fmtTime(t)) : '') +
        (pendList().length ? '<br>Búsquedas sin resultado por enviar: ' + pendList().length : '')
      : 'Sin datos en este teléfono.';
    $('#pin').placeholder = lsGet(LS.pin) ? '•••• (guardado)' : 'PIN';
    $('#url').value = lsGet(LS.url) || '';
    $('#url').placeholder = API_URL.slice(0, 48) + '…';
  }

  // ------------------------------------------------------------------ panel (hoja inferior)

  function openSheet(title, html) {
    $('#sheet-title').textContent = title;
    $('#sheet-body').innerHTML = html;
    $('#overlay').hidden = false;
    $('#sheet-body').scrollTop = 0;
    if (!state.sheetOpen) {
      state.sheetOpen = true;
      try { history.pushState({ sheet: 1 }, ''); } catch (e) { /* nada */ }
    }
  }

  function closeSheet(fromPop) {
    if (!state.sheetOpen) return;
    state.sheetOpen = false;
    $('#overlay').hidden = true;
    $('#sheet-body').innerHTML = '';
    if (!fromPop) { try { history.back(); } catch (e) { /* nada */ } }
  }

  function kv(label, value) {
    return value ? '<dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd>' : '';
  }

  function openProduct(id) {
    const p = state.idx && state.idx.prodById.get(id);
    if (!p) return;
    const prs = Core.printersForProduct(state.idx, id);
    const rels = Core.relationsOf(state.idx, id);
    let h = '<div class="mb-1"><span class="badge text-bg-light border badge-tipo">' + esc(p.categoria) + '</span> ' + tipoBadge(p) + '</div>';
    h += '<dl class="kv">' + kv('Marca', p.marca) + kv('Color', p.color) +
      kv('Rendimiento', p.rendimiento ? Number(p.rendimiento).toLocaleString('es-AR') + ' páginas' : '') + kv('Notas', p.notas) + '</dl>';
    if (rels.length) {
      h += '<div class="sec-title">Relacionados</div><div class="chips">' + rels.map(function (r) { return chipProd(r.producto, false, r.rol); }).join('') + '</div>';
    }
    h += '<div class="sec-title">Impresoras compatibles (' + prs.length + ')</div>';
    if (prs.length > 12) h += '<input id="pfilter" type="search" class="form-control form-control-sm mb-2" placeholder="Filtrar modelos…" autocomplete="off" autocapitalize="none">';
    h += '<div id="plist" class="chips">' + (prs.length ? prs.map(chipPrinter).join('') : '<span class="rsub">Ninguna cargada</span>') + '</div>';
    h += '<div class="d-flex gap-2 mt-3">' +
      '<button type="button" class="btn btn-outline-primary flex-fill" data-act="edit-prod" data-id="' + esc(id) + '">Editar</button>' +
      '<button type="button" class="btn btn-outline-secondary flex-fill" data-act="rels" data-id="' + esc(id) + '">Relaciones</button>' +
      '<button type="button" class="btn btn-outline-danger flex-fill" data-act="del-prod" data-id="' + esc(id) + '">Eliminar</button></div>';
    openSheet(p.codigo + (p.tipo ? ' · ' + p.tipo : ''), h);
  }

  function openPrinter(id) {
    const pr = state.idx && state.idx.prById.get(id);
    if (!pr) return;
    const prods = Core.productsForPrinter(state.idx, id);
    let h = '<dl class="kv">' + kv('Marca', pr.marca) + kv('Modelo', pr.modelo) + kv('Notas', pr.notas) + '</dl>';
    h += '<div class="sec-title">Insumos (' + prods.length + ')</div><div class="chips">' +
      (prods.length ? prods.map(function (p) { return chipProd(p, false); }).join('') : '<span class="rsub">Ninguno cargado</span>') + '</div>';
    h += '<div class="d-flex gap-2 mt-3">' +
      '<button type="button" class="btn btn-outline-primary flex-fill" data-act="edit-pr" data-id="' + esc(id) + '">Editar</button>' +
      '<button type="button" class="btn btn-outline-danger flex-fill" data-act="del-pr" data-id="' + esc(id) + '">Eliminar</button></div>';
    openSheet(pr.marca + ' ' + pr.modelo, h);
  }

  // ------------------------------------------------------------------ formularios

  function field(id, label, value, attrs) {
    return '<div class="mb-2"><label class="form-label small mb-1" for="' + id + '">' + esc(label) + '</label>' +
      '<input id="' + id + '" class="form-control" value="' + esc(value) + '" ' + (attrs || '') + '></div>';
  }

  function productForm(id) {
    const idx = state.idx;
    const p = id ? idx.prodById.get(id) : null;
    const prs = p ? Core.printersForProduct(idx, id) : [];
    const marcas = Array.from(new Set(idx.products.map(function (x) { return x.marca; }).concat(idx.printers.map(function (x) { return x.marca; })).filter(Boolean))).sort();
    const v = p || { codigo: '', marca: '', categoria: 'Toner', tipo: '', color: '', rendimiento: '', notas: '' };
    let h = '<datalist id="dl-marcas">' + marcas.map(function (m) { return '<option value="' + esc(m) + '">'; }).join('') + '</datalist>';
    h += field('f-codigo', 'Código', v.codigo, 'autocomplete="off" autocapitalize="characters"');
    h += field('f-marca', 'Marca de impresora a la que sirve', v.marca, 'list="dl-marcas" autocomplete="off"');
    h += '<div class="row g-2 mb-2"><div class="col-7"><label class="form-label small mb-1" for="f-categoria">Categoría</label><select id="f-categoria" class="form-select">' +
      CATEGORIAS.map(function (c) { return '<option' + (c === v.categoria ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></div>' +
      '<div class="col-5"><label class="form-label small mb-1" for="f-tipo">Tipo</label><select id="f-tipo" class="form-select">' +
      [['', '(no indica)'], ['Original', 'Original'], ['Alternativo', 'Alternativo']].map(function (o) {
        return '<option value="' + o[0] + '"' + (o[0] === (v.tipo || '') ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select></div></div>';
    h += '<div class="row g-2"><div class="col-6">' + field('f-color', 'Color', v.color, 'autocomplete="off"') + '</div>' +
      '<div class="col-6">' + field('f-rend', 'Rendimiento (págs.)', v.rendimiento, 'inputmode="numeric" autocomplete="off"') + '</div></div>';
    h += field('f-notas', 'Notas', v.notas, 'autocomplete="off"');
    h += '<label class="form-label small mb-1" for="f-modelos">Impresoras compatibles (una por línea)</label>' +
      '<textarea id="f-modelos" class="form-control" rows="8" autocapitalize="characters" spellcheck="false">' +
      esc(prs.map(function (x) { return x.marca + ' | ' + x.modelo; }).join('\n')) + '</textarea>' +
      '<div class="form-text mb-3">Escribí solo el modelo (se usa la marca de arriba) o <b>Marca | Modelo</b> si es de otra marca. Los modelos que ya existen se reutilizan.</div>';
    h += '<div class="d-flex gap-2"><button type="button" class="btn btn-primary flex-fill" data-act="save-prod" data-id="' + esc(id || '') + '">Guardar</button>' +
      '<button type="button" class="btn btn-outline-secondary flex-fill" data-act="cancel-form" data-id="' + esc(id || '') + '" data-kind="prod">Cancelar</button></div>';
    openSheet(p ? 'Editar ' + p.codigo : 'Nuevo producto', h);
  }

  function printerForm(id) {
    const pr = id ? state.idx.prById.get(id) : null;
    const v = pr || { marca: '', modelo: '', notas: '' };
    let h = field('g-marca', 'Marca', v.marca, 'autocomplete="off"') + field('g-modelo', 'Modelo', v.modelo, 'autocomplete="off" autocapitalize="characters"') +
      field('g-notas', 'Notas', v.notas, 'autocomplete="off"');
    h += '<div class="d-flex gap-2 mt-3"><button type="button" class="btn btn-primary flex-fill" data-act="save-pr" data-id="' + esc(id || '') + '">Guardar</button>' +
      '<button type="button" class="btn btn-outline-secondary flex-fill" data-act="cancel-form" data-id="' + esc(id || '') + '" data-kind="pr">Cancelar</button></div>';
    openSheet(pr ? 'Editar ' + pr.modelo : 'Nueva impresora', h);
  }

  function resolveModelos(lines, defBrand) {
    const idx = state.idx;
    const byKey = new Map(), byModel = new Map();
    idx.printers.forEach(function (p) {
      byKey.set(String(p.marca).toLowerCase() + '|' + p._n, p);
      if (!byModel.has(p._n)) byModel.set(p._n, []);
      byModel.get(p._n).push(p);
    });
    const seen = new Set(), out = [];
    lines.forEach(function (line) {
      let marca = '', modelo = line.trim();
      const i = line.indexOf('|');
      if (i >= 0) { marca = line.slice(0, i).trim(); modelo = line.slice(i + 1).trim(); }
      if (!modelo) return;
      const n = Core.norm(modelo);
      let found = null;
      if (marca) found = byKey.get(marca.toLowerCase() + '|' + n) || null;
      else {
        const c = byModel.get(n) || [];
        found = c.filter(function (x) { return String(x.marca).toLowerCase() === defBrand.toLowerCase(); })[0] || c[0] || null;
      }
      if (found) {
        if (!seen.has(found.id)) { seen.add(found.id); out.push({ id_impresora: found.id }); }
      } else {
        const m = marca || defBrand;
        const key = m.toLowerCase() + '|' + n;
        if (!seen.has(key)) { seen.add(key); out.push({ marca: m, modelo: modelo }); }
      }
    });
    return out;
  }

  async function withBusy(btn, fn) {
    const txt = btn.textContent;
    btn.disabled = true; btn.textContent = 'Guardando…';
    try { await fn(); }
    catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; btn.textContent = txt; }
  }

  async function saveProduct(btn) {
    const id = btn.dataset.id || '';
    const g = function (s) { return $(s, $('#sheet-body')).value.trim(); };
    const codigo = g('#f-codigo');
    if (!codigo) return toast('Falta el código', true);
    const marca = g('#f-marca');
    const defBrand = (marca.split('/')[0] || '').trim();
    const lines = $('#f-modelos').value.split('\n');
    const modelos = resolveModelos(lines, defBrand);
    const previo = id ? (state.idx.byProduct.get(id) || []).length : 0;
    if (id && previo && !modelos.length && !confirm('La lista de impresoras quedó vacía: se van a quitar las ' + previo + ' compatibilidades de este producto. ¿Seguir?')) return;
    const nuevas = modelos.filter(function (m) { return !m.id_impresora; }).length;
    if (!defBrand && nuevas && !confirm('Hay modelos nuevos y la marca está vacía. ¿Guardarlos sin marca?')) return;
    const producto = {
      codigo: codigo, marca: marca, categoria: g('#f-categoria'), tipo: g('#f-tipo'), color: g('#f-color'),
      rendimiento: g('#f-rend'), notas: g('#f-notas'), modelos: modelos
    };
    if (id) producto.id = id;
    await withBusy(btn, async function () {
      const r = await api('saveProducto', { producto: producto });
      await sync(true);
      toast('Guardado' + (nuevas ? ' · ' + nuevas + ' impresoras nuevas' : ''));
      openProduct(r.id);
    });
  }

  async function savePrinter(btn) {
    const id = btn.dataset.id || '';
    const g = function (s) { return $(s, $('#sheet-body')).value.trim(); };
    if (!g('#g-modelo')) return toast('Falta el modelo', true);
    const impresora = { marca: g('#g-marca'), modelo: g('#g-modelo'), notas: g('#g-notas') };
    if (id) impresora.id = id;
    await withBusy(btn, async function () {
      const r = await api('saveImpresora', { impresora: impresora });
      await sync(true);
      toast('Guardado');
      openPrinter(r.id);
    });
  }

  async function deleteProduct(id) {
    const p = state.idx.prodById.get(id);
    const n = (state.idx.byProduct.get(id) || []).length;
    if (!confirm('¿Eliminar ' + p.codigo + '? Se quitan también sus ' + n + ' compatibilidades y relaciones. No se puede deshacer.')) return;
    try { await api('deleteProducto', { id: id }); await sync(true); closeSheet(); toast('Producto eliminado'); }
    catch (e) { toast(e.message, true); }
  }

  async function deletePrinter(id) {
    const p = state.idx.prById.get(id);
    if (!confirm('¿Eliminar ' + p.marca + ' ' + p.modelo + '? Se quita de todos los productos. No se puede deshacer.')) return;
    try { await api('deleteImpresora', { id: id }); await sync(true); closeSheet(); toast('Impresora eliminada'); }
    catch (e) { toast(e.message, true); }
  }

  // ------------------------------------------------------------------ relaciones

  function openRelations(id) {
    const p = state.idx.prodById.get(id);
    const rels = Core.relationsOf(state.idx, id);
    const dlMap = {};
    const opts = state.idx.products.filter(function (x) { return x.id !== id; }).map(function (x) {
      const val = x.codigo + ' · ' + (x.tipo || 'sin tipo') + ' · ' + x.categoria + ' (' + x.id + ')';
      dlMap[val] = x.id;
      return '<option value="' + esc(val) + '">';
    }).join('');
    state.dlMap = dlMap;
    let h = '<div class="sec-title">Relaciones actuales</div>';
    h += rels.length ? rels.map(function (r) {
      return '<div class="rel-row"><span>' + esc(r.rol) + ': <b>' + esc(r.producto.codigo) + '</b> <span class="rsub">' + esc(r.producto.tipo || r.producto.categoria) + '</span></span>' +
        '<button type="button" class="btn btn-sm btn-outline-danger" data-act="rel-del" data-id="' + esc(id) + '" data-a="' + esc(r.a) + '" data-b="' + esc(r.b) + '" data-rel="' + esc(r.relacion) + '">Quitar</button></div>';
    }).join('') : '<div class="rsub">Sin relaciones.</div>';
    h += '<div class="sec-title">Agregar</div><datalist id="dl-prods">' + opts + '</datalist>' +
      '<div class="mb-2"><div class="small mb-1"><b>' + esc(p.codigo) + '</b> ' + esc(p.tipo ? '(' + p.tipo + ')' : '') + '</div>' +
      '<select id="r-kind" class="form-select mb-2">' + KINDS.map(function (k) { return '<option value="' + k[0] + '">' + k[1] + '</option>'; }).join('') + '</select>' +
      '<input id="r-other" class="form-control" list="dl-prods" placeholder="Código del otro producto" autocomplete="off" autocapitalize="none"></div>' +
      '<div class="d-flex gap-2"><button type="button" class="btn btn-primary flex-fill" data-act="rel-add" data-id="' + esc(id) + '">Agregar relación</button>' +
      '<button type="button" class="btn btn-outline-secondary flex-fill" data-act="back-prod" data-id="' + esc(id) + '">Volver</button></div>';
    openSheet('Relaciones de ' + p.codigo, h);
  }

  function kindToEquiv(kind, P, O) {
    switch (kind) {
      case 'orig': return { a: P, b: O, rel: 'original-alternativo' };
      case 'alt': return { a: O, b: P, rel: 'original-alternativo' };
      case 'tambor': return { a: P, b: O, rel: 'toner-tambor' };
      case 'esTambor': return { a: O, b: P, rel: 'toner-tambor' };
      default: return { a: P, b: O, rel: 'equivalente' };
    }
  }

  async function addRelation(btn) {
    const id = btn.dataset.id;
    const val = $('#r-other').value.trim();
    let otro = (state.dlMap || {})[val];
    if (!otro) {
      const n = Core.norm(val);
      const c = state.idx.products.filter(function (x) { return x.id !== id && x._n === n; });
      if (c.length === 1) otro = c[0].id;
      else return toast(c.length ? 'Hay varios con ese código: elegí uno de la lista' : 'Elegí un producto de la lista', true);
    }
    const e = kindToEquiv($('#r-kind').value, id, otro);
    await withBusy(btn, async function () {
      await api('addEquiv', { equivalencia: { id_producto_a: e.a, id_producto_b: e.b, relacion: e.rel, nota: '' } });
      await sync(true);
      toast('Relación agregada');
      openRelations(id);
    });
  }

  async function removeRelation(btn) {
    try {
      await api('removeEquiv', { equivalencia: { id_producto_a: btn.dataset.a, id_producto_b: btn.dataset.b, relacion: btn.dataset.rel } });
      await sync(true);
      toast('Relación quitada');
      openRelations(btn.dataset.id);
    } catch (e) { toast(e.message, true); }
  }

  // ------------------------------------------------------------------ eventos

  function onClick(ev) {
    const act = ev.target.closest('[data-act]');
    if (act) {
      const id = act.dataset.id;
      switch (act.dataset.act) {
        case 'edit-prod': return productForm(id);
        case 'del-prod': return deleteProduct(id);
        case 'rels': return openRelations(id);
        case 'back-prod': return openProduct(id);
        case 'rel-add': return addRelation(act);
        case 'rel-del': return removeRelation(act);
        case 'save-prod': return saveProduct(act);
        case 'edit-pr': return printerForm(id);
        case 'del-pr': return deletePrinter(id);
        case 'save-pr': return savePrinter(act);
        case 'cancel-form':
          if (id) return act.dataset.kind === 'pr' ? openPrinter(id) : openProduct(id);
          return closeSheet();
      }
      return;
    }
    const pr = ev.target.closest('[data-pr]');
    if (pr) return openPrinter(pr.dataset.pr);
    const pd = ev.target.closest('[data-prod]');
    if (pd) return openProduct(pd.dataset.prod);
  }

  function bind() {
    $('#results').addEventListener('click', onClick);
    $('#list').addEventListener('click', onClick);
    $('#sheet-body').addEventListener('click', onClick);
    $('#sheet-close').addEventListener('click', function () { closeSheet(); });
    $('#overlay').addEventListener('click', function (e) { if (e.target === $('#overlay')) closeSheet(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
    window.addEventListener('popstate', function () { if (state.sheetOpen) closeSheet(true); });

    $$('.bottom-nav button').forEach(function (b) { b.addEventListener('click', function () { showView(b.dataset.view); }); });
    $$('[data-seg]').forEach(function (b) {
      b.addEventListener('click', function () { state.seg = b.dataset.seg; $('#lf').value = ''; renderList(); });
    });

    let t;
    $('#q').addEventListener('input', function () { clearTimeout(t); t = setTimeout(renderResults, 120); });
    $('#q').addEventListener('keydown', function (e) { if (e.key === 'Enter') e.target.blur(); });
    $('#qclear').addEventListener('click', function () { $('#q').value = ''; renderResults(); $('#q').focus(); });
    $('#lf').addEventListener('input', function () { renderList(); });
    $('#newbtn').addEventListener('click', function () {
      if (!state.idx) return toast('Primero sincronizá los datos', true);
      if (!navigator.onLine) return toast('Para cargar necesitás conexión', true);
      if (state.seg === 'productos') productForm(); else printerForm();
    });

    $('#sheet-body').addEventListener('input', function (e) {
      if (e.target.id !== 'pfilter') return;
      const id = ($('[data-act="edit-prod"]', $('#sheet-body')) || {}).dataset;
      if (!id) return;
      const f = Core.norm(e.target.value);
      const prs = Core.printersForProduct(state.idx, id.id).filter(function (p) { return !f || (Core.norm(p.marca) + p._n).indexOf(f) >= 0 || Core.norm(p.modelo).indexOf(f) >= 0; });
      $('#plist').innerHTML = prs.length ? prs.map(chipPrinter).join('') : '<span class="rsub">Sin coincidencias</span>';
    });

    $('#pinsave').addEventListener('click', function () {
      const pin = $('#pin').value.trim();
      const url = $('#url').value.trim();
      if (url) { if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url)) return toast('La URL debe terminar en /exec', true); lsSet(LS.url, url); }
      else lsDel(LS.url);
      if (pin) lsSet(LS.pin, pin);
      if (!lsGet(LS.pin)) return toast('Ingresá el PIN', true);
      $('#pin').value = '';
      state.lastError = '';
      toast('Guardado');
      sync(true);
    });
    $('#syncnow').addEventListener('click', function () { state.lastError = ''; sync(true); });
    $('#wipe').addEventListener('click', function () {
      if (!confirm('Se borran los datos guardados en este teléfono (no los de la planilla). Se vuelven a descargar al sincronizar. ¿Seguir?')) return;
      [LS.data, LS.ver, LS.time, LS.pend].forEach(lsDel);
      state.data = null; state.idx = null;
      rerender();
      sync(true);
    });
    $('#install').addEventListener('click', async function () {
      if (!state.installEvt) return;
      state.installEvt.prompt();
      try { await state.installEvt.userChoice; } catch (e) { /* nada */ }
      state.installEvt = null; $('#install').hidden = true;
    });
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); state.installEvt = e; $('#install').hidden = false; });

    window.addEventListener('online', function () { sync(false); });
    window.addEventListener('offline', refreshStatus);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && Date.now() - Number(lsGet(LS.time) || 0) > 120000) sync(false);
    });
  }

  function init() {
    bind();
    loadCache();
    refreshStatus();
    showView('buscar');
    if (!lsGet(LS.pin)) { showView('ajustes'); toast('Ingresá el PIN para empezar'); }
    else sync(false);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* sin SW (por ejemplo, abierto como archivo) */ });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
