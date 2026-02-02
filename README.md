# RareFi Vault Contracts

Yield routing protocol on Algorand. Users deposit Alpha tokens and earn yield in their chosen format - either project tokens or auto-compounded Alpha.

## Contracts

| Contract | Description |
|----------|-------------|
| `RareFiVault` | Deposit Alpha, earn project tokens from USDC yield |
| `RareFiAlphaCompoundingVault` | Deposit Alpha, auto-compound USDC yield back to Alpha |
| `MockTinymanPool` | Test mock for Tinyman V2 integration |

## Documentation

- [RAREFI_CONCEPT.md](./RAREFI_CONCEPT.md) - Protocol overview and architecture
- [TECHNICAL_SPEC_RareFiVault.md](./TECHNICAL_SPEC_RareFiVault.md) - RareFiVault specification
- [TECHNICAL_SPEC_RareFiAlphaCompoundingVault.md](./TECHNICAL_SPEC_RareFiAlphaCompoundingVault.md) - Compounding vault specification
- [TEST_SUMMARY.md](./TEST_SUMMARY.md) - Test coverage and results

## Project Structure

```
rarefivault/
├── contracts/
│   ├── RareFiVault.algo.ts              # Project token yield vault
│   ├── RareFiAlphaCompoundingVault.algo.ts  # Auto-compounding vault
│   ├── MockTinymanPool.algo.ts          # Tinyman V2 test mock
│   └── artifacts/                       # Compiled TEAL and ABI specs
├── tests/
│   ├── vault.test.ts                    # RareFiVault tests (81 tests)
│   ├── compoundingVault.test.ts         # Compounding vault tests (61 tests)
│   └── utils/                           # Test utilities
├── RAREFI_CONCEPT.md
├── TECHNICAL_SPEC_RareFiVault.md
├── TECHNICAL_SPEC_RareFiAlphaCompoundingVault.md
└── TEST_SUMMARY.md
```

## Prerequisites

- Node.js >= 18
- Docker (for Algorand localnet)
- [AlgoKit](https://github.com/algorandfoundation/algokit-cli)

## Setup

```bash
# Install dependencies
npm install

# Start localnet
algokit localnet start
```

## Build

```bash
# Compile all contracts
npm run compile
```

Compiled artifacts are output to `contracts/artifacts/`.

## Test

```bash
# Run all tests (requires localnet running)
npm test

# Run specific test file
npm test -- tests/vault.test.ts
```

**Current status:** 142 tests passing

## Key Features

- **Permissionless deposits/withdrawals** - Users can enter/exit anytime
- **Permissionless yield processing** - Anyone can trigger swaps/compounds
- **Flash deposit protection** - Auto-swap on deposit prevents yield sniping
- **On-chain price calculation** - Reads Tinyman pool state directly, no oracles
- **Farm bonus** - Optional sponsor-funded yield boost
- **Immutable** - No upgrades or deletions possible

## Security

- Contracts cannot be upgraded or deleted after deployment
- 128-bit safe math prevents overflow
- Slippage protection on all swaps
- Minimum thresholds prevent dust attacks

See [TEST_SUMMARY.md](./TEST_SUMMARY.md) for security test coverage.

## License

MIT
