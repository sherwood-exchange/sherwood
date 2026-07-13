// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Sherwood} from "../src/Sherwood.sol";
import {SwapExecutor} from "../src/SwapExecutor.sol";
import {MockVerifier} from "../src/verifiers/MockVerifier.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";

/// @dev exposes the internal field-encoding helper for property testing.
contract SherwoodHarness is Sherwood {
    constructor(IVerifier v, SwapExecutor e, uint32 l, address o, address asp_, address[] memory a)
        Sherwood(v, e, l, o, asp_, a)
    {}

    function xPublicAmount(int256 extAmount, uint256 fee) external pure returns (uint256) {
        return _publicAmount(extAmount, fee);
    }
}

/// @dev Property/fuzz tests for the value-encoding and binding invariants that the
///      Solidity side must uphold regardless of the (ZK-proven) rest.
contract SherwoodPropsTest is Test {
    SherwoodHarness pool;
    uint256 FIELD;
    uint256 MAX_EXT;
    uint256 MAX_FEE;

    function setUp() public {
        MockVerifier v = new MockVerifier();
        SwapExecutor e = new SwapExecutor();
        address[] memory a = new address[](1);
        a[0] = address(new MockERC20("USDG", "USDG", 6));
        pool = new SherwoodHarness(IVerifier(address(v)), e, 23, address(this), address(this), a);
        FIELD = pool.FIELD_SIZE();
        MAX_EXT = pool.MAX_EXT_AMOUNT();
        MAX_FEE = pool.MAX_FEE();
    }

    /// publicAmount is a faithful 2's-complement-in-field encoding of extAmount-fee:
    /// decoding it back yields exactly the signed net amount.
    function testFuzz_PublicAmountRoundTrips(int256 extAmount, uint256 fee) public view {
        extAmount = bound(extAmount, -int256(MAX_EXT) + 1, int256(MAX_EXT) - 1);
        fee = bound(fee, 0, MAX_FEE - 1);
        uint256 enc = pool.xPublicAmount(extAmount, fee);
        int256 expected = extAmount - int256(fee);
        // decode: values in the upper half of the field represent negatives
        int256 decoded = enc > FIELD / 2 ? int256(enc) - int256(FIELD) : int256(enc);
        assertEq(decoded, expected, "field encoding does not round-trip");
    }

    function testFuzz_PublicAmount_RevertsFeeTooLarge(uint256 fee) public {
        fee = bound(fee, MAX_FEE, type(uint256).max);
        vm.expectRevert("fee too large");
        pool.xPublicAmount(0, fee);
    }

    function testFuzz_PublicAmount_RevertsExtAmountOutOfRange(int256 extAmount) public {
        // only exercise values outside the valid band [-MAX_EXT+1, MAX_EXT-1]
        vm.assume(extAmount <= -int256(MAX_EXT) || extAmount >= int256(MAX_EXT));
        vm.expectRevert("extAmount out of range");
        pool.xPublicAmount(extAmount, 0);
    }

    /// A non-canonical assetId (any high bit set above 160) is always rejected.
    function testFuzz_AssetIdMustBeCanonical(uint256 assetId) public {
        vm.assume(assetId >= 2 ** 160);
        Sherwood.ExtData memory e;
        e.assetId = assetId;
        e.extAmount = 1;
        Sherwood.Proof memory p;
        p.root = pool.getLastRoot();
        p.publicAmount = pool.xPublicAmount(e.extAmount, 0);
        p.publicAsset = assetId;
        p.extDataHash = uint256(keccak256(abi.encode(e))) % FIELD;
        p.associationRoot = pool.associationRoot();
        p.isDeposit = 1;
        p.inputNullifiers[0] = uint256(keccak256("a")) % FIELD;
        p.inputNullifiers[1] = uint256(keccak256("b")) % FIELD;
        vm.expectRevert("assetId not canonical");
        pool.transact(p, e);
    }
}
