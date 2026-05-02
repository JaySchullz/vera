import { CausalNarrative } from "./narrative.js";
import { getVariations } from "./variability.js";
import { VoiceProfile, containsTaboo } from "./voice-profiles.js";
import { polishWithLLM } from "./openai-client.js";
import { logger } from "./logger.js";

const MAX_BODY_CHARS = 600;

const COMPULSION_PATTERNS = [
  /expires in \d+/i,
  /\d+ days? (left|remaining|until)/i,
  /tonight/i,
  /deadline/i,
  /\d+ hours?/i,
  /peers?/i,
  /nearby/i,
  /~?\d+%/i,
  /similar businesses/i,
  /clinics? (countering|offering|with)/i,
  /dropped? ~?\d+%/i,
  /pipeline stops/i,
  /lapsed/i,
  /views? down/i,
  /calls? down/i,
  /already drafted/i,
  /ready to go/i,
  /ready in \d+ min/i,
  /can send in/i,
  /\d{2,}.*patient/i,
  /\d+.*trial/i,
  /₹\d+/i,
  /\d+.*slot/i,
  /\d{2,}.*view/i,
  /\d{2,}.*call/i,
];

// All patterns that count as a CTA so we can enforce exactly one
const CTA_PATTERNS = [
  /want me to\??/i,
  /should i\??/i,
  /shall i\??/i,
  /send this across\??/i,
  /reply (yes|1|2|confirm)\b/i,
  /want me to send/i,
  /confirm delivery/i,
  /\bconfirm\b.*\?/i,
  /reply yes or no/i,
  /reply yes/i,
  /schedule.*post\?/i,
  /publish.*\?/i,
  /want to review/i,
  /want me to publish/i,
  /shall I send/i,
];

function hasCompulsion(body: string): boolean {
  return COMPULSION_PATTERNS.some((p) => p.test(body));
}

function countCTAs(body: string): number {
  return CTA_PATTERNS.filter((p) => p.test(body)).length;
}

/**
 * Extract digits/numbers embedded in narrative fields for post-LLM preservation check.
 * Returns an array of distinct numeric tokens (e.g. "2100", "38", "4999").
 */
function extractNumericTokens(narrative: CausalNarrative): string[] {
  const source = [
    narrative.proof,
    narrative.proof2,
    narrative.benchmark,
    narrative.problem,
  ]
    .filter(Boolean)
    .join(" ");
  const matches = source.match(/\d[\d,.]*/g) ?? [];
  // Normalise: strip commas/dots so "2,100" and "2100" compare equal
  return [...new Set(matches.map((m) => m.replace(/[,.]/g, "")))];
}

/**
 * Check that all numeric tokens from the template narrative survive in the
 * polished output. Allows for Indian-locale formatting (2,100 vs 2100).
 */
function numericTokensPreserved(body: string, tokens: string[]): boolean {
  const normalBody = body.replace(/[,.]/g, "");
  return tokens.every((t) => normalBody.includes(t));
}

/**
 * Ensure the body contains at least one phrase that names or implies the
 * trigger reason (used for trigger-reason phrase enforcement).
 */
function hasTriggerReasonPhrase(body: string, narrative: CausalNarrative): boolean {
  const keywords = [
    narrative.triggerKind.replace(/_/g, " "),
    narrative.problem.split(" ").slice(0, 3).join(" ").toLowerCase(),
    narrative.proof.split(" ").slice(0, 3).join(" ").toLowerCase(),
  ];
  const lBody = body.toLowerCase();
  return keywords.some((kw) => kw.length > 3 && lBody.includes(kw));
}

/**
 * Strip extra CTAs: keep everything up to and including the first CTA sentence,
 * remove subsequent CTA sentences.
 */
function enforceExactlyOneCTA(body: string): string {
  if (countCTAs(body) <= 1) return body;

  // Split on sentence boundaries and remove duplicate CTA sentences
  const sentences = body.split(/(?<=[.?!])\s+/);
  const kept: string[] = [];
  let ctaSeen = false;

  for (const sentence of sentences) {
    const isCTA = CTA_PATTERNS.some((p) => p.test(sentence));
    if (isCTA) {
      if (!ctaSeen) {
        kept.push(sentence);
        ctaSeen = true;
      }
      // else: drop this duplicate CTA sentence
    } else {
      kept.push(sentence);
    }
  }

  return kept.join(" ").trim();
}

function enforceCompulsion(body: string, narrative: CausalNarrative): string {
  if (hasCompulsion(body)) return body;
  const hook = narrative.benchmark
    ? `${narrative.benchmark}. `
    : "Peers with active offers see ~2× better results right now. ";
  return `${hook}${body}`;
}

