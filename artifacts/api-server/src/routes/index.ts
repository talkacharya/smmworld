import { Router, type IRouter } from "express";
import healthRouter from "./health";
import smmRouter from "./smm";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/smm", smmRouter);

export default router;
