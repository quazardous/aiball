/**
 * Config home (#235): one read for the frontend's boot-time configuration,
 * instead of one micro-router per config slice. Mutations stay on their own
 * targeted methods (`strategy.set`, `upload.set_max_bytes`).
 * The read is the bus method `config.get`; this route serves it.
 */
import { Router } from "express";
import { serveMethod } from "../bus/http.js";

export const configRouter = Router();

configRouter.get("/config", serveMethod("config.get"));
