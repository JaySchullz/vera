import { humanizePct, humanizeNumber, formatRupees } from "./number-utils.js";

export interface CausalNarrative {
  problem: string;
  proof: string;
  proof2?: string;
  benchmark: string;
  locality?: string;
  offer: string;
  action: string;
  triggerKind: string;
  merchantName: string;
  ownerFirstName: string;
  categorySlug: string;
  customerId?: string;
  customerName?: string;
  sendAs: "vera" | "merchant_on_behalf";
}

function getActiveOffer(merchant: Record<string, unknown>): string {
  const offers = (merchant["offers"] as Array<Record<string, unknown>>) ?? [];
  const active = offers.find((o) => o["status"] === "active");
  if (active) return active["title"] as string;
  return "";
}

/**
 * Offer anchoring rules (in priority order):
 * 1. Merchant active offer of type service_at_price (has a ₹ price, not % discount)
 * 2. Merchant any active offer (excluding pure % discounts)
 * 3. Category catalog service_at_price offer
 * 4. Category catalog non-percent offer
 * 5. First catalog entry (last resort)
 *
 * Percentage-only discounts (e.g. "20% off") are deprioritized when
 * a service+price offer exists.
 */
function isPercentageOnlyOffer(title: string): boolean {
  // Matches "20% off", "flat 30%", "upto 15% discount" etc.
  return /^\d+%|\bflat\s+\d+%|\bupto\s+\d+%|discount\s+\d+%/i.test(title) &&
    !/₹\d/.test(title);
}

function getBestOffer(
  merchant: Record<string, unknown>,
  category: Record<string, unknown>,
): string {
  const offers = (merchant["offers"] as Array<Record<string, unknown>>) ?? [];
  const active = offers.filter((o) => o["status"] === "active");

  // Prefer service_at_price merchant offer (has explicit price, not %-only)
  const pricedActive = active.find(
    (o) => o["type"] === "service_at_price" || /₹\d/.test((o["title"] as string) ?? ""),
  );
  if (pricedActive) return pricedActive["title"] as string;

  // Any merchant active offer that isn't a pure percent discount
  const nonPctActive = active.find(
    (o) => !isPercentageOnlyOffer((o["title"] as string) ?? ""),
  );
  if (nonPctActive) return nonPctActive["title"] as string;

  // Fall through to category catalog
  const catalog = (category["offer_catalog"] as Array<Record<string, unknown>>) ?? [];

  // Catalog: prefer service_at_price
  const catalogPriced = catalog.find((o) => o["type"] === "service_at_price");
  if (catalogPriced) return catalogPriced["title"] as string;

  // Catalog: non-percent
  const catalogNonPct = catalog.find(
    (o) => !isPercentageOnlyOffer((o["title"] as string) ?? ""),
  );
  if (catalogNonPct) return catalogNonPct["title"] as string;

  return (catalog[0]?.["title"] as string) ?? "";
}