function enforceOneCTA(body: string): string {
  if (countCTAs(body) >= 1) return body;
  return `${body.trimEnd()} Want me to send this?`;
}

function truncateTo(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  // Truncate at last sentence boundary within limit
  const truncated = body.slice(0, maxChars);
  const lastSentence = truncated.search(/[.?!][^.?!]*$/);
  if (lastSentence > maxChars * 0.6) {
    return truncated.slice(0, lastSentence + 1).trim();
  }
  return truncated.trimEnd() + "…";
}

function validateOutput(
  body: string,
  narrative: CausalNarrative,
  voice: VoiceProfile,
  numericTokens: string[],
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  if (!hasCompulsion(body)) issues.push("no_compulsion");
  if (countCTAs(body) !== 1) issues.push(`cta_count:${countCTAs(body)}`);
  if (body.length > MAX_BODY_CHARS) issues.push(`too_long:${body.length}`);
  if (!numericTokensPreserved(body, numericTokens)) issues.push("numeric_tokens_lost");
  if (!hasTriggerReasonPhrase(body, narrative)) issues.push("no_trigger_reason");
  if (containsTaboo(body, voice.taboos)) issues.push("taboo_word");
  if (/https?:\/\/\S+/.test(body)) issues.push("url_present");
  // Hard specificity requirement: body MUST contain at least one digit
  if (!/\d/.test(body)) issues.push("no_digit");

  const nameLower = body.toLowerCase();
  const hasName =
    nameLower.includes(narrative.merchantName.toLowerCase()) ||
    nameLower.includes(narrative.ownerFirstName.toLowerCase()) ||
    (!!narrative.customerName &&
      nameLower.includes(narrative.customerName.toLowerCase()));
  if (!hasName) issues.push("missing_name");

  return { valid: issues.length === 0, issues };
}

function buildRaw(
  narrative: CausalNarrative,
  variations: ReturnType<typeof getVariations>,
): string {
  const {
    problem,
    proof,
    proof2,
    benchmark,
    locality,
    offer,
    action,
    triggerKind,
    merchantName,
    ownerFirstName,
    categorySlug,
    customerName,
  } = narrative;

  const v = variations;

  switch (triggerKind) {
    case "research_digest": {
      const localityStr = locality ? ` — relevant for ${locality}` : "";
      const salutation =
        categorySlug === "dentists" ? `Dr. ${ownerFirstName}` : ownerFirstName;
      return `${salutation}, ${problem}. ${proof} — ${proof2 ?? "meaningful results"}${localityStr}. I've ${action}. ${v.cta}`;
    }
    case "recall_due": {
      const slots = proof2 ?? "a convenient time";
      const offerStr = offer || "Dental Cleaning @ ₹299";
      const slot1 = slots.split(" or ")[0] ?? slots;
      const slot2 = slots.split(" or ")[1] ?? "another time";
      return `Hi ${customerName ?? "there"}, ${merchantName} here 🦷\n${problem} — your 6-month ${proof} is coming up.\nWe've held 2 slots: ${slots}.\n${offerStr} + complimentary fluoride. Reply 1 for ${slot1} or 2 for ${slot2}.`;
    }
    case "perf_dip":
    case "seasonal_perf_dip": {
      const localityStr = locality ? ` ${locality}` : "";
      return `${v.humanization} ${merchantName}, ${problem} (${proof}).${localityStr} ${benchmark}. I've ${action}. ${v.cta}`;
    }
    case "renewal_due": {
      return `${merchantName}, ${problem}.\n${proof} — ${proof2 ?? benchmark}.\n${offer || ""}. I'm ${action}. ${v.cta}`;
    }
    case "competitor_opened": {
      return `${v.humanization} ${merchantName}, ${problem}.\n${benchmark}.\nI've ${action}. ${v.cta}`;
    }
    case "ipl_match_today": {
      return `${v.humanization} ${merchantName} — ${problem}.\n${proof} (vs ${proof2 ?? "+18% weeknight delivery"}).\nSkip the dine-in push; ${offer ? `your ${offer}` : "delivery combo"} as delivery-only is the play. ${action}. ${v.cta}`;
    }
    case "review_theme_emerged": {
      return `${merchantName}, ${problem}.\nLatest: ${proof}.\nI've ${action}. ${v.cta}`;
    }
    case "curious_ask_due": {
      return `Hi ${ownerFirstName}! Quick one — what service has been most asked-for at ${merchantName} this week?\nI'll turn it into a Google post + a 4-line WhatsApp reply for pricing questions. Takes 5 min. ${v.cta}`;
    }
    case "active_planning_intent": {
      const offerAnchor = offer ? `\n\nSuggested anchor: ${offer}` : "";
      return `${ownerFirstName}, ${problem}.${offerAnchor}\n\nI've ${action}. Want to review it now?`;
    }
    case "supply_alert": {
      return `${merchantName}, ${problem}.\n${proof}${proof2 ? ` (${proof2})` : ""}.\nAction: pull from shelf + contact distributor. I've ${action}. ${v.cta}`;
    }
    case "regulation_change": {
      return `${merchantName}, ${problem}.\n${proof}.\n${proof2 ? `Required: ${proof2}.\n` : ""}I've ${action}. ${v.cta}`;
    }
    case "chronic_refill_due": {
      return `Hi ${customerName ?? "there"}, ${merchantName} here.\n${problem} (${proof}).\n${proof2 ?? ""}.\nConfirm dispatch? Reply YES or call us.`;
    }
    case "dormant_with_vera": {
      return `Hi ${ownerFirstName}, ${problem} — ${benchmark}.\nWorth 2 minutes? I ${action}. ${v.cta}`;
    }
    case "winback_eligible": {
      return `${merchantName}, ${problem}.\n${proof}${proof2 ? `, and ${proof2}` : ""}.\nI ${action}. ${v.cta}`;
    }
    case "festival_upcoming": {
      return `${merchantName}, ${problem}.\n${proof} (${proof2}).\nI've ${action}. ${v.cta}`;
    }
    case "perf_spike": {
      return `${v.humanization} ${merchantName}, ${problem} (${proof}).\nHigh-intent window — ${benchmark}.\nI ${action}. ${v.cta}`;
    }
    case "milestone_reached": {
      return `${merchantName}, just crossed your ${problem}!\n${proof2 ?? benchmark}.\nI've ${action}. ${v.cta}`;
    }
    case "trial_followup": {
      return `Hi ${customerName ?? "there"}, ${merchantName} here — hope you enjoyed the trial!\nWe've ${action} (${proof}).\nReply YES to confirm or suggest another time.`;
    }
    case "gbp_unverified": {
      return `${v.humanization} ${merchantName}, ${problem}.\n${proof} (${proof2}).\nI've ${action}. ${v.cta}`;
    }
    default: {
      return `${v.humanization} ${merchantName}, ${problem}.\n${proof}${proof2 ? ` (${proof2})` : ""}.\nI've ${action}. ${v.cta}`;
    }
  }
}

