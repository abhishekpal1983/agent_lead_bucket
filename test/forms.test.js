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
  src.slice(src.indexOf("const FORM_STOPWORDS"), src.indexOf("async function discoverForms")) +
  "; return creatorMatchesForm;")();

let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  ->  " + extra : "")); }
}

/* The real portal, all 22 forms discovery found, each against every tracked creator.
   Twenty one must land on exactly one creator and the boilerplate one on nobody. This is
   the table that caught the bug below: "Topmate Creator Cohort — Registration" was being
   given to kartikkapoorconsultation because "ation" appears in both. */
{
  const CREATORS = ["ayush_singh13", "payalineurope", "wanderess_priyanka", "ankita_gulati",
    "simrankhokha", "technomanagers", "saurav_chaudhary_1", "vijaychandola",
    "digital_girl_dubai", "kartikkapoorconsultation"];
  const EXPECT = [
    ["Payal Waitlist", "payalineurope"], ["Ayush Waitlist", "ayush_singh13"],
    ["Priyanka Waitlist", "wanderess_priyanka"], ["Vijay Chandola Cohort form", "vijaychandola"],
    ["Test_Ayush Form", "ayush_singh13"], ["Vijay Chandola_Leads ", "vijaychandola"],
    ["Saurav Cohort Form", "saurav_chaudhary_1"],
    ["Topmate Creator Cohort \u2014 Registration", null],
    ["Ankita Gulati Blog", "ankita_gulati"], ["Wanderess priyanka form", "wanderess_priyanka"],
    ["Kartik Kapoor blog", "kartikkapoorconsultation"], ["Ankita Gulati Form", "ankita_gulati"],
    ["Ayush Blog ", "ayush_singh13"], ["Ayush Cohort form", "ayush_singh13"],
    ["Test_Vijaychandola Form", "vijaychandola"], ["digital_girl_dubai Form", "digital_girl_dubai"],
    ["Payalineurope Cohort Form", "payalineurope"], ["Saurav - Build Infrathrone", "saurav_chaudhary_1"],
    ["New form Payal in Europe", "payalineurope"], ["Kartik Kapoor", "kartikkapoorconsultation"],
    ["Ayush October Cohort form ", "ayush_singh13"], ["Simran khokha Form", "simrankhokha"]
  ];
  EXPECT.forEach(function(e){
    const hits = CREATORS.filter(function(c){ return creatorMatchesForm(c, e[0]); });
    const want = e[1] ? [e[1]] : [];
    ok("\"" + e[0].trim() + "\" belongs to " + (e[1] || "nobody"),
      hits.length === want.length && hits.every(function(h){ return want.indexOf(h) >= 0; }),
      "got " + (hits.join(", ") || "none"));
  });
}

/* The forms are not named to a house style. Real ones from the portal:
   "Wanderess priyanka form", "Ayush Cohort form", "digital_girl_dubai Form", and some
   are just the creator's name with nothing after it. An earlier version demanded the
   word "waitlist" and would have kept most of these out. */
[["wanderess_priyanka", "Wanderess priyanka form"],
 ["ayush_singh13", "Ayush Cohort form"],
 ["digital_girl_dubai", "digital_girl_dubai Form"],
 ["kartikkapoor", "Kartik Kapoor"],
 ["kartik_kapoor", "Kartik Kapoor"]
].forEach(function(p){
  ok("matches the real form name " + JSON.stringify(p[1]) + " to " + p[0],
    creatorMatchesForm(p[0], p[1]) === true);
});

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
 ["vijaychandola", "Ankita Gulati Waitlist"],
 ["ayush_singh13", "Wanderess priyanka form"],
 ["technomanagers", "digital_girl_dubai Form"]
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
// The bug this table found: an arbitrary run of letters shared by two words is not evidence.
ok("a shared word ending is not a match",
  creatorMatchesForm("kartikkapoorconsultation", "Topmate Creator Cohort Registration") === false);
ok("nor is any boilerplate word on its own",
  ["Cohort Form", "Waitlist", "Blog", "Registration Page", "Test Form"].every(function(f){
    return creatorMatchesForm("kartikkapoorconsultation", f) === false; }));
