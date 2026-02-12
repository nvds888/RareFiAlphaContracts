# RareFiVault Technical Specification

**Contract:** Staking Rewards Accumulator Vault
**Framework:** Algorand TypeScript (puya-ts)
**Last Updated:** February 2025

---

## Overview

Users deposit Alpha tokens and earn yield in a project's ASA token. USDC airdrops arriving at the vault are swapped to the project token via Tinyman V2, with yield distributed proportionally using the yield-per-token accumulator pattern.

**Flow:** Alpha (deposit) → USDC (airdrop) → Swap via Tinyman → Project Token (yield to users)

---

## Assets (3)

| Asset | Role | Example |
|-------|------|---------|
| `depositAsset` | What users deposit | Alpha |
| `yieldAsset` | Airdrop currency | USDC |
| `swapAsset` | What yield is swapped to | Project Token |

---

## State

### Global State (17 keys)

| Key | Type | Description |
|-----|------|-------------|
| `depositAsset` | uint64 | Alpha ASA ID |
| `yieldAsset` | uint64 | USDC ASA ID |
| `swapAsset` | uint64 | Project ASA ID |
| `creatorAddress` | Account | Vault creator (receives fees) |
| `rarefiAddress` | Account | RareFi platform address |
| `creatorFeeRate` | uint64 | Fee percentage (0-6%) |
| `creatorUnclaimedYield` | uint64 | Accumulated creator fees |
| `totalDeposits` | uint64 | Total Alpha deposited |
| `yieldPerToken` | uint64 | Accumulator (scaled by 1e12) |
| `minSwapThreshold` | uint64 | Min USDC before swap |
| `maxSlippageBps` | uint64 | Max slippage for swaps (bps) |
| `totalYieldGenerated` | uint64 | Lifetime yield generated |
| `tinymanPoolAppId` | uint64 | Tinyman V2 pool app ID |
| `tinymanPoolAddress` | Account | Tinyman pool state holder |
| `farmBalance` | uint64 | Farm bonus pool |
| `farmEmissionRate` | uint64 | Farm emission rate (bps) |
| `assetsOptedIn` | uint64 | 1 if assets opted in |

### Local State (3 keys per user)

| Key | Type | Description |
|-----|------|-------------|
| `depositedAmount` | uint64 | User's Alpha in vault |
| `userYieldPerToken` | uint64 | Snapshot at last action |
| `earnedYield` | uint64 | Accumulated unclaimed yield |

---

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `SCALE` | 1e12 | Yield-per-token precision |
| `MAX_FEE_RATE` | 6 | Max creator fee (6%) |
| `MIN_DEPOSIT_AMOUNT` | 1,000,000 | 1 token (6 decimals) |
| `MIN_SWAP_AMOUNT` | 200,000 | 0.20 USDC |
| `FEE_BPS_BASE` | 10,000 | Basis points denominator |
| `MIN_MAX_SLIPPAGE_BPS` | 500 | 5% min for maxSlippageBps |
| `MAX_SLIPPAGE_BPS` | 10,000 | 100% absolute ceiling |
| `MIN_FARM_EMISSION_BPS` | 1,000 | 10% min when farm funded |
| `MAX_FARM_EMISSION_BPS` | 50,000 | 500% max farm rate |

---

## Methods

### Initialization

#### `createVault(depositAssetId, yieldAssetId, swapAssetId, creatorFeeRate, minSwapThreshold, maxSlippageBps, tinymanPoolAppId, tinymanPoolAddress, rarefiAddress)`
**Action:** `onCreate` (required)

Creates vault. Validates: fee ≤ 6%, threshold ≥ 0.20 USDC, slippage 5-100%, all asset IDs non-zero and unique, pool app ID non-zero. Sets caller as creator.

#### `optInAssets()`
Creator opts contract into all 3 assets. Requires 5.5 ALGO payment in preceding txn. Can only be called once (`assetsOptedIn` guard).

### User Operations

#### `optIn()`
**Action:** `OptIn` — Initializes all local state to 0.

#### `deposit(slippageBps)`
Deposits Alpha. Requires asset transfer in preceding txn, amount ≥ 1 token.

**Auto-swap:** If USDC balance ≥ threshold AND existing depositors, executes swap BEFORE crediting deposit. Yield goes to existing depositors only.

Calls `updateEarnedYield` before adding to deposit to capture pending yield.

#### `withdraw(amount)`
Withdraws Alpha. Pass 0 to withdraw all. Calls `updateEarnedYield` before reducing balance.

#### `claim()`
Claims accumulated yield in swapAsset. Calls `updateEarnedYield`, resets `earnedYield` to 0, transfers.

#### `closeOut()`
**Action:** `CloseOut` — Returns all deposited Alpha + all pending yield (swapAsset).

### Yield Processing

#### `swapYield(slippageBps)`
**Permissionless.** Swaps USDC → swapAsset via Tinyman V2.

Requirements: USDC ≥ threshold, depositors > 0, slippage ≤ maxSlippageBps.

