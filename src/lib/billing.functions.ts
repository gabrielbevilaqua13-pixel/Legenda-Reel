import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { manifestSchema } from "./billing-schema";
import { mergeSegments } from "./timing";
import { enabled, identity, remember, videoQuote } from "./billing.server";
import { database, quote, redeem, settle } from "./credits-store.server.mjs";

export const getWallet = createServerFn({ method: "POST" }).handler(async () => {
  if (!enabled()) return null;
  const { wallet, network } = identity();
  const price = quote(database(), wallet, network, "", 60);
  const raw = process.env["MERCADO_PAGO_PAYMENT_LINK"] || "";
  const link = /^https:\/\/(mpago\.la|(?:www\.)?mercadopago\.com\.br)\//.test(raw) ? raw : null;
  const contact = process.env["LEGENDA_SUPPORT_EMAIL"] || null;
  return { seconds: price.available, trial: price.free, link: contact ? link : null, contact };
});
export const activatePack = createServerFn({ method: "POST" })
  .inputValidator((v) =>
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-f0-9]{36}$/)
      .parse(v),
  )
  .handler(async ({ data }) => {
    remember(redeem(identity().wallet, data));
    return true;
  });
export const getQuote = createServerFn({ method: "POST" })
  .inputValidator((v) => manifestSchema.parse(v))
  .handler(async ({ data }) => videoQuote(data).price);
export const finishVideo = createServerFn({ method: "POST" })
  .inputValidator((v) =>
    z.object({ parts: manifestSchema, cost: z.number().int().min(0).max(600) }).parse(v),
  )
  .handler(async ({ data }) => {
    const { wallet, network, video, seconds } = videoQuote(data.parts);
    const get = database().prepare(
      "SELECT words FROM parts WHERE wallet=? AND hash=? AND ABS(duration-?)<0.0001 AND expires>?",
    );
    const groups = data.parts.map((p) => {
      const row = get.get(wallet, p.hash, p.duration, Date.now());
      if (!row) throw Error("Um trecho expirou. Selecione o vídeo novamente.");
      return JSON.parse(String(row["words"]));
    });
    const words = mergeSegments(groups, data.parts, data.parts.at(-1)!.keepEnd);
    if (!words.length) throw Error("Não encontramos fala neste vídeo.");
    settle(wallet, network, video, seconds, data.cost);
    return { words };
  });
