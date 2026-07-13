// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Sherwood} from "../../src/Sherwood.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";

/// @dev Drives random shield/unshield/swap/transfer sequences against the pool
///      (mock verifier accepts any proof, so the handler itself plays the role of
///      a *trusted, value-conserving prover*) and tracks the per-asset balance the
///      vault should hold. The invariant then checks the contract's real ERC20
///      balances never drift from that ledger — i.e. the Solidity token-flow
///      accounting is solvent regardless of the sequence.
contract SherwoodHandler is Test {
    Sherwood public pool;
    MockERC20 public usdg;
    MockERC20 public aapl;
    MockRouter public router;
    address public shielder = address(0xA11CE);
    address public recipient = address(0xB0B);

    // ghost ledger: what the pool SHOULD hold
    uint256 public gUsdg;
    uint256 public gAapl;
    uint256 public shields;
    uint256 public unshields;
    uint256 public swaps;

    uint256 private nonce;

    constructor(Sherwood _pool, MockERC20 _usdg, MockERC20 _aapl, MockRouter _router) {
        pool = _pool;
        usdg = _usdg;
        aapl = _aapl;
        router = _router;
        router.setRate(1, 1); // 1 USDG unit -> 1 AAPL unit (accounting is unit-agnostic)
        usdg.mint(shielder, 1e30);
        vm.prank(shielder);
        usdg.approve(address(pool), type(uint256).max);
    }

    function _field() internal view returns (uint256) {
        return pool.FIELD_SIZE();
    }

    function _freshProof(Sherwood.ExtData memory e) internal returns (Sherwood.Proof memory p) {
        nonce++;
        uint256 F = _field();
        p.root = pool.getLastRoot();
        int256 net = e.extAmount - int256(e.fee);
        p.publicAmount = net >= 0 ? uint256(net) : F - uint256(-net);
        p.publicAsset = e.assetId;
        p.extDataHash = uint256(keccak256(abi.encode(e))) % F;
        p.associationRoot = pool.associationRoot();
        p.isDeposit = e.extAmount > 0 ? 1 : 0;
        // C-1: value-in deposit label must equal the contract-derived per-sender value.
        p.depositLabel = (p.isDeposit == 1 && e.extAmount > 0)
            ? PoseidonT3.hash([uint256(uint160(shielder)), pool.depositNonce(shielder)])
            : 0;
        p.inputNullifiers[0] = uint256(keccak256(abi.encode("nf0", nonce))) % F;
        p.inputNullifiers[1] = uint256(keccak256(abi.encode("nf1", nonce))) % F;
        p.outputCommitments[0] = uint256(keccak256(abi.encode("oc0", nonce))) % F;
        p.outputCommitments[1] = uint256(keccak256(abi.encode("oc1", nonce))) % F;
    }

    function shield(uint256 amt) external {
        amt = bound(amt, 1, 1_000_000e6);
        Sherwood.ExtData memory e;
        e.assetId = uint256(uint160(address(usdg)));
        e.extAmount = int256(amt);
        Sherwood.Proof memory p = _freshProof(e);
        vm.prank(shielder);
        pool.transact(p, e);
        gUsdg += amt;
        shields++;
    }

    function unshield(uint256 amt) external {
        if (gUsdg == 0) return;
        amt = bound(amt, 1, gUsdg);
        Sherwood.ExtData memory e;
        e.recipient = recipient;
        e.assetId = uint256(uint160(address(usdg)));
        e.extAmount = -int256(amt);
        Sherwood.Proof memory p = _freshProof(e);
        pool.transact(p, e);
        gUsdg -= amt;
        unshields++;
    }

    function swap(uint256 amt) external {
        if (gUsdg == 0) return;
        amt = bound(amt, 1, gUsdg);
        Sherwood.ExtData memory e;
        e.assetId = uint256(uint160(address(usdg)));
        e.extAmount = -int256(amt);
        e.tokenOut = address(aapl);
        e.minAmountOut = amt; // rate 1:1
        e.poolFee = 3000;
        e.deadline = block.timestamp + 1;
        e.swapPubKey = 1;
        e.swapBlinding = nonce + 1;
        Sherwood.Proof memory p = _freshProof(e);
        pool.transact(p, e);
        gUsdg -= amt; // sent to the AMM
        gAapl += amt; // proceeds re-shielded into the vault
        swaps++;
    }

    function transfer(uint256 seed) external {
        Sherwood.ExtData memory e;
        e.assetId = uint256(uint160(address(usdg)));
        // notes-only; no token movement
        Sherwood.Proof memory p = _freshProof(e);
        pool.transact(p, e);
        seed;
    }
}
