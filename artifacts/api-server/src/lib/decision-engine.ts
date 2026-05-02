import { getMerchant, getCategory, getTrigger } from "./context-store.js";
import { isSuppressed } from "./suppression.js";
import { getWaitingConvForMerchant } from "./conversation-store.js";

// ── Tier base scores ──────────────────────────────────────────────────────────
const TIER_SCORES: Record<string, number> = {
  supply_alert: 10,
  active_planning_intent: 10,
  regulation_change: 9,
  renewal_due: 8,
  recall_due: 7,
  perf_dip: 7,
  chronic_refill_due: 7,
  competitor_opened: 6,
  review_theme_emerged: 5,
  trial_followup: 5,
  winback_eligible: 5,
  customer_lapsed_hard: 5,
  wedding_package_followup: 4,
  research_digest: 4,
  perf_spike: 3,
  milestone_reached: 3,
  festival_upcoming: 3,
  ipl_match_today: 3,
  curious_ask_due: 3,
  dormant_with_vera: 2,
  gbp_unverified: 2,
  cde_opportunity: 2,
  seasonal_perf_dip: 2,
  category_seasonal: 2,
};

// LOW_INFO_KINDS: informational triggers that critical ones can soft-override
const LOW_INFO_KINDS = new Set([
  "research_digest",
  "curious_ask_due",
  "perf_spike",
  "cde_opportunity",
  "dormant_with_vera",
  "festival_upcoming",
  "milestone_reached",
  "category_seasonal",
  "gbp_unverified",
]);

/**
 * Critical triggers bypass ONLY the 6h recency cooldown gate.
 * They do NOT bypass the waiting-conv gate (which has no exceptions).
 *
 * Criteria (trigger-payload-aware):
 *   - active_planning_intent: always critical
 *   - supply_alert: urgency >= 5
 *   - renewal_due: days_remaining <= 7
 *   - regulation_change: deadline_iso within 30 days of `now`
 */
function isCriticalTrigger(trigger: Record<string, unknown>, now: string): boolean {
  const kind = trigger["kind"] as string;
  const urgency = (trigger["urgency"] as number) ?? 0;
  const payload = (trigger["payload"] as Record<string, unknown>) ?? {};

  if (kind === "active_planning_intent") return true;
  if (kind === "supply_alert") return urgency >= 5;
  if (kind === "renewal_due") {
    const days = (payload["days_remaining"] as number) ?? 999;
    return days <= 7;
  }
  if (kind === "regulation_change") {
    const deadlineIso = payload["deadline_iso"] as string | undefined;
    if (!deadlineIso) return false;
    const msToDeadline = new Date(deadlineIso).getTime() - new Date(now).getTime();
    return msToDeadline >= 0 && msToDeadline < 30 * 24 * 3_600_000;
  }
  return false;
}

// Category ↔ trigger relevance mapping for categoryRelevance scoring
const CATEGORY_RELEVANCE: Record<string, string[]> = {
  dentists: ["research_digest", "recall_due", "regulation_change", "winback_eligible", "perf_dip"],
  restaurants: ["ipl_match_today", "festival_upcoming", "perf_dip", "seasonal_perf_dip", "review_theme_emerged"],
  salons: ["trial_followup", "wedding_package_followup", "winback_eligible", "perf_dip"],
  pharmacies: ["chronic_refill_due", "supply_alert", "regulation_change", "customer_lapsed_hard"],
  gyms: ["trial_followup", "winback_eligible", "perf_dip", "milestone_reached"],
};

// ── Per-merchant send tracking for 6h cooldown ────────────────────────────────
const merchantLastSentAt = new Map<string, string>();

export function recordMerchantSend(merchantId: string, now: string): void {
  merchantLastSentAt.set(merchantId, now);
}

function isWithin6h(merchantId: string, now: string): boolean {
  const lastSentAt = merchantLastSentAt.get(merchantId);
  if (!lastSentAt) return false;
  const msSinceLast =
    new Date(now).getTime() - new Date(lastSentAt).getTime();
  // Negative means `now` is before lastSentAt — treat as outside cooldown
  return msSinceLast >= 0 && msSinceLast < 6 * 3_600_000;
}

// ── Scoring terms ─────────────────────────────────────────────────────────────

function tierScore(kind: string, urgency: number): number {
  const base = TIER_SCORES[kind] ?? 3;
  return base + (urgency ?? 0);
}

function engagementBoost(signals: string[]): number {
  const sigSet = new Set(signals);
  let boost = 0;
  if (sigSet.has("engaged_in_last_48h")) boost += 3;
  if (sigSet.has("engaged_in_last_7d")) boost += 1;
  if (sigSet.has("high_risk_adult_cohort")) boost += 1;
  if (sigSet.has("opened_last_message")) boost += 2;
  return boost;
}

