// Sherwood Points service. Trustless indexer: attributes each on-chain shield
// (Deposit event) to the address that submitted it, and awards shield + daily-streak
// points. Referrals are a signed opt-in (the only non-derivable part). Private
// transfers/swaps are intentionally NOT tracked — that stays private.
//
//   GET  /health
//   GET  /info
//   GET  /points/<address>
//   GET  /leaderboard?limit=N
//   POST /referral   { referee, referrer, signature }
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createPublicClient, http, getAddress, isAddress, verifyMessage, type Address } from "viem";
import { config } from "./config.js";
import { SHERWOOD_ABI } from "../../client/src/abi.js";
import { load, save, ensure, pointsFor, leaderboard, rankOf, type State } from "./ledger.js";

const client = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });
const state: State = load();

/** Canonical message a referee signs to opt into a referral (binds their address). */
const referralMessage = (referrer: string) => `Sherwood Points — I was referred by ${getAddress(referrer)}`;

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
const dayOf = (tsSeconds: bigint) => new Date(Number(tsSeconds) * 1000).toISOString().slice(0, 10);

// ---- indexer ----
let indexing = false;
async function index(): Promise<void> {
  if (indexing) return;
  indexing = true;
  try {
    const from = BigInt(state.lastBlock) + 1n;
    // Page the scan in bounded windows — this RPC errors on wide getLogs ranges. The window
    // shrinks on failure and grows back on success.
    const head = await client.getBlockNumber({ cacheTime: 0 });
    const logs: any[] = [];
    for (let lo = from, span = 5000n; lo <= head; ) {
      let hi = lo + span - 1n;
      if (hi > head) hi = head;
      try {
        const part = await client.getContractEvents({ address: config.pool, abi: SHERWOOD_ABI, eventName: "Deposit", fromBlock: lo, toBlock: hi });
        logs.push(...(part as any[]));
        lo = hi + 1n;
        if (span < 5000n) span = span * 2n > 5000n ? 5000n : span * 2n;
      } catch (e) {
        if (span <= 1n) throw e;
        span = span / 2n;
      }
    }
    if (logs.length) {
      const txFrom = new Map<string, string>(); // txHash -> from
      const blkDay = new Map<string, string>(); // blockNumber -> UTC day
      const sorted = (logs as any[]).slice().sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
      for (const l of sorted) {
        const h = l.transactionHash as string;
        if (!txFrom.has(h)) txFrom.set(h, ((await client.getTransaction({ hash: h as `0x${string}` })).from as string).toLowerCase());
        const bn = (l.blockNumber as bigint).toString();
        if (!blkDay.has(bn)) blkDay.set(bn, dayOf((await client.getBlock({ blockNumber: l.blockNumber as bigint })).timestamp));
        const addr = txFrom.get(h)!;
        const a = ensure(state, addr);
        a.shields += 1;
        const day = blkDay.get(bn)!;
        if (!a.days.includes(day)) a.days.push(day);
        if (!a.firstBlock) a.firstBlock = Number(l.blockNumber);
        // settle a pending referral now that this referee has shielded
        const ref = state.pending[addr];
        if (ref && !a.referredBy && ref !== addr) {
          a.referredBy = ref;
          const r = ensure(state, ref);
          if (!r.referrals.includes(addr)) r.referrals.push(addr);
          delete state.pending[addr];
        }
      }
    }
    // advance cursor only to the highest block actually observed (avoid overshoot)
    let cursor = BigInt(state.lastBlock);
    for (const l of logs as any[]) if ((l.blockNumber as bigint) > cursor) cursor = l.blockNumber as bigint;
    if (cursor < from - 1n) cursor = from - 1n;
    // if nothing new, still bump toward head so we don't re-scan huge ranges forever
    if (!logs.length) { try { cursor = await client.getBlockNumber({ cacheTime: 0 }); } catch {} }
    state.lastBlock = cursor.toString();
    save(state);
  } catch (e: any) {
    console.error("[index] error:", e?.shortMessage ?? e?.message ?? e);
  } finally {
    indexing = false;
  }
}

// ---- referral registration ----
async function handleReferral(req: IncomingMessage, res: ServerResponse) {
  let body: any;
  try { body = await readBody(req); } catch { return json(res, 400, { error: "bad body" }); }
  const { referee, referrer, signature } = body ?? {};
  if (!isAddress(referee ?? "") || !isAddress(referrer ?? "") || typeof signature !== "string") return json(res, 400, { error: "referee, referrer, signature required" });
  const ref = getAddress(referrer).toLowerCase();
  const ree = getAddress(referee).toLowerCase();
  if (ref === ree) return json(res, 400, { error: "cannot refer yourself" });
  const a = state.addrs[ree];
  if (a?.referredBy) return json(res, 409, { error: "already referred" });
  let ok = false;
  try { ok = await verifyMessage({ address: getAddress(referee) as Address, message: referralMessage(referrer), signature: signature as `0x${string}` }); } catch { ok = false; }
  if (!ok) return json(res, 401, { error: "bad signature" });
  // if the referee already shielded, settle immediately; else park it as pending
  if (a && a.shields > 0 && !a.referredBy) {
    a.referredBy = ref;
    const r = ensure(state, ref);
    if (!r.referrals.includes(ree)) r.referrals.push(ree);
  } else {
    state.pending[ree] = ref;
  }
  save(state);
  return json(res, 200, { ok: true, settled: !!(a && a.shields > 0) });
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" });
    return res.end();
  }
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true });
  if (req.method === "GET" && path === "/info")
    return json(res, 200, { pool: config.pool, chainId: config.chainId, rules: config.rules, indexedBlock: state.lastBlock, users: Object.keys(state.addrs).length, referralMessage: referralMessage("0x0000000000000000000000000000000000000000") });
  if (req.method === "GET" && path === "/leaderboard") {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
    return json(res, 200, { leaderboard: leaderboard(state, limit), indexedBlock: state.lastBlock });
  }
  if (req.method === "GET" && path.startsWith("/points/")) {
    const addr = path.slice("/points/".length);
    if (!isAddress(addr)) return json(res, 400, { error: "invalid address" });
    const a = state.addrs[addr.toLowerCase()];
    if (!a) return json(res, 200, { address: getAddress(addr), points: 0, breakdown: { shield: 0, daily: 0, streakBonus: 0, referral: 0 }, streak: 0, shields: 0, referrals: 0, rank: 0, referredBy: null });
    const p = pointsFor(a);
    return json(res, 200, { address: getAddress(addr), points: p.total, breakdown: p.breakdown, streak: p.streak, shields: p.shields, referrals: p.referrals, rank: rankOf(state, addr), referredBy: a.referredBy ? getAddress(a.referredBy) : null });
  }
  if (req.method === "POST" && path === "/referral") return handleReferral(req, res);
  return json(res, 404, { error: "not found" });
});

server.listen(config.port, () => {
  console.log(`🍃 Sherwood points on :${config.port}  pool ${config.pool}  chain ${config.chainId}  from ${config.fromBlock}`);
  const tick = () => index().finally(() => setTimeout(tick, config.pollMs));
  tick();
});
