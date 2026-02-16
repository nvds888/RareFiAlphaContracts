# Internal Security Review - RareFi Vault Contracts

**Date:** February 10, 2026
**Type:** Internal review (not a professional third-party audit)
**Reviewed Contracts:**
- `RareFiVault.algo.ts` → `RareFiVault.approval.teal`
- `RareFiAlphaCompoundingVault.algo.ts` → `RareFiAlphaCompoundingVault.approval.teal`

**Tools Used:**
- Trail of Bits Tealer v0.1.2 (static analyzer)
- Manual TEAL bytecode review

> **Note:** This is a self-conducted security review using automated tooling and manual verification. A professional third-party audit by an Algorand-specialized firm is recommended before mainnet deployment.

---

## Summary

- Phishing attack vector identified and fixed (unchecked `rekeyTo`/`closeRemainderTo`/`assetCloseTo` fields)
- All security checks verified in compiled TEAL bytecode
- Contract immutability enforced (updates/deletions disabled)
- Tealer false positives identified and documented

---

## 1. Phishing Attack Vector (Found & Fixed)

### Description

The contracts originally accepted payment and asset transfer transactions without validating dangerous Algorand-specific fields:
- `rekeyTo` - Changes account spending authority
- `closeRemainderTo` - Closes account and sends all remaining ALGOs
- `assetCloseTo` - Closes asset position and sends remaining assets

### Attack Scenario

1. Attacker creates malicious UI presenting "deposit" transaction
2. Transaction includes hidden `rekeyTo` field set to attacker's address
3. Contract approves without checking dangerous fields
4. User signs thinking it's just a deposit
5. User loses control of their account

### Affected Methods

**Both contracts:**
- `optInAssets()` - Payment transaction
- `deposit()` - Asset transfer transaction
- `contributeFarm()` - Asset transfer transaction

### Fix Applied

Added explicit validation for all incoming transactions:

```typescript
// Payment Transactions (optInAssets)
assert(algoPayment.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
assert(algoPayment.closeRemainderTo === Global.zeroAddress, 'closeRemainderTo must be zero');

// Asset Transfer Transactions (deposit, contributeFarm)
assert(depositTransfer.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
assert(depositTransfer.assetCloseTo === Global.zeroAddress, 'assetCloseTo must be zero');
```

### TEAL Verification

Verified in compiled bytecode at:

**RareFiVault.approval.teal:**
- Lines 403-414 (optInAssets): `RekeyTo`, `CloseRemainderTo`
- Lines 882-894 (deposit): `RekeyTo`, `AssetCloseTo`
- Lines 2036-2048 (contributeFarm): `RekeyTo`, `AssetCloseTo`

**RareFiAlphaCompoundingVault.approval.teal:**
- Lines 373-384 (optInAssets): `RekeyTo`, `CloseRemainderTo`
- Lines 738-750 (deposit): `RekeyTo`, `AssetCloseTo`
- Lines 1860-1872 (contributeFarm): `RekeyTo`, `AssetCloseTo`

---

## 2. Tealer Static Analysis

### Findings

| Finding | Impact | Status |
|---------|--------|--------|
| unprotected-deletable | High | False positive |
| unprotected-updatable | High | False positive |
| is-deletable | High | False positive |
| is-updatable | High | False positive |
| missing-fee-check | High | Not applicable |
| rekey-to | High | Not applicable |

### Analysis

**Deletable/Updatable (false positive):** Tealer detects that UpdateApplication/DeleteApplication have code paths, but doesn't recognize they always `err`. Both contracts explicitly reject these:

```teal
main_deleteApplication@31:
    txn ApplicationID
    assert // can only call when not creating
    err // Contract deletion disabled

main_updateApplication@30:
    txn ApplicationID
    assert // can only call when not creating
    err // Contract updates disabled
```

**Missing fee check (not applicable):** This detector targets Logic Signatures, not stateful applications. Inner transaction fees are explicitly set to 0 (covered by outer transaction fee pooling).

**Rekey-to (not applicable):** This detector targets Logic Signatures. Our contracts are stateful applications.

---

## 3. Security Checklist

Based on Trail of Bits "Not So Smart Contracts" Algorand vulnerability patterns:

| Pattern | Status | Notes |
|---------|--------|-------|
| Rekeying vulnerability | Pass | `rekeyTo` validated on all incoming txns |
| Close remainder to | Pass | `closeRemainderTo`/`assetCloseTo` validated |
| Transaction verification | Pass | Group index, sender, receiver, asset ID all checked |
| Access control | Pass | Creator-only and admin functions protected |
| Inner transaction safety | Pass | Fees set to 0, receivers explicit, no user-controlled fields |
| Application state | Pass | Properly initialized, safe arithmetic |
| Asset operations | Pass | Opt-in guard, ID validation, minimum amounts |
| Clear state program | Warning | Users lose funds if they clear state without withdrawing (by design) |
| Fee handling | Pass | Users pay fees, inner txns use fee pooling |
| Atomic transaction groups | Pass | Group position and previous txn validated |

---

## 4. Economic Safety Guards

- Maximum creator fee: 6%
- Minimum swap threshold: 0.20 USDC (prevents dust attacks)
- Maximum swap threshold: 50 USDC (prevents excessive accumulation)
- Minimum slippage setting: 5% (prevents creator from blocking swaps)
- Minimum deposit: 1 token (prevents spam)
- Safe math: 128-bit intermediates via `mulw`/`divmodw`, overflow assertion
- Immutable: Update and delete always fail, no admin backdoors
- On-chain pricing: Reads Tinyman pool reserves directly, no oracle dependency
- Slippage enforced post-swap: `assert(swapOutput >= minAmountOut)`

---

## 5. Recommendations

### Before Mainnet Deployment

1. Professional third-party audit by an Algorand-specialized firm
2. Integration testing against real Tinyman V2 on testnet
3. Verify Tinyman V2 local state keys match mainnet (`asset_1_id`, `asset_1_reserves`, `asset_2_reserves`, `total_fee_share`)
4. Verify inner transaction fee budget is sufficient for mainnet conditions

### Known Design Tradeoffs

- No emergency pause (tradeoff of immutability — users can always withdraw)
- No ownership transfer for `creatorAddress` or `rarefiAddress`
- Single Tinyman pool per vault (immutable after deployment)
- `emissionRatio` cannot be set to 0 once activated (intentional — protects farm contributors)
- Clear state without withdrawing forfeits funds (standard Algorand behavior)

---

**Last Updated:** 2026-02-10
