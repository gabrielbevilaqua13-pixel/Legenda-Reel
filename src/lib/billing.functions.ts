import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { manifestSchema } from "./billing-schema";
import { mergeSegments } from "./timing";
import { enabled, identity, remember, videoQuote } from "./billing.server";
import { getCachedPart, quote, redeem, settle } from "./credits-store.server";

export const getWallet = createServerFn({ method: "POST" }).handler(async () => {
  if (!enabled()) return null;
  const { wallet, network } = identity();
  const price = await quote(wallet, network, "", 60);
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
    remember(await redeem(identity().wallet, data));
    return true;
  });
export const getQuote = createServerFn({ method: "POST" })
  .inputValidator((v) => manifestSchema.parse(v))
  .handler(async ({ data }) => (await videoQuote(data)).price);
export const finishVideo = createServerFn({ method: "POST" })
  .inputValidator((v) =>
    z.object({ parts: manifestSchema, cost: z.number().int().min(0).max(600) }).parse(v),
  )
  .handler(async ({ data }) => {
    const { wallet, network, video, seconds } = await videoQuote(data.parts);
    const groups = await Promise.all(
      data.parts.map(async (part) => {
        const words = await getCachedPart(wallet, part.hash, part.duration);
        if (!words) throw Error("Um trecho expirou. Selecione o vídeo novamente.");
        return words;
      }),
    );
    const words = mergeSegments(groups, data.parts, data.parts.at(-1)!.keepEnd);
    if (!words.length) throw Error("Não encontramos fala neste vídeo.");
    await settle(wallet, network, video, seconds, data.cost);
    return { words };
  });
