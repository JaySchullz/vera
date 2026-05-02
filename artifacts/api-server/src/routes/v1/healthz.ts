import { Router, type IRouter } from "express";
import { getCounts } from "../../lib/context-store.js";

const startedAt = Date.now();

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const uptime_seconds = Math.floor((Date.now() - startedAt) / 1000);
  res.json({
    status: "ok",
    uptime_seconds,
    contexts_loaded: getCounts(),
  });
});

export default router;
