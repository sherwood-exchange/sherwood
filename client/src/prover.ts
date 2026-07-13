// Witness assembly + Groth16 proof generation for the join-split circuit.
// Pads to exactly N_INS real-or-dummy inputs and N_OUTS outputs, enforces value
// conservation, runs snarkjs, and formats a,b,c + public signals for Solidity.

import * as snarkjs from "snarkjs";
import { LEVELS, ASSOC_LEVELS, N_INS, N_OUTS, FIELD_SIZE, mod, type Artifacts } from "./config.js";
import { Keypair } from "./keypair.js";
import { Note } from "./note.js";
import { MerkleTree, MerklePath } from "./tree.js";

export interface OwnedInput {
  note: Note;
  index: number; // leaf index in the tree
  /** Owner private key for this note; defaults to the master spendKey. Swap
   *  claim notes are owned by a per-swap stealth key (M-1). */
  privKey?: bigint;
}

export interface SolidityProof {
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
  root: bigint;
  publicAmount: bigint;
  publicAsset: bigint;
  extDataHash: bigint;
  associationRoot: bigint;
  depositLabel: bigint;
  isDeposit: bigint;
  inputNullifiers: [bigint, bigint];
  outputCommitments: [bigint, bigint];
}

const zeroPath = () => Array(LEVELS).fill(0n);

export interface WitnessArgs {
  keypair: Keypair;
  tree: MerkleTree;
  inputs: OwnedInput[]; // 0..N_INS real inputs (owned notes being spent)
  outputs: Note[]; // 0..N_OUTS real outputs
  publicAmount: bigint; // field-encoded net (extAmount - fee) mod FIELD
  publicAsset: bigint; // uint160(token) of the boundary/tx asset
  extDataHash: bigint;
  // --- compliance ---
  txLabel: bigint; // the single label shared by all real notes
  associationRoot: bigint; // must equal the on-chain associationRoot
  depositLabel: bigint; // for a deposit, == txLabel (revealed); 0 for a spend
  assocPath: MerklePath; // membership path of txLabel (dummy for a deposit)
}

export interface AssembledWitness {
  input: any; // snarkjs-ready (decimal strings)
  root: bigint;
  inputNullifiers: bigint[];
  outputCommitments: bigint[];
}

/** Build the circuit witness (padded, value-conservation-checked). Exposed so
 *  proofs can also be generated + locally verified outside `proveTransaction`. */
export function assembleWitness(args: WitnessArgs): AssembledWitness {
  const { keypair, tree, publicAmount, publicAsset, extDataHash, txLabel, associationRoot, depositLabel, assocPath } = args;
  if (args.inputs.length > N_INS) throw new Error(`too many inputs (max ${N_INS})`);
  if (args.outputs.length > N_OUTS) throw new Error(`too many outputs (max ${N_OUTS})`);

  const root = tree.root();

  // --- pad inputs to N_INS with fresh dummy (amount 0) notes owned by us ---
  const inputs: OwnedInput[] = [...args.inputs];
  while (inputs.length < N_INS) {
    inputs.push({ note: Note.zero(keypair.pubKey, publicAsset, txLabel), index: 0 });
  }

  // --- pad outputs to N_OUTS with zero notes ---
  const outputs: Note[] = [...args.outputs];
  while (outputs.length < N_OUTS) outputs.push(Note.zero(keypair.pubKey, publicAsset, txLabel));

  const inAmount: bigint[] = [];
  const inAssetId: bigint[] = [];
  const inPrivateKey: bigint[] = [];
  const inBlinding: bigint[] = [];
  const inLabel: bigint[] = [];
  const inPathIndices: bigint[] = [];
  const inPathElements: bigint[][] = [];
  const inputNullifiers: bigint[] = [];

  for (const { note, index, privKey } of inputs) {
    const isReal = note.amount !== 0n;
    const key = privKey ?? keypair.spendKey; // dummy padding stays on the master key
    inAmount.push(note.amount);
    inAssetId.push(note.assetId);
    inPrivateKey.push(key);
    inBlinding.push(note.blinding);
    inLabel.push(note.label);
    inPathIndices.push(BigInt(index));
    inPathElements.push(isReal ? tree.path(index).pathElements : zeroPath());
    inputNullifiers.push(note.nullifierWithKey(key, index));
  }

  const outAmount: bigint[] = [];
  const outAssetId: bigint[] = [];
  const outPubkey: bigint[] = [];
  const outBlinding: bigint[] = [];
  const outLabel: bigint[] = [];
  const outputCommitments: bigint[] = [];
  for (const note of outputs) {
    outAmount.push(note.amount);
    outAssetId.push(note.assetId);
    outPubkey.push(note.pubKey);
    outBlinding.push(note.blinding);
    outLabel.push(note.label);
    outputCommitments.push(note.commitment());
  }

  // sanity: value conservation in the field (fail early with a clear message)
  const sumIn = inAmount.reduce((a, b) => a + b, 0n);
  const sumOut = outAmount.reduce((a, b) => a + b, 0n);
  if (mod(sumIn + publicAmount, FIELD_SIZE) !== mod(sumOut, FIELD_SIZE)) {
    throw new Error("value conservation violated: sum(in) + publicAmount != sum(out)");
  }
  const isDeposit = sumIn === 0n ? 1n : 0n;

  const witness = {
    root,
    publicAmount,
    publicAsset,
    extDataHash,
    associationRoot,
    depositLabel,
    isDeposit,
    inputNullifier: inputNullifiers,
    outputCommitment: outputCommitments,
    inAmount,
    inAssetId,
    inPrivateKey,
    inBlinding,
    inLabel,
    inPathIndices,
    inPathElements,
    outAmount,
    outAssetId,
    outPubkey,
    outBlinding,
    outLabel,
    txLabel,
    assocPathIndices: BigInt(assocPath.pathIndices),
    assocPathElements: assocPath.pathElements,
  };

  return { input: stringify(witness), root, inputNullifiers, outputCommitments };
}

/** Runs the Groth16 witness+prove for a witness `input`. The default calls
 *  snarkjs directly; a browser can pass a Web-Worker-backed implementation so
 *  proving does not block the UI thread. */
export type FullProveFn = (
  input: any,
  artifacts: Artifacts
) => Promise<{ proof: any; publicSignals: string[] }>;

export const defaultFullProve: FullProveFn = (input, artifacts) =>
  snarkjs.groth16.fullProve(input, artifacts.wasm, artifacts.zkey);

export async function proveTransaction(
  args: WitnessArgs,
  artifacts: Artifacts,
  fullProve: FullProveFn = defaultFullProve
): Promise<SolidityProof> {
  const { input } = assembleWitness(args);

  const { proof, publicSignals } = await fullProve(input, artifacts);

  const S = publicSignals.map((x: string) => BigInt(x));
  return {
    a: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
    // snarkjs emits pi_b in (x, y) with the two Fp2 coords swapped vs. the EVM verifier
    b: [
      [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
      [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
    ],
    c: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
    root: S[0],
    publicAmount: S[1],
    publicAsset: S[2],
    extDataHash: S[3],
    associationRoot: S[4],
    depositLabel: S[5],
    isDeposit: S[6],
    inputNullifiers: [S[7], S[8]],
    outputCommitments: [S[9], S[10]],
  };
}

// snarkjs wants decimal strings / arrays of them.
function stringify(w: any): any {
  const s = (x: any): any =>
    Array.isArray(x) ? x.map(s) : typeof x === "bigint" ? x.toString() : x;
  const out: any = {};
  for (const k of Object.keys(w)) out[k] = s(w[k]);
  return out;
}
