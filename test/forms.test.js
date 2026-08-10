"use strict";
/* Matching a creator to their form, by name.

   The old list was three hard-coded waitlist forms against ten tracked creators, so a
   lead who filled anybody else's form showed the form name and nothing to read. Naming
   three more would only have postponed it; the list going stale on the next creator is
   the actual defect. So the match is by name, and this pins what "by name" means. */
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
// Lifted out of server.js rather than copied, so the test cannot pass against a stale
// copy of the rule. Built with Function rather than eval, because eval under "use strict"
// keeps its declarations to itself.
const creatorMatchesForm = new Function(
  src.slice(src.indexOf("function nameKey("), src.indexOf("async function discoverForms")) +
  "; return creatorMatchesForm;")();

let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  ->  " + extra : "")); }
}

// A creator handle and their form are the same person however they are spelled.
[["ayush_singh13", "Ayush Waitlist"],
 ["payalineurope", "Payal Waitlist"],
 ["wanderess_priyanka", "Priyanka Waitlist"],
 ["ankita_gulati", "Ankita Gulati Waitlist"],
 ["simrankhokha", "Simran Khokha Waitlist"],
 ["technomanagers", "Technomanagers Waitlist"],
 ["saurav_chaudhary_1", "Saurav Chaudhary Waitlist"],
 ["vijaychandola", "Vijay Chandola Waitlist"]
].forEach(function(p){
  ok("matches " + p[0] + " to " + p[1], creatorMatchesForm(p[0], p[1]) === true);
});

// And a form belonging to somebody else is not theirs. This is the important half: a
// wrong match would put another creator's answers on a lead card.
[["ayush_singh13", "Payal Waitlist"],
 ["payalineurope", "Ayush Waitlist"],
 ["simrankhokha", "Priyanka Waitlist"],
 ["vijaychandola", "Ankita Gulati Waitlist"]
].forEach(function(p){
  ok("does not match " + p[0] + " to " + p[1], creatorMatchesForm(p[0], p[1]) === false);
});

// Nor does a generic form belong to anybody.
["General Contact Us", "Newsletter Signup", "Demo Request", "Contact", "Book a call"]
  .forEach(function(f){
    ok("no creator owns \"" + f + "\"",
      ["ayush_singh13", "payalineurope", "simrankhokha"].every(function(c){
        return creatorMatchesForm(c, f) === false; }));
  });

// Short or empty handles must never match, or every form becomes everybody's.
ok("a handle too short to be distinctive matches nothing", creatorMatchesForm("abc", "ABC Waitlist") === false);
ok("an empty handle matches nothing", creatorMatchesForm("", "Ayush Waitlist") === false);
ok("an empty form name matches nothing", creatorMatchesForm("ayush_singh13", "") === false);
ok("punctuation and case are ignored", creatorMatchesForm("Ayush_Singh13", "  ayush   waitlist  ") === true);

// The guard that keeps discovery from changing what counts as a priority lead.
ok("discovery only considers forms that look like a waitlist",
  src.indexOf('const FORM_INCLUDE = (process.env.FORM_INCLUDE || "waitlist")') >= 0 &&
  src.indexOf("must not change meaning") >= 0);
ok("a hand-named form is never dropped by discovery",
  src.indexOf("Whatever was named by hand stays named by hand") >= 0);
ok("and a creator with no form is reported rather than left silent",
  src.indexOf("noFormFor: FORM_LIST.unmatched") >= 0 &&
  src.indexOf("creatorsWithoutForm:") >= 0);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
