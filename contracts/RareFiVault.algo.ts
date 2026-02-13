// RareFiVault.algo.ts - Permissionless yield vault contract
// Users deposit Alpha (yield-bearing asset) and earn yield in a project's ASA token
// Yield is fairly distributed using the standard staking rewards accumulator pattern

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
const SCALE: uint64 = Uint64(1_000_000_000_000);      // 1e12 for yield_per_token precision
const MAX_FEE_RATE: uint64 = Uint64(6);                 // 6% max fee (percentage 0-6)
const FEE_PERCENT_BASE: uint64 = Uint64(100);          // Fee percentage base (feeRate/100 = percentage)
const MIN_FARM_EMISSION_BPS: uint64 = Uint64(1_000);    // 10% minimum when farm has balance
const MIN_DEPOSIT_AMOUNT: uint64 = Uint64(1_000_000);  // Minimum deposit (1 token with 6 decimals)
const MIN_SWAP_AMOUNT: uint64 = Uint64(200_000);       // Minimum swap amount (0.20 USDC)
const MAX_SWAP_THRESHOLD: uint64 = Uint64(50_000_000);  // Maximum swap threshold (50 USDC)
const FEE_BPS_BASE: uint64 = Uint64(10_000);           // Basis points denominator (10000 = 100%)
const MAX_SLIPPAGE_BPS: uint64 = Uint64(10_000);        // Absolute ceiling for maxSlippageBps setting
const MIN_MAX_SLIPPAGE_BPS: uint64 = Uint64(500);       // 5% minimum for maxSlippageBps (prevents creator from setting too low)

export class RareFiVault extends arc4.Contract {
  // ============================================
  // GLOBAL STATE
  // ============================================

  // Asset IDs
  depositAsset = GlobalState<uint64>();      // Alpha ASA ID (what users deposit)
  yieldAsset = GlobalState<uint64>();        // USDC ASA ID (what airdrops come in as)
  swapAsset = GlobalState<uint64>();         // Project's ASA ID (what yield is swapped to)

  // Creator/Fee settings
  creatorAddress = GlobalState<Account>();   // Vault creator who receives fee
  rarefiAddress = GlobalState<Account>();    // RareFi platform address (can also trigger swaps)
  creatorFeeRate = GlobalState<uint64>();    // 0-100, percentage of yield to creator
  creatorUnclaimedYield = GlobalState<uint64>(); // Accumulated yield for creator to claim

  // Vault state
  totalDeposits = GlobalState<uint64>();     // Total Alpha deposited in vault
  yieldPerToken = GlobalState<uint64>();     // Accumulator for yield distribution (scaled by SCALE)
  minSwapThreshold = GlobalState<uint64>();  // Minimum USDC before swap allowed
  maxSlippageBps = GlobalState<uint64>();    // Maximum slippage tolerance in basis points
  totalYieldGenerated = GlobalState<uint64>(); // Total yield generated from swaps (swap output in swapAsset)

  // Tinyman V2 integration
  tinymanPoolAppId = GlobalState<uint64>();  // Tinyman V2 pool app ID (USDC/swapAsset)
  tinymanPoolAddress = GlobalState<Account>(); // Tinyman pool address

  // Farm feature - dynamic yield distribution
  farmBalance = GlobalState<uint64>();         // Total swapAsset available for farm bonus
  emissionRatio = GlobalState<uint64>();       // Multiplier for dynamic rate: rate = farmBalance * emissionRatio / totalDeposits

  // Setup guard
  assetsOptedIn = GlobalState<uint64>();      // 1 if assets are opted in, 0 otherwise

  // ============================================
  // LOCAL STATE (per user)
  // ============================================

