# RareFiFolksVault Technical Specification

> ⚠️ **CONCEPT VERSION — DO NOT USE IN PRODUCTION**
>
> This specification and its associated contract are an untested concept/draft. The contract has not been audited, tested on-chain, or reviewed for security. It requires significant improvements, thorough testing, and a professional audit before any real funds should be deposited or it should be deployed to mainnet.
>
> **USE AT YOUR OWN RISK.**

---

**Contract Type:** Folks Finance Lending Market Yield Aggregator
**Version:** 1.0
**Last Updated:** March 2026

---

## Overview

RareFiFolksVault is a permissionless yield vault that deposits user USDC into a Folks Finance lending pool (earning interest from borrowers), harvests yield by redeeming only the appreciation in fToken value, and swaps it to a target yield asset via Tinyman V2. Yield is distributed proportionally to all depositors using the standard yield-per-token accumulator pattern. **User principal is never touched during harvests.**

### Key Features
- **Folks Finance integration** - Deposits USDC to earn lending interest
- **fToken-based yield tracking** - Tracks `totalPrincipalFTokens` on-chain; anything beyond that is harvestable yield
- **No oracle required** - Yield is calculated purely from fToken balance delta, no price oracle needed
- **Permissionless harvest** - Anyone can trigger yield redemption and swapping
- **Auto-swap to yield asset** - USDC interest converted to project token via Tinyman
- **Farm bonus** - Optional boosted yields from sponsor contributions

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           RareFiFolksVault                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│  User Flow:                                                                  │
│  ┌─────────────┐                                                            │
│  │    User     │                                                            │
│  └──────┬──────┘                                                            │
│         │ deposit(USDC)                                                     │
│         ▼                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐            │
│  │                    Vault Logic                               │            │
│  │  • Track USDC deposits + fTokens received (local + global)  │            │
│  │  • Forward USDC to Folks Finance pool → receive fUSDC       │            │
│  │  • harvestYield: redeem fTokens above principal baseline    │            │
│  │  • Swap USDC yield → yieldAsset (via Tinyman)              │            │
│  │  • Distribute yield via accumulator                          │            │
│  └─────────────────────────────────────────────────────────────┘            │
│         │                                   │                               │
│         │ inner txn group                   │ harvestYield()                │
│         ▼                                   ▼                               │
│  ┌──────────────────┐              ┌──────────────────┐                     │
│  │  Folks Finance   │──fUSDC──>    │  Tinyman V2 AMM  │                     │
│  │  Lending Pool    │<──USDC──     │   (USDC→Yield)   │                     │
│  │  (borrower APR)  │              └──────────────────┘                     │
│  └──────────────────┘                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Yield Mechanics — How fToken Tracking Works

Folks Finance lending pools issue **fTokens** (e.g. fUSDC) as receipts. These fTokens appreciate in value over time as borrowers pay interest: 1 fUSDC redeems for increasingly more USDC.

The vault tracks two counters:
- `totalPrincipalFTokens` — the sum of all fUSDC received when users deposited USDC
- The vault's actual fUSDC balance (read from ASA balance)

```
yieldFTokens = fTokenBalance - totalPrincipalFTokens
```

`yieldFTokens` grows over time as the exchange rate increases. The `harvestYield` caller passes `fTokensToRedeem ≤ yieldFTokens`, which are redeemed from Folks Finance for USDC, then swapped to the yield asset.

**No oracle needed.** The yield calculation is entirely derived from known on-chain balances.

---

## Global State

| Key | Type | Description |
|-----|------|-------------|
| `usdcAsset` | uint64 | USDC ASA ID (user deposit asset) |
| `fTokenAsset` | uint64 | fUSDC ASA ID (Folks Finance receipt token) |
| `yieldAsset` | uint64 | Target yield ASA ID (swapped from USDC rewards) |
| `folksPoolAppId` | uint64 | Folks Finance lending pool application ID |
| `folksPoolAddress` | Account | Folks Finance pool address (for inner asset transfers) |
| `tinymanPoolAppId` | uint64 | Tinyman V2 pool app ID |
| `tinymanPoolAddress` | Account | Tinyman pool address |
| `totalDeposits` | uint64 | Total USDC deposited by all users (principal tracking) |
| `totalPrincipalFTokens` | uint64 | Total fUSDC received for all user deposits (yield baseline) |
| `yieldPerToken` | uint64 | Yield accumulator (scaled by PRECISION) |
| `totalYieldGenerated` | uint64 | Cumulative yield generated (stats) |
| `creatorAddress` | Account | Vault creator receiving fees |
| `rarefiAddress` | Account | RareFi platform address |
| `creatorFeeRate` | uint64 | Fee rate in basis points (max 600 = 6%) |
| `creatorUnclaimedYield` | uint64 | Accumulated fees for creator |
| `farmBalance` | uint64 | Farm bonus pool balance |
| `emissionRatio` | uint64 | Farm emission rate (basis points, 0 = disabled) |
| `minSwapThreshold` | uint64 | Minimum USDC to trigger swap |