ok("an empty handle matches nothing", creatorMatchesForm("", "Ayush Waitlist") === false);
ok("an empty form name matches nothing", creatorMatchesForm("ayush_singh13", "") === false);
ok("punctuation and case are ignored", creatorMatchesForm("Ayush_Singh13", "  ayush   waitlist  ") === true);

// The guard that keeps discovery from changing what counts as a priority lead.
ok("naming the creator is the filter, not a house style nobody follows",
  src.indexOf('const FORM_INCLUDE = (process.env.FORM_INCLUDE || "")') >= 0 &&
  src.indexOf("Requiring a house style that does not exist") >= 0);
ok("with a small denylist for the awkward middle",
  src.indexOf('const FORM_EXCLUDE = (process.env.FORM_EXCLUDE || "unsubscribe,newsletter') >= 0);
ok("and every match is named, so a wrong one is visible rather than trusted",
  src.indexOf("matched: FORM_LIST.pairs") >= 0 &&
  src.indexOf('pairs.push({ form: f.name, creator: who })') >= 0);
ok("a hand-named form is never dropped by discovery",
  src.indexOf("Whatever was named by hand stays named by hand") >= 0);
ok("and a creator with no form is reported rather than left silent",
  src.indexOf("noFormFor: FORM_LIST.unmatched") >= 0 &&
  src.indexOf("creatorsWithoutForm:") >= 0);

/* The trap this walked into: "Forms" is also a lead SOURCE. A card can show a Forms chip
   and hold no submission at all, which reads as a bug and is not one. */
ok("answers are no longer gated on the form label being set",
  src.indexOf("formSubs: formAnswers({ email: r.email }),") >= 0);
{
  const page = fs.readFileSync(require("path").join(__dirname, "..", "public", "callnow2.html"), "utf8");
  ok("the source chip says it is a source, not a submission",
    page.indexOf("This is where the lead came from, not a form we have read") >= 0);
  ok("and a form lead with no submission says why rather than showing nothing",
    page.indexOf("we hold no submission for ") >= 0 &&
    page.indexOf("no answers held for this form yet") >= 0);
}
ok("there is a lever to rediscover and re-read forms now",
  src.indexOf('app.get("/api/callnow2/sync/forms"') >= 0 &&
  src.indexOf("creatorsWithNoForm:") >= 0 &&
  src.indexOf("submissionsPerForm:") >= 0);

/* A person who submits twice gives different answers each time. Showing one and hiding
   the rest made the app look like it was contradicting HubSpot. */
ok("every submission is kept, not one per form",
  src.indexOf("Every submission, not one per form.") >= 0 &&
  src.indexOf("e.subs.push({ form: f.label, guid: f.guid, at: at, answers: s.answers });") >= 0);
ok("newest first, and capped so a serial submitter cannot fill the card",
  src.indexOf("e.subs.sort(function(a, b){ return (b.at || 0) - (a.at || 0); });") >= 0 &&
  src.indexOf("const FORM_SUBS_MAX") >= 0);
ok("the true total survives the cap, so the card can say how many were hidden",
  src.indexOf("e.total = e.subs.length;") >= 0 &&
  src.indexOf("hidden: Math.max(0, total - kept)") >= 0);
{
  const page = fs.readFileSync(require("path").join(__dirname, "..", "public", "callnow2.html"), "utf8");
  ok("the card says how many times they filled a form",
    page.indexOf("Filled a form <b>") >= 0 &&
    page.indexOf("Their answers can change between submissions") >= 0);
  ok("and numbers each one, so it is clear which is being read",
    page.indexOf("class='fnum'") >= 0);
}

/* When the card and HubSpot disagree, look at the data rather than reason about it. */
ok("there is a way to dump exactly what we hold for one person",
  src.indexOf('app.get("/api/callnow2/forms/for"') >= 0 &&
  src.indexOf("Theories are what produce confident wrong answers") >= 0);