function categoryRelevance(triggerKind: string, categorySlug: string): number {
  const relevant = CATEGORY_RELEVANCE[categorySlug] ?? [];
  return relevant.includes(triggerKind) ? 4 : 0;
}

function merchantSignalMatch(triggerKind: string, signals: string[]): number {
  let score = 0;
  const signalSet = new Set(signals ?? []);

  if (triggerKind === "perf_dip" && signalSet.has("perf_dip_severe")) score += 3;
  if (triggerKind === "research_digest" && signalSet.has("high_risk_adult_cohort"))
    score += 2;
  if (triggerKind === "renewal_due") {
    for (const s of signalSet) {
      if (s.startsWith("renewal_due_soon")) { score += 3; break; }
    }
  }
  if (triggerKind === "competitor_opened" && signalSet.has("ctr_below_peer_median"))
    score += 2;
  if (triggerKind === "recall_due") {
    for (const s of signalSet) {
      if (s.startsWith("lapsed_180d_plus")) { score += 2; break; }
    }
  }
  if (triggerKind === "perf_spike" && signalSet.has("stale_posts:22d")) score += 1;
  if (triggerKind === "winback_eligible" && signalSet.has("no_active_offers")) score += 2;
  if (triggerKind === "gbp_unverified" && signalSet.has("unverified_gbp")) score += 3;
  return score;
}

function recencyBonus(expiresAt: string | undefined, now: string): number {
  if (!expiresAt) return 0;
  const msRemaining =
    new Date(expiresAt).getTime() - new Date(now).getTime();
  if (msRemaining < 0) return -100;
  const hoursRemaining = msRemaining / 3_600_000;
  if (hoursRemaining < 12) return 5;
  if (hoursRemaining < 48) return 3;
  if (hoursRemaining < 168) return 1;
  return 0;
}

// Urgency boost for renewal_due nearing deadline (<=7d earns additional score)
function renewalUrgencyBoost(trigger: Record<string, unknown>): number {
  if (trigger["kind"] !== "renewal_due") return 0;
  const payload = (trigger["payload"] as Record<string, unknown>) ?? {};
  const days = (payload["days_remaining"] as number) ?? 999;
  if (days <= 3) return 5;
  if (days <= 7) return 3;
  return 0;
}

// ── Conflict override classification ─────────────────────────────────────────

/**
 * Hard override: always wins; also bypasses 6h cooldown gate.
 * - active_planning_intent: always
 * - supply_alert: urgency >= 5
 * - renewal_due: days_remaining <= 3
 */
function isHardOverride(trigger: Record<string, unknown>): boolean {
  const kind = trigger["kind"] as string;
  const payload = (trigger["payload"] as Record<string, unknown>) ?? {};
  const urgency = (trigger["urgency"] as number) ?? 0;

  if (kind === "active_planning_intent") return true;
  if (kind === "supply_alert" && urgency >= 5) return true;
  if (kind === "renewal_due") {
    const days = (payload["days_remaining"] as number) ?? 999;
    return days <= 3;
  }
  return false;
}

/**
 * Soft override: overrides LOW_INFO_KINDS only, not HIGH-tier triggers.
 * - regulation_change with deadline <= 30 days
 * - recall_due with available_slots present (overrides low-info triggers)
 */
function isSoftOverride(trigger: Record<string, unknown>, now: string): boolean {
  const kind = trigger["kind"] as string;
  const payload = (trigger["payload"] as Record<string, unknown>) ?? {};

  if (kind === "regulation_change") {
    const deadlineIso = payload["deadline_iso"] as string | undefined;
    // Missing deadline → not a soft override (no urgency to determine precedence)
    if (!deadlineIso) return false;
    const msToDeadline =
      new Date(deadlineIso).getTime() - new Date(now).getTime();
    // Must be in the future AND within 30 days to qualify as soft override
    return msToDeadline >= 0 && msToDeadline < 30 * 24 * 3_600_000;
  }

  if (kind === "recall_due") {
    const slots = payload["available_slots"] as unknown[] | undefined;
    return !!(slots && slots.length > 0);
  }

  return false;
}

// ── Main selection ────────────────────────────────────────────────────────────

interface ScoredTrigger {
  triggerId: string;
  score: number;
  trigger: Record<string, unknown>;
  merchant: Record<string, unknown>;
  category: Record<string, unknown>;
  signals: string[];
}

export interface BestTrigger {
  triggerId: string;
  trigger: Record<string, unknown>;
  merchant: Record<string, unknown>;
  category: Record<string, unknown>;
  score: number;
  signals: string[];
}