---

## Local State (Per User)

| Key | Type | Description |
|-----|------|-------------|
| `depositedAmount` | uint64 | User's USDC principal in vault |
| `userYieldPerToken` | uint64 | Snapshot of global yieldPerToken at last interaction |
| `earnedYield` | uint64 | Accumulated unclaimed yieldAsset |

---

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `PRECISION` | 1,000,000,000,000 (1e12) | Yield-per-token precision |
| `DEFAULT_MIN_SWAP_THRESHOLD` | 10,000,000 | 10 USDC (6 decimals) |
| `MAX_FEE_RATE` | 600 | Max creator fee (600 bps = 6%) |
| `MIN_FARM_EMISSION_BPS` | 1,000 | Min farm rate when balance > 0 (10%) |

---

## Folks Finance Integration

### Protocol Overview

Folks Finance (V2) is an ARC-4 compliant lending protocol on Algorand. Each asset (USDC, ALGO, etc.) has a dedicated pool smart contract. Deposits return fTokens (ASAs); withdrawals burn fTokens for underlying + accrued interest.

### Key ABI Methods

| Method | Description |
|--------|-------------|
| `deposit(depositTxn)` | Deposit underlying asset, receive fTokens |
| `withdraw(amount, isFAmount)` | Redeem fTokens for underlying + interest |

Both are ARC-4 ABI calls on the pool app. Exact selectors are derived from the ARC-4 method signature and can be confirmed from `@folks-finance/algorand-sdk`.

### Deposit Flow (Inner Transaction Group)

```
┌──────────────────────────────────────────────────────────────┐
│ Inner Transaction Group (issued by vault contract):           │
│                                                               │
│ [1] Asset Transfer: USDC → Folks Pool Address                │
│ [2] App Call: folksPool.deposit(depositTxn)                  │
│     → vault receives fUSDC back                              │
└──────────────────────────────────────────────────────────────┘
```

After this group, the vault's fUSDC balance increases. The number of fUSDC received is recorded by comparing the vault's fUSDC balance before and after, and that delta is added to `totalPrincipalFTokens`.

### Withdraw Flow (Inner Transaction Group)

```
┌──────────────────────────────────────────────────────────────┐
│ Inner Transaction Group (issued by vault contract):           │
│                                                               │
│ [1] Asset Transfer: fUSDC → Folks Pool Address               │
│ [2] App Call: folksPool.withdraw(fTokenAmount, isFAmount=1)  │
│     → vault receives USDC back                               │
└──────────────────────────────────────────────────────────────┘
```

The fToken amount to redeem for a user is calculated proportionally:
```
fTokensToRedeem = (withdrawAmount / totalDeposits) × totalPrincipalFTokens
```

### Harvest Flow (Inner Transaction Group)

```
┌──────────────────────────────────────────────────────────────┐
│ Inner Transaction Group (yield redemption):                   │
│                                                               │
│ [1] Asset Transfer: fUSDC (yield portion) → Folks Pool       │
│ [2] App Call: folksPool.withdraw(fTokensToRedeem, isFAmount=1)│
│     → vault receives USDC (only the yield, not principal)    │
└──────────────────────────────────────────────────────────────┘
Then:
│ [3] App Call: tinymanPool swap USDC → yieldAsset             │
└──────────────────────────────────────────────────────────────┘
```

### Isolated vs. Regular Pools

Folks Finance isolation is at the **loan level** (relevant only for borrowers). For a pure deposit vault there is no pool-level isolation distinction — all Folks lending pools share the same deposit interface.

To support different assets (ALGO, USDt, etc.), deploy separate vault instances pointing to the relevant Folks pool app ID. Each vault is a single-asset deposit vault.

---

## ABI Methods

### Initialization

