import { Router, type IRouter } from "express";
import { pickBestTrigger, recordMerchantSend } from "../../lib/decision-engine.js";
import { buildNarrative } from "../../lib/narrative.js";
import { compose } from "../../lib/composer.js";
import { getVoiceProfile } from "../../lib/voice-profiles.js";
import { suppress } from "../../lib/suppression.js";
import { createConv, getConv, appendTurn } from "../../lib/conversation-store.js";
import { getCustomer } from "../../lib/context-store.js";
import { logger } from "../../lib/logger.js";

const router: IRouter = Router();

// Anti-repetition: track bodies sent per conversation_id
const sentBodies = new Map<string, Set<string>>();

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

router.post("/tick", async (req, res) => {
  const { now, available_triggers } = req.body as {
    now: string;
    available_triggers: string[];
  };

  if (!now || !Array.isArray(available_triggers)) {
    res.status(400).json({ error: "missing now or available_triggers" });
    return;
  }

  try {
    const best = pickBestTrigger(available_triggers, now);

    if (!best) {
      res.json({ actions: [] });
      return;
    }

    const { triggerId, trigger, merchant, category, signals } = best;

    const customerId = trigger["customer_id"] as string | null;
    const customer = customerId ? getCustomer(customerId) : undefined;

    const narrative = buildNarrative(
      trigger,
      merchant,
      category,
      customer ?? undefined,
    );

    const categorySlug = (category["slug"] as string) ?? "dentists";
    const voice = getVoiceProfile(categorySlug);

    const merchantId = trigger["merchant_id"] as string;
    const suppKey = trigger["suppression_key"] as string;

    // Deterministic conversation ID based on merchant + trigger kind + week
    const nowDate = new Date(now);
    const weekNum = Math.floor(nowDate.getTime() / (7 * 24 * 3600000));
    const convId = `conv_${merchantId}_${narrative.triggerKind}_${hashStr(`${triggerId}:${weekNum}`).toString(36).slice(0, 6)}`;

    const hashKey = `${merchantId}::${triggerId}`;
    const composed = await compose(narrative, voice, hashKey, signals);

    // Anti-repetition check
    const convBodies = sentBodies.get(convId) ?? new Set<string>();
    if (convBodies.has(composed.body)) {
      logger.warn({ convId }, "Anti-repetition: body already sent; skipping tick");
      res.json({ actions: [] });
      return;
    }
    convBodies.add(composed.body);
    sentBodies.set(convId, convBodies);

    suppress(suppKey);
    recordMerchantSend(merchantId, now);

    // Create conversation if it doesn't exist, then append initial vera turn
    if (!getConv(convId)) {
      createConv({
        conversation_id: convId,
        merchant_id: merchantId,
        customer_id: customerId,
        trigger_id: triggerId,
        trigger_kind: narrative.triggerKind,
        composeContext: {
          category: category as Record<string, unknown>,
          merchant: merchant as Record<string, unknown>,
          trigger: trigger as Record<string, unknown>,
          customer: customer as Record<string, unknown> | undefined,
        },
        suppression_key: suppKey,
        now,
      });
    }

    // Append the outbound vera turn so conversation memory is complete
    appendTurn(convId, {
      role: "vera",
      body: composed.body,
      ts: now,
    });

    const action = {
      conversation_id: convId,
      merchant_id: merchantId,
      customer_id: customerId ?? null,
      send_as: composed.sendAs,
      trigger_id: triggerId,
      template_name: composed.templateName,
      template_params: composed.templateParams,
      body: composed.body,
      cta: composed.cta,
      suppression_key: suppKey,
      rationale: composed.rationale,
    };

    res.json({ actions: [action] });
  } catch (err) {
    logger.error({ err }, "Error in /v1/tick");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
