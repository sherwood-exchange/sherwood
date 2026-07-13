pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "./merkleTree.circom";

// ForceEqualIfEnabled (force in[0] == in[1] when enabled != 0) comes from
// circomlib/circuits/comparators.circom.

// Multi-asset UTXO join-split with Privacy-Pools association-set compliance.
//   note        = { amount, assetId, pubKey, blinding, label }
//   commitment  = Poseidon(amount, assetId, pubKey, blinding, label)
//   pubKey      = Poseidon(privKey)
//   sign        = Poseidon(privKey, commitment, pathIndices)
//   nullifier   = Poseidon(commitment, pathIndices, sign)
//
// Compliance: every note carries a per-deposit `label`. A DEPOSIT (no real
// inputs) binds its output labels to the public `depositLabel` (revealed so an
// ASP can screen it). A SPEND (real inputs) proves the shared input label is a
// member of the ASP's association tree (`associationRoot`, public) WITHOUT
// revealing which label — so deposits stay unlinkable to withdrawals. Labels
// propagate unchanged to outputs.
template Transaction(levels, assocLevels, nIns, nOuts) {
    // ---- public signals ----
    signal input root;
    signal input publicAmount;
    signal input publicAsset;
    signal input extDataHash;
    signal input associationRoot;      // ASP-approved deposit-label set (spends prove membership)
    signal input depositLabel;         // revealed label for a deposit (unused for spends)
    signal input isDeposit;            // 1 iff no real inputs; lets the contract force deposits to be pure
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];

    // ---- private: inputs ----
    signal input inAmount[nIns];
    signal input inAssetId[nIns];
    signal input inPrivateKey[nIns];
    signal input inBlinding[nIns];
    signal input inLabel[nIns];
    signal input inPathIndices[nIns];
    signal input inPathElements[nIns][levels];

    // ---- private: outputs ----
    signal input outAmount[nOuts];
    signal input outAssetId[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];
    signal input outLabel[nOuts];

    // ---- private: compliance ----
    signal input txLabel;                            // the single label shared by all real notes
    signal input assocPathIndices;
    signal input assocPathElements[assocLevels];

    component inPubKey[nIns];
    component inCommit[nIns];
    component inSign[nIns];
    component inNull[nIns];
    component inTree[nIns];
    component inCheckRoot[nIns];
    component inAssetOk[nIns];
    component inLabelOk[nIns];
    component inRange[nIns];
    var sumIns = 0;

    for (var i = 0; i < nIns; i++) {
        inRange[i] = Num2Bits(248);
        inRange[i].in <== inAmount[i];

        inPubKey[i] = Poseidon(1);
        inPubKey[i].inputs[0] <== inPrivateKey[i];

        // commitment = Poseidon(amount, assetId, pubKey, blinding, label)
        inCommit[i] = Poseidon(5);
        inCommit[i].inputs[0] <== inAmount[i];
        inCommit[i].inputs[1] <== inAssetId[i];
        inCommit[i].inputs[2] <== inPubKey[i].out;
        inCommit[i].inputs[3] <== inBlinding[i];
        inCommit[i].inputs[4] <== inLabel[i];

        inSign[i] = Poseidon(3);
        inSign[i].inputs[0] <== inPrivateKey[i];
        inSign[i].inputs[1] <== inCommit[i].out;
        inSign[i].inputs[2] <== inPathIndices[i];

        inNull[i] = Poseidon(3);
        inNull[i].inputs[0] <== inCommit[i].out;
        inNull[i].inputs[1] <== inPathIndices[i];
        inNull[i].inputs[2] <== inSign[i].out;
        inNull[i].out === inputNullifier[i];

        inTree[i] = MerkleProof(levels);
        inTree[i].leaf <== inCommit[i].out;
        inTree[i].pathIndices <== inPathIndices[i];
        for (var j = 0; j < levels; j++) {
            inTree[i].pathElements[j] <== inPathElements[i][j];
        }

        inCheckRoot[i] = ForceEqualIfEnabled();
        inCheckRoot[i].enabled <== inAmount[i];
        inCheckRoot[i].in[0] <== root;
        inCheckRoot[i].in[1] <== inTree[i].root;

        inAssetOk[i] = ForceEqualIfEnabled();
        inAssetOk[i].enabled <== inAmount[i];
        inAssetOk[i].in[0] <== publicAsset;
        inAssetOk[i].in[1] <== inAssetId[i];

        // real inputs must all carry the transaction label
        inLabelOk[i] = ForceEqualIfEnabled();
        inLabelOk[i].enabled <== inAmount[i];
        inLabelOk[i].in[0] <== txLabel;
        inLabelOk[i].in[1] <== inLabel[i];

        sumIns += inAmount[i];
    }

    component outCommit[nOuts];
    component outRange[nOuts];
    component outAssetOk[nOuts];
    component outLabelOk[nOuts];
    var sumOuts = 0;

    for (var i = 0; i < nOuts; i++) {
        outCommit[i] = Poseidon(5);
        outCommit[i].inputs[0] <== outAmount[i];
        outCommit[i].inputs[1] <== outAssetId[i];
        outCommit[i].inputs[2] <== outPubkey[i];
        outCommit[i].inputs[3] <== outBlinding[i];
        outCommit[i].inputs[4] <== outLabel[i];
        outCommit[i].out === outputCommitment[i];

        outRange[i] = Num2Bits(248);
        outRange[i].in <== outAmount[i];

        outAssetOk[i] = ForceEqualIfEnabled();
        outAssetOk[i].enabled <== outAmount[i];
        outAssetOk[i].in[0] <== publicAsset;
        outAssetOk[i].in[1] <== outAssetId[i];

        // outputs inherit the transaction label (so it propagates unchanged)
        outLabelOk[i] = ForceEqualIfEnabled();
        outLabelOk[i].enabled <== outAmount[i];
        outLabelOk[i].in[0] <== txLabel;
        outLabelOk[i].in[1] <== outLabel[i];

        sumOuts += outAmount[i];
    }

    // distinct input nullifiers
    component sameNull = IsEqual();
    sameNull.in[0] <== inputNullifier[0];
    sameNull.in[1] <== inputNullifier[1];
    sameNull.out === 0;

    // value conservation
    sumIns + publicAmount === sumOuts;

    // ---- compliance ----
    // isDeposit == 1 iff there are no real inputs (a shield). Exposed publicly so
    // the contract can require any value-in transaction to be a PURE deposit
    // (else fresh, unscreened value could inherit an already-approved label).
    component isDep = IsZero();
    isDep.in <== sumIns;
    isDeposit === isDep.out;

    // deposit: bind the (revealed) depositLabel to the transaction label
    isDep.out * (txLabel - depositLabel) === 0;

    // spend: prove txLabel is in the ASP association tree (enabled when NOT a deposit)
    component assocTree = MerkleProof(assocLevels);
    assocTree.leaf <== txLabel;
    assocTree.pathIndices <== assocPathIndices;
    for (var j = 0; j < assocLevels; j++) {
        assocTree.pathElements[j] <== assocPathElements[j];
    }
    component assocOk = ForceEqualIfEnabled();
    assocOk.enabled <== 1 - isDep.out; // there are real inputs → must prove membership
    assocOk.in[0] <== associationRoot;
    assocOk.in[1] <== assocTree.root;

    // bind extDataHash into the proof (anti-tamper)
    signal extDataSquare;
    extDataSquare <== extDataHash * extDataHash;
}

component main {
    public [root, publicAmount, publicAsset, extDataHash, associationRoot, depositLabel, isDeposit, inputNullifier, outputCommitment]
} = Transaction(23, 16, 2, 2);