#### `createApplication()`
Creates and initializes the vault. Called once at deployment.

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| `usdcAssetId` | uint64 | USDC ASA ID |
| `fTokenAssetId` | uint64 | fUSDC ASA ID |
| `yieldAssetId` | uint64 | Target yield ASA ID |
| `folksPoolAppId` | uint64 | Folks Finance lending pool app ID |
| `folksPoolAddress` | Account | Folks Finance pool address |
| `tinymanPoolAppId` | uint64 | Tinyman V2 pool app ID |
| `tinymanPoolAddress` | Account | Tinyman pool address |
| `creatorFeeRate` | uint64 | Fee rate in basis points (0–600) |
| `rarefiAddress` | Account | RareFi platform address |

**Validations:**
- `creatorFeeRate ≤ MAX_FEE_RATE` (600)

---

#### `optInToAssets()`
Opts the vault contract into USDC, fUSDC, and yieldAsset.

**Access:** Creator or RareFi only

**Actions:**
- Inner asset transfer (amount=0) to self for usdcAsset
- Inner asset transfer (amount=0) to self for fTokenAsset
- Inner asset transfer (amount=0) to self for yieldAsset

---

#### `optInToFolksPool()`
Opts the vault into the Folks Finance pool (required before depositing).

**Access:** Creator or RareFi only

**Actions:**
- Sends OptIn app call to Folks pool

---

### User Operations

#### `optIn()`
User opts into the contract to enable local storage.

**Action:** `OptIn`
**Initializes:** `depositedAmount = 0`, `earnedYield = 0`, `userYieldPerToken = yieldPerToken`

---

#### `deposit(usdcTransfer: AssetTransferTxn)`
User deposits USDC. USDC is forwarded to Folks Finance; vault receives fUSDC.

**Requirements:**
- Preceding transaction is an asset transfer of `usdcAsset` to the vault
- `amount > 0`
- Transfer sender equals caller
- `rekeyTo == ZeroAddress` on all group txns

**State Updates:**
1. Sync user yield (update `earnedYield` before any state change)
2. Record fUSDC balance before deposit
3. Issue inner txn group: forward USDC to Folks pool → receive fUSDC
4. Calculate `fTokensReceived = newFTokenBalance - oldFTokenBalance`
5. `totalPrincipalFTokens += fTokensReceived`
6. `depositedAmount[user] += amount`
7. `totalDeposits += amount`
8. Update `userYieldPerToken[user] = yieldPerToken`

---

#### `withdraw(amount: uint64)`
User withdraws USDC principal from the vault.

**Parameters:**
- `amount` — USDC amount to withdraw (must be ≤ `depositedAmount[user]`)

**Requirements:**
- `amount > 0 && amount ≤ depositedAmount[user]`

**State Updates:**
1. Sync user yield
2. Calculate proportional fTokens to redeem:
   ```
   fTokensToRedeem = (amount × totalPrincipalFTokens) / totalDeposits
   ```
3. Issue inner txn group: send fTokens to Folks pool → receive USDC back
4. `totalPrincipalFTokens -= fTokensToRedeem`
5. `depositedAmount[user] -= amount`
6. `totalDeposits -= amount`
7. Send USDC to user
8. If `earnedYield[user] > 0`: auto-claim (send yieldAsset to user, reset to 0)

---

#### `claimYield()`
User claims accumulated yield without withdrawing principal.

**Requirements:**
- `earnedYield[user] > 0`

**State Updates:**
- `earnedYield[user] = 0`
- Send yieldAsset to user

---

#### `closeOut()`
User closes out, receiving all deposited USDC and any pending yield.

**Action:** `CloseOut`
**Returns:** All deposited USDC (via full withdraw from Folks) + all pending yieldAsset

---

### Yield Processing

#### `harvestYield(fTokensToRedeem: uint64)`
Redeems the yield-only portion of fTokens, swaps USDC to yieldAsset, distributes.

**Access:** Permissionless (anyone can call)

**Parameters:**
- `fTokensToRedeem` — Number of fUSDC tokens to redeem (must not exceed yield portion)

**On-chain Guard:**
```
yieldFTokens = fTokenBalance - totalPrincipalFTokens
assert fTokensToRedeem ≤ yieldFTokens
```
This ensures principal fTokens are never redeemed.

