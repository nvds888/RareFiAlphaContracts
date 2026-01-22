// RareFiAlphaCompoundingVault.algo.ts - Auto-compounding yield vault
// Users deposit Alpha and earn yield in USDC which is auto-swapped back to Alpha
// Uses share-based accounting: yield compounds automatically into deposits
// When users withdraw, they receive original deposit + accumulated yield

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

// Constants
const SCALE: uint64 = Uint64(1_000_000_000_000);      // 1e12 for share price display precision
const MAX_FEE_RATE: uint64 = Uint64(100);              // 100% max fee (basis is 100)
const MIN_DEPOSIT_AMOUNT: uint64 = Uint64(1_000_000);  // Minimum deposit (1 token with 6 decimals)
const MIN_SWAP_AMOUNT: uint64 = Uint64(200_000);       // Minimum swap amount (0.20 USDC)
const FEE_BPS_BASE: uint64 = Uint64(10_000);           // Basis points denominator (10000 = 100%)
const MAX_SLIPPAGE_BPS: uint64 = Uint64(1000);         // Max 10% slippage allowed
const CREATOR_SETUP_FEE: uint64 = Uint64(200_000_000); // 200 ALGO setup fee (in microALGO)
const MBR_ASSET_OPTIN: uint64 = Uint64(100_000);       // 0.1 ALGO MBR per asset opt-in

export class RareFiAlphaCompoundingVault extends arc4.Contract {
  // ============================================
  // GLOBAL STATE
  // ============================================

  // Asset IDs (only 2 assets needed for auto-compounding)
  alphaAsset = GlobalState<uint64>();       // Alpha ASA ID (deposit & yield asset)
  usdcAsset = GlobalState<uint64>();        // USDC ASA ID (airdrops come in as this)

  // Creator/Fee settings
  creatorAddress = GlobalState<Account>();   // Vault creator who receives fee
  rarefiAddress = GlobalState<Account>();    // RareFi platform address (can also trigger swaps)
  creatorFeeRate = GlobalState<uint64>();    // 0-100, percentage of yield to creator
  creatorUnclaimedAlpha = GlobalState<uint64>(); // Accumulated Alpha for creator to claim

  // Vault state - Share-based accounting
  totalShares = GlobalState<uint64>();       // Total shares issued to all depositors
  totalAlpha = GlobalState<uint64>();        // Total Alpha held (deposits + compounded yield)
  minSwapThreshold = GlobalState<uint64>();  // Minimum USDC before swap allowed
  totalYieldCompounded = GlobalState<uint64>(); // Total yield compounded (for stats)

  // Tinyman V2 integration (USDC/Alpha pool)
  tinymanPoolAppId = GlobalState<uint64>();  // Tinyman V2 pool app ID
  tinymanPoolAddress = GlobalState<Account>(); // Tinyman pool address

  // ============================================
  // LOCAL STATE (per user)
  // ============================================

  userShares = LocalState<uint64>();         // User's share balance (represents proportional ownership)

  // ============================================
  // HELPER FUNCTIONS
  // ============================================

  /**
   * Safe multiplication and division to prevent overflow
   * Returns floor(n1 * n2 / d)
   */
  private mulDivFloor(n1: uint64, n2: uint64, d: uint64): uint64 {
    const [hi, lo] = mulw(n1, n2);
    const [q_hi, q_lo, _r_hi, _r_lo] = divmodw(hi, lo, Uint64(0), d);
    assert(q_hi === Uint64(0), 'Multiplication overflow in mulDivFloor');
    return q_lo;
  }

  /**
   * Convert Alpha amount to shares
   * shares = (alphaAmount * totalShares) / totalAlpha
   * If first deposit, 1:1 ratio (no scaling needed)
   */
  private alphaToShares(alphaAmount: uint64): uint64 {
    if (this.totalShares.value === Uint64(0)) {
      // First depositor: 1:1 shares, no multiplication needed
      return alphaAmount;
    }
    return this.mulDivFloor(alphaAmount, this.totalShares.value, this.totalAlpha.value);
  }

  /**
   * Convert shares to Alpha amount
   * alphaAmount = (shares * totalAlpha) / totalShares
   */
  private sharesToAlpha(shares: uint64): uint64 {
    if (this.totalShares.value === Uint64(0)) {
      return Uint64(0);
    }
    return this.mulDivFloor(shares, this.totalAlpha.value, this.totalShares.value);
  }

