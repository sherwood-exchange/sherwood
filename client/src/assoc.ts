// The Association Set — the ASP's Merkle tree of approved deposit labels.
// A spend proves its note's label is a member of this tree (root published
// on-chain via setAssociationRoot). Same Poseidon(2)/ZERO_VALUE construction as
// the commitment tree, at ASSOC_LEVELS depth, so SDK and circuit agree.

import { ASSOC_LEVELS, ZERO_VALUE } from "./config.js";
import { MerkleTree, MerklePath } from "./tree.js";

export class AssociationSet {
  private tree = new MerkleTree(ASSOC_LEVELS, ZERO_VALUE);
  private index = new Map<string, number>();

  /** Approve a label (idempotent). Returns its leaf index. */
  add(label: bigint): number {
    const k = label.toString();
    const existing = this.index.get(k);
    if (existing !== undefined) return existing;
    const i = this.tree.insert(label);
    this.index.set(k, i);
    return i;
  }

  addMany(labels: bigint[]): void {
    for (const l of labels) this.add(l);
  }

  has(label: bigint): boolean {
    return this.index.has(label.toString());
  }

  /** Approved labels in insertion order — for persisting/restoring the set. */
  labels(): bigint[] {
    return [...this.index.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => BigInt(k));
  }

  root(): bigint {
    return this.tree.root();
  }

  /** Membership path for an approved label (throws if not approved). */
  proof(label: bigint): MerklePath {
    const i = this.index.get(label.toString());
    if (i === undefined) throw new Error(`label ${label} is not in the association set`);
    return this.tree.path(i);
  }

  /** An all-zero dummy path (for deposits, where membership is not enforced). */
  static dummyPath(): MerklePath {
    return { pathElements: Array(ASSOC_LEVELS).fill(0n), pathIndices: 0 };
  }
}
