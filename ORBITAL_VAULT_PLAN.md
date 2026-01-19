# OrbitalVault Contract Specification

## Overview

**Contract Name:** `OrbitalVault`

A vault contract that enables users to deposit USDC, which is automatically deposited into Orbital Lending to earn yield. The yield is periodically harvested and swapped to a project's ASA token, which users can claim.

**Key Features:**
- Users deposit/withdraw USDC freely at any time
- Yield accrues via Orbital Lending rate appreciation
- Periodic harvests (e.g., weekly) swap accumulated yield to project ASA
- Fair yield distribution using two-stage accumulator pattern
- Users can claim ASA yield after harvests

---

## Core Flow

```
User deposits USDC
       ↓
Vault deposits to Orbital Lending → receives cUSDC
       ↓
cUSDC appreciates over time (exchange rate increases)
       ↓
Admin calls harvest() weekly:
  → Redeem yield portion of cUSDC → get USDC
  → Swap USDC → Project ASA via Tinyman
  → Distribute ASA via accumulator
       ↓
User claims ASA (their yield in project tokens)
```

---

## References

### Orbital Lending Integration

**Mainnet:**
- App ID: `3312464201`
- cUSDC Asset ID: TBD (need to verify)
- USDC Asset ID: `31566704` (Algorand mainnet USDC)

**Global State Keys (for rate calculation):**
- `circulating_lst` - Total cUSDC in circulation
- `total_deposits` - Total USDC deposited in Orbital

**Exchange Rate Formula:**
```
rate = total_deposits / circulating_lst (scaled by 1e6)
```

Reference: https://github.com/compx-labs/orbital-lending

### Tinyman V2 Integration

Same pattern as RareFiVault - swap USDC to project ASA via Tinyman V2 pool.

---

## Architecture

### State Variables

#### Global State

| Variable | Type | Description |
|----------|------|-------------|
| `creator` | Account | Vault creator/admin |
| `rarefiAddress` | Account | RareFi platform address |
| `isPaused` | boolean | Emergency pause flag |
| `usdcAssetId` | uint64 | USDC asset ID |
| `cUsdcAssetId` | uint64 | cUSDC (Orbital receipt token) asset ID |
| `projectAsaId` | uint64 | Project ASA (yield paid in this token) |
| `orbitalAppId` | uint64 | Orbital Lending application ID |
| `tinymanPoolAppId` | uint64 | Tinyman V2 pool app ID (USDC/projectASA) |
| `tinymanPoolAddress` | Account | Tinyman pool address |
| `totalShares` | uint64 | Total cUSDC shares in vault |
| `totalPrincipal` | uint64 | Total USDC principal deposited |
| `usdcYieldPerShare` | uint64 | Stage 1: Rate-based accumulator (USDC yield) |
| `asaYieldPerShare` | uint64 | Stage 2: ASA accumulator (claimable yield) |
| `lastRateSnapshot` | uint64 | Exchange rate at last checkpoint |
| `lastHarvestYieldPerShare` | uint64 | usdcYieldPerShare at last harvest |
| `minHarvestThreshold` | uint64 | Minimum USDC yield before harvest allowed |
| `depositFeeBps` | uint64 | Fee on deposit (basis points) |
| `withdrawFeeBps` | uint64 | Fee on withdrawal (basis points) |

#### Local State (per user)

| Variable | Type | Description |
|----------|------|-------------|
| `userShares` | uint64 | User's cUSDC share balance |
| `userUsdcYieldPerShare` | uint64 | User's snapshot of usdcYieldPerShare |
| `userAsaYieldPerShare` | uint64 | User's snapshot of asaYieldPerShare |
| `userUnrealizedUsdc` | uint64 | Accumulated USDC yield (not yet harvested) |
| `earnedAsa` | uint64 | Accumulated ASA yield (claimable) |

---

## Two-Stage Yield Model

This is the key innovation: separating yield tracking from yield conversion.

### Stage 1: USDC Yield Tracking (Continuous)

Tracks each user's fair share of yield based on rate appreciation.

