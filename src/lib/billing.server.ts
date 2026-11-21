import { randomBytes } from "node:crypto";
import { getCookie, setCookie, getRequestIP, useSession } from "@tanstack/react-start/server";
import { digest, quote } from "./credits-store.server";
import type { Manifest } from "./billing-schema";

export const enabled = () =>
  Boolean(process.env["SUPABASE_URL"] && process.env["SUPABASE_PUBLISHABLE_KEY"]);
const ownerCookie = "legenda-owner";
export function ownerSession() {
  const secret = process.env["LEGENDA_ADMIN_SECRET"] || "";
  if (secret.length < 20) throw Error("Acesso de proprietário indisponível.");
  return useSession<{ owner: boolean }>({
    name: ownerCookie,
    password: digest("legenda-owner-session:" + secret),
    maxAge: 8 * 3600,
    sessionHeader: false,
    cookie: { httpOnly: true, secure: process.env["NODE_ENV"] === "production", sameSite: "strict", path: "/" },
  });
}
export async function isOwner() {
  if (!getCookie(ownerCookie) || (process.env["LEGENDA_ADMIN_SECRET"] || "").length < 20) return false;
  return (await ownerSession()).data.owner === true;
}
export function remember(id: string) {
  setCookie("legenda-wallet", id, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 31536000,
  });
}
export function identity() {
  let id = getCookie("legenda-wallet");
  if (!id || !/^[a-f0-9]{48}$/.test(id)) {
    id = randomBytes(24).toString("hex");
    remember(id);
  }
  return { wallet: id, network: digest(getRequestIP({ xForwardedFor: true }) || "unknown") };
}
export async function videoQuote(parts: Manifest) {
  let end = 0;
  for (const p of parts) {
    if (
      Math.abs(p.keepStart - end) > 0.00001 ||
      p.keepEnd <= p.keepStart ||
      Math.abs(p.offset - Math.max(0, p.keepStart - 0.65)) > 0.0001 ||
      Math.abs(p.offset + p.duration - Math.min(parts.at(-1)!.keepEnd, p.keepEnd + 0.65)) >
        0.0001 ||
      (parts.length > 1 && p !== parts.at(-1) && p.keepEnd - p.keepStart < 6)
    )
      throw Error("A duração dos trechos é inválida.");
    end = p.keepEnd;
  }
  const seconds = Math.ceil(end - 0.00001);
  if (seconds < 1 || seconds > 600) throw Error("Envie um vídeo de até 10 minutos.");
  const { wallet, network } = identity();
  const owner = await isOwner();
  const video = digest(parts.map((p) => p.hash).join("/"));
  return {
    wallet,
    network,
    video,
    seconds,
    owner,
    price: owner ? { available: 0, cost: 0, allowed: true, free: false } : await quote(wallet, network, video, seconds),
  };
}
