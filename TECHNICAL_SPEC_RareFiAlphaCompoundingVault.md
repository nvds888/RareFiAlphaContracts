# RareFiAlphaCompoundingVault Technical Specification

**Contract:** Auto-Compounding Yield Vault (ERC4626-style)
**Framework:** Algorand TypeScript (puya-ts)
**Last Updated:** February 2026

---

## Overview

Users deposit Alpha tokens and earn yield in USDC, which is automatically swapped back to Alpha. Uses share-based accounting: when yield compounds, share price increases, so users withdraw more Alpha than they deposited.

**Flow:** Alpha (deposit) → USDC (airdrop) → Swap via Tinyman → Alpha (compounded back)

---

## Assets (2)

| Asset | Role | Example |
|-------|------|---------|
| `alphaAsset` | Deposit & yield token | Alpha |
| `usdcAsset` | Airdrop currency | USDC |

---

## State

### Global State (16 keys)

| Key | Type | Description |
|-----|------|-------------|
| `alphaAsset` | uint64 | Alpha ASA ID |
| `usdcAsset` | uint64 | USDC ASA ID |
| `creatorAddress` | Account | Vault creator (receives fees) |
| `rarefiAddress` | Account | RareFi platform address |
| `creatorFeeRate` | uint64 | Fee percentage (0-6%) |
| `creatorUnclaimedAlpha` | uint64 | Accumulated creator fees |
| `totalShares` | uint64 | Total shares issued |
| `totalAlpha` | uint64 | Total Alpha held (deposits + yield) |
| `minSwapThreshold` | uint64 | Min USDC before compound |
| `maxSlippageBps` | uint64 | Max slippage for swaps (bps) |
| `totalYieldCompounded` | uint64 | Lifetime yield compounded |
| `tinymanPoolAppId` | uint64 | Tinyman V2 pool app ID |
| `tinymanPoolAddress` | Account | Tinyman pool state holder |
| `farmBalance` | uint64 | Farm bonus pool |
| `emissionRatio` | uint64 | Multiplier for dynamic rate: rate = farmBalance × emissionRatio / totalAlpha |
| `assetsOptedIn` | uint64 | 1 if assets opted in |

### Local State (1 key per user)

| Key | Type | Description |
|-----|------|-------------|
| `userShares` | uint64 | User's share balance |

---

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `SCALE` | 1e12 | Share price display precision |
| `MAX_FEE_RATE` | 6 | Max creator fee (6%) |
| `MIN_DEPOSIT_AMOUNT` | 1,000,000 | 1 token (6 decimals) |
| `MIN_SWAP_AMOUNT` | 200,000 | 0.20 USDC |
| `MAX_SWAP_THRESHOLD` | 50,000,000 | 50 USDC max threshold |
| `FEE_BPS_BASE` | 10,000 | Basis points denominator |
| `MIN_MAX_SLIPPAGE_BPS` | 500 | 5% min for maxSlippageBps |
| `MAX_SLIPPAGE_BPS` | 10,000 | 100% absolute ceiling |
| `MIN_FARM_EMISSION_BPS` | 1,000 | 10% floor when farm funded |

---

## Methods

### Initialization

#### `createVault(alphaAssetId, usdcAssetId, creatorFeeRate, minSwapThreshold, maxSlippageBps, tinymanPoolAppId, tinymanPoolAddress, rarefiAddress)`
**Action:** `onCreate` (required)

Creates vault. Validates: fee ≤ 6%, threshold 0.20-50 USDC, slippage 5-100%, both asset IDs non-zero and different, pool app ID non-zero. Sets caller as creator.

#### `optInAssets()`
Creator opts contract into both assets. Requires 5.4 ALGO payment in preceding txn. Can only be called once (`assetsOptedIn` guard).

### User Operations

#### `optIn()`
**Action:** `OptIn` — Initializes `userShares` to 0.

#### `deposit(slippageBps)`
Deposits Alpha, receives shares proportional to current share price.