  /**
   * Calculate expected swap output by reading Tinyman V2 pool state
   * Pool is USDC/Alpha
   */
  private getExpectedSwapOutput(inputAmount: uint64): uint64 {
    const poolApp = this.tinymanPoolAppId.value;
    const poolAddr = this.tinymanPoolAddress.value;

    // Read pool state from local state of pool address
    const [asset1Id, hasAsset1Id] = AppLocal.getExUint64(poolAddr, poolApp, Bytes('asset_1_id'));
    assert(hasAsset1Id, 'Cannot read pool asset_1_id');

    const [asset1Reserves, hasAsset1Reserves] = AppLocal.getExUint64(poolAddr, poolApp, Bytes('asset_1_reserves'));
    assert(hasAsset1Reserves, 'Cannot read pool asset_1_reserves');

    const [asset2Reserves, hasAsset2Reserves] = AppLocal.getExUint64(poolAddr, poolApp, Bytes('asset_2_reserves'));
    assert(hasAsset2Reserves, 'Cannot read pool asset_2_reserves');

    const [totalFeeShare, hasTotalFeeShare] = AppLocal.getExUint64(poolAddr, poolApp, Bytes('total_fee_share'));
    assert(hasTotalFeeShare, 'Cannot read pool total_fee_share');

    // Determine which asset is input (USDC) and which is output (Alpha)
    let inputReserves: uint64;
    let outputReserves: uint64;

    if (asset1Id === this.usdcAsset.value) {
      // USDC is asset_1, Alpha is asset_2
      inputReserves = asset1Reserves;
      outputReserves = asset2Reserves;
    } else {
      // Alpha is asset_1, USDC is asset_2
      inputReserves = asset2Reserves;
      outputReserves = asset1Reserves;
    }

    // Calculate net input after Tinyman fee
    const feeBps = totalFeeShare;
    const netInput = this.mulDivFloor(inputAmount, FEE_BPS_BASE - feeBps, FEE_BPS_BASE);

    // Apply constant product AMM formula
    const expectedOutput = this.mulDivFloor(outputReserves, netInput, inputReserves + netInput);

    return expectedOutput;
  }

  // ============================================
  // INITIALIZATION
  // ============================================

  /**
   * Create and initialize the vault
   * Called once at deployment
   */
  @arc4.abimethod({ onCreate: 'require' })
  createVault(
    alphaAssetId: uint64,
    usdcAssetId: uint64,
    creatorFeeRate: uint64,
    minSwapThreshold: uint64,
    tinymanPoolAppId: uint64,
    tinymanPoolAddress: Account,
    rarefiAddress: Account
  ): void {
    // Validate parameters
    assert(creatorFeeRate <= MAX_FEE_RATE, 'Creator fee rate exceeds maximum (100%)');
    assert(minSwapThreshold >= MIN_SWAP_AMOUNT, 'Swap threshold too low');
    assert(alphaAssetId !== Uint64(0), 'Invalid Alpha asset');
    assert(usdcAssetId !== Uint64(0), 'Invalid USDC asset');
    assert(alphaAssetId !== usdcAssetId, 'Alpha and USDC must be different');
    assert(tinymanPoolAppId !== Uint64(0), 'Invalid Tinyman pool app ID');

    // Set asset IDs
    this.alphaAsset.value = alphaAssetId;
    this.usdcAsset.value = usdcAssetId;

    // Set creator/fee settings
    this.creatorAddress.value = Txn.sender;
    this.rarefiAddress.value = rarefiAddress;
    this.creatorFeeRate.value = creatorFeeRate;
    this.creatorUnclaimedAlpha.value = Uint64(0);

    // Initialize vault state
    this.totalShares.value = Uint64(0);
    this.totalAlpha.value = Uint64(0);
    this.minSwapThreshold.value = minSwapThreshold;
    this.totalYieldCompounded.value = Uint64(0);

    // Tinyman integration
    this.tinymanPoolAppId.value = tinymanPoolAppId;
    this.tinymanPoolAddress.value = tinymanPoolAddress;
  }