**Steps:**
1. Assert `fTokensToRedeem > 0`
2. Assert `fTokensToRedeem ≤ (fTokenBalance - totalPrincipalFTokens)` — principal safety guard
3. Issue inner txn group: redeem `fTokensToRedeem` fUSDC from Folks → receive USDC
4. If received USDC ≥ `minSwapThreshold`: swap via Tinyman USDC → yieldAsset
5. Deduct creator fee: `fee = yieldReceived × creatorFeeRate / 10000`
6. Apply farm bonus if `emissionRatio > 0 && farmBalance > 0`
7. Update `yieldPerToken` accumulator
8. `totalYieldGenerated += netYield`

**Note:** The caller is responsible for computing `fTokensToRedeem` off-chain by reading the vault's current fToken balance vs. `totalPrincipalFTokens`. This is a simple algod account asset balance read.

---

#### `forceSwap()`
Force swap any USDC held by vault even below `minSwapThreshold`.

**Access:** Permissionless

**Requirements:**
- Vault holds USDC > 0

---

### Creator Operations

#### `claimCreatorFees()`
Creator claims accumulated fee yield.

**Access:** Creator only

**Requirements:**
- `creatorUnclaimedYield > 0`

---

#### `updateCreatorFeeRate(newFeeRate: uint64)`
Updates the creator fee rate.

**Access:** Creator only

**Requirements:**
- `newFeeRate ≤ MAX_FEE_RATE` (600)

---

### Admin Operations

#### `updateMinSwapThreshold(newThreshold: uint64)`
Updates minimum USDC to trigger an automatic swap.

**Access:** Creator or RareFi

---

#### `updateTinymanPool(newPoolAppId: uint64, newPoolAddress: Account)`
Updates Tinyman pool configuration.

**Access:** Creator or RareFi

**Validations:**
- Pool must contain both usdcAsset and yieldAsset (read pool local state to verify)

---

#### `updateCreatorAddress(newAddress: Account)`
Updates the creator address.

**Access:** Current creator only

---

#### `updateRarefiAddress(newAddress: Account)`
Updates the RareFi platform address.

**Access:** RareFi only

---

### Farm Operations

#### `contributeFarm(farmTransfer: AssetTransferTxn)`
Anyone can contribute yieldAsset to the farm bonus pool.

**Requirements:**
- Asset transfer of yieldAsset in preceding transaction
- Transfer to vault address
- Transfer sender equals caller

---

#### `setEmissionRatio(newRatio: uint64)`
Sets farm emission rate.

**Access:** Creator or RareFi

**Requirements:**
- If `farmBalance > 0 && newRatio > 0`: `newRatio ≥ MIN_FARM_EMISSION_BPS` (1000 = 10%)

---

### Read-Only Methods

#### `getPendingYield(user: Account) → uint64`
Returns user's pending unclaimed yield (without claiming).

#### `getUserDeposit(user: Account) → uint64`
Returns user's current USDC principal.

#### `getVaultStats() → [uint64, uint64, uint64, uint64]`
Returns `[totalDeposits, totalYieldGenerated, farmBalance, yieldFTokens]`
where `yieldFTokens = fTokenBalance - totalPrincipalFTokens` (harvestable amount).

---

## Mathematical Formulas

### fToken Principal Tracking

On deposit:
```
fTokensReceived = vaultFTokenBalance_after - vaultFTokenBalance_before
totalPrincipalFTokens += fTokensReceived
```

On withdraw:
```
fTokensToRedeem = (withdrawAmount × totalPrincipalFTokens) / totalDeposits
totalPrincipalFTokens -= fTokensToRedeem
```

Harvestable yield at any time:
```
yieldFTokens = vaultFTokenBalance - totalPrincipalFTokens
```

### Yield Per Token Accumulator

When yield is distributed:
```
creator_fee = yieldAmount × creatorFeeRate / 10000
net_yield = yieldAmount - creator_fee
yield_per_token += (net_yield × PRECISION) / totalDeposits
creatorUnclaimedYield += creator_fee
```

When user yield is synced (before any state change):
```
pending = depositedAmount[user] × (yieldPerToken - userYieldPerToken[user]) / PRECISION
earnedYield[user] += pending
userYieldPerToken[user] = yieldPerToken
```

### Farm Bonus Calculation

```
dynamic_rate = max(MIN_FARM_EMISSION_BPS, farmBalance × emissionRatio / totalDeposits)
potential_bonus = base_yield × dynamic_rate / 10000
actual_bonus = min(potential_bonus, farmBalance)
total_yield = base_yield + actual_bonus
farmBalance -= actual_bonus
```

### Safe Math

