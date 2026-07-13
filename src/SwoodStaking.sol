// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title SwoodStaking — stake $SWOOD, earn a share of protocol fee revenue.
/// @notice Synthetix-style single-reward staking. The protocol's swap fees accrue to the
///         treasury; the treasury converts them to the reward token (USDG) and streams them to
///         stakers via `notifyRewardAmount`. Rewards accrue pro-rata to stake × time. This is
///         the on-chain "revenue share" utility for $SWOOD holders.
contract SwoodStaking is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable stakingToken; // $SWOOD
    IERC20 public immutable rewardsToken; // USDG (fees, converted)

    uint256 public rewardsDuration = 7 days;
    uint256 public periodFinish;
    uint256 public rewardRate; // reward tokens per second
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;

    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    uint256 private _totalStaked;
    mapping(address => uint256) private _staked;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardAdded(uint256 reward, uint256 periodFinish);

    constructor(address _staking, address _rewards, address _owner) Ownable(_owner) {
        require(_staking != address(0) && _rewards != address(0), "zero token");
        stakingToken = IERC20(_staking);
        rewardsToken = IERC20(_rewards);
    }

    // ---- views ----
    function totalStaked() external view returns (uint256) { return _totalStaked; }
    function stakedOf(address a) external view returns (uint256) { return _staked[a]; }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (_totalStaked == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * 1e18) / _totalStaked;
    }

    /// @notice Reward tokens `a` can currently claim.
    function earned(address a) public view returns (uint256) {
        return (_staked[a] * (rewardPerToken() - userRewardPerTokenPaid[a])) / 1e18 + rewards[a];
    }

    // ---- staking ----
    function stake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        require(amount > 0, "amount=0");
        _totalStaked += amount;
        _staked[msg.sender] += amount;
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount) public nonReentrant updateReward(msg.sender) {
        require(amount > 0 && amount <= _staked[msg.sender], "bad amount");
        _totalStaked -= amount;
        _staked[msg.sender] -= amount;
        stakingToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function getReward() public nonReentrant updateReward(msg.sender) {
        uint256 r = rewards[msg.sender];
        if (r > 0) {
            rewards[msg.sender] = 0;
            rewardsToken.safeTransfer(msg.sender, r);
            emit RewardPaid(msg.sender, r);
        }
    }

    function exit() external {
        withdraw(_staked[msg.sender]);
        getReward();
    }

    // ---- rewards distribution (treasury) ----
    /// @notice Fund a new reward stream. The caller must have approved `reward` of the reward token.
    function notifyRewardAmount(uint256 reward) external onlyOwner updateReward(address(0)) {
        rewardsToken.safeTransferFrom(msg.sender, address(this), reward);
        if (block.timestamp >= periodFinish) {
            rewardRate = reward / rewardsDuration;
        } else {
            uint256 remaining = periodFinish - block.timestamp;
            uint256 leftover = remaining * rewardRate;
            rewardRate = (reward + leftover) / rewardsDuration;
        }
        // guard against reward rate that the balance can't cover
        require(rewardRate * rewardsDuration <= rewardsToken.balanceOf(address(this)), "reward > balance");
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + rewardsDuration;
        emit RewardAdded(reward, periodFinish);
    }

    function setRewardsDuration(uint256 _duration) external onlyOwner {
        require(block.timestamp >= periodFinish, "period active");
        require(_duration > 0, "duration=0");
        rewardsDuration = _duration;
    }

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }
}
