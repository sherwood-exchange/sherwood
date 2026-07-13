// Sherwood ASP auto-approver.
//
// Watches on-chain Deposit events, rebuilds the association set (all deposit labels, in
// emission order — the same construction the SDK client uses), and publishes its Merkle
// root via setAssociationRoot whenever it differs from the on-chain root. This makes new
// deposits spendable within seconds without anyone clicking "Approve deposits".
//
// It runs a full scan from POINTS_FROM_BLOCK on every tick (no cache), so — unlike a
// warm-started browser client — its association set is always complete and it never
// publishes an empty root.
//
// Env: RPC_URL, CHAIN_ID, POOL_ADDRESS, POINTS_FROM_BLOCK (or ASP_FROM_BLOCK),
//      ASP_PRIVATE_KEY (the pool's ASP/owner key), ASP_INTERVAL_SECONDS (default 15).
import { createServer } from "node:http";
import { createPublicClient, createWalletClient, http, defineChain, parseAbiItem, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { initPoseidon, AssociationSet } from "../../client/src/index.js";

const RPC_URL = process.env.RPC_URL as string;
const CHAIN_ID = Number(process.env.CHAIN_ID || 4663);
const POOL = getAddress(process.env.POOL_ADDRESS as string);
const FROM_BLOCK = BigInt(process.env.POINTS_FROM_BLOCK || process.env.ASP_FROM_BLOCK || "0");
const KEY = process.env.ASP_PRIVATE_KEY || "";
const INTERVAL = Number(process.env.ASP_INTERVAL_SECONDS || 15) * 1000;
const HAVE_KEY = /^0x[0-9a-fA-F]{64}$/.test(KEY);

const ABI = [
  { type: "function", name: "associationRoot", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "setAssociationRoot", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "asp", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const DEPOSIT = parseAbiItem("event Deposit(uint256 indexed label, uint256 commitmentIndex)");

const chain = defineChain({ id: CHAIN_ID, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
const transport = http(RPC_URL);
const pc = createPublicClient({ chain, transport });
const account = HAVE_KEY ? privateKeyToAccount(KEY as `0x${string}`) : null;
const wc = account ? createWalletClient({ account, chain, transport }) : null;

async function localRoot(): Promise<bigint> {
  // Page the scan in bounded windows — this RPC errors on wide getLogs ranges. The window
  // shrinks on failure and grows back on success.
  const head = await pc.getBlockNumber();
  const logs: any[] = [];
  for (let lo = FROM_BLOCK, span = 5000n; lo <= head; ) {
    let hi = lo + span - 1n;
    if (hi > head) hi = head;
    try {
      const part = await pc.getLogs({ address: POOL, event: DEPOSIT, fromBlock: lo, toBlock: hi });
      logs.push(...part);
      lo = hi + 1n;
      if (span < 5000n) span = span * 2n > 5000n ? 5000n : span * 2n;
    } catch (e) {
      if (span <= 1n) throw e;
      span = span / 2n;
    }
  }
  logs.sort((a, b) => (a.blockNumber === b.blockNumber ? Number(a.logIndex! - b.logIndex!) : a.blockNumber! < b.blockNumber! ? -1 : 1));
  const assoc = new AssociationSet();
  for (const l of logs) assoc.add(l.args.label as bigint);
  return assoc.root();
}

async function tick(): Promise<void> {
  try {
    const [onchain, local] = await Promise.all([
      pc.readContract({ address: POOL, abi: ABI, functionName: "associationRoot" }) as Promise<bigint>,
      localRoot(),
    ]);
    if (onchain === local) return; // in sync, nothing to publish
    if (!account || !wc) { console.warn("pending deposits to approve, but ASP_PRIVATE_KEY is not set — idle"); return; }
    const asp = (await pc.readContract({ address: POOL, abi: ABI, functionName: "asp" })) as `0x${string}`;
    if (asp.toLowerCase() !== account.address.toLowerCase()) {
      console.error(`key ${account.address} is not the pool ASP (${asp}); cannot publish`);
      return;
    }
    const head = await pc.getBlock({ blockTag: "latest" });
    const fee = head.baseFeePerGas != null ? { maxFeePerGas: head.baseFeePerGas * 2n, maxPriorityFeePerGas: 0n } : {};
    const hash = await wc.writeContract({ address: POOL, abi: ABI, functionName: "setAssociationRoot", args: [local], ...fee });
    await pc.waitForTransactionReceipt({ hash });
    console.log(`published association root ${local} (was ${onchain})  tx ${hash}`);
  } catch (e: any) {
    console.error("tick error:", e?.shortMessage ?? e?.message ?? e);
  }
}

async function main(): Promise<void> {
  await initPoseidon();
  createServer((req, res) => {
    if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); }
    else { res.writeHead(404); res.end(); }
  }).listen(8792, () => console.log("health on :8792"));
  console.log(`ASP auto-approver up. pool ${POOL} chain ${CHAIN_ID} from ${FROM_BLOCK} every ${INTERVAL / 1000}s ${HAVE_KEY ? `key ${account!.address}` : "(NO KEY — idle until ASP_PRIVATE_KEY is set)"}`);
  for (;;) { await tick(); await new Promise((r) => setTimeout(r, INTERVAL)); }
}
main();
