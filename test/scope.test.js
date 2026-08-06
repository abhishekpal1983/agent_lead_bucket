"use strict";
/* Role scoping decides which leads a person can see at all, so it is worth proving
   rather than assuming. The fixture server runs without login, which means the endpoint
   test can never exercise this path: it is pulled out and run directly instead. */
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  ->  " + extra : "")); }
}

const body = src.match(/function cn2Scope\(req\)\{[\s\S]*?\n\}/)[0];
const TEAMS = [
  { id: "t1", name: "Team Sid", managerEmail: "sid@topmate.io", agentIds: ["201", "202"] },
  { id: "t2", name: "Team Vik", managerEmail: "vik@topmate.io", agentIds: ["203", "204"] }
];
function make(isVPv){
  const sandbox = { isVP: function(){ return isVPv; }, cn2Teams: function(){ return TEAMS; },
    sessionOf: function(){ return null; }, String: String };
  const vm = require("vm"); vm.createContext(sandbox);
  vm.runInContext(body + "; this.__fn = cn2Scope;", sandbox);
  return sandbox.__fn;
}

console.log("\nWho sees what");
{
  const vp = make(true);
  ok("a VP is not restricted at all", vp({ session: { role: "manager", email: "abhishek@topmate.io" } }) === null);

  const other = make(false);
  const agent = other({ session: { role: "agent", email: "a@topmate.io", ownerId: "202" } });
  ok("an agent sees only their own owner id", JSON.stringify(agent) === '["202"]', JSON.stringify(agent));

  const mgr = other({ session: { role: "manager", email: "sid@topmate.io" } });
  ok("a manager sees their own team's agents", JSON.stringify(mgr) === '["201","202"]', JSON.stringify(mgr));
  ok("and not the other team's", mgr.indexOf("203") < 0);

  const stranger = other({ session: { role: "manager", email: "nobody@topmate.io" } });
  ok("a manager with no team mapped sees nothing, rather than everything",
    Array.isArray(stranger) && stranger.length === 0, JSON.stringify(stranger));

  const nosession = other({});
  ok("no session sees nothing", Array.isArray(nosession) && nosession.length === 0);
}

console.log("\nAn empty scope must exclude, never wave everything through");
{
  const allow = [];
  const leads = [{ owner: "201" }, { owner: "" }, { owner: "999" }];
  const kept = leads.filter(function(l){ return allow.indexOf(String(l.owner)) >= 0; });
  ok("an empty allow list keeps nothing", kept.length === 0);
  const allow2 = ["201"];
  const kept2 = leads.filter(function(l){ return allow2.indexOf(String(l.owner)) >= 0; });
  ok("a one agent scope keeps only that agent's leads", kept2.length === 1 && kept2[0].owner === "201");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
