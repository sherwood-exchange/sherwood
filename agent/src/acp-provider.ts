// economyOS ACP provider — fulfillment loop for the "Sherwood Live Quote & Economy Intel" offering.
// Polls ACP for jobs on the active agent (Sherwood Exchange), and drives each through the escrow
// lifecycle:  open → (set-budget) → budget_set → funded → (submit deliverable) → submitted → completed.
// The deliverable is computed live by economyOS's own functions (callByName) — never invented.
//
//   npm run acp:serve            # run the loop (needs an approved signer: acp agent add-signer)
//   npm run acp:serve -- --once  # single pass then exit (for testing)
//
// Requires the acp-cli to be authenticated + a signer approved in THIS environment.
import { spawnSync } from "node:child_process";
import { parseUnits, formatUnits } from "viem";
import { callByName } from "./economyos.js";
import { executeSwap, sendNativeEth } from "./sherwood-exec.js";
import { resolveToken, quotePublic } from "./quote.js";

const CLI = ["-y", "@virtuals-protocol/acp-cli@1.0.24"];
const PRICE = process.env.ACP_PRICE ?? "0.1";
const POLL_MS = Number(process.env.ACP_POLL_MS ?? 15000);

// requirements.action  →  economyOS function name. Extra keys in the payload are ignored per fn.
const ACTION_MAP: Record<string, string> = {
  quote: "get_live_quote",
  bridge_quote: "get_bridge_quote",
  swood_utility: "get_swood_utility",
  staking: "get_staking_stats",
  fee_tier: "get_fee_tier",
  governance: "get_governance",
  token_search: "get_token_universe",
  bridge_info: "get_bridge_info",
  explain: "explain_sherwood",
  portfolio: "get_portfolio",
  liquidity_check: "get_liquidity_check", // arg: symbol (optional)
  best_route: "get_best_route", // args: token_in, token_out, amount
};

// requirements.action → offering price (USDC). Matches the per-offering prices on the agent.
const ACTION_PRICE: Record<string, string> = {
  quote: "0.1", bridge_quote: "0.1",
  swood_utility: "0.05", staking: "0.05", fee_tier: "0.05",
  governance: "0.05", token_search: "0.05", bridge_info: "0.05", explain: "0.05",
  portfolio: "0.1",
  liquidity_check: "0.05", best_route: "0.1",
  swap_execute: process.env.SWAP_PRICE ?? "1", // executes a real Sherwood swap, delivers on RH
  // onramp is priced dynamically (see swapPrice) off the requested ETH size
};
// swap_execute sizing + dynamic pricing. Buyer may request `amount_eth` (clamped to SWAP_MAX_ETH);
// the price is the live USDC value of that ETH plus a margin, so the fee scales with the trade.
const SWAP_SIZE_ETH = process.env.SWAP_SIZE_ETH ?? "0.0005"; // default when buyer omits amount_eth
const SWAP_MAX_ETH = Number(process.env.SWAP_MAX_ETH ?? "0.002"); // inventory-safety cap per job
const SWAP_MARGIN = Number(process.env.SWAP_MARGIN ?? "0.05"); // 5% over delivered value

/** Clamp a requested ETH size to [0, SWAP_MAX_ETH]; fall back to the default. */
function swapSize(req: Record<string, any>): string {
  const v = Number(req.amount_eth ?? req.amount ?? SWAP_SIZE_ETH);
  if (!isFinite(v) || v <= 0) return SWAP_SIZE_ETH;
  return String(Math.min(v, SWAP_MAX_ETH));
}

/** Dynamic price (USDC, 2dp) for delivering `amountEth` worth of a token = live USD value × (1+margin). */
async function swapPrice(amountEth: string): Promise<string> {
  try {
    const [eth, usdg] = [await resolveToken("ETH"), await resolveToken("USDG")];
    const out = await quotePublic(eth, usdg, parseUnits(amountEth, 18));
    const usd = out ? Number(formatUnits(out, usdg.decimals)) : 0;
    if (usd > 0) return (Math.ceil(usd * (1 + SWAP_MARGIN) * 100) / 100).toFixed(2);
  } catch { /* fall through */ }
  return process.env.SWAP_PRICE ?? "1";
}

