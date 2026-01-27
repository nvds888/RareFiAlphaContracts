# RareFiAlphaCompoundingVault Technical Specification

**Contract Type:** Auto-Compounding Yield Vault
**Version:** 1.0
**Last Updated:** January 2025

---

## Overview

RareFiAlphaCompoundingVault is an auto-compounding yield vault where users deposit Alpha tokens and earn yield in USDC, which is automatically swapped back to Alpha. Uses share-based accounting (similar to ERC4626): when yield compounds, the share price increases, so users withdraw more Alpha than they deposited.

### Key Features
- **Share-based accounting** - Yield compounds automatically into share value
- **Auto-compound on deposit** - Flash deposit attack prevention
- **Permissionless compounding** - Anyone can trigger yield processing
- **On-chain price calculation** - Reads Tinyman pool state directly
- **Farm bonus** - Optional boosted yields from sponsor contributions

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  RareFiAlphaCompoundingVault                    │
├─────────────────────────────────────────────────────────────────┤
│  Assets:                                                        │
│  ┌─────────────┐  ┌─────────────┐                              │
│  │   Alpha     │  │    USDC     │                              │
│  │(deposit/out)│  │  (airdrop)  │                              │
│  └─────────────┘  └─────────────┘                              │
│         │               │                                       │
│         ▼               ▼                                       │
│  ┌─────────────────────────────────────────┐                   │
│  │           Vault Logic                    │                   │
│  │  • Deposit Alpha → Receive Shares       │                   │
│  │  • Compound USDC → Alpha (via Tinyman)  │                   │
│  │  • Withdraw Shares → Receive Alpha+Yield│                   │
│  └─────────────────────────────────────────┘                   │
│                                                                 │
│  Share Price = totalAlpha / totalShares                        │
│  (Increases with each compound)                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Global State

| Key | Type | Description |
|-----|------|-------------|
| `alphaAsset` | uint64 | Alpha ASA ID (deposit & yield) |
| `usdcAsset` | uint64 | USDC ASA ID (airdrop asset) |
| `creatorAddress` | Account | Vault creator receiving fees |
| `rarefiAddress` | Account | RareFi platform address |
| `creatorFeeRate` | uint64 | Fee percentage (0-100) |
| `creatorUnclaimedAlpha` | uint64 | Accumulated fees for creator |
| `totalShares` | uint64 | Total shares issued |
| `totalAlpha` | uint64 | Total Alpha held (deposits + yield) |
| `minSwapThreshold` | uint64 | Minimum USDC before compound |
| `totalYieldCompounded` | uint64 | Lifetime yield compounded |
| `tinymanPoolAppId` | uint64 | Tinyman V2 pool app ID |
| `tinymanPoolAddress` | Account | Tinyman pool address |
| `farmBalance` | uint64 | Farm bonus pool |
| `farmEmissionRate` | uint64 | Farm emission rate (bps) |

---

## Local State (Per User)

| Key | Type | Description |
|-----|------|-------------|
| `userShares` | uint64 | User's share balance |

---

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `SCALE` | 1,000,000,000,000 (1e12) | Share price precision |
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
| `alphaAssetId` | uint64 | Alpha ASA ID |
| `usdcAssetId` | uint64 | USDC ASA ID |
| `creatorFeeRate` | uint64 | Fee percentage (0-100) |
| `minSwapThreshold` | uint64 | Min USDC before compound |
| `tinymanPoolAppId` | uint64 | Tinyman pool app ID |
| `tinymanPoolAddress` | Account | Tinyman pool address |
| `rarefiAddress` | Account | RareFi platform address |

**Validations:**
- Creator fee rate ≤ 100%
- Min swap threshold ≥ 0.20 USDC
- Alpha and USDC asset IDs must be different

---

#### `optInAssets()`
Opts contract into required assets.

**Requirements:**
- Caller must be creator
- Must include 5.4 ALGO payment in preceding transaction

**Actions:**
- Opts into alphaAsset (Alpha)
- Opts into usdcAsset (USDC)

---

### User Operations

#### `optIn()`
User opts into the contract to enable local storage.

**Action:** `OptIn`
**Initializes:** `userShares = 0`

---

#### `deposit(slippageBps: uint64)`
User deposits Alpha tokens, receiving shares.

**Auto-Compound Logic:**
If `usdcBalance ≥ minSwapThreshold` AND `totalShares > 0`:
1. Execute compound BEFORE deposit is credited
2. Share price increases for existing holders
3. New depositor buys at new (higher) share price

