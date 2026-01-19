// OrbitalVault.algo.ts - USDC vault with Orbital Lending integration
// Users deposit USDC → deposited to Orbital → yield accrues via rate appreciation
// Periodic harvests swap accumulated yield to project ASA for distribution

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
import { mulw, divmodw, itob, AppGlobal, btoi } from '@algorandfoundation/algorand-typescript/op';

// Constants
const RATE_PRECISION: uint64 = Uint64(1_000_000);     // 1e6 for Orbital exchange rate
const YIELD_SCALE: uint64 = Uint64(1_000_000_000);    // 1e9 for yield per share precision
const ASA_SCALE: uint64 = Uint64(1_000_000_000_000);  // 1e12 for ASA per USDC precision
const FEE_BPS_BASE: uint64 = Uint64(10_000);          // Basis points denominator
const MAX_FEE_BPS: uint64 = Uint64(500);              // Max 5% fee
const MAX_SLIPPAGE_BPS: uint64 = Uint64(1000);        // Max 10% slippage
const MIN_DEPOSIT_AMOUNT: uint64 = Uint64(1_000_000); // 1 USDC minimum (6 decimals)
const MIN_HARVEST_THRESHOLD: uint64 = Uint64(1_000_000); // 1 USDC minimum harvest
const MBR_ASSET_OPTIN: uint64 = Uint64(100_000);      // 0.1 ALGO per asset opt-in
const CREATOR_SETUP_FEE: uint64 = Uint64(200_000_000); // 200 ALGO setup fee

export class OrbitalVault extends arc4.Contract {
  // ============================================
  // GLOBAL STATE
  // ============================================

  // Core addresses
  creator = GlobalState<Account>();           // Vault creator/admin
  rarefiAddress = GlobalState<Account>();     // RareFi platform address

  // Control flags
  isPaused = GlobalState<boolean>();          // Emergency pause flag

  // Asset IDs
  usdcAssetId = GlobalState<uint64>();        // USDC asset ID
  cUsdcAssetId = GlobalState<uint64>();       // cUSDC (Orbital LST) asset ID
  projectAsaId = GlobalState<uint64>();       // Project ASA (yield paid in this)

  // External protocol integration
  orbitalAppId = GlobalState<uint64>();       // Orbital Lending app ID
  tinymanPoolAppId = GlobalState<uint64>();   // Tinyman V2 pool app ID
  tinymanPoolAddress = GlobalState<Account>();// Tinyman pool address

  // Vault totals
  totalShares = GlobalState<uint64>();        // Total cUSDC shares held by vault
  totalPrincipal = GlobalState<uint64>();     // Total USDC principal deposited by users

  // Two-stage yield tracking
  usdcYieldPerShare = GlobalState<uint64>();  // Stage 1: Rate-based USDC yield accumulator
  asaYieldPerShare = GlobalState<uint64>();   // Stage 2: ASA yield accumulator (after harvest)
  lastRateSnapshot = GlobalState<uint64>();   // Exchange rate at last checkpoint

  // Harvest tracking
  lastHarvestYieldPerShare = GlobalState<uint64>(); // usdcYieldPerShare at last harvest
  lastHarvestAsaPerUsdc = GlobalState<uint64>();    // Conversion rate from last harvest
  minHarvestThreshold = GlobalState<uint64>();      // Minimum USDC yield before harvest

  // Fee settings
  depositFeeBps = GlobalState<uint64>();      // Deposit fee in basis points
  withdrawFeeBps = GlobalState<uint64>();     // Withdraw fee in basis points

  // ============================================
  // LOCAL STATE (per user)
  // ============================================

  userShares = LocalState<uint64>();              // User's cUSDC share balance
  userUsdcYieldPerShare = LocalState<uint64>();   // Snapshot of usdcYieldPerShare
  userAsaYieldPerShare = LocalState<uint64>();    // Snapshot of asaYieldPerShare
  userUnrealizedUsdc = LocalState<uint64>();      // USDC yield not yet harvested
  earnedAsa = LocalState<uint64>();               // ASA yield ready to claim

  // ============================================
  // HELPER FUNCTIONS
  // ============================================

  /**
   * Safe multiplication and division: floor(n1 * n2 / d)
   */
  private mulDivFloor(n1: uint64, n2: uint64, d: uint64): uint64 {
    const [hi, lo] = mulw(n1, n2);
    const [q_hi, q_lo, _r_hi, _r_lo] = divmodw(hi, lo, Uint64(0), d);
    assert(q_hi === Uint64(0), 'Overflow in mulDivFloor');
    return q_lo;
  }

