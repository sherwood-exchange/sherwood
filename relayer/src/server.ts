// Sherwood relayer HTTP service.
//
//   POST /transact   { proof, extData }  (wire-serialized BuiltTx)
//     -> validates binding + fee + sanctions, simulates, submits from the hot
//        wallet, waits for the receipt, returns { txHash, status, blockNumber }.
//   GET  /info        -> { relayer, pool, chainId, minFee }
//   GET  /health      -> { ok: true }
//
// The relayer CANNOT steal funds: every param the user cares about is bound into
// the proof via extDataHash, so tampering invalidates the proof. It can only
// censor or observe the public legs — which is the accepted MVP trust model.

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createPublicClient, createWalletClient, http, getAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";
import { screenAddress } from "./screen.js";
import { handleXchain } from "./xchain.js";
import { SHERWOOD_ABI } from "../../client/src/abi.js";
import { deserializeBuiltTx } from "../../client/src/serde.js";
import { extDataHash } from "../../client/src/extdata.js";
import { FIELD_SIZE, mod } from "../../client/src/config.js";

const account = privateKeyToAccount(config.relayerKey);
const transport = http(config.rpcUrl);
const publicClient = createPublicClient({ chain: config.chain, transport });
const walletClient = createWalletClient({ account, chain: config.chain, transport });