Uses `executeSwapAndDistribute` helper:
1. Read pool reserves on-chain → calculate expected output
2. Apply slippage → execute swap via inner txn group
3. Calculate farm bonus (capped by farmBalance)
4. Split `totalOutput` between creator fee and user yield
5. Update `yieldPerToken` accumulator

### Creator Operations

#### `claimCreator()`
Creator claims accumulated fees in swapAsset.

#### `updateCreatorFeeRate(newFeeRate)`
Creator only. Must be 0-6%.

### Admin Operations (Creator or RareFi)

#### `updateMinSwapThreshold(newThreshold)`
Must be ≥ 0.20 USDC.

#### `updateMaxSlippage(newMaxSlippageBps)`
Creator only. Must be 5-100% (500-10000 bps).

### Farm Operations

#### `contributeFarm()`
Anyone sends swapAsset to fund the farm. Requires asset transfer in preceding txn.

#### `setFarmEmissionRate(emissionRateBps)`
Creator or RareFi. Max 500%. Min 10% when farm has balance (protects contributors).

### Read-Only Methods

| Method | Returns |
|--------|---------|
| `getVaultStats()` | `[totalDeposits, yieldPerToken, creatorUnclaimed, usdcBal, swapBal, totalYield]` |
| `getPendingYield(user)` | User's claimable yield |
| `getUserDeposit(user)` | User's deposited Alpha |
| `getSwapQuote()` | `[usdcBal, expectedOutput, minAt50bps]` |
| `getFarmStats()` | `[farmBalance, farmEmissionRate]` |

### Security (Bare Methods)

- `updateApplication()` → always fails
- `deleteApplication()` → always fails

---

## Core Formulas

**Yield distribution:**
```
yieldPerToken += (userCut × SCALE) / totalDeposits
```

**Pending yield calculation:**
```
pending = deposited × (yieldPerToken - userSnapshot) / SCALE
```

**AMM swap (constant product):**
```
netInput = input × (10000 - feeBps) / 10000
output = (outputReserves × netInput) / (inputReserves + netInput)
```

**Safe math:** All multiplications use `mulw` (128-bit) + `divmodw` (128-bit division), asserts no overflow.

---

## Access Control

| Method | Anyone | Creator | RareFi |
|--------|--------|---------|--------|
| deposit, withdraw, claim, closeOut | ✓ | ✓ | ✓ |
| swapYield, contributeFarm | ✓ | ✓ | ✓ |
| claimCreator, updateCreatorFeeRate | | ✓ | |
| updateMaxSlippage | | ✓ | |
| updateMinSwapThreshold | | ✓ | ✓ |
| setFarmEmissionRate | | ✓ | ✓ |

---

## Transaction Groups

**Deposit:**
```
[0] AssetTransfer: Alpha → Vault
[1] AppCall: deposit(slippageBps)
    foreignApps: [tinymanPoolAppId]  (if auto-swap possible)
    foreignAssets: [swapAsset]
    accounts: [poolAddress]
    fee: 5000 (covers inner txns)
```

**Swap:**
```
[0] AppCall: swapYield(slippageBps)
    foreignApps: [tinymanPoolAppId]
    foreignAssets: [yieldAsset, swapAsset]
    accounts: [poolAddress]
    fee: 5000
```

---

## Security Features

1. **Phishing attack prevention** — All incoming transactions validated:
   - `rekeyTo` must be zero (prevents account takeover)
   - `closeRemainderTo` must be zero on payments (prevents fund drain)
   - `assetCloseTo` must be zero on asset transfers (prevents asset drain)
   - Applied to: `optInAssets`, `deposit`, `contributeFarm`
2. **Flash deposit prevention** — Auto-swap executes BEFORE deposit is credited
3. **On-chain pricing** — Reads Tinyman pool reserves directly, no oracle dependency
4. **Slippage cap** — Creator sets maxSlippageBps (min 5%), all swaps bounded
5. **Immutable** — Update and delete always fail
6. **128-bit safe math** — `mulw`/`divmodw` prevents overflow, floor division throughout
7. **Asset opt-in guard** — `optInAssets` can only be called once

### Security Validation

TEAL bytecode verified for dangerous field checks:
- **Lines 403-414** (optInAssets): rekeyTo, closeRemainderTo
- **Lines 882-894** (deposit): rekeyTo, assetCloseTo
- **Lines 2036-2048** (contributeFarm): rekeyTo, assetCloseTo

Audited with Trail of Bits Tealer v0.1.2 static analyzer.

---

## Deployment

1. Deploy with `createVault()` parameters
2. Creator calls `optInAssets()` with 5.5 ALGO payment
3. (Optional) Fund farm with `contributeFarm()` + set rate with `setFarmEmissionRate()`
4. Team performs first deposit
5. Users can begin depositing

---

## Known Limitations

1. **Pool dependency** — Swaps fail if Tinyman pool state is unreadable
2. **No emergency pause** — Contract cannot be paused (users can always withdraw)
3. **Single pool** — One Tinyman pool per vault (set at deployment, immutable)
4. **Stranded USDC** — If all depositors withdraw while USDC is in vault, it's stranded until someone deposits again
