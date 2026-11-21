import { createHash, timingSafeEqual } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { getRequestIP } from "@tanstack/react-start/server";
import { z } from "zod";
import { issuePack } from "./credits-store.server";

const attempts = new Map<string, { count: number; expires: number }>();

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
    const now = Date.now();
    const previous = attempts.get(network);
    const attempt =
      !previous || previous.expires <= now
        ? { count: 1, expires: now + 3_600_000 }
        : { count: previous.count + 1, expires: previous.expires };
    attempts.set(network, attempt);
    if (attempt.count > 10 || !matchesSecret(data.secret)) {
      throw new Error("Acesso não autorizado.");
    }
    return { code: await issuePack(data.payment) };
  });
