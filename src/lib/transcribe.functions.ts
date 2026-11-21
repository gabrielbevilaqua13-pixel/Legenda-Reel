import { createServerFn } from "@tanstack/react-start";
import { getRequestIP } from "@tanstack/react-start/server";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { enabled, videoQuote } from "./billing.server";
import { manifestSchema } from "./billing-schema";
import { digest, getCachedPart, putCachedPart } from "./credits-store.server";
import { evalRedis } from "./redis.server";
import { normalizeWords } from "./timing";

export type Word = { text: string; start: number; end: number };

const RATE_WINDOW_MS = 60 * 60 * 1000;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_REQUESTS_PER_HOUR = 150;
const MAX_REQUESTS_PER_DAY = 400;
const requestHistory = new Map<string, number[]>();
let warnedAboutRedis = false;

const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local member = ARGV[2]
local hour = tonumber(ARGV[3])
local day = tonumber(ARGV[4])
local maxHour = tonumber(ARGV[5])
local maxDay = tonumber(ARGV[6])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - day)
local hourly = redis.call('ZCOUNT', key, now - hour, '+inf')
if hourly >= maxHour then
  local oldest = redis.call('ZRANGEBYSCORE', key, now - hour, '+inf', 'WITHSCORES', 'LIMIT', 0, 1)
  return {0, math.max(1, math.ceil((tonumber(oldest[2]) + hour - now) / 1000))}
