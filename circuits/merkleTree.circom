pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";

// s == 0 -> [in0,in1] ; s == 1 -> [in1,in0]
template DualMux() {
    signal input in[2];
    signal input s;
    signal output out[2];
    s * (1 - s) === 0;
    out[0] <== (in[1] - in[0]) * s + in[0];
    out[1] <== (in[0] - in[1]) * s + in[1];
}

// Reconstructs the Merkle root for `leaf` at position `pathIndices`
// (a single number decomposed to per-level bits) with `pathElements` siblings.
template MerkleProof(levels) {
    signal input leaf;
    signal input pathIndices;
    signal input pathElements[levels];
    signal output root;

    component bits = Num2Bits(levels);
    bits.in <== pathIndices;

    component mux[levels];
    component hasher[levels];
    signal levelHash[levels + 1];
    levelHash[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        mux[i] = DualMux();
        mux[i].in[0] <== levelHash[i];
        mux[i].in[1] <== pathElements[i];
        mux[i].s <== bits.out[i];

        hasher[i] = Poseidon(2);
        hasher[i].inputs[0] <== mux[i].out[0];
        hasher[i].inputs[1] <== mux[i].out[1];
        levelHash[i + 1] <== hasher[i].out;
    }
    root <== levelHash[levels];
}