```typescript
// Updated on EVERY user action (deposit, withdraw, claim, etc.)
private updateUsdcYieldAccumulator(): void {
  const currentRate = this.fetchCurrentRate();

  if (currentRate > this.lastRateSnapshot.value) {
    const rateIncrease = currentRate - this.lastRateSnapshot.value;
    this.usdcYieldPerShare.value += rateIncrease;
  }

  this.lastRateSnapshot.value = currentRate;
}

private updateUserUsdcYield(user: Account): void {
  const shares = this.userShares(user).value;

  if (shares > Uint64(0)) {
    const currentYPS = this.usdcYieldPerShare.value;
    const userYPS = this.userUsdcYieldPerShare(user).value;

    if (currentYPS > userYPS) {
      // Calculate USDC yield based on rate increase since last action
      const pendingUsdc = this.mulDivFloor(shares, currentYPS - userYPS, RATE_PRECISION);
      this.userUnrealizedUsdc(user).value += pendingUsdc;
    }
  }

  this.userUsdcYieldPerShare(user).value = this.usdcYieldPerShare.value;
}
```

### Stage 2: Harvest (Periodic - e.g., Weekly)

Converts accumulated USDC yield to ASA for all users.

```typescript
@arc4.abimethod()
harvestAndSwap(slippageBps: uint64): void {
  // Only creator/RareFi can call
  assert(Txn.sender === this.creator.value || Txn.sender === this.rarefiAddress.value);

  // 1. Update rate accumulator first
  this.updateUsdcYieldAccumulator();

  // 2. Calculate total unrealized USDC yield
  const currentRate = this.lastRateSnapshot.value;
  const cUsdcBalance = Asset(this.cUsdcAssetId.value).balance(appAddr);
  const currentValueUsdc = this.mulDivFloor(cUsdcBalance, currentRate, RATE_PRECISION);
  const totalUnrealizedUsdc = currentValueUsdc - this.totalPrincipal.value;

  assert(totalUnrealizedUsdc >= this.minHarvestThreshold.value, 'Below threshold');

  // 3. Calculate cUSDC to redeem for this yield
  const cUsdcToRedeem = this.mulDivFloor(totalUnrealizedUsdc, RATE_PRECISION, currentRate);

  // 4. Redeem from Orbital → get USDC
  // ... inner txn to Orbital ...

  // 5. Swap USDC → Project ASA via Tinyman
  // ... inner txn to Tinyman (same pattern as RareFiVault) ...
  const asaReceived = /* swap output */;

  // 6. Calculate yield per share for this harvest period
  //    This is the USDC yield per share since last harvest
  const yieldPerShareThisPeriod = this.usdcYieldPerShare.value - this.lastHarvestYieldPerShare.value;

  // 7. Calculate ASA per USDC yield unit
  //    asaPerUsdcYield = asaReceived / totalUnrealizedUsdc (scaled)
  //    But we distribute per share, so:
  //    asaYieldPerShare += asaReceived / totalShares
  //
  //    However, this isn't perfectly fair if shares changed during period.
  //    Better: track conversion rate and apply per-user on claim.

  // Simpler approach: convert at harvest time
  // Each user's unrealized USDC → ASA at this rate
  const asaPerUsdc = this.mulDivFloor(asaReceived, SCALE, totalUnrealizedUsdc);

  // Store conversion rate for this harvest
  this.lastHarvestAsaPerUsdc.value = asaPerUsdc;
  this.lastHarvestYieldPerShare.value = this.usdcYieldPerShare.value;
}
```

### Stage 3: User Claims ASA

On any user action, convert their unrealized USDC to ASA using the harvest rate.

```typescript
private updateUserAsaYield(user: Account): void {
  // Convert any unrealized USDC yield to ASA (if harvest happened)
  const unrealizedUsdc = this.userUnrealizedUsdc(user).value;

  if (unrealizedUsdc > Uint64(0) && this.lastHarvestAsaPerUsdc.value > Uint64(0)) {
    const asaFromUsdc = this.mulDivFloor(unrealizedUsdc, this.lastHarvestAsaPerUsdc.value, SCALE);
    this.earnedAsa(user).value += asaFromUsdc;
    this.userUnrealizedUsdc(user).value = Uint64(0);
  }
}
```

