// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║                        ⚠  CONCEPT VERSION — DO NOT USE IN PRODUCTION  ⚠    ║
// ║                                                                              ║
// ║  This contract is an untested concept/draft. It has NOT been audited,       ║
// ║  tested on-chain, or reviewed for security. It requires significant         ║
// ║  improvements, thorough testing, and a professional audit before any        ║
// ║  real funds should be deposited or it should be deployed to mainnet.        ║
// ║                                                                              ║
// ║  USE AT YOUR OWN RISK.                                                       ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

// RareFiFolksVault.algo.ts - Folks Finance lending yield vault
// Users deposit an underlying asset (e.g. USDC) which the vault forwards to a Folks Finance
// lending pool. The fToken receipt appreciates over time as borrowers pay interest.
// Anyone can call harvestYield() to redeem the appreciation and swap it to a project token,
// which is distributed proportionally to all depositors via the standard accumulator pattern.
//
// Folks Finance V2 integration notes (verified from @folks-finance/algorand-sdk@0.2.3):
//   pool.deposit  ARC-4 sig: deposit(txn,account,asset,asset,application)uint64
//                 selector:  0xb9d542fb
//   pool.withdraw ARC-4 sig: withdraw(axfer,uint64,account,asset,asset,application)uint64
//                 selector:  0xeabe829d
//
//   The pool.deposit and pool.withdraw calls require:
//     - A preceding asset-transfer inner-txn (handled as the `txn`/`axfer` argument)
//     - The pool manager app ID as a foreign app (mainnet: 971350278, testnet: 147157634)
//     - No vault opt-in to the Folks pool app required — only ASA opt-ins
//
//   Fee requirements for outer transaction (fee pooling, all inner txns use fee=0):
//     deposit():     outer fee >= 4000 µALGO  (outer + vault axfer + Folks appcall + Folks fToken issue)
//     withdraw():    outer fee >= 5000 µALGO  (outer + vault axfer + Folks appcall + Folks underlying send + vault send to user)
//     harvestYield() without swap: >= 4000 µALGO
//     harvestYield() with swap:    >= 7000 µALGO  (adds Tinyman axfer + appcall + Tinyman inner send)
//     swapYield():   >= 4000 µALGO
//
//   ARC-4 reference type encoding in appArgs (standard AVM convention):
//     account:     uint8 index — 0 = Txn.sender (vault), 1 = accounts[0], ...
//     asset:       uint8 index — 0 = assets[0], 1 = assets[1], ...  (0-based)
//     application: uint8 index — 0 = called app, 1 = apps[0], ...

import {
  GlobalState,
  LocalState,
  itxn,
  gtxn,
  Global,
  assert,
  Uint64,
  uint64,
  Account,
  Asset,
  Application,
  arc4,
  Txn,
  Bytes,
  baremethod,
} from '@algorandfoundation/algorand-typescript';
import { mulw, divmodw, itob, AppLocal } from '@algorandfoundation/algorand-typescript/op';

// ── Constants ─────────────────────────────────────────────────────────────────
const SCALE: uint64 = Uint64(1_000_000_000_000);      // 1e12 yield-per-token precision
const MAX_FEE_RATE: uint64 = Uint64(6);                // 6% max creator fee (percentage)
const FEE_PERCENT_BASE: uint64 = Uint64(100);          // creatorFeeRate / 100 = percentage
const MIN_FARM_EMISSION_BPS: uint64 = Uint64(1_000);   // 10% floor when farm has balance
const MIN_DEPOSIT_AMOUNT: uint64 = Uint64(1_000_000);  // Minimum deposit (1 token, 6 decimals)
const MIN_SWAP_AMOUNT: uint64 = Uint64(100_000);       // 0.10 of deposit asset (6 decimals)
const MAX_SWAP_THRESHOLD: uint64 = Uint64(50_000_000); // 50 of deposit asset max threshold
const FEE_BPS_BASE: uint64 = Uint64(10_000);           // Basis points denominator
const MAX_SLIPPAGE_BPS: uint64 = Uint64(10_000);       // 100% absolute ceiling
const MIN_MAX_SLIPPAGE_BPS: uint64 = Uint64(500);      // 5% minimum for maxSlippageBps

// ── Folks Finance V2 ARC-4 method selectors ───────────────────────────────────
// Verified from @folks-finance/algorand-sdk@0.2.3 src/lend/abi-contracts/pool.json
// Selector = first 4 bytes of SHA-512/256 of the ARC-4 method signature string.

// deposit(txn,account,asset,asset,application)uint64  →  0xb9d542fb
const FOLKS_DEPOSIT_SELECTOR: bytes = Bytes('\xb9\xd5\x42\xfb');

// withdraw(axfer,uint64,account,asset,asset,application)uint64  →  0xeabe829d
const FOLKS_WITHDRAW_SELECTOR: bytes = Bytes('\xea\xbe\x82\x9d');

export class RareFiFolksVault extends arc4.Contract {
  // ── Global State ─────────────────────────────────────────────────────────────

  // Asset IDs
  depositAsset = GlobalState<uint64>();          // Underlying asset users deposit (e.g. USDC)
  fTokenAsset = GlobalState<uint64>();           // Folks Finance receipt token (e.g. fUSDC)
  swapAsset = GlobalState<uint64>();             // Project token (yield output after Tinyman swap)