/** Run an acp-cli command with --json; return parsed JSON (last JSON line) or null. */
function acp(args: string[]): any {
  const r = spawnSync("npx", [...CLI, ...args, "--json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const out = (r.stdout || "") + "\n" + (r.stderr || "");
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{") || l.startsWith("["));
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch { /* keep scanning */ } }
  return null;
}

const idOf = (j: any) => j?.onChainJobId ?? j?.jobId ?? j?.id ?? j?.job_id;
// `acp job list` phase field is `jobStatus` (OPEN/…); `job history` uses `status`.
const phaseOf = (j: any) => String(j?.jobStatus ?? j?.status ?? j?.phase ?? j?.phaseName ?? j?.state ?? "").toLowerCase();
const chainOf = (j: any) => String(j?.chainId ?? "8453");

/** Pull the client's requirement payload from the job's on-chain history (entries[].content). */
function extractReq(id: string, chainId: string): Record<string, string> {
  const hist = acp(["job", "history", "--job-id", String(id), "--chain-id", String(chainId)]);
  const entries: any[] = hist?.entries ?? hist?.data?.entries ?? [];
  for (const e of entries) {
    let c = e?.content ?? e?.message ?? e?.memo;
    if (!c) continue;
    if (typeof c === "string") { try { c = JSON.parse(c); } catch { continue; } }
    if (c && typeof c === "object" && c.action) return c as Record<string, string>;
  }
  return { action: "explain" };
}

async function computeDeliverable(id: string, chainId: string): Promise<string> {
  const req = extractReq(id, chainId);
  const action = String(req.action);

  // Execution service: perform a REAL Sherwood swap on Robinhood Chain and deliver to the buyer.
  // Throws on failure so the loop does NOT submit — the funded job then expires and the escrow
  // refunds to the buyer (no deliverable = no payment for a swap that didn't happen).
  if (action === "swap_execute") {
    const tokenOut = String(req.token_out ?? req.token ?? "").trim();
    const recipient = String(req.recipient ?? "").trim();
    if (!tokenOut) throw new Error("swap_execute requires token_out");
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new Error("swap_execute requires a valid recipient 0x address");
    const size = swapSize(req);
    const { plan, swapTx } = await executeSwap({ inId: "ETH", outId: tokenOut, amount: size, recipient, slippagePct: Number(process.env.SWAP_SLIPPAGE ?? "1.5"), send: true });
    if (!swapTx) throw new Error("swap did not broadcast");
    return JSON.stringify({
      action, source: "https://sherwood.spot", tx: swapTx,
      result: `Executed on Robinhood Chain: ${plan.amountIn} ETH → ~${plan.expectedOut} ${plan.outSym} (min ${plan.minOut}), delivered to ${recipient}. tx ${swapTx}`,
    });
  }

  // On-ramp: deliver native ETH (gas) on Robinhood Chain from inventory. Throws on failure → no submit.
  if (action === "onramp") {
    const recipient = String(req.recipient ?? "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new Error("onramp requires a valid recipient 0x address");
    const size = swapSize(req);
    const { amount, tx } = await sendNativeEth({ recipient, amount: size, send: true });
    if (!tx) throw new Error("onramp did not broadcast");
    return JSON.stringify({ action, source: "https://sherwood.spot", tx, result: `Delivered ${amount} ETH (gas) to ${recipient} on Robinhood Chain. tx ${tx}` });
  }

  const fn = ACTION_MAP[action] ?? "explain_sherwood";
  let result: string;
  try { result = await callByName(fn, req); }
  catch (e: any) { result = `Could not compute (${e.message}). See https://sherwood.spot`; }
  return JSON.stringify({ action: req.action ?? "explain", result, source: "https://sherwood.spot" });
}

const seen = new Set<string>(); // jobId:phase we've already acted on

async function handle(job: any) {
  const id = idOf(job);
  if (id == null) return;
  const phase = phaseOf(job);
  const key = `${id}:${phase}`;
  if (seen.has(key)) return;

  const chainId = chainOf(job);
  if (/open|request|negotiat/.test(phase)) {
    seen.add(key);
    // Price by the requested action; swap_execute is priced dynamically off the requested ETH size.
    const req = extractReq(String(id), chainId);
    const price = (String(req.action) === "swap_execute" || String(req.action) === "onramp")
      ? await swapPrice(swapSize(req))
      : (ACTION_PRICE[String(req.action)] ?? PRICE);
    console.log(`[acp] job ${id} is ${phase} (action=${req.action ?? "?"}) → set-budget ${price} USDC`);
    const r = acp(["provider", "set-budget", "--job-id", String(id), "--amount", price, "--chain-id", chainId]);
    console.log(`[acp]   set-budget →`, r?.transactionHash ?? r?.success ?? JSON.stringify(r)?.slice(0, 200));
  } else if (/fund|transaction/.test(phase)) {
    seen.add(key);
    const deliverable = await computeDeliverable(String(id), chainId);
    console.log(`[acp] job ${id} is ${phase} → submit deliverable (${deliverable.slice(0, 120)}…)`);
    const r = acp(["provider", "submit", "--job-id", String(id), "--deliverable", deliverable, "--chain-id", chainId]);
    console.log(`[acp]   submit →`, r?.transactionHash ?? r?.success ?? JSON.stringify(r)?.slice(0, 200));
  } else {
    // budget_set (awaiting client fund), submitted, completed, rejected, expired — nothing for us to do
    if (!seen.has(key)) { seen.add(key); console.log(`[acp] job ${id} is ${phase} — waiting on the client / terminal.`); }
  }
}

async function pass() {
  const list = acp(["job", "list"]);
  const jobs: any[] = Array.isArray(list) ? list : (list?.data ?? list?.jobs ?? []);
  if (!jobs.length) { console.log(`[acp] no active jobs.`); return; }
  console.log(`[acp] ${jobs.length} active job(s).`);
  for (const j of jobs) { try { await handle(j); } catch (e: any) { console.error(`[acp] handle error:`, e.message); } }
}

const once = process.argv.includes("--once");
console.log(`[acp] economyOS provider loop — offering price ${PRICE} USDC, poll ${POLL_MS}ms${once ? " (single pass)" : ""}.`);
if (once) {
  await pass();
} else {
  // Never crash the loop; keep serving.
  for (;;) {
    try { await pass(); } catch (e: any) { console.error(`[acp] pass error:`, e.message); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
