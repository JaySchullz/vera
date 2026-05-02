import { Router, type IRouter } from "express";
import healthzRouter from "./healthz.js";
import metadataRouter from "./metadata.js";
import contextRouter from "./context.js";
import tickRouter from "./tick.js";
import replyRouter from "./reply.js";

const router: IRouter = Router();

router.use(healthzRouter);
router.use(metadataRouter);
router.use(contextRouter);
router.use(tickRouter);
router.use(replyRouter);

export default router;
