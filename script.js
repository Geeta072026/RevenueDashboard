/**
 * Meridian Revenue Intelligence — Lead Scoring & Prioritization
 *
 * Accepts pasted, CRM-style contact text, parses it into structured
 * contact records, and applies deterministic, rule-based scoring to
 * rank leads by priority. Every point awarded is traceable to an
 * explicit rule so a relationship manager (or compliance reviewer)
 * can see exactly why a lead was scored the way it was.
 *
 * No randomness. No external data or network calls. All logic below
 * is pure and runs entirely against the text the user pastes in.
 */

/* ============================================================================
   1. INPUT PARSING LAYER
   Converts raw pasted text into structured contact objects.
   Expected format: one contact per block, blocks separated by a blank
   line, each line within a block formatted as "Field: Value".
   ============================================================================ */

/** Maps accepted field labels (lowercased) to internal contact keys. */
const CONTACT_FIELD_ALIASES = {
  name: ["name", "contact", "contact name"],
  company: ["company", "firm", "organization"],
  title: ["title", "role", "position"],
  estimatedAssets: ["estimated assets", "assets", "net worth", "aum", "investable assets"],
  referralSource: ["referral source", "referral", "source"],
  lastContact: ["last contact", "last contacted", "last interaction", "last touch"],
  notes: ["notes", "note", "comments"]
};

/**
 * Parses the full textarea input into an array of contact objects.
 * Blocks are separated by one or more blank lines.
 */
function parseContactsFromInput(rawText) {
  if (!rawText || !rawText.trim()) {
    return [];
  }

  const blocks = rawText
    .split(/\n\s*\n/)
    .map(block => block.trim())
    .filter(Boolean);

  return blocks
    .map(parseContactBlock)
    .filter(contact => contact.name); // a contact without a name cannot be scored meaningfully
}

/**
 * Parses a single "Field: Value" block into a structured contact object.
 * Unrecognized lines and unrecognized field labels are silently skipped
 * rather than causing a parse failure, since CRM exports are rarely clean.
 */
function parseContactBlock(block) {
  const lines = block.split("\n").map(line => line.trim()).filter(Boolean);

  const contact = {
    name: "",
    company: "",
    title: "",
    estimatedAssets: null,
    referralSource: "",
    lastContact: null,
    notes: ""
  };

  lines.forEach(line => {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) return;

    const rawKey = line.slice(0, separatorIndex).trim().toLowerCase();
    const rawValue = line.slice(separatorIndex + 1).trim();
    const fieldKey = resolveFieldKey(rawKey);

    if (!fieldKey || !rawValue) return;

    if (fieldKey === "estimatedAssets") {
      contact.estimatedAssets = parseAssetValue(rawValue);
    } else if (fieldKey === "lastContact") {
      contact.lastContact = parseDaysAgo(rawValue);
    } else {
      contact[fieldKey] = rawValue;
    }
  });

  return contact;
}

/** Resolves a raw field label to one of the internal contact keys. */
function resolveFieldKey(rawKey) {
  for (const [fieldKey, aliases] of Object.entries(CONTACT_FIELD_ALIASES)) {
    if (aliases.includes(rawKey)) return fieldKey;
  }
  return null;
}

/**
 * Parses a dollar-value string ("$6.5M", "750K", "1,200,000") into a
 * plain number of dollars. Returns null if the value cannot be parsed.
 */
function parseAssetValue(value) {
  const cleaned = value.replace(/[$,]/g, "").trim().toUpperCase();
  const match = cleaned.match(/^([\d.]+)\s*(B|M|K)?$/);
  if (!match) return null;

  const amount = parseFloat(match[1]);
  if (isNaN(amount)) return null;

  const unit = match[2];
  if (unit === "B") return amount * 1_000_000_000;
  if (unit === "M") return amount * 1_000_000;
  if (unit === "K") return amount * 1_000;
  return amount;
}

/**
 * Converts a "last contact" value into a number of days elapsed since
 * today. Supports relative phrasing ("5 days ago", "3 weeks ago") and
 * absolute dates (any format the Date constructor can parse, e.g.
 * "2026-06-20" or "06/20/2026"). Returns null if unparseable.
 */
function parseDaysAgo(value) {
  const relativeMatch = value.match(/(\d+)\s*(day|week|month)/i);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    if (unit === "day") return amount;
    if (unit === "week") return amount * 7;
    if (unit === "month") return amount * 30;
  }

  const parsedDate = new Date(value);
  if (!isNaN(parsedDate.getTime())) {
    const diffMs = Date.now() - parsedDate.getTime();
    return Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
  }

  return null;
}


