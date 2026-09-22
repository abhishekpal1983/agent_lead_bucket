'use strict';
/* A minimum viable .xlsx writer, because a CSV has no tabs.

   The ask was one tab per date in the download. CSV is a single flat sheet by definition,
   so the only honest way to give somebody a tab per day is a real workbook. That is a ZIP
   of a few XML parts, which Node can build with nothing installed, so this file exists
   rather than a dependency.

   Deliberately small. Inline strings so there is no shared string table to keep in sync,
   stored entries so there is no compression to get wrong, and numbers written as numbers
   so Excel sums them without anyone retyping a column. */

const NUM_RE = /^-?\d+(\.\d+)?$/;

/* CRC32, which the ZIP central directory requires for every entry. */
let TABLE = null;
function crcTable(){
  if (TABLE) return TABLE;
  TABLE = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    TABLE[i] = c;
  }
  return TABLE;
}
function crc32(buf){
  const t = crcTable();
  let c = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ t[(c ^ buf[i]) & 0xFF];
  return (c ^ (-1)) >>> 0;
}

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    /* Excel refuses to open a file containing a raw control character, and a stray one in
       a lead name would take the whole workbook down rather than one cell. */
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/* Excel's own limits, not ours. A sheet name over 31 characters, or carrying any of
   []:*?/\, makes the file unopenable rather than merely ugly. Duplicates do the same, so
   they are numbered. */
function safeName(name, taken){
  let s = String(name || 'Sheet').replace(/[\[\]:*?\/\\]/g, '-').slice(0, 31).trim() || 'Sheet';
  if (!taken) return s;
  let out = s, n = 2;
  while (taken.has(out.toLowerCase())) {
    const tail = ' (' + n + ')';
    out = s.slice(0, 31 - tail.length) + tail;
    n++;
  }
  taken.add(out.toLowerCase());
  return out;
}

function colRef(i){
  let s = '', n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function sheetXml(rows){
  const out = [];
  (rows || []).forEach(function(row, r){
    const cells = [];
    (row || []).forEach(function(v, c) {
      const ref = colRef(c) + (r + 1);
      if (v === null || v === undefined || v === '') return;
      const s = String(v);
      /* A number stays a number so the column adds up in Excel. Anything that merely looks
         numeric but is not exactly numeric, a date or an id with a leading zero, stays
         text, because Excel silently reformats what it thinks is a number. */
      if (typeof v === 'number' && isFinite(v)) {
        cells.push('<c r="' + ref + '"><v>' + v + '</v></c>');
      } else if (NUM_RE.test(s) && String(Number(s)) === s) {
        cells.push('<c r="' + ref + '"><v>' + s + '</v></c>');
      } else {
        cells.push('<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + esc(s) + '</t></is></c>');
      }
    });
    out.push('<row r="' + (r + 1) + '">' + cells.join('') + '</row>');
  });
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData>' + out.join('') + '</sheetData></worksheet>';
}

/* A ZIP with stored entries. No compression, because a talktime workbook is a few tens of
   kilobytes and a deflate bug is a corrupt file somebody cannot open on a Monday. */
function zip(files){
  const locals = [], central = [];
  let offset = 0;
  files.forEach(function(f){
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0x0800, 6);      // UTF-8 names
    lh.writeUInt16LE(0, 8);           // stored
    lh.writeUInt16LE(0, 10);          // time
    lh.writeUInt16LE(0x21, 12);       // date, 1 Jan 1980
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);

    offset += 30 + name.length + data.length;
  });

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), cd, eocd]);
}

/* sheets: [{ name, rows: [[cell, cell, ...], ...] }] in the order the tabs should appear. */
function build(sheets){
  const list = (sheets || []).filter(Boolean);
  if (!list.length) throw new Error('a workbook needs at least one sheet');
  const taken = new Set();
  const named = list.map(function(s){ return { name: safeName(s.name, taken), rows: s.rows || [] }; });

  const files = [
    { name: '[Content_Types].xml', data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      named.map(function(s, i){
        return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }).join('') +
      '</Types>' },
    { name: '_rels/.rels', data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>' },
    { name: 'xl/workbook.xml', data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      named.map(function(s, i){
        return '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
      }).join('') +
      '</sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      named.map(function(s, i){
        return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
      }).join('') +
      '</Relationships>' }
  ];
  named.forEach(function(s, i){
    files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: sheetXml(s.rows) });
  });
  return zip(files);
}

module.exports = { build, zip, sheetXml, safeName, colRef, crc32 };
