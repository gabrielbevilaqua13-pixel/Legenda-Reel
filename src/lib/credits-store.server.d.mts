import type { DatabaseSync } from "node:sqlite";
export function database(): DatabaseSync;
export function digest(value: string | Buffer): string;
export function issuePack(payment: string): string;
export function redeem(wallet: string, code: string): string;
export function quote(
  db: DatabaseSync,
  wallet: string,
  network: string,
  video: string,
  seconds: number,
): { cost: number; available: number; allowed: boolean; free: boolean };
export function settle(
  wallet: string,
  network: string,
  video: string,
  seconds: number,
  expectedCost: number,
): void;
