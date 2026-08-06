"use strict";
/* Design mockup only. Nothing here is wired to the live app.
   Matrix keeps today's tables exactly as they are; the only change to them is a
   background tint per column group. Hero and What changed today are new. Queue gives the
   lead table the full width and slides a lead card in only when a lead is picked. */
const fs = require("fs");

const TIMING = [["due","Due today"],["over","Overdue"],["nofu","No FU"],["newlead","Fresh"],["sched","Later date"]];
const COLS = [["form","Form"],["score","Score &ge;6"],["intl","Intl"],["fresh","Fresh"],
  ["refill","Refilled form"],["ifc","IFC due"],["needs","Needs owner"],["any","Any priority"],["all","All in stage"]];
// Timing is one question, priority signals another, the last three are totals.
const BAND = { due:"bA", over:"bA", nofu:"bA", newlead:"bA", sched:"bA",
  form:"bB", score:"bB", intl:"bB",
  fresh:"bC", refill:"bC", ifc:"bC",
  needs:"bD", any:"bD", all:"bD" };
const EDGE = { due:1, form:1, fresh:1, needs:1 };
const GROUPS = [["bA","Call today",5],["bB","Priority signals",3],["bC","New information",3],["bD","Totals",3]];

const S = (k,label,tone,o) => Object.assign({ k, label, tone,
  due:0,over:0,nofu:0,newlead:0,sched:0,form:0,score:0,intl:0,fresh:0,refill:0,ifc:0,needs:0,any:0,all:0,
  cdue:0,cover:0,cnofu:0,cnewlead:0,csched:0,cform:0,cscore:0,cintl:0,cfresh:0,crefill:0,cifc:0,cneeds:0,cany:0,call:0 }, o);

const CALL_TODAY = [
  S("counselled","Counselled","blue",{due:92,over:473,nofu:116,form:5,score:65,intl:76,refill:2,needs:473,any:142,all:681,cdue:6,cover:1,cnofu:4,cscore:1,cneeds:1,cany:1,call:11}),
  S("program_pitched","Program pitched","blue",{due:61,over:137,nofu:37,form:1,score:80,intl:9,needs:137,any:87,all:235,cdue:2,cover:6,cscore:6,cneeds:6,cany:6,call:8}),
  S("discovery","Discovery","blue",{due:39,over:122,nofu:55,score:20,intl:23,needs:122,any:43,all:216,cdue:2,cover:1,cscore:1,cneeds:1,cany:1,call:3}),
  S("pricing_pitched","Pricing pitched","blue",{due:11,over:62,nofu:3,score:24,intl:5,needs:62,any:28,all:76,cdue:1,call:1}),
  S("Follow up","Follow up","amber",{due:15,over:48,nofu:8,form:1,score:22,intl:4,needs:48,any:26,all:71,cdue:2,cscore:1,cintl:1,cany:2,call:2}),
  S("payment_prospect","Payment prospect","purple",{due:2,over:44,nofu:6,score:21,intl:2,needs:44,any:21,all:52,cdue:1,cover:4,cnofu:1,cscore:4,cneeds:4,cany:4,call:6}),
  S("FU_DNP","FU - DNP","amber",{due:65,over:312,nofu:19,form:1,score:94,intl:22,needs:312,any:116,all:396,cdue:10,cover:6,cscore:4,cintl:2,cneeds:6,cany:6,call:16}),
  S("FU_RCB","FU - RCB","amber",{due:8,over:66,nofu:5,score:29,intl:5,needs:66,any:32,all:79,cdue:2,cover:2,cscore:4,cneeds:2,cany:4,call:4}),
  S("rcb","RCB - Requested callback","green",{due:66,over:258,nofu:128,score:31,intl:14,needs:258,any:44,all:452,cdue:9,cover:4,cnofu:6,cscore:3,cneeds:4,cany:3,call:19}),
  S("dnp","DNP","red",{due:39,over:149,nofu:73,form:16,score:37,intl:219,refill:8,needs:149,any:261,all:261,cdue:4,cover:2,cscore:2,cintl:9,cany:9,call:9}),
  S("__fresh","Fresh leads","grey",{over:67,newlead:592,form:1,score:1,intl:178,fresh:660,refill:1,any:660,all:660,cover:3,cnewlead:14,cfresh:14,cany:14,call:17})
];
const AHEAD = [
  S("counselled","Counselled","blue",{sched:96,form:1,score:13,intl:4,any:17,all:96,csched:1,cscore:1,cany:1,call:1}),
  S("program_pitched","Program pitched","blue",{sched:40,form:2,score:16,intl:5,refill:1,any:20,all:40}),
  S("discovery","Discovery","blue",{sched:31,score:4,intl:5,any:9,all:31,csched:1,cscore:1,cany:1,call:1})
];
const PARKED = [ S("dnp","DNP","red",{due:223,over:1117,nofu:469,sched:111,needs:1117,all:1920,cdue:12,cover:5,cnofu:2,csched:1,cneeds:5,call:20}) ];

