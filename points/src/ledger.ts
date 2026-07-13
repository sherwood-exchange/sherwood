// Points ledger: persistent state + the points formula. All shield/streak points are
// derived purely from on-chain Deposit events; referrals need a signed opt-in.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

export interface AddrState {
  shields: number; // number of shields (Deposit events) attributed to this address
  days: string[]; // distinct UTC 'YYYY-MM-DD' on which this address shielded
  firstBlock: number;
  referredBy?: string; // referrer address (set once the referee has shielded)
  referrals: string[]; // addresses this address successfully referred
}

export interface State {
  lastBlock: string; // bigint as string
  addrs: Record<string, AddrState>; // key = lowercased address
  pending: Record<string, string>; // referee(lower) -> referrer(lower), verified sig, awaiting first shield
}

export function emptyState(): State {
  return { lastBlock: (config.fromBlock - 1n).toString(), addrs: {}, pending: {} };
}

export function load(): State {
  try {
    return { ...emptyState(), ...JSON.parse(readFileSync(config.dataFile, "utf8")) };
  } catch {
    return emptyState();
  }
}

export function save(s: State): void {
  mkdirSync(dirname(config.dataFile), { recursive: true });
  writeFileSync(config.dataFile, JSON.stringify(s));
}

export function ensure(s: State, addr: string): AddrState {
  const k = addr.toLowerCase();
  if (!s.addrs[k]) s.addrs[k] = { shields: 0, days: [], firstBlock: 0, referrals: [] };
  return s.addrs[k];
}

/** Longest run of consecutive UTC days ending at the most recent active day. */
export function currentStreak(days: string[]): number {
  if (!days.length) return 0;
  const set = new Set(days);
  const sorted = [...set].sort();
  let last = sorted[sorted.length - 1];
  let streak = 1;
  for (;;) {
    const prev = new Date(last + "T00:00:00Z");
    prev.setUTCDate(prev.getUTCDate() - 1);
    const key = prev.toISOString().slice(0, 10);
    if (set.has(key)) { streak++; last = key; } else break;
  }
  return streak;
}

export interface Breakdown {
  shield: number;
  daily: number;
  streakBonus: number;
  referral: number;
}

export function pointsFor(a: AddrState): { total: number; breakdown: Breakdown; streak: number; shields: number; referrals: number } {
  const r = config.rules;
  const distinctDays = new Set(a.days).size;
  const streak = currentStreak(a.days);
  const shield = a.shields * r.shield;
  const daily = distinctDays * r.day;
  const streakBonus = streak >= 7 ? r.weekStreakBonus : 0;
  const referral = a.referrals.length * r.referrer + (a.referredBy ? r.referee : 0);
  return {
    total: shield + daily + streakBonus + referral,
    breakdown: { shield, daily, streakBonus, referral },
    streak,
    shields: a.shields,
    referrals: a.referrals.length,
  };
}

export function leaderboard(s: State, limit = 50): { rank: number; address: string; points: number; shields: number; streak: number }[] {
  const rows = Object.entries(s.addrs)
    .map(([address, a]) => ({ address, ...pointsFor(a) }))
    .filter((r) => r.total > 0)
    .sort((x, y) => y.total - x.total || y.shields - x.shields);
  return rows.slice(0, limit).map((r, i) => ({ rank: i + 1, address: r.address, points: r.total, shields: r.shields, streak: r.streak }));
}

export function rankOf(s: State, addr: string): number {
  const k = addr.toLowerCase();
  const all = Object.entries(s.addrs)
    .map(([address, a]) => ({ address, total: pointsFor(a).total }))
    .filter((r) => r.total > 0)
    .sort((x, y) => y.total - x.total);
  const idx = all.findIndex((r) => r.address === k);
  return idx < 0 ? 0 : idx + 1;
}
