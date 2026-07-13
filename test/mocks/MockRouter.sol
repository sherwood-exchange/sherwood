// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISwapRouter} from "../../src/interfaces/ISwapRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @notice Deterministic Uniswap-V3-router stand-in for tests. Pulls `amountIn`
///         of tokenIn via the standard approve/transferFrom, then mints
///         `amountIn * rateNum / rateDen` of tokenOut to `recipient`. `rate` is
///         set per test to simulate price / slippage. Enforces the router's own
///         `amountOutMinimum` so slippage-revert paths can be exercised.
contract MockRouter is ISwapRouter {
    using SafeERC20 for IERC20;

    uint256 public rateNum = 1;
    uint256 public rateDen = 1;

    function setRate(uint256 num, uint256 den) external {
        rateNum = num;
        rateDen = den;
    }

    function exactInputSingle(ExactInputSingleParams calldata p)
        external
        payable
        override
        returns (uint256 amountOut)
    {
        IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(this), p.amountIn);
        amountOut = (p.amountIn * rateNum) / rateDen;
        require(amountOut >= p.amountOutMinimum, "router: slippage");
        IMintable(p.tokenOut).mint(p.recipient, amountOut);
    }
}
