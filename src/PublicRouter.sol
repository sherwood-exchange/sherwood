// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IUniversalRouter, IWETH, PoolKey, ExactInputSingleParams} from "./interfaces/IUniswapV4.sol";

/// @title PublicRouter — non-custodial any-token swap router for Robinhood Chain (public mode).
/// @notice Powers Sherwood's public aggregator ("Swap" tab): a plain on-chain swap, NOT the
///         shielded pool. Routes `tokenIn -> ETH -> tokenOut` through hookless Uniswap v4
///         native-ETH pools — the same working leg the shielded SwapExecutor uses for USDG —
///         so it covers the whole ETH-paired v4 token universe. The pool fee/tickSpacing for
///         each leg are supplied by the off-chain router (best-liquidity pool per token).
///
///         Custody-free: it swaps exactly the `amountIn` pulled from the caller and forwards
///         the entire output to `recipient`, holding no balance between calls.
contract PublicRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant NATIVE = address(0);

    bytes1 internal constant CMD_V4_SWAP = 0x10;
    uint8 internal constant ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant ACTION_SETTLE = 0x0b;
    uint8 internal constant ACTION_TAKE_ALL = 0x0f;

    error Expired();
    error Slippage();
    error BadValue();
    error EthSendFailed();

    event PublicSwap(address indexed tokenIn, address indexed tokenOut, address indexed recipient, uint256 amountIn, uint256 amountOut);

    receive() external payable {} // native ETH from v4 TAKE + WETH unwrap

    /// @notice Swap `amountIn` of `tokenIn` into `tokenOut`, routed through the ETH hub, and
    ///         send the proceeds to `recipient`. Native ETH is `address(0)` (pass it as msg.value).
    ///         `feeIn/tsIn` describe the tokenIn/ETH pool; `feeOut/tsOut` the ETH/tokenOut pool
    ///         (ignored for a WETH/native leg). Reverts (no state change) if output < `minOut`.
    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint24 feeIn,
        int24 tsIn,
        uint24 feeOut,
        int24 tsOut,
        uint256 deadline,
        address recipient
    ) external payable nonReentrant returns (uint256 out) {
        if (block.timestamp > deadline) revert Expired();
        require(recipient != address(0), "recipient=0");
        require(tokenIn != tokenOut, "tokenIn==tokenOut");

        // 1) tokenIn -> ETH
        uint256 ethMid = _toEth(tokenIn, amountIn, feeIn, tsIn);

        // 2) ETH -> tokenOut
        if (tokenOut == NATIVE) {
            out = ethMid;
            (bool ok,) = recipient.call{value: out}("");
            if (!ok) revert EthSendFailed();
        } else if (tokenOut == WETH) {
            IWETH(WETH).deposit{value: ethMid}();
            out = ethMid;
            IERC20(WETH).safeTransfer(recipient, out);
        } else {
            out = _v4(NATIVE, tokenOut, ethMid, ethMid, feeOut, tsOut);
            IERC20(tokenOut).safeTransfer(recipient, out);
        }

        if (out < minOut) revert Slippage();
        emit PublicSwap(tokenIn, tokenOut, recipient, amountIn, out);
    }

    /// @dev Bring `amountIn` of `tokenIn` into this contract as native ETH.
    function _toEth(address tokenIn, uint256 amountIn, uint24 feeIn, int24 tsIn) internal returns (uint256) {
        if (tokenIn == NATIVE) {
            if (msg.value != amountIn) revert BadValue();
            return amountIn;
        }
        if (msg.value != 0) revert BadValue();
        if (tokenIn == WETH) {
            IERC20(WETH).safeTransferFrom(msg.sender, address(this), amountIn);
            IWETH(WETH).withdraw(amountIn); // WETH -> ETH
            return amountIn;
        }
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).safeTransfer(UNIVERSAL_ROUTER, amountIn); // fund router for SETTLE
        return _v4(tokenIn, NATIVE, amountIn, 0, feeIn, tsIn);
    }

    function _v4(address cin, address cout, uint256 amtIn, uint256 value, uint24 fee, int24 ts)
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
