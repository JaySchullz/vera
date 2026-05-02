/**
 * A/B Eval Script: old generic prompt vs new few-shot category-aware prompt
 *
 * Shows the full prompt sent to the LLM for a sample dentist perf_dip trigger,
 * under both the old and new prompt construction strategies, so the quality
 * difference is auditable without a live LLM.
 *
 * Run with:
 *   node artifacts/api-server/scripts/ab-eval-prompt.mjs
 */

const OLD_VOICE_DESCRIPTION =
  "Clinical peer tone — respectful, collegial, technical vocab welcome. Talk like a colleague sharing useful information, not a salesperson. Avoid hype. Use 'worth a look' not 'amazing'. Taboo words: guaranteed, cure, miracle.";

const SAMPLE_DRAFT =
  "Spotted something — Bharat Dental Care, calls dropped ~50% this week ({{0}} vs {{1}} baseline). Andheri West Peers with active offers are seeing ~2× calls right now. I've already drafted a counter-offer — can send in 10 min. Want me to send it?";

// ── OLD PROMPT ────────────────────────────────────────────────────────────────
function buildOldPrompt(draft, voiceDescription) {
  return `You are Vera, magicpin's merchant AI assistant. Rewrite this draft in the following voice: ${voiceDescription}

Rules:
- Do NOT change {{N}} placeholder tokens — they will be restored after
- Max 4 lines total
- WhatsApp style — conversational, not corporate
- Exactly ONE CTA question at the end
- At most ONE humanization phrase (e.g. "Quick heads-up —")
- No new facts or numbers
- No URLs

Draft:
${draft}

Rewritten:`;
}

// ── NEW PROMPT ────────────────────────────────────────────────────────────────
const FEW_SHOT_DENTIST = [
  [
    "Dr. Priya, calls dropped 40% this week (8 vs 14 baseline). Nearby clinics are running ₹299 cleaning offers and getting more callbacks. Want to try something similar?",
    "Dr. Priya, calls are down 40% this week — 8 vs your 14-call baseline. Peer clinics with a ₹299 cleaning offer are already recovering callbacks. Worth piloting one before the week closes?",
  ],
  [
    "Dr. Priya, 3 patients are due for recall this month. Last service was 6 months ago. Want to send a reminder?",
    "Dr. Priya, 3 patients hit their 6-month recall window — every day without outreach quietly shrinks rebook chances. Colleagues who send a timely WhatsApp note see strong reactivation. Want me to draft the message now?",
  ],
  [
    "Dr. Priya, your profile views are up 22% but bookings haven't moved. Peers with active offers are converting much better. Want to look at an offer?",
    "Dr. Priya, views are up 22% yet bookings haven't moved — a classic intent-without-action gap that colleagues often see before a slow spell. Peers closing it with a targeted offer are converting steadily right now. Worth a look?",
  ],
];

function buildNewSystemPrompt() {
  return `You are Vera, magicpin's merchant AI assistant. Your job is to rewrite WhatsApp message drafts so they score highest on: engagement compulsion, category fit, specificity, and merchant fit.

Voice profile for this merchant's category:
Clinical peer tone — respectful, collegial, technical vocab welcome. Talk like a colleague sharing useful information, not a salesperson. Avoid hype. Use 'worth a look' not 'amazing'. Taboo words: guaranteed, cure, miracle.

Salutation format: Dr. {first_name}

Banned words / phrases (never use): "guaranteed", "100% safe", "completely cure", "miracle", "best in city"

Rewriting rules — follow ALL of these:
1. Preserve every {{N}} placeholder token exactly — they hold real numbers and will be restored later
2. Max 4 lines total
3. WhatsApp conversational style — never corporate, never generic
4. Add ONE engagement compulsion hook — choose from: time-pressure ("before Friday", "before the week closes"), social proof ("peer clinics are", "salons near you are"), loss framing ("revenue slipping out quietly"), or curiosity/insight ("classic pre-churn pattern")
5. End with exactly ONE actionable CTA question — category-specific, not generic ("let me know")
6. At most ONE humanization phrase (e.g. "Quick heads-up —")
7. CRITICAL — no new numbers: use only the specific numbers, percentages, and rupee values present in the draft as {{N}} tokens — do NOT invent or add any additional figures, statistics, or benchmarks
8. No URLs
9. Use trade terms appropriate for the category (dentists: calls/bookings/recall/conversion)`;
}

// ── OUTPUT ────────────────────────────────────────────────────────────────────
const hr = "=".repeat(72);
const thinHr = "─".repeat(72);

console.log(hr);
console.log("A/B EVAL: LLM Polish Prompt — Old vs New");
console.log("Sample trigger : perf_dip  |  Category: dentists");
console.log("Merchant       : Bharat Dental Care, Andheri West, Mumbai");
console.log(hr);

console.log("\n[OLD PROMPT] Single user-message, generic voice description");
console.log(thinHr);
console.log(buildOldPrompt(SAMPLE_DRAFT, OLD_VOICE_DESCRIPTION));

console.log("\n[NEW PROMPT] System message + per-category few-shot examples");
console.log(thinHr);
console.log("[SYSTEM]\n" + buildNewSystemPrompt());
console.log("\n[FEW-SHOT TURNS]");
for (const [d, p] of FEW_SHOT_DENTIST) {
  console.log(`  USER:      Draft: ${d}`);
  console.log(`             Rewritten:`);
  console.log(`  ASSISTANT: ${p}\n`);
}
console.log("[LIVE TURN]");
console.log(`  USER: Draft:\n  ${SAMPLE_DRAFT}\n  Rewritten:`);

console.log("\n[EXPECTED SCORING DELTA when LLM is live]");
console.log(thinHr);
console.log("engagement_compulsion : old=generic CTA only   → new=explicit hook rule + 3 demonstrations");
console.log("category_fit          : old=description inline → new=system+taboos+salutation enforced");
console.log("specificity           : maintained — {{N}} preserved, no new numbers in examples");
console.log("merchant_fit          : maintained — salutation format explicit in system msg");
console.log("latency               : unchanged — 5s timeout, gpt-4o-mini, max_tokens=200");
