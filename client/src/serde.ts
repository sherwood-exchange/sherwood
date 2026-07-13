// Wire (de)serialization for a BuiltTx: bigints -> decimal strings and back, so
// { proof, extData } can travel over HTTP between the SDK client and the relayer.

import type { BuiltTx } from "./pool.js";
import type { SolidityProof } from "./prover.js";
import type { ExtData } from "./extdata.js";

const s = (x: bigint) => x.toString();

export function serializeBuiltTx(tx: BuiltTx): any {
  const p = tx.proof;
  return {
    proof: {
      a: p.a.map(s),
      b: p.b.map((row) => row.map(s)),
      c: p.c.map(s),
      root: s(p.root),
      publicAmount: s(p.publicAmount),
      publicAsset: s(p.publicAsset),
      extDataHash: s(p.extDataHash),
      associationRoot: s(p.associationRoot),
      depositLabel: s(p.depositLabel),
      isDeposit: s(p.isDeposit),
      inputNullifiers: p.inputNullifiers.map(s),
      outputCommitments: p.outputCommitments.map(s),
    },
    extData: {
      ...tx.extData,
      extAmount: s(tx.extData.extAmount),
      assetId: s(tx.extData.assetId),
      fee: s(tx.extData.fee),
      minAmountOut: s(tx.extData.minAmountOut),
      swapPubKey: s(tx.extData.swapPubKey),
      swapBlinding: s(tx.extData.swapBlinding),
      deadline: s(tx.extData.deadline),
      swapLabel: s(tx.extData.swapLabel),
    },
  };
}

export function deserializeBuiltTx(j: any): BuiltTx {
  const P = j.proof;
  const proof: SolidityProof = {
    a: [BigInt(P.a[0]), BigInt(P.a[1])],
    b: [
      [BigInt(P.b[0][0]), BigInt(P.b[0][1])],
      [BigInt(P.b[1][0]), BigInt(P.b[1][1])],
    ],
    c: [BigInt(P.c[0]), BigInt(P.c[1])],
    root: BigInt(P.root),
    publicAmount: BigInt(P.publicAmount),
    publicAsset: BigInt(P.publicAsset),
    extDataHash: BigInt(P.extDataHash),
    associationRoot: BigInt(P.associationRoot),
    depositLabel: BigInt(P.depositLabel),
    isDeposit: BigInt(P.isDeposit),
    inputNullifiers: [BigInt(P.inputNullifiers[0]), BigInt(P.inputNullifiers[1])],
    outputCommitments: [BigInt(P.outputCommitments[0]), BigInt(P.outputCommitments[1])],
  };
  const E = j.extData;
  const extData: ExtData = {
    recipient: E.recipient,
    extAmount: BigInt(E.extAmount),
    assetId: BigInt(E.assetId),
    relayer: E.relayer,
    fee: BigInt(E.fee),
    tokenOut: E.tokenOut,
    minAmountOut: BigInt(E.minAmountOut),
    swapPubKey: BigInt(E.swapPubKey),
    swapBlinding: BigInt(E.swapBlinding),
    poolFee: Number(E.poolFee),
    deadline: BigInt(E.deadline),
    swapLabel: BigInt(E.swapLabel),
    encryptedOutput1: E.encryptedOutput1,
    encryptedOutput2: E.encryptedOutput2,
    encryptedSwapNote: E.encryptedSwapNote,
  };
  return { proof, extData };
}