/* ============================================================================
   2. SCORING LAYER
   Deterministic, rule-based lead scoring (0–100). Every rule below is
   explicit and produces a human-readable reason string, so results can
   always be explained to a relationship manager or compliance reviewer.
   ============================================================================ */

/** Estimated-assets tiers, evaluated from highest to lowest. */
const ASSET_TIERS = [
  { minimum: 10_000_000, points: 35, label: "$10M+" },
  { minimum: 5_000_000, points: 25, label: "$5M–$10M" },
  { minimum: 1_000_000, points: 15, label: "$1M–$5M" },
  { minimum: 250_000, points: 8, label: "$250K–$1M" }
];

/** Referral-source patterns, evaluated in order; first match wins. */
const REFERRAL_SOURCE_RULES = [
  { pattern: /existing client|client referral/i, points: 25, label: "an existing client referral" },
  { pattern: /attorney|cpa|accountant|centers? of influence|coi/i, points: 15, label: "a professional/COI referral" },
  { pattern: /website|inbound|webinar|event/i, points: 8, label: "an inbound/marketing source" }
];

/** Title-seniority patterns, evaluated in order; first match wins. */
const SENIORITY_RULES = [
  { pattern: /chief|ceo|cfo|coo|founder|owner|president|managing partner/i, points: 10, label: "a senior decision-maker title" },
  { pattern: /director|vp|vice president|principal/i, points: 5, label: "a management-level title" }
];

const POSITIVE_NOTE_KEYWORDS = /interested|ready to invest|looking to invest|urgent|moving forward|wants to proceed/i;
const NEGATIVE_NOTE_KEYWORDS = /not interested|no budget|declined|unresponsive|do not contact/i;

/**
 * Scores a single contact against the rules above. Returns the final
 * score (clamped 0–100) and an ordered list of reason strings explaining
 * how the score was built.
 */
function scoreLead(contact) {
  const reasons = [];
  let score = 0;

  // Rule 1: estimated assets
  if (contact.estimatedAssets != null) {
    const tier = ASSET_TIERS.find(t => contact.estimatedAssets >= t.minimum);
    if (tier) {
      score += tier.points;
      reasons.push(`Estimated assets of ${formatCurrency(contact.estimatedAssets)} fall in the ${tier.label} tier (+${tier.points})`);
    } else {
      reasons.push(`Estimated assets of ${formatCurrency(contact.estimatedAssets)} are below the minimum scoring tier (+0)`);
    }
  } else {
    reasons.push("No estimated assets provided (+0)");
  }

  // Rule 2: referral source
  if (contact.referralSource) {
    const rule = REFERRAL_SOURCE_RULES.find(r => r.pattern.test(contact.referralSource));
    if (rule) {
      score += rule.points;
      reasons.push(`Referral source ("${contact.referralSource}") matches ${rule.label} (+${rule.points})`);
    } else {
      reasons.push(`Referral source ("${contact.referralSource}") does not match a recognized high-value pattern (+0)`);
    }
  } else {
    reasons.push("No referral source provided (+0)");
  }

  // Rule 3: recency of last contact
  if (contact.lastContact != null) {
    if (contact.lastContact <= 7) {
      score += 20;
      reasons.push(`Last contacted ${contact.lastContact} day(s) ago, indicating high engagement (+20)`);
    } else if (contact.lastContact <= 30) {
      score += 12;
      reasons.push(`Last contacted ${contact.lastContact} day(s) ago, indicating recent engagement (+12)`);
    } else if (contact.lastContact <= 90) {
      score += 5;
      reasons.push(`Last contacted ${contact.lastContact} day(s) ago, indicating moderate engagement (+5)`);
    } else {
      reasons.push(`Last contacted ${contact.lastContact} day(s) ago, indicating stale engagement (+0)`);
    }
  } else {
    reasons.push("No last contact date provided (+0)");
  }

  // Rule 4: title seniority
  if (contact.title) {
    const rule = SENIORITY_RULES.find(r => r.pattern.test(contact.title));
    if (rule) {
      score += rule.points;
      reasons.push(`Title "${contact.title}" indicates ${rule.label} (+${rule.points})`);
    } else {
      reasons.push(`Title "${contact.title}" does not indicate elevated decision-making authority (+0)`);
    }
  } else {
    reasons.push("No title provided (+0)");
  }

  // Rule 5: notes / buying-intent language
  if (contact.notes) {
    if (NEGATIVE_NOTE_KEYWORDS.test(contact.notes)) {
      score -= 20;
      reasons.push("Notes contain negative buying-intent language (-20)");
    } else if (POSITIVE_NOTE_KEYWORDS.test(contact.notes)) {
      score += 10;
      reasons.push("Notes contain positive buying-intent language (+10)");
    } else {
      reasons.push("Notes contain no clear buying-intent signal (+0)");
    }
  } else {
    reasons.push("No notes provided (+0)");
  }

  score = Math.max(0, Math.min(100, score));

  return { score, reasons };
}

