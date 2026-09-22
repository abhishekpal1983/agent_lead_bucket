"use strict";
/* The workbook writer, checked by unzipping what it produces.

   A CSV has no tabs, so "one tab per date" needs a real xlsx. This has no dependency
   behind it, which means the ZIP container and the CRCs are ours to get right, and a
   corrupt workbook is the kind of failure somebody meets on a Monday morning with no way
   to diagnose it. So: build one, take it apart, and check the parts. */
const zlib = require("zlib");
const X = require(require("path").join(__dirname, "..", "lib", "xlsx.js"));
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (x ? "  ->  " + x : "")); } };

/* A minimal reader for stored-method zips, so the test does not trust the writer's own
   idea of where anything is. */
function unzip(buf){
  const out = {};
  let i = 0;
  while (i < buf.length - 4 && buf.readUInt32LE(i) === 0x04034b50) {
    const crc = buf.readUInt32LE(i + 14);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString("utf8");
    const data = buf.slice(i + 30 + nameLen + extraLen, i + 30 + nameLen + extraLen + size);
    out[name] = { data: data, crc: crc, declared: size };
    i += 30 + nameLen + extraLen + size;
  }
  return out;
}

console.log("\nCRC32, because the whole archive hangs off it");
{
  ok("the standard check value is right",
    X.crc32(Buffer.from("123456789")) === 0xCBF43926,
    X.crc32(Buffer.from("123456789")).toString(16));
  ok("an empty buffer is zero", X.crc32(Buffer.alloc(0)) === 0);
}

console.log("\nColumn references past Z, which is where naive versions break");
{
  ok("A, Z, AA, AB and AZ are right",
    ["A", "Z", "AA", "AB", "AZ"].join(",") === [0, 25, 26, 27, 51].map(X.colRef).join(","),
    [0, 25, 26, 27, 51].map(X.colRef).join(","));
}

console.log("\nSheet names, which Excel is strict about");
{
  const taken = new Set();
  ok("a date is left alone", X.safeName("2026-09-21", taken) === "2026-09-21");
  ok("the characters Excel refuses are replaced",
    !/[\[\]:*?\/\\]/.test(X.safeName("a/b[c]:d*e?f", new Set())));
  ok("names are cut to 31 characters",
    X.safeName("x".repeat(60), new Set()).length === 31);
  const t2 = new Set();
  const a = X.safeName("Sept", t2), b = X.safeName("Sept", t2);
  ok("a duplicate is numbered rather than silently colliding", a !== b, a + " / " + b);
}

console.log("\nA built workbook comes apart into the parts Excel expects");
{
  const buf = X.build([
    { name: "Total", rows: [["Talktime", "2026-09-21 to 2026-09-22"], [], ["Agent", "Minutes"], ["Hema Bindu C", 50]] },
    { name: "2026-09-21", rows: [["Agent", "Minutes"], ["Hema Bindu C", 37], ["Kushal Singla", 2]] },
    { name: "2026-09-22", rows: [["Agent", "Minutes"], ["Arshdeep Singh", 13]] }
  ]);
  ok("it is a zip", buf.slice(0, 2).toString() === "PK");
  const z = unzip(buf);
  ok("every part Excel requires is present",
    ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels",
     "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml"]
      .every(n => z[n]), Object.keys(z).join(", "));

  /* The CRC in the header has to match the bytes, or the file opens as corrupt. */
  const bad = Object.keys(z).filter(n => X.crc32(z[n].data) !== z[n].crc);
  ok("every entry's stored CRC matches its bytes", bad.length === 0, bad.join(", "));
  const wrongLen = Object.keys(z).filter(n => z[n].data.length !== z[n].declared);
  ok("and every declared length matches too", wrongLen.length === 0, wrongLen.join(", "));

  const wb = z["xl/workbook.xml"].data.toString();
  const names = [...wb.matchAll(/<sheet name="([^"]+)"/g)].map(m => m[1]);
  ok("one tab per date, in the order given, with the total first",
    names.join(",") === "Total,2026-09-21,2026-09-22", names.join(","));

  const s2 = z["xl/worksheets/sheet2.xml"].data.toString();
  ok("a number is written as a number so Excel will sum the column",
    s2.indexOf('<v>37</v>') >= 0 && s2.indexOf('>37<') >= 0);
  ok("text is written inline, so there is no shared string table to fall out of step",
    s2.indexOf('t="inlineStr"') >= 0 && s2.indexOf("Hema Bindu C") >= 0);
  ok("an empty row is still a row, so the layout does not shift",
    z["xl/worksheets/sheet1.xml"].data.toString().indexOf('<row r="2">') >= 0);
}

console.log("\nThings that would make the file refuse to open");
{
  const z = unzip(X.build([{ name: "S", rows: [["a & b <c>", 'say "hi"'], ["ctrlchar", 1]] }]));
  const xml = z["xl/worksheets/sheet1.xml"].data.toString();
  ok("ampersands and angle brackets are escaped",
    xml.indexOf("a &amp; b &lt;c&gt;") >= 0);
  ok("a control character is stripped rather than written raw",
    xml.indexOf("") < 0 && xml.indexOf("ctrlchar") >= 0);
  let threw = null;
  try { X.build([]); } catch (e) { threw = e.message; }
  ok("a workbook with no sheets is refused rather than written empty", !!threw, String(threw));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