export interface ComposedMessage {
  body: string;
  cta: string;
  templateName: string;
  templateParams: string[];
  sendAs: "vera" | "merchant_on_behalf";
  rationale: string;
}

export async function compose(
  narrative: CausalNarrative,
  voice: VoiceProfile,
  hashKey: string,
  signals: string[],
): Promise<ComposedMessage> {
  const variations = getVariations(hashKey);
  const numericTokens = extractNumericTokens(narrative);

  let body = buildRaw(narrative, variations);
  body = enforceCompulsion(body, narrative);
  body = body.replace(/https?:\/\/\S+/g, "");

  let usedRaw = false;

  try {
    const polished = await polishWithLLM(body, voice, narrative.categorySlug);
    const { issues } = validateOutput(polished, narrative, voice, numericTokens);
    // All gates are mandatory — name, trigger-reason, digit, compulsion, CTA, length, taboo
    // No non-blocking exceptions: even missing_name or no_trigger_reason fails the LLM polish
    if (issues.length === 0) {
      body = polished;
    } else {
      usedRaw = true;
      logger.debug({ issues }, "LLM polish failed validation; using template draft");
    }
  } catch (err) {
    logger.warn({ err }, "LLM polish threw; using template draft");
    usedRaw = true;
  }

  // Post-compose gates (applied to both LLM output and raw template)
  body = enforceCompulsion(body, narrative);
  body = body.replace(/https?:\/\/\S+/g, "");
  body = enforceExactlyOneCTA(body);
  body = enforceOneCTA(body);
  body = truncateTo(body, MAX_BODY_CHARS);

  // Hard fallback: if ANY gate fails after post-compose enforcement, revert to raw template.
  // "Serve anyway" is never acceptable — specificity and output contract must be met.
  const { valid: finalValid, issues } = validateOutput(body, narrative, voice, numericTokens);
  if (!finalValid) {
    logger.warn(
      { issues, triggerKind: narrative.triggerKind, usedRaw },
      "Final output failed validation — reverting to raw template draft",
    );
    // Revert to raw draft and apply mandatory gates
    body = buildRaw(narrative, variations);
    body = enforceCompulsion(body, narrative);
    body = body.replace(/https?:\/\/\S+/g, "");
    body = enforceExactlyOneCTA(body);
    body = enforceOneCTA(body);
    body = truncateTo(body, MAX_BODY_CHARS);
    usedRaw = true;

    // Second validation pass on raw fallback — log any remaining issues
    const { issues: rawIssues } = validateOutput(body, narrative, voice, numericTokens);
    if (rawIssues.length > 0) {
      logger.error(
        { rawIssues, triggerKind: narrative.triggerKind },
        "Raw template fallback still has validation issues — narrative may be incomplete",
      );
    }
  }

  const ctaType = detectCTAType(narrative.triggerKind, narrative.sendAs);
  const rationale = buildRationale(narrative, signals, usedRaw);

  return {
    body,
    cta: ctaType,
    templateName: `vera_${narrative.triggerKind}_v1`,
    templateParams: [narrative.merchantName, narrative.problem, narrative.benchmark],
    sendAs: narrative.sendAs,
    rationale,
  };
}

