// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Sherwood} from "../src/Sherwood.sol";
import {SwapExecutor} from "../src/SwapExecutor.sol";
import {Groth16Verifier} from "../src/verifiers/Verifier.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";
import {ISwapRouter} from "../src/interfaces/ISwapRouter.sol";

/// @notice Deploys the full Sherwood stack to Robinhood Chain.
///
/// Env:
///   ROUTER   Uniswap V3 SwapRouter on Robinhood Chain (fill from RH-Chain docs)
///   LEVELS   tree depth (=23, must match Transaction(23,..) in the circuit)
///   OWNER    allowlist admin (defaults to the broadcaster)
///   ASSET_0  first supported asset (e.g. USDG)   — required
///   ASSET_1  second supported asset (e.g. a Stock Token) — optional (0 to skip)
///
/// Deploy order: Verifier -> SwapExecutor(router) -> Sherwood(verifier, executor,
/// levels, owner, [assets]). The verifier is the snarkjs-generated Groth16Verifier
/// for the join-split circuit.
contract Deploy is Script {
    function run() external returns (Sherwood pool, SwapExecutor executor, address verifier) {
        address router = vm.envAddress("ROUTER");
        uint32 levels = uint32(vm.envOr("LEVELS", uint256(23)));
        address asset0 = vm.envAddress("ASSET_0");
        address asset1 = vm.envOr("ASSET_1", address(0));

        uint256 n = asset1 == address(0) ? 1 : 2;
        address[] memory assets = new address[](n);
        assets[0] = asset0;
        if (n == 2) assets[1] = asset1;

        vm.startBroadcast();
        // default the allowlist owner + ASP to the broadcasting deployer
        address owner = vm.envOr("OWNER", msg.sender);
        address aspAddr = vm.envOr("ASP", owner);
        verifier = address(new Groth16Verifier());
        executor = new SwapExecutor();
        pool = new Sherwood(IVerifier(verifier), executor, levels, owner, aspAddr, assets);
        vm.stopBroadcast();

        console2.log("Verifier:    ", verifier);
        console2.log("SwapExecutor:", address(executor));
        console2.log("Sherwood:    ", address(pool));
    }
}
