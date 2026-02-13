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
| **Creator fees** | Configurable fee (0-6%) on swapped yield as project revenue |

### For RareFi

| Revenue Stream | Description |
|----------------|-------------|
| **Vault deployment** | RareFi deploys vault contracts for projects (5.4-5.5 ALGO MBR) |
| **Platform fee** | Performance fee on yield swapped via default dApp |

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
| Update creator fee rate | Creator only (0-6% range) |
| Trigger swaps/compounds | Anyone (permissionless) |
| Deposit/withdraw | Any opted-in user |
| Claim yield | Any user with pending yield |
| Set emission ratio | Creator or RareFi (must be > 0) |
| Upgrade contract | Nobody (disabled) |
| Delete contract | Nobody (disabled) |

### Safety Features

- **Phishing attack prevention:** All incoming transactions validated for dangerous fields:
  - `rekeyTo` must be zero (prevents account takeover)
  - `closeRemainderTo` must be zero (prevents fund drain)
  - `assetCloseTo` must be zero (prevents asset drain)
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

Both vaults support an optional farm bonus that sponsors can fund, with a **dynamic emission rate** that auto-adjusts based on the ratio of farm balance to total deposits.

**How it works:**
1. Anyone can contribute tokens to the farm via `contributeFarm()`
2. Creator/RareFi sets an `emissionRatio` multiplier via `setEmissionRatio()`
3. The emission rate is calculated dynamically on every swap/compound:
   ```
   dynamicRate = max(10%, farmBalance × emissionRatio / totalDeposits)
   farmBonus = min(swapOutput × dynamicRate / 10000, farmBalance)
   totalOutput = swapOutput + farmBonus
   ```
4. The rate self-adjusts: high farm balance = high rate, as farm depletes the rate drops smoothly (geometric decay — constant % drain per swap)
5. 10% floor ensures contributors always get meaningful distribution when farm > 0

**Geometric decay properties:**
- Each swap drains a fixed percentage of the remaining farm balance
- Half-life is the same regardless of starting farm amount
- Creator can tune aggressiveness by adjusting `emissionRatio` at any time (e.g., after price changes)

**Use cases:**
- Projects can boost yields for their vault with predictable, self-adjusting distribution
- Marketing campaigns with enhanced APY that naturally tapers off
- Community incentives with smooth, fair depletion

### Managing Farm Emissions (Creator / RareFi Guide)

Farm incentives are **disabled by default** after deployment. To activate and manage them:

**Step 1 — Fund the farm:**
```
contributeFarm()  →  send tokens to the farm (anyone can do this)
```

**Step 2 — Activate emissions:**
```
setEmissionRatio(ratio)  →  set the multiplier (creator or RareFi only, must be > 0)
```

Both steps are required. Funding without a ratio means tokens sit idle. Setting a ratio without funding means no bonus is distributed.

**What does `emissionRatio` mean?**

The `emissionRatio` controls **how much of the farm gets paid out as bonus each swap**. Higher number = bigger bonus per swap = farm empties faster.

**Real-world example:**

A vault has 200,000 Alpha deposited and generates ~40 Alpha yield per weekly swap. The creator funds the farm with 10,000 Alpha via `contributeFarm()`. Now they need to choose an `emissionRatio`:

| `emissionRatio` | Bonus from farm | Users receive per swap | Farm drain per swap | Farm half-life |
|---|---|---|---|---|
| 50,000 | 10 Alpha | 50 Alpha (+25%) | 0.1% | ~13 years |
| 250,000 | 50 Alpha | 90 Alpha (+125%) | 0.5% | ~2.5 years |
| **500,000** | **100 Alpha** | **140 Alpha (+250%)** | **1%** | **~16 months** |
| 1,250,000 | 250 Alpha | 290 Alpha (+625%) | 2.5% | ~6 months |
| 2,500,000 | 500 Alpha | 540 Alpha (+1250%) | 5% | ~3 months |

A good starting point here is **500,000** — users get a meaningful 100 Alpha bonus on top of their 40 Alpha yield, and the 10,000 Alpha farm lasts about 16 months.

**How it behaves as the vault grows:**

The absolute farm bonus stays roughly the same regardless of vault size (assuming yield scales with deposits). If deposits double to 400,000 Alpha:
- Yield doubles to ~80 Alpha per swap
- Farm bonus stays at ~100 Alpha per swap
- But each user gets a smaller share because there are more depositors

The farm acts like a fixed weekly marketing budget — the total spend is constant, but the per-user benefit dilutes as the vault grows.

**How it behaves as the farm depletes:**

The bonus automatically shrinks as the farm empties. With `emissionRatio = 500,000`:
- Week 1: farm = 10,000 → bonus = 100 Alpha
- Week 50: farm = 6,000 → bonus = 60 Alpha
- Week 100: farm = 3,600 → bonus = 36 Alpha

This is geometric decay — no manual adjustment needed. The farm never runs out abruptly; it tapers smoothly.

The bonus is always capped at the remaining farm balance — the farm can never go negative.

**Adjusting after activation:**

Call `setEmissionRatio(newRatio)` at any time. Takes effect on the next swap/compound.