**Auto-compound:** If USDC balance ≥ threshold AND existing shareholders, executes compound BEFORE crediting deposit. Share price increases for existing holders; new depositor buys at the higher price.

**Share calculation:**
- First deposit: `shares = alphaAmount` (1:1)
- Otherwise: `shares = alphaAmount × totalShares / totalAlpha`

Requires asset transfer in preceding txn, amount ≥ 1 token.

#### `withdraw(shareAmount)`
Redeems shares for Alpha (deposit + compounded yield). Pass 0 to withdraw all.

`alphaAmount = shareAmount × totalAlpha / totalShares`

#### `closeOut()`
**Action:** `CloseOut` — Redeems all shares and returns Alpha.

### Yield Processing

#### `compoundYield(slippageBps)`
**Permissionless.** Swaps USDC → Alpha via Tinyman V2.

Requirements: USDC ≥ threshold, shareholders > 0, slippage ≤ maxSlippageBps.

Uses `executeCompound` helper:
1. Read pool reserves on-chain → calculate expected output
2. Apply slippage → execute swap via inner txn group
3. Calculate farm bonus (capped by farmBalance)
4. Split `totalOutput` between creator fee and vault
5. Add vault's cut to `totalAlpha` (share price increases)

**Compounding effect:** `totalShares` stays the same, `totalAlpha` increases → share price goes up.

### Creator Operations

#### `claimCreator()`
Creator claims accumulated fees in Alpha.

#### `updateCreatorFeeRate(newFeeRate)`
Creator only. Must be 0-6%.

### Admin Operations (Creator or RareFi)

#### `updateMinSwapThreshold(newThreshold)`
Must be 0.20-50 USDC (200,000-50,000,000). Prevents disabling swaps via excessive threshold.

#### `updateMaxSlippage(newMaxSlippageBps)`
Creator only. Must be 5-100% (500-10000 bps).

### Farm Operations

#### `contributeFarm()`
Anyone sends Alpha to fund the farm. Requires asset transfer in preceding txn.

#### `setEmissionRatio(newRatio)`
Creator or RareFi. Must be > 0. Controls the dynamic emission rate: `rate = farmBalance × emissionRatio / totalAlpha`, floored at 10% when farm has balance. No max cap — the rate self-adjusts as the farm depletes (geometric decay).

### Read-Only Methods

| Method | Returns |
|--------|---------|
| `getVaultStats()` | `[totalShares, totalAlpha, creatorUnclaimed, usdcBal, totalYieldCompounded, sharePrice]` |
| `getUserAlphaBalance(user)` | User's Alpha value (shares × price) |
| `getUserShares(user)` | User's share count |
| `previewDeposit(alphaAmount)` | Shares that would be minted |
| `previewWithdraw(shareAmount)` | Alpha that would be received |
| `getCompoundQuote()` | `[usdcBal, expectedAlpha, minAt50bps]` |
| `getFarmStats()` | `[farmBalance, emissionRatio, currentDynamicRate]` |

Note: `sharePrice` in `getVaultStats` is scaled by SCALE (1e12).

### Security (Bare Methods)

- `updateApplication()` → always fails
- `deleteApplication()` → always fails

---

## Core Formulas

**Share price:**
```
sharePrice = totalAlpha × SCALE / totalShares
```

**Deposit (Alpha → Shares):**
```
If totalShares == 0: shares = alphaAmount
Else: shares = alphaAmount × totalShares / totalAlpha
```

**Withdraw (Shares → Alpha):**
```
alphaAmount = shares × totalAlpha / totalShares
```

**AMM swap (constant product):**
```
netInput = input × (10000 - feeBps) / 10000
output = (outputReserves × netInput) / (inputReserves + netInput)
```

**Dynamic farm emission rate:**
```
dynamicRate = max(MIN_FARM_EMISSION_BPS, farmBalance × emissionRatio / totalAlpha)
farmBonus = min(compoundOutput × dynamicRate / FEE_BPS_BASE, farmBalance)
```
Rate self-adjusts: high farm balance = high rate, as farm depletes the rate drops (geometric decay). 10% floor when farm > 0.

