import { Router, type IRouter } from "express";
import {
  getConv,
  appendTurn,
  endConv,
  waitConv,
  setConv,
} from "../../lib/conversation-store.js";
import {
  isAutoReply,
  isOptOut,
  isPositive,
  extractTopicBias,
} from "../../lib/detectors.js";
import { composeExecutionTurn } from "../../lib/composer.js";
import { getVoiceProfile } from "../../lib/voice-profiles.js";
import { buildNarrative } from "../../lib/narrative.js";
import { suppress } from "../../lib/suppression.js";
import { logger } from "../../lib/logger.js";

const router: IRouter = Router();

router.post("/reply", async (req, res) => {
  const { conversation_id, from_role, message, received_at } =
    req.body as {
      conversation_id: string;
      merchant_id?: string;
      customer_id?: string | null;
      from_role: string;
      message: string;
      received_at: string;
      turn_number?: number;
    };

  if (!conversation_id || !message) {
    res.status(400).json({ error: "missing conversation_id or message" });
    return;
  }

  const ts = received_at ?? new Date().toISOString();

  // Store incoming turn
  appendTurn(conversation_id, {
    role: from_role as "merchant" | "customer" | "vera",
    body: message,
    ts,
  });

  const conv = getConv(conversation_id);

  if (!conv || conv.state === "ended") {
    res.json({
      action: "end",
      rationale: "Conversation already closed or not found.",
    });
    return;
  }

  // Unblock waiting conv when owner sends a real (non-auto) reply
  if (conv.state === "waiting" && !isAutoReply(message)) {
    conv.state = "open";
    conv.wait_until = undefined;
    setConv(conv);
  }

  // ── Priority 1: Opt-out / hostile ──────────────────────────────────────────
  if (isOptOut(message)) {
    endConv(conversation_id);
    const suppKey = conv.composeContext.trigger["suppression_key"] as string | undefined;
    if (suppKey) suppress(suppKey);
    res.json({
      action: "end",
      rationale:
        "Merchant explicitly opted out. Closing conversation; suppressing triggers for this merchant.",
    });
    return;
  }

  // ── Priority 2: Auto-reply detection ────────────────────────────────────────
  // Spec: detect and immediately back off 4 hours (14400 s) to let the owner take over.
  if (isAutoReply(message)) {
    waitConv(conversation_id, 14400, ts);
    res.json({
      action: "wait",
      wait_seconds: 14400,
      rationale:
        "Detected merchant auto-reply (canned phrasing). Backing off 4 hours to wait for owner.",
    });
    return;
  }

  // Reset waiting state on any real reply
  conv.auto_reply_count = 0;

  // Always extract topic_bias from any merchant message (not just positive ones)
  // so that "focus on fluoride varnish" on a clarify turn is captured for the later exec turn.
  const incomingBias = extractTopicBias(message);
  if (incomingBias && !conv.topic_bias) {
    conv.topic_bias = incomingBias;
  }

  setConv(conv);

  // ── Priority 3: Positive intent → produce execution artifact ────────────────
  if (isPositive(message)) {
    try {
      const narrative = buildNarrative(
        conv.composeContext.trigger,
        conv.composeContext.merchant,
        conv.composeContext.category,
        conv.composeContext.customer,
      );
      const categorySlug =
        (conv.composeContext.category["slug"] as string) ?? "dentists";
      const voice = getVoiceProfile(categorySlug);
      const artifact = await composeExecutionTurn(narrative, voice, conv.topic_bias);

      appendTurn(conversation_id, {
        role: "vera",
        body: artifact,
        ts: new Date().toISOString(),
      });

      res.json({
        action: "send",
        body: artifact,
        cta: "binary_confirm_cancel",
        rationale: `Merchant confirmed intent; switching from qualifying to action-execution. Concrete artifact for trigger: ${narrative.triggerKind}. Topic bias: ${conv.topic_bias ?? "none"}.`,
      });
    } catch (err) {
      logger.error({ err }, "Error composing execution turn");
      res.json({
        action: "send",
        body: "Great — I'll get that ready for you now. Reply CONFIRM when ready.",
        cta: "binary_confirm_cancel",
        rationale: "Error composing artifact; sending holding message.",
      });
    }
    return;
  }

  // ── Priority 4: Out-of-scope requests ───────────────────────────────────────
  const SCOPE_PATTERNS = [
    /\bgst\b/i,
    /income tax/i,
    /\baccounting\b/i,
    /\bsalary\b/i,
    /\bpayroll\b/i,
    /compliance filing/i,
    /legal advice/i,
    /\bcourt\b/i,
    /competition commission/i,
    /instagram ads/i,
    /facebook ads/i,
    /google ads/i,
    /\bseo\b/i,
    /\bwebsite\b/i,
    /app development/i,
    /\bloan\b/i,
    /\bbanking\b/i,
    /\binvestment\b/i,
    /ca filing/i,
  ];

  if (SCOPE_PATTERNS.some((p) => p.test(message))) {
    const triggerKind =
      conv.trigger_kind ?? (conv.composeContext.trigger["kind"] as string);
    const redirectMsg = getRedirectMessage(triggerKind);
    appendTurn(conversation_id, {
      role: "vera",
      body: redirectMsg,
      ts: new Date().toISOString(),
    });
    res.json({
      action: "send",
      body: redirectMsg,
      cta: "open_ended",
      rationale:
        "Out-of-scope ask politely declined; redirects back to the original trigger without losing thread.",
    });
    return;
  }

  // ── Priority 5: Ambiguous / unclear → clarify ───────────────────────────────
  const triggerKind2 =
    conv.trigger_kind ?? (conv.composeContext.trigger["kind"] as string);
  const clarifyMsg = getClarifyMessage(triggerKind2, conv.composeContext.merchant);
  appendTurn(conversation_id, {
    role: "vera",
    body: clarifyMsg,
    ts: new Date().toISOString(),
  });
  res.json({
    action: "send",
    body: clarifyMsg,
    cta: "binary_yes_no",
    rationale:
      "Unclear or ambiguous reply — simplifying to a single binary CTA to reduce friction.",
  });
});

function getRedirectMessage(triggerKind: string): string {
  const scope = triggerKind.includes("digest") || triggerKind.includes("research")
    ? "the research piece"
    : triggerKind.includes("perf")
    ? "the performance opportunity"
    : triggerKind.includes("renewal")
    ? "the renewal"
    : triggerKind.includes("recall")
    ? "the patient recall"
    : "what I shared earlier";

  return `I'll have to leave that to the right expert — outside what I can help with. Coming back to ${scope} — shall I send the draft?`;
}

function getClarifyMessage(
  triggerKind: string,
  merchant: Record<string, unknown>,
): string {
  const identity = (merchant["identity"] as Record<string, unknown>) ?? {};
  const firstName = (identity["owner_first_name"] as string) ?? "there";

  if (triggerKind.includes("research") || triggerKind.includes("digest")) {
    return `Just to confirm, ${firstName} — should I send the abstract + patient WhatsApp draft? Reply Yes or No.`;
  }
  if (triggerKind.includes("perf_dip")) {
    return `To confirm — shall I send the counter-offer I drafted? Reply Yes and I'll share it.`;
  }
  if (triggerKind.includes("renewal")) {
    return `Quick check — shall I process the renewal now? Reply Yes to confirm.`;
  }
  if (triggerKind.includes("recall")) {
    return `To confirm — shall I send the patient recall message? Reply Yes or No.`;
  }
  return `Just checking — do you want me to send what I've prepared? Reply Yes or No.`;
}

export default router;