| Action | Effect |
|--------|--------|
| Increase `emissionRatio` | Bigger bonus per swap, farm drains faster |
| Decrease `emissionRatio` | Smaller bonus per swap, farm lasts longer |
| Add more via `contributeFarm()` | More tokens in farm, bonus per swap increases automatically |

**Monitoring:**

Call `getFarmStats()` (read-only) to check:
- `farmBalance` — tokens remaining in the farm
- `emissionRatio` — current multiplier setting
- `currentDynamicRate` — the live emission rate in basis points (e.g., 2500 = 25%)

**Full scenario — farm dynamics over time:**

Starting conditions: `emissionRatio = 500,000`, 10,000 Alpha in farm, 200,000 Alpha deposited, ~40 Alpha yield per weekly swap. The farm drains at 1% per swap.

| Week | Event | Deposits | Yield | Farm | Bonus | Users get | Boost |
|------|-------|----------|-------|------|-------|-----------|-------|
| 0 | Launch | 200k | 40 | 10,000 | 100 | 140 | +250% |
| 10 | — | 200k | 40 | 9,044 | 90 | 130 | +225% |
| 25 | Deposits grow to 300k | 300k | 60 | 7,778 | 78 | 138 | +130% |
| 35 | — | 300k | 60 | 7,036 | 70 | 130 | +117% |
| 40 | Creator tops up farm +5k | 300k | 60 | 11,758 | 118 | 178 | +197% |
| 50 | — | 300k | 60 | 10,639 | 106 | 166 | +177% |
| 60 | Deposits grow to 500k | 500k | 100 | 9,618 | 96 | 196 | +96% |
| 80 | — | 500k | 100 | 7,867 | 79 | 179 | +79% |
| 100 | — | 500k | 100 | 6,434 | 64 | 164 | +64% |

**Key observations from this scenario:**

1. **Farm drains at a constant 1% per swap** — regardless of vault size. This is because the yield scales proportionally with deposits: when deposits double, the yield doubles, but the rate halves — these cancel out.

2. **The percentage boost dilutes as the vault grows.** At 200k deposits the bonus is +250% of yield. At 500k deposits with the same farm, the bonus drops to +96%. The absolute bonus (96-100 Alpha) stays similar, but each user gets a smaller share because more people split it.

3. **Topping up the farm immediately increases the bonus.** At week 40 the creator adds 5,000 Alpha — the bonus jumps from ~70 to 118 Alpha instantly. No ratio change needed.

4. **The bonus tapers smoothly, never runs out abruptly.** After 100 weeks the farm still has 6,434 Alpha and is distributing 64 Alpha/week. It's geometric decay — always draining the same percentage, so the absolute amount shrinks but never hits zero.

5. **The creator never has to touch the ratio.** After setting it once to 500,000, the system auto-adjusts. The only reason to change it is if you want to speed up or slow down the drain (e.g., set to 1,000,000 to drain faster, or 250,000 to make it last even longer).

**Important notes:**
- Once `emissionRatio` is set, it cannot be set to 0 (protects farm contributors from locked funds)
- When `farmBalance` reaches 0, no more bonuses are distributed regardless of the ratio
- The rate auto-adjusts as the farm depletes — no manual intervention needed
- There is a 10% floor: when the farm has a balance, at least 10% of swap output is distributed as bonus

---

## Fees

### Vault Creation
- **MBR:** 5.4-5.5 ALGO (stays in contract for asset opt-ins and operations)

### Yield Fees
- **Creator fee:** 0-6% of yield (set at deployment, can be updated by creator)
- **Example:** If creator fee is 5% and 100 USDC yield is swapped:
  - 5 USDC worth of output -> Creator
  - 95 USDC worth of output -> Users

---

## Example Scenarios

### Scenario 1: RareFiVault for ProjectX

1. Alice deposits 10,000 Alpha (worth $1,000)
2. Bob deposits 40,000 Alpha (worth $4,000)
3. Total vault: 50,000 Alpha

4. Alpha Arcade airdrops $100 USDC to the vault

5. RareFi swaps $100 USDC -> 500 ProjectX tokens
   - This creates $100 of buying pressure for ProjectX on Tinyman

6. Distribution (creator fee 3%):
   - Creator: 15 ProjectX (project revenue)
   - Users: 485 ProjectX
     - Alice (20%): 97 ProjectX
     - Bob (80%): 388 ProjectX

7. Alice and Bob claim their tokens whenever convenient

**Result:** ProjectX gets recurring buy pressure from Alpha Arcade yield.


### Scenario 2: RareFiAlphaCompoundingVault

1. Alice deposits 1,000 Alpha
   - Receives 1,000 shares (1:1 initial ratio)
   - Share price: 1.0

2. Alpha Arcade airdrops 100 USDC to the vault

3. Compound triggered: 100 USDC -> 95 Alpha (after fees)
   - Creator fee (3%): 2.85 Alpha
   - Vault receives: 92.15 Alpha
   - New totalAlpha: 1,092.15
   - Share price: 1.092

4. Bob deposits 500 Alpha
   - Receives: 500 / 1.092 = 457.9 shares
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

**Status:** Smart contracts complete and tested on localnet.
