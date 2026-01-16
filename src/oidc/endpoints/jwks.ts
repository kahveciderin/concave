import { Router, Request, Response } from "express";
import { KeyManager } from "../types";

export const createJWKSEndpoint = (keyManager: KeyManager): Router => {
  const router = Router();

  router.get("/", async (_req: Request, res: Response) => {
    const keys = await keyManager.getPublicKeys();

    res.set("Cache-Control", "public, max-age=3600");
    res.json({ keys });
  });

  return router;
};
