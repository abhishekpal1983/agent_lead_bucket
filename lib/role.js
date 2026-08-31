"use strict";
/* Tech or not, from a free-text job title.

   There is no tech/non-tech field in HubSpot. The forms ask "what is your current role"
   and the lead types whatever they like: "software engineer", "chef", "forklift operator",
   "i don't have one atm". So this is a classification, and a classification is wrong
   sometimes. Two decisions follow from that.

   Order matters more than the word lists. "data analyst" is tech and "business analyst" is
   not, and both contain "analyst", so the specific patterns are tested before the general
   ones and the first match wins.

   And there is a third answer. Titles like consultant, manager, associate or executive
   genuinely go either way, and forcing them into tech or non-tech would put a confident
   wrong label in front of an agent about to dial. They come back unclear, which tells the
   agent to ask rather than to assume. */

// First match wins, so anything specific must sit above anything general.
// Each pattern allows the word to carry on, because the lists hold stems. Ending them at
// a word boundary meant "physiotherap" did not match "physiotherapist" and the lead fell
// through to unclear.
const RULES = [
  // Specific enough to settle an otherwise ambiguous word.
  [/\b(data|business intelligence|bi|ml|ai|machine learning|analytics)\s*(and\s*ai\s*)?(engineer|scientist|analyst|architect)\w*/, "tech"],
  [/\b(cyber ?security|security|information security|infosec|systems?|network|cloud|devops|qa|quality engineering|test|technical|software|platform)\s+analyst\b/, "tech"],
  [/\b(business|financial|finance|credit|risk|fraud|hr|marketing|sales|content|category|investment|operations?)\s+analyst\b/, "nontech"],
  [/\b(product|project|program|delivery|engineering)\s+manager\b/, "unclear"],

  [/\b(software|backend|back end|frontend|front end|full ?stack|web|mobile|android|ios|flutter|react|node|java|python|golang|ruby|php|\.net|dotnet)\s*(developer|engineer|dev)\w*/, "tech"],
  [/\b(sde|sdet|sre|devops|devsecops|qa automation|test automation)\w*/, "tech"],
  [/\b(software|hardware|firmware|embedded|systems?|platform|cloud|network|security|cyber ?security|data|site reliability|automation|validation|design verification|application|integration)\s+(engineer|developer|architect|specialist)\w*/, "tech"],
  [/\b(developer|programmer|coder)\w*/, "tech"],
  [/\b(data scientist|data engineer|data analyst|ml engineer|ai engineer|cloud engineer|devops engineer|qa engineer|test engineer|security engineer|network engineer|solutions? architect|enterprise architect|technical lead|tech lead|cto)\w*/, "tech"],
  [/\b(aws|azure|gcp|kubernetes|salesforce|sap (abap|basis|technical)|etl|database administrator|dba|sysadmin|system administrator)\w*/, "tech"],
  [/\b(it support|technical support|application support|desktop support|helpdesk|help desk)\w*/, "tech"],
  [/\b(qa|quality analyst|manual tester|tester|testing)\w*/, "tech"],

  // Trades, services and professions that are plainly not software.
  [/\b(chef|cook|waiter|waitress|bartender|barista|kitchen|steward|housekeep|cleaner|janitor|dishwash)\w*/, "nontech"],
  [/\b(driver|delivery|courier|rider|forklift|warehouse|loader|packer|logistics|supply chain|storekeeper)\w*/, "nontech"],
  [/\b(nurse|doctor|physician|surgeon|dentist|dental|physiotherap|pharmacist|paramedic|radiolog|embryolog|health ?care assistant)\w*/, "nontech"],
  [/\b(teacher|professor|lecturer|tutor|principal|faculty)\w*/, "nontech"],
  [/\b(accountant|accounts|accounting|audit|bookkeep|payroll|cashier|teller|banker|banking)\w*/, "nontech"],
  [/\b(lawyer|advocate|legal|paralegal|solicitor)\w*/, "nontech"],
  [/\b(hr|human resources?|recruit|talent acquisition)\w*/, "nontech"],
  [/\b(sales|business development|bd |telecall|telesales|customer (service|support|care|success)|call cent|relationship manager)\w*/, "nontech"],
  [/\b(marketing|seo|social media|content writ|copywrit|video edit|photograph|graphic design(er)?|brand)\w*/, "nontech"],
  [/\b(electrician|plumber|carpenter|welder|fitter|mason|painter|mechanic|machinist|technician|hvac|boiler|maintenance)\w*/, "nontech"],
  [/\b(civil|mechanical|electrical|chemical|petroleum|mining|structural|production|industrial)\s+(engineer|engineering)\w*/, "nontech"],
  [/\b(security guard|bouncer|watchman|safety officer|hse)\w*/, "nontech"],
  [/\b(receptionist|clerk|admin assistant|administrative|office boy|peon|data entry)\w*/, "nontech"],
  [/\b(farmer|gardener|agricultur|fisher)\w*/, "nontech"],
  [/\b(cabin crew|air hostess|flight attendant|hotel|hospitality|travel agent|tour)\w*/, "nontech"],
  [/\b(coach|trainer|counsel|psycholog|therapist|social work)\w*/, "nontech"],

  /* Genuinely either. An analyst can be writing SQL or reconciling invoices, and a lead
     labelled wrongly here is worse than one labelled unclear. */
  [/\b(analyst|consultant|manager|associate|executive|specialist|coordinator|officer|supervisor|lead|director|head|founder|owner|partner|advisor|architect)\w*/, "unclear"],
  [/\b(student|fresher|fresh graduate|graduate|intern|trainee|apprentice|unemploy|jobless|job ?seeker|looking for|no job|none|not working)\w*/, "unclear"]
];