const LEADS = [
  { n:"Ishaan Rao", stage:"FU - DNP", tone:"amber", tags:["FORM","SCORE 10","OVERDUE"], ph:"+91 919737763", fu:"8d overdue", fuCls:"od", last:"23d ago", score:10, agent:"Farah N", creator:"@designdaily", src:"forms", calls:2, own:1, band:"low", days:23 },
  { n:"Manav Pillai", stage:"RCB - Requested callback", tone:"green", tags:["FORM","INTL","OVERDUE"], ph:"+971 578121917", fu:"12d overdue", fuCls:"od", last:"2d ago", score:4, agent:"Farah N", creator:"@payalineurope", src:"forms", calls:5, own:5, band:"avg", days:14 },
  { n:"Sana Iyer", stage:"Program pitched", tone:"blue", tags:["FORM","INTL"], ph:"+971 526274997", fu:"Due today", fuCls:"due", last:"26d ago", score:4, agent:"Farah N", creator:"@designdaily", src:"import", calls:8, own:3, band:"bench", days:26, called:true },
  { n:"Arjun Menon", stage:"FU - DNP", tone:"amber", tags:["FORM","INTL","NO FU"], ph:"+971 556853793", fu:"None set", fuCls:"none", last:"19d ago", score:3, agent:"Sid M", creator:"@ayush_singh13", src:"digital product", calls:1, own:0, band:"low", days:19 },
  { n:"Kiran Ghosh", stage:"RCB - Requested callback", tone:"green", tags:["FORM"], ph:"+91 991982612", fu:"Due today", fuCls:"due", last:"19d ago", score:3, agent:"Sid M", creator:"@ankita_gulati", src:"forms", calls:12, own:9, band:"high", days:31, called:true },
  { n:"Neha Bhatt", stage:"Counselled", tone:"blue", tags:["SCORE 8","OVERDUE"], ph:"+91 887712043", fu:"3d overdue", fuCls:"od", last:"11d ago", score:8, agent:"Rhea K", creator:"@payalineurope", src:"forms", calls:4, own:4, band:"avg", days:11 }
];
const CALLED = 1170, POOL = 4794;
const fmt = n => (n||0).toLocaleString("en-IN");
const pct = (a,b) => b ? Math.round(100*a/b) : 0;

