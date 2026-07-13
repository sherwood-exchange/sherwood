// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @notice Deterministic SwapExecutor stand-in for the local anvil e2e (the real
///         SwapExecutor routes through hardcoded Robinhood-mainnet DEX hubs, which
///         do not exist on anvil — see Sherwood.t.sol, which vm.etch-es mocks at
///         those addresses instead; etch cannot persist through a broadcast).
///         Matches the real executor's calling convention: the pool transfers
///         `amountIn` of `tokenIn` here BEFORE calling `swap`, and the entire
///         output goes to the caller (the pool). Mints `amountIn * rateNum /
///         rateDen` of `tokenOut`. Exposes rateNum/rateDen (MockQuoter's IRate)
///         so quotes match what a swap actually returns.
contract MockSwapExecutor {
    uint256 public rateNum = 1;
    uint256 public rateDen = 1;

    function setRate(uint256 num, uint256 den) external {
        rateNum = num;
        rateDen = den;
    }

    function swap(
        address, /* tokenIn (already transferred here by the pool) */
        address tokenOut,
        uint24, /* fee (unused, like the real executor) */
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline,
        address /* recipient (forced to caller, like the real executor) */
    ) external returns (uint256 amountOut) {
        require(block.timestamp <= deadline, "swap expired");
        amountOut = (amountIn * rateNum) / rateDen;
        require(amountOut >= amountOutMinimum, "router: slippage");
        IMintable(tokenOut).mint(msg.sender, amountOut);
    }
}