export function pickBestTrigger(
  availableTriggerIds: string[],
  now: string,
): BestTrigger | null {
  const candidates: ScoredTrigger[] = [];

  for (const triggerId of availableTriggerIds) {
    const trigger = getTrigger(triggerId);
    if (!trigger) continue;

    const suppKey = trigger["suppression_key"] as string;
    if (isSuppressed(suppKey)) continue;

    const expiresAt = trigger["expires_at"] as string | undefined;
    if (expiresAt && expiresAt < now) continue;

    const merchantId = trigger["merchant_id"] as string;
    const merchant = getMerchant(merchantId);
    if (!merchant) continue;

    const categorySlug = (merchant["category_slug"] as string) ?? "dentists";
    const category = getCategory(categorySlug);
    if (!category) continue;

    const kind = trigger["kind"] as string;
    const urgency = (trigger["urgency"] as number) ?? 0;
    const triggerIsCritical = isCriticalTrigger(trigger, now);
    const preHardOverride = isHardOverride(trigger);

    // HARD GATE 1: 6h cooldown — skipped ONLY for triggers classified as critical
    // (active_planning_intent, supply_alert>=5, renewal_due<=7d, regulation_change<=30d)
    // Hard overrides (renewal_due<=3d, supply_alert>=5) also bypass via isCriticalTrigger
    if (!triggerIsCritical && !preHardOverride && isWithin6h(merchantId, now)) continue;

    // HARD GATE 2: waiting-conv — NO bypass for any trigger including critical ones
    // Per spec: waiting state blocks sends until wait_until; CRITICAL exception is
    // defined ONLY for the 6h recency gate above, not here.
    const waitingConv = getWaitingConvForMerchant(merchantId, now);
    if (waitingConv) continue;

    const signals = (merchant["signals"] as string[]) ?? [];

    // Composite score (aligned to spec formula):
    //   tierScore * 3 + merchantSignalMatch * 3 + recencyBonus * 2
    //   + categoryRelevance * 1 + engagementBoost * 1 + renewalUrgencyBoost
    const score =
      tierScore(kind, urgency) * 3 +
      merchantSignalMatch(kind, signals) * 3 +
      recencyBonus(expiresAt, now) * 2 +
      categoryRelevance(kind, categorySlug) * 1 +
      engagementBoost(signals) * 1 +
      renewalUrgencyBoost(trigger);

    candidates.push({ triggerId, score, trigger, merchant, category, signals });
  }

  if (candidates.length === 0) return null;

  // ── Priority resolution (strict precedence, not score-based between tiers) ──
  //
  // Tier 0 (SUPREMACY): active_planning_intent — unconditionally wins all others.
  //   No other trigger can override it; score within this tier is irrelevant.
  // Tier 1 (HARD): supply_alert>=5, renewal_due<=3d — wins over all non-supreme.
  //   Score used to break ties within this tier.
  // Tier 2 (SOFT): regulation_change<=30d, recall_due+slots — wins over LOW_INFO only.
  // Tier 3 (NORMAL): all remaining candidates, sorted by score.

  const supremacyPool = candidates.filter(
    (c) => (c.trigger["kind"] as string) === "active_planning_intent",
  );

  const hardOverridePool = candidates.filter((c) => {
    const kind = c.trigger["kind"] as string;
    if (kind === "active_planning_intent") return false; // already in supremacy
    return isHardOverride(c.trigger);
  });

  const softOverrides = candidates.filter((c) => isSoftOverride(c.trigger, now));
  const allLowInfoOrSoft = candidates.every(
    (c) =>
      LOW_INFO_KINDS.has(c.trigger["kind"] as string) ||
      isSoftOverride(c.trigger, now),
  );

  let pool: ScoredTrigger[];

  if (supremacyPool.length > 0) {
    // Tier 0: active_planning_intent unconditionally wins
    pool = supremacyPool;
  } else if (hardOverridePool.length > 0) {
    // Tier 1: hard overrides win over soft and normal
    pool = hardOverridePool;
  } else if (softOverrides.length > 0 && allLowInfoOrSoft) {
    // Tier 2: soft overrides win only when all competitors are LOW_INFO or also soft
    pool = softOverrides;
  } else {
    // Tier 3: all candidates, score-sorted
    pool = candidates;
  }

  pool.sort((a, b) => b.score - a.score);
  const best = pool[0]!;

  return {
    triggerId: best.triggerId,
    trigger: best.trigger,
    merchant: best.merchant,
    category: best.category,
    score: best.score,
    signals: best.signals,
  };
}
