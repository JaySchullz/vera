export interface VoiceProfile {
  tone: string;
  register: string;
  taboos: string[];
  salutation: string;
  description: string;
}

export const VOICE_PROFILES: Record<string, VoiceProfile> = {
  dentists: {
    tone: "peer_clinical",
    register: "respectful_collegial",
    taboos: ["guaranteed", "100% safe", "completely cure", "miracle", "best in city"],
    salutation: "Dr. {first_name}",
    description:
      "Clinical peer tone — respectful, collegial, technical vocab welcome. Talk like a colleague sharing useful information, not a salesperson. Avoid hype. Use 'worth a look' not 'amazing'. Taboo words: guaranteed, cure, miracle.",
  },
  salons: {
    tone: "warm_practical",
    register: "approachable_expert",
    taboos: ["guaranteed glow", "permanent results", "instant transformation", "miracle", "best in city"],
    salutation: "{first_name}",
    description:
      "Warm, practical, approachable expert. Hindi-English code-mix natural. Talk like a knowledgeable friend who works in beauty, not a corporate brand. Taboo: guaranteed results, miracle.",
  },
  gyms: {
    tone: "energetic_disciplined",
    register: "coach_to_member",
    taboos: ["guaranteed weight loss", "shred in 7 days", "miracle transformation", "fastest results"],
    salutation: "{first_name}",
    description:
      "Energetic but disciplined coach-to-member tone. Results-oriented, data-driven. Avoid empty hype. Use specifics (footfall, churn %). Taboo: guaranteed weight loss, miracle transformation.",
  },
  restaurants: {
    tone: "warm_busy_practical",
    register: "fellow_operator",
    taboos: ["best food in city", "guaranteed packed house", "miracle marketing", "viral guarantee"],
    salutation: "{first_name}",
    description:
      "Warm, busy, practical — talk like a fellow restaurant operator who gets it. Use trade terms (covers, AOV, footfall). Taboo: viral guarantee, best in city.",
  },
  pharmacies: {
    tone: "trustworthy_precise",
    register: "neighbourhood_pharmacist",
    taboos: ["miracle cure", "guaranteed result", "100% safe", "best price"],
    salutation: "{first_name}",
    description:
      "Trustworthy, precise neighbourhood pharmacist. Compliance-aware. Use molecule names, batch numbers, CDSCO references naturally. Taboo: miracle cure, guaranteed.",
  },
};

export function getVoiceProfile(categorySlug: string): VoiceProfile {
  return VOICE_PROFILES[categorySlug] ?? VOICE_PROFILES["dentists"]!;
}

export function containsTaboo(body: string, taboos: string[]): boolean {
  const lower = body.toLowerCase();
  return taboos.some((t) => lower.includes(t.toLowerCase()));
}