---

## Detailed Example Walkthrough

### Setup
- Rate starts at 1.05
- Harvest happens weekly on Mondays

### Week 1

**Monday 9:00 AM - User A deposits 100 USDC**
```
Rate: 1.05
- Vault deposits to Orbital → gets 95.24 cUSDC
- userShares(A) = 95.24
- userUsdcYieldPerShare(A) = 0
- userUnrealizedUsdc(A) = 0
- totalShares = 95.24
- totalPrincipal = 100
```

**Wednesday - User B deposits 100 USDC**
```
Rate: 1.06
- updateUsdcYieldAccumulator():
    usdcYieldPerShare += (1.06 - 1.05) = 0.01
- updateUserUsdcYield(B): no shares yet, nothing to do
- Vault deposits to Orbital → gets 94.34 cUSDC
- userShares(B) = 94.34
- userUsdcYieldPerShare(B) = 0.01 (current accumulator)
- userUnrealizedUsdc(B) = 0
- totalShares = 189.58
- totalPrincipal = 200
```

**Friday - User A checks balance**
```
Rate: 1.07
- updateUsdcYieldAccumulator():
    usdcYieldPerShare += (1.07 - 1.06) = 0.01
    usdcYieldPerShare now = 0.02
- updateUserUsdcYield(A):
    pending = 95.24 * (0.02 - 0) / 1e6 = 1.90 USDC
    userUnrealizedUsdc(A) = 1.90
    userUsdcYieldPerShare(A) = 0.02
- User A's claimable ASA: 0 (no harvest yet)
- User A's unrealized yield: 1.90 USDC (waiting for harvest)
```

### Week 2

**Monday 9:00 AM - Harvest**
```
Rate: 1.08
- updateUsdcYieldAccumulator():
    usdcYieldPerShare += (1.08 - 1.07) = 0.01
    usdcYieldPerShare now = 0.03

- Calculate total unrealized yield:
    cUSDC balance: 189.58
    Current value: 189.58 * 1.08 = 204.75 USDC
    Principal: 200 USDC
    Unrealized yield: 4.75 USDC

- Redeem 4.75/1.08 = 4.40 cUSDC from Orbital → get 4.75 USDC
- Swap 4.75 USDC → 1000 ASA (example)
- asaPerUsdc = 1000 / 4.75 = 210.53 ASA per USDC yield
- lastHarvestYieldPerShare = 0.03
```

**Monday 10:00 AM - User A claims**
```
- updateUserUsdcYield(A):
    pending = 95.24 * (0.03 - 0.02) / 1e6 = 0.95 USDC
    userUnrealizedUsdc(A) = 1.90 + 0.95 = 2.85 USDC
- updateUserAsaYield(A):
    asaFromUsdc = 2.85 * 210.53 = 600 ASA
    earnedAsa(A) = 600
    userUnrealizedUsdc(A) = 0
- User A claims 600 ASA ✓
```

**Monday 11:00 AM - User B claims**
```
- updateUserUsdcYield(B):
    pending = 94.34 * (0.03 - 0.01) / 1e6 = 1.89 USDC
    userUnrealizedUsdc(B) = 1.89
- updateUserAsaYield(B):
    asaFromUsdc = 1.89 * 210.53 = 398 ASA
    earnedAsa(B) = 398
    userUnrealizedUsdc(B) = 0
- User B claims 398 ASA ✓
```

**Verification:**
```
User A: Deposited at rate 1.05, yield tracked from 1.05→1.08 = 600 ASA
User B: Deposited at rate 1.06, yield tracked from 1.06→1.08 = 398 ASA
Total: 998 ASA ≈ 1000 ASA ✓ (rounding)
```

---

## Edge Cases

### Case 1: User deposits AFTER harvest, claims BEFORE next harvest

