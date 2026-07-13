// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";

/// @title MerkleTreeWithHistory (pair-insert)
/// @notice Append-only Poseidon Merkle tree over BN254. Inserts leaves two at a
///         time (one UTXO transaction produces two output notes), which halves
///         the work and matches the join-split circuit. Keeps a rolling window
///         of recent roots so a proof can reference any recently-valid root.
contract MerkleTreeWithHistory {
    uint256 public constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // keccak256("sherwood.v1") % FIELD_SIZE — the empty-leaf value.
    uint256 public constant ZERO_VALUE =
        17242179440202835624415648542940796277869244002882800752906823721480933474798;

    uint32 public constant ROOT_HISTORY_SIZE = 100;
    uint32 public immutable levels;

    mapping(uint256 => uint256) public filledSubtrees;
    mapping(uint256 => uint256) public roots;
    mapping(uint256 => uint256) private _zeros;

    uint32 public currentRootIndex;
    uint32 public nextIndex;

    constructor(uint32 _levels) {
        require(_levels > 0 && _levels < 32, "levels out of range");
        levels = _levels;

        uint256 currentZero = ZERO_VALUE;
        for (uint32 i = 0; i < _levels; i++) {
            _zeros[i] = currentZero;
            filledSubtrees[i] = currentZero;
            currentZero = hashLeftRight(currentZero, currentZero);
        }
        roots[0] = currentZero; // root of the empty tree
    }

    function hashLeftRight(uint256 left, uint256 right) public pure returns (uint256) {
        require(left < FIELD_SIZE, "left out of field");
        require(right < FIELD_SIZE, "right out of field");
        uint256[2] memory input;
        input[0] = left;
        input[1] = right;
        return PoseidonT3.hash(input);
    }

    /// @dev Inserts a pair of leaves; the pair forms the level-1 node. Returns
    ///      the index of the first leaf.
    function _insert(uint256 leaf1, uint256 leaf2) internal returns (uint32 index) {
        uint32 _nextIndex = nextIndex;
        require(_nextIndex != uint32(2) ** levels, "merkle tree is full");

        uint32 indexPair = _nextIndex / 2;
        uint256 currentLevelHash = hashLeftRight(leaf1, leaf2);
        uint256 left;
        uint256 right;

        for (uint32 i = 1; i < levels; i++) {
            if (indexPair % 2 == 0) {
                left = currentLevelHash;
                right = _zeros[i];
                filledSubtrees[i] = currentLevelHash;
            } else {
                left = filledSubtrees[i];
                right = currentLevelHash;
            }
            currentLevelHash = hashLeftRight(left, right);
            indexPair /= 2;
        }

        uint32 newRootIndex = (currentRootIndex + 1) % ROOT_HISTORY_SIZE;
        currentRootIndex = newRootIndex;
        roots[newRootIndex] = currentLevelHash;
        nextIndex = _nextIndex + 2;
        return _nextIndex;
    }

    function isKnownRoot(uint256 root) public view returns (bool) {
        if (root == 0) return false;
        uint32 _currentRootIndex = currentRootIndex;
        uint32 i = _currentRootIndex;
        do {
            if (root == roots[i]) return true;
            if (i == 0) i = ROOT_HISTORY_SIZE;
            i--;
        } while (i != _currentRootIndex);
        return false;
    }

    function getLastRoot() public view returns (uint256) {
        return roots[currentRootIndex];
    }
}