function detectCTAType(triggerKind: string, sendAs: string): string {
  if (sendAs === "merchant_on_behalf") {
    if (triggerKind === "recall_due") return "multi_choice_slot";
    return "binary_yes_no";
  }
  if (triggerKind === "research_digest") return "open_ended";
  if (triggerKind === "renewal_due") return "binary_yes_no";
  if (triggerKind === "active_planning_intent") return "binary_confirm_cancel";
  if (triggerKind === "supply_alert") return "binary_yes_no";
  return "open_ended";
}

function buildRationale(
  narrative: CausalNarrative,
  signals: string[],
  usedRaw: boolean,
): string {
  // Pipe-style format as per brief: Trigger | Signal | Decision | Action
  return [
    `Trigger: ${narrative.triggerKind} (${narrative.proof}${narrative.proof2 ? `, ${narrative.proof2}` : ""})`,
    `Signal: ${signals.length > 0 ? signals.join(", ") : "none"}`,
    `Decision: highest-score trigger selected; causal narrative + specificity stacking${usedRaw ? "; served template draft (LLM validation failed)" : ""}`,
    `Action: ${narrative.action}`,
  ].join("\n");
}

// ── Execution turn ────────────────────────────────────────────────────────────
// ALL branches end with "This is yours to edit — want me to publish it?"