```
Monday: Harvest happens (usdcYieldPerShare = 0.03)
Tuesday: User C deposits
  - userUsdcYieldPerShare(C) = 0.03
  - userUnrealizedUsdc(C) = 0
Friday: User C tries to claim
  - updateUserUsdcYield(C):
      Rate increased, so pending USDC yield calculated
      userUnrealizedUsdc(C) = some amount
  - updateUserAsaYield(C):
      No new harvest since deposit, so conversion rate is stale
      OR: we skip conversion if yield is from after last harvest
  - earnedAsa(C) = 0
  - Result: "Nothing to claim" ✓

Next Monday: Harvest happens
  - User C's unrealized USDC yield gets converted to ASA
  - User C can now claim ✓
```

### Case 2: User deposits just BEFORE harvest

```
Sunday 11:59 PM: User D deposits
  - userUsdcYieldPerShare(D) = 0.03
Monday 12:00 AM: Harvest
  - Rate barely changed
  - User D's unrealized USDC yield = tiny
  - User D gets tiny amount of ASA

Week passes, rate increases a lot

Next Monday: Harvest
  - User D's unrealized USDC yield = large (from week of holding)
  - User D gets proportionally large ASA
  - Result: Fair! ✓
```

### Case 3: User withdraws ALL principal, waits, claims yield later

```
Monday: Harvest happens
Tuesday: User E (has 100 shares) withdraws ALL principal
  - updateUserUsdcYield(E):
      pending USDC yield calculated and stored
      userUnrealizedUsdc(E) = 2.5 USDC
  - userShares(E) = 0 (all withdrawn)
  - User E still opted in, local state preserved

Friday: Rate keeps increasing
  - User E's userUnrealizedUsdc stays at 2.5 (no shares = no new yield)

Next Monday: Harvest happens
  - User E's 2.5 USDC yield gets converted to ASA
  - earnedAsa(E) = 2.5 * asaPerUsdc = 525 ASA

Later: User E claims
  - Receives 525 ASA ✓
  - Can optionally close out now
```

**Key insight:** After full withdrawal, user has 0 shares but still has `userUnrealizedUsdc`. On next harvest, this converts to ASA. User can claim anytime while opted in.

### Case 4: User opts out (CloseOut) with unclaimed yield

```
User has:
  - userShares = 0 (already withdrew principal)
  - userUnrealizedUsdc = 2.5 USDC (waiting for harvest)
  - earnedAsa = 0 (no harvest since last action)

User calls CloseOut:
  - Return any earnedAsa (0 in this case)
  - userUnrealizedUsdc is LOST (2.5 USDC worth)
  - Local state deleted

Result: User loses unharvested yield ⚠️
```

**UI Warning:** "You have X USDC of unrealized yield waiting for the next harvest. If you close out now, this yield will be lost. Consider waiting until after the next harvest to claim your ASA."

---

## Contract Methods

### Initialization

#### `createVault()`
```typescript
@arc4.abimethod({ onCreate: 'require' })
createVault(
  usdcAssetId: uint64,
  cUsdcAssetId: uint64,
  projectAsaId: uint64,
  orbitalAppId: uint64,
  tinymanPoolAppId: uint64,
  tinymanPoolAddress: Account,
  depositFeeBps: uint64,
  withdrawFeeBps: uint64,
  minHarvestThreshold: uint64,
  rarefiAddress: Account
): void
```

#### `optInAssets()`
Opts the contract into USDC, cUSDC, and project ASA.
- Requires ALGO payment for MBR + setup fee
- Sets `lastRateSnapshot` to current Orbital rate

---

### User Operations

#### `optIn()`
```typescript
@arc4.abimethod({ allowActions: 'OptIn' })
optIn(): void
```

Initializes local state:
- `userShares = 0`
- `userUsdcYieldPerShare = usdcYieldPerShare` (current)
- `userAsaYieldPerShare = asaYieldPerShare` (current)
- `userUnrealizedUsdc = 0`
- `earnedAsa = 0`

#### `deposit()`
```typescript
@arc4.abimethod()
deposit(): void
```

**Transaction Group:**
```
[0] Asset Transfer: User → Contract (USDC)
[1] App Call: deposit()
```

**Logic:**
1. `updateUsdcYieldAccumulator()` - checkpoint rate
2. `updateUserUsdcYield(sender)` - lock in pending USDC yield
3. `updateUserAsaYield(sender)` - convert to ASA if harvest happened
4. Validate USDC transfer
5. Deduct deposit fee (if any)
6. Deposit USDC to Orbital → receive cUSDC
7. `userShares += cUSDC received`
8. `totalShares += cUSDC received`
9. `totalPrincipal += USDC deposited`

