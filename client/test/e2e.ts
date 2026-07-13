// End-to-end test against a local anvil node with REAL Groth16 proofs.
// Validates: circuit -> snarkjs -> Solidity Groth16Verifier -> Sherwood.transact
// across all four shielded actions (shield, private transfer, unshield, swap).
//
// Prereq: anvil running on 127.0.0.1:8545 and the E2EDeploy script already run
// (deploy/e2e.local.json present). The run-e2e.mjs harness does both for you.

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, getAddress, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { initPoseidon } from "../src/poseidon.js";
import { Keypair } from "../src/keypair.js";
import { SherwoodClient, BuiltTx } from "../src/pool.js";
import { AssociationSet } from "../src/assoc.js";
import { SHERWOOD_ABI, ERC20_ABI } from "../src/abi.js";
import { anvil } from "../src/chains.js";
import { nodeArtifacts } from "../src/artifacts.js";
import { quoteExactInputSingle, applySlippage } from "../src/quote.js";

const here = dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(resolve(here, "../../deploy/e2e.local.json"), "utf8"));

// anvil deterministic keys
const KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // submitter/relayer
const KEY1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // Alice's clear wallet (SHIELDER)
const CLEAR_RECIPIENT = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // anvil #3

const transport = http("http://127.0.0.1:8545");
const publicClient = createPublicClient({ chain: anvil, transport });
const submitter = createWalletClient({ account: privateKeyToAccount(KEY0), chain: anvil, transport });
const shielder = createWalletClient({ account: privateKeyToAccount(KEY1), chain: anvil, transport });

const pool = getAddress(A.pool) as `0x${string}`;
const usdg = getAddress(A.usdg) as `0x${string}`;
const aapl = getAddress(A.aapl) as `0x${string}`;
const quoter = getAddress(A.quoter) as `0x${string}`;

const usdgBal = (who: string) =>
  publicClient.readContract({ address: usdg, abi: ERC20_ABI, functionName: "balanceOf", args: [getAddress(who)] });
const aaplBal = (who: string) =>
  publicClient.readContract({ address: aapl, abi: ERC20_ABI, functionName: "balanceOf", args: [getAddress(who)] });

async function submit(wallet: typeof submitter, tx: BuiltTx) {
  const hash = await wallet.writeContract({
    address: pool,
    abi: SHERWOOD_ABI,
    functionName: "transact",
    args: [tx.proof as any, tx.extData as any],
  });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", `transact reverted (${hash})`);
  return r;
}

let pass = 0;
const ok = (m: string) => {
  console.log(`  ✓ ${m}`);
  pass++;
};

