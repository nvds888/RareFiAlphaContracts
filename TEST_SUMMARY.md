# RareFi Vault Contracts - Test Summary

**Date:** February 2025
**Contracts:** RareFiVault, RareFiAlphaCompoundingVault
**Framework:** Jest + Algorand Localnet
**Total Tests:** 190 passing

---

## Contract Overview

### RareFiVault (Staking Rewards Accumulator)
- Deposit Alpha → earn project tokens via USDC → swapAsset swaps
- Yield-per-token accumulator pattern (SCALE = 1e12)
- Auto-swap on deposit when threshold met

### RareFiAlphaCompoundingVault (Share-Based Auto-Compounding)
- Deposit Alpha → earn more Alpha via USDC → Alpha swaps
- Share price increases over time as yield compounds
- Auto-compound on deposit when threshold met

---

## RareFiVault Tests (105 tests)

### Deployment (2 tests)
- Deploy vault and pool successfully
- Correct initial state (all global state vars)

### User Operations (6 tests)
- Opt in, deposit, yield tracking, claim, withdraw, deposit-withdraw-deposit cycle

### Close Out (1 test)
- Returns deposit and yield on close out

### Comprehensive Integration (9 tests)
Multi-user scenario (Alice, Bob, Charlie, Dave):
1. Initial deposits (1000 + 500 + 300 + 200 = 2000 total)
2. First yield swap — proportional distribution verified
3. Partial operations (claims, partial withdrawals)
4. Second yield swap to remaining users
5. Close out returns deposit + yield
6. Additional deposits with preserved history
7. Creator fee claims
8. Final user operations
9. Full withdrawal (vault ends at 0)

### Edge Cases & Rounding (5 tests)
- Prime number deposits: 0.00001% error
- Small yield (2 USDC on 1000 tokens)
- Large deposits (10,000 tokens)
- Multiple deposit-claim cycles
- Creator fee accumulation over 5 swaps: exactly 20.00%

### Auto-Swap on Deposit (4 tests)
- No swap when USDC below threshold
- Auto-swap triggers at threshold (yieldPerToken increases)
- Withdrawals always allowed
- New depositor gets 0 from pre-existing yield

### Flash Deposit Prevention (1 test)
- Alice: 100% yield (49.60 IBUS), attacker Bob: 0

### Permissionless Swap (1 test)
- Non-creator can trigger swapYield

### Creator Fee Rate Update (5 tests)
- Update to valid value (2% → 5%)
- Set to 0%, set to max (6%)
- Reject 7% (exceeds maximum)
- Reject non-creator update

### Max Slippage (5 tests)
- Creator can update maxSlippageBps
- Enforced min 5% (rejects lower)
- Enforced max 100% (rejects higher)
- Swap rejects slippage above max setting
- Non-creator cannot update

### Asset Opt-In Guard (2 tests)
- optInAssets succeeds on first call
- Rejects second call (already opted in)

### Farm Emission Rate (6 tests)
- Set to 0% when balance is 0
- Set any rate when balance is 0
- Reject < 10% when farm has balance
- Allow exactly 10% when farm has balance
- Allow > 10% when farm has balance
- Reject 0% when farm has balance

### Tinyman Pool Update (3 tests)
- Creator can update pool
- Validates pool contains correct assets
- Rejects non-creator/non-RareFi

---

## RareFiAlphaCompoundingVault Tests (85 tests)

### Deployment (2 tests)
- Deploy vault and pool successfully
- Correct initial state

### User Operations - Share Accounting (6 tests)
- Opt in, deposit (1:1 first), compound (price 1.0 → 1.154)
- Withdraw with yield (1000 → 1154.88 Alpha)
- Correct shares at higher price (500 Alpha → 463.4 shares at 1.079)
- Late depositor pays current share price

### Auto-Compounding Logic (2 tests)
- Proportional distribution (2x shares = 2x yield)
- Close out returns all Alpha for shares

### Edge Cases (4 tests)
- Prime number deposits
- 5 compound cycles: share price 1.496
- Dust handling on withdrawals
- Reject zero deposit

### Auto-Compound on Deposit (3 tests)
- No compound when USDC below threshold
- Auto-compound at threshold (price 1.0 → 1.090546)
- New depositor gets correct shares (not capturing yield)

### Farm Feature (3 tests)
- Fund farm (50 Alpha)
- Set emission rate (10%)
- Farm bonus applied on compound

### Permissionless Compound (1 test)
- Non-creator can trigger compoundYield

### Creator Fee Rate Update (5 tests)
- Same pattern as RareFiVault (0-6% range, creator only)

### Max Slippage (5 tests)
- Same pattern as RareFiVault (5-100% range, creator only)

### Asset Opt-In Guard (2 tests)
- Same pattern as RareFiVault

### Farm Emission Rate (6 tests)
- Same pattern as RareFiVault

### Tinyman Pool Update (3 tests)
- Same pattern as RareFiVault

### Comprehensive Integration (6 tests)
1. Initial deposits (3 users: 1000 + 500 + 500 = 2000 shares)
2. First compound — share price 1.0398
3. Partial withdrawals, Bob closes out
4. Second compound — further appreciation
5. Creator claims 29.86 Alpha fees
6. Final withdrawals (totalShares: 0, totalAlpha: 0)

---

## Security Features Tested

### Flash Deposit Prevention
Auto-swap/compound executes BEFORE deposit is credited. New depositor cannot capture pre-existing yield. Verified with explicit attacker scenario.

### Yield Distribution Fairness
- Proportional distribution based on deposit/share size
- Late depositors pay current share price
- Historical yield preserved through cycles
- Creator fee deducted before user distribution

### Permissionless Swaps
- Anyone can trigger `swapYield()` / `compoundYield()`
- Slippage capped by creator-controlled `maxSlippageBps` (min 5%)
- On-chain price calculation prevents fake quotes

### Creator Fee Constraints
- Capped at 0-6% via `MAX_FEE_RATE`
- Only creator can update (not RareFi or anyone else)

### Max Slippage Constraints
- Creator-controlled, range 5-100% (500-10000 bps)
- Enforced on all swap paths (permissionless + auto-swap on deposit)

### Farm Emission Constraints
- Min 10% when farm has balance (protects contributors)
- Max 100%, only creator or RareFi can set

### Immutability
- Contract updates and deletions always fail

---

## Accounting Precision

| Scenario | Expected | Actual | Error |
|----------|----------|--------|-------|
| Prime deposits (7:13) | 1.8571428571 | 1.8571429491 | 0.00001% |
| Share price | Exact | Exact | 0% |
| Creator fee (5%) | 5.00% | 5.00% | 0% |

- `yieldPerToken` / share price scaled by 1e12
- Safe math: `mulw`/`divmodw` (128-bit intermediates)
- Floor division throughout

---

## Test Infrastructure

```bash
# Run all tests
npm test

# Verbose output
npx jest --verbose

# Single file
npm test -- tests/vault.test.ts

# Compile contracts
npm run compile:vault
```

**Prerequisites:** Docker (Algorand localnet via `algokit localnet start`), Node.js ≥ 18

---

## Mock Tinyman Pool

Tests use `MockTinymanPool` simulating Tinyman V2:
- LocalState storage (matches real Tinyman V2 pattern)
- Constant product AMM formula
- 30 bps (0.3%) default fee
- State holder pattern for pool data

---

## Conclusion

All 190 tests pass. Both contracts demonstrate mathematically correct accounting with minimal precision loss (~0.00001%). Security features (auto-swap/compound protection, slippage caps, access controls, immutability) function as designed.
