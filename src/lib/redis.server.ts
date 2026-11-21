import { createConnection } from "node:net";
import { connect as connectTls } from "node:tls";

export type RedisValue = string | number | null | RedisValue[];

function parseResp(buffer: Buffer, offset = 0): { value: RedisValue; next: number } | null {
  if (offset >= buffer.length) return null;
  const type = String.fromCharCode(buffer[offset]!);
  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd < 0) return null;
  const header = buffer.toString("utf8", offset + 1, lineEnd);
  if (type === "+" || type === "-") {
    if (type === "-") throw new Error(`Valkey error: ${header}`);
    return { value: header, next: lineEnd + 2 };
  }
  if (type === ":") return { value: Number(header), next: lineEnd + 2 };
  if (type === "$") {
    const length = Number(header);
    if (length === -1) return { value: null, next: lineEnd + 2 };
    const end = lineEnd + 2 + length;
    if (buffer.length < end + 2) return null;
    return { value: buffer.toString("utf8", lineEnd + 2, end), next: end + 2 };
  }
  if (type === "*") {
    const count = Number(header);
    if (count === -1) return { value: null, next: lineEnd + 2 };
    const values: RedisValue[] = [];
    let cursor = lineEnd + 2;
    for (let index = 0; index < count; index += 1) {
      const item = parseResp(buffer, cursor);
      if (!item) return null;
      values.push(item.value);
      cursor = item.next;
    }
    return { value: values, next: cursor };
  }
  throw new Error("Unsupported Valkey response");
}

function encodeResp(args: string[]): string {
  return `*${args.length}\r\n${args
    .map((argument) => `$${Buffer.byteLength(argument)}\r\n${argument}\r\n`)
    .join("")}`;
}

export async function redis(command: string[]): Promise<RedisValue> {
  const rawUrl = process.env["REDIS_URL"];
  if (!rawUrl) throw new Error("O armazenamento de créditos ainda não está configurado.");
  const url = new URL(rawUrl);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use redis:// or rediss://");
  }
  const port = Number(url.port || 6379);
  const commands: string[][] = [];
  if (url.password) {
    commands.push(
      url.username
        ? ["AUTH", decodeURIComponent(url.username), decodeURIComponent(url.password)]
        : ["AUTH", decodeURIComponent(url.password)],
    );
  }
  const database = url.pathname.replace(/^\//, "");
  if (database && database !== "0") commands.push(["SELECT", database]);
  commands.push(command);

  return new Promise((resolve, reject) => {
    const socket =
      url.protocol === "rediss:"
        ? connectTls({ host: url.hostname, port, servername: url.hostname })
        : createConnection({ host: url.hostname, port });
    let buffer = Buffer.alloc(0);
    let parsedCount = 0;
    let lastValue: RedisValue = null;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(4_000, () => fail(new Error("Valkey connection timed out")));
    socket.once(url.protocol === "rediss:" ? "secureConnect" : "connect", () => {
      socket.write(commands.map(encodeResp).join(""));
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (parsedCount < commands.length) {
          const parsed = parseResp(buffer);
          if (!parsed) break;
          lastValue = parsed.value;
          buffer = buffer.subarray(parsed.next);
          parsedCount += 1;
        }
        if (parsedCount === commands.length && !settled) {
          settled = true;
          socket.end();
          resolve(lastValue);
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Valkey response error"));
      }
    });
    socket.on("error", fail);
  });
}

export async function evalRedis(script: string, keys: string[], args: string[]) {
  return redis(["EVAL", script, String(keys.length), ...keys, ...args]);
}