  /**
   * Opt the contract into required assets
   * Must be called by creator after deployment with:
   * - 200 ALGO setup fee (sent to RareFi)
   * - 0.2 ALGO MBR for asset opt-ins (stays in contract)
   * Total required: 200.2 ALGO
   */
  @arc4.abimethod()
  optInAssets(): void {
    assert(Txn.sender === this.creatorAddress.value, 'Only creator can opt-in assets');

    const appAddr: Account = Global.currentApplicationAddress;
    const totalMbr: uint64 = MBR_ASSET_OPTIN * Uint64(2); // 0.2 ALGO for 2 assets
    const totalRequired: uint64 = CREATOR_SETUP_FEE + totalMbr; // 200.2 ALGO

    // Verify payment covers setup fee + MBR
    const currentIndex = Txn.groupIndex;
    assert(currentIndex >= Uint64(1), 'App call must follow payment');

    const algoPayment = gtxn.PaymentTxn(currentIndex - Uint64(1));
    assert(algoPayment.receiver === appAddr, 'Payment must be to app');
    assert(algoPayment.amount >= totalRequired, 'Insufficient ALGO (need 200.2 ALGO: 200 setup fee + 0.2 MBR)');
    assert(algoPayment.sender === Txn.sender, 'Payment must be from caller');

    // Send setup fee to RareFi platform
    itxn.payment({
      receiver: this.rarefiAddress.value,
      amount: CREATOR_SETUP_FEE,
      fee: Uint64(0),
    }).submit();

    // Opt-in to Alpha asset
    itxn.assetTransfer({
      assetReceiver: appAddr,
      xferAsset: Asset(this.alphaAsset.value),
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit();

    // Opt-in to USDC asset
    itxn.assetTransfer({
      assetReceiver: appAddr,
      xferAsset: Asset(this.usdcAsset.value),
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit();
  }

  // ============================================
  // USER OPT-IN
  // ============================================

  /**
   * User opts into the contract to enable local storage
   */
  @arc4.abimethod({ allowActions: 'OptIn' })
  optIn(): void {
    // Initialize local state for user
    this.userShares(Txn.sender).value = Uint64(0);
  }

  /**
   * User closes out - withdraws all Alpha (deposit + yield)
   */
  @arc4.abimethod({ allowActions: 'CloseOut' })
  closeOut(): void {
    const shares = this.userShares(Txn.sender).value;

    if (shares > Uint64(0)) {
      // Calculate Alpha amount for user's shares
      const alphaAmount = this.sharesToAlpha(shares);

      // Update global state
      this.totalShares.value = this.totalShares.value - shares;
      this.totalAlpha.value = this.totalAlpha.value - alphaAmount;

      // Transfer Alpha to user
      itxn.assetTransfer({
        assetReceiver: Txn.sender,
        xferAsset: Asset(this.alphaAsset.value),
        assetAmount: alphaAmount,
        fee: Uint64(0),
      }).submit();
    }
  }

  // ============================================
  // DEPOSIT / WITHDRAW
  // ============================================

  /**
   * User deposits Alpha into the vault
   * Receives shares proportional to their deposit
   *
   * NOTE: Deposits are paused when USDC balance >= minSwapThreshold to prevent
   * flash deposit attacks where users deposit right before yield is compounded.
   */
  @arc4.abimethod()
  deposit(): void {
    const appAddr: Account = Global.currentApplicationAddress;

    // Check if deposits are paused due to pending yield
    const usdcBalance = Asset(this.usdcAsset.value).balance(appAddr);
    assert(usdcBalance < this.minSwapThreshold.value, 'Deposits paused: yield pending compound');

    const currentIndex = Txn.groupIndex;
    assert(currentIndex >= Uint64(1), 'App call must follow asset transfer');

    // Validate the deposit transfer
    const depositTransfer = gtxn.AssetTransferTxn(currentIndex - Uint64(1));
    assert(depositTransfer.xferAsset === Asset(this.alphaAsset.value), 'Must transfer Alpha asset');
    assert(depositTransfer.assetReceiver === appAddr, 'Must send to contract');
    assert(depositTransfer.sender === Txn.sender, 'Transfer must be from caller');

    const amount = depositTransfer.assetAmount;
    assert(amount >= MIN_DEPOSIT_AMOUNT, 'Deposit too small');

    // Calculate shares to mint
    const sharesToMint = this.alphaToShares(amount);
    assert(sharesToMint > Uint64(0), 'Shares to mint is zero');

    // Update state
    this.userShares(Txn.sender).value = this.userShares(Txn.sender).value + sharesToMint;
    this.totalShares.value = this.totalShares.value + sharesToMint;
    this.totalAlpha.value = this.totalAlpha.value + amount;
  }

  /**
   * User withdraws Alpha from the vault
   * Receives proportional share of vault's Alpha (original deposit + compounded yield)
   * @param shareAmount - Shares to redeem (0 = withdraw all)
   */
  @arc4.abimethod()
  withdraw(shareAmount: uint64): void {
    const userShareBalance = this.userShares(Txn.sender).value;
    let sharesToRedeem = shareAmount;

    // If amount is 0, withdraw all
    if (sharesToRedeem === Uint64(0)) {
      sharesToRedeem = userShareBalance;
    }

    assert(sharesToRedeem > Uint64(0), 'Nothing to withdraw');
    assert(sharesToRedeem <= userShareBalance, 'Insufficient shares');

    // Calculate Alpha amount for shares
    const alphaAmount = this.sharesToAlpha(sharesToRedeem);
    assert(alphaAmount > Uint64(0), 'Alpha amount is zero');

    // Update state
    this.userShares(Txn.sender).value = userShareBalance - sharesToRedeem;
    this.totalShares.value = this.totalShares.value - sharesToRedeem;
    this.totalAlpha.value = this.totalAlpha.value - alphaAmount;

    // Transfer Alpha to user
    itxn.assetTransfer({
      assetReceiver: Txn.sender,
      xferAsset: Asset(this.alphaAsset.value),
      assetAmount: alphaAmount,
      fee: Uint64(0),
    }).submit();
  }

  // ============================================
  // CREATOR YIELD CLAIM
  // ============================================

  /**
   * Creator claims their accumulated Alpha from fees
   */
  @arc4.abimethod()
  claimCreator(): void {
    assert(Txn.sender === this.creatorAddress.value, 'Only creator can claim');

    const claimable = this.creatorUnclaimedAlpha.value;
    assert(claimable > Uint64(0), 'Nothing to claim');

    // Reset creator unclaimed
    this.creatorUnclaimedAlpha.value = Uint64(0);

    // Transfer Alpha to creator
    itxn.assetTransfer({
      assetReceiver: Txn.sender,
      xferAsset: Asset(this.alphaAsset.value),
      assetAmount: claimable,
      fee: Uint64(0),
    }).submit();
  }

  // ============================================
  // AUTO-COMPOUND (Tinyman V2 Integration)
  // ============================================

  /**
   * Swaps accumulated USDC to Alpha and compounds into vault
   * The Alpha is added to totalAlpha, increasing the value of all shares
   * Only callable by creator or RareFi platform to prevent sandwich attacks
   *
   * @param slippageBps - Slippage tolerance in basis points (e.g., 50 = 0.5%, 100 = 1%)
   */
  @arc4.abimethod()
  compoundYield(slippageBps: uint64): void {
    const isCreator = Txn.sender === this.creatorAddress.value;
    const isRarefi = Txn.sender === this.rarefiAddress.value;
    assert(isCreator || isRarefi, 'Only creator or RareFi can compound');
    assert(slippageBps <= MAX_SLIPPAGE_BPS, 'Slippage too high (max 10%)');

    const appAddr: Account = Global.currentApplicationAddress;
    const usdcBalance = Asset(this.usdcAsset.value).balance(appAddr);

    assert(usdcBalance >= this.minSwapThreshold.value, 'Below minimum swap threshold');
    assert(this.totalShares.value > Uint64(0), 'No depositors to compound for');

    // Calculate expected output ON-CHAIN by reading pool state
    const expectedOutput = this.getExpectedSwapOutput(usdcBalance);
    assert(expectedOutput > Uint64(0), 'Expected output is zero');

    // Apply slippage tolerance
    const minAmountOut = this.mulDivFloor(expectedOutput, FEE_BPS_BASE - slippageBps, FEE_BPS_BASE);

    // Record Alpha balance before swap
    const alphaBefore = Asset(this.alphaAsset.value).balance(appAddr);

    // Execute Tinyman V2 swap: USDC -> Alpha
    itxn.submitGroup(
      // Transaction 1: Send USDC to pool
      itxn.assetTransfer({
        assetReceiver: this.tinymanPoolAddress.value,
        xferAsset: Asset(this.usdcAsset.value),
        assetAmount: usdcBalance,
        fee: Uint64(0),
      }),
      // Transaction 2: Call Tinyman pool to execute swap
      itxn.applicationCall({
        appId: Application(this.tinymanPoolAppId.value),
        appArgs: [
          Bytes('swap'),
          Bytes('fixed-input'),
          itob(minAmountOut),
        ],
        assets: [Asset(this.alphaAsset.value)],  // Output asset
        accounts: [this.tinymanPoolAddress.value],
        fee: Uint64(0),
      }),
    );

    // Calculate actual swap output
    const alphaAfter: uint64 = Asset(this.alphaAsset.value).balance(appAddr);
    const swapOutput: uint64 = alphaAfter - alphaBefore;

    assert(swapOutput >= minAmountOut, 'Swap output below minimum');

    // Split yield between creator and vault
    const creatorCut: uint64 = this.mulDivFloor(swapOutput, this.creatorFeeRate.value, MAX_FEE_RATE);
    const vaultCut: uint64 = swapOutput - creatorCut;

    // Add creator's cut to their claimable balance
    this.creatorUnclaimedAlpha.value = this.creatorUnclaimedAlpha.value + creatorCut;

    // Add vault's cut to totalAlpha (this increases share value for all depositors)
    // This is the auto-compounding magic: totalShares stays the same, totalAlpha increases
    this.totalAlpha.value = this.totalAlpha.value + vaultCut;

    // Track total yield compounded for stats
    this.totalYieldCompounded.value = this.totalYieldCompounded.value + swapOutput;
  }

  // ============================================
  // READ-ONLY METHODS
  // ============================================

  /**
   * Get vault statistics
   * @returns [totalShares, totalAlpha, creatorUnclaimedAlpha, usdcBalance, totalYieldCompounded, sharePrice]
   * Note: sharePrice is scaled by SCALE (1e12) for precision
   */
  @arc4.abimethod({ readonly: true })
  getVaultStats(): [uint64, uint64, uint64, uint64, uint64, uint64] {
    const appAddr: Account = Global.currentApplicationAddress;
    const usdcBalance = Asset(this.usdcAsset.value).balance(appAddr);

    // Calculate share price (how much Alpha per share, scaled)
    let sharePrice: uint64 = SCALE; // Default 1:1 if no shares
    if (this.totalShares.value > Uint64(0)) {
      sharePrice = this.mulDivFloor(this.totalAlpha.value, SCALE, this.totalShares.value);
    }

    return [
      this.totalShares.value,
      this.totalAlpha.value,
      this.creatorUnclaimedAlpha.value,
      usdcBalance,
      this.totalYieldCompounded.value,
      sharePrice
    ];
  }

  /**
   * Get user's current Alpha balance (shares converted to Alpha)
   * This includes their original deposit + all compounded yield
   */
  @arc4.abimethod({ readonly: true })
  getUserAlphaBalance(user: Account): uint64 {
    const shares = this.userShares(user).value;
    return this.sharesToAlpha(shares);
  }

  /**
   * Get user's share balance
   */
  @arc4.abimethod({ readonly: true })
  getUserShares(user: Account): uint64 {
    return this.userShares(user).value;
  }

  /**
   * Preview how many shares a deposit would receive
   */
  @arc4.abimethod({ readonly: true })
  previewDeposit(alphaAmount: uint64): uint64 {
    return this.alphaToShares(alphaAmount);
  }

  /**
   * Preview how much Alpha a share redemption would receive
   */
  @arc4.abimethod({ readonly: true })
  previewWithdraw(shareAmount: uint64): uint64 {
    return this.sharesToAlpha(shareAmount);
  }

  /**
   * Preview compound - shows expected Alpha for current USDC balance
   * @returns [usdcBalance, expectedAlphaOutput, minOutputAt50bps]
   */
  @arc4.abimethod({ readonly: true })
  getCompoundQuote(): [uint64, uint64, uint64] {
    const appAddr: Account = Global.currentApplicationAddress;
    const usdcBalance = Asset(this.usdcAsset.value).balance(appAddr);

    if (usdcBalance === Uint64(0)) {
      return [Uint64(0), Uint64(0), Uint64(0)];
    }

    const expectedOutput = this.getExpectedSwapOutput(usdcBalance);
    const minAt50Bps = this.mulDivFloor(expectedOutput, FEE_BPS_BASE - Uint64(50), FEE_BPS_BASE);

    return [usdcBalance, expectedOutput, minAt50Bps];
  }

  // ============================================
  // ADMIN METHODS
  // ============================================

  /**
   * Update the minimum swap threshold
   */
  @arc4.abimethod()
  updateMinSwapThreshold(newThreshold: uint64): void {
    const isCreator = Txn.sender === this.creatorAddress.value;
    const isRarefi = Txn.sender === this.rarefiAddress.value;
    assert(isCreator || isRarefi, 'Only creator or RareFi can update');
    assert(newThreshold >= MIN_SWAP_AMOUNT, 'Threshold too low');
    this.minSwapThreshold.value = newThreshold;
  }

  /**
   * Update Tinyman pool configuration
   * Use only if the pool needs to be changed (e.g., migration)
   */
  @arc4.abimethod()
  updateTinymanPool(newPoolAppId: uint64, newPoolAddress: Account): void {
    const isCreator = Txn.sender === this.creatorAddress.value;
    const isRarefi = Txn.sender === this.rarefiAddress.value;
    assert(isCreator || isRarefi, 'Only creator or RareFi can update');
    assert(newPoolAppId !== Uint64(0), 'Invalid pool app ID');
    this.tinymanPoolAppId.value = newPoolAppId;
    this.tinymanPoolAddress.value = newPoolAddress;
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
