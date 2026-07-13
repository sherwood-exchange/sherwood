// A shielded UTXO note and its cryptographic derivations.
//
//   note        = { amount, assetId, pubKey, blinding }
//   assetId     = BigInt(tokenAddress)  (uint160 of the ERC20 address)
//   commitment  = Poseidon(amount, assetId, pubKey, blinding)
//   sign        = Poseidon(spendKey, commitment, merkleIndex)
//   nullifier   = Poseidon(commitment, merkleIndex, sign)
//
// Notes are handed to their owner out-of-band via an ECIES payload emitted in the
// NewCommitment event; the owner trial-decrypts every event to find theirs.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { poseidon } from "./poseidon.js";
import { FIELD_SIZE, mod } from "./config.js";
import { Keypair, PublicAddress, bytesToHex, hexToBytes } from "./keypair.js";

const HKDF_INFO = new TextEncoder().encode("sherwood-note-v1");

function randomField(): bigint {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  let x = 0n;
  for (const byte of b) x = (x << 8n) | BigInt(byte);
  return mod(x, FIELD_SIZE);
}

function beBytes32(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}
function fromBeBytes(b: Uint8Array): bigint {
  let x = 0n;
  for (const byte of b) x = (x << 8n) | BigInt(byte);
  return x;
}

export class Note {
  amount: bigint;
  assetId: bigint;
  pubKey: bigint;
  blinding: bigint;
  label: bigint; // per-deposit compliance label (Privacy-Pools association set)

  constructor(params: { amount: bigint; assetId: bigint; pubKey: bigint; blinding?: bigint; label?: bigint }) {
    this.amount = params.amount;
    this.assetId = params.assetId;
    this.pubKey = params.pubKey;
    this.blinding = params.blinding ?? randomField();
    this.label = params.label ?? 0n;
  }

  /** A note owned by `keypair`, of `amount` in `assetId`, carrying `label`. */
  static own(keypair: Keypair, amount: bigint, assetId: bigint, label: bigint): Note {
    return new Note({ amount, assetId, pubKey: keypair.pubKey, label });
  }

  /** A note payable to another account's public address, carrying `label`. */
  static to(addr: PublicAddress, amount: bigint, assetId: bigint, label: bigint): Note {
    return new Note({ amount, assetId, pubKey: addr.pubKey, label });
  }

  /** An empty padding note (amount 0) with a fresh blinding so its nullifier is unique. */
  static zero(pubKey: bigint, assetId: bigint = 0n, label: bigint = 0n): Note {
    return new Note({ amount: 0n, assetId, pubKey, blinding: randomField(), label });
  }

  commitment(): bigint {
    return poseidon([this.amount, this.assetId, this.pubKey, this.blinding, this.label]);
  }

  nullifier(keypair: Keypair, merkleIndex: number | bigint): bigint {
    const idx = BigInt(merkleIndex);
    const c = this.commitment();
    const sign = keypair.sign(c, idx);
    return poseidon([c, idx, sign]);
  }

  /** ECIES-encrypt {amount, assetId, blinding} to `viewPub`. pubKey is implicit
   *  (the recipient's own), so it is not shipped. Layout: ephPub(33)|nonce(24)|ct. */
  encryptTo(viewPub: Uint8Array): `0x${string}` {
    const eph = secp256k1.utils.randomSecretKey
      ? secp256k1.utils.randomSecretKey()
      : (secp256k1.utils as any).randomPrivateKey();
    const ephPub = secp256k1.getPublicKey(eph, true);
    const shared = secp256k1.getSharedSecret(eph, viewPub);
    const key = hkdf(sha256, shared, undefined, HKDF_INFO, 32);
    const nonce = new Uint8Array(24);
    crypto.getRandomValues(nonce);
    const plaintext = new Uint8Array(128);
    plaintext.set(beBytes32(this.amount), 0);
    plaintext.set(beBytes32(this.assetId), 32);
    plaintext.set(beBytes32(this.blinding), 64);
    plaintext.set(beBytes32(this.label), 96);
    const ct = xchacha20poly1305(key, nonce).encrypt(plaintext);
    const out = new Uint8Array(33 + 24 + ct.length);
    out.set(ephPub, 0);
    out.set(nonce, 33);
    out.set(ct, 57);
    return bytesToHex(out) as `0x${string}`;
  }

  /** Trial-decrypt an event payload for `keypair`. Returns the Note or null. */
  static tryDecrypt(keypair: Keypair, payloadHex: string): Note | null {
    try {
      const data = hexToBytes(payloadHex);
      if (data.length < 57 + 16) return null;
      const ephPub = data.slice(0, 33);
      const nonce = data.slice(33, 57);
      const ct = data.slice(57);
      const shared = secp256k1.getSharedSecret(keypair.viewKey, ephPub);
      const key = hkdf(sha256, shared, undefined, HKDF_INFO, 32);
      const pt = xchacha20poly1305(key, nonce).decrypt(ct);
      if (pt.length !== 128) return null;
      return new Note({
        amount: fromBeBytes(pt.slice(0, 32)),
        assetId: fromBeBytes(pt.slice(32, 64)),
        pubKey: keypair.pubKey,
        blinding: fromBeBytes(pt.slice(64, 96)),
        label: fromBeBytes(pt.slice(96, 128)),
      });
    } catch {
      return null;
    }
  }
}
