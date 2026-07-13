// Sherwood native swap EXECUTOR (Robinhood Chain) — the execution primitive behind the ACP
// `sherwood_swap` service. Given (tokenIn, tokenOut, amount, recipient) it resolves the deepest
// route (v2/v3/v4 via the ETH hub — reusing quote.ts), computes minOut at a slippage bound, and
// calls the same `AggRouter.swap(...)` the web app uses. Runs server-side from an EXEC wallet.
//
// SAFETY: `--send` actually broadcasts (spends real funds from EXEC_PRIVATE_KEY on RH chain).
// Without it the module DRY-RUNS: it quotes + prints the exact tx it WOULD send, and broadcasts
// nothing. Wire this into the ACP provider only after the exec wallet + bridging are set up.
//
//   npm run sherwood:swap -- --in ETH --out AAPL --amount 0.01 --recipient 0xabc…        # dry-run
//   npm run sherwood:swap -- --in USDG --out ETH --amount 5 --recipient 0xabc… --send     # broadcast
import "dotenv/config";
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, getAddress, encodeFunctionData, maxUint256, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pathToFileURL } from "node:url";
import { resolveToken, quotePublic, WETH, NATIVE, type Tok, type Spoke } from "./quote.js";

const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = 4663;
const AGG_ROUTER = (process.env.AGG_ROUTER || "0x01bfe0d5d43be24f2edf626bdd2ff41af5dc4e0c") as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const rh = { id: CHAIN_ID, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;

const SPOKE_C = [{ name: "kind", type: "uint8" }, { name: "pool", type: "address" }, { name: "fee", type: "uint24" }, { name: "ts", type: "int24" }, { name: "via", type: "address" }, { name: "pool2", type: "address" }] as const;
const AGG_ABI = [
  { type: "function", name: "swap", stateMutability: "payable", inputs: [
    { name: "tokenIn", type: "address" }, { name: "spokeIn", type: "tuple", components: SPOKE_C },
    { name: "tokenOut", type: "address" }, { name: "spokeOut", type: "tuple", components: SPOKE_C },
    { name: "amountIn", type: "uint256" }, { name: "minOut", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "recipient", type: "address" }],
    outputs: [{ type: "uint256" }] },
] as const;
const ERC20_ABI = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const isHub = (a: string) => a.toLowerCase() === WETH.toLowerCase() || a.toLowerCase() === NATIVE.toLowerCase();
const spokeArg = (t: Tok) => {
  const s = t.spoke as Spoke | null | undefined;
  if (!s) return { kind: 0, pool: ZERO, fee: 0, ts: 0, via: ZERO, pool2: ZERO };
  return { kind: s.kind, pool: (s.pool ?? ZERO) as Address, fee: s.fee, ts: s.ts, via: (s.via ?? ZERO) as Address, pool2: (s.pool2 ?? ZERO) as Address };
};

export interface SwapPlan {
  inSym: string; outSym: string; amountIn: string; expectedOut: string; minOut: string; slippagePct: number;
  recipient: string; router: string; value: string; needsApproval: boolean; txData: string;
}

/** Build (and optionally broadcast) a Sherwood AggRouter swap on Robinhood Chain. */
export async function executeSwap(o: { inId: string; outId: string; amount: string; recipient: string; slippagePct?: number; send?: boolean }): Promise<{ plan: SwapPlan; approveTx?: string; swapTx?: string }> {
  const pub = createPublicClient({ chain: rh as any, transport: http(RPC) });
  const tin = await resolveToken(o.inId);
  const tout = await resolveToken(o.outId);
  const amountIn = parseUnits(String(o.amount), tin.decimals);
  const recipient = getAddress(o.recipient);
  const slip = o.slippagePct ?? 1;

  const out = await quotePublic(tin, tout, amountIn);
  if (out === null || out === 0n) throw new Error(`no route/liquidity for ${tin.symbol}->${tout.symbol}`);
  const minOut = out - (out * BigInt(Math.round(slip * 100)) / 10000n);
  const nativeIn = isHub(tin.address) && tin.address.toLowerCase() === NATIVE.toLowerCase();
  const value = nativeIn ? amountIn : 0n;
  const deadline = BigInt(Math.floor(Number(process.env.NOW_SECONDS ?? "0")) || Math.floor(Date.now() / 1000) + 1800);

  const txData = encodeFunctionData({ abi: AGG_ABI, functionName: "swap",
    args: [tin.address, spokeArg(tin) as any, tout.address, spokeArg(tout) as any, amountIn, minOut, deadline, recipient] });

  // approval needed only for ERC20 inputs (native ETH is sent as value)
  let needsApproval = false;
  const plan: SwapPlan = {
    inSym: tin.symbol, outSym: tout.symbol,
    amountIn: formatUnits(amountIn, tin.decimals), expectedOut: formatUnits(out, tout.decimals), minOut: formatUnits(minOut, tout.decimals),
    slippagePct: slip, recipient, router: AGG_ROUTER, value: formatUnits(value, 18), needsApproval, txData,
  };

  if (!o.send) return { plan };

  // ---- broadcast path (spends real funds) ----
  const pk = process.env.EXEC_PRIVATE_KEY;
  if (!pk) throw new Error("EXEC_PRIVATE_KEY not set — cannot broadcast. (dry-run only)");
  const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`);
  const wallet = createWalletClient({ account, chain: rh as any, transport: http(RPC) });

  let approveTx: string | undefined;
  if (!nativeIn) {
    const allow = (await pub.readContract({ address: tin.address, abi: ERC20_ABI, functionName: "allowance", args: [account.address, AGG_ROUTER] })) as bigint;
    if (allow < amountIn) {
      approveTx = await wallet.writeContract({ address: tin.address, abi: ERC20_ABI, functionName: "approve", args: [AGG_ROUTER, maxUint256] });
      await pub.waitForTransactionReceipt({ hash: approveTx as `0x${string}` });
    }
  }
  plan.needsApproval = !!approveTx;
  const swapTx = await wallet.writeContract({ address: AGG_ROUTER, abi: AGG_ABI, functionName: "swap",
    args: [tin.address, spokeArg(tin) as any, tout.address, spokeArg(tout) as any, amountIn, minOut, deadline, recipient], value });
  return { plan, approveTx, swapTx };
}

/** RH gas on-ramp: send native ETH from the exec wallet to `recipient` on Robinhood Chain. */
export async function sendNativeEth(o: { recipient: string; amount: string; send?: boolean }): Promise<{ amount: string; recipient: string; tx?: string }> {
  const recipient = getAddress(o.recipient);
  const value = parseUnits(String(o.amount), 18);
  if (!o.send) return { amount: formatUnits(value, 18), recipient };
  const pk = process.env.EXEC_PRIVATE_KEY;
  if (!pk) throw new Error("EXEC_PRIVATE_KEY not set — cannot broadcast.");
  const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`);
  const pub = createPublicClient({ chain: rh as any, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: rh as any, transport: http(RPC) });
  const tx = await wallet.sendTransaction({ to: recipient, value });
  await pub.waitForTransactionReceipt({ hash: tx });
  return { amount: formatUnits(value, 18), recipient, tx };
}

