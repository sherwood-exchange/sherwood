// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifier} from "../interfaces/IVerifier.sol";

/// @notice Test-only verifier — exercises the Sherwood state machine without the
///         proving stack. Replace with the snarkjs-generated Verifier.sol.
contract MockVerifier is IVerifier {
    bool public ok = true;
    function setOk(bool _ok) external { ok = _ok; }
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[11] calldata)
        external view returns (bool) { return ok; }
}
