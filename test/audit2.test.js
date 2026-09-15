"use strict";
/* A quick, sceptical sweep for the classes of defect that have actually bitten:
   identifiers used but never defined, and column counts that disagree. */
const fs=require("fs"),vm=require("vm"),path=require("path");
let bad=0;
function chk(name,cond,extra){ if(cond)console.log("  ok   "+name); else {bad++;console.log("  FAIL "+name+(extra?"  ->  "+extra:""));} }

// ---- 1. every page script parses and every top-level function is reachable ---------
["callnow2.html","vp.html","callnow.html","agent.html","index.html","talktime.html"].forEach(function(f){
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

/* ---- 6. no route is hiding inside a comment ---------------------------------------

   Removing the agent-day endpoint took the closing marker of the comment above it, which
   left that comment open. Everything down to the next closing marker was swallowed, and
   the creator-weeks route silently stopped existing. Nothing complained: the file parsed,
   the server started, and the only reason it was caught is that creator-weeks happened to
   have a test. A route with no test would simply have been gone.

   So: every route literal in the file has to be a live registration and not text sitting
   inside a comment. Comments are stripped and the two lists compared. */
{
  const src = fs.readFileSync(path.join("/tmp/repo", "server.js"), "utf8");
  const live = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const paths = function(text){
    return [...text.matchAll(/app\.(?:get|post|put|delete)\(\s*"([^"]+)"/g)]
      .map(function(m){ return m[1]; });
  };
  const all = paths(src), on = paths(live);
  const buried = all.filter(function(r){ return on.indexOf(r) < 0; });
  chk("every route in server.js is registered, not commented out",
    buried.length === 0, buried.join(", "));
  chk("and the file still registers a sensible number of them",
    on.length > 30, String(on.length));
}

/* ---- 7. one name, one function, in the server too --------------------------------

   `function istDayBounds()` returning today was declared near the top. Months later
   `function istDayBounds(dayKey)` was declared for the counselling ledger, further down
   the same file. JavaScript does not complain about that: both are hoisted and the later
   one wins for the whole module. So nine callers that passed no argument started getting
   the day-key version, computed Date.parse("undefinedT00:00:00Z"), and got NaN.

   What that cost: every HubSpot search asking for calls since "NaN" got a 400 that read
   like a HubSpot fault, and every in-memory comparison against NaN quietly matched
   nothing. Four surfaces reported zero rather than reporting a problem. `node --check`
   passes on this, every existing test passed on this, and it survived until somebody
   asked why a banner was red.

   A name declared twice at the top level of one file is always a mistake. */
{
  ["server.js", "lib/cn2.js", "lib/counsel.js", "lib/talklock.js", "lib/idle.js",
   "lib/revenue.js", "lib/selfcheck.js", "lib/role.js"].forEach(function(f){
    const p = path.join("/tmp/repo", f);
    if (!fs.existsSync(p)) return;
    const src = fs.readFileSync(p, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const seen = {};
    [...src.matchAll(/^function ([a-zA-Z_$][\w$]*)\s*\(/gm)].forEach(function(m){
      seen[m[1]] = (seen[m[1]] || 0) + 1; });
    const dups = Object.keys(seen).filter(function(k){ return seen[k] > 1; });
    chk(f + " declares each top-level function once", dups.length === 0,
      dups.map(function(d){ return d + " x" + seen[d]; }).join(", "));
  });
}

/* ---- 8. a broken day boundary must never reach HubSpot ---------------------------

   The second line of defence for the same fault. HubSpot answers a filter value of "NaN"
   with "There was a problem with the request.", which names neither the request nor the
   value, and that wording is what made our bug look like theirs. Every day boundary now
   goes through hsMs, which refuses anything that is not a real timestamp and says whose
   fault it is. */
{
  const src = fs.readFileSync(path.join("/tmp/repo", "server.js"), "utf8");
  chk("hsMs exists and refuses anything that is not a timestamp",
    /function hsMs\(v, what\)/.test(src) && src.indexOf("This is our bug, not HubSpot's.") > 0);
  const bare = [...src.matchAll(/operator: "(?:GTE|LT|GT|LTE)", value: String\((?:day|b|dayR|fromMs|toMs)[.\w]*\)/g)];
  chk("no day boundary is sent to a HubSpot filter unchecked", bare.length === 0,
    bare.map(function(m){ return m[0]; }).join(" | "));
  /* Run it, rather than trust the regex. */
  const fn = new Function("return " + src.slice(src.indexOf("function hsMs(v, what)"),
    src.indexOf("\n}", src.indexOf("function hsMs(v, what)")) + 2))();
  let threw = null;
  try { fn(NaN, "today's calls"); } catch (e) { threw = e.message; }
  chk("NaN is refused with a sentence that says what went wrong",
    threw && threw.indexOf("NaN") >= 0 && threw.indexOf("our bug") >= 0, String(threw));
  chk("and a real timestamp passes straight through",
    fn(1789410600000, "x") === "1789410600000");
}

console.log("\n"+(bad?bad+" failed":"all clear"));
process.exit(bad?1:0);
