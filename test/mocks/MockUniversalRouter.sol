// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ExactInputSingleParams} from "../../src/interfaces/IUniswapV4.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Deterministic Universal-Router (Uniswap v4) stand-in, meant to be
///         `vm.etch`-ed at the executor's hardcoded Robinhood-mainnet address.
///         Decodes the single V4_SWAP command the executor emits
///         ([SWAP_EXACT_IN_SINGLE, SETTLE, TAKE_ALL]) and settles at a per-output-
///         currency rate (default 1:1 raw units) so tests can simulate price /
///         slippage, mirroring the old MockRouter. Native ETH = address(0):
///           - ETH in  -> paid via msg.value; pays `out` of the ERC20 side.
///           - ERC20 in -> pre-transferred here by the executor (SETTLE with
///             payerIsUser=false); pays `out` native ETH back to the caller.
///         Constructor- and immutable-free so etching the runtime code suffices;
///         pre-fund it (vm.deal + mint) so both directions have inventory.
contract MockUniversalRouter {
    struct Rate {
        uint256 num;
        uint256 den; // den == 0 -> unset -> 1:1
    }

    mapping(address => Rate) public rate; // keyed by OUTPUT currency

    function setRate(address currencyOut, uint256 num, uint256 den) external {
        rate[currencyOut] = Rate(num, den);
    }

    receive() external payable {}

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 /* deadline */ ) external payable {
        commands; // single V4_SWAP; params carry everything we need
        (, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        ExactInputSingleParams memory p = abi.decode(params[0], (ExactInputSingleParams));
        (address cin, address cout) =
            p.zeroForOne ? (p.poolKey.currency0, p.poolKey.currency1) : (p.poolKey.currency1, p.poolKey.currency0);

        Rate memory r = rate[cout];
        uint256 out = r.den == 0 ? p.amountIn : (uint256(p.amountIn) * r.num) / r.den;

        if (cin == address(0)) {
            require(msg.value == p.amountIn, "amm: bad msg.value");
            require(IERC20(cout).transfer(msg.sender, out), "amm: token send failed");
        } else {
            // input tokens already sit here; return native ETH
            (bool ok,) = msg.sender.call{value: out}("");
            require(ok, "amm: eth send failed");
        }
    }
}
