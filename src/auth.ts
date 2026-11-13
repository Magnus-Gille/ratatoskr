import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { isLoopbackBindHost } from "./loopback.js";

export function requireSendApiKey(
  sendApiKey: string,
  host: string
): (req: Request, res: Response, next: NextFunction) => void {
  const isLoopback = isLoopbackBindHost(host);

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!sendApiKey) {
      if (isLoopback) {
        next();
        return;
      }
      res.status(401).json({
        error:
          "Send API key not configured; endpoint disabled on non-loopback bind",
      });
      return;
    }

    // Key is configured — enforce on all binds.
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";

    let valid = false;
    try {
      const keyBuf = Buffer.from(sendApiKey);
      const tokBuf = Buffer.from(token);
      // Length check first to keep buffers same size for timingSafeEqual.
      if (keyBuf.length === tokBuf.length && keyBuf.length > 0) {
        valid = timingSafeEqual(keyBuf, tokBuf);
      }
    } catch {
      valid = false;
    }

    if (!valid) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    next();
  };
}
