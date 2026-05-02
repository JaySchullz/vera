# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/api-server run test` — run judge simulation tests (requires server running)

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Vera AI Bot (magicpin India AI Challenge)

The `artifacts/api-server` package exposes 5 HTTP endpoints under `/v1/`:
- `POST /v1/context` — upsert merchant/trigger/customer/category context (versioned)
- `POST /v1/tick` — select best trigger, compose message, create conversation
- `POST /v1/reply` — handle merchant reply (opt-out / auto-reply / positive / clarify)
- `GET /v1/healthz` — system health + context load counts
- `GET /v1/metadata` — challenge metadata (team, model, approach)

### Key Architecture
- **Decision engine** (`src/lib/decision-engine.ts`): 4-tier priority (Tier 0 supremacy → Tier 1 hard override → Tier 2 soft override → Tier 3 scored). 6h cooldown gate (critical triggers bypass), waiting-conv gate (no bypass).
- **Composer** (`src/lib/composer.ts`): 24 trigger-kind templates, LLM polish via OpenAI with 5s timeout fallback, 8 mandatory output gates (digit, compulsion, CTA count, length, numeric token preservation, trigger-reason, taboo, URL).
- **Narrative** (`src/lib/narrative.ts`): Builds causal narrative (problem/proof/proof2/benchmark/offer/action) per trigger kind with offer anchoring (service_at_price preferred).
- **5 category files** preloaded at startup from `attached_assets/`.

### Test Suite
- `artifacts/api-server/tests/judge_simulation.py` — 287-assertion end-to-end judge simulation
  - Section 1: healthz + metadata sanity
  - Section 2: All 24 trigger kinds (body digit, ≤600 chars, rationale format, send_as, cta)
  - Section 3: Decision engine (Tier 0/1/2, soft-override correctness, 6h cooldown, suppression, expiry, waiting-conv block)
  - Section 4: Reply state machine (auto-reply→wait, opt-out→end, positive→exec+PUBLISH_CTA, topic_bias, out-of-scope redirect, clarify, ended-conv, wait-expiry, critical bypass, idempotency)
