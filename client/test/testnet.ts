// Live test against Robinhood Chain TESTNET with real Groth16 proofs.
// Flow: shield -> ASP approve -> private transfer -> unshield, using one of the
// allowlisted tokens the deployer holds. Swap is skipped (no known testnet DEX).
//
// Prereq: `.env` has DEPLOYER_PRIVATE_KEY + RPC_URL + CHAIN_ID + ASSETS, and
// `deploy/testnet.json` exists (run `npm run testnet:deploy` first). The deployer
// needs testnet ETH for gas and a balance of at least one allowlisted token.
//
// Run: npm run testnet:test

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, defineChain, getAddress, formatUnits, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toBytes } from "viem";
import { initPoseidon } from "../src/poseidon.js";
import { Keypair } from "../src/keypair.js";
import { SherwoodClient, type BuiltTx } from "../src/pool.js";
import { AssociationSet } from "../src/assoc.js";
import { SHERWOOD_ABI, ERC20_ABI } from "../src/abi.js";
import { nodeArtifacts } from "../src/artifacts.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const file of [".env", ".env.local"]) {
    const path = resolve(ROOT, file);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const v = m[2].replace(/\s+#.*$/, "").trim();
      if (v) env[m[1]] = v; // .env.local overrides .env
    }
  }
  if (env.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  return env;
}

