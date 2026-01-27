# RareFiVault Technical Specification

**Contract Type:** Staking Rewards Accumulator
**Version:** 1.0
**Last Updated:** January 2025

---

## Overview

RareFiVault is a permissionless yield vault where users deposit Alpha tokens (yield-bearing asset) and earn yield in a project's ASA token. USDC airdrops arriving at the vault are swapped to the project token via Tinyman V2, with yield distributed proportionally using the standard staking rewards accumulator pattern.

### Key Features
- **Yield-per-token accumulator** - Fair, gas-efficient yield distribution
- **Auto-swap on deposit** - Flash deposit attack prevention
- **Permissionless swaps** - Anyone can trigger yield processing
- **On-chain price calculation** - Reads Tinyman pool state directly
- **Farm bonus** - Optional boosted yields from sponsor contributions

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         RareFiVault                             │
├─────────────────────────────────────────────────────────────────┤
│  Assets:                                                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │   Alpha     │  │    USDC     │  │  swapAsset  │             │
│  │  (deposit)  │  │  (airdrop)  │  │  (project)  │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│         │               │                 ▲                     │
│         ▼               ▼                 │                     │
│  ┌─────────────────────────────────────────┐                   │
│  │           Vault Logic                    │                   │
│  │  • Deposit/Withdraw Alpha               │                   │
│  │  • Swap USDC → swapAsset (via Tinyman)  │                   │
│  │  • Distribute yield via accumulator     │                   │
│  └─────────────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Global State

| Key | Type | Description |
|-----|------|-------------|
| `depositAsset` | uint64 | Alpha ASA ID (what users deposit) |
| `yieldAsset` | uint64 | USDC ASA ID (airdrop asset) |
| `swapAsset` | uint64 | Project's ASA ID (yield token) |
| `creatorAddress` | Account | Vault creator receiving fees |
| `rarefiAddress` | Account | RareFi platform address |
| `creatorFeeRate` | uint64 | Fee percentage (0-100) |
| `creatorUnclaimedYield` | uint64 | Accumulated fees for creator |
| `totalDeposits` | uint64 | Total Alpha deposited |
| `yieldPerToken` | uint64 | Accumulator scaled by 1e9 |
| `minSwapThreshold` | uint64 | Minimum USDC before swap |
| `totalYieldGenerated` | uint64 | Lifetime yield generated |
| `tinymanPoolAppId` | uint64 | Tinyman V2 pool app ID |
| `tinymanPoolAddress` | Account | Tinyman pool address |
| `farmBalance` | uint64 | Farm bonus pool |
| `farmEmissionRate` | uint64 | Farm emission rate (bps) |

---

## Local State (Per User)

| Key | Type | Description |
|-----|------|-------------|
| `depositedAmount` | uint64 | User's Alpha balance in vault |
| `userYieldPerToken` | uint64 | Snapshot at last action |
| `earnedYield` | uint64 | Accumulated unclaimed yield |

---

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `SCALE` | 1,000,000,000 (1e9) | Yield-per-token precision |
| `MAX_FEE_RATE` | 100 | Max fee (100 = 100%) |
| `MIN_DEPOSIT_AMOUNT` | 1,000,000 | 1 token (6 decimals) |
| `MIN_SWAP_AMOUNT` | 200,000 | 0.20 USDC minimum |
| `FEE_BPS_BASE` | 10,000 | Basis points denominator |
| `MAX_SLIPPAGE_BPS` | 10,000 | 100% max slippage |
| `MAX_FARM_EMISSION_BPS` | 10,000 | 100% max farm rate |

---

## ABI Methods

### Initialization

#### `createVault()`
Creates and initializes the vault. Called once at deployment.

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| `depositAssetId` | uint64 | Alpha ASA ID |
| `yieldAssetId` | uint64 | USDC ASA ID |
| `swapAssetId` | uint64 | Project token ASA ID |
| `creatorFeeRate` | uint64 | Fee percentage (0-100) |
| `minSwapThreshold` | uint64 | Min USDC before swap |
| `tinymanPoolAppId` | uint64 | Tinyman pool app ID |
| `tinymanPoolAddress` | Account | Tinyman pool address |
| `rarefiAddress` | Account | RareFi platform address |

**Validations:**
- Creator fee rate ≤ 100%
- Min swap threshold ≥ 0.20 USDC
- All asset IDs non-zero and unique

---

#### `optInAssets()`
Opts contract into all required assets.

**Requirements:**
- Caller must be creator
- Must include 5.5 ALGO payment in preceding transaction

**Actions:**
- Opts into depositAsset (Alpha)
- Opts into yieldAsset (USDC)
- Opts into swapAsset (Project token)

