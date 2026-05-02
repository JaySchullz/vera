const AUTO_REPLY_PATTERNS = [
  "thank you for contacting",
  "our team will respond",
  "this is an automated",
  "outside of working hours",
  "will get back to you",
  "away right now",
  "not available",
  "currently unavailable",
  "office hours",
  "auto-reply",
  "automatic reply",
  "out of office",
];

const OPT_OUT_PATTERNS = [
  "stop",
  "not interested",
  "don't message",
  "dont message",
  "unsubscribe",
  "hatao",
  "band karo",
  "mat bhejo",
  "nahi chahiye",
  "leave me alone",
  "stop bothering",
  "useless",
  "this is useless",
  "stop sending",
  "bother",
  "annoying",
];

const POSITIVE_PATTERNS = [
  "yes",
  "yeah",
  "yep",
  "sure",
  "ok",
  "okay",
  "please",
  "go ahead",
  "sounds good",
  "let's do it",
  "do it",
  "confirm",
  "send it",
  "proceed",
  "great",
  "perfect",
];

export function isAutoReply(message: string): boolean {
  const lower = message.toLowerCase();
  return AUTO_REPLY_PATTERNS.some((p) => lower.includes(p));
}

export function isOptOut(message: string): boolean {
  const lower = message.toLowerCase();
  return OPT_OUT_PATTERNS.some((p) => lower.includes(p));
}

// Phrases that negate an otherwise-positive word (e.g. "not sure", "not ok")
const POSITIVE_NEGATIONS = [
  "not sure", "not ok", "not okay", "not great", "not good",
  "not proceed", "not interested", "don't proceed", "dont proceed",
  "not yet", "maybe not", "not really",
];

export function isPositive(message: string): boolean {
  const lower = message.toLowerCase().trim();
  // Check negation phrases first — they trump any positive match
  if (POSITIVE_NEGATIONS.some((n) => lower.includes(n))) return false;
  return POSITIVE_PATTERNS.some((p) => lower.includes(p));
}

export function extractTopicBias(message: string): string | undefined {
  const lower = message.toLowerCase();

  // Generic "focus on X" / "specifically X" / "especially X" extraction
  const focusMatch = lower.match(
    /(?:focus on|specifically|especially|about|for)\s+(?:the\s+)?([a-z][a-z\s]{3,30}?)(?:\s+(?:protocol|procedure|treatment|service|plan|offer|topic))?(?:[,.]|$)/,
  );

  const topics: Array<[string, string]> = [
    // Dental
    ["fluoride varnish", "fluoride varnish treatment"],
    ["fluoride", "fluoride treatment"],
    ["recall", "recall protocol"],
    ["whitening", "teeth whitening"],
    ["aligner", "aligners"],
    ["implant", "dental implants"],
    ["root canal", "root canal treatment"],
    ["kids", "pediatric dentistry"],
    ["pediatric", "pediatric dentistry"],
    ["cleaning", "dental cleaning"],
    ["scaling", "scaling & polishing"],
    ["braces", "orthodontic braces"],
    ["crown", "dental crown"],
    ["extraction", "tooth extraction"],
    // Salons
    ["balayage", "balayage"],
    ["keratin", "keratin treatment"],
    ["bridal", "bridal package"],
    ["hair spa", "hair spa"],
    // Restaurants
    ["corporate", "corporate thali"],
    ["thali", "thali"],
    ["delivery", "delivery"],
    ["biryani", "biryani"],
    ["combo", "combo meal"],
    // Gyms
    ["yoga", "yoga"],
    ["pilates", "pilates"],
    ["pt session", "personal training"],
    ["personal training", "personal training"],
    ["weight loss", "weight loss program"],
    // Pharmacies
    ["refill", "medication refill"],
    ["generic", "generic medicine"],
    ["home delivery", "home delivery"],
  ];

  for (const [pattern, bias] of topics) {
    if (lower.includes(pattern)) return bias;
  }

  // Fallback: use the "focus on X" capture group
  if (focusMatch?.[1]) {
    const captured = focusMatch[1].trim();
    if (captured.length > 3) return captured;
  }

  return undefined;
}
