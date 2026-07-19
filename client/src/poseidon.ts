// Poseidon over BN254 via circomlibjs. This is the SAME hash the circuit uses
// and (by construction of poseidon-solidity) the same the contracts use, so
// commitments / nullifiers / tree roots computed here match on-chain byte-for-byte.

type PoseidonFn = ((inputs: (bigint | number | string)[]) => Uint8Array) & {
  F: { toObject: (x: Uint8Array) => bigint };
};

let _poseidon: PoseidonFn | null = null;

export async function initPoseidon(): Promise<void> {
  // Dynamic import keeps circomlibjs (and its ffjavascript/wasm baggage, ~MBs) out of the app's
  // boot bundle — it loads on the first shielded-account derivation instead.
  if (!_poseidon) {
    const { buildPoseidon } = await import("circomlibjs");
    _poseidon = (await buildPoseidon()) as unknown as PoseidonFn;
  }
}

/** Poseidon hash of `inputs`, returned as a field element (bigint). */
export function poseidon(inputs: (bigint | number | string)[]): bigint {
  if (!_poseidon) throw new Error("call initPoseidon() first");
  const out = _poseidon(inputs.map((x) => BigInt(x)));
  return _poseidon.F.toObject(out);
}

export const poseidon2 = (a: bigint, b: bigint) => poseidon([a, b]);
export const poseidon4 = (a: bigint, b: bigint, c: bigint, d: bigint) => poseidon([a, b, c, d]);
