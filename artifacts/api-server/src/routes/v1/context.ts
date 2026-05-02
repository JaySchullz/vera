import { Router, type IRouter } from "express";
import { upsertContext } from "../../lib/context-store.js";

const router: IRouter = Router();

const VALID_SCOPES = new Set(["category", "merchant", "customer", "trigger"]);

router.post("/context", (req, res) => {
  const { scope, context_id, version, payload } = req.body as {
    scope: string;
    context_id: string;
    version: number;
    payload: unknown;
    delivered_at?: string;
  };

  if (!scope || !VALID_SCOPES.has(scope)) {
    res.status(400).json({ error: "invalid_scope", valid_scopes: [...VALID_SCOPES] });
    return;
  }
  if (!context_id || typeof context_id !== "string") {
    res.status(400).json({ error: "missing_context_id" });
    return;
  }
  if (typeof version !== "number" || version < 1) {
    res.status(400).json({ error: "invalid_version" });
    return;
  }
  if (payload === undefined || payload === null) {
    res.status(400).json({ error: "missing_payload" });
    return;
  }

  const result = upsertContext(scope, context_id, version, payload);

  if (!result.accepted) {
    res.status(409).json(result);
    return;
  }

  res.status(200).json(result);
});

export default router;