  // Folks Finance integration
  folksPoolAppId = GlobalState<uint64>();        // Folks Finance lending pool app ID
  folksPoolAddress = GlobalState<Account>();     // Folks Finance pool address (= getAppAddress(folksPoolAppId))
  folksPoolManagerAppId = GlobalState<uint64>(); // Folks Finance pool manager app ID (mainnet: 971350278)

  // Tinyman V2 integration
  tinymanPoolAppId = GlobalState<uint64>();      // Tinyman V2 pool app ID (depositAsset/swapAsset)
  tinymanPoolAddress = GlobalState<Account>();   // Tinyman pool address

  // Creator / fee settings
  creatorAddress = GlobalState<Account>();
  rarefiAddress = GlobalState<Account>();
  creatorFeeRate = GlobalState<uint64>();        // 0–6, percentage of yield to creator
  creatorUnclaimedYield = GlobalState<uint64>(); // Accumulated swapAsset for creator to claim

  // Vault accounting
  totalDeposits = GlobalState<uint64>();             // Total underlying deposited (principal)
  totalPrincipalFTokens = GlobalState<uint64>();     // fTokens received on deposit — never harvested
  yieldPerToken = GlobalState<uint64>();             // Yield accumulator (scaled by SCALE)
  totalYieldGenerated = GlobalState<uint64>();       // Cumulative swapAsset yield distributed
  minSwapThreshold = GlobalState<uint64>();          // Minimum underlying balance to trigger swap
  maxSlippageBps = GlobalState<uint64>();            // Max slippage tolerance for Tinyman swaps

  // Farm feature
  farmBalance = GlobalState<uint64>();               // swapAsset bonus pool
  emissionRatio = GlobalState<uint64>();             // Farm emission multiplier (0 = disabled)

  // Setup guard
  assetsOptedIn = GlobalState<uint64>();             // 1 once all ASAs are opted in

  // ── Local State (per user) ───────────────────────────────────────────────────

  depositedAmount = LocalState<uint64>();        // User's underlying principal in vault
  userYieldPerToken = LocalState<uint64>();      // Snapshot of yieldPerToken at last interaction
  earnedYield = LocalState<uint64>();            // Accumulated unclaimed swapAsset

  // ── Private Helpers ──────────────────────────────────────────────────────────

  /**
   * Safe floor(n1 * n2 / d) using 128-bit intermediate precision.
   */
  private mulDivFloor(n1: uint64, n2: uint64, d: uint64): uint64 {
    const [hi, lo] = mulw(n1, n2);
    const [q_hi, q_lo, _r_hi, _r_lo] = divmodw(hi, lo, Uint64(0), d);
    assert(q_hi === Uint64(0), 'Overflow in mulDivFloor');
    return q_lo;
  }

  /**
   * Dynamic farm emission rate: farmBalance * emissionRatio / totalDeposits,
   * floored at MIN_FARM_EMISSION_BPS when farm has a balance.
   */
  private calculateDynamicEmissionRate(): uint64 {
    const totalDeposited = this.totalDeposits.value;
    if (totalDeposited === Uint64(0) || this.farmBalance.value === Uint64(0)) {
      return Uint64(0);
    }
    const dynamicRate = this.mulDivFloor(this.farmBalance.value, this.emissionRatio.value, totalDeposited);
    return dynamicRate < MIN_FARM_EMISSION_BPS ? MIN_FARM_EMISSION_BPS : dynamicRate;
  }

  /**
   * Sync a user's earned yield to the current accumulator snapshot.
   * Must be called before any state change that affects depositedAmount.
   */
  private updateEarnedYield(user: Account): void {
    const deposited = this.depositedAmount(user).value;
    if (deposited > Uint64(0)) {
      const currentYPT = this.yieldPerToken.value;
      const userYPT = this.userYieldPerToken(user).value;
      if (currentYPT > userYPT) {
        const pending = this.mulDivFloor(deposited, currentYPT - userYPT, SCALE);
        this.earnedYield(user).value = this.earnedYield(user).value + pending;
      }
    }
    this.userYieldPerToken(user).value = this.yieldPerToken.value;
  }

  /**
   * Read Tinyman V2 pool reserves on-chain and compute expected swap output.
   * Swapping depositAsset → swapAsset.
   */
  private getExpectedSwapOutput(inputAmount: uint64): uint64 {
    const poolApp = this.tinymanPoolAppId.value;
    const poolAddr = this.tinymanPoolAddress.value;

    const [asset1Id, hasAsset1Id] = AppLocal.getExUint64(poolAddr, poolApp, Bytes('asset_1_id'));
    assert(hasAsset1Id, 'Cannot read pool asset_1_id');

    const [asset1Reserves, hasAsset1Reserves] = AppLocal.getExUint64(poolAddr, poolApp, Bytes('asset_1_reserves'));
    assert(hasAsset1Reserves, 'Cannot read pool asset_1_reserves');

    const [asset2Reserves, hasAsset2Reserves] = AppLocal.getExUint64(poolAddr, poolApp, Bytes('asset_2_reserves'));
    assert(hasAsset2Reserves, 'Cannot read pool asset_2_reserves');

    const [totalFeeShare, hasTotalFeeShare] = AppLocal.getExUint64(poolAddr, poolApp, Bytes('total_fee_share'));
    assert(hasTotalFeeShare, 'Cannot read pool total_fee_share');

    let inputReserves: uint64;
    let outputReserves: uint64;

    if (asset1Id === this.depositAsset.value) {
      inputReserves = asset1Reserves;
      outputReserves = asset2Reserves;
    } else {
      inputReserves = asset2Reserves;
      outputReserves = asset1Reserves;
    }

    const netInput = this.mulDivFloor(inputAmount, FEE_BPS_BASE - totalFeeShare, FEE_BPS_BASE);
    return this.mulDivFloor(outputReserves, netInput, inputReserves + netInput);
  }

