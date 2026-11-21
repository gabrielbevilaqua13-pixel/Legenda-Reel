// @vitest-environment node
import { beforeEach, expect, test, vi } from "vitest";
import {
  getCachedPart,
  issuePack,
  putCachedPart,
  quote,
  redeem,
  settle,
} from "../lib/credits-store.server";

const wallets = new Map<string, { seconds: number; trial: boolean }>();
const trials = new Set<string>();
const receipts = new Map<string, Set<string>>();
const payments = new Map<string, string>();
const owners = new Map<string, string>();
const cache = new Map<string, { duration: number; words: unknown[] }>();

function price(walletId: string, network: string, video: string, seconds: number) {
  const wallet = wallets.get(walletId) ?? { seconds: 0, trial: true };
  wallets.set(walletId, wallet);
  const free = wallet.trial && !trials.has(network) && seconds <= 60;
  const repeat = Boolean(video) && (receipts.get(walletId)?.has(video) ?? false);
  const cost = free || repeat ? 0 : seconds;
  return { cost, available: wallet.seconds, allowed: cost <= wallet.seconds, free: free && !repeat };
}

beforeEach(() => {
  [wallets, trials, receipts, payments, owners, cache].forEach((item) => item.clear());
  process.env["SUPABASE_URL"] = "https://example.supabase.co";
  process.env["SUPABASE_PUBLISHABLE_KEY"] = "publishable";
  process.env["LEGENDA_ADMIN_SECRET"] = "a-very-long-administrative-secret";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      const name = url.split("/").at(-1)!;
      const body = JSON.parse(String(options.body)) as {
        p_wallet: string; p_network: string; p_video: string; p_seconds: number;
        p_code: string; p_payment: string; p_expected_cost: number; p_hash: string;
        p_duration: number; p_words: unknown[];
      };
      if (name === "legenda_quote") {
        return Response.json([
          price(body.p_wallet, body.p_network, body.p_video, body.p_seconds),
        ]);
      }
      if (name === "legenda_settle") {
        const current = price(body.p_wallet, body.p_network, body.p_video, body.p_seconds);
        if (!current.allowed || current.cost > body.p_expected_cost) {
          return new Response("balance changed", { status: 400 });
        }
        const wallet = wallets.get(body.p_wallet)!;
        if (current.free) {
          wallet.trial = false;
          trials.add(body.p_network);
        }
        wallet.seconds -= current.cost;
        const videos = receipts.get(body.p_wallet) ?? new Set<string>();
        videos.add(body.p_video);
        receipts.set(body.p_wallet, videos);
        return Response.json(true);
      }
      if (name === "legenda_issue_pack") {
        const code = payments.get(body.p_payment) ?? body.p_code;
        payments.set(body.p_payment, code);
        return Response.json(code);
      }
      if (name === "legenda_redeem") {
        if (![...payments.values()].includes(body.p_code)) {
          return new Response("invalid code", { status: 400 });
        }
        const owner = owners.get(body.p_code);
        if (owner) return Response.json(owner);
        const wallet = wallets.get(body.p_wallet) ?? { seconds: 0, trial: true };
        wallet.seconds += 600;
        wallets.set(body.p_wallet, wallet);
        owners.set(body.p_code, body.p_wallet);
        return Response.json(body.p_wallet);
      }
      if (name === "legenda_cache_put") {
        cache.set(`${body.p_wallet}:${body.p_hash}`, {
          duration: body.p_duration,
          words: body.p_words,
        });
        return Response.json(true);
      }
      const entry = cache.get(`${body.p_wallet}:${body.p_hash}`);
      return Response.json(
        entry && Math.abs(entry.duration - body.p_duration) < 0.0001 ? entry.words : null,
      );
    }),
  );
});

test("trial, idempotent purchase, recovery, debit and free retry", async () => {
  expect((await quote("a", "ip", "short", 60)).free).toBe(true);
  expect((await quote("a", "ip", "long", 61)).allowed).toBe(false);
  await settle("a", "ip", "short", 60, 0);
  expect((await quote("b", "ip", "short", 60)).allowed).toBe(false);
  const code = await issuePack("1234");
  expect(await issuePack("1234")).toBe(code);
  expect(await redeem("a", code)).toBe("a");
  expect(await redeem("b", code)).toBe("a");
  expect((await quote("a", "ip", "paid", 400)).available).toBe(600);
  await settle("a", "ip", "paid", 400, 400);
  await settle("a", "ip", "paid", 400, 400);
  await expect(settle("a", "ip", "racing", 400, 400)).rejects.toThrow();
  expect((await quote("a", "ip", "another", 200)).available).toBe(200);
});

test("temporary transcription cache validates duration", async () => {
  const words = [{ text: "Legenda", start: 0, end: 0.4 }];
  await putCachedPart("wallet", "hash", 2, words);
  expect(await getCachedPart("wallet", "hash", 2)).toEqual(words);
  expect(await getCachedPart("wallet", "hash", 3)).toBeNull();
});
