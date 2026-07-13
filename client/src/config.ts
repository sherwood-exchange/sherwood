// Protocol constants. These MUST stay in lockstep with the Solidity contracts
// and the circuit, or roots/commitments/nullifiers will not line up on-chain.
// This module is browser-safe (no node: imports); circuit artifact paths live in
// the node-only ./artifacts.ts.

/** BN254 scalar field (same as MerkleTreeWithHistory.FIELD_SIZE). */
export const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Empty-leaf value: keccak256("sherwood.v1") % FIELD_SIZE (MerkleTreeWithHistory.ZERO_VALUE). */
export const ZERO_VALUE =
  17242179440202835624415648542940796277869244002882800752906823721480933474798n;

/** Tree depth — MUST equal Transaction(23,..) in the circuit and the pool's `levels`. */
export const LEVELS = 23;

/** Association-set tree depth — MUST equal the assocLevels in Transaction(23,16,..). */
export const ASSOC_LEVELS = 16;

export const N_INS = 2;
export const N_OUTS = 2;

/** Circuit artifacts a prover needs: a URL (browser) or filesystem path (node). */
export interface Artifacts {
  wasm: string;
  zkey: string;
}

export const mod = (x: bigint, m: bigint = FIELD_SIZE) => ((x % m) + m) % m;
