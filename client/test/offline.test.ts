// Offline validation of the ZK + crypto stack — no chain required.
// Run: npx tsx client/test/offline.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toHex, stringToBytes } from "viem";
import * as snarkjs from "snarkjs";
import { initPoseidon, poseidon, poseidon2 } from "../src/poseidon.js";
import { FIELD_SIZE, ZERO_VALUE, mod } from "../src/config.js";
import { nodeArtifacts } from "../src/artifacts.js";
import { MerkleTree } from "../src/tree.js";
import { Keypair, deriveSwapStealthKey, SWAP_STEALTH_DOMAIN } from "../src/keypair.js";
import { Note } from "../src/note.js";
import { assembleWitness } from "../src/prover.js";
import { AssociationSet } from "../src/assoc.js";
import { recoverClaimNote } from "../src/pool.js";

const here = dirname(fileURLToPath(import.meta.url));
const VKEY = JSON.parse(readFileSync(resolve(here, "../../circuits/build/verification_key.json"), "utf8"));

let pass = 0;
const ok = (name: string) => {
  console.log(`  ✓ ${name}`);
  pass++;
};

async function main() {
  await initPoseidon();

  // 1. Poseidon parity with the on-chain PoseidonT3 / circom
  assert.equal(
    poseidon2(1n, 2n),
    7853200120776062878684798364095072458815029376092732009249414926327459813530n
  );
  ok("Poseidon(1,2) matches circomlib / poseidon-solidity");

  // 2. ZERO_VALUE = keccak256("sherwood.v1") % FIELD (matches MerkleTreeWithHistory)
  const z = mod(BigInt(keccak256(stringToBytes("sherwood.v1"))), FIELD_SIZE);
  assert.equal(z, ZERO_VALUE, "ZERO_VALUE derivation mismatch");
  ok("ZERO_VALUE = keccak256('sherwood.v1') % FIELD");

  // 3. Note encrypt -> decrypt roundtrip (ECIES)
  const alice = Keypair.fromSeed(new Uint8Array(32).fill(7));
  const bob = Keypair.fromSeed(new Uint8Array(32).fill(9));
  const usdg = BigInt("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
  const label = 424242n;
  const note = Note.to({ pubKey: bob.pubKey, viewPub: bob.viewPub }, 123456n, usdg, label);
  const payload = note.encryptTo(bob.viewPub);
  const recovered = Note.tryDecrypt(bob, payload);
  assert(recovered, "bob failed to decrypt his note");
  assert.equal(recovered!.commitment(), note.commitment(), "decrypted commitment mismatch");
  assert.equal(recovered!.label, label, "decrypted label mismatch");
  assert.equal(Note.tryDecrypt(alice, payload), null, "alice must NOT decrypt bob's note");
  ok("Note ECIES encrypt/decrypt roundtrip (label carried; non-owner rejected)");

  // 4. A real labeled shield proof verifies against the exported verification key
  const tree = new MerkleTree();
  const out = Note.own(alice, 100_000000n, usdg, label); // 100 USDG (6dp), deposit label
  const extDataHash = mod(BigInt(keccak256(toHex("demo-extdata"))), FIELD_SIZE);
  const shieldArgs = {
    keypair: alice, tree, inputs: [], outputs: [out],
    publicAmount: 100_000000n, publicAsset: usdg, extDataHash,
    txLabel: label, associationRoot: 0n, depositLabel: label, assocPath: AssociationSet.dummyPath(),
  };
  const { input } = assembleWitness(shieldArgs);
  console.log("  … generating Groth16 proof (shield)…");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, nodeArtifacts.wasm, nodeArtifacts.zkey);
  const verified = await snarkjs.groth16.verify(VKEY, publicSignals, proof);
  assert(verified, "shield proof failed vkey verification");
  ok("real Groth16 labeled shield proof verifies against verification_key.json");

  // 5. public signals are in the contract's expected order & values
  assert.equal(BigInt(publicSignals[0]), tree.root(), "publicSignal[0] root");
  assert.equal(BigInt(publicSignals[1]), 100_000000n, "publicSignal[1] publicAmount");
  assert.equal(BigInt(publicSignals[2]), usdg, "publicSignal[2] publicAsset");
  assert.equal(BigInt(publicSignals[3]), extDataHash, "publicSignal[3] extDataHash");
  assert.equal(BigInt(publicSignals[5]), label, "publicSignal[5] depositLabel");
  assert.equal(BigInt(publicSignals[6]), 1n, "publicSignal[6] isDeposit (pure deposit)");
  assert.equal(BigInt(publicSignals[9]), out.commitment(), "publicSignal[9] outCommitment0");
  ok("public signals match [root, publicAmount, publicAsset, extDataHash, assocRoot, depositLabel, isDeposit, …]");

  // 6. value conservation guard fires
  let threw = false;
  try {
    assembleWitness({ ...shieldArgs, publicAmount: 99n });
  } catch {
    threw = true;
  }
  assert(threw, "value-conservation guard did not fire");
  ok("value-conservation guard rejects unbalanced tx");

  // 7. per-swap stealth key derivation (M-1): deterministic + domain-separated
  const blinding = 987654321987654321n;
  const s1 = deriveSwapStealthKey(alice.spendKey, blinding);
  const s1again = deriveSwapStealthKey(alice.spendKey, blinding);
  assert.equal(s1.priv, s1again.priv, "stealth priv not deterministic");
  assert.equal(s1.pub, s1again.pub, "stealth pub not deterministic");
  assert.equal(s1.pub, poseidon([s1.priv]), "stealth pub != Poseidon(priv)");
  const s2 = deriveSwapStealthKey(alice.spendKey, blinding + 1n);
  assert.notEqual(s1.priv, s2.priv, "different blinding must give a different stealth key");
  assert.notEqual(s1.pub, alice.pubKey, "stealth pub must differ from the master pubKey");
  assert.notEqual(s1.priv, alice.spendKey, "stealth priv must differ from the master spendKey");
  // domain separation: not reachable via the ownership `sign` derivation
  // Poseidon(spendKey, ·, ·) nor via an untagged Poseidon(spendKey, blinding)
  assert.notEqual(s1.priv, alice.sign(blinding, SWAP_STEALTH_DOMAIN), "collides with sign derivation");
  assert.notEqual(s1.priv, alice.sign(SWAP_STEALTH_DOMAIN, blinding), "collides with sign derivation");
  assert.notEqual(s1.priv, poseidon([alice.spendKey, blinding]), "collides with untagged 2-ary hash");
  ok("deriveSwapStealthKey: deterministic, per-blinding, domain-separated from sign/master keys");

  // 8. recoverClaimNote: stealth match, legacy master fallback, foreign rejection
  const amountOut = 55_000000n;
  const claimLabel = 777777n;
  // what Note.tryDecrypt yields for a claim placeholder (amount 0, master pubKey implicit)
  const decrypted = new Note({ amount: 0n, assetId: usdg, pubKey: alice.pubKey, blinding, label: 0n });
  const stealthCommit = new Note({ amount: amountOut, assetId: usdg, pubKey: s1.pub, blinding, label: claimLabel }).commitment();
  const r1 = recoverClaimNote(alice, decrypted, amountOut, claimLabel, stealthCommit);
  assert(r1, "stealth claim note not recovered");
  assert.equal(r1!.privKey, s1.priv, "recovered privKey should be the stealth priv");
  assert.equal(r1!.note.pubKey, s1.pub, "recovered note should carry the stealth pubKey");
  assert.equal(r1!.note.commitment(), stealthCommit, "recovered note commitment mismatch");
  const legacyCommit = new Note({ amount: amountOut, assetId: usdg, pubKey: alice.pubKey, blinding, label: claimLabel }).commitment();
  const r2 = recoverClaimNote(alice, decrypted, amountOut, claimLabel, legacyCommit);
  assert(r2, "legacy (master-key) claim note not recovered");
  assert.equal(r2!.privKey, alice.spendKey, "legacy claim should spend with the master key");
  assert.equal(r2!.note.pubKey, alice.pubKey, "legacy claim should carry the master pubKey");
  const foreignCommit = new Note({ amount: amountOut, assetId: usdg, pubKey: bob.pubKey, blinding, label: claimLabel }).commitment();
  assert.equal(recoverClaimNote(alice, decrypted, amountOut, claimLabel, foreignCommit), null, "foreign commitment must be rejected");
  ok("recoverClaimNote: stealth match / legacy master fallback / foreign commitment rejected");

  // 9. assembleWitness honors the per-input privKey override (nullifier + inPrivateKey)
  const claimNote = new Note({ amount: 10_000000n, assetId: usdg, pubKey: s1.pub, blinding, label: claimLabel });
  const tree2 = new MerkleTree();
  tree2.insert(claimNote.commitment());
  const aset = new AssociationSet();
  aset.add(claimLabel);
  const outNote = new Note({ amount: 10_000000n, assetId: usdg, pubKey: alice.pubKey, label: claimLabel });
  const w = assembleWitness({
    keypair: alice, tree: tree2,
    inputs: [{ note: claimNote, index: 0, privKey: s1.priv }], outputs: [outNote],
    publicAmount: 0n, publicAsset: usdg, extDataHash,
    txLabel: claimLabel, associationRoot: aset.root(), depositLabel: 0n, assocPath: aset.proof(claimLabel),
  });
  assert.equal(BigInt(w.input.inPrivateKey[0]), s1.priv, "witness inPrivateKey[0] should be the stealth priv");
  assert.equal(w.inputNullifiers[0], claimNote.nullifierWithKey(s1.priv, 0), "nullifier should use the stealth key");
  assert.notEqual(w.inputNullifiers[0], claimNote.nullifier(alice, 0), "stealth nullifier must differ from master-key nullifier");
  assert.equal(BigInt(w.input.inPrivateKey[1]), alice.spendKey, "dummy padding input must stay on the master key");
  assert.equal(claimNote.nullifier(alice, 0), claimNote.nullifierWithKey(alice.spendKey, 0), "nullifier() must delegate to nullifierWithKey(spendKey)");
  ok("assembleWitness: privKey override drives inPrivateKey + nullifier; dummies stay on master key");

  console.log(`\n${pass} checks passed.`);
}

main()
  .then(() => process.exit(0)) // snarkjs leaves worker threads alive; exit explicitly
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  });