  /**
   * Execute depositAsset → swapAsset swap on Tinyman V2, apply farm bonus,
   * split fees, and update the yieldPerToken accumulator.
   * Sweeps the entire vault depositAsset balance.
   */
  private executeSwapAndDistribute(depositBalance: uint64, slippageBps: uint64): void {
    const appAddr: Account = Global.currentApplicationAddress;

    const expectedOutput = this.getExpectedSwapOutput(depositBalance);
    assert(expectedOutput > Uint64(0), 'Expected swap output is zero');

    const minAmountOut = this.mulDivFloor(expectedOutput, FEE_BPS_BASE - slippageBps, FEE_BPS_BASE);
    const swapAssetBefore = Asset(this.swapAsset.value).balance(appAddr);

    // Tinyman V2 fixed-input swap: depositAsset → swapAsset
    itxn.submitGroup(
      itxn.assetTransfer({
        assetReceiver: this.tinymanPoolAddress.value,
        xferAsset: Asset(this.depositAsset.value),
        assetAmount: depositBalance,
        fee: Uint64(0),
      }),
      itxn.applicationCall({
        appId: Application(this.tinymanPoolAppId.value),
        appArgs: [Bytes('swap'), Bytes('fixed-input'), itob(minAmountOut)],
        assets: [Asset(this.swapAsset.value)],
        accounts: [this.tinymanPoolAddress.value],
        fee: Uint64(0),
      }),
    );

    const swapAssetAfter: uint64 = Asset(this.swapAsset.value).balance(appAddr);
    const swapOutput: uint64 = swapAssetAfter - swapAssetBefore;
    assert(swapOutput >= minAmountOut, 'Swap output below minimum');

    // Farm bonus
    let farmBonus: uint64 = Uint64(0);
    if (this.emissionRatio.value > Uint64(0) && this.farmBalance.value > Uint64(0)) {
      const currentRate = this.calculateDynamicEmissionRate();
      const requestedBonus = this.mulDivFloor(swapOutput, currentRate, FEE_BPS_BASE);
      farmBonus = requestedBonus < this.farmBalance.value ? requestedBonus : this.farmBalance.value;
      this.farmBalance.value = this.farmBalance.value - farmBonus;
    }

    const totalOutput: uint64 = swapOutput + farmBonus;
    this.totalYieldGenerated.value = this.totalYieldGenerated.value + totalOutput;

    const creatorCut: uint64 = this.mulDivFloor(totalOutput, this.creatorFeeRate.value, FEE_PERCENT_BASE);
    const userCut: uint64 = totalOutput - creatorCut;

    this.creatorUnclaimedYield.value = this.creatorUnclaimedYield.value + creatorCut;

    if (userCut > Uint64(0)) {
      const yieldIncrease: uint64 = this.mulDivFloor(userCut, SCALE, this.totalDeposits.value);
      this.yieldPerToken.value = this.yieldPerToken.value + yieldIncrease;
    }
  }

  /**
   * Redeem fTokens from Folks Finance. The vault receives depositAsset back.
   * Used internally by withdraw, closeOut, and harvestYield.
   *
   * Folks withdraw ARC-4 args (verified from SDK):
   *   [0] selector (4 bytes)
   *   [1] received_amount uint64 (8 bytes) — pass 0 for variable (redeem all fTokens sent)
   *   [2] receiver account index (1 byte) — 0 = Txn.sender (vault)
   *   [3] asset index (1 byte) — 1 = foreignAssets[0] = depositAsset
   *   [4] f_asset index (1 byte) — 2 = foreignAssets[1] = fTokenAsset
   *   [5] pool_manager app index (1 byte) — 1 = foreignApps[0] = folksPoolManagerAppId
   *
   * @param fTokensToRedeem - exact fToken amount to send back to Folks
   * @returns depositAsset amount received from Folks
   */
  private redeemFTokens(fTokensToRedeem: uint64): uint64 {
    const appAddr: Account = Global.currentApplicationAddress;
    const depositBefore = Asset(this.depositAsset.value).balance(appAddr);

    itxn.submitGroup(
      itxn.assetTransfer({
        assetReceiver: this.folksPoolAddress.value,
        xferAsset: Asset(this.fTokenAsset.value),
        assetAmount: fTokensToRedeem,
        fee: Uint64(0),
      }),
      itxn.applicationCall({
        appId: Application(this.folksPoolAppId.value),
        appArgs: [
          FOLKS_WITHDRAW_SELECTOR,  // withdraw(axfer,uint64,account,asset,asset,application)uint64
          itob(Uint64(0)),           // received_amount = 0 (variable: redeem all fTokens sent)
          Bytes('\x00'),             // receiver = index 0 = Txn.sender = vault address
          Bytes('\x00'),             // asset = index 0 = foreignAssets[0] = depositAsset
          Bytes('\x01'),             // f_asset = index 1 = foreignAssets[1] = fTokenAsset
          Bytes('\x01'),             // pool_manager = index 1 = foreignApps[0] = folksPoolManagerAppId
        ],
        assets: [Asset(this.depositAsset.value), Asset(this.fTokenAsset.value)],
        apps: [Application(this.folksPoolManagerAppId.value)],
        fee: Uint64(0),
      }),
    );

    const depositAfter = Asset(this.depositAsset.value).balance(appAddr);
    const received = depositAfter - depositBefore;
    assert(received > Uint64(0), 'No underlying received from Folks');

    return received;
  }

