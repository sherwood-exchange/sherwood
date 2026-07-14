// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {SherwoodV2Factory} from "../../src/amm/SherwoodV2Factory.sol";
import {SherwoodV2Router} from "../../src/amm/SherwoodV2Router.sol";
import {ISherwoodV2Pair} from "../../src/amm/interfaces/ISherwoodV2Pair.sol";
import {IERC20} from "../../src/amm/interfaces/IERC20.sol";
import {IWETH} from "../../src/amm/interfaces/IWETH.sol";

/// @notice Live-fork sanity run against real WETH/SWOOD on Robinhood Chain mainnet.
///         Fork via https://sherwood.spot/rpc (direct RPC is ISP-blocked here).
contract SherwoodV2ForkTest is Test {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant SWOOD = 0xB1cB27F78B7335df8C3d8ebF0881A15BeD6BeB60;
    string constant RPC = "https://sherwood.spot/rpc";

    SherwoodV2Factory factory;
    SherwoodV2Router router;
    address user = address(0xB0B);

    function setUp() public {
        vm.createSelectFork(RPC);
        factory = new SherwoodV2Factory(address(this));
        router = new SherwoodV2Router(address(factory), WETH);
    }

    function test_Fork_FullLifecycle_RealWETH_SWOOD() public {
        // ---- fund the user with real ETH and real SWOOD ----
        vm.deal(user, 1 ether);
        deal(SWOOD, user, 5_000 ether); // real SWOOD token storage on the fork

        console2.log("chainid            ", block.chainid);
        console2.log("user ETH   (start) ", user.balance);
        console2.log("user SWOOD (start) ", IERC20(SWOOD).balanceOf(user));

        vm.startPrank(user);

        // ---- wrap 0.01 ETH -> real WETH ----
        IWETH(WETH).deposit{value: 0.01 ether}();
        assertEq(IERC20(WETH).balanceOf(user), 0.01 ether, "wrapped 0.01 ETH");
        console2.log("user WETH after wrap", IERC20(WETH).balanceOf(user));

        // ---- createPair(SWOOD, WETH) ----
        address pair = factory.createPair(SWOOD, WETH);
        assertEq(factory.getPair(SWOOD, WETH), pair, "getPair SWOOD,WETH");
        assertEq(factory.getPair(WETH, SWOOD), pair, "getPair WETH,SWOOD reverse");
        assertEq(factory.allPairsLength(), 1);
        console2.log("pair               ", pair);

        _addLiquidity(pair);
        _buy(pair);
        _sell(pair);
        _remove(pair);

        vm.stopPrank();
    }

    function _addLiquidity(address pair) internal {
        // ---- addLiquidityETH: 0.005 ETH + 1000 SWOOD ----
        IERC20(SWOOD).approve(address(router), type(uint256).max);
        (uint256 amtToken, uint256 amtETH, uint256 liquidity) =
            router.addLiquidityETH{value: 0.005 ether}(SWOOD, 1_000 ether, 0, 0, user, block.timestamp);
        console2.log("addLiq SWOOD used  ", amtToken);
        console2.log("addLiq WETH used   ", amtETH);
        console2.log("LP minted          ", liquidity);
        assertGt(liquidity, 0, "LP minted");

        (uint112 r0, uint112 r1,) = ISherwoodV2Pair(pair).getReserves();
        console2.log("reserve0           ", uint256(r0));
        console2.log("reserve1           ", uint256(r1));
    }

    function _buy(address) internal {
        // ---- swapExactETHForTokens: WETH -> SWOOD ----
        address[] memory pathBuy = new address[](2);
        pathBuy[0] = WETH;
        pathBuy[1] = SWOOD;
        uint256 swoodBefore = IERC20(SWOOD).balanceOf(user);
        uint256[] memory quotedBuy = router.getAmountsOut(0.001 ether, pathBuy);
        uint256[] memory gotBuy =
            router.swapExactETHForTokens{value: 0.001 ether}(0, pathBuy, user, block.timestamp);
        uint256 swoodOut = IERC20(SWOOD).balanceOf(user) - swoodBefore;
        console2.log("buy: WETH in       ", uint256(0.001 ether));
        console2.log("buy: SWOOD out     ", swoodOut);
        assertEq(swoodOut, quotedBuy[1], "buy output matches quote");
        assertEq(gotBuy[1], quotedBuy[1], "returned amounts match quote");
        assertGt(swoodOut, 0, "got SWOOD");
    }

    function _sell(address) internal {
        // ---- swapExactTokensForETH: SWOOD -> WETH (back) ----
        address[] memory pathSell = new address[](2);
        pathSell[0] = SWOOD;
        pathSell[1] = WETH;
        uint256 ethBefore = user.balance;
        uint256[] memory quotedSell = router.getAmountsOut(500 ether, pathSell);
        router.swapExactTokensForETH(500 ether, 0, pathSell, user, block.timestamp);
        uint256 ethOut = user.balance - ethBefore;
        console2.log("sell: SWOOD in     ", uint256(500 ether));
        console2.log("sell: ETH out      ", ethOut);
        assertEq(ethOut, quotedSell[1], "sell output matches quote");
        assertGt(ethOut, 0, "got ETH back");
    }

    function _remove(address pair) internal {
        // ---- removeLiquidity: burn all LP ----
        uint256 lpBal = ISherwoodV2Pair(pair).balanceOf(user);
        ISherwoodV2Pair(pair).approve(address(router), lpBal);
        uint256 swoodPre = IERC20(SWOOD).balanceOf(user);
        uint256 ethPre = user.balance;
        (uint256 remToken, uint256 remETH) =
            router.removeLiquidityETH(SWOOD, lpBal, 0, 0, user, block.timestamp);
        console2.log("removeLiq SWOOD out ", remToken);
        console2.log("removeLiq ETH out   ", remETH);
        assertGt(remToken, 0, "remove returns SWOOD");
        assertGt(remETH, 0, "remove returns ETH");
        assertEq(IERC20(SWOOD).balanceOf(user) - swoodPre, remToken, "SWOOD delta matches");
        assertEq(user.balance - ethPre, remETH, "ETH delta matches");
        assertEq(ISherwoodV2Pair(pair).balanceOf(user), 0, "all LP burned");

        // dust reserves (MINIMUM_LIQUIDITY worth) remain locked
        (uint112 fr0, uint112 fr1,) = ISherwoodV2Pair(pair).getReserves();
        console2.log("final reserve0      ", uint256(fr0));
        console2.log("final reserve1      ", uint256(fr1));
        assertGt(uint256(fr0), 0);
        assertGt(uint256(fr1), 0);
    }
}
