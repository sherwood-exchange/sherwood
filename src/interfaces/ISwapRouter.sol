// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Uniswap **v3 SwapRouter02** surface (params struct has NO `deadline`) plus the
///         minimal **v2 pair** surface. Used by Sherwood's multi-DEX swap leg on Robinhood
///         Chain, where meme tokens trade against WETH on Uniswap v2/v3.
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

/// @notice Minimal Uniswap v2 pair surface for low-level swaps (no router needed).
interface IUniV2Pair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}
