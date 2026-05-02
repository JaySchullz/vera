import OpenAI from "openai";
import { VoiceProfile } from "./voice-profiles.js";
import { logger } from "./logger.js";

let _client: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (_client) return _client;
  const baseURL = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  const apiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "dummy";
  if (!baseURL) {
    logger.warn("AI_INTEGRATIONS_OPENAI_BASE_URL not set — LLM polish disabled, using template drafts");
    return null;
  }
  _client = new OpenAI({ baseURL, apiKey });
  return _client;
}

// Per-category few-shot examples (draft → polished) demonstrating engagement
// compulsion and category voice WITHOUT introducing new numbers.
// Rule: every number that appears in a polished output must also appear in its draft.
// Compulsion is achieved through: time-pressure, social proof (qualitative),
// loss framing, and curiosity — not invented statistics.
const FEW_SHOT_EXAMPLES: Record<string, Array<[string, string]>> = {
  dentists: [
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
  ],
  salons: [
    [
      "Meena, footfall dropped 30% this week (28 vs 40 baseline). Nearby salons are running a ₹599 hair-spa combo and getting back-to-back bookings. Want to try one?",
      "Meena, footfall thoda kam hua this week — 28 visits vs your usual 40. Salons near you running a ₹599 hair-spa combo are filling slots fast. Abhi trial karein before the weekend rush?",
    ],
    [
      "Meena, 5 clients haven't returned in 45 days. Want to send a win-back message?",
      "Meena, 5 regulars ne 45 din se visit nahi kiya — that's revenue slipping out quietly. Salons sending a 'we miss you' + ₹150 off message this week are pulling lapsed clients back. Want me to send it right now?",
    ],
    [
      "Meena, your reviews dropped from 4.6 to 4.2 this month. Competitors have higher ratings. Want to run a review campaign?",
      "Meena, rating 4.6 se 4.2 pe aa gayi this month — yeh customers check karte hain before booking. Salons that nudge happy clients for a quick review after service are climbing back noticeably. Shall I draft a polite post-visit nudge for your team?",
    ],
  ],
  gyms: [
    [
      "Rahul, member churn hit 18% this month vs 11% baseline. Nearby gyms are offering retention deals. Want to run one?",
      "Rahul, churn just hit 18% — 7 points above your 11% baseline and growing. Gyms running a 'freeze + comeback' plan this week are cutting drop-offs before the next billing cycle. Want me to build the outreach list now?",
    ],
    [
      "Rahul, footfall is down 25% this week (60 vs 80 baseline). Peak-hour slots are underutilised. Want to promote them?",
      "Rahul, floor traffic dropped to 60 check-ins vs your 80 baseline — 25% down and peak-hour slots are sitting half-empty. Gyms activating an off-peak promo this week are recovering floor density fast. Worth activating before Friday?",
    ],
    [
      "Rahul, 12 members have not visited in 3 weeks. They may churn. Want to send a re-engagement message?",
      "Rahul, 12 members haven't swiped in 3 weeks — a reliable pre-churn pattern. Coaches who send a personalised 'come back strong' nudge at this window recover most of them before the next billing cycle. Want me to draft the WhatsApp message right now?",
    ],
  ],
  restaurants: [
    [
      "Arjun, covers dropped 35% this week (65 vs 100 baseline). Nearby restaurants are running ₹249 weekday lunch sets. Want to try one?",
      "Arjun, covers are down to 65 this week — 35% below your 100-cover baseline and your AOV hasn't offset it. Restaurants near you running a ₹249 weekday lunch set are filling slow slots steadily. Worth trialing before Friday?",
    ],
    [
      "Arjun, profile views are up but repeat visits dropped 20%. Customers aren't coming back. Want to run a loyalty offer?",
      "Arjun, views are healthy but repeat footfall dipped 20% — guests are discovering you but not returning. Operators running a simple return-visit hook are turning that around week-on-week. Want me to draft the offer copy now?",
    ],
    [
      "Arjun, your average order value dropped from ₹480 to ₹380. Customers are ordering less. Want to run an upsell campaign?",
      "Arjun, AOV slid from ₹480 to ₹380 this week — that's ₹100 per cover left on the table. Restaurants prompting a small add-on at order time are recovering that gap quickly. Want me to build the upsell prompt for your team?",
    ],
  ],
  pharmacies: [
    [
      "Vikram, Metformin 500mg stock is low — only 3 days of supply left. Nearby pharmacies are running out too. Want to reorder?",
      "Vikram, Metformin 500mg (INN) stock is at a critical threshold — 3 days' cover based on current dispensing velocity. Distributors in your zone are already under allocation pressure. Reorder now before the window closes?",
    ],
    [
      "Vikram, 8 patients are due for chronic prescription refill this week. Want to send reminders?",
      "Vikram, 8 patients hit their chronic-prescription refill window this week — delayed Schedule H refills can trigger CDSCO compliance gaps. Pharmacies sending a timely WhatsApp refill nudge retain chronic customers far more reliably. Want me to draft the message?",
    ],
    [
      "Vikram, your footfall dropped 20% this week (40 vs 50 baseline). Nearby pharmacies are more active. Want to run a campaign?",
      "Vikram, footfall is 20% below baseline — 40 vs your usual 50 daily visits. Neighbourhood pharmacies offering a free BP check or sugar screening this week are pulling in new walk-ins without any discount. Worth running a 3-day pilot?",
    ],
  ],
};

