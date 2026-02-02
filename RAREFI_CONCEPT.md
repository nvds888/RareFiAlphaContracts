# RareFi Protocol

## Overview

RareFi is a yield routing protocol on Algorand that connects yield-bearing assets with project tokens. Users deposit their yield-generating assets into project-specific vaults and receive the project's token as yield - instead of the underlying yield asset.

The protocol creates a win-win: users get exposure to tokens they believe in while maintaining their principal, and projects get continuous buying pressure for their ASA funded by real yield.

---

## The Problem

**For Users:**
- Holding yield-bearing assets (like Alpha from Alpha Arcade) generates yield in USDC
- Users who want exposure to specific project tokens must manually swap their yield
- Auto-compounding back into the yield-bearing asset requires manual management

**For Projects:**
- Getting sustainable buying pressure for your ASA is difficult
- Airdrops and liquidity mining create sell pressure, not buy pressure
- No way to tap into the yield that's flowing through the Algorand ecosystem

---

## The Solution

RareFi vaults act as a bridge:

```
User deposits yield-bearing asset (Alpha)
         |
         v
    [RareFi Vault]
         |
         v
Yield accrues (USDC airdrops)
         |
         v
RareFi swaps Yield -> Target Asset
         |
         v
User receives Target Asset as yield
```

Users keep their principal intact and withdraw anytime. The yield is automatically converted to the target asset.

---

## Two Vault Types

### 1. RareFiVault (Project Token Yield)

For users who want to earn **project tokens** from their Alpha holdings.

**How it works:**
- Alpha Arcade periodically airdrops USDC to Alpha holders
- Users deposit Alpha into a RareFi vault for a specific project
- When USDC airdrops arrive at the vault, it's swapped to the project's token via Tinyman
- Users claim their share of project tokens proportional to their Alpha deposit

**Yield flow:** Alpha -> USDC airdrop -> Swap to Project Token -> Claim

**Key features:**
- Yield-per-token accumulator pattern (fair distribution)
- Auto-swap on deposit (flash deposit protection)
- Permissionless swaps (anyone can trigger)
- Farm bonus (optional boosted yields)

**Use case:** Earn your favorite project's token while holding Alpha


### 2. RareFiAlphaCompoundingVault (Auto-Compounding)

For users who want to **grow their Alpha position** automatically.

**How it works:**
- Users deposit Alpha into the compounding vault
- When USDC airdrops arrive, they're automatically swapped back to Alpha via Tinyman
- The Alpha compounds into the vault, increasing the share price
- Users withdraw more Alpha than they deposited

**Yield flow:** Alpha -> USDC airdrop -> Swap back to Alpha -> Compounds automatically

**Key features:**
- Share-based accounting (similar to ERC4626)
- Auto-compound on deposit (flash deposit protection)
- Permissionless compounding (anyone can trigger)
- Farm bonus (optional boosted yields)
- Share price increases over time

**Use case:** Maximize Alpha holdings through automatic compounding

---

## Value Proposition

### For Users

| Benefit | Description |
|---------|-------------|
| **Keep your principal** | Deposit Alpha, withdraw anytime with full amount (plus yield for compounding vault) |
| **Automatic yield handling** | No manual swapping needed |
| **Choice of yield type** | Earn project tokens OR compound back to Alpha |
| **Fair distribution** | Yield is proportional to deposit amount and time |
| **No lock-up** | Withdraw principal whenever you want |
| **Protected from snipers** | Auto-swap/compound on deposit ensures yield goes to existing holders |

### For Projects

| Benefit | Description |
|---------|-------------|
| **Organic buying pressure** | Real yield is swapped into your ASA continuously |
| **Yield routing** | Redirect ecosystem yield flows toward your token |
| **Community earning** | Your supporters earn your token seamlessly |
| **Engaged holders** | Users actively chose your project's vault |
| **Configurable fees** | Take a percentage of swapped yield as project revenue |

### For RareFi