const css = `
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  background:#F4F7FA;color:#0A2540;font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}
.hdr{background:#0A2540;padding:11px 22px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.hdr h1{margin:0;font-size:17px;font-weight:600;color:#fff}
.hdr .badge{background:#F6D6EA;color:#9B2C6F;font-size:11px;font-weight:700;letter-spacing:.06em;padding:3px 10px;border-radius:6px}
.hdr p{margin:0 0 0 auto;font-size:12px;color:#93A7BC}
.seg{display:inline-flex;background:#EFECF7;border-radius:10px;padding:3px;gap:2px}
.seg button{border:0;background:transparent;border-radius:8px;padding:5px 17px;font-size:13px;font-weight:600;color:#7C7A8C;cursor:pointer;font-family:inherit}
.seg button.on{background:#fff;color:#1A1A2E;box-shadow:0 1px 3px rgba(20,20,45,.13)}
.wrap{max-width:1860px;margin:0 auto;padding:15px 20px 60px}
.view{display:none}.view.on{display:block}
h2{font-size:14px;font-weight:600;margin:0 0 3px}
.sub{font-size:12px;color:#566575;margin:0 0 9px;line-height:1.5}
.sec{background:#fff;border:1px solid #DCE4EC;border-radius:11px;padding:12px 14px;margin-bottom:13px}
/* hero */
.herorow{display:grid;grid-template-columns:minmax(0,340px) minmax(0,1fr);gap:13px;margin-bottom:13px}
.hero{background:linear-gradient(135deg,#3B63E0,#4B3FCF 55%,#3E2FA8);border-radius:12px;padding:15px 17px;color:#fff}
.hero .k{font-size:10px;letter-spacing:.11em;text-transform:uppercase;color:#C9D4FA;font-weight:700}
.hero .pctpill{float:right;background:rgba(255,255,255,.19);border-radius:7px;padding:2px 9px;font-size:11.5px;font-weight:700}
.hero .big{font-size:38px;font-weight:700;letter-spacing:-.03em;line-height:1.05;margin:5px 0 2px}
.hero .of{font-size:15px;font-weight:500;color:#C9D4FA;margin-left:5px}
.hero .track{height:6px;border-radius:4px;background:rgba(255,255,255,.24);margin:9px 0 7px;overflow:hidden}
.hero .track i{display:block;height:6px;background:#fff;border-radius:4px}
.hero .foot{font-size:11px;color:#C9D4FA}
.chg{background:#fff;border:1px solid #DCE4EC;border-radius:12px;padding:12px 14px}
.chg .k{font-size:10px;letter-spacing:.11em;text-transform:uppercase;color:#7C8899;font-weight:700;margin-bottom:8px}
.chips{display:flex;gap:7px;flex-wrap:wrap}
.chip{background:#F4F7FA;border:1px solid #E3E9EF;border-radius:8px;padding:6px 11px;font-size:12px;color:#3F5163;cursor:pointer}
.chip b{color:#0A2540;font-size:13.5px;font-variant-numeric:tabular-nums;margin-right:4px}
.chip:hover{border-color:#B7DEE8;background:#EDF6FA}
.chip.on{background:#E8EEFF;border-color:#B9C6F5}.chip.on b{color:#3B63E0}
/* tables, unchanged except the group tints */
.tw{border:1px solid #DCE4EC;border-radius:9px;overflow:auto;max-height:56vh}
table{border-collapse:separate;border-spacing:0;width:100%;font-size:12px}
th{padding:5px 8px;font-size:9.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;white-space:normal;
  line-height:1.2;vertical-align:bottom;position:sticky;top:0;z-index:3;background:#F4F7FA;border-bottom:1px solid #DCE4EC;
  text-align:right;color:#5A6B7D}
th:first-child,td:first-child{text-align:left;position:sticky;left:0;z-index:2;background:#fff;width:150px}
td{padding:4px 8px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;border-bottom:1px solid #F0F4F8}
tbody tr:hover td{background:#FAFCFE}
.cv{font-weight:600;font-size:12.5px}
.cs{font-size:9.5px;color:#8B99A8;line-height:1.2}
.cs b{color:#0A5346}
.z{color:#C3CDD7}
td.cell{cursor:pointer}
td.cell:hover{box-shadow:inset 0 0 0 2px #0091AE}
/* the only change to these tables: a ground colour per column group */
.bA{background:#EEF4FC}.bB{background:#FDF6E7}.bC{background:#EDF7F0}.bD{background:#F2F5F8}
th.bA{background:#E4EDF9;color:#2A5EA8}th.bB{background:#FAEFD8;color:#8A6414}
th.bC{background:#E3F2E9;color:#1C6B4E}th.bD{background:#E9EEF3;color:#4A5A6A}
/* group band sits above the column names, both stay put when the table scrolls */
thead tr.grp th{top:0;z-index:4;text-align:left;font-size:10.5px;letter-spacing:.09em;padding:6px 9px;border-bottom:none}
thead tr.colh th{top:25px;z-index:3}
th.gh{background:#fff}
tr.tot td.bB{background:#F2E8D2}tr.tot td.bC{background:#DEEBE3}tr.tot td.bD{background:#D6DEE7}
tr.grand td.bB{background:#1A2E4A}tr.grand td.bC{background:#14304A}tr.grand td.bD{background:#152A44}
td.edge,th.edge{border-left:2px solid #CFDBE6}
tr.tot td{background:#DCE7F0;font-weight:700;border-top:2px solid #B9CBDC}
tr.tot td:first-child{background:#DCE7F0}
tr.tot td.bA{background:#D2DFEC}
tr.grand td{background:#0A2540;color:#fff}
tr.grand td:first-child{background:#0A2540;color:#fff}
tr.grand td.bA{background:#12304F}
tr.grand .cs,tr.grand .cs b{color:#AFC3D6}
.st{font-size:11px;font-weight:500;padding:1px 7px;border-radius:5px;display:inline-block}
.blue{background:#DCEDF6;color:#0B4A66}.amber{background:#FAEBD7;color:#7A4A08}
.purple{background:#EDE9FE;color:#4B2E9E}.green{background:#DDEFEA;color:#0A5346}
.red{background:#FBE2D8;color:#8C2D12}.grey{background:#EAEFF4;color:#3F5163}
/* board */
.board{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:11px}
.card{background:#fff;border:1px solid #DCE4EC;border-radius:11px;padding:12px 14px}
.card:hover{border-color:#B7DEE8}
.card .top{display:flex;align-items:center;gap:7px;margin-bottom:8px}
.dot{width:8px;height:8px;border-radius:50%;flex:none}
.dot.blue{background:#0091AE}.dot.amber{background:#B8791A}.dot.purple{background:#6D4AC4}
.dot.green{background:#0A7C63}.dot.grey{background:#8B99A8}.dot.red{background:#C0492A}
.card .nm{font-weight:600;font-size:13px}
.card .instage{margin-left:auto;font-size:11px;color:#7C8899}
.card .h2n{font-size:27px;font-weight:700;letter-spacing:-.02em;line-height:1}
.card .h2n span{font-size:12px;font-weight:500;color:#7C8899;margin-left:5px}
.stack{display:flex;height:6px;border-radius:4px;overflow:hidden;margin:9px 0 9px;background:#EDF1F6}
.stack i{display:block;height:6px}
.s1{background:#2F6FE4}.s2{background:#A6357F}.s3{background:#C9D2DD}.s4{background:#1E7A5F}
.brk{display:flex;align-items:center;gap:8px;padding:4px 6px;border-top:1px solid #F0F4F8;font-size:12px;cursor:pointer;border-radius:5px}
.brk:hover{background:#EEF3FF}.brk:hover .v{color:#2F6FE4}
.sw{width:9px;height:9px;border-radius:2px;flex:none}
.brk .v{margin-left:auto;font-weight:600;font-variant-numeric:tabular-nums}
/* queue */
.qrow{display:grid;grid-template-columns:minmax(0,1fr);gap:13px;align-items:start}
.qrow.open{grid-template-columns:minmax(0,1fr) 330px}
/* without min-width:0 a wide table refuses to shrink and slides under the card */
.qrow > *{min-width:0}
.q .tw{overflow-x:auto}
.q td{text-align:left}
.q tr.sel td{background:#EEF3FF}
.q tr.sel td:first-child{background:#EEF3FF;box-shadow:inset 3px 0 0 #3B63E0}
.q tr{cursor:pointer}
.q tr.done td{background:#F7FBF9;color:#6B7A8A}
.q tr.done td b{color:#4A5A6A;font-weight:500}
.tick{display:inline-block;width:15px;height:15px;line-height:15px;text-align:center;border-radius:50%;
  background:#15A34A;color:#fff;font-size:10px;font-weight:700;margin-right:6px;vertical-align:1px}
.q th{text-align:left}
.q td.num,.q th.num{text-align:right}
.q td.phc,.q th.phc{text-align:right;font-variant-numeric:tabular-nums;padding-right:5px}
.q td.wac,.q th.wac{text-align:left;padding-left:5px;width:44px}
.q td.exp{width:26px;text-align:center;color:#0091AE;font-weight:700;cursor:pointer;user-select:none}
[hidden]{display:none !important}
tr.det td{background:#F4F8FB;white-space:normal;font-size:11.5px;color:#3F5163;line-height:1.6;
  padding:0;cursor:default;border-bottom:2px solid #DCE4EC}
/* the detail sits in its own boxed block so it reads as a section under the lead, not as
   another row of the table */
.detbox{border-left:3px solid #0091AE;background:#fff;margin:8px 10px 10px 34px;padding:9px 12px;
  border:1px solid #DCE4EC;border-left:3px solid #0091AE;border-radius:7px}
tr.det b{color:#0A2540}
tr.det + tr{border-top:1px solid #DCE4EC}
.tag{font-size:9.5px;font-weight:700;padding:2px 6px;border-radius:4px;margin-right:3px;display:inline-block}
.t-form{background:#FDF0D8;color:#8A6414}.t-score{background:#DDEFEA;color:#0A5346}
.t-intl{background:#DCEDF6;color:#0B4A66}.t-over{background:#FBE2E8;color:#8C2D4B}.t-nofu{background:#EAEFF4;color:#3F5163}
.wa{background:#15A34A;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;text-decoration:none}
.od{color:#C2185B;font-weight:600}.due{color:#2F6FE4;font-weight:600}.none{color:#8B99A8}
.scorepill{display:inline-block;min-width:24px;text-align:center;background:#EDF1F6;border-radius:5px;padding:1px 6px;font-weight:700}
.scorepill.hi{background:#DDEFEA;color:#0A5346}
.now{background:#fff;border:1px solid #DCE4EC;border-radius:11px;padding:14px 16px;position:sticky;top:13px}
.now .k{font-size:10px;letter-spacing:.11em;text-transform:uppercase;color:#7C8899;font-weight:700}
.now .nm2{font-size:20px;font-weight:700;letter-spacing:-.02em;margin:5px 0 1px}
.now .ph{font-size:13.5px;color:#3F5163}
.kv{display:flex;padding:6px 0;border-top:1px solid #F0F4F8;font-size:12.5px}
.kv .k2{color:#7C8899}.kv .v2{margin-left:auto;font-weight:600;text-align:right}
.effort{display:flex;gap:6px;margin-top:10px}
.eb{flex:1;text-align:center;border:1px solid #E3E9EF;border-radius:7px;padding:6px 4px}
.eb .n{font-size:16px;font-weight:700;line-height:1}
.eb .l{font-size:9px;color:#7C8899;letter-spacing:.03em;text-transform:uppercase;margin-top:2px}
.eb.low{background:#FDECEA;border-color:#F3CFC9}.eb.low .n{color:#8C2D12}
.eb.ok{background:#EAF4F0;border-color:#CCE3DA}.eb.ok .n{color:#0A5346}
.btnrow{display:flex;gap:7px;margin-top:11px}
.btn{flex:1;border:1px solid #DCE4EC;background:#fff;border-radius:7px;padding:7px;font-size:12px;font-weight:600;cursor:pointer;color:#37475A}
.btn.p{background:#3B63E0;border-color:#3B63E0;color:#fff}
.note{font-size:11px;color:#7C8899;margin-top:8px;line-height:1.5}
.cardexp{margin-top:11px;border-top:1px solid #EFF3F7;padding-top:4px}
.expbtn{width:100%;text-align:left;border:0;background:transparent;padding:7px 0;font-size:12.5px;
  font-weight:600;color:#0A2540;cursor:pointer;font-family:inherit;border-bottom:1px solid #F0F4F8}
.expbtn:hover{color:#0091AE}
.expbtn span{color:#0091AE;font-weight:700;margin-right:6px}
.expbody{font-size:11.5px;color:#3F5163;line-height:1.6;padding:8px 10px;margin:0 0 6px;
  background:#F7FAFC;border-left:3px solid #0091AE;border-radius:0 6px 6px 0}
`;