---

### User Operations

#### `optIn()`
User opts into the contract to enable local storage.

**Action:** `OptIn`
**Initializes:** All local state to 0

---

#### `deposit(slippageBps: uint64)`
User deposits Alpha tokens into the vault.

**Auto-Swap Logic:**
If `usdcBalance ≥ minSwapThreshold` AND `totalDeposits > 0`:
1. Execute swap BEFORE deposit is credited
2. Yield goes to existing depositors only
3. New depositor cannot capture pre-existing yield

**Requirements:**
- Asset transfer of Alpha in preceding transaction
- Amount ≥ MIN_DEPOSIT_AMOUNT (1 token)
- slippageBps ≤ MAX_SLIPPAGE_BPS (10000)

**State Updates:**
- `depositedAmount[user] += amount`
- `totalDeposits += amount`
- `userYieldPerToken[user] = yieldPerToken` (after pending yield captured)

---

#### `withdraw(amount: uint64)`
User withdraws Alpha from the vault.

**Parameters:**
- `amount`: Amount to withdraw (0 = withdraw all)

**Requirements:**
- `amount ≤ depositedAmount[user]`

**State Updates:**
- Updates pending yield before withdrawal
- `depositedAmount[user] -= amount`
- `totalDeposits -= amount`

---

#### `claim()`
User claims accumulated yield in swapAsset.

**Requirements:**
- `earnedYield[user] > 0`

**State Updates:**
- `earnedYield[user] = 0`

---

#### `closeOut()`
User closes out, receiving all deposits and pending yield.

**Action:** `CloseOut`
**Returns:** All deposited Alpha + all pending yield (swapAsset)

---

### Yield Processing

#### `swapYield(slippageBps: uint64)`
Swaps accumulated USDC to project token via Tinyman V2.

**Access:** Permissionless (anyone can call)

**Requirements:**
- `usdcBalance ≥ minSwapThreshold`
- `totalDeposits > 0`
- `slippageBps ≤ MAX_SLIPPAGE_BPS`

**On-Chain Price Calculation:**
1. Reads pool reserves from Tinyman local state
2. Calculates expected output using AMM formula
3. Applies slippage tolerance

**Yield Distribution:**
```
creatorCut = totalOutput × creatorFeeRate / 100
userCut = totalOutput - creatorCut
yieldPerToken += (userCut × SCALE) / totalDeposits
```

**Farm Bonus:**
If `farmEmissionRate > 0` AND `farmBalance > 0`:
```
farmBonus = min(swapOutput × farmEmissionRate / 10000, farmBalance)
totalOutput = swapOutput + farmBonus
```

---

### Creator Operations

#### `claimCreator()`
Creator claims accumulated fees.

**Access:** Creator only

**Requirements:**
- `creatorUnclaimedYield > 0`

---

### Admin Operations

#### `updateMinSwapThreshold(newThreshold: uint64)`
Updates minimum swap threshold.

**Access:** Creator or RareFi

**Requirements:**
- `newThreshold ≥ MIN_SWAP_AMOUNT`

---

#### `updateTinymanPool(newPoolAppId: uint64, newPoolAddress: Account)`
Updates Tinyman pool configuration (for migrations).

**Access:** Creator or RareFi

---

### Farm Operations

#### `contributeFarm()`
Anyone can contribute swapAsset to the farm.

**Requirements:**
- Asset transfer of swapAsset in preceding transaction
- Amount > 0

---

#### `setFarmEmissionRate(emissionRateBps: uint64)`
Sets farm emission rate.

**Access:** Creator or RareFi

**Requirements:**
- `emissionRateBps ≤ MAX_FARM_EMISSION_BPS`

---

### Read-Only Methods

#### `getVaultStats()`
**Returns:** `[totalDeposits, yieldPerToken, creatorUnclaimedYield, usdcBalance, swapAssetBalance, totalYieldGenerated]`

#### `getPendingYield(user: Account)`
**Returns:** User's pending yield (without claiming)

#### `getUserDeposit(user: Account)`
**Returns:** User's deposited Alpha amount

#### `getSwapQuote()`
**Returns:** `[usdcBalance, expectedOutput, minOutputAt50bps]`

#### `getFarmStats()`
**Returns:** `[farmBalance, farmEmissionRate]`

---

## Mathematical Formulas

### Yield Per Token Accumulator

When yield is distributed:
```
yield_increase = (user_cut × SCALE) / total_deposits
yield_per_token += yield_increase
```

When user claims/deposits/withdraws:
```
pending = deposited × (yield_per_token - user_snapshot) / SCALE
earned_yield += pending
user_snapshot = yield_per_token
```

