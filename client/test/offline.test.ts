// Offline validation of the ZK + crypto stack — no chain required.
// Run: npx tsx client/test/offline.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toHex, stringToBytes } from "viem";
import * as snarkjs from "snarkjs";
import { initPoseidon, poseidon2 } from "../src/poseidon.js";
import { FIELD_SIZE, ZERO_VALUE, mod } from "../src/config.js";
import { nodeArtifacts } from "../src/artifacts.js";
import { MerkleTree } from "../src/tree.js";
import { Keypair } from "../src/keypair.js";
import { Note } from "../src/note.js";
import { assembleWitness } from "../src/prover.js";
import { AssociationSet } from "../src/assoc.js";

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

  console.log(`\n${pass} checks passed.`);
}

main()
  .then(() => process.exit(0)) // snarkjs leaves worker threads alive; exit explicitly
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  });