Uses 128-bit precision for yield distribution:
```
[hi, lo] = mulw(depositedAmount, yieldPerTokenDelta)
[q_hi, q_lo, _, _] = divmodw(hi, lo, 0, PRECISION)
assert q_hi == 0
pending = q_lo
```

---

## Security Features

### 1. Principal Segregation via fToken Accounting
- `totalPrincipalFTokens` is the on-chain record of how many fTokens belong to user principal
- `harvestYield` is guarded: `fTokensToRedeem ≤ fTokenBalance - totalPrincipalFTokens`
- Even if the caller passes a malicious value, the on-chain check prevents touching principal

### 2. Yield Synchronization
- User yield is synced before ANY state change to that user's record
- Prevents yield dilution or inflation attacks

### 3. Permissionless Harvest
- Anyone can call `harvestYield` with any valid `fTokensToRedeem ≤ yieldFTokens`
- No operational single point of failure

### 4. Safe Integer Arithmetic
- 128-bit precision (`mulw`/`divmodw`) for all yield distribution calculations
- Floor division prevents rounding exploits

### 5. rekeyTo Guards
- All app call methods assert `rekeyTo == ZeroAddress` on the calling transaction

### 6. Zero Address Guards
- Creator and RareFi address updates assert new address is not zero

### 7. No Update/Delete
- Contract is immutable post-deployment (deny update and delete app calls)

---

## Access Control Matrix

| Method | Anyone | Creator | RareFi |
|--------|--------|---------|--------|
| `optIn` | ✓ | ✓ | ✓ |
| `deposit` | ✓ | ✓ | ✓ |
| `withdraw` | ✓ | ✓ | ✓ |
| `claimYield` | ✓ | ✓ | ✓ |
| `closeOut` | ✓ | ✓ | ✓ |
| `harvestYield` | ✓ | ✓ | ✓ |
| `forceSwap` | ✓ | ✓ | ✓ |
| `contributeFarm` | ✓ | ✓ | ✓ |
| `optInToAssets` | ✗ | ✓ | ✓ |
| `optInToFolksPool` | ✗ | ✓ | ✓ |
| `claimCreatorFees` | ✗ | ✓ | ✗ |
| `updateCreatorFeeRate` | ✗ | ✓ | ✗ |
| `updateCreatorAddress` | ✗ | ✓ | ✗ |
| `updateRarefiAddress` | ✗ | ✗ | ✓ |
| `setEmissionRatio` | ✗ | ✓ | ✓ |
| `updateMinSwapThreshold` | ✗ | ✓ | ✓ |
| `updateTinymanPool` | ✗ | ✓ | ✓ |

---

## Transaction Requirements

### Deposit Transaction
```
Group:
  [0] Asset Transfer: USDC → Vault
  [1] App Call: deposit(usdcTransfer)

Required:
  - appForeignApps: [folksPoolAppId]
  - appForeignAssets: [usdcAsset, fTokenAsset]
  - appAccounts: [folksPoolAddress]
  - fee: 5000 micro-ALGO (covers 2 inner txns: asset transfer + app call)
```

### Withdraw Transaction
```
Group:
  [0] App Call: withdraw(amount)

Required:
  - appForeignApps: [folksPoolAppId]
  - appForeignAssets: [usdcAsset, fTokenAsset, yieldAsset]
  - appAccounts: [folksPoolAddress]
  - fee: 5000 micro-ALGO (covers 2 inner txns: asset transfer + app call)
```

### harvestYield Transaction
```
Group:
  [0] App Call: harvestYield(fTokensToRedeem)

Required:
  - appForeignApps: [folksPoolAppId, tinymanPoolAppId]
  - appForeignAssets: [usdcAsset, fTokenAsset, yieldAsset]
  - appAccounts: [folksPoolAddress, tinymanPoolAddress]
  - fee: 7000 micro-ALGO (covers: fToken transfer + Folks withdraw + Tinyman swap)
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
  │Depositor │ ◄──────────────►│   Partial   │
  └────┬─────┘   (partial)     │  Withdrawal │
       │                       └─────────────┘
       │ closeOut()
       ▼
  ┌──────────┐
  │  Closed  │
  └──────────┘

Harvest Cycle:
  ┌──────────────────────────────────────────────────────────────┐
  │                                                              │
  │  fTokenBalance grows over time as exchange rate increases    │
  │  totalPrincipalFTokens stays fixed between deposits/withdraws│
  │                                                              │
  │  ┌─────────────────────────────────────────────────────┐     │
  │  │ vault fToken balance                                 │     │
  │  │ [====principal====][==yield==] ← harvestable        │     │
  │  └─────────────────────────────────────────────────────┘     │
  │                                                              │
  │  harvestYield(fTokensToRedeem) →                            │
  │  ┌───────────┐  USDC    ┌────────────┐  yieldAsset          │
  │  │  Folks    │ ──────►  │  Tinyman   │ ─────────►           │
  │  │  Pool     │          │  V2 AMM    │  yieldPerToken++      │
  │  └───────────┘          └────────────┘                       │
  └──────────────────────────────────────────────────────────────┘
```

