// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal wrapped-native interface (WETH9 shape) used by the router.
interface IWETH {
    function deposit() external payable;
    function transfer(address to, uint256 value) external returns (bool);
    function withdraw(uint256) external;
}
