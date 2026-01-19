// MockOrbital.algo.ts - Mock Orbital Lending protocol for testing
// Simulates Compound-style lending with cUSDC (LST tokens)
// Exchange rate increases over time to simulate yield accrual

import {
  GlobalState,
  itxn,
  Global,
  assert,
  Uint64,
  uint64,
  bytes,
  Account,
  Asset,
  Contract,
  Txn,
  Bytes,
  gtxn,
} from '@algorandfoundation/algorand-typescript';
import { mulw, divmodw, btoi, itob } from '@algorandfoundation/algorand-typescript/op';

// Constants
const RATE_PRECISION: uint64 = Uint64(1_000_000);  // 1e6 precision for exchange rate
const INITIAL_RATE: uint64 = Uint64(1_000_000);    // 1.0 initial rate (1 cUSDC = 1 USDC)

export class MockOrbital extends Contract {
  // Asset IDs
  usdcAssetId = GlobalState<uint64>();    // USDC asset ID
  cUsdcAssetId = GlobalState<uint64>();   // cUSDC (LST receipt token) asset ID

  // State for exchange rate calculation (matches Orbital's global state keys)
  // rate = total_deposits / circulating_lst
  total_deposits = GlobalState<uint64>();   // Total USDC deposited in protocol
  circulating_lst = GlobalState<uint64>();  // Total cUSDC minted (in circulation)

