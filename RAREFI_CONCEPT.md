# RareFi Protocol

## Overview

RareFi is a yield routing protocol on Algorand that connects yield-bearing assets with project tokens. Users deposit their yield-generating assets into project-specific vaults and receive the project's token as yield - instead of the underlying yield asset.

The protocol creates a win-win: users get exposure to tokens they believe in while maintaining their principal, and projects get continuous buying pressure for their ASA funded by real yield.

---

## The Problem

**For Users:**
- Holding yield-bearing assets (like Alpha from Alpha Arcade, or USDC in lending protocols) generates yield in underlying yield asset
- Users who want exposure to specific project tokens must manually swap their yield

**For Projects:**
- Getting sustainable buying pressure for your ASA is difficult
- Airdrops and liquidity mining create sell pressure, not buy pressure
- No way to tap into the yield that's flowing through the Algorand ecosystem

---

## The Solution

RareFi vaults act as a bridge:

```
User deposits yield-bearing asset
         |
         v
    [RareFi Vault]
         |
         v
Yield accrues
         |
         v
RareFi swaps Yield -> Project Token
         |
         v
User claims Project Token as yield
```

Users keep their principal intact and withdraw anytime. The yield is automatically converted to project tokens.

---

## Two Vault Types

### 1. Alpha Arcade Vault (RareFiVault)

For users holding **Alpha** tokens from Alpha Arcade.

**How it works:**
- Alpha Arcade periodically airdrops USDC to Alpha holders
- Users deposit Alpha into a RareFi vault for a specific project
- When USDC airdrops arrive at the vault, RareFi swaps it to the project's token
- Users claim their share of project tokens proportional to their Alpha deposit

**Yield source:** Alpha Arcade USDC airdrops (external, periodic)

**Key characteristic:** Passive yield - airdrops arrive without any action needed


### 2. Orbital Lending Vault (OrbitalVault)

For users who want lending yield paid in project tokens instead of the underlying asset.

**How it works:**
- Users deposit an asset (starting with USDC) into the vault
- Vault deposits into Orbital Lending protocol, receives the corresponding LST (cUSDC)
- As interest accrues, the LST exchange rate appreciates
- Periodically, RareFi harvests the accumulated yield and swaps to project tokens
- Users claim their share of project tokens

**Yield source:** Orbital Lending interest (continuous, compounding)

**Key characteristic:** Active yield generation through DeFi lending

**Asset roadmap:**
- Phase 1: USDC/cUSDC (current implementation)
- Phase 2: Other Orbital assets (ALGO, goBTC, goETH, etc.)
- Phase 3: Isolated lending pools Folks

---

## Value Proposition

### For Users

| Benefit | Description |
|---------|-------------|
| **Keep your principal** | Deposit Alpha or USDC, withdraw anytime with full amount |
| **Automatic yield conversion** | No manual swapping needed |
| **Project exposure** | Get tokens of projects you believe in |
| **Fair distribution** | Yield is proportional to deposit amount and time |
| **No lock-up** | Withdraw principal whenever you want |

### For Projects

| Benefit | Description |
|---------|-------------|
| **Organic buying pressure** | Real yield is swapped into your ASA continuously |
| **Yield routing** | Redirect ecosystem yield flows toward your token |
| **Community earning** | Your supporters earn your token seamlessly, no manual swapping |
| **Engaged holders** | Users actively chose your project's vault - they believe in you |
| **Configurable fees** | Take a percentage of swapped yield as project revenue |

### For RareFi

| Revenue Stream | Description |
|----------------|-------------|
| **Setup fee** | 200 ALGO per vault deployment |
| **Swap execution** | Platform/Vault Creator controls swap timing and execution |

---

## Technical Architecture

### RareFiVault (Alpha Arcade)

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

**Contract Methods:**

| Method | Access | Description |
|--------|--------|-------------|
| `createVault()` | Deploy only | Initialize vault with asset IDs and configuration |
| `optInAssets()` | Creator | Opt vault into required ASAs (requires 200.3 ALGO) |
| `optIn()` | Any user | User opts into vault to enable deposits |
| `deposit()` | Opted-in users | Deposit Alpha tokens |
| `withdraw(amount)` | Depositors | Withdraw Alpha (0 = withdraw all) |
| `claim()` | Depositors | Claim accumulated project tokens |
| `swapYield(slippageBps)` | Creator/RareFi | Swap USDC yield to project tokens |
| `closeOut()` | Depositors | Withdraw all + claim all + leave vault |
| `claimCreator()` | Creator | Claim creator's fee portion |
| `getVaultStats()` | Anyone | Read total deposits, yield info, balances |
| `getPendingYield(user)` | Anyone | Read user's claimable amount |


### OrbitalVault (Orbital Lending)

**Two-Stage Yield Model:**

Stage 1 - Yield Tracking via Rate Appreciation:
```
LST exchange rate increases over time (e.g., 1.0 -> 1.05)
yieldPerShare tracks this appreciation
User's unrealized yield = shares * rate_increase
```

Stage 2 - Harvest and Convert:
```
On harvest:
  1. Calculate total unrealized yield (in underlying asset)
  2. Redeem that portion of LST from Orbital
  3. Swap underlying to project ASA via Tinyman
  4. Store conversion rate (ASA per underlying)

When user interacts:
  Convert their unrealized yield to ASA using stored rate
```

**Contract Methods:**