  // ── Initialization ───────────────────────────────────────────────────────────

  /**
   * Deploy and configure the vault. Called once at deployment.
   * The deployer becomes the creator.
   *
   * Mainnet pool IDs (Folks Finance V2):
   *   USDC:  poolAppId=971372237, poolAddress=..., poolManagerAppId=971350278
   *   ALGO:  poolAppId=971368268, poolAddress=..., poolManagerAppId=971350278
   *   USDt:  poolAppId=971372700, poolAddress=..., poolManagerAppId=971350278
   *
   * Testnet pool IDs:
   *   USDC:  poolAppId=147170678, poolManagerAppId=147157634
   *   ALGO:  poolAppId=147169673, poolManagerAppId=147157634
   */
  @arc4.abimethod({ onCreate: 'require' })
  createVault(
    depositAssetId: uint64,
    fTokenAssetId: uint64,
    swapAssetId: uint64,
    folksPoolAppId: uint64,
    folksPoolAddress: Account,
    folksPoolManagerAppId: uint64,
    tinymanPoolAppId: uint64,
    tinymanPoolAddress: Account,
    creatorFeeRate: uint64,
    minSwapThreshold: uint64,
    maxSlippageBps: uint64,
    rarefiAddress: Account,
  ): void {
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');

    assert(creatorFeeRate <= MAX_FEE_RATE, 'Creator fee rate exceeds maximum (6%)');
    assert(minSwapThreshold >= MIN_SWAP_AMOUNT, 'Swap threshold too low');
    assert(minSwapThreshold <= MAX_SWAP_THRESHOLD, 'Swap threshold too high (max 50)');
    assert(maxSlippageBps >= MIN_MAX_SLIPPAGE_BPS, 'Max slippage too low (min 5%)');
    assert(maxSlippageBps <= MAX_SLIPPAGE_BPS, 'Max slippage too high');
    assert(depositAssetId !== Uint64(0), 'Invalid deposit asset');
    assert(fTokenAssetId !== Uint64(0), 'Invalid fToken asset');
    assert(swapAssetId !== Uint64(0), 'Invalid swap asset');
    assert(folksPoolAppId !== Uint64(0), 'Invalid Folks pool app ID');
    assert(folksPoolManagerAppId !== Uint64(0), 'Invalid Folks pool manager app ID');
    assert(tinymanPoolAppId !== Uint64(0), 'Invalid Tinyman pool app ID');
    assert(depositAssetId !== fTokenAssetId, 'Deposit and fToken assets must be different');
    assert(depositAssetId !== swapAssetId, 'Deposit and swap assets must be different');
    assert(fTokenAssetId !== swapAssetId, 'fToken and swap assets must be different');

    this.depositAsset.value = depositAssetId;
    this.fTokenAsset.value = fTokenAssetId;
    this.swapAsset.value = swapAssetId;

    this.folksPoolAppId.value = folksPoolAppId;
    this.folksPoolAddress.value = folksPoolAddress;
    this.folksPoolManagerAppId.value = folksPoolManagerAppId;

    this.tinymanPoolAppId.value = tinymanPoolAppId;
    this.tinymanPoolAddress.value = tinymanPoolAddress;

    this.creatorAddress.value = Txn.sender;
    this.rarefiAddress.value = rarefiAddress;
    this.creatorFeeRate.value = creatorFeeRate;
    this.creatorUnclaimedYield.value = Uint64(0);

    this.totalDeposits.value = Uint64(0);
    this.totalPrincipalFTokens.value = Uint64(0);
    this.yieldPerToken.value = Uint64(0);
    this.totalYieldGenerated.value = Uint64(0);
    this.minSwapThreshold.value = minSwapThreshold;
    this.maxSlippageBps.value = maxSlippageBps;

    this.farmBalance.value = Uint64(0);
    this.emissionRatio.value = Uint64(0);

    this.assetsOptedIn.value = Uint64(0);
  }

