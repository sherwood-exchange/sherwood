// Live test of the RELAYER path on Robinhood Chain testnet: a private transfer is
// built bound to the relayer, POSTed to the relayer service, and submitted on-chain
// FROM THE RELAYER'S wallet — proving the user's address never touches the pool
// (gasless + unlinkable). Requires the relayer running: `npm run relayer:testnet`.
//
// Run: npm run testnet:relayer   (needs Alice to already hold a shielded note —
// run `npm run testnet:test` first if the pool is empty for this account.)
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, defineChain, getAddress, formatUnits, keccak256, toBytes, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { initPoseidon } from "../src/poseidon.js";
import { Keypair } from "../src/keypair.js";
import { SherwoodClient } from "../src/pool.js";
import { AssociationSet } from "../src/assoc.js";
import { SHERWOOD_ABI } from "../src/abi.js";
import { serializeBuiltTx } from "../src/serde.js";
import { nodeArtifacts } from "../src/artifacts.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const f of [".env", ".env.local"]) {
    try { for (const l of readFileSync(resolve(ROOT, f), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/); if (m) { const v = m[2].replace(/\s+#.*$/, "").trim(); if (v) env[m[1]] = v; } } } catch {}
  }
  if (env.INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  return env;
}

async function main() {
  const env = loadEnv();
  const rpc = env.RPC_URL;
  const chainId = Number(env.CHAIN_ID || 46630);
  const pk = env.DEPLOYER_PRIVATE_KEY as `0x${string}`;
  const relayerUrl = (env.RELAYER_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
  const dep = JSON.parse(readFileSync(resolve(ROOT, "deploy/testnet.json"), "utf8"));
  const pool = getAddress(dep.pool) as Address;
  const assets: Address[] = (dep.assets as string[]).map((a) => getAddress(a) as Address);
  const fromBlock = BigInt(dep.fromBlock ?? 0);

  const chain = defineChain({ id: chainId, name: "RH Testnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } }, testnet: true });
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const deployer = privateKeyToAccount(pk);
  const wallet = createWalletClient({ account: deployer, chain, transport: http(rpc) });
  const explorer = (h: string) => `https://explorer.testnet.chain.robinhood.com/tx/${h}`;

  await initPoseidon();
  const alice = Keypair.fromSeed(toBytes(keccak256(toBytes(pk))));
  const bob = Keypair.fromSeed(toBytes(keccak256(toBytes(pk + "01"))));
  const assoc = new AssociationSet();
  const opts = { publicClient, pool, artifacts: nodeArtifacts, associationSet: assoc, autoApproveDeposits: true, fromBlock };
  const aliceClient = new SherwoodClient({ ...opts, keypair: alice });
  const bobClient = new SherwoodClient({ ...opts, keypair: bob });
  const syncUntilBalance = async (client: SherwoodClient, tok: Address, expected: bigint, label: string) => {
    for (let i = 0; ; i++) { client.invalidate(); await client.sync(); if (client.balance(tok) === expected) return; if (i >= 9) assert.equal(client.balance(tok), expected, label); await new Promise((r) => setTimeout(r, 3000)); }
  };

  await aliceClient.sync();
  await bobClient.sync();

  // 0) relayer identity — must be a DIFFERENT wallet than ours, else nothing is unlinked
  const info = await (await fetch(relayerUrl + "/info")).json();
  const relAddr = getAddress(info.relayer) as Address;
  console.log(`Relayer ${relAddr}  pool ${info.pool}  chain ${info.chainId}  minFee ${info.minFee}`);
  assert.equal(getAddress(info.pool), pool, "relayer points at a different pool");
  assert.equal(Number(info.chainId), chainId, "relayer on a different chain");
  assert.notEqual(relAddr.toLowerCase(), deployer.address.toLowerCase(), "relayer must not be the deployer wallet (no unlinkability)");

  // pick a token Alice already holds shielded
  const token = assets.find((t) => aliceClient.balance(t) > 0n);
  assert.ok(token, "Alice holds no shielded notes — run `npm run testnet:test` first");
  const dec = 18; // all rh-testnet stock tokens are 18-dp
  const amount = aliceClient.balance(token!) / 4n;
  assert.ok(amount > 0n, "shielded balance too small to split");
  console.log(`Alice will privately send ${formatUnits(amount, dec)} of ${token} to Bob via the relayer.\n`);

  // 1) make sure Alice's note labels are ASP-approved (publish the set if stale)
  const onchainRoot = (await publicClient.readContract({ address: pool, abi: SHERWOOD_ABI, functionName: "associationRoot" })) as bigint;
  if (assoc.root() !== onchainRoot) {
    console.log("Publishing association root (ASP) so the note's label is approved…");
    const h = await wallet.writeContract({ address: pool, abi: SHERWOOD_ABI, functionName: "setAssociationRoot", args: [assoc.root()] });
    await publicClient.waitForTransactionReceipt({ hash: h });
    console.log(`   ASP set associationRoot → ${explorer(h)}`);
  }

  // 2) build the transfer bound to the relayer + POST it (no wallet signature from us)
  const bobBefore = bobClient.balance(token!);
  const tx = await aliceClient.buildTransfer(token!, amount, { pubKey: bob.pubKey, viewPub: bob.viewPub }, { relayer: relAddr, fee: BigInt(info.minFee ?? 0) });
  console.log("Submitting to relayer /transact …");
  const res = await fetch(relayerUrl + "/transact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(serializeBuiltTx(tx)) });
  const body = await res.json();
  assert.ok(res.ok, `relayer rejected: ${body.detail || body.error}`);
  const txHash = body.txHash as `0x${string}`;
  console.log(`   relayed transfer → ${explorer(txHash)}`);

  // 3) THE PROOF: the on-chain tx was sent by the relayer, not by us
  const onchainTx = await publicClient.getTransaction({ hash: txHash });
  assert.equal(onchainTx.from.toLowerCase(), relAddr.toLowerCase(), "tx was not submitted by the relayer");
  assert.equal(onchainTx.to?.toLowerCase(), pool.toLowerCase(), "tx did not call the pool");
  assert.notEqual(onchainTx.from.toLowerCase(), deployer.address.toLowerCase(), "tx.from is the user wallet — link not broken");

  // 4) value moved privately to Bob
  await syncUntilBalance(bobClient, token!, bobBefore + amount, "bob did not receive the relayed transfer");

  console.log(`\n✓ relayer path verified: ${formatUnits(amount, dec)} moved Alice→Bob with a real Groth16 proof,`);
  console.log(`  submitted on-chain by the relayer ${relAddr} (gas paid by relayer),`);
  console.log(`  NOT by the user ${deployer.address} — the deposit↔spend address link is broken.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("RELAYER TEST FAIL:", e?.shortMessage ?? e?.message ?? e); process.exit(1); });
