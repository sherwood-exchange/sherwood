// Emit Poseidon parity vectors so Solidity (poseidon-solidity) and the circuit
// (circomlib) can be pinned to identical outputs in a Foundry test.
import { buildPoseidon } from "circomlibjs";

const poseidon = await buildPoseidon();
const F = poseidon.F;

function h(arr) {
  return F.toString(poseidon(arr.map((x) => BigInt(x))));
}

const vec2 = ["1", "2"];
const vec4 = ["100", "1461501637330902918203684832716283019655932542976", "7", "9999"]; // amount, uint160(addr), pubkey, blinding
const vec4b = ["0", "0", "0", "0"];

console.log(JSON.stringify({
  poseidon2_1_2: h(vec2),
  poseidon4_vecA: h(vec4),
  poseidon4_zero: h(vec4b),
}, null, 2));