| Revenue Stream | Description |
|----------------|-------------|
| **Setup fee** | 5.4-5.5 ALGO per vault deployment (MBR + operational) |
| **Swap execution** | Platform controls swap timing for optimal execution |

---

## Technical Architecture

### RareFiVault (Project Token Yield)

**Yield Distribution Model: yieldPerToken Accumulator**

This is the standard staking rewards pattern (used by Synthetix, Compound, etc.):

```
When yield arrives and is swapped:
  yieldPerToken += (yieldAmount * SCALE) / totalDeposits

When user claims:
  pending = userDeposit * (yieldPerToken - userSnapshot) / SCALE
  userSnapshot = yieldPerToken
```

This ensures:
- Fair distribution based on deposit amount
- Users can claim anytime
- Gas-efficient (O(1) per user action)

**Contract State:**
- 3 assets: depositAsset (Alpha), yieldAsset (USDC), swapAsset (Project Token)
- 3 local state variables per user: depositedAmount, userYieldPerToken, earnedYield


### RareFiAlphaCompoundingVault (Auto-Compounding)

**Yield Distribution Model: Share-Based Accounting**

Similar to ERC4626 vaults:

```
Share price = totalAlpha / totalShares

On deposit:
  shares = alphaAmount * totalShares / totalAlpha

On compound:
  totalAlpha += compoundedAmount (shares stay same)
  share price increases

On withdraw:
  alphaAmount = shares * totalAlpha / totalShares
```

This ensures:
- Automatic compounding without user action
- Late depositors pay fair share price
- Simple accounting (1 local state variable)

**Contract State:**
- 2 assets: alphaAsset (Alpha), usdcAsset (USDC)
- 1 local state variable per user: userShares

---

## Protocol Integration: Tinyman V2

Both vaults use Tinyman V2 for swaps.

**On-Chain Price Calculation:**
1. Read pool reserves directly from Tinyman local state
2. Calculate expected output using AMM formula
3. Apply slippage tolerance
4. Execute swap via inner transactions
5. Verify output meets minimum

**Why on-chain price calculation:**
- No oracle dependency
- No off-chain price feeds to trust
- Swap fails if slippage exceeded
- Prevents fake quote attacks

---

## Security Model

### Access Control

| Action | Who can do it |
|--------|---------------|
| Deploy vault | Anyone (permissionless) |
| Configure vault | Creator at deployment only |
| Trigger swaps/compounds | Anyone (permissionless) |
| Deposit/withdraw | Any opted-in user |
| Claim yield | Any user with pending yield |
| Set farm emission rate | Creator or RareFi |
| Upgrade contract | Nobody (disabled) |
| Delete contract | Nobody (disabled) |

### Safety Features

- **No upgrades:** Contracts cannot be modified after deployment
- **No deletion:** Contracts cannot be deleted (user funds always accessible)
- **Slippage protection:** Swaps revert if output below minimum
- **Minimum thresholds:** Prevents dust attacks and unprofitable swaps
- **Safe math:** 128-bit multiplication prevents overflow
- **Auto-swap on deposit:** Prevents flash deposit attacks

### Flash Deposit Protection

A critical security feature that prevents "yield sniping" attacks.

**The Problem:**
Without protection, when a USDC airdrop arrives at the vault, an attacker could:
1. Monitor the vault for incoming USDC
2. Deposit a large amount right before the swap
3. Capture a share of yield they didn't earn
4. Withdraw immediately after

**The Solution:**
When deposit is called and USDC balance >= threshold:
1. Swap executes FIRST (yield goes to existing depositors)
2. THEN the new deposit is credited
3. New depositor cannot capture pre-existing yield

**Benefits:**
- Fair yield distribution to loyal holders
- No lock-ups needed
- Minimal disruption (deposit still succeeds)
- Self-penalizing if attacker sends USDC (becomes yield for others)

---

## Farm Feature

Both vaults support an optional farm bonus that sponsors can fund.

