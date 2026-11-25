/* Pop-Out Repair Photos. MIT licence. Runs entirely in the browser; photos never leave the device. */
(function () {
  'use strict';
  /* Settings: change these to match your own form. Leave FORM_NO_SHOWN empty to hide it on the PDF. */
  var FORM_NO = 'FGJV0008';                 // used in the PDF file name
  var FORM_NO_SHOWN = 'S2-CIV-CF-PFC-FRM-FGJV0008[A]'; // printed at top right of each PDF page
  var PDF_TITLE = 'SEGMENT REPAIR INSPECTION CHECKLIST (Photos)';
  var STAGES = [
    { k: 'pre', label: 'Pre Repair', short: 'Pre', file: 'Pre' },
    { k: 'during', label: 'During Repair', short: 'During', file: 'During' },
    { k: 'post', label: 'Post Repair', short: 'Post', file: 'Post' }
  ];
  var LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'K'];

  var idb = null;
  var state = { utns: [], openId: null, saveOk: true, storageNote: '' };
  var urls = [];
  var toastTimer = null;

  function $(s) { return document.querySelector(s); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dstr(t) { var d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function dtstr(t) { var d = new Date(t); return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function cleanId(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /* ---------- storage (IndexedDB, this phone only) ---------- */
  function openDb() {
    return new Promise(function (res) {
      try {
        var r = indexedDB.open('fgjv0008-photos', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('utns', { keyPath: 'id' }); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { res(null); };
        r.onblocked = function () { res(null); };
      } catch (e) { res(null); }
    });
  }
  function dbAll() {
    return new Promise(function (res) {
      if (!idb) return res([]);
      try {
        var q = idb.transaction('utns').objectStore('utns').getAll();
        q.onsuccess = function () { res(q.result || []); };
        q.onerror = function () { res([]); };
      } catch (e) { res([]); }
    });
  }
  function dbPut(rec) {
    return new Promise(function (res) {
      if (!idb) return res(false);
      try {
        var tx = idb.transaction('utns', 'readwrite');
        tx.objectStore('utns').put(rec);
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { res(false); };
        tx.onabort = function () { res(false); };
      } catch (e) { res(false); }
    });
  }
  function dbDel(id) {
    return new Promise(function (res) {
      if (!idb) return res(false);
      try {
        var tx = idb.transaction('utns', 'readwrite');
        tx.objectStore('utns').delete(id);
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { res(false); };
        tx.onabort = function () { res(false); };
      } catch (e) { res(false); }
    });
  }
  function save(u) {
    u.updated = Date.now();
    return dbPut(u).then(function (ok) {
      state.saveOk = ok || !idb ? state.saveOk : false;
      if (!ok) { state.saveOk = false; render(); }
      return ok;
    });
  }

  /* ---------- helpers ---------- */
  function getUtn(id) { return state.utns.filter(function (u) { return u.id === id; })[0]; }
  function counts(u) {
    var have = 0;
    u.segments.forEach(function (s) { STAGES.forEach(function (st) { if (s.photos[st.k]) have++; }); });
    return { have: have, total: u.segments.length * 3 };
  }
  function toast(msg, ms) {
    clearTimeout(toastTimer);
    var t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg;
    toastTimer = setTimeout(function () { var x = $('#toast'); if (x) x.remove(); }, ms || 3200);
  }
  function ask(msg, okLabel) {
    return new Promise(function (res) {
      var layer = $('#layer');
      layer.innerHTML = '<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true"><div>' + esc(msg) + '</div><div class="row"><button class="grow" data-m="no">Cancel</button><button class="grow danger" data-m="yes">' + esc(okLabel || 'OK') + '</button></div></div></div>';
      layer.onclick = function (e) {
        var b = e.target.closest('[data-m]');
        if (!b) return;
        layer.innerHTML = ''; layer.onclick = null;
        res(b.getAttribute('data-m') === 'yes');
      };
    });
  }

  /* ---------- photos ---------- */
  function loadImg(file) {
    return new Promise(function (res, rej) {
      var u = URL.createObjectURL(file);
      var im = new Image();
      im.onload = function () { URL.revokeObjectURL(u); res(im); };
      im.onerror = function () { URL.revokeObjectURL(u); rej(new Error('image')); };
      im.src = u;
    });
  }
  function toJpeg(file) {
    var get = (typeof createImageBitmap === 'function')
      ? createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return loadImg(file); })
      : loadImg(file);
    return get.then(function (img) {
      var w0 = img.width || img.naturalWidth, h0 = img.height || img.naturalHeight;
      var s = Math.min(1, 1600 / Math.max(w0, h0));
      var w = Math.max(1, Math.round(w0 * s)), h = Math.max(1, Math.round(h0 * s));
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      if (img.close) img.close();
      return new Promise(function (res, rej) {
        c.toBlob(function (b) { b ? res(b) : rej(new Error('encode')); }, 'image/jpeg', 0.82);
      }).then(function (blob) {
        return blob.arrayBuffer().then(function (buf) { return { buf: buf, w: w, h: h }; });
      });
    });
  }
  function pick(segId, stageK, camera) {
    var u = getUtn(state.openId);
    if (!u) return;
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    if (camera) inp.setAttribute('capture', 'environment');
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      inp.remove();
      if (!f) return;
      toast('Saving photo…', 6000);
      toJpeg(f).then(function (r) {
        var seg = u.segments.filter(function (s) { return s.id === segId; })[0];
        if (!seg) return;
        seg.photos[stageK] = { buf: r.buf, w: r.w, h: r.h, ts: Date.now() };
        return save(u).then(function (ok) { render(); toast(ok ? 'Photo saved' : 'Photo kept for now, but could not be saved to this phone. Export soon.'); });
      }).catch(function () { toast('That photo could not be read. Try again.'); });
    });
    inp.click();
  }

  /* ---------- export ---------- */
  function segName(s) { return cleanId(s.label) || 'SEG'; }
  function exportPdf(u) {
    var segs = u.segments.map(function (s) {
      var photos = {};
      STAGES.forEach(function (st) {
        var p = s.photos[st.k];
        photos[st.k] = p ? { bytes: new Uint8Array(p.buf), w: p.w, h: p.h, when: dtstr(p.ts) } : null;
      });
      return { label: s.label, photos: photos };
    });
    var bytes = buildPdf({ utn: u.utn, segments: segs, stages: STAGES, generated: dtstr(Date.now()), formNo: FORM_NO_SHOWN, title: PDF_TITLE });
    return saveFile(FORM_NO + '_' + u.utn + '_Photos.pdf', new Blob([bytes], { type: 'application/pdf' }));
  }
  function exportZip(u) {
    var files = [];
    u.segments.forEach(function (s) {
      STAGES.forEach(function (st) {
        var p = s.photos[st.k];
        if (p) files.push({ name: u.utn + '/' + u.utn + '_' + segName(s) + '_' + st.file + '_' + dstr(p.ts) + '.jpg', data: new Uint8Array(p.buf) });
      });
    });
    if (!files.length) { toast('No photos to save yet.'); return Promise.resolve(); }
    var bytes = zipStore(files);
    return saveFile('UTN_' + u.utn + '_photos.zip', new Blob([bytes], { type: 'application/zip' }));
  }
  /* Save a file: share sheet where available (iPhone: Save to Files), otherwise a normal download. */
  function saveFile(name, blob) {
    var file;
    try { file = new File([blob], name, { type: blob.type }); } catch (e) { file = null; }
    var tryShare = file && navigator.canShare && navigator.canShare({ files: [file] })
      ? navigator.share({ files: [file], title: name }).then(function () { return 'shared'; }, function (e) {
          if (e && e.name === 'AbortError') return Promise.reject({ code: 'declined' });
          return 'fallback';
        })
      : Promise.resolve('fallback');
    return tryShare.then(function (r) {
      if (r === 'shared') return r;
      var a = document.createElement('a');
      var u = URL.createObjectURL(blob);
      a.href = u; a.download = name; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(function () { a.remove(); URL.revokeObjectURL(u); }, 5000);
      return 'downloaded';
    });
  }
  function exportJpgs(u) {
    var files = [];
    u.segments.forEach(function (s) {
      STAGES.forEach(function (st) {
        var p = s.photos[st.k];
        if (p) files.push(new File([p.buf], u.utn + '_' + segName(s) + '_' + st.file + '_' + dstr(p.ts) + '.jpg', { type: 'image/jpeg' }));
      });
    });
    if (!files.length) { toast('No photos to save yet.'); return Promise.resolve(); }
    if (!(navigator.canShare && navigator.canShare({ files: files }))) return Promise.reject({ code: 'noshare' });
    return navigator.share({ files: files }).then(function () { return 'shared'; }, function (e) {
      return Promise.reject(e && e.name === 'AbortError' ? { code: 'declined' } : { code: 'share' });
    });
  }
  function doExport(kind) {
    var u = getUtn(state.openId);
    if (!u) return;
    var c = counts(u);
    if (!c.have) { toast('Take at least one photo first.'); return; }
    toast('Preparing file…', 8000);
    var p;
    try { p = kind === 'pdf' ? exportPdf(u) : kind === 'jpgs' ? exportJpgs(u) : exportZip(u); } catch (e) { toast('Could not build the file.'); return; }
    p.then(function (r) { if (r === 'shared') toast('Done.'); else if (r === 'downloaded') toast('File downloaded. Check Files or Downloads.'); }, function (e) {
      if (e && e.code === 'declined') toast('Save cancelled.');
      else if (e && e.code === 'noshare') toast('This browser cannot send photos to the Photos app. Use Photos as ZIP.');
      else toast('Could not save the file' + (e && e.code ? ' (' + e.code + ')' : '') + '.');
    });
  }

  /* ---------- views ---------- */
  function topBanner() {
    var s = '';
    if (!idb) s += '<div class="banner">This browser is not keeping data between visits. Photos will be lost when you close this page. Export before leaving.</div>';
    else if (!state.saveOk) s += '<div class="banner">The last save to this phone failed. Export your photos now.</div>';
    return s;
  }
  function viewHome() {
    var list = state.utns.slice().sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
    var h = '<div><h1>Pop-Out Repair Photos</h1><p class="sub">Form 0008 photo log. Pre, During and Post for each segment.</p></div>';
    h += topBanner();
    h += '<form class="card" id="f-utn" autocomplete="off"><h2>Add a ring (UTN)</h2><div class="row"><input id="in-utn" type="tel" inputmode="numeric" placeholder="e.g. 12134" aria-label="UTN" maxlength="12"><button class="primary" type="submit">Add</button></div></form>';
    if (!list.length) {
      h += '<div class="empty">No UTNs yet. Add one above, then add its segments (K, G, C, F, D …).</div>';
    } else {
      h += '<h2>Your UTNs</h2><div style="display:flex;flex-direction:column;gap:10px">';
      list.forEach(function (u) {
        var c = counts(u);
        var done = c.total > 0 && c.have === c.total;
        h += '<button class="utn-item card" data-act="open" data-id="' + esc(u.id) + '"><span><span class="utn-no">' + esc(u.utn) + '</span><br><span class="note">' + u.segments.length + ' segment' + (u.segments.length === 1 ? '' : 's') + (u.segments.length ? ': ' + esc(u.segments.map(function (s) { return s.label; }).join(', ')) : '') + '</span></span><span class="pill' + (done ? ' done' : '') + '">' + c.have + ' / ' + c.total + '</span></button>';
      });
      h += '</div>';
    }
    h += '<p class="note">Photos are stored only on this phone, inside this page. Use Save PDF or Save photos on each UTN so you always have a copy.</p>';
    return h;
  }
  function stageHtml(seg, st) {
    var p = seg.photos[st.k];
    var h = '<div class="stage"><div class="stage-label">' + st.short + '</div>';
    if (p) {
      var url = URL.createObjectURL(new Blob([p.buf], { type: 'image/jpeg' }));
      urls.push(url);
      h += '<div class="thumb"><img alt="' + esc(st.label + ' segment ' + seg.label) + '" src="' + url + '"><div class="when">' + esc(dtstr(p.ts)) + '</div></div>';
      h += '<div class="stage-actions"><button class="small" data-act="shoot" data-seg="' + esc(seg.id) + '" data-st="' + st.k + '">Retake</button><button class="small danger" data-act="rmphoto" data-seg="' + esc(seg.id) + '" data-st="' + st.k + '" aria-label="Remove photo">✕</button></div>';
    } else {
      h += '<button class="shoot" data-act="shoot" data-seg="' + esc(seg.id) + '" data-st="' + st.k + '"><span class="cam" aria-hidden="true">📷</span><span>' + st.short + '</span></button>';
      h += '<div class="stage-actions"><button class="small" data-act="lib" data-seg="' + esc(seg.id) + '" data-st="' + st.k + '">From library</button></div>';
    }
    return h + '</div>';
  }
  function viewUtn(u) {
    var c = counts(u);
    var h = '<div class="bar"><button data-act="back" aria-label="Back to list">← Back</button><h1>UTN ' + esc(u.utn) + '</h1><span class="pill' + (c.total && c.have === c.total ? ' done' : '') + '">' + c.have + ' / ' + c.total + '</span></div>';
    h += topBanner();
    h += '<div class="card"><h2>Add segment</h2><div class="chips">';
    LETTERS.forEach(function (L) {
      var used = u.segments.some(function (s) { return s.label === L; });
      h += '<button class="chip" data-act="addseg" data-l="' + L + '"' + (used ? ' disabled' : '') + '>' + L + '</button>';
    });
    h += '</div><form id="f-seg" class="row" autocomplete="off"><input id="in-seg" type="text" placeholder="Other, e.g. A2" aria-label="Other segment" maxlength="12" autocapitalize="characters"><button type="submit">Add</button></form></div>';
    if (!u.segments.length) h += '<div class="empty">Tap a letter to add each segment repaired under this UTN.</div>';
    u.segments.forEach(function (s) {
      var n = STAGES.filter(function (st) { return s.photos[st.k]; }).length;
      h += '<div class="card"><div class="seg-head"><span class="seg-title">Segment ' + esc(s.label) + '</span><span class="pill' + (n === 3 ? ' done' : '') + '" style="margin-left:auto">' + n + ' / 3</span><button class="small danger" data-act="rmseg" data-seg="' + esc(s.id) + '" aria-label="Remove segment ' + esc(s.label) + '">Remove</button></div><div class="stages">';
      STAGES.forEach(function (st) { h += stageHtml(s, st); });
      h += '</div></div>';
    });
    h += '<div class="card"><h2>Export</h2><div class="row"><button class="primary grow" data-act="pdf">Save PDF</button></div><div class="row"><button class="grow" data-act="jpgs">Save to Photos</button><button class="grow" data-act="zip">Photos as ZIP</button></div><p class="note" style="margin:0">PDF: one page per segment. ZIP and Photos use names like ' + esc(u.utn) + '_K_Pre_' + dstr(Date.now()) + '.jpg.</p></div>';
    h += '<button class="danger" data-act="rmutn">Delete this UTN</button>';
    return h;
  }
  function render() {
    urls.forEach(function (x) { URL.revokeObjectURL(x); });
    urls = [];
    var u = state.openId ? getUtn(state.openId) : null;
    if (state.openId && !u) state.openId = null;
    $('#app').innerHTML = u ? viewUtn(u) : viewHome();
  }

  /* ---------- events ---------- */
  document.addEventListener('submit', function (e) {
    e.preventDefault();
    if (e.target.id === 'f-utn') {
      var v = cleanId($('#in-utn').value);
      if (!v) { toast('Enter the UTN number.'); return; }
      var ex = state.utns.filter(function (u) { return u.utn === v; })[0];
      if (ex) { state.openId = ex.id; render(); window.scrollTo(0, 0); return; }
      var rec = { id: uid(), utn: v, created: Date.now(), updated: Date.now(), segments: [] };
      state.utns.push(rec); state.openId = rec.id;
      save(rec).then(function () { render(); window.scrollTo(0, 0); });
    } else if (e.target.id === 'f-seg') {
      var u = getUtn(state.openId);
      var L = cleanId($('#in-seg').value);
      if (!u || !L) { toast('Enter a segment name.'); return; }
      addSeg(u, L);
    }
  });
  function addSeg(u, L) {
    if (u.segments.some(function (s) { return s.label === L; })) { toast('Segment ' + L + ' is already added.'); return; }
    u.segments.push({ id: uid(), label: L, photos: {} });
    save(u).then(render);
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    var u = getUtn(state.openId);
    var seg = b.getAttribute('data-seg'), st = b.getAttribute('data-st');
    if (act === 'open') { state.openId = b.getAttribute('data-id'); render(); window.scrollTo(0, 0); }
    else if (act === 'back') { state.openId = null; render(); window.scrollTo(0, 0); }
    else if (act === 'addseg' && u) addSeg(u, b.getAttribute('data-l'));
    else if (act === 'shoot') pick(seg, st, true);
    else if (act === 'lib') pick(seg, st, false);
    else if (act === 'rmphoto' && u) {
      ask('Remove this photo?', 'Remove').then(function (ok) {
        if (!ok) return;
        var s = u.segments.filter(function (x) { return x.id === seg; })[0];
        if (s) { delete s.photos[st]; save(u).then(render); }
      });
    } else if (act === 'rmseg' && u) {
      var s2 = u.segments.filter(function (x) { return x.id === seg; })[0];
      ask('Remove segment ' + (s2 ? s2.label : '') + ' and its photos?', 'Remove').then(function (ok) {
        if (!ok) return;
        u.segments = u.segments.filter(function (x) { return x.id !== seg; });
        save(u).then(render);
      });
    } else if (act === 'rmutn' && u) {
      ask('Delete UTN ' + u.utn + ' and all its photos from this phone? Export first if you still need them.', 'Delete').then(function (ok) {
        if (!ok) return;
        state.utns = state.utns.filter(function (x) { return x.id !== u.id; });
        state.openId = null;
        dbDel(u.id).then(render);
      });
    } else if (act === 'pdf') doExport('pdf');
    else if (act === 'zip') doExport('zip');
    else if (act === 'jpgs') doExport('jpgs');
  });

  /* ---------- start ---------- */
  render();
  openDb().then(function (d) {
    idb = d;
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    return dbAll();
  }).then(function (all) { state.utns = all; render(); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();