#### `withdraw(amount: uint64)`
```typescript
@arc4.abimethod()
withdraw(amount: uint64): void
```

**Logic:**
1. `updateUsdcYieldAccumulator()`
2. `updateUserUsdcYield(sender)` - lock in pending USDC yield
3. `updateUserAsaYield(sender)` - convert to ASA if harvest happened
4. Calculate cUSDC to redeem: `amount / currentRate`
5. Verify user has enough shares
6. Redeem cUSDC from Orbital → receive USDC
7. Deduct withdraw fee (if any)
8. Send USDC to user
9. `userShares -= cUSDC redeemed`
10. `totalShares -= cUSDC redeemed`
11. `totalPrincipal -= USDC withdrawn`

**Note:** User keeps their `userUnrealizedUsdc` even after full withdrawal. They can claim ASA after next harvest.

#### `claimYield()`
```typescript
@arc4.abimethod()
claimYield(): void
```

**Logic:**
1. `updateUsdcYieldAccumulator()`
2. `updateUserUsdcYield(sender)` - lock in pending USDC yield
3. `updateUserAsaYield(sender)` - convert unrealized USDC to ASA
4. `claimable = earnedAsa(sender)`
5. Assert `claimable > 0`
6. Send ASA to user
7. `earnedAsa(sender) = 0`

#### `closeOut()`
```typescript
@arc4.abimethod({ allowActions: 'CloseOut' })
closeOut(): void
```

**Logic:**
1. Update all yield accumulators
2. If `userShares > 0`: withdraw all principal first
3. If `earnedAsa > 0`: send ASA to user
4. **WARNING:** `userUnrealizedUsdc` is lost if > 0 (not yet harvested)
5. Local state deleted

---

### Harvest (Admin Only)

#### `harvestAndSwap(slippageBps: uint64)`
```typescript
@arc4.abimethod()
harvestAndSwap(slippageBps: uint64): void
```

**Logic:**
1. Assert caller is creator or RareFi
2. Assert slippage within bounds
3. `updateUsdcYieldAccumulator()`
4. Calculate total unrealized USDC yield
5. Assert above minimum threshold
6. Calculate cUSDC to redeem
7. Redeem from Orbital → get USDC
8. Swap USDC → project ASA via Tinyman
9. Calculate and store `asaPerUsdc` conversion rate
10. Update `lastHarvestYieldPerShare`

---

### Read-Only Methods

#### `getVaultStats()`
```typescript
@arc4.abimethod({ readonly: true })
getVaultStats(): [uint64, uint64, uint64, uint64, uint64]
```
Returns: `[totalShares, totalPrincipal, currentRate, totalUnrealizedYield, asaBalance]`

#### `getUserPosition(user: Account)`
```typescript
@arc4.abimethod({ readonly: true })
getUserPosition(user: Account): [uint64, uint64, uint64, uint64]
```
Returns: `[userShares, principalValue, unrealizedUsdcYield, claimableAsa]`

#### `getPendingYield(user: Account)`
```typescript
@arc4.abimethod({ readonly: true })
getPendingYield(user: Account): [uint64, uint64]
```
Returns: `[unrealizedUsdcYield, claimableAsa]`

- `unrealizedUsdcYield`: USDC yield waiting for next harvest
- `claimableAsa`: ASA ready to claim now

---

### Admin Methods

#### `setPaused(paused: boolean)`
Emergency pause/unpause (creator only).

#### `updateMinHarvestThreshold(threshold: uint64)`
Update minimum USDC before harvest is allowed.

#### `updateTinymanPool(poolAppId: uint64, poolAddress: Account)`
Update Tinyman pool if needed (migration).

---

## Fee Structure

| Action | Fee | Goes To |
|--------|-----|---------|
| Deposit | 0-50 bps | Creator |
| Withdraw | 0-50 bps | Creator |
| Claim Yield | 0 bps | N/A |
| Harvest | 0 bps | N/A |

---