async function main() {
  const env = loadEnv();
  const rpc = env.RPC_URL;
  const chainId = Number(env.CHAIN_ID || 46630);
  const pk = env.DEPLOYER_PRIVATE_KEY as `0x${string}`;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("DEPLOYER_PRIVATE_KEY missing/invalid in .env");

  const dep = JSON.parse(readFileSync(resolve(ROOT, "deploy/testnet.json"), "utf8"));
  const pool = getAddress(dep.pool) as Address;
  const assets: Address[] = (dep.assets as string[]).map((a) => getAddress(a) as Address);

  const chain = defineChain({
    id: chainId,
    name: "Robinhood Chain Testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: { default: { name: "Blockscout", url: "https://explorer.testnet.chain.robinhood.com" } },
    testnet: true,
  });
  const transport = http(rpc);
  const publicClient = createPublicClient({ chain, transport });
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({ account, chain, transport });
  const explorer = (h: string) => `https://explorer.testnet.chain.robinhood.com/tx/${h}`;

  await initPoseidon();

  // shielded accounts derived from signatures/keys (never leave this process)
  const alice = Keypair.fromSeed(toBytes(keccak256(toBytes(pk))));
  const bob = Keypair.fromSeed(toBytes(keccak256(toBytes(pk + "01"))));
  const bobAddr = { pubKey: bob.pubKey, viewPub: bob.viewPub };

  const assoc = new AssociationSet();
  // fromBlock = the pool's first-event block (recorded at deploy). The client must
  // replay every existing leaf to rebuild the exact on-chain tree, so this must be
  // <= the first NewCommitment; scanning from 0 also works but is needlessly slow.
  const opts = { publicClient, pool, artifacts: nodeArtifacts, associationSet: assoc, fromBlock: BigInt(dep.fromBlock ?? 0) };
  const aliceClient = new SherwoodClient({ ...opts, keypair: alice, sender: account.address });
  const bobClient = new SherwoodClient({ ...opts, keypair: bob });

  const submit = async (tx: BuiltTx, label: string) => {
    const hash = await wallet.writeContract({ address: pool, abi: SHERWOOD_ABI, functionName: "transact", args: [tx.proof as any, tx.extData as any] });
    console.log(`   ${label} → ${explorer(hash)}`);
    const r = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(r.status, "success", `${label} reverted`);
  };
  // RPC nodes behind the load balancer can lag a block right after a receipt, so a
  // single sync may miss the newest events — retry before declaring a mismatch.
  const syncUntilBalance = async (client: SherwoodClient, tok: Address, expected: bigint, label: string) => {
    for (let i = 0; ; i++) {
      client.invalidate();
      await client.sync();
      if (client.balance(tok) === expected) return;
      if (i >= 9) assert.equal(client.balance(tok), expected, label);
      await new Promise((r) => setTimeout(r, 3000));
    }
  };
  const depositFromBlock = BigInt(dep.fromBlock ?? 0);
  const fetchDeposits = async (minCount: number) => {
    // A lagging load-balanced backend can return an incomplete Deposit set right after
    // a shield; publishing a root that omits the fresh label would make the following
    // transfer fail its membership proof. Retry until the expected deposit is indexed.
    for (let i = 0; ; i++) {
      const logs = await publicClient.getContractEvents({ address: pool, abi: SHERWOOD_ABI, eventName: "Deposit", fromBlock: depositFromBlock, toBlock: "latest" });
      if (logs.length >= minCount || i >= 9) return logs as any[];
      await new Promise((r) => setTimeout(r, 3000));
    }
  };
  const aspApproveAll = async (minCount: number) => {
    const logs = await fetchDeposits(minCount);
    for (const l of logs) assoc.add(l.args.label as bigint);
    const hash = await wallet.writeContract({ address: pool, abi: SHERWOOD_ABI, functionName: "setAssociationRoot", args: [assoc.root()] });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`   ASP set associationRoot (${logs.length} approved deposits) → ${explorer(hash)}`);
  };

  // sanity: gas + pool
  const ethBal = await publicClient.getBalance({ address: account.address });
  console.log(`Deployer ${account.address}  gas ${formatUnits(ethBal, 18)} ETH  pool ${pool}`);
  if (ethBal === 0n) throw new Error("deployer has 0 testnet ETH — fund it at https://faucet.testnet.chain.robinhood.com");

  // pick an allowlisted token the deployer actually holds (TOKEN=0x… to force one,
  // e.g. an asset added post-deploy like WETH that isn't in the deploy record)
  const candidates: Address[] = env.TOKEN ? [getAddress(env.TOKEN) as Address] : assets;
  let token: Address | null = null;
  let dec = 18;
  let bal = 0n;
  for (const t of candidates) {
    const b = (await publicClient.readContract({ address: t, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] })) as bigint;
    if (b > 0n) {
      token = t;
      bal = b;
      dec = (await publicClient.readContract({ address: t, abi: ERC20_ABI, functionName: "decimals" })) as number;
      break;
    }
  }
  if (!token) throw new Error(`deployer holds no balance of: ${candidates.join(", ")}`);
  const amount = bal; // shield the full balance, then move it around
  console.log(`Using token ${token} (balance ${formatUnits(bal, dec)}), shielding it all.\n`);

  // approve + shield
  const alw = (await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [account.address, pool] })) as bigint;
  if (alw < amount) {
    const h = await wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: "approve", args: [pool, 2n ** 256n - 1n] });
    await publicClient.waitForTransactionReceipt({ hash: h });
  }
  // Capture pre-existing shielded balances so assertions are deltas — the pool is
  // shared and these deterministic accounts may hold change notes from prior runs.
  await aliceClient.sync();
  await bobClient.sync();
  const aliceStart = aliceClient.balance(token);
  const bobStart = bobClient.balance(token);
  const depsBefore = (await fetchDeposits(0)).length; // existing approved deposits

  console.log("1) SHIELD");
  await submit(await aliceClient.buildShield(token, amount), "shield");
  await syncUntilBalance(aliceClient, token, aliceStart + amount, "shielded balance mismatch");

  console.log("2) ASP APPROVE (screen the deposit label, publish root)");
  await aspApproveAll(depsBefore + 1); // wait until this shield's Deposit is indexed
  aliceClient.invalidate();
  await aliceClient.sync();

  const half = amount / 2n;
  console.log("3) PRIVATE TRANSFER (Alice → Bob, proves label membership)");
  await submit(await aliceClient.buildTransfer(token, half, bobAddr), "transfer");
  await syncUntilBalance(bobClient, token, bobStart + half, "bob balance mismatch");

  console.log("4) UNSHIELD (Bob → deployer clear address)");
  const quarter = half / 2n;
  const before = (await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] })) as bigint;
  await submit(await bobClient.buildUnshield(token, quarter, account.address), "unshield");
  let after = before;
  for (let i = 0; i < 10 && after - before !== quarter; i++) {
    after = (await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] })) as bigint;
    if (after - before !== quarter) await new Promise((r) => setTimeout(r, 3000));
  }
  assert.equal(after - before, quarter, "unshield did not pay out");

  console.log(`\n✓ testnet flow complete: shield ${formatUnits(amount, dec)} → transfer ${formatUnits(half, dec)} → unshield ${formatUnits(quarter, dec)}, all with real Groth16 proofs + association-set compliance.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("TESTNET FAIL:", e?.shortMessage ?? e?.message ?? e);
    process.exit(1);
  });
