const usedKeys = new Set<string>();

export function isSuppressed(key: string): boolean {
  return usedKeys.has(key);
}

export function suppress(key: string): void {
  usedKeys.add(key);
}
