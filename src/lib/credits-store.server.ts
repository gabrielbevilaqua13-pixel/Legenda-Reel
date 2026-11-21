import { createHash, randomBytes } from "node:crypto";
import type { Word } from "./transcribe.functions";

export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

async function rpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) throw new Error("O armazenamento de créditos ainda não está configurado.");
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: key,
      ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("Supabase credit RPC failed", { name, status: response.status, detail });
    throw new Error("Não foi possível atualizar os créditos.");
  }
  return (await response.json()) as T;
}

export type Price = { cost: number; available: number; allowed: boolean; free: boolean };

export async function quote(
  wallet: string,
  network: string,
  video: string,
  seconds: number,
): Promise<Price> {
  const rows = await rpc<Price[]>("legenda_quote", {
    p_wallet: wallet,
    p_network: network,
    p_video: video,
    p_seconds: seconds,
  });
  const price = rows[0];
  if (!price) throw new Error("Não foi possível consultar o saldo.");
  return price;
}

export async function settle(
  wallet: string,
  network: string,
  video: string,
  seconds: number,
  expectedCost: number,
) {
  await rpc<boolean>("legenda_settle", {
    p_wallet: wallet,
    p_network: network,
    p_video: video,
    p_seconds: seconds,
    p_expected_cost: expectedCost,
  });
}

export async function redeem(wallet: string, code: string) {
  return rpc<string>("legenda_redeem", { p_wallet: wallet, p_code: code });
}

export async function issuePack(payment: string) {
  if (!/^[0-9]{1,40}$/.test(payment)) {
    throw new Error("Informe o ID numérico do pagamento aprovado.");
  }
  const adminHash = digest(process.env["LEGENDA_ADMIN_SECRET"] || "");
  return rpc<string>("legenda_issue_pack", {
    p_payment: payment,
    p_code: randomBytes(18).toString("hex"),
    p_admin_hash: adminHash,
  });
}

export async function getCachedPart(wallet: string, hash: string, duration: number) {
  return rpc<Word[] | null>("legenda_cache_get", {
    p_wallet: wallet,
    p_hash: hash,
    p_duration: duration,
  });
}

export async function putCachedPart(wallet: string, hash: string, duration: number, words: Word[]) {
  await rpc<boolean>("legenda_cache_put", {
    p_wallet: wallet,
    p_hash: hash,
    p_duration: duration,
    p_words: words,
  });
}
