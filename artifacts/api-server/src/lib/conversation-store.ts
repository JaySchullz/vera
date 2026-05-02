export interface ConvTurn {
  role: "vera" | "merchant" | "customer";
  body: string;
  ts: string;
}

export interface ConvState {
  conversation_id: string;
  merchant_id: string;
  customer_id: string | null;
  trigger_id: string;
  state: "open" | "ended" | "waiting";
  wait_until?: string;
  suppressed: boolean;
  last_sent_at?: string;
  auto_reply_count: number;
  turns: ConvTurn[];
  composeContext: {
    category: Record<string, unknown>;
    merchant: Record<string, unknown>;
    trigger: Record<string, unknown>;
    customer?: Record<string, unknown>;
  };
  topic_bias?: string;
  trigger_kind: string;
}

const convStore = new Map<string, ConvState>();

export function getConv(conversation_id: string): ConvState | undefined {
  return convStore.get(conversation_id);
}

export function setConv(conv: ConvState): void {
  convStore.set(conv.conversation_id, conv);
}

export function createConv(params: {
  conversation_id: string;
  merchant_id: string;
  customer_id: string | null;
  trigger_id: string;
  trigger_kind: string;
  composeContext: ConvState["composeContext"];
  suppression_key: string;
  now?: string;
}): ConvState {
  const conv: ConvState = {
    conversation_id: params.conversation_id,
    merchant_id: params.merchant_id,
    customer_id: params.customer_id,
    trigger_id: params.trigger_id,
    trigger_kind: params.trigger_kind,
    state: "open",
    suppressed: false,
    auto_reply_count: 0,
    turns: [],
    composeContext: params.composeContext,
    last_sent_at: params.now ?? new Date().toISOString(),
  };
  convStore.set(conv.conversation_id, conv);
  return conv;
}

export function appendTurn(
  conversation_id: string,
  turn: ConvTurn,
): void {
  const conv = convStore.get(conversation_id);
  if (!conv) return;
  conv.turns.push(turn);
  if (conv.turns.length > 10) conv.turns = conv.turns.slice(-10);
  convStore.set(conversation_id, conv);
}

export function endConv(conversation_id: string): void {
  const conv = convStore.get(conversation_id);
  if (!conv) return;
  conv.state = "ended";
  conv.suppressed = true;
  convStore.set(conversation_id, conv);
}

/**
 * Put a conversation into waiting state.
 * @param asOf  Simulated "now" timestamp from the judge request (ISO string).
 *              Falls back to wall-clock only when not provided — never use
 *              wall-clock in production judge paths.
 */
export function waitConv(
  conversation_id: string,
  wait_seconds: number,
  asOf?: string,
): void {
  const conv = convStore.get(conversation_id);
  if (!conv) return;
  conv.state = "waiting";
  const baseMs = asOf ? new Date(asOf).getTime() : Date.now();
  conv.wait_until = new Date(baseMs + wait_seconds * 1000).toISOString();
  convStore.set(conversation_id, conv);
}

export function getOpenConvForMerchant(merchant_id: string): ConvState | undefined {
  for (const conv of convStore.values()) {
    if (conv.merchant_id === merchant_id && conv.state === "open") {
      return conv;
    }
  }
  return undefined;
}

export function getWaitingConvForMerchant(merchant_id: string, now: string): ConvState | undefined {
  for (const conv of convStore.values()) {
    if (conv.merchant_id !== merchant_id || conv.state !== "waiting") continue;

    // Auto-transition waiting → open when wait_until has expired
    if (conv.wait_until && conv.wait_until <= now) {
      conv.state = "open";
      conv.wait_until = undefined;
      convStore.set(conv.conversation_id, conv);
      // No longer a waiting conv — don't return it
      continue;
    }

    if (conv.wait_until && conv.wait_until > now) {
      return conv;
    }
  }
  return undefined;
}