---

## Deployment Checklist

1. Deploy contract with `createApplication()` parameters
2. Fund vault with minimum ALGO balance (for 3 asset opt-ins + app opt-in)
3. Creator/RareFi calls `optInToAssets()` — opts into USDC, fUSDC, yieldAsset
4. Creator/RareFi calls `optInToFolksPool()` — opts into Folks pool app
5. Verify all opt-ins successful via algod account info
6. (Optional) Fund farm with `contributeFarm()`
7. (Optional) Set farm rate with `setEmissionRatio()`
8. Users can begin depositing

---

## Known Limitations

1. **Folks Finance Dependency** - If Folks pool is paused/frozen, withdrawals from vault will fail
2. **Single Pool** - One Folks pool per vault (e.g. USDC only); deploy separate vaults for other assets
3. **fToken Rounding** - Integer math means `totalPrincipalFTokens` may drift by 1 unit on many deposit/withdraw cycles; this is negligible and always conservative (principal is never over-redeemed)
4. **Swap Slippage** - Tinyman swap uses `minOut=1` (permissionless but MEV-exposed on large harvests); consider adding a `minAmountOut` parameter in a future version
5. **No Emergency Pause** - Contract is immutable; in a Folks Finance exploit scenario there is no admin escape hatch
6. **Deposit Asset Flexibility** - Currently assumes USDC (6 decimals); deploying for ALGO or other assets requires care around decimal handling in proportional fToken math

---

## Differences from Other RareFi Vaults

| Feature | RareFiVault | RareFiAllbridgeVault | **RareFiFolksVault** |
|---------|-------------|----------------------|----------------------|
| Deposit Asset | Alpha | USDC | USDC (or any Folks asset) |
| Yield Source | USDC airdrops | Allbridge bridge fees | Folks Finance lending APR |
| Principal Storage | Held in vault | Deposited to Allbridge | Deposited to Folks (as fTokens) |
| Yield Mechanism | Periodic swap | claimRewards() | fToken appreciation |
| Oracle Required | No | No | No |
| Harvest Trigger | Auto on deposit | Manual harvest() | Manual harvestYield(fTokenAmt) |
| Yield Asset | Project token | Project token | Project token |
| Inner Txn Groups | 1 (Tinyman) | 2 (Allbridge deposit + Tinyman) | 2 (Folks deposit/withdraw + Tinyman) |

---

## External References

- Folks Finance SDK: `@folks-finance/algorand-sdk` (npm)
- Folks Finance GitHub: https://github.com/Folks-Finance/algorand-js-sdk
- Folks Finance Docs: https://docs.folks.finance/developer/contracts
- Pool Manager App ID (Mainnet): 971350278
- Deposit App ID (Mainnet): 971353536
- Per-asset pool app IDs: see https://docs.folks.finance/developer/contracts

---

## Audit Recommendations

### Priority Areas
1. **fToken proportion math** — `fTokensToRedeem` calculation in `withdraw` and the principal guard in `harvestYield`; verify no rounding path allows principal drain
2. **Inner transaction group ordering** — Ensure fToken balance reads happen before/after the Folks inner group correctly
3. **Yield accumulator arithmetic** — rounding, overflow in mulDivFloor
4. **Local state synchronization timing** — yield must sync before any balance change

### Test Scenarios
- Multi-user yield distribution fairness over many harvest cycles
- Partial withdraw + yield claim atomicity
- harvestYield with maximal fTokensToRedeem (entire yield portion)
- Attempt to pass `fTokensToRedeem > yieldFTokens` (should revert)
- Single depositor full lifecycle (deposit → multiple harvests → full withdraw)
- Zero-deposit edge case (harvest when totalDeposits == 0 must be guarded)
- Concurrent deposit + harvestYield in same block
