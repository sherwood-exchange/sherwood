// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleTreeWithHistory} from "./MerkleTreeWithHistory.sol";
import {IVerifier} from "./interfaces/IVerifier.sol";
import {SwapExecutor} from "./SwapExecutor.sol";
import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";
import {PoseidonT6} from "poseidon-solidity/PoseidonT6.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Sherwood — shielded multi-asset UTXO pool with a public-AMM swap leg (M2)
/// @notice A single privacy pool that holds many ERC20s and hides everything
///         about the *holder* of value: identity, balance, note amounts, note
///         asset (within the set), and the sender↔receiver / deposit↔withdraw
///         links. Value lives only inside amount-carrying UTXO notes committed to
///         a Poseidon Merkle tree; a join-split (2-in / 2-out) circuit proves
///         ownership and value conservation without revealing which leaf is spent.
///
///         note        = { amount, assetId, pubKey, blinding }
///         assetId     = uint256(uint160(tokenAddress))
///         commitment  = Poseidon(amount, assetId, pubKey, blinding)
///         nullifier   = Poseidon(commitment, pathIndices, sign)
///
///         A single `transact` covers four actions, distinguished by `extAmount`
///         and the presence of a swap leg in `extData`:
///           shield   : extAmount > 0            (pull tokens in, mint output notes)
///           transfer : extAmount = 0, fee = 0   (notes only, no token movement)
///           unshield : extAmount < 0, no swap   (burn input notes, send tokens out)
///           swap     : extAmount < 0, tokenOut != 0
///                      (route `-extAmount` of the input asset through the public
///                       Uniswap pool and RE-SHIELD the received amount as a fresh
///                       note that only the swapPubKey owner can spend)
///
///         The swap's cross-asset step lives entirely in Solidity, where the AMM
///         output amount is known; the circuit stays a clean single-asset
///         join-split. The output ("claim") note is computed on-chain with the
///         *actual* received amount and inserted as its own leaf.
contract Sherwood is MerkleTreeWithHistory, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    IVerifier public immutable verifier;
    /// @notice Multi-DEX swap router for the swap leg. Owner-settable so new token routes
    ///         can be added without redeploying the pool (and its shielded state). The
    ///         executor is custody-free — it only ever holds the transient per-swap amount —
    ///         so the trust delegated here is bounded to in-flight swap funds, matching the
    ///         owner's existing control over the asset allowlist and ASP.
    SwapExecutor public swapExecutor;

    uint256 public constant MAX_EXT_AMOUNT = 2 ** 248;
    uint256 public constant MAX_FEE = 2 ** 248;

    /// @notice Assets allowed to enter/leave the pool. assetId == uint160(token).
    mapping(address => bool) public supportedAsset;

    mapping(uint256 => bool) public nullifierHashes;

    /// @notice Per-sender monotonic deposit counter. Deposit/swap labels are
    ///         Poseidon(sender, nonce), so each label is unique and provably bound to
    ///         one deposit — it can never reuse another already-approved label. (C-1.)
    mapping(address => uint256) public depositNonce;
    /// @notice Every label ever minted — belt-and-suspenders against reuse.
    mapping(uint256 => bool) public usedLabel;

    /// @notice Association-Set Provider: curates the set of approved deposit labels.
    address public asp;
    /// @notice Merkle root of ASP-approved deposit labels; spends prove membership.
    uint256 public associationRoot;

    /// @notice Ring buffer of recent approved roots so an ASP root rotation does not
    ///         invalidate honest in-flight spend proofs (anti-griefing / churn-DoS).
    uint32 public constant ASSOC_ROOT_HISTORY = 64;
    uint256[ASSOC_ROOT_HISTORY] public associationRoots;
    uint32 public assocRootIndex;

    /// @notice Time-locked ASP rotation so users can react to a malicious change.
    uint256 public constant ASP_TIMELOCK = 2 days;
    address public pendingAsp;
    uint256 public pendingAspTime;

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        uint256 root;
        uint256 publicAmount;
        uint256 publicAsset;
        uint256 extDataHash;
        uint256 associationRoot; // must match the on-chain associationRoot
        uint256 depositLabel; // revealed label for a deposit (0 for spends)
        uint256 isDeposit; // 1 iff no real inputs (a pure deposit)
        uint256[2] inputNullifiers;
        uint256[2] outputCommitments;
    }

    struct ExtData {
        address recipient; // unshield destination (unused for shield/transfer/swap)
        int256 extAmount; // signed external amount in `asset` (>0 in, <0 out)
        uint256 assetId; // uint160(asset token) — the boundary asset; == every real note's asset
        address relayer;
        uint256 fee; // relayer fee, paid in `asset`
        // --- swap leg (tokenOut == address(0) → not a swap) ---
        address tokenOut; // asset received from the AMM and re-shielded
        uint256 minAmountOut; // slippage floor; swap reverts below it (no nullifier burn)
        uint256 swapPubKey; // owner pubkey of the re-shielded claim note
        uint256 swapBlinding; // blinding of the re-shielded claim note
        uint24 poolFee; // Uniswap v3 fee tier for the tokenIn/tokenOut pool
        uint256 deadline; // AMM deadline
        uint256 swapLabel; // fresh deposit-label for the re-shielded swap proceeds
        // --- encrypted note payloads (for the owners to recover their notes) ---
        bytes encryptedOutput1;
        bytes encryptedOutput2;
        bytes encryptedSwapNote;
    }

    event NewCommitment(uint256 indexed commitment, uint256 index, bytes encryptedOutput);
    event NewNullifier(uint256 indexed nullifier);
    /// @notice A new deposit label enters the pool (shield or swap proceeds); the
    ///         ASP screens these and approves a subset into the association set.
    event Deposit(uint256 indexed label, uint256 commitmentIndex);
    event SwapExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 claimCommitment,
        uint256 claimIndex
    );
    event AssetSet(address indexed token, bool supported);
    event SwapExecutorSet(address indexed executor);
    event AssociationRootUpdated(uint256 newRoot);
    event AspUpdated(address indexed asp);
    event AspProposed(address indexed asp, uint256 effectiveTime);

    constructor(
        IVerifier _verifier,
        SwapExecutor _swapExecutor,
        uint32 _levels,
        address _owner,
        address _asp,
        address[] memory _initialAssets
    ) MerkleTreeWithHistory(_levels) Ownable(_owner) {
        require(address(_verifier) != address(0), "verifier = zero");
        require(address(_swapExecutor) != address(0), "executor = zero");
        require(_asp != address(0), "asp = zero");
        verifier = _verifier;
        swapExecutor = _swapExecutor;
        asp = _asp;
        for (uint256 i = 0; i < _initialAssets.length; i++) {
            _setAsset(_initialAssets[i], true);
        }
    }

    /// @notice Owner adds/removes an asset from the pool allowlist.
    function setAsset(address token, bool supported) external onlyOwner {
        _setAsset(token, supported);
    }

    /// @notice Owner updates the swap router (e.g. to add new token routes) without a pool
    ///         redeploy. Custody-free by construction — see `swapExecutor`.
    function setSwapExecutor(SwapExecutor newExecutor) external onlyOwner {
        require(address(newExecutor) != address(0), "executor = zero");
        swapExecutor = newExecutor;
        emit SwapExecutorSet(address(newExecutor));
    }

    /// @notice ASP publishes the Merkle root of approved deposit labels. Spends
    ///         must prove membership against this root.
    function setAssociationRoot(uint256 newRoot) external {
        require(msg.sender == asp, "not ASP");
        associationRoot = newRoot;
        associationRoots[assocRootIndex] = newRoot;
        assocRootIndex = (assocRootIndex + 1) % ASSOC_ROOT_HISTORY;
        emit AssociationRootUpdated(newRoot);
    }

    /// @notice True if `root` is the current or a recent approved root.
    function isKnownAssociationRoot(uint256 root) public view returns (bool) {
        if (root == 0) return false;
        if (root == associationRoot) return true;
        for (uint256 i = 0; i < ASSOC_ROOT_HISTORY; i++) {
            if (associationRoots[i] == root) return true;
        }
        return false;
    }

    /// @notice Owner proposes a new ASP; it only takes effect after ASP_TIMELOCK so
    ///         users can react/exit if the rotation is malicious.
    function proposeAsp(address newAsp) external onlyOwner {
        require(newAsp != address(0), "asp = zero");
        pendingAsp = newAsp;
        pendingAspTime = block.timestamp + ASP_TIMELOCK;
        emit AspProposed(newAsp, pendingAspTime);
    }

    /// @notice Owner finalizes a proposed ASP once the timelock has elapsed.
    function acceptAsp() external onlyOwner {
        require(pendingAsp != address(0), "no pending asp");
        require(block.timestamp >= pendingAspTime, "asp timelock");
        asp = pendingAsp;
        pendingAsp = address(0);
        emit AspUpdated(asp);
    }

    function _setAsset(address token, bool supported) internal {
        require(token != address(0), "token = zero");
        supportedAsset[token] = supported;
        emit AssetSet(token, supported);
    }

    /// @notice Execute a shielded transaction (shield / transfer / unshield / swap).
    function transact(Proof calldata proof, ExtData calldata extData) external nonReentrant {
        // ---- validate against the proof's public signals ----
        require(isKnownRoot(proof.root), "unknown merkle root");
        require(!isSpent(proof.inputNullifiers[0]), "input 0 already spent");
        require(!isSpent(proof.inputNullifiers[1]), "input 1 already spent");
        require(proof.inputNullifiers[0] != proof.inputNullifiers[1], "duplicate input nullifier");
        require(uint256(keccak256(abi.encode(extData))) % FIELD_SIZE == proof.extDataHash, "extData hash mismatch");
        require(proof.publicAmount == _publicAmount(extData.extAmount, extData.fee), "invalid public amount");
        require(proof.publicAsset == extData.assetId, "publicAsset mismatch");

        // assetId is a 256-bit circuit signal but only its low 160 bits address a
        // token; require it be canonical so a note cannot be filed under a synthetic
        // asset id that the circuit segregates while the contract still moves the
        // real token (keeps on-chain balances and in-circuit accounting in lockstep).
        require(extData.assetId < 2 ** 160, "assetId not canonical");
        address assetToken = address(uint160(extData.assetId));
        // Only DEPOSITS (value-in) require the asset to be currently allowlisted; an
        // unshield/transfer/swap of a since-delisted asset must still be able to exit,
        // so the owner cannot freeze existing shielded funds by delisting.
        if (extData.extAmount > 0) require(supportedAsset[assetToken], "asset not supported");

        // ---- compliance: association-set binding ----
        // A spend must prove its label is in the ASP-approved set (checked in-circuit
        // against this exact root). Value entering the pool must be a PURE deposit so
        // fresh, unscreened value cannot inherit an already-approved label. The root may
        // be the current one OR a recent one (history) so a rotation does not invalidate
        // honest in-flight proofs.
        require(
            proof.associationRoot == associationRoot || isKnownAssociationRoot(proof.associationRoot),
            "stale association root"
        );
        if (extData.extAmount > 0) require(proof.isDeposit == 1, "deposit must be pure");

        uint256[11] memory input;
        input[0] = proof.root;
        input[1] = proof.publicAmount;
        input[2] = proof.publicAsset;
        input[3] = proof.extDataHash;
        input[4] = proof.associationRoot;
        input[5] = proof.depositLabel;
        input[6] = proof.isDeposit;
        input[7] = proof.inputNullifiers[0];
        input[8] = proof.inputNullifiers[1];
        input[9] = proof.outputCommitments[0];
        input[10] = proof.outputCommitments[1];
        require(verifier.verifyProof(proof.a, proof.b, proof.c, input), "invalid proof");

        // ---- effects: burn inputs, insert the two output notes ----
        nullifierHashes[proof.inputNullifiers[0]] = true;
        nullifierHashes[proof.inputNullifiers[1]] = true;
        uint32 insertedIndex = _insert(proof.outputCommitments[0], proof.outputCommitments[1]);
        emit NewCommitment(proof.outputCommitments[0], insertedIndex, extData.encryptedOutput1);
        emit NewCommitment(proof.outputCommitments[1], insertedIndex + 1, extData.encryptedOutput2);
        emit NewNullifier(proof.inputNullifiers[0]);
        emit NewNullifier(proof.inputNullifiers[1]);
        // A pure value-in deposit publishes its label for the ASP to screen. The label
        // MUST equal a unique per-sender value so it can never reuse an already-approved
        // label to smuggle unscreened value into the association set (C-1).
        if (proof.isDeposit == 1 && extData.extAmount > 0) {
            uint256 expected = PoseidonT3.hash([uint256(uint160(msg.sender)), depositNonce[msg.sender]]);
            require(proof.depositLabel == expected, "bad deposit label");
            require(!usedLabel[expected], "label reuse");
            depositNonce[msg.sender] += 1;
            usedLabel[expected] = true;
            emit Deposit(proof.depositLabel, insertedIndex);
        }

        // ---- interactions: token movement by mode ----
        if (extData.extAmount > 0) {
            // shield — verify the pool actually received exactly `extAmount`, so a
            // fee-on-transfer/rebasing asset cannot mint notes worth more than the
            // vault gained (which would leave the pool undercollateralized).
            uint256 amt = uint256(extData.extAmount);
            uint256 balBefore = IERC20(assetToken).balanceOf(address(this));
            IERC20(assetToken).safeTransferFrom(msg.sender, address(this), amt);
            require(IERC20(assetToken).balanceOf(address(this)) - balBefore == amt, "fee-on-transfer unsupported");
        }
        if (extData.fee > 0) {
            IERC20(assetToken).safeTransfer(extData.relayer, extData.fee);
        }

        if (extData.tokenOut != address(0)) {
            _swapAndReshield(assetToken, extData);
        } else if (extData.extAmount < 0) {
            // unshield
            require(extData.recipient != address(0), "recipient = zero");
            IERC20(assetToken).safeTransfer(extData.recipient, uint256(-extData.extAmount));
        }
    }

    /// @dev Routes `-extAmount` of `tokenIn` through the public AMM and re-shields
    ///      the received amount as a fresh note (contract-computed with the ACTUAL
    ///      output, so the user never has to predict the price).
    function _swapAndReshield(address tokenIn, ExtData calldata extData) internal {
        require(extData.extAmount < 0, "swap needs extAmount < 0");
        require(supportedAsset[extData.tokenOut], "tokenOut not supported");
        require(extData.tokenOut != tokenIn, "tokenOut == tokenIn");
        uint256 amountIn = uint256(-extData.extAmount);

        // Credit the ACTUAL balance delta the vault received (not the router's
        // return value), so a fee-on-transfer/rebasing tokenOut cannot mint a claim
        // note larger than the tokens really in the vault.
        uint256 balBefore = IERC20(extData.tokenOut).balanceOf(address(this));
        IERC20(tokenIn).safeTransfer(address(swapExecutor), amountIn);
        swapExecutor.swap(
            tokenIn, extData.tokenOut, extData.poolFee, amountIn, extData.minAmountOut, extData.deadline, address(this)
        );
        uint256 received = IERC20(extData.tokenOut).balanceOf(address(this)) - balBefore;
        require(received >= extData.minAmountOut, "insufficient output");
        // Bound to the circuit's amount range so the claim note is always a valid,
        // in-field, spendable commitment (and inputs stay implicitly range-bound).
        require(received < 2 ** 248, "amountOut out of range");

        // Re-shield: claim note = Poseidon(received, assetIdOut, swapPubKey, swapBlinding, swapLabel).
        // The proceeds are new value from public liquidity, so they get a FRESH
        // deposit label (emitted for the ASP to screen) rather than inheriting the
        // spent note's label.
        // The proceeds are new value from public liquidity, so they get a FRESH,
        // contract-derived UNIQUE label (Poseidon(sender, nonce)) — never a
        // caller-chosen one — so they cannot inherit an already-approved label (C-1).
        // The client recovers this label from the emitted Deposit event.
        uint256 assetIdOut = uint256(uint160(extData.tokenOut));
        uint256 swapLabel = PoseidonT3.hash([uint256(uint160(msg.sender)), depositNonce[msg.sender]]);
        require(!usedLabel[swapLabel], "label reuse");
        depositNonce[msg.sender] += 1;
        usedLabel[swapLabel] = true;
        uint256 claim =
            PoseidonT6.hash([received, assetIdOut, extData.swapPubKey, extData.swapBlinding, swapLabel]);
        uint32 idx = _insert(claim, ZERO_VALUE);
        emit NewCommitment(claim, idx, extData.encryptedSwapNote);
        // The claim's ZERO_VALUE sibling is a real tree leaf; emit it too so every
        // client/indexer rebuilds a gap-free tree (else the leaf count desyncs and
        // the next transaction's Merkle paths/roots diverge from on-chain).
        emit NewCommitment(ZERO_VALUE, idx + 1, "");
        emit Deposit(swapLabel, idx);
        emit SwapExecuted(tokenIn, extData.tokenOut, amountIn, received, claim, idx);
    }

    function isSpent(uint256 nullifierHash) public view returns (bool) {
        return nullifierHashes[nullifierHash];
    }

    /// @dev Field-encoded net amount entering the pool: extAmount - fee, wrapped
    ///      into the BN254 field so unshields/swaps (negative) are representable.
    function _publicAmount(int256 extAmount, uint256 fee) internal pure returns (uint256) {
        require(fee < MAX_FEE, "fee too large");
        require(extAmount > -int256(MAX_EXT_AMOUNT) && extAmount < int256(MAX_EXT_AMOUNT), "extAmount out of range");
        int256 publicAmount = extAmount - int256(fee);
        return publicAmount >= 0 ? uint256(publicAmount) : FIELD_SIZE - uint256(-publicAmount);
    }
}
