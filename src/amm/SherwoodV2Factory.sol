// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SherwoodV2Pair} from "./SherwoodV2Pair.sol";
import {ISherwoodV2Pair} from "./interfaces/ISherwoodV2Pair.sol";

/// @title  SherwoodV2Factory
/// @notice Faithful port of Uniswap V2's UniswapV2Factory to Solidity 0.8.24.
/// @dev    The `PairCreated` event signature is preserved EXACTLY — DexScreener
///         and other indexers key off it. Pairs are CREATE2-deployed with
///         salt = keccak256(token0, token1), so pair addresses are deterministic.
contract SherwoodV2Factory {
    address public feeTo;
    address public feeToSetter;

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256);

    constructor(address _feeToSetter) {
        feeToSetter = _feeToSetter;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @notice keccak256 of the pair creation bytecode — for router/init-hash checks.
    function pairCodeHash() external pure returns (bytes32) {
        return keccak256(type(SherwoodV2Pair).creationCode);
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "Sherwood V2: IDENTICAL_ADDRESSES");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "Sherwood V2: ZERO_ADDRESS");
        require(getPair[token0][token1] == address(0), "Sherwood V2: PAIR_EXISTS"); // single check is sufficient
        bytes memory bytecode = type(SherwoodV2Pair).creationCode;
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        assembly {
            pair := create2(0, add(bytecode, 32), mload(bytecode), salt)
        }
        ISherwoodV2Pair(pair).initialize(token0, token1);
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair; // populate mapping in the reverse direction
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function setFeeTo(address _feeTo) external {
        require(msg.sender == feeToSetter, "Sherwood V2: FORBIDDEN");
        feeTo = _feeTo;
    }

    function setFeeToSetter(address _feeToSetter) external {
        require(msg.sender == feeToSetter, "Sherwood V2: FORBIDDEN");
        feeToSetter = _feeToSetter;
    }
}
