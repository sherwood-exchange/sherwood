// Sherwood account keys, all deterministically derived from a single 32-byte
// seed (in production: keccak256 of a wallet signature over a fixed message, so
// the account is recoverable from the wallet alone — no extra secret to back up).
//
//   spendKey   (field element)  — note ownership. pubKey = Poseidon(spendKey)
//                                 is committed into every note the account owns.
//   viewKey    (secp256k1 priv) — note encryption. viewPub lets others encrypt
//                                 notes TO this account (ECIES).
//
// The public "Sherwood address" others send to is (pubKey, viewPub).

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { poseidon } from "./poseidon.js";
import { mod } from "./config.js";

const enc = new TextEncoder();

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array): string {
  return "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function toField(b: Uint8Array): bigint {
  let x = 0n;
  for (const byte of b) x = (x << 8n) | BigInt(byte);
  return mod(x);
}

export class Keypair {
  readonly spendKey: bigint;
  readonly pubKey: bigint;
  readonly viewKey: Uint8Array; // secp256k1 private scalar
  readonly viewPub: Uint8Array; // compressed secp256k1 point (33 bytes)

  private constructor(spendKey: bigint, viewKey: Uint8Array) {
    this.spendKey = spendKey;
    this.pubKey = poseidon([spendKey]);
    this.viewKey = viewKey;
    this.viewPub = secp256k1.getPublicKey(viewKey, true);
  }

  /** Derive from a 32-byte seed (e.g. keccak of a wallet signature). */
  static fromSeed(seed: Uint8Array): Keypair {
    const spendKey = toField(keccak_256(concat(seed, enc.encode("sherwood/spend"))));
    let viewKey = keccak_256(concat(seed, enc.encode("sherwood/view")));
    // ensure it is a valid secp256k1 scalar (astronomically unlikely to loop)
    for (;;) {
      try {
        secp256k1.getPublicKey(viewKey, true);
        break;
      } catch {
        viewKey = keccak_256(viewKey);
      }
    }
    return new Keypair(spendKey, viewKey);
  }

  static fromHexSeed(hexSeed: string): Keypair {
    return Keypair.fromSeed(hexToBytes(hexSeed));
  }

  /** Ownership signature over a note being spent (matches the circuit's `sign`). */
  sign(commitment: bigint, merkleIndex: bigint): bigint {
    return poseidon([this.spendKey, commitment, merkleIndex]);
  }

  /** Shareable address: the info someone needs to send a note to this account. */
  address(): { pubKey: string; viewPub: string } {
    return { pubKey: "0x" + this.pubKey.toString(16), viewPub: bytesToHex(this.viewPub) };
  }
}

/** Domain tag for per-swap stealth keys (M-1): keccak256("sherwood/swap-stealth-v1") % FIELD. */
export const SWAP_STEALTH_DOMAIN = toField(keccak_256(enc.encode("sherwood/swap-stealth-v1")));

/** Per-swap stealth owner key (M-1 fix). Deterministic from the master spend key
 *  and the swap's fresh blinding, so the scanner — which recovers `swapBlinding`
 *  from the ECIES `encryptedSwapNote` — can re-derive it with zero extra on-chain
 *  data. Domain-separated from `sign` (Poseidon(spendKey, commitment, idx)) by
 *  the leading tag. `pub` goes into `extData.swapPubKey` in place of the master
 *  pubKey, so an observer can no longer link an account's swaps together. */
export function deriveSwapStealthKey(spendKey: bigint, swapBlinding: bigint): { priv: bigint; pub: bigint } {
  const priv = poseidon([SWAP_STEALTH_DOMAIN, spendKey, swapBlinding]);
  return { priv, pub: poseidon([priv]) };
}

export interface PublicAddress {
  pubKey: bigint;
  viewPub: Uint8Array;
}

export function parseAddress(a: { pubKey: string; viewPub: string }): PublicAddress {
  return { pubKey: BigInt(a.pubKey), viewPub: hexToBytes(a.viewPub) };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export { hexToBytes, bytesToHex };