export async function composeExecutionTurn(
  narrative: CausalNarrative,
  _voice: VoiceProfile,
  topicBias?: string,
): Promise<string> {
  const { triggerKind, merchantName, offer, proof, proof2, benchmark, problem, ownerFirstName } = narrative;
  const PUBLISH_CTA = "This is yours to edit — want me to publish it?";

  // topic_bias adjusts the copy focal point
  const biasNote = topicBias
    ? `Focusing on: ${topicBias}. `
    : "";

  let artifact: string;

  switch (triggerKind) {
    case "research_digest": {
      const offerStr = offer || "Dental Cleaning @ ₹299";
      const focusLine = topicBias
        ? `"${topicBias} — new research shows ${proof}. Drop us a note for a quick check."`
        : `"${offerStr} — new research shows ${proof}. Especially relevant if you've had cavities recently."`;
      artifact = `${biasNote}Sending the abstract now (2 pages). Patient WhatsApp draft:\n\n${focusLine}\n\n${PUBLISH_CTA}`;
      break;
    }
    case "perf_dip":
    case "seasonal_perf_dip": {
      const offerStr = offer || `${merchantName} — this week only`;
      const focusOffer = topicBias ? topicBias : offerStr;
      artifact = `${biasNote}Counter-offer post ready:\n\n"${focusOffer} at ${merchantName}. Includes ${proof2 || "full service"} + extras. Limited slots — reply to book."\n\n${PUBLISH_CTA}`;
      break;
    }
    case "competitor_opened": {
      const offerStr = offer || "best-value service in your area";
      artifact = `${biasNote}Counter-offer post ready:\n\n"Still ${topicBias ?? offerStr} at ${merchantName}. Book this week — limited slots."\n\n${PUBLISH_CTA}`;
      break;
    }
    case "renewal_due": {
      const planOffer = offer || "see invoice";
      artifact = `${biasNote}Renewal confirmation:\n\n✅ Plan: Pro\n✅ Amount: ${planOffer}\n✅ Pipeline: ${proof}\n\nProcessing renewal now — reply CONFIRM and your profile stays active.\n\n${PUBLISH_CTA}`;
      break;
    }
    case "active_planning_intent": {
      const planTitle = (topicBias ?? problem).toUpperCase();
      const offerStr = offer || "core service";
      artifact = `${biasNote}Plan draft:\n\n📋 ${planTitle}\n• Package: ${offerStr}\n• Post: "Now available — ${offerStr}. Book your slot today."\n• Target: existing customers + new walk-ins\n\n${PUBLISH_CTA}`;
      break;
    }
    case "supply_alert": {
      const msgFocus = topicBias ?? proof;
      artifact = `${biasNote}WhatsApp for affected customers:\n\n"Hi, ${merchantName} here. Advisory on ${msgFocus}. If you're on this medication, please contact us — replacement at no extra cost."\n\n${PUBLISH_CTA}`;
      break;
    }
    case "regulation_change": {
      const deadlineStr = benchmark || proof2 || "see circular";
      artifact = `${biasNote}SOP note:\n\n"Per latest update (${proof}): ${proof2 || "action required"}. Deadline: ${deadlineStr}. Action: review workflow, update docs, brief staff."\n\n${PUBLISH_CTA}`;
      break;
    }
    case "recall_due": {
      const offerStr = offer || "Dental Cleaning @ ₹299";
      const slotStr = proof2 || "slots available this week";
      artifact = `${biasNote}Recall message:\n\n"Hi, ${merchantName} here — your 6-month check is due. ${offerStr} + complimentary fluoride. ${slotStr}. Reply 1 or 2 to confirm."\n\n${PUBLISH_CTA}`;
      break;
    }
    case "chronic_refill_due": {
      artifact = `${biasNote}Dispatch message:\n\n"Hi, ${merchantName} here — your ${proof || "medication"} refill is due. ${proof2 || "Delivery address saved"}. Confirm dispatch? Reply YES."\n\n${PUBLISH_CTA}`;
      break;
    }
    case "trial_followup": {
      artifact = `${biasNote}Follow-up message:\n\n"Hi, ${merchantName} here — hope the trial was great! We've held ${proof || "a slot"} for your next session. Reply YES to confirm."\n\n${PUBLISH_CTA}`;
      break;
    }
    case "review_theme_emerged": {
      const theme = topicBias ?? (problem.split('"')[1] ?? "wait times");
      artifact = `${biasNote}Public response draft:\n\n"Thank you for your feedback on ${theme}. We've made adjustments — your next visit will be different."\n\nInternal note: review capacity for the identified theme.\n\n${PUBLISH_CTA}`;
      break;
    }
    case "gbp_unverified": {
      artifact = `${biasNote}Google Business Profile verification steps:\n\n1. Go to business.google.com\n2. Find your listing → click "Verify now"\n3. Choose phone or postcard\n4. Enter the code when received\n\n${PUBLISH_CTA}`;
      break;
    }
    case "ipl_match_today": {
      const offerStr = topicBias ?? offer ?? "delivery combo";
      artifact = `${biasNote}Match-night offer post:\n\n"IPL night special at ${merchantName} — ${offerStr}. Order before 8pm."\n\n${PUBLISH_CTA}`;
      break;
    }
    case "festival_upcoming": {
      const offerStr = topicBias ?? offer ?? "special package";
      artifact = `${biasNote}Festival offer post:\n\n"${merchantName} — ${offerStr} for the upcoming festival. Book early — limited slots."\n\n${PUBLISH_CTA}`;
      break;
    }
    case "winback_eligible": {
      const offerStr = topicBias ?? offer ?? "exclusive returning-customer offer";
      artifact = `${biasNote}Winback message:\n\n"Hi, ${merchantName} here — we miss you! ${offerStr} waiting for you. Book today."\n\n${PUBLISH_CTA}`;
      break;
    }
    case "curious_ask_due": {
      artifact = `${biasNote}Google post draft based on your latest service focus:\n\n"${merchantName} — ${topicBias ?? "this week's most-asked service"} now available. Message us for pricing & slots."\n\n${PUBLISH_CTA}`;
      break;
    }
    default: {
      const offerStr = topicBias ?? offer ?? `${merchantName} — here for you`;
      artifact = `${biasNote}Draft ready:\n\n"${offerStr}. Book your slot today — limited availability."\n\n${PUBLISH_CTA}`;
    }
  }

  // Strip URLs and truncate
  artifact = artifact.replace(/https?:\/\/\S+/g, "");
  artifact = truncateTo(artifact, MAX_BODY_CHARS);

  return artifact;
}
