// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Faithful port of Uniswap V2's UQ112x112 fixed-point library.
/// @dev    Range: [0, 2**112 - 1] with resolution 1 / 2**112. Used only by the
///         pair's price oracle accumulators.
library UQ112x112 {
    uint224 constant Q112 = 2 ** 112;

    /// @notice encode a uint112 as a UQ112x112.
    /// @dev    `uint224(y) * Q112` never overflows: max is (2**112 - 1) * 2**112
    ///         = 2**224 - 2**112 < 2**224, so it stays in checked math without
    ///         reverting. Left checked to match the original "never overflows".
    function encode(uint112 y) internal pure returns (uint224 z) {
        z = uint224(y) * Q112; // never overflows
    }

    /// @notice divide a UQ112x112 by a uint112, returning a UQ112x112.
    function uqdiv(uint224 x, uint112 y) internal pure returns (uint224 z) {
        z = x / y;
    }
}
