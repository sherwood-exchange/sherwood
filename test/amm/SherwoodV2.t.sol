// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {SherwoodV2Factory} from "../../src/amm/SherwoodV2Factory.sol";
import {SherwoodV2Router} from "../../src/amm/SherwoodV2Router.sol";
import {SherwoodV2Pair} from "../../src/amm/SherwoodV2Pair.sol";
import {ISherwoodV2Pair} from "../../src/amm/interfaces/ISherwoodV2Pair.sol";
import {Math} from "../../src/amm/libraries/Math.sol";

contract SherwoodV2Test is Test {
    // mirror the events so we can expectEmit against them
    event PairCreated(address indexed token0, address indexed token1, address pair, uint256);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );

    uint256 constant MINIMUM_LIQUIDITY = 1000;

    SherwoodV2Factory factory;
    SherwoodV2Router router;
    MockERC20 tokenA;
    MockERC20 tokenB;

    address feeSetter = address(0xFEE);
    address lp = address(this);
    // WETH is irrelevant for token/token tests; use a nonzero placeholder address.
    address constant WETH_PLACEHOLDER = address(0xE7);

    function setUp() public {
        factory = new SherwoodV2Factory(feeSetter);
        router = new SherwoodV2Router(address(factory), WETH_PLACEHOLDER);
        tokenA = new MockERC20("Token A", "AAA", 18);
        tokenB = new MockERC20("Token B", "BBB", 18);

        tokenA.mint(address(this), 1_000_000 ether);
        tokenB.mint(address(this), 1_000_000 ether);
        tokenA.approve(address(router), type(uint256).max);
        tokenB.approve(address(router), type(uint256).max);
    }

    function test_CreatePair_RegistersBothDirectionsAndEmits() public {
        (address t0, address t1) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));

        vm.expectEmit(true, true, false, false);
        emit PairCreated(t0, t1, address(0), 0); // pair addr + index not checked (checkData=false)
        address pair = factory.createPair(address(tokenA), address(tokenB));

        assertEq(factory.getPair(address(tokenA), address(tokenB)), pair, "getPair A,B");
        assertEq(factory.getPair(address(tokenB), address(tokenA)), pair, "getPair B,A (reverse)");
        assertEq(factory.allPairsLength(), 1, "allPairsLength");
        assertEq(factory.allPairs(0), pair, "allPairs[0]");

        // token0/token1 sorted correctly
        assertEq(ISherwoodV2Pair(pair).token0(), t0, "token0 sorted");
        assertEq(ISherwoodV2Pair(pair).token1(), t1, "token1 sorted");
        assertEq(ISherwoodV2Pair(pair).factory(), address(factory), "pair.factory");

        // LP metadata
        assertEq(ISherwoodV2Pair(pair).symbol(), "SHERWOOD-V2");
        assertEq(ISherwoodV2Pair(pair).decimals(), 18);
    }

    function test_CreatePair_RevertsOnDuplicate() public {
        factory.createPair(address(tokenA), address(tokenB));
        vm.expectRevert(bytes("Sherwood V2: PAIR_EXISTS"));
        factory.createPair(address(tokenB), address(tokenA));
    }

    function test_AddLiquidity_FirstMintEqualsSqrtMinusMinimum() public {
        uint256 amtA = 4_000 ether;
        uint256 amtB = 9_000 ether;

        (,, uint256 liquidity) = router.addLiquidity(
            address(tokenA), address(tokenB), amtA, amtB, 0, 0, lp, block.timestamp
        );

        uint256 expected = Math.sqrt(amtA * amtB) - MINIMUM_LIQUIDITY;
        assertEq(liquidity, expected, "first mint liquidity = sqrt(a*b) - MINIMUM_LIQUIDITY");

        address pair = factory.getPair(address(tokenA), address(tokenB));
        // MINIMUM_LIQUIDITY locked at address(0), plus lp's balance
        assertEq(ISherwoodV2Pair(pair).totalSupply(), expected + MINIMUM_LIQUIDITY, "total supply");
        assertEq(ISherwoodV2Pair(pair).balanceOf(lp), expected, "lp balance");
        assertEq(ISherwoodV2Pair(pair).balanceOf(address(0)), MINIMUM_LIQUIDITY, "locked minimum");

        // reserves match deposits, sorted
        (uint112 r0, uint112 r1,) = ISherwoodV2Pair(pair).getReserves();
        (uint256 expR0, uint256 expR1) =
            address(tokenA) < address(tokenB) ? (amtA, amtB) : (amtB, amtA);
        assertEq(uint256(r0), expR0, "reserve0");
        assertEq(uint256(r1), expR1, "reserve1");
    }

    function test_SecondAddLiquidity_RespectsRatio() public {
        router.addLiquidity(address(tokenA), address(tokenB), 4_000 ether, 8_000 ether, 0, 0, lp, block.timestamp);

        // add at same 1:2 ratio but supply excess B; router should pull only optimal B
        uint256 balBBefore = tokenB.balanceOf(address(this));
        (uint256 usedA, uint256 usedB,) = router.addLiquidity(
            address(tokenA), address(tokenB), 1_000 ether, 5_000 ether, 0, 0, lp, block.timestamp
        );
        assertEq(usedA, 1_000 ether, "usedA");
        assertEq(usedB, 2_000 ether, "usedB optimal at 1:2 ratio");
        assertEq(balBBefore - tokenB.balanceOf(address(this)), 2_000 ether, "only optimal B pulled");
    }

    function test_SwapExactTokensForTokens_BothDirections_MatchQuoteAndGrowK() public {
        router.addLiquidity(address(tokenA), address(tokenB), 100_000 ether, 100_000 ether, 0, 0, lp, block.timestamp);
        address pair = factory.getPair(address(tokenA), address(tokenB));

        uint256 kBefore = _k(pair);

        // ---- direction A -> B ----
        address[] memory pathAB = new address[](2);
        pathAB[0] = address(tokenA);
        pathAB[1] = address(tokenB);
        uint256 amountIn = 1_000 ether;
        uint256[] memory quoted = router.getAmountsOut(amountIn, pathAB);

        uint256 balBBefore = tokenB.balanceOf(address(this));
        vm.expectEmit(false, false, false, false, pair);
        emit Swap(address(0), 0, 0, 0, 0, address(0)); // just assert a Swap fires from the pair
        uint256[] memory got =
            router.swapExactTokensForTokens(amountIn, 0, pathAB, address(this), block.timestamp);
        uint256 received = tokenB.balanceOf(address(this)) - balBBefore;

        assertEq(got[1], quoted[1], "swap output matches getAmountsOut");
        assertEq(received, quoted[1], "received matches quote");
        uint256 kAfterAB = _k(pair);
        assertGt(kAfterAB, kBefore, "k grows after A->B (fee accrues)");

        // ---- direction B -> A ----
        address[] memory pathBA = new address[](2);
        pathBA[0] = address(tokenB);
        pathBA[1] = address(tokenA);
        uint256[] memory quotedBA = router.getAmountsOut(amountIn, pathBA);
        uint256 balABefore = tokenA.balanceOf(address(this));
        uint256[] memory gotBA =
            router.swapExactTokensForTokens(amountIn, 0, pathBA, address(this), block.timestamp);
        uint256 receivedA = tokenA.balanceOf(address(this)) - balABefore;
        assertEq(gotBA[1], quotedBA[1], "B->A output matches quote");
        assertEq(receivedA, quotedBA[1], "B->A received matches quote");
        assertGt(_k(pair), kAfterAB, "k grows again after B->A");
    }

    function test_RemoveLiquidity_ProportionalReturn() public {
        (,, uint256 liquidity) = router.addLiquidity(
            address(tokenA), address(tokenB), 5_000 ether, 20_000 ether, 0, 0, lp, block.timestamp
        );
        address pair = factory.getPair(address(tokenA), address(tokenB));

        uint256 total = ISherwoodV2Pair(pair).totalSupply();
        (uint112 r0, uint112 r1,) = ISherwoodV2Pair(pair).getReserves();
        // burning `liquidity` should return liquidity/total of each reserve
        uint256 expA;
        uint256 expB;
        {
            (uint256 rA, uint256 rB) =
                address(tokenA) < address(tokenB) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
            expA = liquidity * rA / total;
            expB = liquidity * rB / total;
        }

        ISherwoodV2Pair(pair).approve(address(router), liquidity);
        uint256 balABefore = tokenA.balanceOf(address(this));
        uint256 balBBefore = tokenB.balanceOf(address(this));
        (uint256 amountA, uint256 amountB) = router.removeLiquidity(
            address(tokenA), address(tokenB), liquidity, 0, 0, address(this), block.timestamp
        );

        assertEq(amountA, expA, "proportional A returned");
        assertEq(amountB, expB, "proportional B returned");
        assertEq(tokenA.balanceOf(address(this)) - balABefore, expA, "A balance delta");
        assertEq(tokenB.balanceOf(address(this)) - balBBefore, expB, "B balance delta");
        // MINIMUM_LIQUIDITY worth remains locked
        assertEq(ISherwoodV2Pair(pair).balanceOf(lp), 0, "all lp burned");
        assertEq(ISherwoodV2Pair(pair).totalSupply(), MINIMUM_LIQUIDITY, "minimum liquidity remains");
    }

    function test_PairCodeHash_MatchesCreationCode() public view {
        assertEq(factory.pairCodeHash(), keccak256(type(SherwoodV2Pair).creationCode));
    }

    function _k(address pair) internal view returns (uint256) {
        (uint112 r0, uint112 r1,) = ISherwoodV2Pair(pair).getReserves();
        return uint256(r0) * uint256(r1);
    }
}
