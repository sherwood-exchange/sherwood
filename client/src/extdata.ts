// ExtData ABI encoding + extDataHash, kept byte-identical to Sherwood.sol so the
// on-chain `keccak256(abi.encode(extData)) % FIELD == proof.extDataHash` check
// passes. Field order here MUST match the Solidity struct exactly.

import { encodeAbiParameters, keccak256 } from "viem";
import { FIELD_SIZE, mod } from "./config.js";

export interface ExtData {
  recipient: `0x${string}`;
  extAmount: bigint; // int256
  assetId: bigint; // uint256 (uint160 of the boundary token)
  relayer: `0x${string}`;
  fee: bigint;
  tokenOut: `0x${string}`; // address(0) => not a swap
  minAmountOut: bigint;
  swapPubKey: bigint;
  swapBlinding: bigint;
  poolFee: number; // uint24
  deadline: bigint;
  swapLabel: bigint; // fresh deposit label for re-shielded swap proceeds
  encryptedOutput1: `0x${string}`;
  encryptedOutput2: `0x${string}`;
  encryptedSwapNote: `0x${string}`;
}

const EXT_DATA_TUPLE = {
  type: "tuple",
  components: [
    { name: "recipient", type: "address" },
    { name: "extAmount", type: "int256" },
    { name: "assetId", type: "uint256" },
    { name: "relayer", type: "address" },
    { name: "fee", type: "uint256" },
    { name: "tokenOut", type: "address" },
    { name: "minAmountOut", type: "uint256" },
    { name: "swapPubKey", type: "uint256" },
    { name: "swapBlinding", type: "uint256" },
    { name: "poolFee", type: "uint24" },
    { name: "deadline", type: "uint256" },
    { name: "swapLabel", type: "uint256" },
    { name: "encryptedOutput1", type: "bytes" },
    { name: "encryptedOutput2", type: "bytes" },
    { name: "encryptedSwapNote", type: "bytes" },
  ],
} as const;

export function encodeExtData(e: ExtData): `0x${string}` {
  return encodeAbiParameters([EXT_DATA_TUPLE], [e as any]);
}

export function extDataHash(e: ExtData): bigint {
  return mod(BigInt(keccak256(encodeExtData(e))), FIELD_SIZE);
}

export const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;
export const EMPTY_BYTES = "0x" as const;
