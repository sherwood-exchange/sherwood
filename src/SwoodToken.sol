// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title $SWOOD — Sherwood utility & governance token.
/// @notice Trust-minimized by construction: the ENTIRE fixed supply is minted once at
///         deploy to `treasury`, and there is NO mint function afterwards. No owner, no
///         pause, no blacklist, no fee-on-transfer, no upgradeability. What you see is
///         all there will ever be — the supply cannot be inflated and transfers cannot
///         be frozen. EIP-2612 `permit` is supported for gasless approvals.
/// @dev Distribution (airdrop / launchpad / liquidity / vesting) is handled OUTSIDE this
///      contract by sending from `treasury` (use a multisig + on-chain vesting/locks).
contract SwoodToken is ERC20, ERC20Permit {
    /// @notice Immutable total supply: 1,000,000,000 SWOOD.
    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;

    /// @param treasury receives 100% of supply at deploy (should be a multisig).
    constructor(address treasury) ERC20("Sherwood", "SWOOD") ERC20Permit("Sherwood") {
        require(treasury != address(0), "treasury=0");
        _mint(treasury, MAX_SUPPLY);
    }
}
