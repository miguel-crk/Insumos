/* Núcleo de búsqueda: sin DOM, para poder probarlo en Node. */
(function (root) {
  'use strict';

  const ORDEN_CAT = { 'Toner': 0, 'Tambor': 1, 'Cabezal': 2, 'Almohadilla': 3, 'Caja de mantenimiento': 4 };
  const ORDEN_TIPO = { 'Original': 0, 'Alternativo': 1, '': 2 };

  function norm(s) {
    return String(s === null || s === undefined ? '' : s).toLowerCase().replace(/[ \-\/._]/g, '');
  }

  function push(map, k, v) {
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  }

  function buildIndex(data, FuseCtor) {
    const products = (data.productos || []).map(function (p) {
      return Object.assign({}, p, { tipo: p.tipo || '', _n: norm(p.codigo) });
    });
    const printers = (data.impresoras || []).map(function (p) {
      return Object.assign({}, p, { _n: norm(p.modelo), _nm: norm(p.marca) + norm(p.modelo) });
    });
    const prodById = new Map(), prById = new Map();
    products.forEach(function (p) { prodById.set(p.id, p); });
    printers.forEach(function (p) { prById.set(p.id, p); });

    const byProduct = new Map(), byPrinter = new Map();
    (data.compatibilidad || []).forEach(function (c) {
      if (!prodById.has(c.id_producto) || !prById.has(c.id_impresora)) return;
      push(byProduct, c.id_producto, c.id_impresora);
      push(byPrinter, c.id_impresora, c.id_producto);
    });

    // relaciones vistas desde cada producto: { id, rol, relacion, a, b }
    const rel = new Map();
    (data.equivalencias || []).forEach(function (e) {
      if (!prodById.has(e.id_producto_a) || !prodById.has(e.id_producto_b)) return;
      let rolDeB, rolDeA;
      if (e.relacion === 'original-alternativo') { rolDeB = 'alternativo'; rolDeA = 'original'; }
      else if (e.relacion === 'toner-tambor') { rolDeB = 'tambor'; rolDeA = 'toner'; }
      else { rolDeB = 'equivalente'; rolDeA = 'equivalente'; }
      push(rel, e.id_producto_a, { id: e.id_producto_b, rol: rolDeB, relacion: e.relacion, a: e.id_producto_a, b: e.id_producto_b, nota: e.nota });
      push(rel, e.id_producto_b, { id: e.id_producto_a, rol: rolDeA, relacion: e.relacion, a: e.id_producto_a, b: e.id_producto_b, nota: e.nota });
    });

    const idx = { products: products, printers: printers, prodById: prodById, prById: prById,
                  byProduct: byProduct, byPrinter: byPrinter, rel: rel, fuseP: null, fuseI: null, Fuse: FuseCtor || null };
    return idx;
  }

  function ordenarProductos(list) {
    return list.slice().sort(function (a, b) {
      const ca = ORDEN_CAT[a.categoria] === undefined ? 9 : ORDEN_CAT[a.categoria];
      const cb = ORDEN_CAT[b.categoria] === undefined ? 9 : ORDEN_CAT[b.categoria];
      if (ca !== cb) return ca - cb;
      const ta = ORDEN_TIPO[a.tipo] === undefined ? 2 : ORDEN_TIPO[a.tipo];
      const tb = ORDEN_TIPO[b.tipo] === undefined ? 2 : ORDEN_TIPO[b.tipo];
      if (ta !== tb) return ta - tb;
      return String(a.codigo).localeCompare(String(b.codigo), 'es', { numeric: true });
    });
  }

  function productsForPrinter(idx, prId) {
    const ids = idx.byPrinter.get(prId) || [];
    return ordenarProductos(ids.map(function (id) { return idx.prodById.get(id); }));
  }

  function printersForProduct(idx, pId) {
    const ids = idx.byProduct.get(pId) || [];
    return ids.map(function (id) { return idx.prById.get(id); }).sort(function (a, b) {
      const m = String(a.marca).localeCompare(String(b.marca), 'es');
      return m || String(a.modelo).localeCompare(String(b.modelo), 'es', { numeric: true });
    });
  }

  function relationsOf(idx, pId) {
    return (idx.rel.get(pId) || []).map(function (r) {
      return Object.assign({}, r, { producto: idx.prodById.get(r.id) });
    });
  }

  function scoreMatch(n, nq) {
    if (n === nq) return 0;
    if (n.indexOf(nq) === 0) return 1;
    if (n.indexOf(nq) > 0) return 2;
    return -1;
  }

  function directHits(idx, nq) {
    const prodHits = [], prHits = [];
    idx.products.forEach(function (p) {
      const s = scoreMatch(p._n, nq);
      if (s >= 0) prodHits.push({ item: p, score: s });
    });
    idx.printers.forEach(function (p) {
      let s = scoreMatch(p._n, nq);
      if (s < 0 && p._nm.indexOf(nq) >= 0) s = 2;
      if (s >= 0) prHits.push({ item: p, score: s });
    });
    const cmp = function (a, b) {
      return a.score - b.score || String(a.item._n).length - String(b.item._n).length ||
        String(a.item._n).localeCompare(String(b.item._n), 'es', { numeric: true });
    };
    prodHits.sort(cmp); prHits.sort(cmp);
    return { prodHits: prodHits, prHits: prHits };
  }

  /* Orden de intentos: coincidencia directa -> palabra con números ("laserjet pro m127" -> m127)
     -> código contenido en lo escrito ("cf283a" -> 283) -> búsqueda aproximada. */
  function search(idx, q) {
    const nq = norm(q);
    const out = { empty: false, nq: nq, prodHits: [], prHits: [], fuzzy: false, via: null, best: 9 };
    if (!nq) { out.empty = true; return out; }

    let h = directHits(idx, nq);

    if (!h.prodHits.length && !h.prHits.length) {
      const tokens = String(q).toLowerCase().split(/\s+/).map(norm).filter(function (t) { return t.length >= 3 && /\d/.test(t) && t !== nq; })
        .sort(function (a, b) { return b.length - a.length; });
      for (let i = 0; i < tokens.length; i++) {
        const th = directHits(idx, tokens[i]);
        if (th.prodHits.length || th.prHits.length) { h = th; out.via = { type: 'token', text: tokens[i] }; break; }
      }
    }

    if (!h.prodHits.length && !h.prHits.length && nq.length >= 4) {
      // forma típica de un código de fabricante: 1-3 letras + código + hasta 2 letras (CF283A, TN-1060)
      const cont = idx.products.filter(function (p) {
        if (p._n.length < 3 || p._n === nq) return false;
        const re = new RegExp('^[a-z]{1,3}' + p._n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[a-z]{0,2}$');
        return re.test(nq);
      }).sort(function (a, b) { return b._n.length - a._n.length; });
      if (cont.length) {
        const mejor = cont[0]._n.length;
        h = { prodHits: cont.filter(function (p) { return p._n.length === mejor; }).map(function (p) { return { item: p, score: 3 }; }), prHits: [] };
        out.via = { type: 'code', text: cont[0].codigo };
      }
    }

    if (!h.prodHits.length && !h.prHits.length && nq.length >= 3 && idx.Fuse) {
      if (!idx.fuseP) {
        idx.fuseP = new idx.Fuse(idx.products, { keys: ['_n'], threshold: 0.3, ignoreLocation: true });
        idx.fuseI = new idx.Fuse(idx.printers, { keys: ['_n', '_nm'], threshold: 0.3, ignoreLocation: true });
      }
      const fp = idx.fuseP.search(nq, { limit: 15 }).map(function (r) { return { item: r.item, score: 3 }; });
      const fi = idx.fuseI.search(nq, { limit: 15 }).map(function (r) { return { item: r.item, score: 3 }; });
      h = { prodHits: fp, prHits: fi };
      out.fuzzy = fp.length + fi.length > 0;
    }

    out.prodHits = h.prodHits; out.prHits = h.prHits;
    out.best = Math.min(h.prodHits.length ? h.prodHits[0].score : 9, h.prHits.length ? h.prHits[0].score : 9);
    return out;
  }

  const Core = { norm: norm, buildIndex: buildIndex, search: search, productsForPrinter: productsForPrinter,
                 printersForProduct: printersForProduct, relationsOf: relationsOf, ordenarProductos: ordenarProductos };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof self !== 'undefined' ? self : this);