  /**
   * Safe multiplication and division with ceiling: ceil(n1 * n2 / d)
   */
  private mulDivCeil(n1: uint64, n2: uint64, d: uint64): uint64 {
    const [hi, lo] = mulw(n1, n2);
    const [q_hi, q_lo, r_hi, r_lo] = divmodw(hi, lo, Uint64(0), d);
    assert(q_hi === Uint64(0), 'Overflow in mulDivCeil');
    if (r_lo > Uint64(0) || r_hi > Uint64(0)) {
      return q_lo + Uint64(1);
    }
    return q_lo;
  }

  /**
   * Fetch current exchange rate from Orbital Lending
   * rate = total_deposits / circulating_lst (scaled by RATE_PRECISION)
   */
  private fetchCurrentRate(): uint64 {
    const orbitalApp = this.orbitalAppId.value;

    // Read Orbital's global state
    const [totalDeposits, hasTotalDeposits] = AppGlobal.getExUint64(orbitalApp, Bytes('total_deposits'));
    const [circulatingLst, hasCirculatingLst] = AppGlobal.getExUint64(orbitalApp, Bytes('circulating_lst'));

    // Handle case where state doesn't exist yet (should not happen in production)
    if (!hasTotalDeposits || !hasCirculatingLst) {
      return RATE_PRECISION; // Default to 1.0 rate
    }

    if (circulatingLst === Uint64(0)) {
      return RATE_PRECISION; // Default to 1.0 if no LST in circulation
    }

    // rate = (totalDeposits * RATE_PRECISION) / circulatingLst
    const rate = this.mulDivFloor(totalDeposits, RATE_PRECISION, circulatingLst);

    // Sanity check: rate should never decrease significantly
    // Allow small decreases due to rounding, but flag major issues
    if (this.lastRateSnapshot.value > Uint64(0)) {
      // Rate should not decrease by more than 0.1%
      const minRate = this.mulDivFloor(this.lastRateSnapshot.value, Uint64(999), Uint64(1000));
      assert(rate >= minRate, 'Rate decreased abnormally');
    }

    return rate;
  }

  /**
   * Update the USDC yield accumulator based on rate appreciation
   * Called on every user action
   */
  private updateUsdcYieldAccumulator(): void {
    const currentRate = this.fetchCurrentRate();

    if (currentRate > this.lastRateSnapshot.value && this.lastRateSnapshot.value > Uint64(0)) {
      // Rate increased - accumulate yield
      const rateIncrease: uint64 = currentRate - this.lastRateSnapshot.value;
      this.usdcYieldPerShare.value = this.usdcYieldPerShare.value + rateIncrease;
    }

    this.lastRateSnapshot.value = currentRate;
  }

  /**
   * Update user's USDC yield based on their share of rate appreciation
   * Calculates pending yield and adds to userUnrealizedUsdc
   */
  private updateUserUsdcYield(user: Account): void {
    const shares = this.userShares(user).value;

    if (shares > Uint64(0)) {
      const currentYPS = this.usdcYieldPerShare.value;
      const userYPS = this.userUsdcYieldPerShare(user).value;

      if (currentYPS > userYPS) {
        // Calculate USDC yield: shares * rateIncrease / RATE_PRECISION
        // This converts the rate increase to actual USDC value
        const pendingUsdc = this.mulDivFloor(shares, currentYPS - userYPS, RATE_PRECISION);
        this.userUnrealizedUsdc(user).value = this.userUnrealizedUsdc(user).value + pendingUsdc;
      }
    }

    // Update snapshot to current
    this.userUsdcYieldPerShare(user).value = this.usdcYieldPerShare.value;
  }

  /**
   * Convert user's unrealized USDC yield to ASA using harvest conversion rate
   * Only converts if a harvest has happened since user's last action
   */
  private updateUserAsaYield(user: Account): void {
    const unrealizedUsdc = this.userUnrealizedUsdc(user).value;
    const harvestAsaPerUsdc = this.lastHarvestAsaPerUsdc.value;

    if (unrealizedUsdc > Uint64(0) && harvestAsaPerUsdc > Uint64(0)) {
      // Check if this yield was accumulated before the last harvest
      // (i.e., it's eligible for conversion)
      const userYPS = this.userUsdcYieldPerShare(user).value;
      const harvestYPS = this.lastHarvestYieldPerShare.value;

      if (userYPS <= harvestYPS) {
        // User's yield was from before/at last harvest - convert to ASA
        const asaFromUsdc = this.mulDivFloor(unrealizedUsdc, harvestAsaPerUsdc, ASA_SCALE);
        if (asaFromUsdc > Uint64(0)) {
          this.earnedAsa(user).value = this.earnedAsa(user).value + asaFromUsdc;
          this.userUnrealizedUsdc(user).value = Uint64(0);
        }
      }
      // If userYPS > harvestYPS, yield is from after last harvest - keep as unrealized
    }
  }

