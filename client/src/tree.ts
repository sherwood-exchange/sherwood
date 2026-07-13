// Fixed-depth incremental Poseidon Merkle tree that reproduces
// MerkleTreeWithHistory.sol exactly. The contract inserts leaves two-at-a-time
// (pair-insert), but that is arithmetically identical to appending them one by
// one into a standard incremental tree with the same ZERO_VALUE and Poseidon(2),
// so a single-append tree here yields bit-identical roots and Merkle paths.

import { LEVELS, ZERO_VALUE } from "./config.js";
import { poseidon2 } from "./poseidon.js";

export interface MerklePath {
  pathElements: bigint[]; // sibling at each level, bottom -> top
  pathIndices: number; // the leaf index (circuit decomposes it to per-level bits)
}

export class MerkleTree {
  readonly levels: number;
  private zeros: bigint[] = [];
  /** layers[0] = leaves; layers[k] = nodes at height k. */
  private layers: bigint[][] = [[]];

  constructor(levels: number = LEVELS, zeroValue: bigint = ZERO_VALUE) {
    this.levels = levels;
    let z = zeroValue;
    for (let i = 0; i < levels; i++) {
      this.zeros.push(z);
      z = poseidon2(z, z);
    }
  }

  get size(): number {
    return this.layers[0].length;
  }

  /** Append a leaf and return its index. */
  insert(leaf: bigint): number {
    const index = this.layers[0].length;
    this.layers[0].push(leaf);
    this.rebuildFrom(index);
    return index;
  }

  insertMany(leaves: bigint[]): void {
    for (const l of leaves) this.insert(l);
  }

  private rebuildFrom(leafIndex: number): void {
    let idx = leafIndex;
    for (let level = 0; level < this.levels; level++) {
      if (!this.layers[level + 1]) this.layers[level + 1] = [];
      const parentIndex = idx >> 1;
      const left = this.layers[level][parentIndex * 2] ?? this.zeros[level];
      const right = this.layers[level][parentIndex * 2 + 1] ?? this.zeros[level];
      this.layers[level + 1][parentIndex] = poseidon2(left, right);
      idx = parentIndex;
    }
  }

  root(): bigint {
    const top = this.layers[this.levels];
    if (top && top[0] !== undefined) return top[0];
    // root of a fully-empty tree = zeros hashed one more level up (matches
    // MerkleTreeWithHistory's constructor: roots[0] = hash(zeros[L-1], zeros[L-1]))
    const z = this.zeros[this.levels - 1];
    return poseidon2(z, z);
  }

  path(index: number): MerklePath {
    if (index < 0 || index >= this.layers[0].length) throw new Error(`leaf ${index} out of range`);
    const pathElements: bigint[] = [];
    let idx = index;
    for (let level = 0; level < this.levels; level++) {
      const sibling = idx ^ 1;
      const val = this.layers[level][sibling] ?? this.zeros[level];
      pathElements.push(val);
      idx >>= 1;
    }
    return { pathElements, pathIndices: index };
  }

  indexOf(leaf: bigint): number {
    return this.layers[0].findIndex((l) => l === leaf);
  }

  /** All leaves in insertion order (for snapshotting an incremental-sync cache). */
  leaves(): bigint[] {
    return [...this.layers[0]];
  }
}
