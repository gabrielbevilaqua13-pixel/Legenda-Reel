// @vitest-environment node
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  wallets: new Map<string, { seconds: number; trial: boolean }>(),
  trials: new Set<string>(),
  receipts: new Map<string, Set<string>>(),
  packs: new Map<string, string>(),
  owners: new Map<string, string>(),
  cache: new Map<string, string>(),
}));

vi.mock("../lib/redis.server", () => ({
  evalRedis: async (script: string, keys: string[], args: string[]) => {
    if (script.includes("return {cost")) {
      const wallet = state.wallets.get(keys[0]!) ?? { seconds: 0, trial: true };
      state.wallets.set(keys[0]!, wallet);
      const free = wallet.trial && !state.trials.has(keys[1]!) && Number(args[0]) <= 60;
      const repeat = Boolean(args[1]) && (state.receipts.get(keys[2]!)?.has(args[1]!) ?? false);
      const cost = free || repeat ? 0 : Number(args[0]);
      return [cost, wallet.seconds, cost <= wallet.seconds ? 1 : 0, free && !repeat ? 1 : 0];
    }
    if (script.includes("HINCRBY") && script.includes("SADD")) {
      const wallet = state.wallets.get(keys[0]!)!;
      const free = wallet.trial && !state.trials.has(keys[1]!) && Number(args[0]) <= 60;
      const receipts = state.receipts.get(keys[2]!) ?? new Set<string>();
      state.receipts.set(keys[2]!, receipts);
      const cost = free || receipts.has(args[1]!) ? 0 : Number(args[0]);
      if (cost > wallet.seconds || cost > Number(args[2])) return 0;
      if (free && !receipts.has(args[1]!)) {
        wallet.trial = false;
        state.trials.add(keys[1]!);
      }
      wallet.seconds -= cost;
      receipts.add(args[1]!);
      return 1;
    }
    if (script.includes("local owner")) {
      if (!state.packs.has(keys[0]!)) return "";
      const owner = state.owners.get(keys[0]!);
      if (owner) return owner;
      const wallet = state.wallets.get(keys[1]!) ?? { seconds: 0, trial: true };
      wallet.seconds += 600;
      state.wallets.set(keys[1]!, wallet);
      state.owners.set(keys[0]!, args[0]!);
      return args[0];
    }
    const existing = state.packs.get(keys[0]!);
    if (existing) return existing;
    state.packs.set(keys[0]!, args[0]!);
    state.packs.set(keys[1]!, args[1]!);
    return args[0];
  },
  redis: async (command: string[]) => {
    if (command[0] === "GET") return state.cache.get(command[1]!) ?? null;
    if (command[0] === "SET") {
      state.cache.set(command[1]!, command[2]!);
      return "OK";
    }
    return null;
  },
}));

import {
  getCachedPart,
  issuePack,
  putCachedPart,
  quote,
  redeem,
  settle,
} from "../lib/credits-store.server";

beforeEach(() => Object.values(state).forEach((value) => value.clear()));

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
