function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function pick<T>(arr: T[], hashKey: string): T {
  return arr[hashStr(hashKey) % arr.length]!;
}

const CTA_ENDINGS = [
  "Want me to send it?",
  "Should I send this?",
  "Send this across?",
  "Shall I proceed?",
];

const HUMANIZATIONS = [
  "Quick heads-up —",
  "Spotted something —",
  "Worth a look —",
  "Quick one —",
];

const EFFORT_FRAMINGS = [
  "already drafted — can send in 10 min",
  "ready to go — can send in 10 min",
  "I've put this together — can send in 10 min",
];

const SOFT_CLOSINGS = [
  "Let me know.",
  "Your call.",
  "Ready when you are.",
];

export function getVariations(hashKey: string) {
  return {
    cta: pick(CTA_ENDINGS, hashKey + "cta"),
    humanization: pick(HUMANIZATIONS, hashKey + "human"),
    effort: pick(EFFORT_FRAMINGS, hashKey + "effort"),
    closing: pick(SOFT_CLOSINGS, hashKey + "close"),
  };
}
