"use strict";
/* Tech or not, from a free-text job title. Every string here is one a real lead typed
   into a Topmate form, taken from the portal rather than invented, because the failure
   mode is a confident wrong label in front of an agent about to dial. */
const R = require("../lib/role.js");
let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  ->  " + extra : "")); }
}
const is = function(text, want){
  const got = R.classify(text);
  ok('"' + text + '" reads as ' + (want || "no answer"), got === want, got || "(no answer)");
};

console.log("\nClearly technical");
["software engineer", "senior software engineer", "full stack developer", "devops engineer",
 "qa engineer", "data engineer", "data scientist", "ai/ml engineer", "sde", "sdet",
 "embedded software engineer", "cloud engineer", "site reliability engineer",
 "technical support engineer", "python developer", ".net developer", "salesforce developer"]
  .forEach(function(t){ is(t, "tech"); });

console.log("\nClearly not");
["chef", "waiter", "bartender", "driver", "forklift operator", "warehouse supervisor",
 "accountant", "hr manager", "sales executive", "teacher", "graphic designer",
 "physiotherapist", "safety officer", "civil engineer", "electrician", "cabin crew"]
  .forEach(function(t){ is(t, "nontech"); });

console.log("\nGenuinely either, and said so rather than guessed");
["consultant", "product manager", "project manager", "senior manager", "associate",
 "senior consultant", "student", "fresher", "unemployed", "business man"]
  .forEach(function(t){ is(t, "unclear"); });

console.log("\nThe pairs that share a word, where order decides the answer");
/* Both contain "analyst", and a generic rule would give them the same label. */
is("data analyst", "tech");
is("business analyst", "nontech");
is("cyber security analyst", "tech");
is("financial analyst", "nontech");
is("qa analyst", "tech");
is("operations analyst", "nontech");
/* Both contain "engineer": one builds software, one builds bridges. */
is("software engineer", "tech");
is("civil engineer", "nontech");
is("mechanical engineer", "nontech");
is("network engineer", "tech");

console.log("\nA non-answer is not an ambiguous answer");
["", "na", "n/a", "none", "nothing", "no", "2000", "8", "-"].forEach(function(t){ is(t, ""); });
ok("because a lead who skipped the question must not be labelled Unclear",
  R.classify("na") === "" && R.classify("consultant") === "unclear");

console.log("\nWhichever field the creator asked in");
ok("the most used field wins when several are set",
  R.roleOf({ what_is_your_current_role: "chef", current_role: "software engineer" }).text === "chef");
ok("and a lead with none of them has no role",
  R.roleOf({ firstname: "x" }).text === "" && R.techOf({ firstname: "x" }).tech === "");
ok("the classification carries the words it judged, so a wrong call can be traced",
  R.techOf({ your_current_role: "Senior DevOps Engineer" }).role === "Senior DevOps Engineer" &&
  R.techOf({ your_current_role: "Senior DevOps Engineer" }).tech === "tech");

console.log("\nMessy input does not throw");
[null, undefined, 12345, "   ", "!!!", "a".repeat(500)].forEach(function(t){
  let threw = false;
  try { R.classify(t); } catch (e) { threw = true; }
  ok("survives " + JSON.stringify(String(t).slice(0, 12)), !threw);
});

/* The axis follows the creator: Simran asks tech, the relocation cohorts ask collar. */
console.log("\nWhich question a creator is asking");
ok("Simran's leads are read tech against non-tech", R.axisFor("simrankhokha") === "tech");
ok("Payal's and Priyanka's on blue against white collar",
  R.axisFor("payalineurope") === "collar" && R.axisFor("wanderess_priyanka") === "collar");
ok("a creator nobody assigned an axis gets no chip rather than the wrong one",
  R.axisFor("ayush_singh13") === "" &&
  R.readingOf({ what_is_your_current_role: "chef" }, "ayush_singh13").value === "");

console.log("\nBlue collar and white collar");
["welder", "electrician", "forklift operator", "chef", "driver", "housekeeping",
 "security guard", "farmer", "warehouse supervisor", "nurse"]
  .forEach(function(t){ ok('"' + t + '" is blue collar', R.classifyCollar(t) === "blue", R.classifyCollar(t)); });
["software engineer", "accountant", "hr manager", "civil engineer", "teacher",
 "data analyst", "lawyer", "marketing manager"]
  .forEach(function(t){ ok('"' + t + '" is white collar', R.classifyCollar(t) === "white", R.classifyCollar(t)); });
["student", "fresher", "freelancer", "business man"]
  .forEach(function(t){ ok('"' + t + '" is neither', R.classifyCollar(t) === "unclear", R.classifyCollar(t)); });

/* The same words, read differently depending on who is asking. This is the whole point of
   having two axes rather than one. */
ok("a welder is non-tech to Simran and blue collar to Payal",
  R.readingOf({ what_is_your_current_role: "welder" }, "simrankhokha").value === "nontech" &&
  R.readingOf({ what_is_your_current_role: "welder" }, "payalineurope").value === "blue");
ok("and an accountant is non-tech to Simran but white collar to Payal",
  R.readingOf({ what_is_your_current_role: "accountant" }, "simrankhokha").value === "nontech" &&
  R.readingOf({ what_is_your_current_role: "accountant" }, "payalineurope").value === "white");

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