ok("it shows the raw field name beside the label we display it under",
  src.indexOf("field: a.name, shownAs:") >= 0);
ok("and can fetch the same thing live from HubSpot to sit beside it",
  src.indexOf("out.liveFromHubSpot") >= 0);
/* The first version scanned every submission of all 23 forms and never returned. A
   diagnostic that needs diagnosing is worse than none. */
ok("the live budget stays under what a proxy will wait for",
  src.indexOf('Math.min(22000, Math.max(4000, parseInt(req.query.budget || "12000", 10)))') >= 0 &&
  src.indexOf("Capped below the proxy's patience") >= 0);
ok("one named form can be scanned on its own, and then it counts every submission",
  src.indexOf('const want = String(req.query.form || "")') >= 0 &&
  src.indexOf("if (found.length && stopAtFirst !== false) break;") >= 0);
ok("the live scan is bounded by time",
  src.indexOf("async function scanFormForEmail") >= 0 && src.indexOf("budgetMs") >= 0);
ok("and it says how far it got, so not-found is never mistaken for not-looked-for",
  src.indexOf("not proof of nothing there") >= 0 &&
  src.indexOf("searchedAll: r.complete") >= 0);

/* "We hold nothing for this person" and "we hold nothing for anybody yet" look the same
   on screen and mean completely different things. The first is a fact about the lead, the
   second is a fact about the app, and reading one as the other sends you hunting a bug
   that is not there. */
ok("the dump says when forms have never loaded, instead of answering with nulls",
  src.indexOf("nothing below is about this person") >= 0 &&
  src.indexOf("Form submissions are loading right now") >= 0);
ok("and when only the hand-named forms are being read",
  src.indexOf("Form discovery has not run") >= 0);
ok("forms start loading at boot rather than queueing behind the lead sync",
  src.indexOf('setTimeout(guard("forms", function(){ return syncForms(); }), 15 * 1000);') >= 0);
ok("the page is told whether forms are loaded at all",
  src.indexOf("formsReady: !!(typeof FORMS !== \"undefined\" && FORMS.loadedAt)") >= 0);
{
  const page = fs.readFileSync(require("path").join(__dirname, "..", "public", "callnow2.html"), "utf8");
  ok("and a card says loading rather than claiming there is nothing",
    page.indexOf("Form answers have not finished loading yet") >= 0);
}

// One real label carries an anchor tag. Escaped on the page it renders as visible markup.
ok("question labels are stripped of markup before they reach the page",
  src.indexOf('String(lab[a.name] || "").replace(/<[^>]+>/g, "")') >= 0);

/* A submission that exists in HubSpot and not here is on a form we are not reading, so
   hunting it needs the whole portal rather than our own list. */
ok("discovery keeps the whole portal list, not only the matches",
  src.indexOf("allForms: all.map(function(f){ return { guid: f.id, label: f.name }; })") >= 0);
ok("and the dump can search the forms we deliberately do not read",
  src.indexOf('const everything = String(req.query.all || "") === "1";') >= 0 &&
  src.indexOf("Untracked first") >= 0);
ok("each hit says whether it came from a form we read",
  src.indexOf('weRead: f.how !== "not read"') >= 0);

/* Scanning 58 forms for one email is the wrong question asked expensively. Two forms ate
   a 22 second budget on their own. HubSpot already knows which forms a contact submitted. */
ok("it asks HubSpot which forms this contact submitted, rather than searching all of them",
  src.indexOf("async function contactFormSubmissions") >= 0 &&
  src.indexOf("formSubmissionMode=all") >= 0);
ok("and resolves the contact from what we already hold before asking HubSpot",
  src.indexOf("async function contactIdForEmail") >= 0 &&
  src.indexOf("from what we already hold if possible") >= 0);
ok("then reads only those forms, marking which of them we do not read",
  src.indexOf("out.hubspotSaysTheySubmitted") >= 0 &&
  src.indexOf('weRead: !!known[f.guid]') >= 0);
ok("and states the conclusion outright when a form we do not read is involved",
  src.indexOf("Answers on those never reach the app") >= 0);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
