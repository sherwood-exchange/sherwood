// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStaking {
    function stakedOf(address) external view returns (uint256);
}

/// @title SwoodGovernor — $SWOOD-weighted signaling governance for Sherwood.
/// @notice On-chain proposals + votes weighted by a holder's STAKED $SWOOD (skin in the game,
///         and it ties governance to the staking utility). Signaling only — there is no
///         automatic on-chain execution; the team enacts what the community votes for
///         (new listings, protocol parameters, treasury use). A lightweight, honest MVP.
contract SwoodGovernor {
    IStaking public immutable staking;
    uint256 public immutable votingPeriod; // seconds a proposal stays open
    uint256 public immutable proposalThreshold; // min staked $SWOOD to open a proposal

    struct Proposal {
        address proposer;
        string description;
        uint64 start;
        uint64 end;
        uint256 forVotes;
        uint256 againstVotes;
    }

    Proposal[] public proposals;
    mapping(uint256 => mapping(address => uint8)) public voteOf; // 0=none, 1=for, 2=against

    event Proposed(uint256 indexed id, address indexed proposer, string description, uint64 end);
    event Voted(uint256 indexed id, address indexed voter, bool support, uint256 weight);

    constructor(address _staking, uint256 _votingPeriod, uint256 _proposalThreshold) {
        require(_staking != address(0), "staking=0");
        staking = IStaking(_staking);
        votingPeriod = _votingPeriod;
        proposalThreshold = _proposalThreshold;
    }

    function proposalCount() external view returns (uint256) {
        return proposals.length;
    }

    /// @notice Open a proposal. Caller must have >= `proposalThreshold` staked $SWOOD.
    function propose(string calldata description) external returns (uint256 id) {
        require(staking.stakedOf(msg.sender) >= proposalThreshold, "below threshold");
        uint256 n = bytes(description).length;
        require(n > 0 && n <= 500, "bad description");
        id = proposals.length;
        uint64 end = uint64(block.timestamp) + uint64(votingPeriod);
        proposals.push(Proposal({proposer: msg.sender, description: description, start: uint64(block.timestamp), end: end, forVotes: 0, againstVotes: 0}));
        emit Proposed(id, msg.sender, description, end);
    }

    /// @notice Cast a vote weighted by your currently-staked $SWOOD. One vote per address.
    function vote(uint256 id, bool support) external {
        Proposal storage p = proposals[id];
        require(p.end != 0, "no proposal");
        require(block.timestamp < p.end, "voting ended");
        require(voteOf[id][msg.sender] == 0, "already voted");
        uint256 w = staking.stakedOf(msg.sender);
        require(w > 0, "no voting power");
        voteOf[id][msg.sender] = support ? 1 : 2;
        if (support) p.forVotes += w;
        else p.againstVotes += w;
        emit Voted(id, msg.sender, support, w);
    }

    function isActive(uint256 id) external view returns (bool) {
        return id < proposals.length && block.timestamp < proposals[id].end;
    }
}
