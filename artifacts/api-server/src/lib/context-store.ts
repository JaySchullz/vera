import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface StoreEntry {
  context_id: string;
  scope: string;
  version: number;
  payload: unknown;
  stored_at: string;
}

const store = new Map<string, StoreEntry>();

function key(context_id: string, scope: string): string {
  return `${scope}::${context_id}`;
}

export type StoreResult =
  | { accepted: true; ack_id: string; stored_at: string }
  | { accepted: false; reason: string; current_version: number };

export function upsertContext(
  scope: string,
  context_id: string,
  version: number,
  payload: unknown,
): StoreResult {
  const k = key(context_id, scope);
  const existing = store.get(k);

  if (existing && existing.version >= version) {
    return {
      accepted: false,
      reason: "stale_version",
      current_version: existing.version,
    };
  }

  const stored_at = new Date().toISOString();
  store.set(k, { context_id, scope, version, payload, stored_at });

  return {
    accepted: true,
    ack_id: `ack_${context_id}_v${version}`,
    stored_at,
  };
}

export function getCategory(slug: string): Record<string, unknown> | null {
  const entry = store.get(key(slug, "category"));
  return entry ? (entry.payload as Record<string, unknown>) : null;
}

export function getMerchant(id: string): Record<string, unknown> | null {
  const entry = store.get(key(id, "merchant"));
  return entry ? (entry.payload as Record<string, unknown>) : null;
}

export function getCustomer(id: string): Record<string, unknown> | null {
  const entry = store.get(key(id, "customer"));
  return entry ? (entry.payload as Record<string, unknown>) : null;
}

export function getTrigger(id: string): Record<string, unknown> | null {
  const entry = store.get(key(id, "trigger"));
  return entry ? (entry.payload as Record<string, unknown>) : null;
}

export function getCounts(): Record<string, number> {
  const counts = { category: 0, merchant: 0, customer: 0, trigger: 0 };
  for (const entry of store.values()) {
    if (entry.scope === "category") counts.category++;
    else if (entry.scope === "merchant") counts.merchant++;
    else if (entry.scope === "customer") counts.customer++;
    else if (entry.scope === "trigger") counts.trigger++;
  }
  return counts;
}

export function preloadCategories(): void {
  const categoryFiles = [
    "dentists_1777665166904.json",
    "salons_1777665166906.json",
    "gyms_1777665166905.json",
    "pharmacies_1777665166905.json",
    "restaurants_1777665166905.json",
  ];

  // Resolve from process.cwd() (server working directory) — robust regardless of
  // whether the code is running from src/ or dist/
  const candidateDirs = [
    resolve(process.cwd(), "../../attached_assets"),   // from artifacts/api-server/
    resolve(process.cwd(), "attached_assets"),          // from workspace root
    resolve(__dirname, "../../../attached_assets"),     // from dist/
    resolve(__dirname, "../../../../attached_assets"),  // fallback
  ];

  let assetsDir: string | null = null;
  for (const dir of candidateDirs) {
    try {
      readFileSync(resolve(dir, categoryFiles[0]!));
      assetsDir = dir;
      break;
    } catch {
      // try next candidate
    }
  }

  if (!assetsDir) {
    console.error(
      "[preloadCategories] FATAL: Could not locate attached_assets/ in any candidate path:",
      candidateDirs,
    );
    return;
  }

  let loaded = 0;
  for (const filename of categoryFiles) {
    try {
      const filePath = resolve(assetsDir, filename);
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      const slug = data["slug"] as string;
      upsertContext("category", slug, 1, data);
      loaded++;
    } catch (err) {
      console.error(`[preloadCategories] FAILED to load ${filename}:`, err);
    }
  }

  console.info(`[preloadCategories] Loaded ${loaded}/${categoryFiles.length} category contexts from ${assetsDir}`);
}
