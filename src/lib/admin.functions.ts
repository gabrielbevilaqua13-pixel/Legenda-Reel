import { createHash, timingSafeEqual } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { getRequestIP } from "@tanstack/react-start/server";
import { z } from "zod";
import { issuePack } from "./credits-store.server";
import { redis } from "./redis.server";

function matchesSecret(provided: string) {
  const expected = process.env["LEGENDA_ADMIN_SECRET"] || "";
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return expected.length >= 20 && timingSafeEqual(left, right);
}

export const issuePackAdmin = createServerFn({ method: "POST" })
  .inputValidator((value) =>
    z
      .object({
        secret: z.string().min(20).max(200),
        payment: z
          .string()
          .trim()
          .regex(/^[0-9]{1,40}$/),
      })
      .parse(value),
  )
  .handler(async ({ data }) => {
    const network = createHash("sha256")
      .update(getRequestIP({ xForwardedFor: true }) || "unknown")
      .digest("hex");
    const attemptKey = `legenda:admin-attempts:${network}`;
    const attempts = await redis(["INCR", attemptKey]);
    if (attempts === 1) await redis(["EXPIRE", attemptKey, "3600"]);
    if (typeof attempts !== "number" || attempts > 10 || !matchesSecret(data.secret)) {
      throw new Error("Acesso não autorizado.");
    }
    return { code: await issuePack(data.payment) };
  });
