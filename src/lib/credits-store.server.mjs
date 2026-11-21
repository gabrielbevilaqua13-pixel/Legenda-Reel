import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";

export const digest = (value) => createHash("sha256").update(value).digest("hex");
let connection;
export function database() {
  if (connection) return connection;
  const path = process.env.LEGENDA_CREDITS_DB;
  if (!path || !isAbsolute(path)) throw Error("Configure um caminho persistente para os créditos.");
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS wallets(id TEXT PRIMARY KEY, seconds INTEGER NOT NULL DEFAULT 0 CHECK(seconds>=0), trial INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS packs(payment TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, wallet TEXT);
    CREATE TABLE IF NOT EXISTS receipts(wallet TEXT, video TEXT, PRIMARY KEY(wallet,video));
    CREATE TABLE IF NOT EXISTS parts(wallet TEXT, hash TEXT, duration REAL NOT NULL, words TEXT NOT NULL, expires INTEGER, PRIMARY KEY(wallet,hash));
    CREATE INDEX IF NOT EXISTS parts_expiry ON parts(expires);
    CREATE TABLE IF NOT EXISTS trials(network TEXT PRIMARY KEY, last_used INTEGER NOT NULL);`);
  connection = db;
  return db;
}
export function atomic(fn) {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function issuePack(payment) {
  if (!/^[0-9]{1,40}$/.test(payment)) throw Error("Informe o ID numérico do pagamento aprovado.");
  return atomic((db) => {
    const existing = db.prepare("SELECT code FROM packs WHERE payment=?").get(payment);
    if (existing) return existing.code;
    const code = randomBytes(18).toString("hex");
    db.prepare("INSERT INTO packs(payment,code) VALUES(?,?)").run(payment, code);
    return code;
  });
}
export function redeem(wallet, code) {
  return atomic((db) => {
    const pack = db.prepare("SELECT wallet FROM packs WHERE code=?").get(code);
    if (!pack) throw Error("Código de pacote inválido.");
    if (pack.wallet) return pack.wallet;
    db.prepare("UPDATE wallets SET seconds=seconds+600 WHERE id=?").run(wallet);
    db.prepare("UPDATE packs SET wallet=? WHERE code=?").run(wallet, code);
    return wallet;
  });
}
export function quote(db, wallet, network, video, seconds) {
  const account = db.prepare("SELECT seconds,trial FROM wallets WHERE id=?").get(wallet);
  if (!account) throw Error("Reabra a página para recuperar seu saldo.");
  const recent = db
    .prepare("SELECT 1 FROM trials WHERE network=? AND last_used>?")
    .get(network, Date.now() - 86400000);
  const free = !!account.trial && !recent && seconds <= 60;
  const repeat = !!db
    .prepare("SELECT 1 FROM receipts WHERE wallet=? AND video=?")
    .get(wallet, video);
  const cost = repeat || free ? 0 : seconds;
  return {
    cost,
    available: account.seconds,
    allowed: cost <= account.seconds,
    free: free && !repeat,
  };
}
export function settle(wallet, network, video, seconds, expectedCost) {
  return atomic((db) => {
    const price = quote(db, wallet, network, video, seconds);
    if (!price.allowed || price.cost > expectedCost)
      throw Error("O saldo mudou. Confira o valor antes de tentar novamente.");
    if (price.free) {
      db.prepare("UPDATE wallets SET trial=0 WHERE id=?").run(wallet);
      db.prepare("INSERT OR REPLACE INTO trials VALUES(?,?)").run(network, Date.now());
    }
    db.prepare("UPDATE wallets SET seconds=seconds-? WHERE id=?").run(price.cost, wallet);
    db.prepare("INSERT OR IGNORE INTO receipts VALUES(?,?)").run(wallet, video);
  });
}