end
local daily = redis.call('ZCARD', key)
if daily >= maxDay then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, math.max(1, math.ceil((tonumber(oldest[2]) + day - now) / 1000))}
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, math.ceil(day / 1000))
return {1, 0}
`;

function checkLocalTranscriptionLimit(ip: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const history = (requestHistory.get(ip) ?? []).filter((time) => now - time < DAILY_WINDOW_MS);
  const hourly = history.filter((time) => now - time < RATE_WINDOW_MS);
  if (hourly.length >= MAX_REQUESTS_PER_HOUR) {
    requestHistory.set(ip, history);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((hourly[0]! + RATE_WINDOW_MS - now) / 1000)),
    };
  }
  if (history.length >= MAX_REQUESTS_PER_DAY) {
    requestHistory.set(ip, history);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((history[0]! + DAILY_WINDOW_MS - now) / 1000)),
    };
  }
  history.push(now);
  requestHistory.set(ip, history);
  if (requestHistory.size > 5_000) {
    for (const [key, times] of requestHistory) {
      if (!times.some((time) => now - time < DAILY_WINDOW_MS)) requestHistory.delete(key);
    }
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

async function checkTranscriptionLimit(
  ip: string,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const redisUrl = process.env["REDIS_URL"];
  if (redisUrl) {
    try {
      const ipHash = createHash("sha256").update(ip).digest("hex");
      const result = await evalRedis(
        RATE_LIMIT_SCRIPT,
        [`transcription-limit:${ipHash}`],
        [
          String(Date.now()),
          `${Date.now()}:${randomUUID()}`,
          String(RATE_WINDOW_MS),
          String(DAILY_WINDOW_MS),
          String(MAX_REQUESTS_PER_HOUR),
          String(MAX_REQUESTS_PER_DAY),
        ],
      );
      if (
        !Array.isArray(result) ||
        typeof result[0] !== "number" ||
        typeof result[1] !== "number"
      ) {
        throw new Error("Unexpected Valkey rate-limit response");
      }
      return { allowed: result[0] === 1, retryAfterSeconds: result[1] };
    } catch (error) {
      if (!warnedAboutRedis) {
        console.warn("Shared rate-limit store unavailable; using in-memory fallback", error);
        warnedAboutRedis = true;
      }
    }
  }
  return checkLocalTranscriptionLimit(ip);
}

const groqResponseSchema = z.object({
  words: z.array(
    z.object({
      word: z.string(),
      start: z.number().finite(),
      end: z.number().finite(),
    }),
  ),
});

export const transcribeAudio = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        audioBase64: z
          .string()
          .min(60)
          .max(1_000_000)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/),
        duration: z.number().positive().max(12),
        billing: z
          .object({
            parts: manifestSchema,
            index: z.number().int().nonnegative(),
            cost: z.number().int().nonnegative(),
          })
          .optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<{ words: Word[] } | { error: string }> => {
    const ip = getRequestIP({ xForwardedFor: true }) ?? "unknown";
    const limit = await checkTranscriptionLimit(ip);
    if (!limit.allowed) {
      console.warn("Transcription rate limit reached");
      return {
        error:
          "Você atingiu o limite temporário de transcrições. Aguarde um pouco e tente novamente.",
      };
    }

    const apiKey = process.env["GROQ_API_KEY"];
    if (!apiKey) {
      console.error("Transcription configuration error: GROQ_API_KEY is missing");
      return { error: "A transcrição ainda não está configurada no servidor." };
    }

    try {
      const audioBytes = Buffer.from(data.audioBase64, "base64");
      const maxAudioBytes = Math.ceil(data.duration * 16_000 * 2) + 46;
      if (audioBytes.byteLength < 44 || audioBytes.byteLength > maxAudioBytes) {
        return { error: "O trecho de áudio enviado é inválido. Tente enviar o vídeo novamente." };
      }
      let cache: { wallet: string; hash: string } | null = null;
      if (enabled()) {
        if (!data.billing) return { error: "Atualize a página para conferir o saldo." };
        const { parts, index, cost } = data.billing;
        const part = parts[index];
        const { wallet, price } = await videoQuote(parts);
        if (!part || !price.allowed || price.cost > cost)
          return { error: "Confira seu saldo antes de transcrever." };
        const hash = digest(data.audioBase64);
        if (
          hash !== part.hash ||
          data.duration !== part.duration ||
          Math.abs((audioBytes.length - 44) / 32000 - part.duration) > 0.0001 ||
          audioBytes.toString("ascii", 0, 4) !== "RIFF" ||
          audioBytes.toString("ascii", 8, 16) !== "WAVEfmt " ||
          audioBytes.readUInt32LE(16) !== 16 ||
          audioBytes.readUInt16LE(20) !== 1 ||
          audioBytes.readUInt16LE(22) !== 1 ||
          audioBytes.readUInt32LE(24) !== 16000 ||
          audioBytes.readUInt16LE(34) !== 16 ||
          audioBytes.toString("ascii", 36, 40) !== "data" ||
          audioBytes.readUInt32LE(40) !== audioBytes.length - 44
        )
          return { error: "O áudio não corresponde ao orçamento." };
        if (await getCachedPart(wallet, hash, data.duration)) return { words: [] };
        cache = { wallet, hash };
      }
      const form = new FormData();
      form.append("file", new Blob([audioBytes], { type: "audio/wav" }), "audio.wav");
      form.append("model", "whisper-large-v3");
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      form.append("temperature", "0");

      const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });

      if (!response.ok) {
        const details = await response.text().catch(() => "");
        console.error("Groq transcription request failed", {
          status: response.status,
          details: details.slice(0, 1000),
        });
        if (response.status === 429) {
          return { error: "Muitas solicitações à transcrição. Aguarde um pouco e tente de novo." };
        }
        if (response.status === 401 || response.status === 403) {
          return {
            error: "A chave da Groq não foi aceita pelo servidor. Verifique a configuração.",
          };
        }
        if (response.status === 413) {
          return { error: "O trecho de áudio é grande demais para a transcrição." };
        }
        return { error: "Não foi possível concluir a transcrição. Tente novamente mais tarde." };
      }

      const payload = groqResponseSchema.parse(await response.json());
      const words = normalizeWords(
        payload.words
          .map(({ word, start, end }) => ({
            text: word.trim(),
            start,
            end,
          }))
          .filter((word) => word.text.length > 0),
        data.duration,
      );

      if (cache) {
        await putCachedPart(cache.wallet, cache.hash, data.duration, words);
        return { words: [] };
      }
      if (!words.length) return { error: "Não encontramos fala neste vídeo." };
      return { words };
    } catch (error) {
      console.error("Groq transcription processing error", error);
      return { error: "A resposta da transcrição veio incompleta. Tente novamente." };
    }
  });
