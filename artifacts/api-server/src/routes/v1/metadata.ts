import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.get("/metadata", (_req, res) => {
  res.json({
    team_name: "Vera AI",
    team_members: ["Vera"],
    model: "gpt-4o-mini",
    approach:
      "causal-narrative trigger router with conflict overrides + 17 asymmetric templates + mandatory compulsion + controlled variability + LLM style polish + latency fallback + structured rationale",
    contact_email: "vera@magicpin.ai",
    version: "4.0.0",
    submitted_at: new Date().toISOString(),
  });
});

export default router;