## Security Considerations

### Rate Manipulation Protection
- Rate should never decrease (assert on fetch)
- Sanity check: max 3x rate increase from initial

### Sandwich Attack Protection
- Only creator/RareFi can call `harvestAndSwap()`
- Slippage parameter with max limit

### Reentrancy Protection
- Update all state BEFORE external calls
- Follow checks-effects-interactions pattern

### Overflow Protection
- Use 128-bit intermediate calculations (mulw/divmodw)

### Admin Controls
- Pause mechanism for emergencies
- No upgrade/delete capability (immutable)

---

## User Experience Summary

| Action | Anytime? | Notes |
|--------|----------|-------|
| Deposit USDC | ✅ Yes | Yield starts accruing immediately |
| Withdraw USDC | ✅ Yes | Can withdraw partial or all |
| Check unrealized yield | ✅ Yes | Shows USDC value waiting for harvest |
| Claim ASA yield | ✅ Yes* | *Only if harvest happened since deposit |
| Close out | ✅ Yes | ⚠️ Loses unharvested yield |

### What to Show in UI

```
Your Position:
- Principal: 100 USDC
- Current Value: 104.50 USDC
- Unrealized Yield: 4.50 USDC (converts to ASA on next harvest)
- Claimable ASA: 250 ASA [Claim Button]

Next harvest in: ~3 days
```

### Warning on CloseOut

```
⚠️ Warning: You have 4.50 USDC of unrealized yield.
This will be lost if you close out now.

Options:
1. Wait for next harvest (~3 days), then claim ASA
2. Close out now and forfeit 4.50 USDC yield
```

---

## Comparison with RareFiVault

| Aspect | RareFiVault | OrbitalVault |
|--------|-------------|--------------|
| Deposit Asset | Alpha | USDC |
| Underlying Yield | Airdrops | Orbital rate appreciation |
| Yield Tracking | Single accumulator | Two-stage (USDC → ASA) |
| Yield Conversion | On `swapYield()` | On `harvestAndSwap()` |
| Claim Asset | Project ASA | Project ASA |
| Complexity | Medium | Medium-High |

**Key Similarity:** Both use accumulator pattern for fair distribution.

**Key Difference:** OrbitalVault has two stages because yield accrues continuously (rate-based) but is converted periodically (harvest).

---

## Implementation Order

1. **Phase 1: Core Contract Structure**
   - Constants and state variables
   - Math helpers (mulDivFloor, mulDivCeil)
   - Rate fetching from Orbital

2. **Phase 2: Two-Stage Yield Logic**
   - `updateUsdcYieldAccumulator()`
   - `updateUserUsdcYield()`
   - `updateUserAsaYield()`

3. **Phase 3: User Operations**
   - `optIn()` / `closeOut()`
   - `deposit()` with Orbital integration
   - `withdraw()` with Orbital integration
   - `claimYield()`

4. **Phase 4: Harvest**
   - `harvestAndSwap()` with Orbital + Tinyman integration
   - Conversion rate tracking

5. **Phase 5: Read-Only & Admin**
   - View methods
   - Admin controls

6. **Phase 6: Testing**
   - MockOrbital contract
   - MockTinyman contract (reuse existing)
   - Unit tests for all scenarios
   - Edge case tests

7. **Phase 7: Audit & Deploy**
   - Security review
   - Mainnet deployment

---

## File Structure

```
rarefivault/
├── contracts/
│   ├── RareFiVault.algo.ts       # Existing
│   ├── MockTinymanPool.algo.ts   # Existing (reuse)
│   ├── OrbitalVault.algo.ts      # NEW
│   └── MockOrbital.algo.ts       # NEW (for testing)
├── tests/
│   ├── RareFiVault.spec.ts       # Existing
│   └── OrbitalVault.spec.ts      # NEW
└── ORBITAL_VAULT_PLAN.md         # This file
```

---

## Open Questions

1. **Orbital method signatures** - Need to verify exact deposit/redeem methods
2. **cUSDC Asset ID** - Need mainnet asset ID
3. **Harvest frequency** - Weekly recommended, but configurable?
4. **Fee split** - All to creator, or split with RareFi?
