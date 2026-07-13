// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Sherwood} from "../src/Sherwood.sol";
import {SwapExecutor} from "../src/SwapExecutor.sol";
import {MockVerifier} from "../src/verifiers/MockVerifier.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MockUniversalRouter} from "./mocks/MockUniversalRouter.sol";
import {SherwoodHandler} from "./handlers/SherwoodHandler.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";

/// @dev Stateful invariant: under any random sequence of shield/unshield/swap/
///      transfer, the pool's real ERC20 balances always equal the ghost ledger of
///      what it should hold — the Solidity token accounting never becomes
///      insolvent or over-credits. (The ZK layer's value conservation is proven
///      in-circuit; this pins the on-chain flows around it.)
contract SherwoodInvariantTest is Test {
    Sherwood pool;
    MockERC20 usdg;
    MockERC20 aapl;
    SherwoodHandler handler;

    // the executor's hardcoded Robinhood-mainnet hubs — mocks get etched here
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;

    function setUp() public {
        MockVerifier verifier = new MockVerifier();
        SwapExecutor executor = new SwapExecutor();
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        aapl = new MockERC20("Apple Stock Token", "AAPLx", 18);

        // stand in the executor's on-chain DEX infra at its hardcoded addresses
        // (mock AMM defaults to a 1:1 raw rate, matching the handler's ghost ledger)
        vm.etch(WETH, address(new MockWETH()).code);
        vm.etch(UNIVERSAL_ROUTER, address(new MockUniversalRouter()).code);
        vm.deal(UNIVERSAL_ROUTER, 1e30); // ETH side of every mock pool
        usdg.mint(UNIVERSAL_ROUTER, 1e38); // token-side inventory
        aapl.mint(UNIVERSAL_ROUTER, 1e38);
        // register the mock tokens as stocks so both route via the native-ETH v4 leg
        executor.setStockRoute(address(usdg), 3000, 60);
        executor.setStockRoute(address(aapl), 3000, 60);

        address[] memory assets = new address[](2);
        assets[0] = address(usdg);
        assets[1] = address(aapl);
        pool = new Sherwood(IVerifier(address(verifier)), executor, 23, address(this), address(this), assets);

        handler = new SherwoodHandler(pool, usdg, aapl);
        targetContract(address(handler));
    }

    /// The vault holds exactly what the ledger says — no drift, no insolvency.
    function invariant_poolBalancesMatchLedger() public view {
        assertEq(usdg.balanceOf(address(pool)), handler.gUsdg(), "USDG balance drifted from ledger");
        assertEq(aapl.balanceOf(address(pool)), handler.gAapl(), "AAPL balance drifted from ledger");
    }

    /// The pool can always honour every outstanding shielded position (it is never
    /// undercollateralized for any asset).
    function invariant_poolNeverUndercollateralized() public view {
        assertGe(usdg.balanceOf(address(pool)), handler.gUsdg(), "USDG undercollateralized");
        assertGe(aapl.balanceOf(address(pool)), handler.gAapl(), "AAPL undercollateralized");
    }

    /// The executor holds no funds between transactions (custody-free).
    function invariant_executorHoldsNothing() public view {
        assertEq(usdg.balanceOf(address(pool.swapExecutor())), 0, "USDG stuck in executor");
        assertEq(aapl.balanceOf(address(pool.swapExecutor())), 0, "AAPL stuck in executor");
    }
}