async function main() {
  await initPoseidon();

  const alice = Keypair.fromSeed(new Uint8Array(32).fill(0xa1));
  const bob = Keypair.fromSeed(new Uint8Array(32).fill(0xb0));
  const bobAddr = { pubKey: bob.pubKey, viewPub: bob.viewPub };

  // Shared association set; the ASP (anvil #0 / submitter) curates it and pushes
  // the root on-chain. Both clients build membership proofs against it.
  const assoc = new AssociationSet();
  const opts = { publicClient, pool, artifacts: nodeArtifacts, associationSet: assoc, fromBlock: 0n as bigint };
  const aliceClient = new SherwoodClient({ ...opts, keypair: alice, sender: shielder.account!.address });
  const bobClient = new SherwoodClient({ ...opts, keypair: bob });

  // ASP: screen new deposit labels, approve them, publish the root on-chain.
  async function aspApproveAll() {
    const logs = await publicClient.getContractEvents({ address: pool, abi: SHERWOOD_ABI, eventName: "Deposit", fromBlock: 0n, toBlock: "latest" });
    for (const l of logs as any[]) assoc.add(l.args.label as bigint);
    const hash = await submitter.writeContract({ address: pool, abi: SHERWOOD_ABI, functionName: "setAssociationRoot", args: [assoc.root()] });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  // --- SHIELD: Alice deposits 100 USDG (a fresh, screenable label) ---
  await shielder.writeContract({ address: usdg, abi: ERC20_ABI, functionName: "approve", args: [pool, 2n ** 256n - 1n] });
  const shield = await aliceClient.buildShield(usdg, 100_000000n);
  await submit(shielder, shield); // shield must be sent by the funding wallet
  aliceClient.invalidate();
  await aliceClient.sync();
  assert.equal(await aliceClient.balance(usdg), 100_000000n);
  assert.equal(await usdgBal(pool), 100_000000n);
  ok(`shield: Alice shielded 100 USDG (pool holds ${formatUnits(await usdgBal(pool), 6)})`);

  // --- COMPLIANCE GATE: spending is blocked until the ASP approves the label ---
  let gated = false;
  try {
    await aliceClient.buildTransfer(usdg, 30_000000n, bobAddr);
  } catch {
    gated = true;
  }
  assert(gated, "spend should be blocked before ASP approval");
  ok("compliance gate: spend blocked until the deposit's label is approved by the ASP");

  // ASP screens + approves the deposit, publishes the association root.
  await aspApproveAll();
  aliceClient.invalidate();
  await aliceClient.sync();

  // --- PRIVATE TRANSFER: Alice -> Bob 30 USDG (proves label ∈ association set) ---
  const transfer = await aliceClient.buildTransfer(usdg, 30_000000n, bobAddr);
  await submit(submitter, transfer);
  aliceClient.invalidate();
  bobClient.invalidate();
  await Promise.all([aliceClient.sync(), bobClient.sync()]);
  assert.equal(bobClient.balance(usdg), 30_000000n, "bob did not receive 30");
  assert.equal(aliceClient.balance(usdg), 70_000000n, "alice change wrong");
  assert.equal(await usdgBal(pool), 100_000000n, "no tokens should move on transfer");
  ok("transfer: 30 USDG moved Alice→Bob privately, no on-chain token movement");

  // --- UNSHIELD: Bob withdraws 25 USDG to a clear address ---
  const before = await usdgBal(CLEAR_RECIPIENT);
  const unshield = await bobClient.buildUnshield(usdg, 25_000000n, CLEAR_RECIPIENT as `0x${string}`);
  await submit(submitter, unshield);
  bobClient.invalidate();
  await bobClient.sync();
  assert.equal((await usdgBal(CLEAR_RECIPIENT)) - before, 25_000000n, "clear recipient not paid");
  assert.equal(bobClient.balance(usdg), 5_000000n, "bob change wrong");
  ok("unshield: Bob withdrew 25 USDG to a clear address; 5 USDG change remains shielded");

  // --- QUOTE: live QuoterV2 quote drives minAmountOut ---
  const quoted = await quoteExactInputSingle(publicClient, quoter, { tokenIn: usdg, tokenOut: aapl, amountIn: 40_000000n, fee: 3000 });
  assert.equal(quoted.amountOut, 40_000000000000000000n, "quote should equal the AMM output (rate 1e12)");
  const minOut = applySlippage(quoted.amountOut, 50); // 0.5%
  ok(`quote: QuoterV2 quotes 40 USDG → ${formatUnits(quoted.amountOut, 18)} AAPLx (min ${formatUnits(minOut, 18)})`);

  // --- SWAP: Alice swaps 40 USDG -> AAPLx through the AMM, proceeds re-shielded ---
  const swap = await aliceClient.buildSwap(usdg, 40_000000n, aapl, {
    minAmountOut: minOut,
    poolFee: 3000,
    deadline: 99999999999n,
  });
  await submit(submitter, swap);
  aliceClient.invalidate();
  await aliceClient.sync();
  assert.equal(await aaplBal(pool), 40_000000000000000000n, "AMM proceeds not in vault");
  assert.equal(aliceClient.balance(aapl), 40_000000000000000000n, "Alice's re-shielded AAPL note missing");
  assert.equal(aliceClient.balance(usdg), 30_000000n, "Alice USDG after swap wrong");
  ok("swap: Alice swapped 40 USDG→40 AAPLx via the public AMM, proceeds re-shielded into a private note");

  // ASP screens the swap proceeds' fresh label (re-screened as new value).
  await aspApproveAll();
  aliceClient.invalidate();
  await aliceClient.sync();

  // --- POST-SWAP: spend the re-shielded note. Works only if (a) the local tree
  // stayed in lockstep through the swap's extra ZERO_VALUE leaf AND (b) the swap's
  // fresh label is now in the association set. ---
  const AAPL_CLEAR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"; // anvil #4
  const beforeA = await aaplBal(AAPL_CLEAR);
  const un2 = await aliceClient.buildUnshield(aapl, 20_000000000000000000n, AAPL_CLEAR as `0x${string}`);
  await submit(submitter, un2);
  aliceClient.invalidate();
  await aliceClient.sync();
  assert.equal((await aaplBal(AAPL_CLEAR)) - beforeA, 20_000000000000000000n, "post-swap AAPL unshield failed");
  assert.equal(aliceClient.balance(aapl), 20_000000000000000000n, "post-swap AAPL change wrong");
  ok("post-swap: spent the re-shielded note (fresh label approved; tree consistent through swap)");

  // --- CACHE: snapshot → restore into a fresh client, balances match with no full rescan ---
  const snap = aliceClient.snapshot();
  const restored = new SherwoodClient({ publicClient, pool, keypair: alice, artifacts: nodeArtifacts, fromBlock: 0n });
  restored.load(snap);
  assert.equal(restored.balance(usdg), aliceClient.balance(usdg), "restored USDG balance mismatch");
  assert.equal(restored.balance(aapl), aliceClient.balance(aapl), "restored AAPL balance mismatch");
  assert.equal(restored.tree.root(), aliceClient.tree.root(), "restored tree root mismatch");
  ok(`cache: snapshot→restore reproduced balances + tree root (${snap.leaves.length} leaves, no rescan)`);

  // --- HISTORY: viewing-key self-disclosure lists spent + held notes ---
  const hist = aliceClient.history();
  assert(hist.length >= 3, "history should list Alice's notes");
  assert(hist.some((h) => h.spent) && hist.some((h) => !h.spent), "history should show both spent and held notes");
  const held = hist.filter((h) => !h.spent);
  ok(`history: ${hist.length} notes disclosed (${held.length} currently held) via viewing key`);

  console.log(`\n${pass} checks passed — shielded actions + compliance gate + live quote + cache + disclosure, all with real Groth16 proofs.`);
}

main()
  .then(() => process.exit(0)) // snarkjs leaves worker threads alive; exit explicitly
  .catch((e) => {
    console.error("E2E FAIL:", e);
    process.exit(1);
  });