  /**
   * Opt the vault into its three ASAs: depositAsset, fTokenAsset, swapAsset.
   * No Folks pool app opt-in is required — the pool accepts any caller.
   *
   * Requires a preceding payment of ≥ 5.5 ALGO to cover:
   *   - 3 × 0.1 ALGO ASA MBR opt-ins
   *   - Operational fee buffer for inner transactions over vault lifetime
   */
  @arc4.abimethod()
  optInAssets(): void {
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    assert(Txn.sender === this.creatorAddress.value, 'Only creator can opt in assets');
    assert(this.assetsOptedIn.value === Uint64(0), 'Assets already opted in');

    const appAddr: Account = Global.currentApplicationAddress;
    const currentIndex = Txn.groupIndex;
    assert(currentIndex >= Uint64(1), 'App call must follow payment');

    const algoPayment = gtxn.PaymentTxn(currentIndex - Uint64(1));
    assert(algoPayment.receiver === appAddr, 'Payment must be to app');
    assert(algoPayment.amount >= Uint64(5_500_000), 'Insufficient ALGO (need 5.5 ALGO)');
    assert(algoPayment.sender === Txn.sender, 'Payment must be from caller');
    assert(algoPayment.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    assert(algoPayment.closeRemainderTo === Global.zeroAddress, 'closeRemainderTo must be zero');

    // Opt into depositAsset (e.g. USDC)
    itxn.assetTransfer({
      assetReceiver: appAddr,
      xferAsset: Asset(this.depositAsset.value),
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit();

    // Opt into fTokenAsset (e.g. fUSDC) — required to receive fTokens from Folks
    itxn.assetTransfer({
      assetReceiver: appAddr,
      xferAsset: Asset(this.fTokenAsset.value),
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit();

    // Opt into swapAsset (project token)
    itxn.assetTransfer({
      assetReceiver: appAddr,
      xferAsset: Asset(this.swapAsset.value),
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit();

    this.assetsOptedIn.value = Uint64(1);
  }

  // ── User Opt-In / Close-Out ──────────────────────────────────────────────────

  /**
   * User opts into the contract to enable local storage.
   */
  @arc4.abimethod({ allowActions: 'OptIn' })
  optIn(): void {
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    this.depositedAmount(Txn.sender).value = Uint64(0);
    this.userYieldPerToken(Txn.sender).value = Uint64(0);
    this.earnedYield(Txn.sender).value = Uint64(0);
  }

  /**
   * User closes out — redeems all deposited principal from Folks Finance
   * and claims any pending swapAsset yield in one transaction.
   *
   * Required outer txn fee: ≥ 6000 µALGO
   * (outer + vault axfer fToken + Folks appcall + Folks underlying send + vault send underlying + vault send yield)
   */
  @arc4.abimethod({ allowActions: 'CloseOut' })
  closeOut(): void {
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    this.updateEarnedYield(Txn.sender);

    const userDeposit = this.depositedAmount(Txn.sender).value;
    const userYield = this.earnedYield(Txn.sender).value;

    if (userDeposit > Uint64(0)) {
      // Last depositor uses all remaining fTokens to avoid dust accumulation
      let fTokensToRedeem: uint64;
      if (userDeposit === this.totalDeposits.value) {
        fTokensToRedeem = this.totalPrincipalFTokens.value;
      } else {
        fTokensToRedeem = this.mulDivFloor(userDeposit, this.totalPrincipalFTokens.value, this.totalDeposits.value);
      }

      const underlyingReceived = this.redeemFTokens(fTokensToRedeem);

      this.totalPrincipalFTokens.value = this.totalPrincipalFTokens.value - fTokensToRedeem;
      this.totalDeposits.value = this.totalDeposits.value - userDeposit;

      itxn.assetTransfer({
        assetReceiver: Txn.sender,
        xferAsset: Asset(this.depositAsset.value),
        assetAmount: underlyingReceived,
        fee: Uint64(0),
      }).submit();
    }

    if (userYield > Uint64(0)) {
      itxn.assetTransfer({
        assetReceiver: Txn.sender,
        xferAsset: Asset(this.swapAsset.value),
        assetAmount: userYield,
        fee: Uint64(0),
      }).submit();
    }
  }

  // ── Deposit / Withdraw ───────────────────────────────────────────────────────

  /**
   * User deposits the underlying asset. The vault immediately forwards it to Folks
   * Finance and records the fTokens received as the user's principal baseline.
   *
   * Expects a preceding asset transfer of depositAsset to the vault in the group.
   *
   * Folks deposit ARC-4 args (verified from SDK):
   *   [0] selector (4 bytes)
   *   [1] receiver account index (1 byte) — 0 = Txn.sender (vault)
   *   [2] asset index (1 byte) — 1 = foreignAssets[0] = depositAsset
   *   [3] f_asset index (1 byte) — 2 = foreignAssets[1] = fTokenAsset
   *   [4] pool_manager app index (1 byte) — 1 = foreignApps[0] = folksPoolManagerAppId
   *
   * Required outer txn fee: ≥ 4000 µALGO
   */
  @arc4.abimethod()
  deposit(): void {
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    assert(this.assetsOptedIn.value === Uint64(1), 'Vault assets not yet opted in');

    const appAddr: Account = Global.currentApplicationAddress;
    const currentIndex = Txn.groupIndex;
    assert(currentIndex >= Uint64(1), 'App call must follow asset transfer');

    const depositTransfer = gtxn.AssetTransferTxn(currentIndex - Uint64(1));
    assert(depositTransfer.xferAsset === Asset(this.depositAsset.value), 'Must transfer deposit asset');
    assert(depositTransfer.assetReceiver === appAddr, 'Must send to contract');
    assert(depositTransfer.sender === Txn.sender, 'Transfer must be from caller');
    assert(depositTransfer.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    assert(depositTransfer.assetCloseTo === Global.zeroAddress, 'assetCloseTo must be zero');

    const amount = depositTransfer.assetAmount;
    assert(amount >= MIN_DEPOSIT_AMOUNT, 'Deposit too small');

    // Sync yield before state changes
    this.updateEarnedYield(Txn.sender);

    // Snapshot fToken balance before forwarding to Folks
    const fTokenBefore = Asset(this.fTokenAsset.value).balance(appAddr);

    // Forward deposit to Folks Finance lending pool
    itxn.submitGroup(
      itxn.assetTransfer({
        assetReceiver: this.folksPoolAddress.value,
        xferAsset: Asset(this.depositAsset.value),
        assetAmount: amount,
        fee: Uint64(0),
      }),
      itxn.applicationCall({
        appId: Application(this.folksPoolAppId.value),
        appArgs: [
          FOLKS_DEPOSIT_SELECTOR,  // deposit(txn,account,asset,asset,application)uint64
          Bytes('\x00'),           // receiver = index 0 = Txn.sender = vault address
          Bytes('\x00'),           // asset = index 0 = foreignAssets[0] = depositAsset
          Bytes('\x01'),           // f_asset = index 1 = foreignAssets[1] = fTokenAsset
          Bytes('\x01'),           // pool_manager = index 1 = foreignApps[0]
        ],
        assets: [Asset(this.depositAsset.value), Asset(this.fTokenAsset.value)],
        apps: [Application(this.folksPoolManagerAppId.value)],
        fee: Uint64(0),
      }),
    );

    // fTokens received = balance delta (Folks sends fTokens to vault via inner axfer)
    const fTokenAfter = Asset(this.fTokenAsset.value).balance(appAddr);
    const fTokensReceived = fTokenAfter - fTokenBefore;
    assert(fTokensReceived > Uint64(0), 'No fTokens received from Folks');

    // Record principal baseline and update user state
    this.totalPrincipalFTokens.value = this.totalPrincipalFTokens.value + fTokensReceived;
    this.depositedAmount(Txn.sender).value = this.depositedAmount(Txn.sender).value + amount;
    this.totalDeposits.value = this.totalDeposits.value + amount;
  }

  /**
   * User withdraws underlying principal.
   * Redeems proportional fTokens from Folks Finance and returns the underlying.
   * Auto-claims any pending yield on withdrawal.
   *
   * @param amount - Amount to withdraw (0 = withdraw all)
   *
   * Required outer txn fee: ≥ 5000 µALGO (≥ 6000 if pending yield exists)
   */
  @arc4.abimethod()
  withdraw(amount: uint64): void {
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');

    const userBalance = this.depositedAmount(Txn.sender).value;
    let withdrawAmount = amount;
    if (withdrawAmount === Uint64(0)) {
      withdrawAmount = userBalance;
    }

    assert(withdrawAmount > Uint64(0), 'Nothing to withdraw');
    assert(withdrawAmount <= userBalance, 'Insufficient balance');

    // Sync yield before state changes
    this.updateEarnedYield(Txn.sender);

    // Last depositor uses all remaining fTokens to avoid dust accumulation
    let fTokensToRedeem: uint64;
    if (withdrawAmount === this.totalDeposits.value) {
      fTokensToRedeem = this.totalPrincipalFTokens.value;
    } else {
      fTokensToRedeem = this.mulDivFloor(withdrawAmount, this.totalPrincipalFTokens.value, this.totalDeposits.value);
    }

    const underlyingReceived = this.redeemFTokens(fTokensToRedeem);

    this.totalPrincipalFTokens.value = this.totalPrincipalFTokens.value - fTokensToRedeem;
    this.depositedAmount(Txn.sender).value = userBalance - withdrawAmount;
    this.totalDeposits.value = this.totalDeposits.value - withdrawAmount;

    // Return underlying to user
    itxn.assetTransfer({
      assetReceiver: Txn.sender,
      xferAsset: Asset(this.depositAsset.value),
      assetAmount: underlyingReceived,
      fee: Uint64(0),
    }).submit();

    // Auto-claim any pending yield
    const pendingYield = this.earnedYield(Txn.sender).value;
    if (pendingYield > Uint64(0)) {
      this.earnedYield(Txn.sender).value = Uint64(0);
      itxn.assetTransfer({
        assetReceiver: Txn.sender,
        xferAsset: Asset(this.swapAsset.value),
        assetAmount: pendingYield,
        fee: Uint64(0),
      }).submit();
    }
  }

  // ── Yield Harvesting ─────────────────────────────────────────────────────────

  /**
   * Harvest the yield portion of fTokens from Folks Finance.
   * Only redeems fTokens beyond the principal baseline:
   *   yieldFTokens = fTokenBalance - totalPrincipalFTokens
   *
   * If the vault's accumulated depositAsset balance meets minSwapThreshold after
   * redemption, it is automatically swapped to swapAsset and distributed.
   * Otherwise the underlying accumulates for the next harvest or swapYield() call.
   *
   * totalPrincipalFTokens is NOT updated — these are yield tokens, not principal.
   * Permissionless — anyone can call.
   *
   * @param fTokensToRedeem - yield fTokens to redeem (≤ fTokenBalance - totalPrincipalFTokens)
   * @param slippageBps     - slippage tolerance for Tinyman swap (basis points)
   *
   * Required outer txn fee: ≥ 4000 µALGO (no swap) or ≥ 7000 µALGO (with swap)
   */
  @arc4.abimethod()
  harvestYield(fTokensToRedeem: uint64, slippageBps: uint64): void {
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    assert(slippageBps <= this.maxSlippageBps.value, 'Slippage exceeds maximum allowed');
    assert(fTokensToRedeem > Uint64(0), 'Must redeem at least 1 fToken');
    assert(this.totalDeposits.value > Uint64(0), 'No depositors to distribute to');

    const appAddr: Account = Global.currentApplicationAddress;

    // Principal safety guard: only the appreciation portion is harvestable
    const fTokenBalance = Asset(this.fTokenAsset.value).balance(appAddr);
    const yieldFTokens = fTokenBalance - this.totalPrincipalFTokens.value;
    assert(fTokensToRedeem <= yieldFTokens, 'Cannot redeem principal fTokens');

    // Redeem yield fTokens — totalPrincipalFTokens NOT updated (yield, not principal)
    this.redeemFTokens(fTokensToRedeem);

    // Swap entire accumulated depositAsset balance if above threshold
    const depositBalance = Asset(this.depositAsset.value).balance(appAddr);
    if (depositBalance >= this.minSwapThreshold.value) {
      this.executeSwapAndDistribute(depositBalance, slippageBps);
    }
  }

  /**
   * Swap accumulated depositAsset to swapAsset via Tinyman V2.
   * Used when a prior harvestYield left the vault below the swap threshold,
   * or to force distribution at any time. Permissionless.
   *
   * @param slippageBps - slippage tolerance in basis points
   *
   * Required outer txn fee: ≥ 4000 µALGO
   */
  @arc4.abimethod()
  swapYield(slippageBps: uint64): void {
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    assert(slippageBps <= this.maxSlippageBps.value, 'Slippage exceeds maximum allowed');

    const appAddr: Account = Global.currentApplicationAddress;
    const depositBalance = Asset(this.depositAsset.value).balance(appAddr);

    assert(depositBalance >= this.minSwapThreshold.value, 'Below minimum swap threshold');
    assert(this.totalDeposits.value > Uint64(0), 'No depositors to distribute to');

    this.executeSwapAndDistribute(depositBalance, slippageBps);
  }

  // ── Yield Claiming ───────────────────────────────────────────────────────────

  /**
   * User claims accumulated swapAsset yield without withdrawing principal.
   */
  @arc4.abimethod()
  claim(): void {
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    this.updateEarnedYield(Txn.sender);

    const claimable = this.earnedYield(Txn.sender).value;
    assert(claimable > Uint64(0), 'Nothing to claim');

    this.earnedYield(Txn.sender).value = Uint64(0);
    itxn.assetTransfer({
      assetReceiver: Txn.sender,
      xferAsset: Asset(this.swapAsset.value),
      assetAmount: claimable,
      fee: Uint64(0),
    }).submit();
  }

  /**
   * Creator claims accumulated fee yield.
   */
  @arc4.abimethod()
  claimCreator(): void {
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    assert(Txn.sender === this.creatorAddress.value, 'Only creator can claim');

    const claimable = this.creatorUnclaimedYield.value;
    assert(claimable > Uint64(0), 'Nothing to claim');

    this.creatorUnclaimedYield.value = Uint64(0);
    itxn.assetTransfer({
      assetReceiver: Txn.sender,
      xferAsset: Asset(this.swapAsset.value),
      assetAmount: claimable,
      fee: Uint64(0),
    }).submit();
  }

  // ── Farm Feature ─────────────────────────────────────────────────────────────

  /**
   * Anyone can contribute swapAsset to the farm bonus pool.
   * Expects a preceding asset transfer of swapAsset to the vault.
   */
  @arc4.abimethod()
  contributeFarm(): void {
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    const appAddr: Account = Global.currentApplicationAddress;
    const currentIndex = Txn.groupIndex;
    assert(currentIndex >= Uint64(1), 'App call must follow asset transfer');

    const farmTransfer = gtxn.AssetTransferTxn(currentIndex - Uint64(1));
    assert(farmTransfer.xferAsset === Asset(this.swapAsset.value), 'Must transfer swap asset');
    assert(farmTransfer.assetReceiver === appAddr, 'Must send to contract');
    assert(farmTransfer.sender === Txn.sender, 'Transfer must be from caller');
    assert(farmTransfer.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    assert(farmTransfer.assetCloseTo === Global.zeroAddress, 'assetCloseTo must be zero');

    const amount = farmTransfer.assetAmount;
    assert(amount > Uint64(0), 'Contribution must be positive');

    this.farmBalance.value = this.farmBalance.value + amount;
  }

  /**
   * Set the farm emission ratio (dynamic rate multiplier).
   * Dynamic rate = farmBalance × emissionRatio / totalDeposits,
   * floored at 10% when farm has a balance.
   */
  @arc4.abimethod()
  setEmissionRatio(newRatio: uint64): void {
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    const isCreator = Txn.sender === this.creatorAddress.value;
    const isRarefi = Txn.sender === this.rarefiAddress.value;
    assert(isCreator || isRarefi, 'Only creator or RareFi can set emission ratio');
    assert(newRatio > Uint64(0), 'Emission ratio must be positive');
    this.emissionRatio.value = newRatio;
  }

  // ── Read-Only Methods ────────────────────────────────────────────────────────

  /**
   * Returns [totalDeposits, yieldPerToken, creatorUnclaimedYield,
   *          depositAssetBalance, yieldFTokens, totalYieldGenerated]
   * where yieldFTokens = fTokenBalance - totalPrincipalFTokens (harvestable amount).
   */
  @arc4.abimethod({ readonly: true })
  getVaultStats(): [uint64, uint64, uint64, uint64, uint64, uint64] {
    const appAddr: Account = Global.currentApplicationAddress;
    const depositBalance = Asset(this.depositAsset.value).balance(appAddr);
    const fTokenBalance = Asset(this.fTokenAsset.value).balance(appAddr);
    const yieldFTokens = fTokenBalance > this.totalPrincipalFTokens.value
      ? fTokenBalance - this.totalPrincipalFTokens.value
      : Uint64(0);

    return [
      this.totalDeposits.value,
      this.yieldPerToken.value,
      this.creatorUnclaimedYield.value,
      depositBalance,
      yieldFTokens,
      this.totalYieldGenerated.value,
    ];
  }

  /**
   * Get user's pending unclaimed yield (without claiming).
   */
  @arc4.abimethod({ readonly: true })
  getPendingYield(user: Account): uint64 {
    const deposited = this.depositedAmount(user).value;
    let pending = this.earnedYield(user).value;

    if (deposited > Uint64(0)) {
      const currentYPT = this.yieldPerToken.value;
      const userYPT = this.userYieldPerToken(user).value;
      if (currentYPT > userYPT) {
        pending = pending + this.mulDivFloor(deposited, currentYPT - userYPT, SCALE);
      }
    }

    return pending;
  }

  /**
   * Get user's deposited principal.
   */
  @arc4.abimethod({ readonly: true })
  getUserDeposit(user: Account): uint64 {
    return this.depositedAmount(user).value;
  }

  /**
   * Get farm statistics.
   * Returns [farmBalance, emissionRatio, currentDynamicRate]
   */
  @arc4.abimethod({ readonly: true })
  getFarmStats(): [uint64, uint64, uint64] {
    let currentRate: uint64 = Uint64(0);
    if (this.emissionRatio.value > Uint64(0) && this.farmBalance.value > Uint64(0)) {
      currentRate = this.calculateDynamicEmissionRate();
    }
    return [this.farmBalance.value, this.emissionRatio.value, currentRate];
  }

  // ── Admin Methods ────────────────────────────────────────────────────────────

  @arc4.abimethod()
  updateMinSwapThreshold(newThreshold: uint64): void {
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    const isCreator = Txn.sender === this.creatorAddress.value;
    const isRarefi = Txn.sender === this.rarefiAddress.value;
    assert(isCreator || isRarefi, 'Only creator or RareFi can update');
    assert(newThreshold >= MIN_SWAP_AMOUNT, 'Threshold too low');
    assert(newThreshold <= MAX_SWAP_THRESHOLD, 'Threshold too high (max 50)');
    this.minSwapThreshold.value = newThreshold;
  }

  @arc4.abimethod()
  updateMaxSlippage(newMaxSlippageBps: uint64): void {
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    assert(Txn.sender === this.creatorAddress.value, 'Only creator can update max slippage');
    assert(newMaxSlippageBps >= MIN_MAX_SLIPPAGE_BPS, 'Max slippage too low (min 5%)');
    assert(newMaxSlippageBps <= MAX_SLIPPAGE_BPS, 'Max slippage too high');
    this.maxSlippageBps.value = newMaxSlippageBps;
  }

  @arc4.abimethod()
  updateCreatorAddress(newCreatorAddress: Account): void {
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    assert(Txn.sender === this.creatorAddress.value, 'Only creator can update');
    assert(newCreatorAddress !== Global.zeroAddress, 'Cannot set zero address');
    this.creatorAddress.value = newCreatorAddress;
  }

  @arc4.abimethod()
  updateRarefiAddress(newRarefiAddress: Account): void {
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    assert(Txn.sender === this.rarefiAddress.value, 'Only RareFi can update');
    assert(newRarefiAddress !== Global.zeroAddress, 'Cannot set zero address');
    this.rarefiAddress.value = newRarefiAddress;
  }

  @arc4.abimethod()
  updateCreatorFeeRate(newFeeRate: uint64): void {
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    assert(Txn.sender === this.creatorAddress.value, 'Only creator can update fee rate');
    assert(newFeeRate <= MAX_FEE_RATE, 'Fee rate exceeds maximum (6%)');
    this.creatorFeeRate.value = newFeeRate;
  }

  @arc4.abimethod()
  updateTinymanPool(newPoolAppId: uint64, newPoolAddress: Account): void {
    assert(Txn.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    const isCreator = Txn.sender === this.creatorAddress.value;
    const isRarefi = Txn.sender === this.rarefiAddress.value;
    assert(isCreator || isRarefi, 'Only creator or RareFi can update pool');
    assert(newPoolAppId !== Uint64(0), 'Invalid pool app ID');
    this.tinymanPoolAppId.value = newPoolAppId;
    this.tinymanPoolAddress.value = newPoolAddress;
  }

  // ── Security: Immutability ───────────────────────────────────────────────────

  @baremethod({ allowActions: 'UpdateApplication' })
  updateApplication(): void {
    assert(false, 'Contract updates disabled');
  }

  @baremethod({ allowActions: 'DeleteApplication' })
  deleteApplication(): void {
    assert(false, 'Contract deletion disabled');
  }
}