### AMM Swap Calculation

```
net_input = input × (10000 - fee_bps) / 10000
output = (output_reserves × net_input) / (input_reserves + net_input)
min_output = output × (10000 - slippage_bps) / 10000
```

### Safe Math (mulDivFloor)

Uses `mulw` for 128-bit multiplication and `divmodw` for 128-bit division:
```
[hi, lo] = mulw(n1, n2)
[q_hi, q_lo, r_hi, r_lo] = divmodw(hi, lo, 0, d)
result = q_lo (asserts q_hi == 0)
```

---

## Security Features

### 1. Flash Deposit Attack Prevention
- Auto-swap executes BEFORE deposit is credited
- New depositor cannot capture pre-existing yield

### 2. On-Chain Price Calculation
- Reads Tinyman pool reserves directly
- No off-chain oracle dependency
- Prevents fake quote attacks

### 3. Permissionless Swaps with High Slippage
- 100% max slippage allows swaps in illiquid pools
- On-chain calculation ensures fair minimum output
- No operational bottleneck

### 4. Immutability
- Contract updates disabled
- Contract deletion disabled

### 5. Safe Integer Arithmetic
- 128-bit precision for all multiplications
- Floor division prevents rounding exploits

---

## Access Control Matrix

| Method | Anyone | Creator | RareFi |
|--------|--------|---------|--------|
| `deposit` | ✓ | ✓ | ✓ |
| `withdraw` | ✓ | ✓ | ✓ |
| `claim` | ✓ | ✓ | ✓ |
| `closeOut` | ✓ | ✓ | ✓ |
| `swapYield` | ✓ | ✓ | ✓ |
| `contributeFarm` | ✓ | ✓ | ✓ |
| `claimCreator` | ✗ | ✓ | ✗ |
| `setFarmEmissionRate` | ✗ | ✓ | ✓ |
| `updateMinSwapThreshold` | ✗ | ✓ | ✓ |
| `updateTinymanPool` | ✗ | ✓ | ✓ |

---

## Transaction Requirements

### Deposit Transaction
```
Group:
  [0] Asset Transfer: Alpha → Vault
  [1] App Call: deposit(slippageBps)

If auto-swap may trigger:
  - appForeignApps: [tinymanPoolAppId]
  - appForeignAssets: [swapAsset]
  - appAccounts: [poolStateHolderAddress]
  - fee: 5000 micro-ALGO (covers inner txns)
```

### Swap Transaction
```
Group:
  [0] App Call: swapYield(slippageBps)

Required:
  - appForeignApps: [tinymanPoolAppId]
  - appForeignAssets: [yieldAsset, swapAsset]
  - appAccounts: [tinymanPoolAddress]
  - fee: 5000 micro-ALGO (covers inner txns)
```

---

## State Diagram

```
User Lifecycle:
  ┌──────────┐
  │  Start   │
  └────┬─────┘
       │ optIn()
       ▼
  ┌──────────┐
  │ Opted In │ ◄─────────────────────────┐
  └────┬─────┘                           │
       │ deposit()                       │
       ▼                                 │
  ┌──────────┐   withdraw()    ┌─────────┴───┐
  │Depositor │ ◄──────────────►│ Partial     │
  └────┬─────┘   (partial)     │ Withdrawal  │
       │                       └─────────────┘
       │ closeOut()
       ▼
  ┌──────────┐
  │  Closed  │
  └──────────┘
```

---

## Deployment Checklist

1. Deploy contract with `createVault()` parameters
2. Creator calls `optInAssets()` with 5.5 ALGO payment
3. Verify all assets are opted-in
4. (Optional) Fund farm with `contributeFarm()`
5. (Optional) Set farm rate with `setFarmEmissionRate()`
6. Users can begin depositing

---

## Known Limitations

1. **MEV Exposure** - High slippage tolerance means sandwich attacks are possible on mainnet
2. **Pool Dependency** - Swaps fail if Tinyman pool state is unreadable
3. **No Emergency Pause** - Contract cannot be paused (users can always withdraw deposits)
4. **Single Pool** - Only one Tinyman pool per vault (can be updated by admin)

---

## Audit Recommendations

### Priority Areas
1. Tinyman V2 integration (swap execution, state reading)
2. Yield accumulator arithmetic (rounding, overflow)
3. Auto-swap timing (before deposit credit)
4. Farm bonus calculation and deduction

### Test Scenarios
- Multi-user yield distribution fairness
- Flash deposit attack prevention
- Edge cases (dust amounts, prime numbers)
- Pool state reading failures
