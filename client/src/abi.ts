// Minimal ABIs for the pieces the SDK touches.

export const SHERWOOD_ABI = [
  {
    type: "function",
    name: "transact",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "proof",
        type: "tuple",
        components: [
          { name: "a", type: "uint256[2]" },
          { name: "b", type: "uint256[2][2]" },
          { name: "c", type: "uint256[2]" },
          { name: "root", type: "uint256" },
          { name: "publicAmount", type: "uint256" },
          { name: "publicAsset", type: "uint256" },
          { name: "extDataHash", type: "uint256" },
          { name: "associationRoot", type: "uint256" },
          { name: "depositLabel", type: "uint256" },
          { name: "isDeposit", type: "uint256" },
          { name: "inputNullifiers", type: "uint256[2]" },
          { name: "outputCommitments", type: "uint256[2]" },
        ],
      },
      {
        name: "extData",
        type: "tuple",
        components: [
          { name: "recipient", type: "address" },
          { name: "extAmount", type: "int256" },
          { name: "assetId", type: "uint256" },
          { name: "relayer", type: "address" },
          { name: "fee", type: "uint256" },
          { name: "tokenOut", type: "address" },
          { name: "minAmountOut", type: "uint256" },
          { name: "swapPubKey", type: "uint256" },
          { name: "swapBlinding", type: "uint256" },
          { name: "poolFee", type: "uint24" },
          { name: "deadline", type: "uint256" },
          { name: "swapLabel", type: "uint256" },
          { name: "encryptedOutput1", type: "bytes" },
          { name: "encryptedOutput2", type: "bytes" },
          { name: "encryptedSwapNote", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
  { type: "function", name: "getLastRoot", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "associationRoot", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "setAssociationRoot", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "asp", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "depositNonce", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isKnownAssociationRoot", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "isKnownRoot",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "isSpent",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "supportedAsset",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "event",
    name: "NewCommitment",
    inputs: [
      { name: "commitment", type: "uint256", indexed: true },
      { name: "index", type: "uint256", indexed: false },
      { name: "encryptedOutput", type: "bytes", indexed: false },
    ],
  },
  {
    type: "event",
    name: "NewNullifier",
    inputs: [{ name: "nullifier", type: "uint256", indexed: true }],
  },
  {
    type: "event",
    name: "Deposit",
    inputs: [
      { name: "label", type: "uint256", indexed: true },
      { name: "commitmentIndex", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SwapExecuted",
    inputs: [
      { name: "tokenIn", type: "address", indexed: true },
      { name: "tokenOut", type: "address", indexed: true },
      { name: "amountIn", type: "uint256", indexed: false },
      { name: "amountOut", type: "uint256", indexed: false },
      { name: "claimCommitment", type: "uint256", indexed: false },
      { name: "claimIndex", type: "uint256", indexed: false },
    ],
  },
] as const;

export const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

export const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;
