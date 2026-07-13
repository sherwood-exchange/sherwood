// Client for the Sherwood Points service (on-chain-indexed shield points + referrals).
import { getAddress, type Address } from "viem";
import type { Connection } from "./wallet";
import type { NetworkConfig } from "./config";

export interface PointsInfo {
  address: string;
  points: number;
  breakdown: { shield: number; daily: number; streakBonus: number; referral: number };
  streak: number;
  shields: number;
  referrals: number;
  rank: number;
  referredBy: string | null;
}
export interface LeaderRow { rank: number; address: string; points: number; shields: number; streak: number }

const base = (net: NetworkConfig) => net.pointsUrl?.replace(/\/$/, "");

export async function fetchPoints(net: NetworkConfig, address: string): Promise<PointsInfo | null> {
  const b = base(net);
  if (!b) return null;
  try { const r = await fetch(`${b}/points/${address}`); return r.ok ? await r.json() : null; } catch { return null; }
}

export async function fetchLeaderboard(net: NetworkConfig, limit = 10): Promise<LeaderRow[]> {
  const b = base(net);
  if (!b) return [];
  try { const r = await fetch(`${b}/leaderboard?limit=${limit}`); return r.ok ? (await r.json()).leaderboard ?? [] : []; } catch { return []; }
}

/** Sign the referral opt-in with the connected wallet and register it. The referee's
 *  signature binds their address; the referrer is credited on the referee's first shield. */
export async function registerReferral(conn: Connection, net: NetworkConfig, referrer: string): Promise<{ ok: boolean; error?: string }> {
  const b = base(net);
  if (!b) return { ok: false, error: "no points service" };
  const message = `Sherwood Points — I was referred by ${getAddress(referrer as Address)}`;
  const signature = await conn.walletClient.signMessage({ account: conn.address, message });
  const res = await fetch(`${b}/referral`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ referee: conn.address, referrer, signature }) });
  const body = await res.json().catch(() => ({}));
  return res.ok ? { ok: true } : { ok: false, error: body.error ?? "failed" };
}

/** Persist a ?ref=<address> invite from the URL so it survives until the user connects. */
export function captureReferral(): void {
  try {
    const r = new URLSearchParams(location.search).get("ref");
    if (r && /^0x[0-9a-fA-F]{40}$/.test(r)) localStorage.setItem("sherwood:ref", getAddress(r as Address));
  } catch { /* ignore */ }
}

export function pendingReferral(selfAddress: string): string | null {
  try {
    const r = localStorage.getItem("sherwood:ref");
    return r && r.toLowerCase() !== selfAddress.toLowerCase() ? r : null;
  } catch { return null; }
}
export function clearReferral(): void { try { localStorage.removeItem("sherwood:ref"); } catch { /* */ } }