**How it works:**
1. Anyone can contribute tokens to the farm via `contributeFarm()`
2. Creator/RareFi sets emission rate (e.g., 10% = 1000 bps)
3. On each swap/compound, farm bonus is added proportionally:
   ```
   farmBonus = min(swapOutput * emissionRate / 10000, farmBalance)
   totalOutput = swapOutput + farmBonus
   ```
4. Farm depletes over time as bonuses are paid out

**Use cases:**
- Projects can boost yields for their vault
- Marketing campaigns with enhanced APY
- Community incentives

---

## Fees

### Vault Creation
- **MBR:** 5.4-5.5 ALGO (stays in contract for asset opt-ins and operations)

### Yield Fees
- **Creator fee:** 0-100% of yield (set at deployment)
- **Example:** If creator fee is 20% and 100 USDC yield is swapped:
  - 20 USDC worth of output -> Creator
  - 80 USDC worth of output -> Users

---

## Deployment Flow

### For Projects (Vault Creators)

1. **Prepare:**
   - Have your project ASA created (for RareFiVault)
   - Ensure Tinyman pool exists (USDC/YourToken or USDC/Alpha)
   - Prepare 5.5 ALGO for setup

2. **Deploy:**
   - Call `createVault()` with configuration
   - Call `optInAssets()` with ALGO payment

3. **Operate:**
   - Monitor for yield accumulation
   - Call `swapYield()` / `compoundYield()` when threshold met
   - Claim creator fees periodically

### For Users

1. **Choose a vault** for a project you like (or compounding vault)
2. **Opt in** to the vault contract
3. **Deposit** Alpha tokens
4. **Wait** for yield to accumulate
5. **Claim** tokens (RareFiVault) or **withdraw** with gains (Compounding)
6. **Withdraw** principal whenever you want

---

## Example Scenarios

### Scenario 1: RareFiVault for ProjectX

1. Alice deposits 10,000 Alpha (worth $1,000)
2. Bob deposits 40,000 Alpha (worth $4,000)
3. Total vault: 50,000 Alpha

4. Alpha Arcade airdrops $100 USDC to the vault

5. RareFi swaps $100 USDC -> 500 ProjectX tokens
   - This creates $100 of buying pressure for ProjectX on Tinyman

6. Distribution (creator fee 10%):
   - Creator: 50 ProjectX (project revenue)
   - Users: 450 ProjectX
     - Alice (20%): 90 ProjectX
     - Bob (80%): 360 ProjectX

7. Alice and Bob claim their tokens whenever convenient

**Result:** ProjectX gets recurring buy pressure from Alpha Arcade yield.


### Scenario 2: RareFiAlphaCompoundingVault

1. Alice deposits 1,000 Alpha
   - Receives 1,000 shares (1:1 initial ratio)
   - Share price: 1.0

2. Alpha Arcade airdrops 100 USDC to the vault

3. Compound triggered: 100 USDC -> 95 Alpha (after fees)
   - Creator fee (20%): 19 Alpha
   - Vault receives: 76 Alpha
   - New totalAlpha: 1,076
   - Share price: 1.076

4. Bob deposits 500 Alpha
   - Receives: 500 / 1.076 = 464.7 shares
   - Bob did NOT capture Alice's yield

5. More compounds happen, share price rises to 1.2

6. Alice withdraws all 1,000 shares
   - Receives: 1,000 * 1.2 = 1,200 Alpha
   - Profit: 200 Alpha from compounding

**Result:** Alice grew her Alpha position by 20% through automatic compounding.

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

## Contracts

- `RareFiVault.algo.ts` - Alpha yield -> Project tokens
- `RareFiAlphaCompoundingVault.algo.ts` - Alpha yield -> More Alpha (auto-compound)
- `MockTinymanPool.algo.ts` - Test mock for Tinyman V2

**Integrations:**
- Tinyman V2 (swaps)
- Alpha Arcade (yield source)

**Status:** Smart contracts complete and tested on localnet. Ready for testnet deployment.
