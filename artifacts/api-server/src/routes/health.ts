import { Router, type IRouter } from "express";
import { z } from "zod";

const HealthCheckResponse = z.object({
  status: z.string(),
  uptime_seconds: z.number().optional(),
  contexts_loaded: z.record(z.number()).optional(),
});

const router: IRouter = Router();

const startTime = Date.now();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok", uptime_seconds: Math.floor((Date.now() - startTime) / 1000) });
  res.json(data);
});

export default router;