export function buildNarrative(
  trigger: Record<string, unknown>,
  merchant: Record<string, unknown>,
  category: Record<string, unknown>,
  customer?: Record<string, unknown>,
): CausalNarrative {
  const kind = trigger["kind"] as string;
  const payload = (trigger["payload"] as Record<string, unknown>) ?? {};
  const identity = (merchant["identity"] as Record<string, unknown>) ?? {};
  const performance = (merchant["performance"] as Record<string, unknown>) ?? {};
  const peerStats = (category["peer_stats"] as Record<string, unknown>) ?? {};
  const digest = (category["digest"] as Array<Record<string, unknown>>) ?? [];

  const merchantName = (identity["name"] as string) ?? "your clinic";
  const ownerFirstName = (identity["owner_first_name"] as string) ?? "there";
  const locality = (identity["locality"] as string) ?? "";
  const categorySlug = (category["slug"] as string) ?? "dentists";

  const sendAs: "vera" | "merchant_on_behalf" = trigger["scope"] === "customer"
    ? "merchant_on_behalf"
    : "vera";

  const customerName = customer
    ? ((customer["identity"] as Record<string, unknown>)?.["name"] as string) ?? ""
    : undefined;
  const customerId = customer ? (customer["customer_id"] as string) : undefined;

  const offer = getBestOffer(merchant, category);

  switch (kind) {
    case "research_digest": {
      const topItemId = payload["top_item_id"] as string;
      const digestItem = digest.find((d) => d["id"] === topItemId) ?? digest[0];
      const source = (digestItem?.["source"] as string) ?? "Industry digest";
      const trialN = (digestItem?.["trial_n"] as number) ?? 0;
      const summary = (digestItem?.["summary"] as string) ?? "";
      const patientSegment = (digestItem?.["patient_segment"] as string) ?? "patients";
      const finding = summary.split(".")[0] ?? summary;
      const peerAvgCalls = peerStats["avg_calls_30d"] as number | undefined;

      return {
        problem: `${source} just dropped — one finding for your ${patientSegment.replace(/_/g, " ")} patients`,
        proof: trialN ? `${humanizeNumber(trialN)}-patient trial` : finding,
        proof2: trialN ? finding : undefined,
        benchmark: peerAvgCalls
          ? `Peers average ${humanizeNumber(peerAvgCalls)} calls/month`
          : "Worth acting on",
        locality: locality || undefined,
        offer,
        action: "already pulled the 2-min abstract and drafted a patient WhatsApp — can send in 10 min",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        sendAs,
      };
    }

    case "perf_dip":
    case "seasonal_perf_dip": {
      const metric = (payload["metric"] as string) ?? "calls";
      const deltaPct = (payload["delta_pct"] as number) ?? 0;
      const vsBaseline = (payload["vs_baseline"] as number) ?? 0;
      const delta7d = (performance["delta_7d"] as Record<string, unknown>) ?? {};
      const actualCalls = (performance["calls"] as number);
      const actual = actualCalls != null ? actualCalls : vsBaseline + vsBaseline * deltaPct;
      const peerAvg = peerStats["avg_calls_30d"] ?? peerStats["avg_views_30d"];
      const isExpected = payload["is_expected_seasonal"] as boolean | undefined;

      return {
        problem: isExpected
          ? `${metric} are in expected seasonal dip`
          : `${metric} dropped ${humanizePct(deltaPct)} this week`,
        proof: actualCalls != null
          ? `${humanizeNumber(actualCalls)} vs ${humanizeNumber(vsBaseline)}/week baseline`
          : `${humanizePct(deltaPct)} drop`,
        proof2: peerAvg ? `peer avg: ${humanizeNumber(peerAvg as number)}` : undefined,
        benchmark: offer
          ? `Peers with active offers are seeing ~2× ${metric} right now`
          : `Category peers average ${humanizeNumber((peerAvg as number) ?? 0)} ${metric}/month`,
        locality: locality || undefined,
        offer,
        action: "already drafted a counter-offer — can send in 10 min",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        sendAs,
      };
    }

    case "renewal_due": {
      const daysRemaining = (payload["days_remaining"] as number) ?? 7;
      const plan = (payload["plan"] as string) ?? "Pro";
      const renewalAmount = (payload["renewal_amount"] as number) ?? 4999;
      const leads = (performance["leads"] as number) ?? 0;
      const views = (performance["views"] as number) ?? 0;

      return {
        problem: `${plan} plan expires in ${daysRemaining} days`,
        proof: `Last 30d: ${humanizeNumber(leads)} leads from ${humanizeNumber(views)} views`,
        proof2: `pipeline stops after expiry`,
        benchmark: `Active accounts maintain ~${humanizePct(0.38)} retention; inactive drop fast`,
        offer: `Renew at ${formatRupees(renewalAmount)}`,
        action: "ready to process — can send confirmation in 10 min",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        sendAs,
      };
    }

    case "recall_due": {
      const servicedue = (payload["service_due"] as string) ?? "cleaning";
      const lastService = (payload["last_service_date"] as string) ?? "";
      const slots = (payload["available_slots"] as Array<{ label: string; iso: string }>) ?? [];
      const slot1 = slots[0]?.label ?? "a convenient time";
      const slot2 = slots[1]?.label ?? "";
      const monthsSince = lastService
        ? Math.round(
            (Date.now() - new Date(lastService).getTime()) / (1000 * 60 * 60 * 24 * 30),
          )
        : 5;

      return {
        problem: `it's been ${monthsSince} months since your last ${servicedue.replace(/_/g, " ")}`,
        proof: `6-month recall due`,
        proof2: slot1 && slot2 ? `${slot1} or ${slot2}` : slot1,
        benchmark: "Regular 6-month cleanings cut caries recurrence ~38%",
        offer: offer || "Dental Cleaning @ ₹299",
        action: `slots ready for you — 2 evenings this week`,
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        customerId,
        customerName,
        sendAs: "merchant_on_behalf",
      };
    }

    case "competitor_opened": {
      const distance = humanizeNumber((payload["distance_km"] as number) ?? 1.0);
      const theirOffer = (payload["their_offer"] as string) ?? "lower prices";

      return {
        problem: `a new ${categorySlug === "dentists" ? "clinic" : "competitor"} opened ${distance}km away${locality ? ` in ${locality}` : ""} offering ${theirOffer}`,
        proof: `your current offer: ${offer || "see catalog"}`,
        proof2: `~80% walk-in retention for clinics running counter-offers`,
        benchmark: "Bundled counter-offers retain ~80% of walk-ins vs. bare-price competition",
        locality: locality ? `In ${locality},` : undefined,
        offer,
        action: "already set up the counter-offer + post — can send in 10 min",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        sendAs,
      };
    }

    case "ipl_match_today": {
      const match = (payload["match"] as string) ?? "tonight's match";
      const venue = (payload["venue"] as string) ?? "local stadium";
      const matchTime = payload["match_time_iso"] as string | undefined;
      const isWeeknight = payload["is_weeknight"] as boolean | undefined;
      const timeStr = matchTime
        ? new Date(matchTime).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })
        : "7:30pm";

      return {
        problem: `${match} at ${venue} tonight at ${timeStr}`,
        proof: isWeeknight === false
          ? "Saturday IPL = -12% dine-in covers"
          : "+18% delivery orders on weeknight matches",
        proof2: isWeeknight === false
          ? "+18% delivery on weeknight matches"
          : undefined,
        benchmark: "Match-night combos on weeknights are 1.5× more effective than weekends",
        offer,
        action: "Swiggy banner + story already drafted — can send in 10 min",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        sendAs,
      };
    }

    case "review_theme_emerged": {
      const theme = (payload["theme"] as string) ?? "service";
      const occurrences = (payload["occurrences_30d"] as number) ?? 3;
      const trend = (payload["trend"] as string) ?? "rising";
      const quote = (payload["common_quote"] as string) ?? "";

      return {
        problem: `${humanizeNumber(occurrences)} reviews this month mention "${theme.replace(/_/g, " ")}" (trend: ${trend})`,
        proof: quote ? `"${quote}"` : `${occurrences} mentions in 30 days`,
        proof2: undefined,
        benchmark: "Responding publicly to negative themes lifts rating by 0.2–0.4 stars over 90 days",
        offer,
        action: "already drafted a public response + internal fix note — can send in 10 min",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        sendAs,
      };
    }

    case "curious_ask_due": {
      return {
        problem: "quick intel check",
        proof: "First-party demand signals beat any trend report",
        proof2: undefined,
        benchmark: "Merchants who track weekly demand convert 2× more inquiries into bookings",
        offer,
        action: "format ready — takes 5 min",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        sendAs,
      };
    }

    case "active_planning_intent": {
      const intentTopic = (payload["intent_topic"] as string) ?? "your idea";
      const lastMsg = (payload["merchant_last_message"] as string) ?? "";

      return {
        problem: `picking up where we left off: ${intentTopic.replace(/_/g, " ")}`,
        proof: lastMsg ? `You said: "${lastMsg}"` : "merchant-initiated",
        proof2: undefined,
        benchmark: "Concrete plans convert 4× better than vague discussions",
        offer,
        action: "drafted the full plan for you — ready to review now",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        sendAs,
      };
    }

    case "supply_alert": {
      const molecule = (payload["molecule"] as string) ?? "medication";
      const batches = (payload["affected_batches"] as string[]) ?? [];
      const issue = (payload["issue"] as string) ?? "quality concern";
      const alertId = payload["alert_id"] as string | undefined;
      const digestItem = alertId ? digest.find((d) => d["id"] === alertId) : undefined;
      const issueText = digestItem
        ? (digestItem["summary"] as string ?? "").split(".")[0]
        : `flagged for ${issue}`;
      const custAggregate = (merchant["customer_aggregate"] as Record<string, unknown>) ?? {};
      const totalCustomers = (custAggregate["total_unique_ytd"] as number) ?? 0;

      return {
        problem: `CDSCO alert: batches ${batches.join(", ")} of ${molecule} flagged`,
        proof: issueText,
        proof2: totalCustomers ? `${humanizeNumber(totalCustomers)} customers on your refill list` : undefined,
        benchmark: "CDSCO requires pull-from-shelf within 48h of alert",
        offer,
        action: "drafted a WhatsApp to notify your refill customers — can send in 10 min",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        sendAs,
      };
    }

    case "regulation_change": {
      const topItemId = payload["top_item_id"] as string;
      const deadline = (payload["deadline_iso"] as string) ?? "";
      const digestItem = digest.find((d) => d["id"] === topItemId) ?? digest[0];
      const source = (digestItem?.["source"] as string) ?? "Regulatory authority";
      const summary = (digestItem?.["summary"] as string) ?? "";
      const actionable = (digestItem?.["actionable"] as string) ?? "";
      const deadlineStr = deadline
        ? new Date(deadline).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
        : "soon";

      return {
        problem: `${source} revised rules — effective ${deadlineStr}`,
        proof: summary.split(".")[0] ?? summary,
        proof2: actionable || undefined,
        benchmark: "Non-compliance attracts ₹50,000+ penalties in Q2 audits",
        offer,
        action: "drafted a 1-page SOP note for your records — can send in 10 min",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        sendAs,
      };
    }

    case "chronic_refill_due": {
      const molecules = (payload["molecule_list"] as string[]) ?? [];
      const stockRunsOut = payload["stock_runs_out_iso"] as string | undefined;
      const daysLeft = stockRunsOut
        ? Math.ceil((new Date(stockRunsOut).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : 2;
      const dateStr = stockRunsOut
        ? new Date(stockRunsOut).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
        : "soon";

      return {
        problem: `${molecules.join(" + ")} stock runs out around ${dateStr}`,
        proof: `${daysLeft} days remaining`,
        proof2: "delivery address already saved",
        benchmark: "Chronic patients with refill reminders have 88% 12-month retention",
        offer,
        action: "can dispatch today — just confirm",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        customerId,
        customerName,
        sendAs: "merchant_on_behalf",
      };
    }

    case "dormant_with_vera": {
      const days = (payload["days_since_last_merchant_message"] as number) ?? 30;
      const lastTopic = (payload["last_topic"] as string) ?? "your business";
      const digestItem = digest[0];
      const digestHint = digestItem
        ? (digestItem["title"] as string)
        : "a useful industry update";

      return {
        problem: `checking in after ${days} days`,
        proof: `last topic: ${lastTopic.replace(/_/g, " ")}`,
        proof2: undefined,
        benchmark: digestHint,
        offer,
        action: "have something useful — worth 2 minutes",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        sendAs,
      };
    }

    case "winback_eligible": {
      const daysSince = (payload["days_since_expiry"] as number) ?? 30;
      const dipPct = (payload["perf_dip_pct"] as number) ?? 0;
      const lapsed = (payload["lapsed_customers_added_since_expiry"] as number) ?? 0;

      return {
        problem: `${daysSince} days since your plan expired`,
        proof: `views dropped ${humanizePct(Math.abs(dipPct))}`,
        proof2: lapsed ? `${humanizeNumber(lapsed)} more customers lapsed since then` : undefined,
        benchmark: "Re-activating within 60 days recovers ~70% of lost visibility",
        offer: `restart plan today`,
        action: "can process restart in 5 min",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        sendAs,
      };
    }

    case "festival_upcoming": {
      const festival = (payload["festival"] as string) ?? "upcoming festival";
      const daysUntil = (payload["days_until"] as number) ?? 14;

      return {
        problem: `${festival} is ${daysUntil} days away`,
        proof: `${categorySlug} with pre-festival posts see ~40% more bookings`,
        proof2: daysUntil < 30 ? `planning window is tight` : `good runway to plan`,
        benchmark: "Pre-festival posts that go up 2+ weeks early get 2× the impressions",
        offer,
        action: "already drafted a post + offer — can send now while there's runway",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        sendAs,
      };
    }

    case "perf_spike": {
      const metric = (payload["metric"] as string) ?? "views";
      const deltaPct = (payload["delta_pct"] as number) ?? 0.15;
      const vsBaseline = (payload["vs_baseline"] as number) ?? 0;
      const actual = Math.round(vsBaseline * (1 + deltaPct));

      return {
        problem: `${metric} up ${humanizePct(deltaPct)} this week`,
        proof: `${humanizeNumber(actual)} vs ${humanizeNumber(vsBaseline)} 30d avg`,
        proof2: undefined,
        benchmark: "High-intent windows convert 2× better for offers",
        offer,
        action: "can schedule a post while interest is high — ready in 10 min",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        sendAs,
      };
    }

    case "milestone_reached": {
      const milestone = (payload["milestone_value"] as number) ?? 100;
      const valueNow = (payload["value_now"] as number) ?? milestone;

      return {
        problem: `approaching ${humanizeNumber(milestone)} reviews milestone`,
        proof: `at ${humanizeNumber(valueNow)} reviews now`,
        proof2: "businesses at 150 reviews with a post see 15–20% more walk-ins",
        benchmark: "Review milestones are high-conversion moments for new posts",
        offer,
        action: "drafted a 'Thank you' post + offer to ride the momentum — ready in 10 min",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        sendAs,
      };
    }

    case "trial_followup": {
      const nextOptions = (payload["next_session_options"] as Array<{ label: string }>) ?? [];
      const nextSlot = nextOptions[0]?.label ?? "a convenient time";

      return {
        problem: `checking in after your trial`,
        proof: `held ${nextSlot} for your next session`,
        proof2: undefined,
        benchmark: "Trial-to-paid conversion drops 60% if follow-up takes more than 3 days",
        offer,
        action: "slot held — confirm in one reply",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        customerId,
        customerName,
        sendAs: "merchant_on_behalf",
      };
    }

    case "gbp_unverified": {
      const upliftPct = humanizePct((payload["estimated_uplift_pct"] as number) ?? 0.3);

      return {
        problem: "Google profile not yet verified",
        proof: `verified profiles see ${upliftPct} more visibility`,
        proof2: "verification takes 5 min via postcard or phone call",
        benchmark: "Verified profiles also rank higher in local search results",
        offer,
        action: "put together a step-by-step guide — can walk you through it in 10 min",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        sendAs,
      };
    }

    case "wedding_package_followup":
    case "customer_lapsed_hard":
    case "cde_opportunity":
    case "category_seasonal": {
      const digestItem = digest[0];
      const digestHint = digestItem
        ? (digestItem["title"] as string)
        : "a relevant update";

      return {
        problem: "spotted something relevant",
        proof: digestHint,
        proof2: undefined,
        benchmark: "Acting on timely signals is 3× more effective than periodic campaigns",
        offer,
        action: "already drafted the follow-up — can send in 10 min",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        customerId,
        customerName,
        sendAs: trigger["scope"] === "customer" ? "merchant_on_behalf" : "vera",
      };
    }

    default: {
      return {
        problem: "spotted something useful",
        proof: `trend data for ${merchantName}`,
        proof2: undefined,
        benchmark: "Timely action beats scheduled campaigns",
        offer,
        action: "already drafted the message — can send in 10 min",
        triggerKind: kind,
        merchantName,
        ownerFirstName,
        categorySlug,
        customerId,
        customerName,
        sendAs: "vera",
      };
    }
  }
}
