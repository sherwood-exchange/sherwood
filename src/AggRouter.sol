// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IUniversalRouter, IWETH, PoolKey, ExactInputSingleParams} from "./interfaces/IUniswapV4.sol";
import {ISwapRouter, IUniV2Pair} from "./interfaces/ISwapRouter.sol";

/// @title AggRouter — non-custodial multi-DEX aggregation router for Robinhood Chain (public mode).
/// @notice Generalises Sherwood's swap leg into a user-callable any-token router. Routes
///         `tokenIn -> ETH -> tokenOut` through the native-ETH hub; each side ("spoke") is
///         swapped to/from ETH on whichever Uniswap version has the liquidity, chosen by the
///         off-chain router and passed in as `kind`/`pool`/`fee`/`ts`:
///           kind 0 = v4 (Universal Router, native-ETH pool: fee + tickSpacing)
///           kind 1 = v3 (SwapRouter02 exactInputSingle vs WETH: fee) — wrapped/unwrapped around ETH
///           kind 2 = v2 (low-level pair swap vs WETH: pool) — wrapped/unwrapped around ETH
///         Custody-free: swaps exactly the pulled `amountIn` and forwards all output to `recipient`.
contract AggRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant V3_ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant NATIVE = address(0);

    // --- $SWOOD fee utility ---
    // A small protocol fee on public swaps, discounted by how much $SWOOD the swapper holds.
    // The shielded core stays fee-minimal + private (a $SWOOD-balance discount there would leak
    // identity), so the utility lives here on the public path.
    address internal constant SWOOD = 0xB1cB27F78B7335df8C3d8ebF0881A15BeD6BeB60;
    address internal constant FEE_RECIPIENT = 0xABc3468B093A349Cfaa952c0a305CF6560E80D9d; // treasury (owner)
    uint256 internal constant FEE_BPS = 30; // 0.30% base
    uint256 internal constant FEE_BPS_T1 = 15; // 0.15% for holders of >= TIER1
    uint256 internal constant TIER1 = 100_000e18; // hold 100k $SWOOD -> half fee
    uint256 internal constant TIER2 = 1_000_000e18; // hold 1M $SWOOD -> zero fee

    bytes1 internal constant CMD_V4_SWAP = 0x10;
    uint8 internal constant A_SWAP = 0x06;
    uint8 internal constant A_SETTLE = 0x0b;
    uint8 internal constant A_TAKE_ALL = 0x0f;

    error Expired();
    error Slippage();
    error BadValue();
    error EthSendFailed();
    error BadKind();

    event AggSwap(address indexed tokenIn, address indexed tokenOut, address indexed recipient, uint256 amountIn, uint256 amountOut);

    /// @dev How to swap a token to/from the ETH hub.
    struct Spoke {
        uint8 kind; // 0=v4, 1=v3, 2=v2, 3=v2 two-hop (token -> via -> WETH)
        address pool; // v2 pair (kind 2 / first hop of kind 3); ignored for v3/v4
        uint24 fee; // v3/v4 fee
        int24 ts; // v4 tickSpacing
        address via; // kind 3: intermediate token (e.g. VIRTUAL)
        address pool2; // kind 3: the via/WETH v2 pair
    }

    receive() external payable {}

    function swap(
        address tokenIn,
        Spoke calldata spokeIn,
        address tokenOut,
        Spoke calldata spokeOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline,
        address recipient
    ) external payable nonReentrant returns (uint256 net) {
        if (block.timestamp > deadline) revert Expired();
        require(recipient != address(0), "recipient=0");
        require(tokenIn != tokenOut, "tokenIn==tokenOut");

        uint256 ethMid = _toEth(tokenIn, spokeIn, amountIn);

        // gross output, in tokenOut terms (native ETH stays as ETH; WETH is a plain ERC20)
        uint256 gross;
        if (tokenOut == NATIVE) {
            gross = ethMid;
        } else if (tokenOut == WETH) {
            IWETH(WETH).deposit{value: ethMid}();
            gross = ethMid;
        } else {
            gross = _fromEth(tokenOut, spokeOut, ethMid);
        }

        // $SWOOD-tiered protocol fee, taken from the output
        uint256 fee = (gross * _feeBps(msg.sender)) / 10000;
        net = gross - fee;
        if (net < minOut) revert Slippage(); // slippage floor is on what the user actually receives

        if (tokenOut == NATIVE) {
            if (fee > 0) { (bool f,) = FEE_RECIPIENT.call{value: fee}(""); require(f, "fee send"); }
            (bool ok,) = recipient.call{value: net}("");
            if (!ok) revert EthSendFailed();
        } else {
            if (fee > 0) IERC20(tokenOut).safeTransfer(FEE_RECIPIENT, fee);
            IERC20(tokenOut).safeTransfer(recipient, net);
        }
        emit AggSwap(tokenIn, tokenOut, recipient, amountIn, net);
    }

    /// @notice The swap fee (in basis points) `user` currently pays, given their $SWOOD balance.
    function feeBpsFor(address user) external view returns (uint256) {
        return _feeBps(user);
    }

    function _feeBps(address user) internal view returns (uint256) {
        uint256 bal = IERC20(SWOOD).balanceOf(user);
        if (bal >= TIER2) return 0;
        if (bal >= TIER1) return FEE_BPS_T1;
        return FEE_BPS;
    }

    /// @dev Pull `amountIn` of `tokenIn` and convert it to native ETH.
    function _toEth(address tokenIn, Spoke calldata s, uint256 amountIn) internal returns (uint256) {
        if (tokenIn == NATIVE) {
            if (msg.value != amountIn) revert BadValue();
            return amountIn;
        }
        if (msg.value != 0) revert BadValue();
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        if (tokenIn == WETH) {
            IWETH(WETH).withdraw(amountIn);
            return amountIn;
        }
        if (s.kind == 0) {
            IERC20(tokenIn).safeTransfer(UNIVERSAL_ROUTER, amountIn); // fund router for SETTLE
            return _v4(tokenIn, NATIVE, amountIn, 0, s.fee, s.ts);
        }
        uint256 weth;
        if (s.kind == 1) weth = _v3(tokenIn, WETH, amountIn, s.fee);
        else if (s.kind == 2) weth = _v2(s.pool, tokenIn, WETH, amountIn);
        else if (s.kind == 3) weth = _v2(s.pool2, s.via, WETH, _v2(s.pool, tokenIn, s.via, amountIn)); // token -> via -> WETH
        else revert BadKind();
        IWETH(WETH).withdraw(weth); // WETH -> ETH
        return weth;
    }

    /// @dev Convert native ETH into `tokenOut`.
    function _fromEth(address tokenOut, Spoke calldata s, uint256 eth) internal returns (uint256) {
        if (s.kind == 0) return _v4(NATIVE, tokenOut, eth, eth, s.fee, s.ts);
        IWETH(WETH).deposit{value: eth}(); // ETH -> WETH
        if (s.kind == 1) return _v3(WETH, tokenOut, eth, s.fee);
        if (s.kind == 2) return _v2(s.pool, WETH, tokenOut, eth);
        if (s.kind == 3) return _v2(s.pool, s.via, tokenOut, _v2(s.pool2, WETH, s.via, eth)); // WETH -> via -> token
        revert BadKind();
    }

    function _v3(address tin, address tout, uint256 amtIn, uint24 fee) internal returns (uint256 outAmt) {
        IERC20(tin).forceApprove(V3_ROUTER, amtIn);
        uint256 before = IERC20(tout).balanceOf(address(this));
        ISwapRouter(V3_ROUTER).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({tokenIn: tin, tokenOut: tout, fee: fee, recipient: address(this), amountIn: amtIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0})
        );
        IERC20(tin).forceApprove(V3_ROUTER, 0);
        outAmt = IERC20(tout).balanceOf(address(this)) - before;
    }

    function _v2(address pair, address tin, address tout, uint256 amtIn) internal returns (uint256 outAmt) {
        (uint112 r0, uint112 r1,) = IUniV2Pair(pair).getReserves();
        bool inIs0 = tin == IUniV2Pair(pair).token0();
        (uint256 rIn, uint256 rOut) = inIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 f = amtIn * 997;
        uint256 amountOut = (f * rOut) / (rIn * 1000 + f);
        uint256 before = IERC20(tout).balanceOf(address(this));
        IERC20(tin).safeTransfer(pair, amtIn);
        (uint256 a0, uint256 a1) = inIs0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
        IUniV2Pair(pair).swap(a0, a1, address(this), "");
        outAmt = IERC20(tout).balanceOf(address(this)) - before;
    }

    function _v4(address cin, address cout, uint256 amtIn, uint256 value, uint24 fee, int24 ts) internal returns (uint256) {
        (address c0, address c1) = uint160(cin) < uint160(cout) ? (cin, cout) : (cout, cin);
        bytes memory actions = abi.encodePacked(A_SWAP, A_SETTLE, A_TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleParams({poolKey: PoolKey(c0, c1, fee, ts, address(0)), zeroForOne: cin == c0, amountIn: uint128(amtIn), amountOutMinimum: 0, hookData: ""}));
        params[1] = abi.encode(cin, amtIn, false);
        params[2] = abi.encode(cout, uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        uint256 before = cout == NATIVE ? address(this).balance : IERC20(cout).balanceOf(address(this));
        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: value}(abi.encodePacked(CMD_V4_SWAP), inputs, block.timestamp);
        return (cout == NATIVE ? address(this).balance : IERC20(cout).balanceOf(address(this))) - before;
    }
}