**Requirements:**
- Asset transfer of Alpha in preceding transaction
- Amount ≥ MIN_DEPOSIT_AMOUNT (1 token)
- slippageBps ≤ MAX_SLIPPAGE_BPS (10000)

**Share Calculation:**
```
If first deposit:  shares = alphaAmount
Otherwise:         shares = alphaAmount × totalShares / totalAlpha
```

**State Updates:**
- `userShares[user] += sharesToMint`
- `totalShares += sharesToMint`
- `totalAlpha += amount`

---

#### `withdraw(shareAmount: uint64)`
User redeems shares for Alpha (deposit + compounded yield).

**Parameters:**
- `shareAmount`: Shares to redeem (0 = redeem all)

**Requirements:**
- `shareAmount ≤ userShares[user]`

**Alpha Calculation:**
```
alphaAmount = shareAmount × totalAlpha / totalShares
```

**State Updates:**
- `userShares[user] -= shareAmount`
- `totalShares -= shareAmount`
- `totalAlpha -= alphaAmount`

---

#### `closeOut()`
User closes out, receiving all Alpha for their shares.

**Action:** `CloseOut`
**Returns:** `userShares × totalAlpha / totalShares` Alpha

---

### Yield Processing

#### `compoundYield(slippageBps: uint64)`
Swaps accumulated USDC to Alpha and adds to vault.

**Access:** Permissionless (anyone can call)

**Requirements:**
- `usdcBalance ≥ minSwapThreshold`
- `totalShares > 0`
- `slippageBps ≤ MAX_SLIPPAGE_BPS`

**On-Chain Price Calculation:**
1. Reads pool reserves from Tinyman local state
2. Calculates expected output using AMM formula
3. Applies slippage tolerance

**Yield Distribution:**
```
creatorCut = totalOutput × creatorFeeRate / 100
vaultCut = totalOutput - creatorCut
totalAlpha += vaultCut  (share price increases)
```

**Auto-Compounding Effect:**
- totalShares stays the same
- totalAlpha increases
- Share price = totalAlpha / totalShares increases

**Farm Bonus:**
If `farmEmissionRate > 0` AND `farmBalance > 0`:
```
farmBonus = min(swapOutput × farmEmissionRate / 10000, farmBalance)
totalOutput = swapOutput + farmBonus
```

---

### Creator Operations

#### `claimCreator()`
Creator claims accumulated fees in Alpha.

**Access:** Creator only

**Requirements:**
- `creatorUnclaimedAlpha > 0`

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
Anyone can contribute Alpha to the farm.

**Requirements:**
- Asset transfer of Alpha in preceding transaction
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
**Returns:** `[totalShares, totalAlpha, creatorUnclaimedAlpha, usdcBalance, totalYieldCompounded, sharePrice]`

Note: `sharePrice` is scaled by SCALE (1e12)

#### `getUserAlphaBalance(user: Account)`
**Returns:** User's current Alpha value (shares converted)

#### `getUserShares(user: Account)`
**Returns:** User's share balance

#### `previewDeposit(alphaAmount: uint64)`
**Returns:** Shares that would be minted for deposit

#### `previewWithdraw(shareAmount: uint64)`
**Returns:** Alpha that would be received for shares

#### `getCompoundQuote()`
**Returns:** `[usdcBalance, expectedAlphaOutput, minOutputAt50bps]`

#### `getFarmStats()`
**Returns:** `[farmBalance, farmEmissionRate]`

---

## Mathematical Formulas

### Share Calculation

**Deposit (Alpha → Shares):**
```
If totalShares == 0:
    shares = alphaAmount
Else:
    shares = alphaAmount × totalShares / totalAlpha
```

**Withdraw (Shares → Alpha):**
```
If totalShares == 0:
    alphaAmount = 0
Else:
    alphaAmount = shares × totalAlpha / totalShares
```

### Share Price
```
sharePrice = totalAlpha × SCALE / totalShares
```
Where SCALE = 1e12 for precision

### Compound Effect

Before compound:
```
totalShares = S
totalAlpha = A
sharePrice = A / S
```