Farm is disabled by default (`emissionRatio = 0`, `farmBalance = 0`). Both funding and a ratio are required to activate. Once set, `emissionRatio` cannot be set to 0 (protects farm contributors from locked funds). Bonus per compound is capped at `farmBalance`. Rate self-adjusts via geometric decay as the farm depletes.

See [RAREFI_CONCEPT.md](./RAREFI_CONCEPT.md#farm-feature) for detailed emission ratio guidance, example scenarios, and half-life calculations.

**Safe math:** All multiplications use `mulw` (128-bit) + `divmodw` (128-bit division), asserts no overflow.

---

## Access Control

| Method | Anyone | Creator | RareFi |
|--------|--------|---------|--------|
| deposit, withdraw, closeOut | ✓ | ✓ | ✓ |
| compoundYield, contributeFarm | ✓ | ✓ | ✓ |
| claimCreator, updateCreatorFeeRate | | ✓ | |
| updateMaxSlippage | | ✓ | |
| updateMinSwapThreshold | | ✓ | ✓ |
| setEmissionRatio | | ✓ | ✓ |

---

## Transaction Groups

**Deposit:**
```
[0] AssetTransfer: Alpha → Vault
[1] AppCall: deposit(slippageBps)
    foreignApps: [tinymanPoolAppId]  (if auto-compound possible)
    foreignAssets: [alphaAsset]
    accounts: [poolAddress]
    fee: 5000 (covers inner txns)
```

**Compound:**
```
[0] AppCall: compoundYield(slippageBps)
    foreignApps: [tinymanPoolAppId]
    foreignAssets: [usdcAsset, alphaAsset]
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
2. **Flash deposit prevention** — Auto-compound executes BEFORE deposit is credited
3. **On-chain pricing** — Reads Tinyman pool reserves directly, no oracle dependency
4. **Slippage cap** — Creator sets maxSlippageBps (min 5%), all swaps bounded
5. **Immutable** — Update and delete always fail
6. **128-bit safe math** — `mulw`/`divmodw` prevents overflow, floor division throughout
7. **Asset opt-in guard** — `optInAssets` can only be called once

### Security Validation

TEAL bytecode verified for dangerous field checks:
- **Lines 373-384** (optInAssets): rekeyTo, closeRemainderTo
- **Lines 738-750** (deposit): rekeyTo, assetCloseTo
- **Lines 1860-1872** (contributeFarm): rekeyTo, assetCloseTo

Reviewed with Trail of Bits Tealer v0.1.2 static analyzer. See [SECURITY_REVIEW.md](./SECURITY_REVIEW.md) for full details.

---

## Deployment

1. Deploy with `createVault()` parameters
2. Creator calls `optInAssets()` with 5.4 ALGO payment
3. (Optional) Fund farm with `contributeFarm()` + set ratio with `setEmissionRatio()`
4. Team performs first deposit
5. Users can begin depositing

---

## Comparison with RareFiVault

| Feature | RareFiVault | CompoundingVault |
|---------|-------------|------------------|
| Assets | 3 (Alpha, USDC, Project) | 2 (Alpha, USDC) |
| Yield token | Project ASA | Alpha (same as deposit) |
| Accounting | Yield-per-token accumulator | Share-based |
| Yield collection | Manual claim | Auto-compounded |
| Local state | 3 vars | 1 var |
| Use case | Earn project tokens | Grow Alpha position |

---

## Known Limitations

1. **Pool dependency** — Compounding fails if Tinyman pool state is unreadable
2. **No emergency pause** — Contract cannot be paused (users can always withdraw)
3. **Single pool** — One Tinyman pool per vault (set at deployment, immutable)
4. **Share price only increases** — No mechanism to handle losses (by design)
5. **Stranded USDC** — If all shareholders withdraw while USDC is in vault, it's stranded until someone deposits again
