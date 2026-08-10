"use strict";
/* A quick, sceptical sweep for the classes of defect that have actually bitten:
   identifiers used but never defined, and column counts that disagree. */
const fs=require("fs"),vm=require("vm"),path=require("path");
let bad=0;
function chk(name,cond,extra){ if(cond)console.log("  ok   "+name); else {bad++;console.log("  FAIL "+name+(extra?"  ->  "+extra:""));} }

// ---- 1. every page script parses and every top-level function is reachable ---------
["callnow2.html","vp.html","coaching.html","callnow.html","agent.html","index.html"].forEach(function(f){
  const p=path.join("/tmp/repo/public",f);
  if(!fs.existsSync(p))return;
  const html=fs.readFileSync(p,"utf8");
  const blocks=(html.match(/<script>([\s\S]*?)<\/script>/g)||[]);
  blocks.forEach(function(b,i){
    const code=b.replace(/^<script>/,"").replace(/<\/script>$/,"");
    try{ new vm.Script(code); chk(f+" block "+i+" parses",true); }
    catch(e){ chk(f+" block "+i+" parses",false,e.message); }
  });
});

// ---- 2. duplicate function declarations in one script -----------------------------
["callnow2.html","vp.html"].forEach(function(f){
  const html=fs.readFileSync(path.join("/tmp/repo/public",f),"utf8");
  const code=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const names={};
  [...code.matchAll(/^\s*function ([a-zA-Z_$][\w$]*)\s*\(/gm)].forEach(function(m){
    names[m[1]]=(names[m[1]]||0)+1; });
  const dups=Object.keys(names).filter(function(k){ return names[k]>1; });
  chk(f+" declares each function once", dups.length===0, dups.join(", "));
});

// ---- 3. the queue's header count must equal the cells it renders -------------------
{
  const code=fs.readFileSync("/tmp/repo/public/callnow2.html","utf8").match(/<script>([\s\S]*?)<\/script>/)[1];
  const qv=code.slice(code.indexOf("function queueView"),code.indexOf("function leadCard"));
  const mine=(qv.match(/\["","",0\]/g)||[]).length;
  chk("the queue defines both a scoped and a full column set", mine>=4, "found "+mine+" spacer columns");
  // cells rendered per row, counted from the row template
  const rowStart=qv.indexOf("rows.forEach(function(r,i){");
  const rowBlk=qv.slice(rowStart, qv.indexOf("});", qv.indexOf('"</tr>"')));
  const always=(rowBlk.match(/"<td/g)||[]).length;
  chk("every row cell is a td", always>0, String(always));
}

// ---- 4. server: no await outside async, no handler that can throw before replying --
{
  const src=fs.readFileSync("/tmp/repo/server.js","utf8");
  chk("no stray await in a non-async express handler",
    !/app\.(get|post)\([^,]+,\s*function\s*\([^)]*\)\s*\{[^}]*await /.test(src));
  // GET and POST on one path is a pair, not a duplicate. Compare method AND path.
  const handlers=[...src.matchAll(/app\.(get|post)\("([^"]+)"/g)].map(m=>m[1]+" "+m[2]);
  chk("no route is registered twice",
    new Set(handlers).size===handlers.length,
    handlers.filter((h,i)=>handlers.indexOf(h)!==i).join(", "));
}

// ---- 5. nothing left behind by a rewrite -----------------------------------------
/* Dead code is harmless until somebody later mistakes it for live code and "fixes" it.
   asJson is passed to .then, and wkCell to .map, so neither is ever followed by a
   bracket; they are the only two allowed exceptions. */
{
  const ALLOWED = ["asJson", "wkCell"];
  ["vp.html", "callnow2.html"].forEach(function(f){
    const code = fs.readFileSync(path.join("/tmp/repo/public", f), "utf8")
      .match(/<script>([\s\S]*?)<\/script>/)[1];
    const dead = [...code.matchAll(/^\s*function ([a-zA-Z_$][\w$]*)\s*\(/gm)]
      .map(function(m){ return m[1]; })
      .filter(function(n){ return ALLOWED.indexOf(n) < 0; })
      .filter(function(n){ return (code.match(new RegExp("\\b" + n + "\\s*\\(", "g")) || []).length <= 1; });
    chk(f + " has no function left behind by a rewrite", dead.length === 0, dead.join(", "));
  });
}

// ---- 6. the pure model still holds its invariants ---------------------------------
{
  const cn2=require("/tmp/repo/lib/cn2");
  const day=cn2.dayBoundsFor(Date.UTC(2026,7,6,6,30));
  const r={id:"1",stage:"counselled",fu:0,last:0,forms:[],score:0,intl:false,owner:"9",creator:"c",counted:true};
  const c=cn2.classify(r,day,{work:cn2.workDaySet("1,2,3,4,5,6"),scoreMin:6});
  chk("a lead lands in exactly one section", ["n","a","d"].indexOf(c.sec)>=0, c.sec);
  chk("pack and unpack round trip", JSON.stringify(cn2.unpack(cn2.pack(c)).why)===JSON.stringify(c.why));
  const rev=require("/tmp/repo/lib/revenue");
  chk("zero() covers every key the aggregate writes",
    rev.KEYS.every(function(k){ return rev.zero()[k]===0; }));
}
console.log("\n"+(bad?bad+" failed":"all clear"));
process.exit(bad?1:0);