function json(res: ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(s);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/** Full validation of an incoming BuiltTx before we spend gas on it. */
async function validate(tx: ReturnType<typeof deserializeBuiltTx>): Promise<string | null> {
  const { proof, extData } = tx;

  // 1. binding: recompute extDataHash from extData and match the proof
  if (extDataHash(extData) !== proof.extDataHash) return "extDataHash mismatch";

  // 2. publicAmount = (extAmount - fee) mod FIELD, matches the proof
  if (mod(extData.extAmount - extData.fee, FIELD_SIZE) !== proof.publicAmount) return "publicAmount mismatch";

  // 3. publicAsset matches
  if (BigInt(getAddress("0x" + extData.assetId.toString(16).padStart(40, "0"))) !== proof.publicAsset) {
    return "publicAsset mismatch";
  }

  // 4. fee policy — relayer must be us and fee must clear the floor
  if (getAddress(extData.relayer) !== getAddress(account.address)) return "relayer is not this service";
  if (extData.fee < config.minFee) return `fee below minimum (${config.minFee})`;

  // 5. sanctions screen the unshield RECIPIENT — the only clear address that
  // actually receives value. (I-1: we no longer "screen" extData.tokenOut; a swap's
  // output *token contract* is not a sanctionable party, so that check had no
  // compliance meaning and only added latency.)
  const unshieldScreen = await screenAddress(extData.recipient);
  if (!unshieldScreen.ok) return unshieldScreen.reason ?? "recipient screening failed";

  return null;
}

async function handleTransact(req: IncomingMessage, res: ServerResponse) {
  const limited = rateLimit(req, Date.now());
  if (limited) return json(res, 429, { error: "rate limited", detail: limited });
  let tx;
  try {
    tx = deserializeBuiltTx(await readBody(req));
  } catch (e: any) {
    return json(res, 400, { error: "bad request body", detail: String(e?.message ?? e) });
  }

  let invalid: string | null;
  try {
    invalid = await validate(tx);
  } catch (e: any) {
    // Malformed address / non-canonical assetId / transient RPC error inside
    // validate() must fail cleanly, not hang the request as an unhandled rejection.
    return json(res, 400, { error: "validation error", detail: shortError(e) });
  }
  if (invalid) return json(res, 400, { error: "validation failed", detail: invalid });

  // simulate before spending gas; surfaces the exact revert reason to the client
  try {
    await publicClient.simulateContract({
      address: config.pool,
      abi: SHERWOOD_ABI,
      functionName: "transact",
      args: [tx.proof as any, tx.extData as any],
      account,
    });
  } catch (e: any) {
    const detail = shortError(e);
    console.error("simulation reverted:", detail, e?.metaMessages ?? "");
    return json(res, 400, { error: "simulation reverted", detail });
  }

  try {
    // Fast L2 with a moving base fee: give a 2x base-fee buffer so the tx isn't rejected
    // with "max fee per gas less than block base fee" if the base fee ticks up. Priority 0.
    const head = await publicClient.getBlock({ blockTag: "latest" });
    const feeOverride = head.baseFeePerGas != null
      ? { maxFeePerGas: head.baseFeePerGas * 2n, maxPriorityFeePerGas: 0n }
      : {};
    const hash = await walletClient.writeContract({
      address: config.pool,
      abi: SHERWOOD_ABI,
      functionName: "transact",
      args: [tx.proof as any, tx.extData as any],
      ...feeOverride,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return json(res, 200, { txHash: hash, status: receipt.status, blockNumber: receipt.blockNumber });
  } catch (e: any) {
    return json(res, 502, { error: "submission failed", detail: shortError(e) });
  }
}

// Tiny native-ETH gas seed for the Private Bridge's ephemeral address. A fresh EOA that
// receives an unshield has no gas to submit the bridge tx; seeding it from the relayer (an
// address unlinkable to the user) preserves the privacy. Rate-limited + only funds a near-empty
// address, so it can't be drained. Amount is a fraction of a cent on this cheap L2.
const GAS_SEED = parseEther("0.0006"); // covers the ephemeral address's 2 txs (unwrap/approve + Relay deposit)
async function handleFundGas(req: IncomingMessage, res: ServerResponse) {
  const limited = rateLimit(req, Date.now());
  if (limited) return json(res, 429, { error: "rate limited", detail: limited });
  let body: any;
  try { body = await readBody(req); } catch (e: any) { return json(res, 400, { error: "bad request body", detail: String(e?.message ?? e) }); }
  let to: `0x${string}`;
  try { to = getAddress(body.address); } catch { return json(res, 400, { error: "bad address" }); }
  try {
    // anti-drain: only fund an address that can't already pay for the bridge tx
    const bal = await publicClient.getBalance({ address: to });
    if (bal >= GAS_SEED) return json(res, 200, { funded: false, reason: "already funded" });
    const head = await publicClient.getBlock({ blockTag: "latest" });
    const feeOverride = head.baseFeePerGas != null ? { maxFeePerGas: head.baseFeePerGas * 2n, maxPriorityFeePerGas: 0n } : {};
    const hash = await walletClient.sendTransaction({ to, value: GAS_SEED, ...feeOverride });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return json(res, 200, { funded: true, txHash: hash, amount: GAS_SEED.toString(), status: receipt.status });
  } catch (e: any) {
    return json(res, 502, { error: "fund failed", detail: shortError(e) });
  }
}

function shortError(e: any): string {
  // Dig through viem's error chain for the actual on-chain revert reason (a require()
  // string or custom-error name) rather than the generic "transact reverted" wrapper.
  const c = e?.cause;
  const parts = [
    c?.reason, c?.data?.errorName, c?.shortMessage,
    e?.shortMessage, e?.details, e?.message,
  ].filter(Boolean);
  const metas = Array.isArray(e?.metaMessages) ? e.metaMessages.join(" ") : "";
  return `${parts[0] ?? String(e)}${metas ? ` — ${metas}` : ""}`.slice(0, 400);
}

// In-memory sliding-window rate limiter for /transact (the only gas-spending route).
// Per-IP and global caps; on a public endpoint these bound gas-drain / griefing.
const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();
const globalHits: number[] = [];
function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const v = Array.isArray(xff) ? xff[xff.length - 1] : xff;
    if (v) {
      // Use the RIGHTMOST entry — the one OUR reverse proxy appended (the real peer
      // it saw). The leftmost is client-controlled and trivially spoofable, which
      // would let one attacker impersonate many IPs and bypass the per-IP limit.
      const parts = v.split(",");
      return parts[parts.length - 1].trim();
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}
/** Returns null if allowed, or a reason string if rate-limited. */
function rateLimit(req: IncomingMessage, now: number): string | null {
  const prune = (arr: number[]) => { while (arr.length && arr[0] <= now - WINDOW_MS) arr.shift(); };
  prune(globalHits);
  if (globalHits.length >= config.rateGlobalPerMin) return "global rate limit";
  const ip = clientIp(req);
  const arr = hits.get(ip) ?? [];
  prune(arr);
  if (arr.length >= config.ratePerMin) return "per-IP rate limit";
  arr.push(now); hits.set(ip, arr); globalHits.push(now);
  return null;
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-user-timezone",
    });
    return res.end();
  }
  if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
  if (req.method === "GET" && req.url === "/info") {
    return json(res, 200, { relayer: account.address, pool: config.pool, chainId: config.chainId, minFee: config.minFee });
  }
  if (req.method === "POST" && req.url === "/transact") return handleTransact(req, res);
  if (req.method === "POST" && req.url === "/fund-gas") return handleFundGas(req, res);
  // cross-chain private on/off-ramp proxy (Houdini/AnySwap keys stay server-side)
  if ((req.url ?? "").startsWith("/xchain/")) {
    const limited = rateLimit(req, Date.now());
    if (limited) return json(res, 429, { error: "rate limited", detail: limited });
    if (await handleXchain(req, res, clientIp(req))) return;
  }
  return json(res, 404, { error: "not found" });
});

server.listen(config.port, () => {
  console.log(`🌲 Sherwood relayer on :${config.port}`);
  console.log(`   relayer ${account.address}  pool ${config.pool}  chain ${config.chainId}  minFee ${config.minFee}`);
  console.log(`   rate: ${config.ratePerMin}/min per IP, ${config.rateGlobalPerMin}/min global  trustProxy ${config.trustProxy}`);
});