  /**
   * Calculate expected swap output from Tinyman pool
   */
  private getExpectedSwapOutput(inputAmount: uint64): uint64 {
    const poolApp = this.tinymanPoolAppId.value;

    // Read pool state
    const [asset1Id, hasAsset1Id] = AppGlobal.getExUint64(poolApp, Bytes('asset_1_id'));
    assert(hasAsset1Id, 'Cannot read pool asset_1_id');

    const [asset1Reserves, hasAsset1Reserves] = AppGlobal.getExUint64(poolApp, Bytes('asset_1_reserves'));
    assert(hasAsset1Reserves, 'Cannot read pool asset_1_reserves');

    const [asset2Reserves, hasAsset2Reserves] = AppGlobal.getExUint64(poolApp, Bytes('asset_2_reserves'));
    assert(hasAsset2Reserves, 'Cannot read pool asset_2_reserves');

    const [totalFeeShare, hasTotalFeeShare] = AppGlobal.getExUint64(poolApp, Bytes('total_fee_share'));
    assert(hasTotalFeeShare, 'Cannot read pool total_fee_share');

    // Determine input/output reserves based on asset ordering
    let inputReserves: uint64;
    let outputReserves: uint64;

    if (asset1Id === this.usdcAssetId.value) {
      inputReserves = asset1Reserves;
      outputReserves = asset2Reserves;
    } else {
      inputReserves = asset2Reserves;
      outputReserves = asset1Reserves;
    }

    // Calculate net input after fee
    const netInput = this.mulDivFloor(inputAmount, FEE_BPS_BASE - totalFeeShare, FEE_BPS_BASE);

    // AMM formula: output = (outputReserves * netInput) / (inputReserves + netInput)
    const expectedOutput = this.mulDivFloor(outputReserves, netInput, inputReserves + netInput);

    return expectedOutput;
  }

  // ============================================
  // INITIALIZATION
  // ============================================