// The role fields the forms actually write, most used first.
const ROLE_FIELDS = [
  "what_is_your_current_role",
  "your_current_role",
  "whats_your_current_role",
  "what_best_describes_your_current_role",
  "current_role",
  "current_background"
];

function normalise(v){
  return String(v == null ? "" : v).toLowerCase()
    .replace(/[\/_|,()\[\]]+/g, " ")
    .replace(/[^a-z0-9+.# ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* Which role the lead gave, and from which field, so a wrong call can be traced back to
   what they actually typed. */
function roleOf(c){
  for (let i = 0; i < ROLE_FIELDS.length; i++) {
    const v = c && c[ROLE_FIELDS[i]];
    if (v != null && String(v).trim()) {
      return { text: String(v).trim(), field: ROLE_FIELDS[i] };
    }
  }
  return { text: "", field: "" };
}

/* "tech", "nontech", "unclear", or "" when they never answered.

   Never answering and answering ambiguously are different facts, and collapsing them
   would hide how much of the list has no answer at all. */
function classify(text){
  const s = normalise(text);
  if (!s) return "";
  // A bare number, a stray character, or a shrug is not an answer. Treating "na" as
  // ambiguous would put an Unclear chip on a lead who simply skipped the question.
  if (s.length < 2 || /^[0-9. ]+$/.test(s)) return "";
  if (/^(na|n a|nil|none|no|nothing|nope|not applicable|null|test|abc|asdf|xyz|-+)$/.test(s)) return "";
  for (let i = 0; i < RULES.length; i++) {
    if (RULES[i][0].test(s)) return RULES[i][1];
  }
  return "unclear";
}

/* Two different questions, asked of the same free text.

   Simran Khokha's leads are sorted tech against non-tech, because her cohort is a career
   move into technology and what matters is whether they are already in it. Payal's and
   Priyanka's are relocation cohorts, where the useful split is blue collar against white
   collar: a welder and a data engineer are both "non-tech" and that tells nobody anything
   about which visa route they are on.

   Which axis a lead gets follows the creator. A creator nobody has assigned an axis to
   gets no chip, rather than the wrong one. */
const COLLAR = [
  // Hands-on and site-based, whatever the industry.
  [/\b(electrician|plumber|carpenter|welder|fitter|mason|painter|mechanic|machinist|fabricat|rigger|scaffold)/, "blue"],
  [/\b(hvac|boiler|refrigerat|maintenance technician|service technician|lineman|technician)/, "blue"],
  [/\b(driver|delivery|courier|rider|chauffeur|forklift|crane operator|loader|packer|warehouse|storekeep|picker)/, "blue"],
  [/\b(chef|cook|waiter|waitress|bartender|barista|kitchen|steward|dishwash|catering)/, "blue"],
  [/\b(housekeep|cleaner|janitor|maid|laundry|sanitation)/, "blue"],
  [/\b(security guard|bouncer|watchman|guard)/, "blue"],
  [/\b(farmer|gardener|agricultur|fisher|labour|labor|helper|general worker|factory|assembly|production operator|plant operator|machine operator)/, "blue"],
  [/\b(tailor|barber|beautician|cobbler|butcher|baker)/, "blue"],
  [/\b(nurse|caregiver|health ?care assistant|nursing assistant|ward)/, "blue"],
  [/\b(construction|site supervisor|site engineer|foreman|surveyor)/, "blue"],

  // Desk, professional and managerial.
  [/\b(engineer|developer|programmer|architect|scientist|analyst|consultant|manager|executive|officer|administrator|accountant|auditor|lawyer|advocate|doctor|physician|surgeon|dentist|pharmacist|physiotherap|professor|lecturer|teacher|researcher|designer|marketer|banker|broker|planner|specialist|coordinator|associate|director|supervisor|lead)/, "white"],
  [/\b(hr|human resources?|recruit|finance|accounts|accounting|marketing|sales|business development|customer success|operations|procurement|logistics manager|supply chain)/, "white"],
  [/\b(software|data|cloud|network|security|it |information technology|qa|devops)/, "white"],

  [/\b(student|fresher|fresh graduate|graduate|intern|trainee|apprentice|unemploy|jobless|job ?seeker|looking for|not working|business ?man|self employed|freelanc|entrepreneur|founder)/, "unclear"]
];

/* Which axis a creator's leads are read on. Set CREATOR_ROLE_AXIS to override, as
   "creator:axis,creator:axis". */
const AXIS = (function(){
  const m = { simrankhokha: "tech", payalineurope: "collar", wanderess_priyanka: "collar" };
  String(process.env.CREATOR_ROLE_AXIS || "").split(",").forEach(function(pair){
    const p = pair.split(":");
    if (p.length === 2 && p[0].trim()) m[p[0].trim()] = p[1].trim();
  });
  return m;
})();
function axisFor(creator){ return AXIS[String(creator || "")] || ""; }

function classifyCollar(text){
  const s = normalise(text);
  if (!s) return "";
  if (s.length < 2 || /^[0-9. ]+$/.test(s)) return "";
  if (/^(na|n a|nil|none|no|nothing|nope|not applicable|null|test|abc|asdf|xyz|-+)$/.test(s)) return "";
  for (let i = 0; i < COLLAR.length; i++) {
    if (COLLAR[i][0].test(s)) return COLLAR[i][1];
  }
  return "unclear";
}

/* The reading for one lead: what they wrote, which question their creator is asking, and
   the answer on that axis. */
function readingOf(c, creator){
  const r = roleOf(c);
  const axis = axisFor(creator);
  if (!axis || !r.text) return { role: r.text, roleField: r.field, axis: axis, value: "" };
  return { role: r.text, roleField: r.field, axis: axis,
    value: axis === "collar" ? classifyCollar(r.text) : classify(r.text) };
}

function techOf(c){
  const r = roleOf(c);
  return { role: r.text, roleField: r.field, tech: classify(r.text) };
}

module.exports = { RULES, COLLAR, ROLE_FIELDS, AXIS, normalise, roleOf,
  classify, classifyCollar, axisFor, readingOf, techOf };
