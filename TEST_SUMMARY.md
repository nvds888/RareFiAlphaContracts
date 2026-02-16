# RareFi Vault Contracts - Test Summary

**Date:** February 2026
**Contracts:** RareFiVault, RareFiAlphaCompoundingVault
**Framework:** Jest + Algorand Localnet
**Total Tests:** 200 passing (110 + 90)

---

## RareFiVault Tests (110 tests)

| Category | Tests | Description |
|----------|-------|-------------|
| Deployment | 2 | Deploy vault and pool, verify initial state |
| User Operations | 6 | Opt in, deposit, yield tracking, claim, withdraw, cycles |
| Close Out | 1 | Returns deposit and yield on close out |
| Comprehensive Integration | 9 | Multi-user scenario (Alice, Bob, Charlie, Dave) through full lifecycle |
| Edge Cases & Rounding | 5 | Prime numbers, small yield, large deposits, multi-cycle precision |
| Auto-Swap on Deposit | 4 | Threshold behavior, yield distribution to existing depositors |
| Flash Deposit Prevention | 1 | Attacker gets 0 from pre-existing yield |
| Permissionless Swap | 1 | Non-creator can trigger swapYield |
| Creator Fee Rate Update | 5 | Valid updates, boundary values, rejection of invalid values |
| Max Slippage | 5 | Range enforcement (5-100%), swap rejection, access control |
| Creator Claim Access Control | 1 | Reject non-creator |
| Asset Opt-In Guard | 2 | Single-use enforcement |
| Farm + Creator Fee Interaction | 1 | Fee applied on total output (swap + farm bonus) |
| Emission Ratio Constraints | 8 | Reject 0, allow positive, no max cap, 10% floor, access control |
| Min Swap Threshold Update | 7 | Range enforcement (0.20-50 USDC), access control |
| Rekey Protection | 1 | Reject app call with non-zero rekeyTo |

## RareFiAlphaCompoundingVault Tests (90 tests)

| Category | Tests | Description |
|----------|-------|-------------|
| Deployment | 2 | Deploy vault and pool, verify initial state |
| Share Accounting | 6 | 1:1 first deposit, compound price increase, late depositor pricing |
| Auto-Compounding Logic | 2 | Proportional distribution, close out |
| Edge Cases | 4 | Prime numbers, 5 compound cycles, dust handling, zero deposit rejection |
| Auto-Compound on Deposit | 3 | Threshold behavior, share price update, new depositor protection |
| Farm Feature | 3 | Fund farm, set emission rate, bonus applied on compound |
| Farm + Creator Fee Interaction | 1 | Fee applied on total output (compound + farm bonus) |
| Permissionless Compound | 1 | Non-creator can trigger compoundYield |
| Creator Fee Rate Update | 5 | Same pattern as RareFiVault |
| Max Slippage | 5 | Same pattern as RareFiVault |
| Creator Claim Access Control | 1 | Reject non-creator |
| Asset Opt-In Guard | 2 | Same pattern as RareFiVault |
| Emission Ratio Constraints | 8 | Same pattern as RareFiVault |
| Min Swap Threshold Update | 7 | Same pattern as RareFiVault |
| Rekey Protection | 1 | Reject app call with non-zero rekeyTo |
| Comprehensive Integration | 6 | Multi-user lifecycle through deposits, compounds, withdrawals |

---

## Security Features Tested

- **Rekey protection:** All app calls and grouped txns reject non-zero `rekeyTo`, `closeRemainderTo`, `assetCloseTo`
- **Flash deposit prevention:** Auto-swap/compound executes before deposit is credited
- **Yield distribution fairness:** Proportional to deposit/share size, late depositors pay current price
- **Permissionless swaps:** Anyone can trigger, slippage capped by `maxSlippageBps`
- **Creator fee constraints:** 0-6% range, creator-only updates
- **Farm emission constraints:** Dynamic rate with 10% floor, geometric decay, no max cap
- **Immutability:** Contract updates and deletions always fail

---

## Accounting Precision

| Scenario | Expected | Actual | Error |
|----------|----------|--------|-------|
| Prime deposits (7:13 ratio) | 1.8571428571 | 1.8571429491 | 0.00001% |
| Share price | Exact | Exact | 0% |
| Creator fee (5%) | 5.00% | 5.00% | 0% |

All arithmetic uses `mulw`/`divmodw` (128-bit intermediates) with floor division.

---

## Running Tests

```bash
# Prerequisites: Docker + algokit localnet start
npm test                              # All tests
npm test -- tests/vault.test.ts       # RareFiVault only
npm test -- tests/compoundingVault.test.ts  # Compounding vault only
npx jest --verbose                    # Detailed output
```

Tests use `MockTinymanPool` simulating Tinyman V2 with LocalState storage, constant product AMM, and 30 bps default fee.
