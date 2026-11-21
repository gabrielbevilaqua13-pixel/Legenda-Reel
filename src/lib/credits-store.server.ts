import { createHash, randomBytes } from "node:crypto";
import { evalRedis, redis } from "./redis.server";
import type { Word } from "./transcribe.functions";

export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

const QUOTE_SCRIPT = `
redis.call('HSETNX', KEYS[1], 'seconds', 0)
redis.call('HSETNX', KEYS[1], 'trial', 1)
local available = tonumber(redis.call('HGET', KEYS[1], 'seconds') or '0')
local trial = tonumber(redis.call('HGET', KEYS[1], 'trial') or '0')
local free = trial == 1 and redis.call('EXISTS', KEYS[2]) == 0 and tonumber(ARGV[1]) <= 60
local repeatVideo = ARGV[2] ~= '' and redis.call('SISMEMBER', KEYS[3], ARGV[2]) == 1
local cost = tonumber(ARGV[1])
if free or repeatVideo then cost = 0 end
return {cost, available, cost <= available and 1 or 0, free and not repeatVideo and 1 or 0}
`;

export type Price = { cost: number; available: number; allowed: boolean; free: boolean };

export async function quote(
  wallet: string,
  network: string,
  video: string,
  seconds: number,
): Promise<Price> {
  const value = await evalRedis(
    QUOTE_SCRIPT,
    [`legenda:wallet:${wallet}`, `legenda:trial-network:${network}`, `legenda:receipts:${wallet}`],
    [String(seconds), video],
  );
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some((item) => typeof item !== "number")
  ) {
    throw new Error("Não foi possível consultar o saldo.");
  }
  return {
    cost: value[0] as number,
    available: value[1] as number,
    allowed: value[2] === 1,
    free: value[3] === 1,
  };
}

const SETTLE_SCRIPT = `
local available = tonumber(redis.call('HGET', KEYS[1], 'seconds') or '0')
local trial = tonumber(redis.call('HGET', KEYS[1], 'trial') or '0')
local free = trial == 1 and redis.call('EXISTS', KEYS[2]) == 0 and tonumber(ARGV[1]) <= 60
local repeatVideo = redis.call('SISMEMBER', KEYS[3], ARGV[2]) == 1
local cost = tonumber(ARGV[1])
if free or repeatVideo then cost = 0 end
if cost > available or cost > tonumber(ARGV[3]) then return 0 end
if free and not repeatVideo then
  redis.call('HSET', KEYS[1], 'trial', 0)
  redis.call('SET', KEYS[2], 1, 'EX', 86400)
end
redis.call('HINCRBY', KEYS[1], 'seconds', -cost)
redis.call('SADD', KEYS[3], ARGV[2])
return 1
`;

export async function settle(
  wallet: string,
  network: string,
  video: string,
  seconds: number,
  expectedCost: number,
) {
  const value = await evalRedis(
    SETTLE_SCRIPT,
    [`legenda:wallet:${wallet}`, `legenda:trial-network:${network}`, `legenda:receipts:${wallet}`],
    [String(seconds), video, String(expectedCost)],
  );
  if (value !== 1) throw new Error("O saldo mudou. Confira o valor antes de tentar novamente.");
}

const REDEEM_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return '' end
local owner = redis.call('HGET', KEYS[1], 'wallet') or ''
if owner ~= '' then return owner end
redis.call('HSETNX', KEYS[2], 'seconds', 0)
redis.call('HSETNX', KEYS[2], 'trial', 1)
redis.call('HINCRBY', KEYS[2], 'seconds', 600)
redis.call('HSET', KEYS[1], 'wallet', ARGV[1])
return ARGV[1]
`;

export async function redeem(wallet: string, code: string) {
  const value = await evalRedis(
    REDEEM_SCRIPT,
    [`legenda:pack:${code}`, `legenda:wallet:${wallet}`],
    [wallet],
  );
  if (typeof value !== "string" || !value) throw new Error("Código de pacote inválido.");
  return value;
}

const ISSUE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then return existing end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[2], 'payment', ARGV[2], 'wallet', '')
return ARGV[1]
`;

export async function issuePack(payment: string) {
  if (!/^[0-9]{1,40}$/.test(payment)) {
    throw new Error("Informe o ID numérico do pagamento aprovado.");
  }
  const code = randomBytes(18).toString("hex");
  const value = await evalRedis(
    ISSUE_SCRIPT,
    [`legenda:payment:${payment}`, `legenda:pack:${code}`],
    [code, payment],
  );
  if (typeof value !== "string") throw new Error("Não foi possível gerar o código.");
  return value;
}

export async function getCachedPart(wallet: string, hash: string, duration: number) {
  const value = await redis(["GET", `legenda:part:${wallet}:${hash}`]);
  if (typeof value !== "string") return null;
  const parsed = JSON.parse(value) as { duration: number; words: Word[] };
  return Math.abs(parsed.duration - duration) < 0.0001 ? parsed.words : null;
}

export async function putCachedPart(wallet: string, hash: string, duration: number, words: Word[]) {
  await redis([
    "SET",
    `legenda:part:${wallet}:${hash}`,
    JSON.stringify({ duration, words }),
    "EX",
    "3600",
  ]);
}
