// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Groth16 verifier for the labeled multi-asset join-split circuit with
///         association-set compliance. Public signals (order fixed by
///         circuits/transaction.circom):
///         [root, publicAmount, publicAsset, extDataHash, associationRoot,
///          depositLabel, isDeposit, inNullifier0, inNullifier1,
///          outCommitment0, outCommitment1]
interface IVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[11] calldata input
    ) external view returns (bool);
}
