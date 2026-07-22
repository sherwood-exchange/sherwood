// economyOS inventory keeper — monitors the RH-chain swap-execution inventory and reports when it
// needs a refill. The provider's exec wallet spends RH ETH to fulfil `sherwood_swap` jobs; revenue
// accrues as USDC on the Sherwood Exchange ACP wallet (Base). Those are on different chains, and the
// ACP signer is `restricted` (ACP-only) so it CANNOT auto-bridge — refills are a deliberate step.
//
//   npm run rebalance                    # report inventory + revenue + recommendation
//   npm run rebalance -- --bridge 3      # bridge 3 USDC Base→RH ETH into the exec wallet (needs
//                                        # REBALANCE_PRIVATE_KEY = a plain EOA on Base holding USDC+gas)
import "dotenv/config";
import { createPublicClient, createWalletClient, http, formatUnits, formatEther, parseUnits, getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RH_RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const RELAY = "https://api.relay.link";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const REVENUE_WALLET = (process.env.REVENUE_WALLET || "0x5e8f2599169a9f1d088165076aa323b6ce6623ce") as Address; // Sherwood Exchange (ACP)
const EXEC_ADDR = (process.env.EXEC_ADDRESS || (process.env.EXEC_PRIVATE_KEY ? privateKeyToAccount((process.env.EXEC_PRIVATE_KEY.startsWith("0x") ? process.env.EXEC_PRIVATE_KEY : `0x${process.env.EXEC_PRIVATE_KEY}`) as `0x${string}`).address : "0xab374DF89536baFeCC40a1730C5fF3e4Ca11b827")) as Address;

const AVG_SWAP_ETH = Number(process.env.SWAP_SIZE_ETH ?? "0.0005") + 0.00003; // size + ~gas
const MIN_ETH = Number(process.env.INVENTORY_MIN_ETH ?? "0.001");
const ERC20_BAL = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;

const rh = createPublicClient({ transport: http(RH_RPC) });
const base = createPublicClient({ transport: http(BASE_RPC) });

async function report() {
  const [execEth, revUsdc] = await Promise.all([
    rh.getBalance({ address: EXEC_ADDR }),
    base.readContract({ address: USDC_BASE, abi: ERC20_BAL, functionName: "balanceOf", args: [REVENUE_WALLET] }).catch(() => 0n) as Promise<bigint>,
  ]);
  const eth = Number(formatEther(execEth));
  const usdc = Number(formatUnits(revUsdc, 6));
  const swapsLeft = Math.floor(eth / AVG_SWAP_ETH);
  console.log(`\n── economyOS inventory ──`);
  console.log(`  exec wallet   : ${EXEC_ADDR}`);
  console.log(`  RH ETH (fuel) : ${eth.toFixed(6)} ETH  → ~${swapsLeft} swaps left`);
  console.log(`  revenue (Base): ${usdc.toFixed(4)} USDC @ ${REVENUE_WALLET.slice(0, 10)}…`);
  if (eth < MIN_ETH) {
    console.log(`  ⚠ LOW inventory (< ${MIN_ETH} ETH). Refill: bridge Base USDC → RH ETH into the exec wallet.`);
    console.log(`    • auto: npm run rebalance -- --bridge <usdc>   (needs REBALANCE_PRIVATE_KEY = EOA on Base w/ USDC+gas)`);
    console.log(`    • note: the ACP revenue wallet is restricted (ACP-only) → withdraw it to that EOA first, or loosen its policy.`);
  } else {
    console.log(`  ✓ inventory OK.`);
  }
  return { eth, usdc, swapsLeft };
}

/** Bridge `usdc` USDC from Base → native ETH on Robinhood Chain, delivered to the exec wallet, via Relay. */
async function bridge(usdc: string) {
  const pk = process.env.REBALANCE_PRIVATE_KEY;
  if (!pk) throw new Error("REBALANCE_PRIVATE_KEY not set — cannot bridge. (a plain EOA on Base holding USDC + gas)");
  const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`);
  const wallet = createWalletClient({ account, chain: { id: 8453, name: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [BASE_RPC] } } } as any, transport: http(BASE_RPC) });
  const body = {
    user: account.address, recipient: EXEC_ADDR, originChainId: 8453, destinationChainId: 4663,
    originCurrency: USDC_BASE, destinationCurrency: "0x0000000000000000000000000000000000000000",
    amount: parseUnits(usdc, 6).toString(), tradeType: "EXACT_INPUT",
  };
  const r = await fetch(`${RELAY}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.message ?? `Relay quote failed (${r.status})`);
  const out = j.details?.currencyOut;
  console.log(`  bridging ${usdc} USDC → ~${Number(formatUnits(BigInt(out?.amount ?? "0"), out?.currency?.decimals ?? 18)).toFixed(6)} ${out?.currency?.symbol ?? "ETH"} on RH → ${EXEC_ADDR}`);
  const txs: any[] = [];
  for (const step of j.steps ?? []) for (const item of step.items ?? []) if (item.data?.to) txs.push(item.data);
  if (!txs.length) throw new Error("Relay returned no executable step");
  for (const t of txs) {
    const hash = await wallet.sendTransaction({ to: t.to as Address, value: BigInt(t.value ?? "0"), data: (t.data ?? "0x") as `0x${string}` });
    console.log(`    sent ${hash}`);
    await base.waitForTransactionReceipt({ hash });
  }
  console.log(`  ✓ bridge submitted — funds arrive on RH shortly (requestId ${j.requestId ?? "?"}).`);
}

async function main() {
  const argv = process.argv.slice(2);
  const bi = argv.indexOf("--bridge");
  await report();
  if (bi >= 0 && argv[bi + 1]) { console.log(); await bridge(argv[bi + 1]); }
}
main().catch((e) => { console.error("rebalance error:", e?.message ?? e); process.exit(1); });
