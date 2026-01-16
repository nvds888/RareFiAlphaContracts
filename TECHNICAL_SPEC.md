# RareFi Vault - Technical Specification

## Overview

RareFi Vault is an Algorand smart contract that enables users to deposit yield-bearing assets (Alpha) and receive yield distributed in a project's ASA token. The contract integrates with Tinyman V2 to swap incoming USDC yield into the project token before distribution.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         RareFi Vault                            │
├─────────────────────────────────────────────────────────────────┤
│  Global State                                                   │
│  ├── Asset Configuration (depositAsset, yieldAsset, swapAsset) │
│  ├── Yield Accumulator (yieldPerToken)                         │
│  ├── Tinyman Pool Config (poolAppId, poolAddress)              │
│  └── Admin Addresses (creator, rarefi)                         │
├─────────────────────────────────────────────────────────────────┤
│  Local State (per user)                                         │
│  ├── depositedAmount                                            │
│  ├── userYieldPerToken (snapshot)                              │
│  └── earnedYield                                                │
└─────────────────────────────────────────────────────────────────┘
```

## Token Flow

```
1. Users deposit Alpha (yield-bearing asset) into vault
2. Alpha generates USDC yield (airdrops to vault address)
3. Creator/RareFi triggers swap: USDC → Project ASA via Tinyman
4. Project ASA is distributed proportionally to depositors
5. Users claim their accumulated yield
```

## State Management

### Global State (12 values)

| Key | Type | Description |
|-----|------|-------------|
| `depositAsset` | uint64 | ASA ID of deposit token (Alpha) |
| `yieldAsset` | uint64 | ASA ID of incoming yield (USDC) |
| `swapAsset` | uint64 | ASA ID of distribution token (Project ASA) |
| `creatorAddress` | Account | Vault creator address |
| `rarefiAddress` | Account | RareFi platform address |
| `creatorFeeRate` | uint64 | Creator fee percentage (0-100) |
| `creatorUnclaimedYield` | uint64 | Accumulated creator fee to claim |
| `totalDeposits` | uint64 | Sum of all user deposits |
| `yieldPerToken` | uint64 | Yield accumulator (scaled by 1e9) |
| `minSwapThreshold` | uint64 | Minimum USDC before swap allowed |
| `tinymanPoolAppId` | uint64 | Tinyman V2 pool application ID |
| `tinymanPoolAddress` | Account | Tinyman V2 pool address |

### Local State (3 values per user)

| Key | Type | Description |
|-----|------|-------------|
| `depositedAmount` | uint64 | User's deposited Alpha balance |
| `userYieldPerToken` | uint64 | Snapshot of yieldPerToken at last action |
| `earnedYield` | uint64 | Accumulated yield pending claim |

## Yield Distribution Algorithm

The contract uses the **staking rewards accumulator pattern** for yield distribution.

### Core Formula

```
pending_yield = deposited * (yieldPerToken - userYieldPerToken) / SCALE
```

Where `SCALE = 1,000,000,000` (1e9) for precision.

### Distribution Flow

1. **Swap triggers yield distribution:**
   ```
   swapOutput = tokens received from Tinyman
   creatorCut = swapOutput * creatorFeeRate / 100
   userCut = swapOutput - creatorCut

   yieldPerToken += (userCut * SCALE) / totalDeposits
   ```

2. **User claims yield:**
   ```
   pending = deposited * (yieldPerToken - userYieldPerToken) / SCALE
   earnedYield += pending
   userYieldPerToken = yieldPerToken  // update snapshot

   // Transfer earnedYield to user
   earnedYield = 0
   ```

### Why This Works

- No loops over users required
- O(1) distribution regardless of user count
- Users "catch up" on missed yield when they interact
- Yield is calculated lazily at claim/deposit/withdraw time

## Tinyman V2 Integration

### Swap Execution

The `swapYield` method performs a fixed-input swap:

```
Transaction 1: Asset Transfer
├── Send all USDC to Tinyman pool address
└── Amount: contract's full USDC balance

Transaction 2: Application Call
├── App ID: tinymanPoolAppId
├── Method: "swap"
├── Mode: "fixed-input"
└── Args: [minAmountOut]
```

### Slippage Protection

- `minAmountOut` parameter sets minimum acceptable output
- Only creator or RareFi can call swap
- Contract verifies received amount >= minAmountOut

## Method Reference

### User Methods

| Method | Description | Prereq |
|--------|-------------|--------|
| `optIn()` | Initialize user local state | - |
| `deposit()` | Deposit Alpha tokens | Asset transfer in group |
| `withdraw(amount)` | Withdraw Alpha (0 = all) | - |
| `claim()` | Claim accumulated yield | - |
| `closeOut()` | Exit vault, return all funds | - |

### Admin Methods (Creator or RareFi)

| Method | Description |
|--------|-------------|
| `swapYield(minAmountOut)` | Swap USDC to project ASA |
| `updateMinSwapThreshold(threshold)` | Update swap threshold |
| `updateTinymanPool(appId, address)` | Update Tinyman config |

### Setup Methods (Creator only)

| Method | Description |
|--------|-------------|
| `createVault(...)` | Initialize vault (on create) |
| `optInAssets()` | Opt contract into ASAs |

### Read-Only Methods

| Method | Returns |
|--------|---------|
| `getVaultStats()` | [totalDeposits, yieldPerToken, creatorUnclaimed, usdcBalance, swapBalance] |
| `getPendingYield(user)` | User's claimable yield |
| `getUserDeposit(user)` | User's deposited amount |

## Transaction Groups

### Deposit

```
Group[0]: AssetTransfer (Alpha to contract)
Group[1]: ApplicationCall (deposit)
```

### Withdraw

```
Group[0]: ApplicationCall (withdraw)
         └── Inner Txn: AssetTransfer (Alpha to user)
```

### Claim

```
Group[0]: ApplicationCall (claim)
         └── Inner Txn: AssetTransfer (Project ASA to user)
```

### Swap Yield

```
Group[0]: ApplicationCall (swapYield)
         ├── Inner Txn 1: AssetTransfer (USDC to Tinyman pool)
         └── Inner Txn 2: ApplicationCall (Tinyman swap)
```

## Access Control

| Method | Anyone | Creator | RareFi |
|--------|--------|---------|--------|
| deposit/withdraw/claim | ✓ | ✓ | ✓ |
| swapYield | | ✓ | ✓ |
| updateMinSwapThreshold | | ✓ | ✓ |
| updateTinymanPool | | ✓ | ✓ |
| optInAssets | | ✓ | |
| claimCreator | | ✓ | |

## Constants

```
SCALE = 1,000,000,000           // 1e9 precision for yield calculations
MAX_FEE_RATE = 100              // Maximum creator fee (100%)
MIN_DEPOSIT_AMOUNT = 1,000,000  // Minimum deposit (1 token @ 6 decimals)
MIN_SWAP_AMOUNT = 1,000,000     // Minimum swap threshold
```

## Deployment

1. Deploy contract with `createVault()` parameters
2. Fund contract with 0.3 ALGO for asset MBR
3. Call `optInAssets()` to opt into all three ASAs
4. Users can now opt-in and deposit
