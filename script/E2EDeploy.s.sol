// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {Sherwood} from "../src/Sherwood.sol";
import {SwapExecutor} from "../src/SwapExecutor.sol";
import {Groth16Verifier} from "../src/verifiers/Verifier.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";
import {ISwapRouter} from "../src/interfaces/ISwapRouter.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";
import {MockRouter} from "../test/mocks/MockRouter.sol";
import {MockQuoter, IRate} from "../test/mocks/MockQuoter.sol";

/// @notice Full local stack for the end-to-end test (anvil). Deploys the REAL
///         Groth16 verifier + a deterministic mock AMM + two mock assets, then
///         writes all addresses to deploy/e2e.local.json for the Node e2e script.
///         Foundry auto-deploys and links the PoseidonT3/T5 libraries.
contract E2EDeploy is Script {
    // anvil account #1 — the "clear" wallet that shields (funded with USDG here).
    address constant SHIELDER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

    function run() external {
        vm.startBroadcast();

        Groth16Verifier verifier = new Groth16Verifier();
        MockRouter router = new MockRouter();
        MockQuoter quoter = new MockQuoter(IRate(address(router)));
        SwapExecutor executor = new SwapExecutor();
        MockERC20 usdg = new MockERC20("Global Dollar", "USDG", 6);
        MockERC20 aapl = new MockERC20("Apple Stock Token", "AAPLx", 18);

        address[] memory assets = new address[](2);
        assets[0] = address(usdg);
        assets[1] = address(aapl);
        // deployer is both owner and ASP for the local demo
        Sherwood pool = new Sherwood(IVerifier(address(verifier)), executor, 23, msg.sender, msg.sender, assets);

        // 1 USDG (6dp) -> 1e12 raw AAPL units (18dp), i.e. price parity by tokens.
        router.setRate(1e12, 1);
        usdg.mint(SHIELDER, 1_000e6);

        vm.stopBroadcast();

        string memory j = "e2e";
        vm.serializeAddress(j, "verifier", address(verifier));
        vm.serializeAddress(j, "router", address(router));
        vm.serializeAddress(j, "quoter", address(quoter));
        vm.serializeAddress(j, "executor", address(executor));
        vm.serializeAddress(j, "usdg", address(usdg));
        vm.serializeAddress(j, "aapl", address(aapl));
        vm.serializeAddress(j, "shielder", SHIELDER);
        string memory out = vm.serializeAddress(j, "pool", address(pool));
        vm.writeJson(out, "./deploy/e2e.local.json");
    }
}
