// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUniversalRouter, IWETH, PoolKey, ExactInputSingleParams} from "./interfaces/IUniswapV4.sol";
import {ISwapRouter, IUniV2Pair} from "./interfaces/ISwapRouter.sol";

/// @title SwapExecutor — multi-DEX router wrapper for Sherwood's swap leg (Robinhood Chain).
/// @notice Custody-free: swaps the exact `amountIn` it was funded with and forwards the
///         entire output to the caller (the pool). Holds no balance between calls.
///
///         Robinhood Chain spreads liquidity across three Uniswap versions with two hubs:
///           - v4: native ETH <-> USDG (ETH = address(0), not WETH).
///           - v3: WETH <-> CASHCAT / JUGGERNAUT.
///           - v2: WETH <-> HOODRAT / VIRTUAL, and VEX <-> VIRTUAL.
///         Sherwood's pool is ERC20-only and represents "ETH" as WETH, so this contract
///         routes every swap through the **WETH hub**: tokenIn -> WETH -> tokenOut. Each
///         spoke knows its DEX/pool; USDG's spoke unwraps/wraps WETH<->ETH for the v4 leg.
contract SwapExecutor {
    using SafeERC20 for IERC20;

    // ---- Robinhood Chain mainnet ----
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904; // v4
    address internal constant V3_ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2; // SwapRouter02
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant NATIVE = address(0);

    // Meme tokens
    address internal constant CASHCAT = 0x020bfC650A365f8BB26819deAAbF3E21291018b4; // v3
    address internal constant JUGGERNAUT = 0xD7321801CAae694090694Ff55A9323139F043B88; // v3
    address internal constant HOODRAT = 0x8e62F281f282686fCa6dCB39288069a93fC23F1c; // v2
    address internal constant VIRTUAL = 0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31; // v2
    address internal constant VEX = 0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b; // v2 (via VIRTUAL)

    // Tokenized stocks — hookless v4 pools paired with **native ETH** (same working leg as USDG).
    address internal constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address internal constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    // v2 pairs
    address internal constant PAIR_HOODRAT = 0x451c0DA3b774045a822A129eeDcc5C667DcbfDD8; // WETH/HOODRAT
    address internal constant PAIR_VIRTUAL = 0xd95e8e2Cd04c207625C6F23c974d365a5F3A91D3; // WETH/VIRTUAL
    address internal constant PAIR_VEX = 0x817f16F5D8da83d1B089B082c0172af3923618dA; // VEX/VIRTUAL

    // Fee tiers
    uint24 internal constant V4_ETH_USDG_FEE = 500;
    int24 internal constant V4_ETH_USDG_TS = 10;
    uint24 internal constant V3_MEME_FEE = 10000;
    // Deepest hookless ETH/<stock> v4 pools on Robinhood Chain (fee 5%, tickSpacing 1000).
    uint24 internal constant V4_STOCK_FEE = 50000;
    int24 internal constant V4_STOCK_TS = 1000;

    // Universal Router command + v4 actions.
    bytes1 internal constant CMD_V4_SWAP = 0x10;
    uint8 internal constant ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant ACTION_SETTLE = 0x0b;
    uint8 internal constant ACTION_TAKE_ALL = 0x0f;

    error SwapFailed();
    error UnsupportedToken();

    receive() external payable {} // native ETH from unwrap + v4 take

    /// @notice Swap `amountIn` of `tokenIn` (already transferred here) into `tokenOut`,
    ///         routed through the WETH hub, forwarding proceeds to the caller (the pool).
    ///         `fee` is ignored — routes/fees are derived internally.
    function swap(
        address tokenIn,
        address tokenOut,
        uint24, /* fee (unused) */
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline,
        address /* recipient (forced to caller) */
    ) external returns (uint256 amountOut) {
        require(block.timestamp <= deadline, "swap expired");
        uint256 wethAmt = _toWeth(tokenIn, amountIn);
        amountOut = _fromWeth(tokenOut, wethAmt);
        if (amountOut < amountOutMinimum) revert SwapFailed();
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    }

    /// @dev Convert `token` -> WETH (identity if already WETH).
    function _toWeth(address token, uint256 amt) internal returns (uint256) {
        if (token == WETH) return amt;
        if (token == USDG) return _usdgToWeth(amt);
        if (token == CASHCAT || token == JUGGERNAUT) return _v3(token, WETH, amt);
        if (token == HOODRAT) return _v2(PAIR_HOODRAT, HOODRAT, WETH, amt);
        if (token == VIRTUAL) return _v2(PAIR_VIRTUAL, VIRTUAL, WETH, amt);
        if (token == VEX) return _v2(PAIR_VIRTUAL, VIRTUAL, WETH, _v2(PAIR_VEX, VEX, VIRTUAL, amt));
        if (token == AAPL || token == TSLA || token == NVDA) return _stockToWeth(token, amt);
        revert UnsupportedToken();
    }

    /// @dev Convert WETH -> `token` (identity if target is WETH).
    function _fromWeth(address token, uint256 weth) internal returns (uint256) {
        if (token == WETH) return weth;
        if (token == USDG) return _wethToUsdg(weth);
        if (token == CASHCAT || token == JUGGERNAUT) return _v3(WETH, token, weth);
        if (token == HOODRAT) return _v2(PAIR_HOODRAT, WETH, HOODRAT, weth);
        if (token == VIRTUAL) return _v2(PAIR_VIRTUAL, WETH, VIRTUAL, weth);
        if (token == VEX) return _v2(PAIR_VEX, VIRTUAL, VEX, _v2(PAIR_VIRTUAL, WETH, VIRTUAL, weth));
        if (token == AAPL || token == TSLA || token == NVDA) return _wethToStock(token, weth);
        revert UnsupportedToken();
    }

    // ---------- Uniswap v3 (SwapRouter02, deadline-less) ----------
    function _v3(address tokenIn, address tokenOut, uint256 amtIn) internal returns (uint256 out) {
        IERC20(tokenIn).forceApprove(V3_ROUTER, amtIn);
        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        ISwapRouter(V3_ROUTER).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: V3_MEME_FEE,
                recipient: address(this),
                amountIn: amtIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(tokenIn).forceApprove(V3_ROUTER, 0);
        out = IERC20(tokenOut).balanceOf(address(this)) - before;
    }

    // ---------- Uniswap v2 (low-level pair swap, 0.3% fee) ----------
    function _v2(address pair, address tokenIn, address tokenOut, uint256 amtIn) internal returns (uint256 out) {
        (uint112 r0, uint112 r1,) = IUniV2Pair(pair).getReserves();
        bool inIs0 = tokenIn == IUniV2Pair(pair).token0();
        (uint256 rIn, uint256 rOut) = inIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 amtInWithFee = amtIn * 997;
        uint256 amountOut = (amtInWithFee * rOut) / (rIn * 1000 + amtInWithFee);

        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).safeTransfer(pair, amtIn);
        (uint256 a0, uint256 a1) = inIs0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
        IUniV2Pair(pair).swap(a0, a1, address(this), "");
        out = IERC20(tokenOut).balanceOf(address(this)) - before;
    }

    // ---------- Uniswap v4 (native ETH <-> USDG / stocks via Universal Router) ----------
    function _wethToUsdg(uint256 wethAmt) internal returns (uint256) {
        IWETH(WETH).withdraw(wethAmt); // WETH -> ETH
        return _v4Single(NATIVE, USDG, wethAmt, wethAmt, V4_ETH_USDG_FEE, V4_ETH_USDG_TS);
    }

    function _usdgToWeth(uint256 usdgAmt) internal returns (uint256 wethOut) {
        IERC20(USDG).safeTransfer(UNIVERSAL_ROUTER, usdgAmt); // fund router for SETTLE
        uint256 ethOut = _v4Single(USDG, NATIVE, usdgAmt, 0, V4_ETH_USDG_FEE, V4_ETH_USDG_TS);
        IWETH(WETH).deposit{value: ethOut}(); // ETH -> WETH
        wethOut = ethOut;
    }

    /// @dev WETH -> ETH -> stock (native-ETH v4 leg, the pattern that works for USDG).
    function _wethToStock(address stock, uint256 wethAmt) internal returns (uint256) {
        IWETH(WETH).withdraw(wethAmt); // WETH -> ETH
        return _v4Single(NATIVE, stock, wethAmt, wethAmt, V4_STOCK_FEE, V4_STOCK_TS);
    }

    /// @dev stock -> ETH -> WETH.
    function _stockToWeth(address stock, uint256 amt) internal returns (uint256 wethOut) {
        IERC20(stock).safeTransfer(UNIVERSAL_ROUTER, amt); // fund router for SETTLE
        uint256 ethOut = _v4Single(stock, NATIVE, amt, 0, V4_STOCK_FEE, V4_STOCK_TS);
        IWETH(WETH).deposit{value: ethOut}(); // ETH -> WETH
        wethOut = ethOut;
    }

    function _v4Single(address cin, address cout, uint256 amtIn, uint256 value, uint24 fee, int24 ts)
        internal
        returns (uint256)
    {
        (address c0, address c1) = uint160(cin) < uint160(cout) ? (cin, cout) : (cout, cin);
        bytes memory actions = abi.encodePacked(ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE, ACTION_TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: PoolKey(c0, c1, fee, ts, address(0)),
                zeroForOne: cin == c0,
                amountIn: uint128(amtIn),
                amountOutMinimum: 0,
                hookData: ""
            })
        );
        params[1] = abi.encode(cin, amtIn, false); // SETTLE(currency, amount, payerIsUser=false)
        params[2] = abi.encode(cout, uint256(0)); // TAKE_ALL(currency, minAmount)
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        uint256 before = cout == NATIVE ? address(this).balance : IERC20(cout).balanceOf(address(this));
        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: value}(abi.encodePacked(CMD_V4_SWAP), inputs, block.timestamp);
        return (cout == NATIVE ? address(this).balance : IERC20(cout).balanceOf(address(this))) - before;
    }
}
