// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Sherwood} from "../src/Sherwood.sol";
import {SwapExecutor} from "../src/SwapExecutor.sol";
import {Groth16Verifier} from "../src/verifiers/Verifier.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";
import {ISwapRouter} from "../src/interfaces/ISwapRouter.sol";
import {MockRouter} from "../test/mocks/MockRouter.sol";

/// @notice Deploy the Sherwood stack to Robinhood Chain testnet with a
///         multi-asset allowlist. Env:
///           ASSETS   comma-separated token addresses (the allowlist)   — required
///           ROUTER   Uniswap SwapRouter02 (optional; a MockRouter placeholder is
///                    deployed if unset — swap stays untested, other actions work)
///           OWNER    allowlist admin (defaults to broadcaster)
///           ASP      association-set provider (defaults to OWNER)
///           LEVELS   tree depth (=23)
///         Writes all addresses to deploy/testnet.json.
contract DeployTestnet is Script {
    function run() external {
        address[] memory assets = vm.envAddress("ASSETS", ",");
        require(assets.length > 0, "ASSETS empty");
        uint32 levels = uint32(vm.envOr("LEVELS", uint256(23)));

        vm.startBroadcast();
        address owner = vm.envOr("OWNER", msg.sender);
        address asp = vm.envOr("ASP", owner);
        address router = vm.envOr("ROUTER", address(0));
        if (router == address(0)) router = address(new MockRouter()); // placeholder; swap untested

        Groth16Verifier verifier = new Groth16Verifier();
        SwapExecutor executor = new SwapExecutor();
        Sherwood pool = new Sherwood(IVerifier(address(verifier)), executor, levels, owner, asp, assets);
        vm.stopBroadcast();

        console2.log("Verifier:    ", address(verifier));
        console2.log("SwapExecutor:", address(executor));
        console2.log("Router:      ", router);
        console2.log("Sherwood:    ", address(pool));

        string memory j = "testnet";
        vm.serializeAddress(j, "verifier", address(verifier));
        vm.serializeAddress(j, "executor", address(executor));
        vm.serializeAddress(j, "router", router);
        vm.serializeAddress(j, "assets", assets);
        string memory out = vm.serializeAddress(j, "pool", address(pool));
        vm.writeJson(out, "./deploy/testnet.json");
    }
}