  /**
   * Create the vault with all configuration
   */
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
  ): void {
    // Validate parameters
    assert(usdcAssetId !== Uint64(0), 'Invalid USDC asset ID');
    assert(cUsdcAssetId !== Uint64(0), 'Invalid cUSDC asset ID');
    assert(projectAsaId !== Uint64(0), 'Invalid project ASA ID');
    assert(orbitalAppId !== Uint64(0), 'Invalid Orbital app ID');
    assert(tinymanPoolAppId !== Uint64(0), 'Invalid Tinyman pool app ID');
    assert(depositFeeBps <= MAX_FEE_BPS, 'Deposit fee too high');
    assert(withdrawFeeBps <= MAX_FEE_BPS, 'Withdraw fee too high');
    assert(minHarvestThreshold >= MIN_HARVEST_THRESHOLD, 'Harvest threshold too low');

    // Ensure assets are different
    assert(usdcAssetId !== cUsdcAssetId, 'USDC and cUSDC must be different');
    assert(usdcAssetId !== projectAsaId, 'USDC and project ASA must be different');

    // Set core addresses
    this.creator.value = Txn.sender;
    this.rarefiAddress.value = rarefiAddress;

    // Set control flags
    this.isPaused.value = false;

    // Set asset IDs
    this.usdcAssetId.value = usdcAssetId;
    this.cUsdcAssetId.value = cUsdcAssetId;
    this.projectAsaId.value = projectAsaId;

    // Set external protocols
    this.orbitalAppId.value = orbitalAppId;
    this.tinymanPoolAppId.value = tinymanPoolAppId;
    this.tinymanPoolAddress.value = tinymanPoolAddress;

    // Initialize vault state
    this.totalShares.value = Uint64(0);
    this.totalPrincipal.value = Uint64(0);

    // Initialize yield tracking
    this.usdcYieldPerShare.value = Uint64(0);
    this.asaYieldPerShare.value = Uint64(0);
    this.lastRateSnapshot.value = Uint64(0); // Will be set on optInAssets

    // Initialize harvest tracking
    this.lastHarvestYieldPerShare.value = Uint64(0);
    this.lastHarvestAsaPerUsdc.value = Uint64(0);
    this.minHarvestThreshold.value = minHarvestThreshold;

    // Set fees
    this.depositFeeBps.value = depositFeeBps;
    this.withdrawFeeBps.value = withdrawFeeBps;
  }

  /**
   * Opt the contract into required assets and set initial rate
   */
  @arc4.abimethod()
  optInAssets(): void {
    assert(Txn.sender === this.creator.value, 'Only creator can opt-in assets');
    assert(!this.isPaused.value, 'Contract is paused');

    const appAddr: Account = Global.currentApplicationAddress;
    const totalMbr: uint64 = MBR_ASSET_OPTIN * Uint64(3); // 3 assets
    const totalRequired: uint64 = CREATOR_SETUP_FEE + totalMbr;

    // Verify payment
    const currentIndex = Txn.groupIndex;
    assert(currentIndex >= Uint64(1), 'App call must follow payment');

    const algoPayment = gtxn.PaymentTxn(currentIndex - Uint64(1));
    assert(algoPayment.receiver === appAddr, 'Payment must be to app');
    assert(algoPayment.amount >= totalRequired, 'Insufficient ALGO');
    assert(algoPayment.sender === Txn.sender, 'Payment must be from caller');

    // Send setup fee to RareFi
    itxn.payment({
      receiver: this.rarefiAddress.value,
      amount: CREATOR_SETUP_FEE,
      fee: Uint64(0),
    }).submit();

    // Opt-in to USDC
    itxn.assetTransfer({
      assetReceiver: appAddr,
      xferAsset: Asset(this.usdcAssetId.value),
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit();

    // Opt-in to cUSDC
    itxn.assetTransfer({
      assetReceiver: appAddr,
      xferAsset: Asset(this.cUsdcAssetId.value),
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit();

    // Opt-in to project ASA
    itxn.assetTransfer({
      assetReceiver: appAddr,
      xferAsset: Asset(this.projectAsaId.value),
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit();

    // Set initial rate snapshot from Orbital
    this.lastRateSnapshot.value = this.fetchCurrentRate();
  }

  // ============================================
  // USER OPT-IN / CLOSE-OUT
  // ============================================

  /**
   * User opts into the contract
   */
  @arc4.abimethod({ allowActions: 'OptIn' })
  optIn(): void {
    assert(!this.isPaused.value, 'Contract is paused');

    // Initialize local state at current accumulator values
    this.userShares(Txn.sender).value = Uint64(0);
    this.userUsdcYieldPerShare(Txn.sender).value = this.usdcYieldPerShare.value;
    this.userAsaYieldPerShare(Txn.sender).value = this.asaYieldPerShare.value;
    this.userUnrealizedUsdc(Txn.sender).value = Uint64(0);
    this.earnedAsa(Txn.sender).value = Uint64(0);
  }

  /**
   * User closes out - withdraws all and claims all yield
   * WARNING: Any unrealized USDC yield (not yet harvested) will be lost
   */
  @arc4.abimethod({ allowActions: 'CloseOut' })
  closeOut(): void {
    // Update accumulators
    this.updateUsdcYieldAccumulator();
    this.updateUserUsdcYield(Txn.sender);
    this.updateUserAsaYield(Txn.sender);

    const userShareBalance = this.userShares(Txn.sender).value;
    const userAsaYield = this.earnedAsa(Txn.sender).value;

    // If user has shares, redeem them from Orbital and return USDC
    if (userShareBalance > Uint64(0)) {
      const appAddr: Account = Global.currentApplicationAddress;
      const currentRate = this.lastRateSnapshot.value;

      // Get actual cUSDC balance - may be less than userShares if harvest occurred
      const vaultCusdcBalance = Asset(this.cUsdcAssetId.value).balance(appAddr);

      // User's actual redeemable shares is proportional to their ownership
      // sharesToRedeem = min(userShares, vaultCusdcBalance)
      // This handles the case where harvest reduced the total cUSDC
      const sharesToRedeem = userShareBalance <= vaultCusdcBalance
        ? userShareBalance
        : vaultCusdcBalance;

      // Calculate USDC to return based on shares being redeemed
      let usdcToReturn = this.mulDivFloor(sharesToRedeem, currentRate, RATE_PRECISION);

      // Deduct withdrawal fee
      if (this.withdrawFeeBps.value > Uint64(0)) {
        const fee = this.mulDivFloor(usdcToReturn, this.withdrawFeeBps.value, FEE_BPS_BASE);
        usdcToReturn = usdcToReturn - fee;
      }

      // Update totals (cap at 0 to prevent underflow)
      this.totalShares.value = this.totalShares.value >= sharesToRedeem
        ? this.totalShares.value - sharesToRedeem
        : Uint64(0);
      this.totalPrincipal.value = this.totalPrincipal.value >= usdcToReturn
        ? this.totalPrincipal.value - usdcToReturn
        : Uint64(0);

      // Only redeem if we have shares to redeem
      if (sharesToRedeem > Uint64(0)) {
        // Redeem from Orbital: send cUSDC, receive USDC
        itxn.submitGroup(
          itxn.assetTransfer({
            assetReceiver: Application(this.orbitalAppId.value).address,
            xferAsset: Asset(this.cUsdcAssetId.value),
            assetAmount: sharesToRedeem,
            fee: Uint64(0),
          }),
          itxn.applicationCall({
            appId: Application(this.orbitalAppId.value),
            appArgs: [Bytes('redeem'), itob(sharesToRedeem)],
            assets: [Asset(this.usdcAssetId.value), Asset(this.cUsdcAssetId.value)],
            fee: Uint64(0),
          }),
        );

        // Send USDC to user
        if (usdcToReturn > Uint64(0)) {
          itxn.assetTransfer({
            assetReceiver: Txn.sender,
            xferAsset: Asset(this.usdcAssetId.value),
            assetAmount: usdcToReturn,
            fee: Uint64(0),
          }).submit();
        }
      }
    }

    // Send any earned ASA yield
    if (userAsaYield > Uint64(0)) {
      itxn.assetTransfer({
        assetReceiver: Txn.sender,
        xferAsset: Asset(this.projectAsaId.value),
        assetAmount: userAsaYield,
        fee: Uint64(0),
      }).submit();
    }

    // Note: userUnrealizedUsdc is lost if not yet harvested
    // UI should warn users about this
  }

  // ============================================
  // DEPOSIT / WITHDRAW
  // ============================================

  /**
   * User deposits USDC into the vault
   * USDC is forwarded to Orbital Lending for yield generation
   */
  @arc4.abimethod()
  deposit(): void {
    assert(!this.isPaused.value, 'Contract is paused');

    const appAddr: Account = Global.currentApplicationAddress;
    const currentIndex = Txn.groupIndex;
    assert(currentIndex >= Uint64(1), 'App call must follow asset transfer');

    // Validate USDC transfer
    const depositTransfer = gtxn.AssetTransferTxn(currentIndex - Uint64(1));
    assert(depositTransfer.xferAsset === Asset(this.usdcAssetId.value), 'Must transfer USDC');
    assert(depositTransfer.assetReceiver === appAddr, 'Must send to contract');
    assert(depositTransfer.sender === Txn.sender, 'Transfer must be from caller');

    let amount = depositTransfer.assetAmount;
    assert(amount >= MIN_DEPOSIT_AMOUNT, 'Deposit too small');

    // Update yield accumulators
    this.updateUsdcYieldAccumulator();
    this.updateUserUsdcYield(Txn.sender);
    this.updateUserAsaYield(Txn.sender);

    // Deduct deposit fee
    if (this.depositFeeBps.value > Uint64(0)) {
      const fee = this.mulDivFloor(amount, this.depositFeeBps.value, FEE_BPS_BASE);
      amount = amount - fee;
      // Fee stays in contract (goes to creator on next harvest or can be claimed)
    }

    // Record cUSDC balance before deposit
    const cUsdcBefore = Asset(this.cUsdcAssetId.value).balance(appAddr);

    // Deposit USDC to Orbital: send USDC, receive cUSDC
    itxn.submitGroup(
      itxn.assetTransfer({
        assetReceiver: Application(this.orbitalAppId.value).address,
        xferAsset: Asset(this.usdcAssetId.value),
        assetAmount: amount,
        fee: Uint64(0),
      }),
      itxn.applicationCall({
        appId: Application(this.orbitalAppId.value),
        appArgs: [Bytes('deposit')],
        assets: [Asset(this.usdcAssetId.value), Asset(this.cUsdcAssetId.value)],
        fee: Uint64(0),
      }),
    );

    // Calculate cUSDC received
    const cUsdcAfter = Asset(this.cUsdcAssetId.value).balance(appAddr);
    const cUsdcReceived: uint64 = cUsdcAfter - cUsdcBefore;

    assert(cUsdcReceived > Uint64(0), 'No cUSDC received from Orbital');

    // Update user and vault state
    this.userShares(Txn.sender).value = this.userShares(Txn.sender).value + cUsdcReceived;
    this.totalShares.value = this.totalShares.value + cUsdcReceived;
    this.totalPrincipal.value = this.totalPrincipal.value + amount;
  }

  /**
   * User withdraws USDC from the vault
   * cUSDC is redeemed from Orbital at current rate
   */
  @arc4.abimethod()
  withdraw(amount: uint64): void {
    assert(!this.isPaused.value, 'Contract is paused');

    // Update yield accumulators
    this.updateUsdcYieldAccumulator();
    this.updateUserUsdcYield(Txn.sender);
    this.updateUserAsaYield(Txn.sender);

    const userShareBalance = this.userShares(Txn.sender).value;
    const currentRate = this.lastRateSnapshot.value;

    // Calculate user's total USDC value: shares * rate / RATE_PRECISION
    const userUsdcValue = this.mulDivFloor(userShareBalance, currentRate, RATE_PRECISION);

    let withdrawAmount = amount;
    if (withdrawAmount === Uint64(0)) {
      withdrawAmount = userUsdcValue; // Withdraw all
    }

    assert(withdrawAmount > Uint64(0), 'Nothing to withdraw');
    assert(withdrawAmount <= userUsdcValue, 'Insufficient balance');

    // Calculate cUSDC to redeem: withdrawAmount * RATE_PRECISION / rate
    const cUsdcToRedeem = this.mulDivCeil(withdrawAmount, RATE_PRECISION, currentRate);
    assert(cUsdcToRedeem <= userShareBalance, 'Share calculation error');

    const appAddr: Account = Global.currentApplicationAddress;

    // Record USDC balance before redemption
    const usdcBefore = Asset(this.usdcAssetId.value).balance(appAddr);

    // Redeem from Orbital: send cUSDC, receive USDC
    itxn.submitGroup(
      itxn.assetTransfer({
        assetReceiver: Application(this.orbitalAppId.value).address,
        xferAsset: Asset(this.cUsdcAssetId.value),
        assetAmount: cUsdcToRedeem,
        fee: Uint64(0),
      }),
      itxn.applicationCall({
        appId: Application(this.orbitalAppId.value),
        appArgs: [Bytes('redeem'), itob(cUsdcToRedeem)],
        assets: [Asset(this.usdcAssetId.value), Asset(this.cUsdcAssetId.value)],
        fee: Uint64(0),
      }),
    );

    // Calculate USDC received
    const usdcAfter = Asset(this.usdcAssetId.value).balance(appAddr);
    let usdcReceived: uint64 = usdcAfter - usdcBefore;

    // Deduct withdrawal fee
    if (this.withdrawFeeBps.value > Uint64(0)) {
      const fee = this.mulDivFloor(usdcReceived, this.withdrawFeeBps.value, FEE_BPS_BASE);
      usdcReceived = usdcReceived - fee;
    }

    // Update user and vault state
    this.userShares(Txn.sender).value = userShareBalance - cUsdcToRedeem;
    this.totalShares.value = this.totalShares.value - cUsdcToRedeem;

    // Update principal (cap at 0 to handle rounding)
    if (this.totalPrincipal.value > withdrawAmount) {
      this.totalPrincipal.value = this.totalPrincipal.value - withdrawAmount;
    } else {
      this.totalPrincipal.value = Uint64(0);
    }

    // Send USDC to user
    itxn.assetTransfer({
      assetReceiver: Txn.sender,
      xferAsset: Asset(this.usdcAssetId.value),
      assetAmount: usdcReceived,
      fee: Uint64(0),
    }).submit();
  }

  // ============================================
  // YIELD CLAIMING
  // ============================================

  /**
   * User claims their accumulated ASA yield
   */
  @arc4.abimethod()
  claimYield(): void {
    assert(!this.isPaused.value, 'Contract is paused');

    // Update yield accumulators
    this.updateUsdcYieldAccumulator();
    this.updateUserUsdcYield(Txn.sender);
    this.updateUserAsaYield(Txn.sender);

    const claimable = this.earnedAsa(Txn.sender).value;
    assert(claimable > Uint64(0), 'Nothing to claim');

    // Reset earned yield
    this.earnedAsa(Txn.sender).value = Uint64(0);

    // Send ASA to user
    itxn.assetTransfer({
      assetReceiver: Txn.sender,
      xferAsset: Asset(this.projectAsaId.value),
      assetAmount: claimable,
      fee: Uint64(0),
    }).submit();
  }

  // ============================================
  // HARVEST (Admin Only)
  // ============================================

  /**
   * Harvest accumulated yield and swap to project ASA
   * Only callable by creator or RareFi
   */
  @arc4.abimethod()
  harvestAndSwap(slippageBps: uint64): void {
    const isCreator = Txn.sender === this.creator.value;
    const isRarefi = Txn.sender === this.rarefiAddress.value;
    assert(isCreator || isRarefi, 'Only creator or RareFi can harvest');
    assert(!this.isPaused.value, 'Contract is paused');
    assert(slippageBps <= MAX_SLIPPAGE_BPS, 'Slippage too high');

    // Update rate accumulator
    this.updateUsdcYieldAccumulator();

    const appAddr: Account = Global.currentApplicationAddress;
    const currentRate = this.lastRateSnapshot.value;
    const cUsdcBalance = Asset(this.cUsdcAssetId.value).balance(appAddr);

    // Calculate total vault value in USDC
    const currentValueUsdc = this.mulDivFloor(cUsdcBalance, currentRate, RATE_PRECISION);

    // Calculate unrealized yield (value above principal)
    assert(currentValueUsdc >= this.totalPrincipal.value, 'No yield to harvest');
    const totalUnrealizedUsdc: uint64 = currentValueUsdc - this.totalPrincipal.value;

    assert(totalUnrealizedUsdc >= this.minHarvestThreshold.value, 'Below minimum harvest threshold');
    assert(this.totalShares.value > Uint64(0), 'No depositors');

    // Calculate cUSDC to redeem for this yield
    const cUsdcToRedeem = this.mulDivCeil(totalUnrealizedUsdc, RATE_PRECISION, currentRate);

    // Record USDC balance before redemption
    const usdcBefore = Asset(this.usdcAssetId.value).balance(appAddr);

    // Redeem yield portion from Orbital
    itxn.submitGroup(
      itxn.assetTransfer({
        assetReceiver: Application(this.orbitalAppId.value).address,
        xferAsset: Asset(this.cUsdcAssetId.value),
        assetAmount: cUsdcToRedeem,
        fee: Uint64(0),
      }),
      itxn.applicationCall({
        appId: Application(this.orbitalAppId.value),
        appArgs: [Bytes('redeem'), itob(cUsdcToRedeem)],
        assets: [Asset(this.usdcAssetId.value), Asset(this.cUsdcAssetId.value)],
        fee: Uint64(0),
      }),
    );

    // Calculate actual USDC received
    const usdcAfter = Asset(this.usdcAssetId.value).balance(appAddr);
    const usdcYield: uint64 = usdcAfter - usdcBefore;

    // Update shares (we redeemed some cUSDC)
    this.totalShares.value = this.totalShares.value - cUsdcToRedeem;

    // Calculate expected swap output
    const expectedOutput = this.getExpectedSwapOutput(usdcYield);
    assert(expectedOutput > Uint64(0), 'Expected swap output is zero');

    // Apply slippage tolerance
    const minAmountOut = this.mulDivFloor(expectedOutput, FEE_BPS_BASE - slippageBps, FEE_BPS_BASE);

    // Record ASA balance before swap
    const asaBefore = Asset(this.projectAsaId.value).balance(appAddr);

    // Swap USDC to project ASA via Tinyman
    itxn.submitGroup(
      itxn.assetTransfer({
        assetReceiver: this.tinymanPoolAddress.value,
        xferAsset: Asset(this.usdcAssetId.value),
        assetAmount: usdcYield,
        fee: Uint64(0),
      }),
      itxn.applicationCall({
        appId: Application(this.tinymanPoolAppId.value),
        appArgs: [Bytes('swap'), Bytes('fixed-input'), itob(minAmountOut)],
        assets: [Asset(this.projectAsaId.value)],
        accounts: [this.tinymanPoolAddress.value],
        fee: Uint64(0),
      }),
    );

    // Calculate actual ASA received
    const asaAfter = Asset(this.projectAsaId.value).balance(appAddr);
    const asaReceived: uint64 = asaAfter - asaBefore;

    assert(asaReceived >= minAmountOut, 'Swap output below minimum');

    // Calculate and store conversion rate: asaPerUsdc = (asaReceived * ASA_SCALE) / usdcYield
    const asaPerUsdc = this.mulDivFloor(asaReceived, ASA_SCALE, usdcYield);

    // Update harvest tracking
    this.lastHarvestAsaPerUsdc.value = asaPerUsdc;
    this.lastHarvestYieldPerShare.value = this.usdcYieldPerShare.value;
  }

  // ============================================
  // READ-ONLY METHODS
  // ============================================

  /**
   * Get vault statistics
   */
  @arc4.abimethod({ readonly: true })
  getVaultStats(): [uint64, uint64, uint64, uint64, uint64] {
    const appAddr: Account = Global.currentApplicationAddress;
    const cUsdcBalance = Asset(this.cUsdcAssetId.value).balance(appAddr);
    const asaBalance = Asset(this.projectAsaId.value).balance(appAddr);

    // Note: For actual rate, caller should read from Orbital directly
    // This returns cached rate
    return [
      this.totalShares.value,
      this.totalPrincipal.value,
      this.lastRateSnapshot.value,
      cUsdcBalance,
      asaBalance
    ];
  }

  /**
   * Get user's position details
   */
  @arc4.abimethod({ readonly: true })
  getUserPosition(user: Account): [uint64, uint64, uint64, uint64] {
    const shares = this.userShares(user).value;
    const rate = this.lastRateSnapshot.value;

    // Calculate principal value: shares * rate / RATE_PRECISION
    const principalValue = rate > Uint64(0)
      ? this.mulDivFloor(shares, rate, RATE_PRECISION)
      : shares;

    // Calculate unrealized USDC yield (pending)
    let unrealizedUsdc = this.userUnrealizedUsdc(user).value;
    if (shares > Uint64(0)) {
      const currentYPS = this.usdcYieldPerShare.value;
      const userYPS = this.userUsdcYieldPerShare(user).value;
      if (currentYPS > userYPS) {
        unrealizedUsdc = unrealizedUsdc + this.mulDivFloor(shares, currentYPS - userYPS, RATE_PRECISION);
      }
    }

    return [
      shares,
      principalValue,
      unrealizedUsdc,
      this.earnedAsa(user).value
    ];
  }

  /**
   * Get user's pending yield details
   */
  @arc4.abimethod({ readonly: true })
  getPendingYield(user: Account): [uint64, uint64] {
    const shares = this.userShares(user).value;

    // Calculate unrealized USDC yield
    let unrealizedUsdc = this.userUnrealizedUsdc(user).value;
    if (shares > Uint64(0)) {
      const currentYPS = this.usdcYieldPerShare.value;
      const userYPS = this.userUsdcYieldPerShare(user).value;
      if (currentYPS > userYPS) {
        unrealizedUsdc = unrealizedUsdc + this.mulDivFloor(shares, currentYPS - userYPS, RATE_PRECISION);
      }
    }

    return [unrealizedUsdc, this.earnedAsa(user).value];
  }

  // ============================================
  // ADMIN METHODS
  // ============================================

  /**
   * Emergency pause/unpause
   */
  @arc4.abimethod()
  setPaused(paused: boolean): void {
    assert(Txn.sender === this.creator.value, 'Only creator can pause');
    this.isPaused.value = paused;
  }

  /**
   * Update minimum harvest threshold
   */
  @arc4.abimethod()
  updateMinHarvestThreshold(threshold: uint64): void {
    const isCreator = Txn.sender === this.creator.value;
    const isRarefi = Txn.sender === this.rarefiAddress.value;
    assert(isCreator || isRarefi, 'Only creator or RareFi can update');
    assert(threshold >= MIN_HARVEST_THRESHOLD, 'Threshold too low');
    this.minHarvestThreshold.value = threshold;
  }

  /**
   * Update Tinyman pool configuration
   */
  @arc4.abimethod()
  updateTinymanPool(poolAppId: uint64, poolAddress: Account): void {
    const isCreator = Txn.sender === this.creator.value;
    const isRarefi = Txn.sender === this.rarefiAddress.value;
    assert(isCreator || isRarefi, 'Only creator or RareFi can update');
    assert(poolAppId !== Uint64(0), 'Invalid pool app ID');
    this.tinymanPoolAppId.value = poolAppId;
    this.tinymanPoolAddress.value = poolAddress;
  }

  // ============================================
  // SECURITY: Prevent upgrades and deletion
  // ============================================

  @baremethod({ allowActions: 'UpdateApplication' })
  updateApplication(): void {
    assert(false, 'Contract updates disabled');
  }

  @baremethod({ allowActions: 'DeleteApplication' })
  deleteApplication(): void {
    assert(false, 'Contract deletion disabled');
  }
}