  // Admin settings
  creator = GlobalState<Account>();

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
    // If there's a remainder, round up
    if (r_lo > Uint64(0) || r_hi > Uint64(0)) {
      return q_lo + Uint64(1);
    }
    return q_lo;
  }

  /**
   * Get current exchange rate: rate = (total_deposits * RATE_PRECISION) / circulating_lst
   * Returns RATE_PRECISION (1.0) if no deposits yet
   */
  private getCurrentRate(): uint64 {
    const circulatingLst = this.circulating_lst.value;
    if (circulatingLst === Uint64(0)) {
      return INITIAL_RATE;
    }
    return this.mulDivFloor(this.total_deposits.value, RATE_PRECISION, circulatingLst);
  }

  /**
   * Main approval program - routes based on app args
   */
  approvalProgram(): boolean {
    // Handle application create
    if (Txn.applicationId.id === Uint64(0)) {
      return this.onCreate();
    }

    // Route based on first app arg
    if (Txn.numAppArgs === Uint64(0)) {
      return false; // No bare calls supported
    }

    const action = Txn.applicationArgs(0);

    if (action === Bytes('initialize')) {
      const usdcId = btoi(Txn.applicationArgs(1));
      const cUsdcId = btoi(Txn.applicationArgs(2));
      this.initialize(usdcId, cUsdcId);
      return true;
    }

    if (action === Bytes('optInAssets')) {
      this.optInAssets();
      return true;
    }

    if (action === Bytes('deposit')) {
      // No extra args needed - reads from preceding asset transfer
      this.deposit();
      return true;
    }

    if (action === Bytes('redeem')) {
      // cUSDC amount to redeem passed as arg
      const amount = btoi(Txn.applicationArgs(1));
      this.redeem(amount);
      return true;
    }

    if (action === Bytes('accrueInterest')) {
      // Admin function to simulate yield accrual by increasing total_deposits
      const additionalYield = btoi(Txn.applicationArgs(1));
      this.accrueInterest(additionalYield);
      return true;
    }

    if (action === Bytes('getRate')) {
      // Read-only: return current exchange rate (for testing)
      return true;
    }

    if (action === Bytes('fundProtocol')) {
      // Admin function to add USDC to protocol (for redemptions)
      this.fundProtocol();
      return true;
    }

    return false; // Unknown action
  }

  /**
   * Clear state program
   */
  clearStateProgram(): boolean {
    return true;
  }

  /**
   * Handle application creation
   */
  private onCreate(): boolean {
    this.creator.value = Txn.sender;
    this.total_deposits.value = Uint64(0);
    this.circulating_lst.value = Uint64(0);

    // Check if initialization args are passed on create
    if (Txn.numAppArgs >= Uint64(3)) {
      const firstArg = Txn.applicationArgs(0);
      // ABI-style call with 4-byte method selector
      if (firstArg.length === Uint64(4)) {
        const usdcId = btoi(Txn.applicationArgs(1));
        const cUsdcId = btoi(Txn.applicationArgs(2));
        this.initialize(usdcId, cUsdcId);
      }
    }

    return true;
  }

  /**
   * Initialize the mock protocol with asset IDs
   */
  private initialize(usdcId: uint64, cUsdcId: uint64): void {
    assert(Txn.sender === this.creator.value, 'Only creator can initialize');
    assert(usdcId !== Uint64(0), 'Invalid USDC asset ID');
    assert(cUsdcId !== Uint64(0), 'Invalid cUSDC asset ID');

    this.usdcAssetId.value = usdcId;
    this.cUsdcAssetId.value = cUsdcId;
  }

  /**
   * Opt the contract into USDC and cUSDC assets
   */
  private optInAssets(): void {
    const appAddr: Account = Global.currentApplicationAddress;

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
  }

  /**
   * Deposit USDC and receive cUSDC at current exchange rate
   * Expects: [Asset transfer USDC to contract] -> [App call: deposit]
   *
   * cUSDC to mint = USDC amount / current rate
   */
  private deposit(): void {
    const appAddr: Account = Global.currentApplicationAddress;
    const currentIndex = Txn.groupIndex;
    assert(currentIndex >= Uint64(1), 'Must follow asset transfer');

    // Validate incoming USDC transfer
    const incomingTransfer = gtxn.AssetTransferTxn(currentIndex - Uint64(1));
    assert(incomingTransfer.xferAsset === Asset(this.usdcAssetId.value), 'Must transfer USDC');
    assert(incomingTransfer.assetReceiver === appAddr, 'Must send to contract');

    const usdcAmount = incomingTransfer.assetAmount;
    assert(usdcAmount > Uint64(0), 'Deposit amount must be positive');

    // Calculate cUSDC to mint based on current rate
    // cUSDC = USDC * RATE_PRECISION / rate
    const currentRate = this.getCurrentRate();
    const cUsdcToMint = this.mulDivFloor(usdcAmount, RATE_PRECISION, currentRate);

    assert(cUsdcToMint > Uint64(0), 'cUSDC mint amount is zero');

    // Update protocol state
    this.total_deposits.value = this.total_deposits.value + usdcAmount;
    this.circulating_lst.value = this.circulating_lst.value + cUsdcToMint;

    // Send cUSDC to depositor
    itxn.assetTransfer({
      assetReceiver: Txn.sender,
      xferAsset: Asset(this.cUsdcAssetId.value),
      assetAmount: cUsdcToMint,
      fee: Uint64(0),
    }).submit();
  }

  /**
   * Redeem cUSDC for USDC at current exchange rate
   * Expects: [Asset transfer cUSDC to contract] -> [App call: redeem]
   *
   * USDC to return = cUSDC amount * current rate / RATE_PRECISION
   */
  private redeem(cUsdcAmount: uint64): void {
    const appAddr: Account = Global.currentApplicationAddress;
    const currentIndex = Txn.groupIndex;
    assert(currentIndex >= Uint64(1), 'Must follow asset transfer');

    // Validate incoming cUSDC transfer
    const incomingTransfer = gtxn.AssetTransferTxn(currentIndex - Uint64(1));
    assert(incomingTransfer.xferAsset === Asset(this.cUsdcAssetId.value), 'Must transfer cUSDC');
    assert(incomingTransfer.assetReceiver === appAddr, 'Must send to contract');
    assert(incomingTransfer.assetAmount === cUsdcAmount, 'Amount mismatch');

    assert(cUsdcAmount > Uint64(0), 'Redeem amount must be positive');
    assert(cUsdcAmount <= this.circulating_lst.value, 'Exceeds circulating supply');

    // Calculate USDC to return based on current rate
    // USDC = cUSDC * rate / RATE_PRECISION
    const currentRate = this.getCurrentRate();
    const usdcToReturn = this.mulDivFloor(cUsdcAmount, currentRate, RATE_PRECISION);

    assert(usdcToReturn > Uint64(0), 'USDC return amount is zero');
    assert(usdcToReturn <= this.total_deposits.value, 'Insufficient protocol reserves');

    // Update protocol state
    this.total_deposits.value = this.total_deposits.value - usdcToReturn;
    this.circulating_lst.value = this.circulating_lst.value - cUsdcAmount;

    // Send USDC to redeemer
    itxn.assetTransfer({
      assetReceiver: Txn.sender,
      xferAsset: Asset(this.usdcAssetId.value),
      assetAmount: usdcToReturn,
      fee: Uint64(0),
    }).submit();
  }

  /**
   * Admin function: Accrue interest by adding USDC to total_deposits
   * This simulates yield generation from lending activity
   * The exchange rate increases because total_deposits grows while circulating_lst stays same
   */
  private accrueInterest(additionalYield: uint64): void {
    assert(Txn.sender === this.creator.value, 'Only creator can accrue interest');

    // Need to actually receive the USDC that represents yield
    const appAddr: Account = Global.currentApplicationAddress;
    const currentIndex = Txn.groupIndex;
    assert(currentIndex >= Uint64(1), 'Must follow asset transfer');

    const incomingTransfer = gtxn.AssetTransferTxn(currentIndex - Uint64(1));
    assert(incomingTransfer.xferAsset === Asset(this.usdcAssetId.value), 'Must transfer USDC');
    assert(incomingTransfer.assetReceiver === appAddr, 'Must send to contract');
    assert(incomingTransfer.assetAmount >= additionalYield, 'Insufficient USDC sent');

    // Increase total_deposits to reflect yield accrual
    // This causes the exchange rate to increase
    this.total_deposits.value = this.total_deposits.value + additionalYield;
  }

  /**
   * Admin function: Fund the protocol with USDC for redemptions
   * Used in testing to ensure the mock has enough USDC to return on redemptions
   */
  private fundProtocol(): void {
    assert(Txn.sender === this.creator.value, 'Only creator can fund protocol');

    const appAddr: Account = Global.currentApplicationAddress;
    const currentIndex = Txn.groupIndex;
    assert(currentIndex >= Uint64(1), 'Must follow asset transfer');

    // Just verify transfer happened - don't update state
    // This is for seeding initial cUSDC liquidity
    const incomingTransfer = gtxn.AssetTransferTxn(currentIndex - Uint64(1));
    assert(incomingTransfer.assetReceiver === appAddr, 'Must send to contract');
  }
}
