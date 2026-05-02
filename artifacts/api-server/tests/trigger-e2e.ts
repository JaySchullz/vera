#!/usr/bin/env node
/**
 * End-to-end judge simulation tests covering all 17+ trigger kinds.
 *
 * Validates per action:
 *   - body contains a digit
 *   - body contains no URLs
 *   - body contains merchant or customer name (business name OR owner first name)
 *   - CTA is present
 *   - rationale is non-empty
 *
 * Also validates:
 *   - suppression: second tick with same suppression_key returns actions:[]
 *   - state machine: auto-reply → wait → nudge(clarify) → opt-out → end → ended:end
 *   - ambiguous reply → clarify (binary_yes_no CTA)
 *   - out-of-scope reply → redirect (open_ended CTA)
 *
 * Usage:
 *   API_URL=http://localhost:8080 node --import tsx/esm artifacts/api-server/tests/trigger-e2e.ts
 *   pnpm --filter @workspace/api-server run test:e2e
 */

const BASE_URL = process.env["API_URL"] ?? `http://localhost:${process.env["PORT"] ?? 8080}`;
const NOW = "2026-05-01T10:00:00Z";

// ── Colour helpers ────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

let passed = 0;
let failed = 0;
const failures: string[] = [];

function pass(label: string) {
  console.log(`  ${c.green}[PASS]${c.reset} ${label}`);
  passed++;
}

function fail(label: string, detail?: string) {
  const msg = detail ? `${label} — ${detail}` : label;
  console.log(`  ${c.red}[FAIL]${c.reset} ${msg}`);
  failed++;
  failures.push(msg);
}

