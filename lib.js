/* PDF + ZIP builders. No DOM access, so they can be tested in Node. */
function latin1(s) {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 255;
  return a;
}
function concatBytes(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const o = new Uint8Array(n);
  let p = 0;
  for (const c of chunks) { o.set(c, p); p += c.length; }
  return o;
}

/* ---------- ZIP (store, no compression) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(files, when) {
  const d = when ? new Date(when) : new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  const te = new TextEncoder();
  for (const f of files) {
    const name = te.encode(f.name);
    const crc = crc32(f.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, f.data.length, true);
    lh.setUint32(22, f.data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, f.data.length, true);
    ch.setUint32(24, f.data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdBytes = concatBytes(central);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdBytes.length, true);
  end.setUint32(16, offset, true);
  return concatBytes([...parts, cdBytes, new Uint8Array(end.buffer)]);
}

/* ---------- PDF (US Letter, one page per segment) ---------- */
function pdfEsc(s) {
  return String(s).replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, '\\$&');
}
function fmt(n) { return (Math.round(n * 100) / 100).toString(); }

/*
 opts: { utn, segments:[{label, photos:{pre,during,post}}], stages:[{k,label}], generated }
 photo = { bytes:Uint8Array(JPEG), w, h, when:'dd/mm/yyyy hh:mm' } or null
*/
function buildPdf(opts) {
  const W = 612, H = 792, M = 36, CW = W - 2 * M;
  const stages = opts.stages;
  const segs = opts.segments.length ? opts.segments : [{ label: '-', photos: {} }];
  const objs = [];
  const add = (chunks) => {
    const id = objs.length + 1;
    objs.push(concatBytes([latin1(id + ' 0 obj\n'), ...chunks, latin1('\nendobj\n')]));
    return id;
  };
  for (let i = 0; i < 5; i++) objs.push(null); // 1 catalog, 2 pages, 3 F1, 4 F2, 5 info
  const kids = [];

  segs.forEach((seg, pi) => {
    const ops = [];
    const Y = (t) => H - t; // top-origin to PDF
    const rectFill = (x, top, w, h, rgb) => ops.push(`${rgb} rg ${fmt(x)} ${fmt(Y(top + h))} ${fmt(w)} ${fmt(h)} re f`);
    const rectStroke = (x, top, w, h, rgb, lw) => ops.push(`${lw || 0.8} w ${rgb} RG ${fmt(x)} ${fmt(Y(top + h))} ${fmt(w)} ${fmt(h)} re S`);
    const text = (s, x, baseTop, size, bold, rgb) => ops.push(`BT ${rgb || '0 0 0'} rg /${bold ? 'F2' : 'F1'} ${size} Tf ${fmt(x)} ${fmt(Y(baseTop))} Td (${pdfEsc(s)}) Tj ET`);
    const widthApprox = (s, size, bold) => String(s).length * size * (bold ? 0.6 : 0.52);

    // header
    rectFill(M, 36, CW, 30, '1 0.753 0');
    rectStroke(M, 36, CW, 30, '0 0 0', 1);
    text(opts.title || 'SEGMENT REPAIR INSPECTION CHECKLIST (Photos)', M + 8, 56, 12, true);
    const ref = opts.formNo || '';
    text(ref, M + CW - 8 - widthApprox(ref, 8, true), 55, 8, true);

    // info row
    rectStroke(M, 70, CW, 28, '0 0 0', 0.8);
    ops.push(`0.8 w 0 0 0 RG ${fmt(M + 250)} ${fmt(Y(70))} m ${fmt(M + 250)} ${fmt(Y(98))} l S`);
    ops.push(`0.8 w 0 0 0 RG ${fmt(M + 380)} ${fmt(Y(70))} m ${fmt(M + 380)} ${fmt(Y(98))} l S`);
    text('RING SERIAL NUMBER (UTN)', M + 6, 81, 7, true, '0.35 0.35 0.35');
    text(opts.utn, M + 6, 94, 13, true);
    text('SEGMENT', M + 256, 81, 7, true, '0.35 0.35 0.35');
    text(seg.label, M + 256, 94, 13, true);
    text('PAGE', M + 386, 81, 7, true, '0.35 0.35 0.35');
    text((pi + 1) + ' of ' + segs.length, M + 386, 94, 13, true);

    // stage blocks
    const resImgs = [];
    let top = 106;
    const BLOCK = 214, BAR = 18;
    stages.forEach((st) => {
      rectFill(M, top, CW, BAR, '1 0.753 0');
      rectStroke(M, top, CW, BAR, '0 0 0', 0.8);
      const lbl = st.label;
      text(lbl, M + CW / 2 - widthApprox(lbl, 10, true) / 2, top + 13, 10, true);
      const ph = seg.photos ? seg.photos[st.k] : null;
      if (ph && ph.when) {
        const wtxt = ph.when;
        text(wtxt, M + CW - 6 - widthApprox(wtxt, 7, false), top + 12, 7, false);
      }
      const areaTop = top + BAR, areaH = BLOCK - BAR;
      rectStroke(M, areaTop, CW, areaH, '0.6 0.6 0.6', 0.6);
      if (ph && ph.bytes) {
        const pad = 6, bw = CW - 2 * pad, bh = areaH - 2 * pad;
        const sc = Math.min(bw / ph.w, bh / ph.h);
        const dw = ph.w * sc, dh = ph.h * sc;
        const dx = M + pad + (bw - dw) / 2;
        const dyTop = areaTop + pad + (bh - dh) / 2;
        const name = 'Im' + (resImgs.length + 1);
        const idImg = add([
          latin1(`<< /Type /XObject /Subtype /Image /Width ${ph.w} /Height ${ph.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${ph.bytes.length} >>\nstream\n`),
          ph.bytes,
          latin1('\nendstream'),
        ]);
        resImgs.push(`/${name} ${idImg} 0 R`);
        ops.push(`q ${fmt(dw)} 0 0 ${fmt(dh)} ${fmt(dx)} ${fmt(Y(dyTop + dh))} cm /${name} Do Q`);
      } else {
        const msg = 'No photo taken';
        text(msg, M + CW / 2 - widthApprox(msg, 10, false) / 2, areaTop + areaH / 2 + 3, 10, false, '0.5 0.5 0.5');
      }
      top += BLOCK;
    });

    text('Generated ' + (opts.generated || ''), M, H - 24, 7, false, '0.45 0.45 0.45');

    const stream = latin1(ops.join('\n'));
    const contentId = add([latin1(`<< /Length ${stream.length} >>\nstream\n`), stream, latin1('\nendstream')]);
    const pageId = add([
      latin1(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${contentId} 0 R ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ${resImgs.join(' ')} >> >> >>`
      ),
    ]);
    kids.push(pageId);
  });

  objs[0] = concatBytes([latin1('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')]);
  objs[1] = concatBytes([latin1(`2 0 obj\n<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>\nendobj\n`)]);
  objs[2] = latin1('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n');
  objs[3] = latin1('4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n');
  objs[4] = latin1(`5 0 obj\n<< /Title (${pdfEsc('Segment repair photos - UTN ' + opts.utn)}) /Producer (Pop-Out Repair Photos) >>\nendobj\n`);

  const header = latin1('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const out = [header];
  let pos = header.length;
  const offsets = [];
  for (const o of objs) { offsets.push(pos); out.push(o); pos += o.length; }
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += String(off).padStart(10, '0') + ' 00000 n \n';
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  out.push(latin1(xref));
  return concatBytes(out);
}

if (typeof module !== 'undefined') module.exports = { buildPdf, zipStore, crc32, concatBytes, latin1 };