// ---- CLI ----
const argv = process.argv.slice(2);
const opt = (n: string, d = "") => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
async function main() {
  const inId = opt("in"), outId = opt("out"), amount = opt("amount"), recipient = opt("recipient");
  const send = argv.includes("--send");
  if (!inId || !outId || !amount || !recipient) {
    console.log('Usage: npm run sherwood:swap -- --in ETH --out AAPL --amount 0.01 --recipient 0x… [--slippage 1] [--send]');
    process.exit(1);
  }
  const r = await executeSwap({ inId, outId, amount, recipient, slippagePct: Number(opt("slippage", "1")), send });
  const p = r.plan;
  console.log(`\n${send ? "▶ EXECUTED" : "◇ DRY-RUN"}  ${p.amountIn} ${p.inSym} → ${p.outSym}`);
  console.log(`  expected out : ${p.expectedOut} ${p.outSym}`);
  console.log(`  minOut (${p.slippagePct}%): ${p.minOut} ${p.outSym}`);
  console.log(`  recipient    : ${p.recipient}`);
  console.log(`  router       : ${p.router}   value: ${p.value} ETH`);
  if (!send) { console.log(`  txData       : ${p.txData.slice(0, 42)}…  (not broadcast)`); }
  else { console.log(`  approveTx    : ${r.approveTx ?? "(none)"}`); console.log(`  swapTx       : ${r.swapTx}`); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("sherwood-exec error:", e?.message ?? e); process.exit(1); });
}