function section(name: string) {
  console.log(`\n${c.cyan}${c.bold}── ${name} ──${c.reset}`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function pushContext(
  scope: string,
  contextId: string,
  version: number,
  payload: unknown,
): Promise<void> {
  await post("/v1/context", {
    scope,
    context_id: contextId,
    version,
    payload,
    delivered_at: NOW,
  });
}

async function tick(triggerIds: string[]): Promise<{ actions: Action[] }> {
  return post("/v1/tick", { now: NOW, available_triggers: triggerIds }) as Promise<{
    actions: Action[];
  }>;
}

async function reply(
  conversationId: string,
  merchantId: string,
  message: string,
  turnNumber = 2,
  fromRole = "merchant",
): Promise<ReplyResponse> {
  return post("/v1/reply", {
    conversation_id: conversationId,
    merchant_id: merchantId,
    from_role: fromRole,
    message,
    received_at: NOW,
    turn_number: turnNumber,
  }) as Promise<ReplyResponse>;
}

interface Action {
  conversation_id: string;
  merchant_id: string;
  customer_id: string | null;
  send_as: string;
  trigger_id: string;
  template_name: string;
  template_params: Record<string, string>;
  body: string;
  cta: string;
  suppression_key: string;
  rationale: string;
}

interface ReplyResponse {
  action: string;
  body?: string;
  cta?: string;
  rationale?: string;
  wait_seconds?: number;
}

// ── Validation helpers ────────────────────────────────────────────────────────
function validateAction(action: Action, triggerKind: string, identifiers: string[]) {
  const prefix = `[${triggerKind}]`;

  if (/\d/.test(action.body)) {
    pass(`${prefix} body contains a digit`);
  } else {
    fail(`${prefix} body must contain a digit`, `got: "${action.body.slice(0, 120)}"`);
  }

  if (!/https?:\/\/\S+/.test(action.body)) {
    pass(`${prefix} body has no URLs`);
  } else {
    fail(`${prefix} body must not contain URLs`, `body starts: "${action.body.slice(0, 80)}"`);
  }

  const bodyLower = action.body.toLowerCase();
  const found = identifiers.some((id) => id.length > 0 && bodyLower.includes(id.toLowerCase()));
  if (found) {
    pass(`${prefix} body contains merchant/customer name`);
  } else {
    fail(
      `${prefix} body must contain one of [${identifiers.join(" | ")}]`,
      `got: "${action.body.slice(0, 120)}"`,
    );
  }

  if (action.cta && action.cta.length > 0) {
    pass(`${prefix} CTA is present ("${action.cta}")`);
  } else {
    fail(`${prefix} CTA must be non-empty`);
  }

  if (action.rationale && action.rationale.length > 0) {
    pass(`${prefix} rationale is non-empty`);
  } else {
    fail(`${prefix} rationale must be non-empty`);
  }
}

// ── Category payloads ─────────────────────────────────────────────────────────
const CATEGORIES: Record<string, unknown> = {
  dentists: {
    slug: "dentists",
    display_name: "Dentists & Dental Clinics",
    voice: {
      tone: "peer_to_peer",
      persona: "specialist advisor",
      vocab_taboo: ["discount", "cheap", "deal", "sale"],
      preferred_opener: "Clinical",
    },
    peer_stats: { avg_calls_30d: 22, avg_views_30d: 3200, median_ctr: 0.025 },
    offer_catalog: [
      { id: "cat_dent_001", type: "service_at_price", title: "Dental Cleaning @ ₹299" },
    ],
    digest: [
      {
        id: "d_2026W17_jida_fluoride",
        title: "Fluoride Varnish Cuts Caries 38%",
        source: "JIDA 2026-W17",
        trial_n: 1200,
        summary:
          "Fluoride varnish applied bi-annually reduces caries recurrence by 38% in adult patients over 24 months.",
        patient_segment: "adult",
        actionable: "Recommend bi-annual fluoride varnish for high-risk adults",
      },
      {
        id: "d_2026W17_dci_radiograph",
        title: "DCI Radiograph Protocols Updated",
        source: "DCI Circular 2026",
        summary:
          "DCI updated radiograph capture and record-keeping requirements effective Dec 2026.",
        actionable: "Update your radiograph record-keeping workflow before Dec 2026",
      },
      {
        id: "d_2026W17_ida_webinar",
        title: "IDA CDE Webinar: Implant Advances",
        source: "IDA",
        summary: "Free webinar on implant advances, 2 CDE credits, members only.",
      },
    ],
  },
  pharmacies: {
    slug: "pharmacies",
    display_name: "Pharmacies",
    voice: { tone: "trustworthy_precise", persona: "pharmacist advisor", vocab_taboo: [] },
    peer_stats: { avg_calls_30d: 35, avg_views_30d: 1800 },
    offer_catalog: [
      { id: "cat_pharm_001", type: "service_at_price", title: "Free Home Delivery on orders ₹299+" },
    ],
    digest: [
      {
        id: "d_2026W17_atorvastatin_recall",
        title: "Atorvastatin Recall Notice",
        source: "CDSCO",
        summary:
          "Batches AT2024-1102 and AT2024-1108 of atorvastatin recalled due to sub-potency. Pull from shelf within 48h.",
        actionable: "Pull listed batches and notify affected patients",
      },
    ],
  },
  salons: {
    slug: "salons",
    display_name: "Salons & Spas",
    voice: { tone: "warm_friendly", persona: "style advisor", vocab_taboo: [] },
    peer_stats: { avg_calls_30d: 28, avg_views_30d: 2100 },
    offer_catalog: [
      { id: "cat_salon_001", type: "service_at_price", title: "Bridal Trial @ ₹1499" },
    ],
    digest: [{ id: "d_salon_001", title: "Bridal Season Bookings Up 42%", source: "Industry" }],
  },
  restaurants: {
    slug: "restaurants",
    display_name: "Restaurants",
    voice: { tone: "operator_to_operator", persona: "business partner", vocab_taboo: [] },
    peer_stats: { avg_calls_30d: 40, avg_views_30d: 4500 },
    offer_catalog: [
      { id: "cat_rest_001", type: "service_at_price", title: "Match Night Combo @ ₹199" },
    ],
    digest: [{ id: "d_rest_001", title: "IPL Delivery Orders Up 18%", source: "Swiggy Trends" }],
  },
  gyms: {
    slug: "gyms",
    display_name: "Gyms & Fitness Centers",
    voice: { tone: "coaching_motivational", persona: "fitness coach", vocab_taboo: [] },
    peer_stats: { avg_calls_30d: 20, avg_views_30d: 1400 },
    offer_catalog: [
      { id: "cat_gym_001", type: "service_at_price", title: "Trial Session @ ₹99" },
    ],
    digest: [{ id: "d_gym_001", title: "Post-Resolution Drop Pattern", source: "Industry" }],
  },
};

// ── Merchant factory ──────────────────────────────────────────────────────────
// Each trigger gets a UNIQUE merchant ID to avoid 6h cooldown interference.
const CAT_IDENTITY: Record<
  string,
  { businessName: string; ownerName: string; locality: string }
> = {
  dentists: {
    businessName: "Dr. Meera's Dental Clinic",
    ownerName: "Meera",
    locality: "Lajpat Nagar",
  },
  pharmacies: {
    businessName: "Apollo Pharmacy Jaipur",
    ownerName: "Arjun",
    locality: "Civil Lines",
  },
  salons: { businessName: "Studio11 Family Salon", ownerName: "Lakshmi", locality: "Kapra" },
  restaurants: {
    businessName: "Pizza Junction Delhi",
    ownerName: "Rajesh",
    locality: "Connaught Place",
  },
  gyms: {
    businessName: "Powerhouse Gym Bangalore",
    ownerName: "Vikram",
    locality: "Koramangala",
  },
};

function makeMerchant(
  id: string,
  catSlug: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const info = CAT_IDENTITY[catSlug] ?? CAT_IDENTITY["dentists"]!;
  return {
    merchant_id: id,
    category_slug: catSlug,
    identity: {
      name: info.businessName,
      city: "Delhi",
      locality: info.locality,
      owner_first_name: info.ownerName,
      verified: true,
      languages: ["en", "hi"],
      established_year: 2018,
    },
    subscription: { status: "active", plan: "Pro", days_remaining: 60, renewed_at: "2026-02-01" },
    performance: {
      window_days: 30,
      views: 2400,
      calls: 18,
      directions: 40,
      ctr: 0.021,
      leads: 9,
      delta_7d: { views_pct: -0.1, calls_pct: -0.5, ctr_pct: -0.05 },
    },
    offers: [
      { id: "o_001", title: "Dental Cleaning @ ₹299", status: "active", started: "2026-03-01" },
    ],
    customer_aggregate: {
      total_unique_ytd: 540,
      lapsed_180d_plus: 78,
      retention_6mo_pct: 0.38,
      high_risk_adult_count: 124,
    },
    signals: ["stale_posts:22d", "high_risk_adult_cohort", "engaged_in_last_48h"],
    review_themes: [],
    ...extra,
  };
}

function makeCustomer(
  customerId: string,
  merchantId: string,
  name: string,
): Record<string, unknown> {
  return {
    customer_id: customerId,
    merchant_id: merchantId,
    identity: {
      name,
      phone_redacted: "<phone>",
      language_pref: "english",
      age_band: "25-35",
    },
    relationship: {
      first_visit: "2025-11-01",
      last_visit: "2026-01-01",
      visits_total: 3,
      services_received: ["cleaning"],
      lifetime_value: 1200,
    },
    state: "lapsed_soft",
    preferences: {
      preferred_slots: "weekday_evening",
      channel: "whatsapp",
      reminder_opt_in: true,
    },
    consent: {
      opted_in_at: "2025-11-01",
      scope: ["recall_reminders", "appointment_reminders"],
    },
  };
}

// ── Trigger definitions (one unique merchant per trigger) ─────────────────────
interface TriggerSpec {
  id: string;
  kind: string;
  merchantId: string;
  categorySlug: string;
  customerId?: string;
  customerName?: string;
  scope?: "merchant" | "customer";
  payload: Record<string, unknown>;
  urgency?: number;
  suppressionKey: string;
  expiresAt?: string;
  extraMerchantFields?: Record<string, unknown>;
}

const FAR_FUTURE = "2027-06-01T00:00:00Z";

const TRIGGER_SPECS: TriggerSpec[] = [
  // 1. research_digest
  {
    id: "te_01_research_digest",
    kind: "research_digest",
    merchantId: "mx_01_dentist",
    categorySlug: "dentists",
    payload: { category: "dentists", top_item_id: "d_2026W17_jida_fluoride" },
    urgency: 2,
    suppressionKey: "te:research:dentists:w17",
    expiresAt: FAR_FUTURE,
  },
  // 2. perf_dip
  {
    id: "te_02_perf_dip",
    kind: "perf_dip",
    merchantId: "mx_02_dentist",
    categorySlug: "dentists",
    payload: { metric: "calls", delta_pct: -0.5, window: "7d", vs_baseline: 12 },
    urgency: 4,
    suppressionKey: "te:perf_dip:mx02:calls:w17",
    expiresAt: FAR_FUTURE,
  },
  // 3. seasonal_perf_dip
  {
    id: "te_03_seasonal_perf_dip",
    kind: "seasonal_perf_dip",
    merchantId: "mx_03_gym",
    categorySlug: "gyms",
    payload: {
      metric: "views",
      delta_pct: -0.3,
      window: "7d",
      is_expected_seasonal: true,
      vs_baseline: 1400,
    },
    urgency: 1,
    suppressionKey: "te:seasonal_dip:mx03:q2",
    expiresAt: FAR_FUTURE,
  },
  // 4. renewal_due
  {
    id: "te_04_renewal_due",
    kind: "renewal_due",
    merchantId: "mx_04_dentist",
    categorySlug: "dentists",
    payload: { days_remaining: 5, plan: "Pro", renewal_amount: 4999 },
    urgency: 4,
    suppressionKey: "te:renewal:mx04:q2",
    expiresAt: FAR_FUTURE,
  },
  // 5. recall_due (customer-scoped)
  {
    id: "te_05_recall_due",
    kind: "recall_due",
    merchantId: "mx_05_dentist",
    categorySlug: "dentists",
    customerId: "cx_05_priya",
    customerName: "Priya",
    scope: "customer",
    payload: {
      service_due: "6_month_cleaning",
      last_service_date: "2025-11-01",
      available_slots: [
        { iso: "2026-11-05T18:00:00+05:30", label: "Wed 5 Nov, 6pm" },
        { iso: "2026-11-06T17:00:00+05:30", label: "Thu 6 Nov, 5pm" },
      ],
    },
    urgency: 3,
    suppressionKey: "te:recall:cx05:6mo",
    expiresAt: FAR_FUTURE,
  },
  // 6. competitor_opened
  {
    id: "te_06_competitor_opened",
    kind: "competitor_opened",
    merchantId: "mx_06_dentist",
    categorySlug: "dentists",
    payload: {
      competitor_name: "Smile Studio",
      distance_km: 1.3,
      their_offer: "Dental Cleaning @ ₹199",
    },
    urgency: 2,
    suppressionKey: "te:competitor:mx06:smile",
    expiresAt: FAR_FUTURE,
  },
  // 7. ipl_match_today
  {
    id: "te_07_ipl_match_today",
    kind: "ipl_match_today",
    merchantId: "mx_07_restaurant",
    categorySlug: "restaurants",
    payload: {
      match: "DC vs MI",
      venue: "Arun Jaitley Stadium",
      city: "Delhi",
      match_time_iso: "2026-05-01T19:30:00+05:30",
      is_weeknight: true,
    },
    urgency: 3,
    suppressionKey: "te:ipl:mx07:20260501",
    expiresAt: FAR_FUTURE,
  },
  // 8. review_theme_emerged
  {
    id: "te_08_review_theme",
    kind: "review_theme_emerged",
    merchantId: "mx_08_restaurant",
    categorySlug: "restaurants",
    payload: {
      theme: "delivery_late",
      occurrences_30d: 4,
      trend: "rising",
      common_quote: "took 50 mins for a 15 min ride",
    },
    urgency: 3,
    suppressionKey: "te:review_theme:mx08:delivery",
    expiresAt: FAR_FUTURE,
  },
  // 9. curious_ask_due
  {
    id: "te_09_curious_ask_due",
    kind: "curious_ask_due",
    merchantId: "mx_09_salon",
    categorySlug: "salons",
    payload: { ask_template: "what_service_in_demand_this_week", last_ask_at: null },
    urgency: 1,
    suppressionKey: "te:curious_ask:mx09:w17",
    expiresAt: FAR_FUTURE,
  },
  // 10. active_planning_intent
  {
    id: "te_10_active_planning",
    kind: "active_planning_intent",
    merchantId: "mx_10_restaurant",
    categorySlug: "restaurants",
    payload: {
      intent_topic: "corporate_bulk_thali_package",
      merchant_last_message: "Yes good idea, what would it look like",
    },
    urgency: 4,
    suppressionKey: "te:planning:mx10:corp_thali:w17",
    expiresAt: FAR_FUTURE,
  },
  // 11. supply_alert
  {
    id: "te_11_supply_alert",
    kind: "supply_alert",
    merchantId: "mx_11_pharmacy",
    categorySlug: "pharmacies",
    payload: {
      alert_id: "d_2026W17_atorvastatin_recall",
      molecule: "atorvastatin",
      affected_batches: ["AT2024-1102", "AT2024-1108"],
      issue: "sub_potency",
    },
    urgency: 5,
    suppressionKey: "te:alert:atorvastatin:mx11",
    expiresAt: FAR_FUTURE,
    extraMerchantFields: {
      customer_aggregate: { total_unique_ytd: 320, lapsed_180d_plus: 40, retention_6mo_pct: 0.72 },
    },
  },
  // 12. regulation_change
  {
    id: "te_12_regulation_change",
    kind: "regulation_change",
    merchantId: "mx_12_dentist",
    categorySlug: "dentists",
    payload: { top_item_id: "d_2026W17_dci_radiograph", deadline_iso: "2026-12-15" },
    urgency: 4,
    suppressionKey: "te:compliance:dci_radiograph:mx12",
    expiresAt: FAR_FUTURE,
  },
  // 13. chronic_refill_due (customer-scoped)
  {
    id: "te_13_chronic_refill_due",
    kind: "chronic_refill_due",
    merchantId: "mx_13_pharmacy",
    categorySlug: "pharmacies",
    customerId: "cx_13_raman",
    customerName: "Raman",
    scope: "customer",
    payload: {
      molecule_list: ["metformin", "atorvastatin", "telmisartan"],
      last_refill: "2026-03-26",
      stock_runs_out_iso: "2026-05-10T00:00:00+05:30",
      delivery_address_saved: true,
    },
    urgency: 3,
    suppressionKey: "te:refill:cx13:2026-04",
    expiresAt: FAR_FUTURE,
  },
  // 14. dormant_with_vera
  {
    id: "te_14_dormant_with_vera",
    kind: "dormant_with_vera",
    merchantId: "mx_14_salon",
    categorySlug: "salons",
    payload: { days_since_last_merchant_message: 38, last_topic: "subscription_expiry" },
    urgency: 2,
    suppressionKey: "te:dormant:mx14:30d",
    expiresAt: FAR_FUTURE,
  },
  // 15. winback_eligible
  {
    id: "te_15_winback_eligible",
    kind: "winback_eligible",
    merchantId: "mx_15_salon",
    categorySlug: "salons",
    payload: {
      days_since_expiry: 38,
      perf_dip_pct: -0.3,
      lapsed_customers_added_since_expiry: 24,
    },
    urgency: 2,
    suppressionKey: "te:winback:mx15",
    expiresAt: FAR_FUTURE,
  },
  // 16. festival_upcoming
  {
    id: "te_16_festival_upcoming",
    kind: "festival_upcoming",
    merchantId: "mx_16_salon",
    categorySlug: "salons",
    payload: { festival: "Diwali", date: "2026-10-31", days_until: 183 },
    urgency: 1,
    suppressionKey: "te:festival:diwali:mx16",
    expiresAt: FAR_FUTURE,
  },
  // 17. perf_spike
  {
    id: "te_17_perf_spike",
    kind: "perf_spike",
    merchantId: "mx_17_gym",
    categorySlug: "gyms",
    payload: { metric: "calls", delta_pct: 0.15, window: "7d", vs_baseline: 18 },
    urgency: 1,
    suppressionKey: "te:perf_spike:mx17:calls:w17",
    expiresAt: FAR_FUTURE,
  },
  // 18. milestone_reached
  {
    id: "te_18_milestone_reached",
    kind: "milestone_reached",
    merchantId: "mx_18_restaurant",
    categorySlug: "restaurants",
    payload: { metric: "review_count", value_now: 145, milestone_value: 150, is_imminent: true },
    urgency: 1,
    suppressionKey: "te:milestone:mx18:reviews_150",
    expiresAt: FAR_FUTURE,
  },
  // 19. trial_followup (customer-scoped)
  {
    id: "te_19_trial_followup",
    kind: "trial_followup",
    merchantId: "mx_19_gym",
    categorySlug: "gyms",
    customerId: "cx_19_karthik",
    customerName: "Karthik",
    scope: "customer",
    payload: {
      trial_date: "2026-04-22",
      next_session_options: [{ iso: "2026-05-03T08:00:00+05:30", label: "Sat 3 May, 8am" }],
    },
    urgency: 2,
    suppressionKey: "te:trial_followup:cx19:2026",
    expiresAt: FAR_FUTURE,
  },
  // 20. gbp_unverified
  {
    id: "te_20_gbp_unverified",
    kind: "gbp_unverified",
    merchantId: "mx_20_pharmacy",
    categorySlug: "pharmacies",
    payload: {
      verified: false,
      verification_path: "postcard_or_phone_call",
      estimated_uplift_pct: 0.3,
    },
    urgency: 3,
    suppressionKey: "te:unverified:mx20",
    expiresAt: FAR_FUTURE,
  },
  // 21. wedding_package_followup (customer-scoped)
  {
    id: "te_21_wedding_package",
    kind: "wedding_package_followup",
    merchantId: "mx_21_salon",
    categorySlug: "salons",
    customerId: "cx_21_kavya",
    customerName: "Kavya",
    scope: "customer",
    payload: {
      wedding_date: "2026-11-08",
      trial_completed: "2026-03-22",
      days_to_wedding: 191,
      next_step_window_open: "skin_prep_program_30day",
    },
    urgency: 2,
    suppressionKey: "te:bridal_followup:cx21",
    expiresAt: FAR_FUTURE,
  },
  // 22. customer_lapsed_hard (customer-scoped)
  {
    id: "te_22_customer_lapsed_hard",
    kind: "customer_lapsed_hard",
    merchantId: "mx_22_gym",
    categorySlug: "gyms",
    customerId: "cx_22_rashmi",
    customerName: "Rashmi",
    scope: "customer",
    payload: {
      days_since_last_visit: 57,
      previous_focus: "weight_loss",
      previous_membership_months: 5,
    },
    urgency: 3,
    suppressionKey: "te:winback:cx22:gym",
    expiresAt: FAR_FUTURE,
  },
  // 23. cde_opportunity
  {
    id: "te_23_cde_opportunity",
    kind: "cde_opportunity",
    merchantId: "mx_23_dentist",
    categorySlug: "dentists",
    payload: { digest_item_id: "d_2026W17_ida_webinar", credits: 2, fee: "free_for_members" },
    urgency: 1,
    suppressionKey: "te:cde:dentists:2026-05-02",
    expiresAt: FAR_FUTURE,
  },
  // 24. category_seasonal
  {
    id: "te_24_category_seasonal",
    kind: "category_seasonal",
    merchantId: "mx_24_pharmacy",
    categorySlug: "pharmacies",
    payload: {
      season: "summer_2026",
      trends: ["ORS_demand_+40", "sunscreen_demand_+38"],
      shelf_action_recommended: true,
    },
    urgency: 2,
    suppressionKey: "te:season:summer:mx24:2026",
    expiresAt: FAR_FUTURE,
  },
  // 25 — suppression test: supply_alert with urgency>=5 bypasses the 6h merchant cooldown,
  //      so the ONLY reason the second tick can return actions:[] is suppression itself.
  {
    id: "te_25_supp_test",
    kind: "supply_alert",
    merchantId: "mx_25_pharmacy",
    categorySlug: "pharmacies",
    payload: {
      molecule: "ibuprofen",
      affected_batches: ["IB2024-0101"],
      issue: "contamination",
    },
    urgency: 5,
    suppressionKey: "te:supp_test:mx25:supply_alert",
    expiresAt: FAR_FUTURE,
    extraMerchantFields: {
      customer_aggregate: { total_unique_ytd: 200, lapsed_180d_plus: 30, retention_6mo_pct: 0.65 },
    },
  },
  // 26 — state-machine trigger (unique merchant mx_26)
  {
    id: "te_26_state_machine",
    kind: "milestone_reached",
    merchantId: "mx_26_restaurant",
    categorySlug: "restaurants",
    payload: { metric: "review_count", value_now: 145, milestone_value: 150, is_imminent: true },
    urgency: 1,
    suppressionKey: "te:state_machine:mx26:milestone",
    expiresAt: FAR_FUTURE,
  },
  // 27 — clarify-branch trigger (unique merchant mx_27)
  {
    id: "te_27_clarify",
    kind: "regulation_change",
    merchantId: "mx_27_dentist",
    categorySlug: "dentists",
    payload: { top_item_id: "d_2026W17_dci_radiograph", deadline_iso: "2026-12-15" },
    urgency: 4,
    suppressionKey: "te:clarify:mx27:dci",
    expiresAt: FAR_FUTURE,
  },
  // 28 — redirect-branch trigger (unique merchant mx_28)
  {
    id: "te_28_redirect",
    kind: "winback_eligible",
    merchantId: "mx_28_salon",
    categorySlug: "salons",
    payload: {
      days_since_expiry: 38,
      perf_dip_pct: -0.3,
      lapsed_customers_added_since_expiry: 24,
    },
    urgency: 2,
    suppressionKey: "te:redirect:mx28:winback",
    expiresAt: FAR_FUTURE,
  },
];

// ── Push all required contexts ────────────────────────────────────────────────
async function pushAllContexts() {
  section("Pushing contexts");

  // Categories (pre-loaded on server startup, but push to be safe)
  for (const [slug, data] of Object.entries(CATEGORIES)) {
    await pushContext("category", slug, 2, data);
  }
  console.log(`  ${c.dim}Pushed ${Object.keys(CATEGORIES).length} category contexts${c.reset}`);

  // Unique merchants — one per trigger spec
  const pushedMerchants = new Set<string>();
  for (const spec of TRIGGER_SPECS) {
    if (pushedMerchants.has(spec.merchantId)) continue;
    pushedMerchants.add(spec.merchantId);
    const m = makeMerchant(spec.merchantId, spec.categorySlug, spec.extraMerchantFields ?? {});
    await pushContext("merchant", spec.merchantId, 1, m);
  }
  console.log(`  ${c.dim}Pushed ${pushedMerchants.size} merchant contexts${c.reset}`);

  // Customers
  for (const spec of TRIGGER_SPECS) {
    if (spec.customerId && spec.customerName) {
      await pushContext(
        "customer",
        spec.customerId,
        1,
        makeCustomer(spec.customerId, spec.merchantId, spec.customerName),
      );
    }
  }
  const customerCount = TRIGGER_SPECS.filter((s) => s.customerId).length;
  console.log(`  ${c.dim}Pushed ${customerCount} customer contexts${c.reset}`);

  // Triggers
  for (const spec of TRIGGER_SPECS) {
    await pushContext("trigger", spec.id, 1, {
      id: spec.id,
      scope: spec.scope ?? "merchant",
      kind: spec.kind,
      source: "internal",
      merchant_id: spec.merchantId,
      customer_id: spec.customerId ?? null,
      payload: spec.payload,
      urgency: spec.urgency ?? 2,
      suppression_key: spec.suppressionKey,
      expires_at: spec.expiresAt ?? FAR_FUTURE,
    });
  }
  console.log(`  ${c.dim}Pushed ${TRIGGER_SPECS.length} trigger contexts${c.reset}`);
}

// ── Test each of the 24 trigger kinds (indices 0-23) ─────────────────────────
async function testAllTriggerKinds() {
  // Specs 0-23 are the 24 distinct trigger kind tests
  const kindSpecs = TRIGGER_SPECS.slice(0, 24);
  section(`Testing ${kindSpecs.length} trigger kinds`);

  for (const spec of kindSpecs) {
    const result = await tick([spec.id]);

    if (!result.actions || result.actions.length === 0) {
      fail(`[${spec.kind}] tick returned no actions`, "expected at least one action");
      continue;
    }

    const action = result.actions[0]!;
    const catInfo = CAT_IDENTITY[spec.categorySlug] ?? CAT_IDENTITY["dentists"]!;

    // Identifiers: business name, owner first name, customer name (if present)
    const identifiers: string[] = [catInfo.businessName, catInfo.ownerName];
    if (spec.customerName) identifiers.push(spec.customerName);

    validateAction(action, spec.kind, identifiers);
  }
}

// ── Test suppression ──────────────────────────────────────────────────────────
async function testSuppression() {
  section("Testing suppression");

  // First tick of te_25 — should succeed
  const first = await tick(["te_25_supp_test"]);
  if (first.actions.length > 0) {
    pass("[suppression] first tick fires correctly");
  } else {
    fail("[suppression] first tick should fire but returned actions:[]");
    return; // Can't test suppression if first tick didn't fire
  }

  // Second tick of te_25 — suppression_key already consumed, should return []
  const second = await tick(["te_25_supp_test"]);
  if (second.actions.length === 0) {
    pass("[suppression] second tick with same suppression_key returns actions:[]");
  } else {
    fail(
      "[suppression] second tick should return actions:[]",
      `got ${second.actions.length} action(s)`,
    );
  }

  // Third tick — still suppressed
  const third = await tick(["te_25_supp_test"]);
  if (third.actions.length === 0) {
    pass("[suppression] third tick still returns actions:[]");
  } else {
    fail("[suppression] third tick should still be suppressed");
  }
}

// ── Test state machine ────────────────────────────────────────────────────────
async function testStateMachine() {
  section("Testing state machine");

  // 1. Initial tick → conversation created
  const smResult = await tick(["te_26_state_machine"]);
  if (!smResult.actions || smResult.actions.length === 0) {
    fail("[state-machine] initial tick returned no actions");
    return;
  }
  const action = smResult.actions[0]!;
  const convId = action.conversation_id;
  const merchantId = action.merchant_id;
  console.log(`  ${c.dim}Conv: ${convId}${c.reset}`);

  // 2. Auto-reply → expect wait
  const waitResp = await reply(
    convId,
    merchantId,
    "Thank you for contacting us! Our team will respond shortly.",
    2,
  );
  if (waitResp.action === "wait") {
    pass('[state-machine] auto-reply → action:"wait"');
  } else {
    fail('[state-machine] auto-reply should return action:"wait"', `got:"${waitResp.action}"`);
  }
  if ((waitResp.wait_seconds ?? 0) > 0) {
    pass(`[state-machine] wait_seconds > 0 (${waitResp.wait_seconds}s)`);
  } else {
    fail("[state-machine] wait_seconds must be positive", `got: ${waitResp.wait_seconds}`);
  }

  // 3. Ambiguous real reply after backoff → expect nudge (clarify send)
  //    This validates the "wait → nudge" transition: after the auto-reply backoff expires
  //    the merchant sends a genuine but unclear reply, and Vera sends a clarify nudge.
  const nudgeResp = await reply(convId, merchantId, "What exactly does this mean?", 3);
  if (nudgeResp.action === "send") {
    pass('[state-machine] ambiguous reply after wait → action:"send" (nudge/clarify)');
  } else {
    fail(
      '[state-machine] ambiguous reply should produce nudge (action:"send")',
      `got:"${nudgeResp.action}"`,
    );
  }
  if (nudgeResp.cta === "binary_yes_no") {
    pass('[state-machine] nudge CTA is "binary_yes_no"');
  } else {
    fail('[state-machine] nudge CTA should be "binary_yes_no"', `got:"${nudgeResp.cta}"`);
  }

  // 4. Opt-out → expect end
  const endResp = await reply(convId, merchantId, "Stop sending me messages. This is useless.", 4);
  if (endResp.action === "end") {
    pass('[state-machine] opt-out → action:"end"');
  } else {
    fail('[state-machine] opt-out should return action:"end"', `got:"${endResp.action}"`);
  }

  // 5. Reply to ended conversation → still end
  const afterEndResp = await reply(convId, merchantId, "Hello again", 5);
  if (afterEndResp.action === "end") {
    pass('[state-machine] reply to ended conv → action:"end"');
  } else {
    fail(
      '[state-machine] reply to ended conv should return "end"',
      `got:"${afterEndResp.action}"`,
    );
  }
}

// ── Test clarify branch ───────────────────────────────────────────────────────
async function testClarifyBranch() {
  section("Testing ambiguous reply → clarify");

  const result = await tick(["te_27_clarify"]);
  if (!result.actions || result.actions.length === 0) {
    fail("[clarify] initial tick returned no actions");
    return;
  }
  const action = result.actions[0]!;
  const convId = action.conversation_id;
  const merchantId = action.merchant_id;

  const resp = await reply(convId, merchantId, "What exactly does this mean?", 2);
  if (resp.action === "send") {
    pass('[clarify] ambiguous reply → action:"send" (clarify)');
  } else {
    fail('[clarify] ambiguous reply should return action:"send"', `got:"${resp.action}"`);
  }
  if (resp.cta === "binary_yes_no") {
    pass('[clarify] clarify CTA is "binary_yes_no"');
  } else {
    fail('[clarify] clarify CTA should be "binary_yes_no"', `got:"${resp.cta}"`);
  }
  if (resp.rationale && resp.rationale.length > 0) {
    pass("[clarify] clarify response has rationale");
  } else {
    fail("[clarify] clarify response must have rationale");
  }
}

// ── Test redirect branch ──────────────────────────────────────────────────────
async function testRedirectBranch() {
  section("Testing out-of-scope reply → redirect");

  const result = await tick(["te_28_redirect"]);
  if (!result.actions || result.actions.length === 0) {
    fail("[redirect] initial tick returned no actions");
    return;
  }
  const action = result.actions[0]!;
  const convId = action.conversation_id;
  const merchantId = action.merchant_id;

  const resp = await reply(convId, merchantId, "Can you help me with my GST filing?", 2);
  if (resp.action === "send") {
    pass('[redirect] out-of-scope reply → action:"send" (redirect)');
  } else {
    fail('[redirect] out-of-scope reply should return action:"send"', `got:"${resp.action}"`);
  }
  if (resp.cta === "open_ended") {
    pass('[redirect] redirect CTA is "open_ended"');
  } else {
    fail('[redirect] redirect CTA should be "open_ended"', `got:"${resp.cta}"`);
  }
  const bodyLower = (resp.body ?? "").toLowerCase();
  if (bodyLower.includes("expert") || bodyLower.includes("outside") || bodyLower.includes("leave")) {
    pass("[redirect] redirect body acknowledges scope limitation");
  } else {
    fail("[redirect] redirect body should acknowledge scope limit", `body:"${resp.body}"`);
  }
}

// ── Health check ──────────────────────────────────────────────────────────────
async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/v1/healthz`);
    if (!res.ok) return false;
    const data = (await res.json()) as { status?: string };
    if (data.status === "ok" || res.ok) {
      console.log(`  ${c.green}Server reachable at ${BASE_URL}${c.reset}`);
      return true;
    }
    return false;
  } catch {
    console.log(`  ${c.red}Server not reachable at ${BASE_URL}${c.reset}`);
    return false;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${c.bold}${c.cyan}${"═".repeat(62)}${c.reset}`);
  console.log(`${c.bold}${c.cyan}  Judge Simulation — All Trigger Kinds E2E Test Suite${c.reset}`);
  console.log(`${c.bold}${c.cyan}${"═".repeat(62)}${c.reset}`);
  console.log(`  Target: ${BASE_URL}`);

  section("Health check");
  const healthy = await checkHealth();
  if (!healthy) {
    console.log(
      `\n${c.red}${c.bold}FATAL: Server not reachable. Start with:${c.reset}`,
    );
    console.log(`  PORT=8080 pnpm --filter @workspace/api-server run dev\n`);
    process.exit(1);
  }

  await pushAllContexts();
  await testAllTriggerKinds();
  await testSuppression();
  await testStateMachine();
  await testClarifyBranch();
  await testRedirectBranch();

  const total = passed + failed;
  console.log(`\n${c.bold}${"═".repeat(62)}${c.reset}`);
  const resultColor = failed > 0 ? c.red : c.green;
  console.log(
    `${c.bold}  ${c.green}${passed} passed${c.reset}${c.bold}, ${resultColor}${failed} failed${c.reset}${c.bold} / ${total} total${c.reset}`,
  );

  if (failures.length > 0) {
    console.log(`\n${c.red}${c.bold}  Failed assertions:${c.reset}`);
    for (const f of failures) {
      console.log(`    ${c.red}✗ ${f}${c.reset}`);
    }
  } else {
    console.log(`\n${c.green}${c.bold}  All assertions passed!${c.reset}`);
  }
  console.log(`${"═".repeat(62)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