  depositedAmount = LocalState<uint64>();    // User's Alpha balance in vault
  userYieldPerToken = LocalState<uint64>();  // Snapshot of yieldPerToken at last action
  earnedYield = LocalState<uint64>();        // Accumulated yield not yet claimed

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
   * Calculate dynamic farm emission rate based on farmBalance / totalDeposits ratio
   * Rate = farmBalance * emissionRatio / totalDeposits, floored at 10% when farm has balance
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
   * Update user's earned yield before any balance changes
   * This implements the staking rewards accumulator pattern
   */
  private updateEarnedYield(user: Account): void {
    const deposited = this.depositedAmount(user).value;

    if (deposited > Uint64(0)) {
      // pending = deposited * (current_yield_per_token - user_snapshot) / SCALE
      const currentYPT = this.yieldPerToken.value;
      const userYPT = this.userYieldPerToken(user).value;

      if (currentYPT > userYPT) {
        const pending = this.mulDivFloor(deposited, currentYPT - userYPT, SCALE);
        this.earnedYield(user).value = this.earnedYield(user).value + pending;
      }
    }

    // Update snapshot to current value
    this.userYieldPerToken(user).value = this.yieldPerToken.value;
  }

  /**
   * Calculate expected swap output by reading Tinyman V2 pool state
   * Reads reserves and fee from pool's local state, then applies AMM formula
   *
   * @param inputAmount - Amount of yieldAsset (USDC) to swap
   * @returns Expected output amount of swapAsset
   */
  private getExpectedSwapOutput(inputAmount: uint64): uint64 {
    const poolApp = this.tinymanPoolAppId.value;
    const poolAddr = this.tinymanPoolAddress.value;

    // Read pool state from local state of pool address (Tinyman V2 stores pool data in local state)
    const [asset1Id, hasAsset1Id] = AppLocal.getExUint64(poolAddr, poolApp, Bytes('asset_1_id'));
    assert(hasAsset1Id, 'Cannot read pool asset_1_id');

    const [asset1Reserves, hasAsset1Reserves] = AppLocal.getExUint64(poolAddr, poolApp, Bytes('asset_1_reserves'));
    assert(hasAsset1Reserves, 'Cannot read pool asset_1_reserves');

    const [asset2Reserves, hasAsset2Reserves] = AppLocal.getExUint64(poolAddr, poolApp, Bytes('asset_2_reserves'));
    assert(hasAsset2Reserves, 'Cannot read pool asset_2_reserves');

    const [totalFeeShare, hasTotalFeeShare] = AppLocal.getExUint64(poolAddr, poolApp, Bytes('total_fee_share'));
    assert(hasTotalFeeShare, 'Cannot read pool total_fee_share');

    // Determine which asset is input and which is output based on asset_1_id
    let inputReserves: uint64;
    let outputReserves: uint64;

    if (asset1Id === this.yieldAsset.value) {
      // USDC is asset_1, swapAsset is asset_2
      inputReserves = asset1Reserves;
      outputReserves = asset2Reserves;
    } else {
      // swapAsset is asset_1, USDC is asset_2
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

  /**
   * Execute USDC -> swapAsset swap, apply farm bonus, split fees, update vault state
   * Shared by deposit (auto-swap) and swapYield
   */
  private executeSwapAndDistribute(usdcBalance: uint64, slippageBps: uint64): void {
    const appAddr: Account = Global.currentApplicationAddress;

    // Calculate expected output ON-CHAIN by reading pool state
    const expectedOutput = this.getExpectedSwapOutput(usdcBalance);
    assert(expectedOutput > Uint64(0), 'Expected output is zero');

    // Apply slippage tolerance
    const minAmountOut = this.mulDivFloor(expectedOutput, FEE_BPS_BASE - slippageBps, FEE_BPS_BASE);

    // Record swap_asset balance before swap
    const swapAssetBefore = Asset(this.swapAsset.value).balance(appAddr);

    // Execute Tinyman V2 swap: USDC -> swap_asset
    itxn.submitGroup(
      itxn.assetTransfer({
        assetReceiver: this.tinymanPoolAddress.value,
        xferAsset: Asset(this.yieldAsset.value),
        assetAmount: usdcBalance,
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

    // Calculate actual swap output
    const swapAssetAfter: uint64 = Asset(this.swapAsset.value).balance(appAddr);
    const swapOutput: uint64 = swapAssetAfter - swapAssetBefore;
    assert(swapOutput >= minAmountOut, 'Swap output below minimum');

    // Calculate farm bonus using dynamic emission rate
    let farmBonus: uint64 = Uint64(0);
    if (this.emissionRatio.value > Uint64(0) && this.farmBalance.value > Uint64(0)) {
      const currentRate = this.calculateDynamicEmissionRate();
      const requestedBonus = this.mulDivFloor(swapOutput, currentRate, FEE_BPS_BASE);
      farmBonus = requestedBonus < this.farmBalance.value ? requestedBonus : this.farmBalance.value;
      this.farmBalance.value = this.farmBalance.value - farmBonus;
    }

    // Total output = swap output + farm bonus
    const totalOutput: uint64 = swapOutput + farmBonus;

    // Track total yield generated
    this.totalYieldGenerated.value = this.totalYieldGenerated.value + totalOutput;

    // Split yield between creator and users
    const creatorCut: uint64 = this.mulDivFloor(totalOutput, this.creatorFeeRate.value, FEE_PERCENT_BASE);
    const userCut: uint64 = totalOutput - creatorCut;

    // Add to creator's claimable
    this.creatorUnclaimedYield.value = this.creatorUnclaimedYield.value + creatorCut;

    // Distribute to users via accumulator
    if (userCut > Uint64(0)) {
      const yieldIncrease: uint64 = this.mulDivFloor(userCut, SCALE, this.totalDeposits.value);
      this.yieldPerToken.value = this.yieldPerToken.value + yieldIncrease;
    }
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
    depositAssetId: uint64,
    yieldAssetId: uint64,
    swapAssetId: uint64,
    creatorFeeRate: uint64,
    minSwapThreshold: uint64,
    maxSlippageBps: uint64,
    tinymanPoolAppId: uint64,
    tinymanPoolAddress: Account,
    rarefiAddress: Account
  ): void {
    // Validate parameters
    assert(creatorFeeRate <= MAX_FEE_RATE, 'Creator fee rate exceeds maximum (6%)');
    assert(minSwapThreshold >= MIN_SWAP_AMOUNT, 'Swap threshold too low');
    assert(minSwapThreshold <= MAX_SWAP_THRESHOLD, 'Swap threshold too high (max 50 USDC)');
    assert(maxSlippageBps >= MIN_MAX_SLIPPAGE_BPS, 'Max slippage too low (min 5%)');
    assert(maxSlippageBps <= MAX_SLIPPAGE_BPS, 'Max slippage too high');
    assert(depositAssetId !== Uint64(0), 'Invalid deposit asset');
    assert(yieldAssetId !== Uint64(0), 'Invalid yield asset');
    assert(swapAssetId !== Uint64(0), 'Invalid swap asset');
    assert(tinymanPoolAppId !== Uint64(0), 'Invalid Tinyman pool app ID');

    // Ensure all assets are different to prevent logic errors
    assert(depositAssetId !== yieldAssetId, 'Deposit and yield assets must be different');
    assert(depositAssetId !== swapAssetId, 'Deposit and swap assets must be different');
    assert(yieldAssetId !== swapAssetId, 'Yield and swap assets must be different');

    // Set asset IDs
    this.depositAsset.value = depositAssetId;
    this.yieldAsset.value = yieldAssetId;
    this.swapAsset.value = swapAssetId;

    // Set creator/fee settings
    this.creatorAddress.value = Txn.sender;
    this.rarefiAddress.value = rarefiAddress;
    this.creatorFeeRate.value = creatorFeeRate;
    this.creatorUnclaimedYield.value = Uint64(0);

    // Initialize vault state
    this.totalDeposits.value = Uint64(0);
    this.yieldPerToken.value = Uint64(0);
    this.minSwapThreshold.value = minSwapThreshold;
    this.maxSlippageBps.value = maxSlippageBps;
    this.totalYieldGenerated.value = Uint64(0);

    // Tinyman integration
    this.tinymanPoolAppId.value = tinymanPoolAppId;
    this.tinymanPoolAddress.value = tinymanPoolAddress;

    // Initialize farm state
    this.farmBalance.value = Uint64(0);
    this.emissionRatio.value = Uint64(0); // Disabled by default, creator sets via setEmissionRatio

    // Setup guard
    this.assetsOptedIn.value = Uint64(0);
  }

  /**
   * Opt the contract into all required assets
   * Must be called by creator after deployment with:
   * - 5.5 ALGO payment (stays in contract for MBR and operational fees)
   */
  @arc4.abimethod()
  optInAssets(): void {
    assert(Txn.sender === this.creatorAddress.value, 'Only creator can opt-in assets');
    assert(this.assetsOptedIn.value === Uint64(0), 'Assets already opted in');

    const appAddr: Account = Global.currentApplicationAddress;
    const totalRequired: uint64 = Uint64(5_500_000); // 5.5 ALGO

    // Verify payment covers setup requirement
    const currentIndex = Txn.groupIndex;
    assert(currentIndex >= Uint64(1), 'App call must follow payment');

    const algoPayment = gtxn.PaymentTxn(currentIndex - Uint64(1));
    assert(algoPayment.receiver === appAddr, 'Payment must be to app');
    assert(algoPayment.amount >= totalRequired, 'Insufficient ALGO (need 5.5 ALGO)');
    assert(algoPayment.sender === Txn.sender, 'Payment must be from caller');

    // SECURITY: Prevent phishing attacks - reject dangerous fields
    assert(algoPayment.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    assert(algoPayment.closeRemainderTo === Global.zeroAddress, 'closeRemainderTo must be zero');

    // Opt-in to deposit asset (Alpha)
    itxn.assetTransfer({
      assetReceiver: appAddr,
      xferAsset: Asset(this.depositAsset.value),
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit();

    // Opt-in to yield asset (USDC)
    itxn.assetTransfer({
      assetReceiver: appAddr,
      xferAsset: Asset(this.yieldAsset.value),
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit();

    // Opt-in to swap asset (Project ASA)
    itxn.assetTransfer({
      assetReceiver: appAddr,
      xferAsset: Asset(this.swapAsset.value),
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit();

    this.assetsOptedIn.value = Uint64(1);
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
    this.depositedAmount(Txn.sender).value = Uint64(0);
    this.userYieldPerToken(Txn.sender).value = Uint64(0);
    this.earnedYield(Txn.sender).value = Uint64(0);
  }

  /**
   * User closes out - claims all pending yield and withdraws all deposits first
   */
  @arc4.abimethod({ allowActions: 'CloseOut' })
  closeOut(): void {
    // Update pending yield
    this.updateEarnedYield(Txn.sender);

    const userDeposit = this.depositedAmount(Txn.sender).value;
    const userYield = this.earnedYield(Txn.sender).value;

    // Return deposit if any
    if (userDeposit > Uint64(0)) {
      this.totalDeposits.value = this.totalDeposits.value - userDeposit;

      itxn.assetTransfer({
        assetReceiver: Txn.sender,
        xferAsset: Asset(this.depositAsset.value),
        assetAmount: userDeposit,
        fee: Uint64(0),
      }).submit();
    }

    // Return yield if any
    if (userYield > Uint64(0)) {
      itxn.assetTransfer({
        assetReceiver: Txn.sender,
        xferAsset: Asset(this.swapAsset.value),
        assetAmount: userYield,
        fee: Uint64(0),
      }).submit();
    }
  }

  // ============================================
  // DEPOSIT / WITHDRAW
  // ============================================

  /**
   * User deposits Alpha into the vault
   * Expects an asset transfer in the group before this call
   *
   * If USDC balance >= threshold and has existing depositors, automatically
   * swaps yield BEFORE processing deposit. This ensures yield goes to
   * existing depositors, not the new one.
   *
   * @param slippageBps - Slippage tolerance for auto-swap (ignored if no swap needed)
   */
  @arc4.abimethod()
  deposit(slippageBps: uint64): void {
    assert(slippageBps <= this.maxSlippageBps.value, 'Slippage exceeds maximum allowed');

    const appAddr: Account = Global.currentApplicationAddress;
    const usdcBalance = Asset(this.yieldAsset.value).balance(appAddr);

    // Auto-swap if threshold met and has existing depositors
    // This distributes yield to EXISTING depositors before new deposit is added
    if (usdcBalance >= this.minSwapThreshold.value && this.totalDeposits.value > Uint64(0)) {
      this.executeSwapAndDistribute(usdcBalance, slippageBps);
    }

    // Process the deposit
    const currentIndex = Txn.groupIndex;
    assert(currentIndex >= Uint64(1), 'App call must follow asset transfer');

    const depositTransfer = gtxn.AssetTransferTxn(currentIndex - Uint64(1));
    assert(depositTransfer.xferAsset === Asset(this.depositAsset.value), 'Must transfer deposit asset');
    assert(depositTransfer.assetReceiver === appAddr, 'Must send to contract');
    assert(depositTransfer.sender === Txn.sender, 'Transfer must be from caller');

    // SECURITY: Prevent phishing attacks - reject dangerous fields
    assert(depositTransfer.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    assert(depositTransfer.assetCloseTo === Global.zeroAddress, 'assetCloseTo must be zero');

    const amount = depositTransfer.assetAmount;
    assert(amount >= MIN_DEPOSIT_AMOUNT, 'Deposit too small');

    // Update pending yield first (if user has existing deposit)
    this.updateEarnedYield(Txn.sender);

    // Add deposit
    this.depositedAmount(Txn.sender).value = this.depositedAmount(Txn.sender).value + amount;
    this.totalDeposits.value = this.totalDeposits.value + amount;
  }

  /**
   * User withdraws Alpha from the vault
   * @param amount - Amount to withdraw (0 = withdraw all)
   */
  @arc4.abimethod()
  withdraw(amount: uint64): void {
    const userBalance = this.depositedAmount(Txn.sender).value;
    let withdrawAmount = amount;

    // If amount is 0, withdraw all
    if (withdrawAmount === Uint64(0)) {
      withdrawAmount = userBalance;
    }

    assert(withdrawAmount > Uint64(0), 'Nothing to withdraw');
    assert(withdrawAmount <= userBalance, 'Insufficient balance');

    // Update pending yield first
    this.updateEarnedYield(Txn.sender);

    // Remove deposit
    this.depositedAmount(Txn.sender).value = userBalance - withdrawAmount;
    this.totalDeposits.value = this.totalDeposits.value - withdrawAmount;

    // Transfer Alpha back to user
    itxn.assetTransfer({
      assetReceiver: Txn.sender,
      xferAsset: Asset(this.depositAsset.value),
      assetAmount: withdrawAmount,
      fee: Uint64(0),
    }).submit();
  }

  // ============================================
  // YIELD CLAIMING
  // ============================================

  /**
   * User claims their accumulated yield (in swap_asset)
   */
  @arc4.abimethod()
  claim(): void {
    // Update pending yield
    this.updateEarnedYield(Txn.sender);

    const claimable = this.earnedYield(Txn.sender).value;
    assert(claimable > Uint64(0), 'Nothing to claim');

    // Reset earned yield
    this.earnedYield(Txn.sender).value = Uint64(0);

    // Transfer swap_asset to user
    itxn.assetTransfer({
      assetReceiver: Txn.sender,
      xferAsset: Asset(this.swapAsset.value),
      assetAmount: claimable,
      fee: Uint64(0),
    }).submit();
  }

  /**
   * Creator claims their accumulated yield
   */
  @arc4.abimethod()
  claimCreator(): void {
    assert(Txn.sender === this.creatorAddress.value, 'Only creator can claim');

    const claimable = this.creatorUnclaimedYield.value;
    assert(claimable > Uint64(0), 'Nothing to claim');

    // Reset creator unclaimed yield
    this.creatorUnclaimedYield.value = Uint64(0);

    // Transfer swap_asset to creator
    itxn.assetTransfer({
      assetReceiver: Txn.sender,
      xferAsset: Asset(this.swapAsset.value),
      assetAmount: claimable,
      fee: Uint64(0),
    }).submit();
  }

  // ============================================
  // YIELD SWAP (Tinyman V2 Integration)
  // ============================================

  /**
   * Swaps accumulated USDC to project ASA via Tinyman V2
   * Uses ON-CHAIN price calculation - reads pool reserves and fee dynamically
   * Permissionless - anyone can trigger, slippage capped by maxSlippageBps
   *
   * @param slippageBps - Slippage tolerance in basis points (e.g., 50 = 0.5%, 100 = 1%)
   */
  @arc4.abimethod()
  swapYield(slippageBps: uint64): void {
    assert(slippageBps <= this.maxSlippageBps.value, 'Slippage exceeds maximum allowed');

    const appAddr: Account = Global.currentApplicationAddress;
    const usdcBalance = Asset(this.yieldAsset.value).balance(appAddr);

    assert(usdcBalance >= this.minSwapThreshold.value, 'Below minimum swap threshold');
    assert(this.totalDeposits.value > Uint64(0), 'No depositors to distribute to');

    this.executeSwapAndDistribute(usdcBalance, slippageBps);
  }

  // ============================================
  // READ-ONLY METHODS
  // ============================================

  /**
   * Get vault statistics
   */
  @arc4.abimethod({ readonly: true })
  getVaultStats(): [uint64, uint64, uint64, uint64, uint64, uint64] {
    const appAddr: Account = Global.currentApplicationAddress;
    const usdcBalance = Asset(this.yieldAsset.value).balance(appAddr);
    const swapAssetBalance = Asset(this.swapAsset.value).balance(appAddr);

    // Return [totalDeposits, yieldPerToken, creatorUnclaimedYield, usdcBalance, swapAssetBalance, totalYieldGenerated]
    return [
      this.totalDeposits.value,
      this.yieldPerToken.value,
      this.creatorUnclaimedYield.value,
      usdcBalance,
      swapAssetBalance,
      this.totalYieldGenerated.value
    ];
  }

  /**
   * Get user's pending yield (without claiming)
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
   * Get user's deposit balance
   */
  @arc4.abimethod({ readonly: true })
  getUserDeposit(user: Account): uint64 {
    return this.depositedAmount(user).value;
  }

  /**
   * Preview swap output - shows expected ASA for current USDC balance
   * Reads pool state on-chain to calculate expected output
   * @returns [usdcBalance, expectedOutput, minOutputAt50bps]
   */
  @arc4.abimethod({ readonly: true })
  getSwapQuote(): [uint64, uint64, uint64] {
    const appAddr: Account = Global.currentApplicationAddress;
    const usdcBalance = Asset(this.yieldAsset.value).balance(appAddr);

    if (usdcBalance === Uint64(0)) {
      return [Uint64(0), Uint64(0), Uint64(0)];
    }

    const expectedOutput = this.getExpectedSwapOutput(usdcBalance);
    // Show min output at 0.5% slippage as reference
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
    assert(newThreshold <= MAX_SWAP_THRESHOLD, 'Threshold too high (max 50 USDC)');
    this.minSwapThreshold.value = newThreshold;
  }

  /**
   * Update the maximum slippage tolerance for swaps
   * Only callable by creator
   */
  @arc4.abimethod()
  updateMaxSlippage(newMaxSlippageBps: uint64): void {
    assert(Txn.sender === this.creatorAddress.value, 'Only creator can update max slippage');
    assert(newMaxSlippageBps >= MIN_MAX_SLIPPAGE_BPS, 'Max slippage too low (min 5%)');
    assert(newMaxSlippageBps <= MAX_SLIPPAGE_BPS, 'Max slippage too high');
    this.maxSlippageBps.value = newMaxSlippageBps;
  }

  /**
   * Update the creator fee rate
   * Only callable by creator, constrained to 0-6% range
   */
  @arc4.abimethod()
  updateCreatorFeeRate(newFeeRate: uint64): void {
    assert(Txn.sender === this.creatorAddress.value, 'Only creator can update fee rate');
    assert(newFeeRate <= MAX_FEE_RATE, 'Fee rate exceeds maximum (6%)');
    this.creatorFeeRate.value = newFeeRate;
  }

  // ============================================
  // FARM FEATURE - Bonus yield distribution
  // ============================================

  /**
   * Anyone can contribute to the farm by sending swapAsset
   * Farm bonus is distributed proportionally during yield swaps
   * This allows projects/sponsors to boost yield for depositors
   *
   * Expects an asset transfer of swapAsset before this call
   */
  @arc4.abimethod()
  contributeFarm(): void {
    const appAddr: Account = Global.currentApplicationAddress;
    const currentIndex = Txn.groupIndex;
    assert(currentIndex >= Uint64(1), 'App call must follow asset transfer');

    // Validate the contribution transfer
    const farmTransfer = gtxn.AssetTransferTxn(currentIndex - Uint64(1));
    assert(farmTransfer.xferAsset === Asset(this.swapAsset.value), 'Must transfer swap asset');
    assert(farmTransfer.assetReceiver === appAddr, 'Must send to contract');
    assert(farmTransfer.sender === Txn.sender, 'Transfer must be from caller');

    // SECURITY: Prevent phishing attacks - reject dangerous fields
    assert(farmTransfer.rekeyTo === Global.zeroAddress, 'rekeyTo must be zero');
    assert(farmTransfer.assetCloseTo === Global.zeroAddress, 'assetCloseTo must be zero');

    const amount = farmTransfer.assetAmount;
    assert(amount > Uint64(0), 'Contribution must be positive');

    // Add to farm balance
    this.farmBalance.value = this.farmBalance.value + amount;
  }

  /**
   * Set the emission ratio (multiplier for dynamic farm rate calculation)
   * Only callable by creator or RareFi
   * Dynamic rate = farmBalance * emissionRatio / totalDeposits
   *
   * @param newRatio - The emission ratio multiplier (e.g., 4000000 for aggressive distribution)
   */
  @arc4.abimethod()
  setEmissionRatio(newRatio: uint64): void {
    const isCreator = Txn.sender === this.creatorAddress.value;
    const isRarefi = Txn.sender === this.rarefiAddress.value;
    assert(isCreator || isRarefi, 'Only creator or RareFi can set emission ratio');
    assert(newRatio > Uint64(0), 'Emission ratio must be positive');

    this.emissionRatio.value = newRatio;
  }

  /**
   * Get farm statistics including dynamic emission rate
   * @returns [farmBalance, emissionRatio, currentDynamicRate]
   */
  @arc4.abimethod({ readonly: true })
  getFarmStats(): [uint64, uint64, uint64] {
    let currentRate: uint64 = Uint64(0);
    if (this.emissionRatio.value > Uint64(0) && this.farmBalance.value > Uint64(0)) {
      currentRate = this.calculateDynamicEmissionRate();
    }
    return [this.farmBalance.value, this.emissionRatio.value, currentRate];
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