function head(){
  let g = `<tr class="grp"><th class="gh"></th>`;
  GROUPS.forEach(([b, label, span], i) => {
    g += `<th class="gh ${b}${i === 0 || true ? " edge" : ""}" colspan="${span}">${label}</th>`;
  });
  g += "</tr>";
  let h = `<tr class="colh"><th>Stage</th>`;
  TIMING.forEach(c => h += `<th class="${BAND[c[0]]}${EDGE[c[0]]?" edge":""}">${c[1]}</th>`);
  COLS.forEach(c => h += `<th class="${BAND[c[0]]}${EDGE[c[0]]?" edge":""}">${c[1]}</th>`);
  return `<thead>${g}${h}</tr></thead>`;
}
function cellOf(s, k){
  const v = s[k], c = s["c" + k] || 0;
  const cls = BAND[k] + (EDGE[k] ? " edge" : "");
  if (!v) return `<td class="${cls} z">0</td>`;
  return `<td class="cell ${cls}" onclick="openSeg('${s.label.replace(/'/g,"")}','${k}',${v})">
    <div class="cv">${fmt(v)}</div><div class="cs"><b>${fmt(c)}</b> called &middot; ${pct(c,v)}%</div></td>`;
}
function rowsOf(list){
  return list.map(s => `<tr><td><span class="st ${s.tone}">${s.label}</span></td>` +
    TIMING.map(c => cellOf(s, c[0])).join("") + COLS.map(c => cellOf(s, c[0])).join("") + "</tr>").join("");
}
function totOf(label, list, cls){
  const sum = k => list.reduce((a, s) => a + s[k], 0);
  const sumC = k => list.reduce((a, s) => a + (s["c" + k] || 0), 0);
  let h = `<tr class="${cls}"><td>${label}</td>`;
  [...TIMING, ...COLS].forEach(c => {
    const k = c[0], v = sum(k), cc = sumC(k), b = BAND[k] + (EDGE[k] ? " edge" : "");
    const t = label.replace(/'/g, "");
    h += v ? `<td class="cell ${b}" onclick="openSeg('${t}','${k}',${v})"><div class="cv">${fmt(v)}</div>
              <div class="cs">${fmt(cc)} called &middot; ${pct(cc,v)}%</div></td>`
           : `<td class="cell ${b} z" onclick="openSeg('${t}','${k}',0)">0</td>`;
  });
  return h + "</tr>";
}
function section(title, sub, list, isLast){
  return `<div class="sec"><h2>${title}</h2><div class="sub">${sub}</div>
    <div class="tw"><table>${head()}<tbody>${rowsOf(list)}
      ${list.length > 1 ? totOf(title, list, "tot") : ""}
      ${isLast ? totOf("Everything added up", [...CALL_TODAY, ...AHEAD, ...PARKED], "tot grand") : ""}
    </tbody></table></div></div>`;
}
function matrixView(){
  return section("Call today","Due today, overdue by a full working day, no follow-up marked, fresh, an IFC that has come due, or a form refilled since the last call. Click any number for the leads behind it.",CALL_TODAY,false) +
    section("Booked for a later date","The next call is set for a future day. Calls made on them still show, so no effort goes missing.",AHEAD,false) +
    section("DNP, nothing to act on today","Did not pick up, and carrying no reason to call. The DNP leads that do carry one are counted in Call today above.",PARKED,true);
}
function boardView(){
  const cards = CALL_TODAY.map(s => {
    const t = s.due + s.over + s.nofu + s.newlead || 1;
    return `<div class="card">
      <div class="top"><span class="dot ${s.tone}"></span><span class="nm">${s.label}</span>
        <span class="instage">${fmt(s.all)} in stage</span></div>
      <div class="h2n">${fmt(s.any)}<span>any priority</span></div>
      <div class="stack"><i class="s1" style="width:${100*s.due/t}%"></i><i class="s2" style="width:${100*s.over/t}%"></i>
        <i class="s3" style="width:${100*(s.nofu+s.newlead)/t}%"></i></div>
      <div class="brk" onclick="openSeg('${s.label}','due',${s.due})"><span class="sw s1"></span>Due today<span class="v">${fmt(s.due)}</span></div>
      <div class="brk" onclick="openSeg('${s.label}','over',${s.over})"><span class="sw s2"></span>Overdue<span class="v">${fmt(s.over)}</span></div>
      <div class="brk" onclick="openSeg('${s.label}','nofu',${s.nofu})"><span class="sw s3"></span>No follow-up<span class="v">${fmt(s.nofu)}</span></div>
      <div class="brk" onclick="openSeg('${s.label}','score',${s.score})"><span class="sw s4"></span>Score &ge;6<span class="v">${fmt(s.score)}</span></div>
    </div>`;
  }).join("");
  return `<div class="sec"><h2>Board view</h2>
    <div class="sub">One card per stage. The bar splits what is due today, what is overdue and what has no next step.
      Click any line to open those leads in the queue.</div>
    <div class="board">${cards}</div></div>`;
}
function queueView(){
  const tagCls = t => t.indexOf("SCORE")===0 ? "t-score" : t==="FORM" ? "t-form" : t==="INTL" ? "t-intl" : t==="OVERDUE" ? "t-over" : "t-nofu";
  const order = LEADS.map((l, i) => i).sort((a, b) => (LEADS[a].called ? 1 : 0) - (LEADS[b].called ? 1 : 0));
  const rows = order.map((i, pos) => { const l = LEADS[i]; return `<tr id="r${i}" class="${l.called ? "done" : ""}" onclick="pickLead(${i})">
    <td class="exp" onclick="event.stopPropagation();toggleDet(${i})"><span id="x${i}">+</span></td>
    <td class="z">${String(pos+1).padStart(2,"0")}</td>
    <td>${l.called ? '<span class="tick" title="Called today">&#10003;</span>' : ""}<b>${l.n}</b></td>
    <td><span class="st ${l.tone}">${l.stage}</span></td>
    <td>${l.tags.map(t=>`<span class="tag ${tagCls(t)}">${t}</span>`).join("")}</td>
    <td class="phc">${l.ph}</td>
    <td class="wac"><a class="wa" href="#" onclick="event.stopPropagation()">WA</a></td>
    <td class="${l.fuCls}">${l.fu}</td>
    <td>${l.last}</td>
    <td>${l.agent}</td>
    <td>${l.creator}</td>
    <td class="num">${l.calls}</td>
    <td class="num">${l.own}</td>
    <td class="num">${l.days}d</td>
    <td class="num"><span class="scorepill ${l.score>=6?"hi":""}">${l.score}</span></td>
  </tr>
  <tr class="det" id="d${i}" hidden><td colspan="15"><div class="detbox">
    <b>Why this lead can convert:</b> sitting in ${l.stage} for ${l.days}d &middot; ${l.calls} dial(s) in the stage,
    ${l.own} by this agent &middot; last touch ${l.last} &middot; follow-up ${l.fu.toLowerCase()}.<br>
    <b>Form:</b> Payal Waitlist &middot; 2 submissions &middot; last 06 Aug 14:22 &nbsp;
    <b>Last booking:</b> The Complete 2026 Data Analyst Roadmap<br>
    <b>AI call summary:</b> asked about EMI options and batch start date, wants a callback after 7pm.
  </div></td></tr>`; }).join("");
  return `<div class="sec"><h2 id="qtitle">Call queue</h2>
    <div class="sub"><span id="qcount">${LEADS.length} leads</span> &middot; form lead first, then conversion score,
      then overdue follow-up, then international, then longest since last call
</div>
    <div class="qrow" id="qrow">
      <div class="q"><div class="tw" style="max-height:none"><table>
        <thead><tr><th></th><th>#</th><th>Lead</th><th>Stage</th><th>Why call</th><th class="phc">Phone</th>
          <th class="wac"></th><th>Follow-up</th><th>Last call</th><th>Agent</th><th>Creator</th>
          <th class="num">Calls</th><th class="num">By owner</th><th class="num">Days</th><th class="num">Score</th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>
      <div id="nowcard"></div>
    </div></div>`;
}
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Call Now v2 &middot; mockup</title>
<style>${css}</style></head><body>
<div class="hdr"><h1>Call Now v2</h1><span class="badge">MOCKUP</span>
  <span class="seg">
    <button id="b-matrix" class="on" onclick="show('matrix')">Matrix</button>
    <button id="b-queue" onclick="show('queue')">Queue</button>
    <button id="b-board" onclick="show('board')">Board</button>
  </span>
  <p>Design proposal. Numbers are illustrative, nothing is wired to the live app.</p></div>
<div class="wrap">
  <div class="herorow">
    <div class="hero"><span class="pctpill">${pct(CALLED,POOL)}% done</span>
      <div class="k">Called today</div>
      <div class="big">${fmt(CALLED)}<span class="of">/ ${fmt(POOL)}</span></div>
      <div class="track"><i style="width:${pct(CALLED,POOL)}%"></i></div>
      <div class="foot">List locked 02:03 &middot; 5,745 leads</div></div>
    <div class="chg"><div class="k">What changed today</div>
      <div class="chips">
        <span class="chip on"><b>${fmt(CALLED)}</b> called</span>
        <span class="chip"><b>363</b> moved stage</span>
        <span class="chip"><b>211</b> next call date changed</span>
        <span class="chip"><b>5</b> no longer in list</span>
        <span class="chip"><b>2,932</b> barely tried</span>
        <span class="chip"><b>41</b> shown, not counted</span>
      </div>
      <div class="note">Every chip opens those leads. The list is fixed at midnight, so these move only because of what the floor did today.</div>
    </div>
  </div>
  <div id="v-matrix" class="view on">${matrixView()}</div>
  <div id="v-queue" class="view">${queueView()}</div>
  <div id="v-board" class="view">${boardView()}</div>
</div>
<script>
var LEADS=${JSON.stringify(LEADS)};
var LABEL={due:"Due today",over:"Overdue",nofu:"No follow-up",newlead:"Fresh",sched:"Later date",
  form:"Form",score:"Score 6 or more",intl:"International",fresh:"Fresh",refill:"Refilled form",
  ifc:"IFC due",needs:"Needs owner",any:"Any priority",all:"All in stage"};
function show(v){
  ['matrix','queue','board'].forEach(function(k){
    document.getElementById('v-'+k).className='view'+(k===v?' on':'');
    document.getElementById('b-'+k).className=(k===v?'on':'');
  });
}
function toggleCard(i){
  var b=document.getElementById('cb'+i), x=document.getElementById('cx'+i);
  var open=!b.hasAttribute('hidden');
  if(open){b.setAttribute('hidden','');}else{b.removeAttribute('hidden');}
  x.textContent=open?'+':'\u2212';
}
function toggleDet(i){
  var d=document.getElementById('d'+i), x=document.getElementById('x'+i);
  var open=!d.hasAttribute('hidden');
  if(open){d.setAttribute('hidden','');}else{d.removeAttribute('hidden');}
  x.textContent=open?'+':'\u2212';
}
function closeLead(){
  document.querySelectorAll('.q tbody tr').forEach(function(tr){tr.className='';});
  document.getElementById('nowcard').innerHTML='';
  document.getElementById('qrow').className='qrow';
}
function pickLead(i){
  var l=LEADS[i];
  document.querySelectorAll('.q tbody tr').forEach(function(tr,n){tr.className=n===i?'sel':'';});
  document.getElementById('qrow').className='qrow open';
  var bandLabel={low:'Barely tried',avg:'Some effort',bench:'At benchmark',high:'Over-worked'};
  var cls=l.band==='low'?'low':'ok';
  document.getElementById('nowcard').innerHTML=
    '<div class="now"><div class="k">Lead card</div>'+
    '<div class="nm2">'+l.n+'</div><div class="ph">'+l.ph+'</div>'+
    '<div style="margin:8px 0 10px"><span class="st '+l.tone+'">'+l.stage+'</span> '+
      l.tags.map(function(t){var c=t.indexOf('SCORE')===0?'t-score':t==='FORM'?'t-form':t==='INTL'?'t-intl':t==='OVERDUE'?'t-over':'t-nofu';
        return '<span class="tag '+c+'">'+t+'</span>';}).join('')+'</div>'+
    '<div class="kv"><span class="k2">Agent</span><span class="v2">'+l.agent+'</span></div>'+
    '<div class="kv"><span class="k2">Creator</span><span class="v2">'+l.creator+'</span></div>'+
    '<div class="kv"><span class="k2">Source</span><span class="v2">'+l.src+'</span></div>'+
    '<div class="kv"><span class="k2">Conversion score</span><span class="v2">'+l.score+'</span></div>'+
    '<div class="kv"><span class="k2">Follow-up</span><span class="v2 '+l.fuCls+'">'+l.fu+'</span></div>'+
    '<div class="kv"><span class="k2">Last call</span><span class="v2">'+l.last+'</span></div>'+
    '<div class="effort">'+
      '<div class="eb '+cls+'"><div class="n">'+l.calls+'</div><div class="l">In stage</div></div>'+
      '<div class="eb '+cls+'"><div class="n">'+l.own+'</div><div class="l">By this agent</div></div>'+
      '<div class="eb"><div class="n" style="font-size:11.5px;padding-top:3px">'+bandLabel[l.band]+'</div><div class="l">Churn</div></div>'+
    '</div>'+
    '<div class="btnrow"><button class="btn p">Open in HubSpot</button>'+
      '<button class="btn" onclick="closeLead()">Close</button></div>'+
    '<div class="cardexp">'+
      '<button class="expbtn" onclick="toggleCard(0)"><span id="cx0">+</span> Why this lead can convert</button>'+
      '<div id="cb0" hidden class="expbody">Sitting in '+l.stage+' for '+l.days+'d &middot; '+l.calls+
        ' dial(s) in the stage, '+l.own+' by this agent &middot; last touch '+l.last+
        ' &middot; follow-up '+l.fu.toLowerCase()+'.<br><b>Form:</b> Payal Waitlist &middot; 2 submissions &middot; last 06 Aug 14:22'+
        '<br><b>Last booking:</b> The Complete 2026 Data Analyst Roadmap</div>'+
      '<button class="expbtn" onclick="toggleCard(1)"><span id="cx1">+</span> AI call summary</button>'+
      '<div id="cb1" hidden class="expbody">Asked about EMI options and batch start date, wants a callback after 7pm. '+
        'Sounded warm on the programme but wants to compare with one other option first.</div>'+
    '</div></div>';
}
function openSeg(stage,key,n){
  show('queue');
  document.getElementById('qtitle').textContent=stage+' \\u00b7 '+(LABEL[key]||key);
  document.getElementById('qcount').textContent=n.toLocaleString('en-IN')+' leads';
  closeLead();
  window.scrollTo({top:0,behavior:'smooth'});
}
show('matrix');
</script></body></html>`;
fs.writeFileSync(process.argv[2] || "callnow2-mockup.html", page);
console.log("wrote " + (process.argv[2] || "callnow2-mockup.html"));