/** Maps a numeric score to a priority category. */
function categorizeLead(score) {
  if (score >= 70) return "High";
  if (score >= 40) return "Medium";
  return "Low";
}

/** Formats a numeric dollar amount as USD currency, e.g. $6,500,000. */
function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}


/* ============================================================================
   3. ANALYSIS PIPELINE
   Orchestrates parsing and scoring, then sorts results highest-score-first.
   ============================================================================ */

/**
 * Runs the full pipeline against raw pasted text: parse contacts, score
 * each one, attach its priority category, and sort by score descending.
 */
function analyzeLeads(rawText) {
  const contacts = parseContactsFromInput(rawText);

  const scoredLeads = contacts.map(contact => {
    const { score, reasons } = scoreLead(contact);
    return {
      contact,
      score,
      priority: categorizeLead(score),
      reasons
    };
  });

  scoredLeads.sort((a, b) => b.score - a.score);
  return scoredLeads;
}


/* ============================================================================
   4. RENDERING LAYER
   Renders scored, ranked leads into the results panel.
   ============================================================================ */

/** Renders the full list of scored leads into the results container. */
function renderResults(scoredLeads) {
  const container = document.getElementById("results-container");
  container.innerHTML = "";

  if (scoredLeads.length === 0) {
    container.appendChild(
      buildEmptyState('No contacts were recognized in the pasted text. Check the expected field format above and try again.')
    );
    return;
  }

  scoredLeads.forEach(lead => {
    container.appendChild(buildLeadCard(lead));
  });
}

/** Builds the empty-state element shown when no contacts could be parsed. */
function buildEmptyState(message) {
  const wrapper = document.createElement("div");
  wrapper.className = "results-empty-state";

  const text = document.createElement("p");
  text.className = "panel__placeholder";
  text.textContent = message;

  wrapper.appendChild(text);
  return wrapper;
}

/** Builds a single lead card element, including its reasoning list. */
function buildLeadCard(lead) {
  const priorityClass = lead.priority.toLowerCase();

  const card = document.createElement("article");
  card.className = `lead-card lead-card--${priorityClass}`;

  const header = document.createElement("div");
  header.className = "lead-card__header";

  const name = document.createElement("h3");
  name.className = "lead-card__name";
  name.textContent = lead.contact.name || "Unnamed Contact";

  const badge = document.createElement("span");
  badge.className = `lead-card__badge lead-card__badge--${priorityClass}`;
  badge.textContent = `${lead.priority} · ${lead.score}`;

  header.appendChild(name);
  header.appendChild(badge);

  const meta = document.createElement("p");
  meta.className = "lead-card__meta";
  meta.textContent = [lead.contact.title, lead.contact.company].filter(Boolean).join(" · ") || "No title/company provided";

  const reasonsList = document.createElement("ul");
  reasonsList.className = "lead-card__reasons";
  lead.reasons.forEach(reasonText => {
    const item = document.createElement("li");
    item.textContent = reasonText;
    reasonsList.appendChild(item);
  });

  card.appendChild(header);
  card.appendChild(meta);
  card.appendChild(reasonsList);

  return card;
}


/* ============================================================================
   5. APPLICATION BOOTSTRAP
   Wires the "Analyze Leads" button to the parse → score → render pipeline.
   ============================================================================ */

/** Handles a click on the "Analyze Leads" button. */
function handleAnalyzeClick() {
  const input = document.getElementById("lead-input");
  const scoredLeads = analyzeLeads(input.value);
  renderResults(scoredLeads);
}

/** Initializes the dashboard by wiring up event listeners. */
function initializeDashboard() {
  const analyzeButton = document.getElementById("analyze-leads-button");
  analyzeButton.addEventListener("click", handleAnalyzeClick);
}

document.addEventListener("DOMContentLoaded", initializeDashboard);
