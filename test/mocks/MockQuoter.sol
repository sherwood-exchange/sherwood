// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRate {
    function rateNum() external view returns (uint256);
    function rateDen() external view returns (uint256);
}

/// @notice QuoterV2-shaped stand-in for the local demo. Reads the paired
///         MockRouter's rate so quotes match what a swap would actually return.
///         Signature matches Uniswap v3 QuoterV2.quoteExactInputSingle.
contract MockQuoter {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    IRate public immutable router;

    constructor(IRate _router) {
        router = _router;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams calldata p)
        external
        view
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)
    {
        amountOut = (p.amountIn * router.rateNum()) / router.rateDen();
        return (amountOut, 0, 0, 90000);
    }
}
