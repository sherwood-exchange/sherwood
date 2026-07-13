// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal surface of the Uniswap v4 stack used by Sherwood's swap leg on
///         Robinhood Chain. v4 has no per-pool router like v3 — swaps go through the
///         Universal Router (V4_SWAP command) against the singleton PoolManager. Native
///         ETH is `Currency` = address(0). Cross pairs are done as two sequential single
///         swaps through the USDG hub (multi-hop path swaps revert on this router).

/// @dev A v4 pool identity. currency0 < currency1 (sorted); native ETH = address(0).
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @dev Params for the Universal Router's SWAP_EXACT_IN_SINGLE v4 action.
struct ExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;
}

interface IUniversalRouter {
    /// @notice Execute encoded commands (e.g. V4_SWAP) with matching inputs.
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    /// @notice Approve `spender` to pull `amount` of `token` until `expiration`.
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
}