function buildFewShotMessages(categorySlug: string): Array<{ role: "user" | "assistant"; content: string }> {
  const examples = FEW_SHOT_EXAMPLES[categorySlug] ?? FEW_SHOT_EXAMPLES["dentists"]!;
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const [draft, polished] of examples) {
    messages.push({ role: "user", content: `Draft:\n${draft}\n\nRewritten:` });
    messages.push({ role: "assistant", content: polished });
  }
  return messages;
}

export async function polishWithLLM(
  draft: string,
  voice: VoiceProfile,
  categorySlug: string,
): Promise<string> {
  const client = getClient();
  if (!client) return draft;

  const TIMEOUT_MS = 5000;

  const tokens: string[] = [];
  let tokenized = draft;

  tokenized = tokenized.replace(
    /(?:₹[\d,]+(?:\.\d+)?|\d[\d,]*(?:\.\d+)?%?(?:\s?(?:calls?|views?|leads?|reviews?|patients?|days?|months?|hours?|km|min|sec|pct|lakh|crore))?)/gi,
    (match) => {
      tokens.push(match);
      return `{{${tokens.length - 1}}}`;
    },
  );

  const tabooList = voice.taboos.map((t) => `"${t}"`).join(", ");

  const systemPrompt = `You are Vera, magicpin's merchant AI assistant. Your job is to rewrite WhatsApp message drafts so they score highest on: engagement compulsion, category fit, specificity, and merchant fit.

Voice profile for this merchant's category:
${voice.description}

Salutation format: ${voice.salutation}

Banned words / phrases (never use): ${tabooList}

Rewriting rules — follow ALL of these:
1. Preserve every {{N}} placeholder token exactly — they hold real numbers and will be restored later
2. Max 4 lines total
3. WhatsApp conversational style — never corporate, never generic
4. Add ONE engagement compulsion hook — choose from: time-pressure ("before Friday", "before the week closes"), social proof ("peer clinics are", "salons near you are"), loss framing ("revenue slipping out quietly"), or curiosity/insight ("classic pre-churn pattern")
5. End with exactly ONE actionable CTA question — category-specific, not generic ("let me know")
6. At most ONE humanization phrase (e.g. "Quick heads-up —")
7. CRITICAL — no new numbers: use only the specific numbers, percentages, and rupee values present in the draft as {{N}} tokens — do NOT invent or add any additional figures, statistics, or benchmarks
8. No URLs
9. Use trade terms appropriate for the category (e.g. covers/AOV for restaurants, churn% for gyms, INN molecule names for pharmacies, footfall/slots for salons/gyms)`;

  const fewShotMessages = buildFewShotMessages(categorySlug);

  const llmCall = client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      ...fewShotMessages,
      { role: "user", content: `Draft:\n${tokenized}\n\nRewritten:` },
    ],
    temperature: 0.2,
    max_tokens: 200,
  });

  const timeoutPromise = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), TIMEOUT_MS),
  );

  const result = await Promise.race([llmCall, timeoutPromise]);

  if (!result) {
    logger.warn("LLM polish timed out — using template draft");
    return draft;
  }

  let polished = result.choices[0]?.message?.content?.trim() ?? draft;

  for (let i = 0; i < tokens.length; i++) {
    polished = polished.replace(new RegExp(`\\{\\{${i}\\}\\}`, "g"), tokens[i]!);
  }

  return polished;
}