| Method | Access | Description |
|--------|--------|-------------|
| `createVault()` | Deploy only | Initialize with underlying asset, LST, project ASA, protocols |
| `optInAssets()` | Creator | Opt into assets (requires 200.3 ALGO) |
| `optIn()` | Any user | User opts into vault |
| `deposit()` | Opted-in users | Deposit underlying asset (forwarded to Orbital) |
| `withdraw(amount)` | Depositors | Withdraw underlying (redeemed from Orbital) |
| `claimYield()` | Depositors | Claim accumulated project tokens |
| `harvestAndSwap(slippageBps)` | Creator/RareFi | Harvest yield from Orbital, swap to project token |
| `closeOut()` | Depositors | Full exit (note: unharvested yield may be lost) |
| `setPaused(bool)` | Creator | Emergency pause |
| `getVaultStats()` | Anyone | Read vault state |
| `getUserPosition(user)` | Anyone | Read user's shares, value, pending yield |

---

## Protocol Integrations

### Tinyman V2 (AMM)

Both vaults use Tinyman V2 for -> Project Token swaps.

**Swap execution:**
1. Read pool reserves on-chain
2. Calculate expected output using AMM formula
3. Apply slippage tolerance
4. Execute swap via inner transactions
5. Verify output meets minimum

**Why on-chain price calculation:**
- No oracle dependency
- No off-chain price feeds to trust
- Swap fails if slippage exceeded

### Orbital Lending (OrbitalVault only)

Orbital is a Compound-style lending protocol on Algorand.

**Integration:**
- Deposit asset -> Receive LST (e.g., cUSDC, cALGO) at current exchange rate
- Rate appreciates as interest accrues
- Redeem LST -> Receive underlying at new (higher) rate
- Yield = (new_rate - old_rate) * shares

**Supported assets (planned):**
- USDC/cUSDC (v1)
- ALGO/cALGO
- goBTC/cgoBTC
- goETH/cgoETH
- Isolated pools (future)

---

## Security Model

### Access Control

| Action | Who can do it |
|--------|---------------|
| Deploy vault | Anyone (permissionless) |
| Configure vault | Creator at deployment only |
| Trigger swaps/harvests | Creator or RareFi platform |
| Deposit/withdraw | Any opted-in user |
| Claim yield | Any user with pending yield |
| Upgrade contract | Nobody (disabled) |
| Delete contract | Nobody (disabled) |

### Safety Features

- **No upgrades:** Contracts cannot be modified after deployment
- **No deletion:** Contracts cannot be deleted (user funds always accessible)
- **Slippage protection:** Swaps revert if output below minimum
- **Minimum thresholds:** Prevents dust attacks and unprofitable swaps
- **Safe math:** 128-bit multiplication prevents overflow

### Known Considerations

**Alpha Vault - Timing between airdrop and swap:**
When USDC airdrops arrive, there's a window before the swap happens. Users could theoretically deposit right before swap to capture yield. Mitigation: RareFi executes swaps promptly after airdrops detected.

**Orbital Vault - Unharvested yield on closeOut:**
If a user closes out before a harvest, any USDC yield accumulated since the last harvest is not converted to ASA. The UI should warn users about this.

---

## Fees

### Vault Creation
- **Setup fee:** 200 ALGO (paid to RareFi)
- **MBR:** 0.3 ALGO (stays in contract for asset opt-ins)

### Yield Fees
- **Creator fee:** 0-100% of yield (set at deployment)
- **Example:** If creator fee is 10% and 1000 USDC yield is swapped:
  - 100 USDC worth of project tokens -> Creator
  - 900 USDC worth of project tokens -> Users


---

## Deployment Flow

### For Projects (Vault Creators)

1. **Prepare:**
   - Have your project ASA created
   - Ensure Tinyman pool exists (IBT/YourToken)
   - Prepare 200.3 ALGO for setup

2. **Deploy:**
   - Call `createVault()` with configuration
   - Call `optInAssets()` with ALGO payment

3. **Operate:**
   - Monitor for yield accumulation
   - Call `swapYield()` / `harvestAndSwap()` when threshold met
   - Claim creator fees periodically

### For Users

1. **Choose a vault** for a project you like
2. **Opt in** to the vault contract
3. **Deposit** Alpha or USDC
4. **Wait** for yield to accumulate
5. **Claim** project tokens whenever you want
6. **Withdraw** principal whenever you want

---

## Example Scenario

**Alpha Arcade Vault for ProjectX:**

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
8. Next week, another airdrop arrives - cycle repeats

**Result:** ProjectX gets recurring buy pressure from Alpha Arcade yield. Users earn ProjectX without selling anything.

---

## Roadmap

### Current (v1)
- Alpha Arcade vault (RareFiVault)
- Orbital Lending vault for USDC (OrbitalVault) - more complex
- Tinyman V2 swap integration 

### Near-term
- Orbital vaults for other assets (ALGO, goBTC, goETH)
- Isolated lending pool Folks

### Future
- Additional yield sources 
- Multi-project vaults (yield split across multiple tokens)

---

## Summary

RareFi routes yield into project tokens. Users keep their principal safe while automatically earning tokens from projects they support. Projects get continuous, organic buying pressure for their ASA - funded by real yield flowing through the Algorand ecosystem.

**Contracts:**
- `RareFiVault.algo.ts` - Alpha Arcade yield -> Project tokens
- `OrbitalVault.algo.ts` - Orbital lending yield -> Project tokens (USDC first, then other assets)

**Integrations:**
- Tinyman V2 (swaps)
- Orbital Lending (OrbitalVault)
- Alpha Arcade (RareFiVault)

**Status:** Smart contracts complete and tested on localnet. Ready for testnet deployment.