After compound (vaultCut = V):
```
totalShares = S  (unchanged)
totalAlpha = A + V
sharePrice = (A + V) / S  (increased)
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
- Auto-compound executes BEFORE deposit is credited
- New depositor buys shares at post-compound price
- Cannot capture pre-existing yield

### 2. On-Chain Price Calculation
- Reads Tinyman pool reserves directly
- No off-chain oracle dependency
- Prevents fake quote attacks

### 3. Permissionless Compounding with High Slippage
- 100% max slippage allows compounding in illiquid pools
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
| `closeOut` | ✓ | ✓ | ✓ |
| `compoundYield` | ✓ | ✓ | ✓ |
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

If auto-compound may trigger:
  - appForeignApps: [tinymanPoolAppId]
  - appForeignAssets: [alphaAsset]
  - appAccounts: [poolStateHolderAddress]
  - fee: 5000 micro-ALGO (covers inner txns)
```

### Compound Transaction
```
Group:
  [0] App Call: compoundYield(slippageBps)

Required:
  - appForeignApps: [tinymanPoolAppId]
  - appForeignAssets: [usdcAsset, alphaAsset]
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
  │Shareholder│◄──────────────►│ Partial     │
  └────┬─────┘   (partial)     │ Withdrawal  │
       │                       └─────────────┘
       │ closeOut()
       ▼
  ┌──────────┐
  │  Closed  │
  └──────────┘

Share Price Over Time:
  ────────────────────────────────────────►
  1.0    1.05    1.12    1.20    1.35   time
   │      │       │       │       │
   ▼      ▼       ▼       ▼       ▼
  [C1]   [C2]    [C3]    [C4]    [C5]  compounds
```

---

## Comparison: RareFiVault vs RareFiAlphaCompoundingVault

| Feature | RareFiVault | RareFiAlphaCompoundingVault |
|---------|-------------|----------------------------|
| **Assets** | 3 (Alpha, USDC, Project) | 2 (Alpha, USDC) |
| **Yield Token** | Project's ASA | Alpha (same as deposit) |
| **Accounting** | Yield-per-token accumulator | Share-based |
| **Yield Collection** | Manual claim required | Auto-compounded |
| **Share Price** | N/A | Increases over time |
| **Local State** | 3 variables | 1 variable |
| **Use Case** | Earn project tokens | Grow Alpha position |

---

## Deployment Checklist

1. Deploy contract with `createVault()` parameters
2. Creator calls `optInAssets()` with 5.4 ALGO payment
3. Verify Alpha and USDC are opted-in
4. (Optional) Fund farm with `contributeFarm()`
5. (Optional) Set farm rate with `setFarmEmissionRate()`
6. Users can begin depositing

---

## Known Limitations

1. **MEV Exposure** - High slippage tolerance means sandwich attacks are possible on mainnet
2. **Pool Dependency** - Compounding fails if Tinyman pool state is unreadable
3. **No Emergency Pause** - Contract cannot be paused (users can always withdraw)
4. **Single Pool** - Only one Tinyman pool per vault (can be updated by admin)
5. **Share Price Only Increases** - No mechanism to handle losses (by design)

---

## Example Scenarios

### Scenario 1: Basic Deposit and Compound

1. Alice deposits 1000 Alpha
   - `totalShares = 1000`, `totalAlpha = 1000`
   - Alice receives 1000 shares
   - Share price = 1.0

2. 100 USDC airdrop arrives, compound triggered
   - Swap yields 95 Alpha
   - Creator fee (20%): 19 Alpha
   - Vault receives: 76 Alpha
   - `totalAlpha = 1076`, `totalShares = 1000`
   - Share price = 1.076

3. Alice withdraws all shares
   - Receives: 1000 × 1076 / 1000 = 1076 Alpha
   - Profit: 76 Alpha

### Scenario 2: Late Depositor Fair Price

1. Alice has 1000 shares, share price = 1.1
   - `totalAlpha = 1100`, `totalShares = 1000`

2. Bob deposits 550 Alpha
   - Shares received: 550 × 1000 / 1100 = 500 shares
   - `totalAlpha = 1650`, `totalShares = 1500`
   - Share price still = 1.1

3. Both users withdraw:
   - Alice: 1000 × 1650 / 1500 = 1100 Alpha
   - Bob: 500 × 1650 / 1500 = 550 Alpha

---

## Audit Recommendations

### Priority Areas
1. Share calculation arithmetic (minting, burning)
2. Auto-compound timing (before deposit credit)
3. Tinyman V2 integration (swap execution, state reading)
4. Farm bonus calculation and deduction

### Test Scenarios
- Share price progression over multiple compounds
- Late depositor does not steal yield
- Dust handling on withdrawals
- Pool state reading failures
- Edge cases (first deposit, last withdrawal)
