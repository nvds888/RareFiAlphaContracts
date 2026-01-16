// MockTinymanPool.algo.ts - Simple mock for testing swapYield
// This simulates Tinyman V2 pool behavior for localnet testing
// Uses GlobalState for simplicity (real Tinyman uses LocalState)
// Uses Contract (not arc4.Contract) to support raw app args like real Tinyman

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
import { mulw, divmodw, btoi } from '@algorandfoundation/algorand-typescript/op';

// Tinyman V2 uses 30 bps (0.3%) base fee, but can be higher
const DEFAULT_FEE_BPS: uint64 = Uint64(30);
const FEE_BPS_BASE: uint64 = Uint64(10_000);

export class MockTinymanPool extends Contract {
  // Pool assets
  asset1Id = GlobalState<uint64>();  // e.g., USDC
  asset2Id = GlobalState<uint64>();  // e.g., Project token

  // Pool state - using GlobalState with same key names as Tinyman LocalState
  // This allows the vault to read state via AppGlobal instead of AppLocal
  asset_1_id = GlobalState<uint64>();
  asset_1_reserves = GlobalState<uint64>();
  asset_2_reserves = GlobalState<uint64>();
  total_fee_share = GlobalState<uint64>();  // Fee in basis points

  /**
   * Safe multiplication and division: floor(n1 * n2 / d)
   */
  private mulDivFloor(n1: uint64, n2: uint64, d: uint64): uint64 {
    const [hi, lo] = mulw(n1, n2);
    const [q_hi, q_lo, _r_hi, _r_lo] = divmodw(hi, lo, Uint64(0), d);
    assert(q_hi === Uint64(0), 'Overflow');
    return q_lo;
  }

  /**
   * Main approval program - routes based on app args
   */
  approvalProgram(): boolean {
    // Check if this is an application create (applicationId.id is 0 on create)
    if (Txn.applicationId.id === Uint64(0)) {
      return this.onCreate();
    }

    // Route based on first app arg
    if (Txn.numAppArgs === Uint64(0)) {
      return false; // No bare calls supported (except create)
    }

    const action = Txn.applicationArgs(0);

    if (action === Bytes('createPool')) {
      // Parse args: asset1Id, asset2Id, initialReserve1, initialReserve2, feeBps
      const asset1Id = btoi(Txn.applicationArgs(1));
      const asset2Id = btoi(Txn.applicationArgs(2));
      const initialReserve1 = btoi(Txn.applicationArgs(3));
      const initialReserve2 = btoi(Txn.applicationArgs(4));
      const feeBps = btoi(Txn.applicationArgs(5));
      this.createPool(asset1Id, asset2Id, initialReserve1, initialReserve2, feeBps);
      return true;
    }

    if (action === Bytes('optInAssets')) {
      this.optInAssets();
      return true;
    }

    if (action === Bytes('swap')) {
      // Parse args: swapType, minAmountOut
      assert(Txn.numAppArgs >= Uint64(3), 'Need 3 args for swap');
      const swapType = Txn.applicationArgs(1);
      const minAmountOut = btoi(Txn.applicationArgs(2));
      this.swap(swapType, minAmountOut);
      return true;
    }

    if (action === Bytes('updateFee')) {
      const newFeeBps = btoi(Txn.applicationArgs(1));
      this.updateFee(newFeeBps);
      return true;
    }

    if (action === Bytes('addLiquidity')) {
      const amount1 = btoi(Txn.applicationArgs(1));
      const amount2 = btoi(Txn.applicationArgs(2));
      this.addLiquidity(amount1, amount2);
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
   * Handle application creation - expects ABI-encoded createPool call from test
   * For simplicity, we initialize with default values here
   */
  private onCreate(): boolean {
    // Parse createPool args from app args (skipping 4-byte method selector)
    // Args format: [methodSelector(4), asset1Id(8), asset2Id(8), reserve1(8), reserve2(8), feeBps(8)]
    if (Txn.numAppArgs >= Uint64(1)) {
      const firstArg = Txn.applicationArgs(0);
      // Check if it's the ABI method selector for createPool (we accept any 4-byte prefix)
      if (firstArg.length === Uint64(4)) {
        // ABI call - parse uint64 args after the selector
        const asset1Id = btoi(Txn.applicationArgs(1));
        const asset2Id = btoi(Txn.applicationArgs(2));
        const reserve1 = btoi(Txn.applicationArgs(3));
        const reserve2 = btoi(Txn.applicationArgs(4));
        const feeBps = btoi(Txn.applicationArgs(5));
        this.createPool(asset1Id, asset2Id, reserve1, reserve2, feeBps);
        return true;
      }
    }
    return true; // Allow bare create for testing
  }

  private createPool(
    asset1Id: uint64,
    asset2Id: uint64,
    initialReserve1: uint64,
    initialReserve2: uint64,
    feeBps: uint64
  ): void {
    this.asset1Id.value = asset1Id;
    this.asset2Id.value = asset2Id;

    // Initialize pool state in global state
    this.asset_1_id.value = asset1Id;
    this.asset_1_reserves.value = initialReserve1;
    this.asset_2_reserves.value = initialReserve2;
    this.total_fee_share.value = feeBps > Uint64(0) ? feeBps : DEFAULT_FEE_BPS;
  }

  private optInAssets(): void {
    const appAddr: Account = Global.currentApplicationAddress;

    itxn.assetTransfer({
      assetReceiver: appAddr,
      xferAsset: Asset(this.asset1Id.value),
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit();

    itxn.assetTransfer({
      assetReceiver: appAddr,
      xferAsset: Asset(this.asset2Id.value),
      assetAmount: Uint64(0),
      fee: Uint64(0),
    }).submit();
  }

  /**
   * Mock swap - simulates Tinyman V2 swap using constant product AMM
   * Uses raw app args like real Tinyman V2
   * Expects: asset transfer in previous txn, then this app call
   */
  private swap(swapType: bytes, minAmountOut: uint64): void {
    assert(swapType === Bytes('fixed-input'), 'Only fixed-input supported');

    const appAddr: Account = Global.currentApplicationAddress;
    const currentIndex = Txn.groupIndex;
    assert(currentIndex >= Uint64(1), 'Must follow asset transfer');

    // Check the incoming asset transfer
    const incomingTransfer = gtxn.AssetTransferTxn(currentIndex - Uint64(1));
    const incomingAsset = incomingTransfer.xferAsset;
    const incomingAmount = incomingTransfer.assetAmount;
    assert(incomingTransfer.assetReceiver === appAddr, 'Must send to pool');

    // Get pool state from global storage
    const feeBps = this.total_fee_share.value;
    let inputReserves: uint64;
    let outputReserves: uint64;
    let outAsset: Asset;

    if (incomingAsset === Asset(this.asset1Id.value)) {
      // Swapping asset1 -> asset2
      inputReserves = this.asset_1_reserves.value;
      outputReserves = this.asset_2_reserves.value;
      outAsset = Asset(this.asset2Id.value);
    } else {
      // Swapping asset2 -> asset1
      assert(incomingAsset === Asset(this.asset2Id.value), 'Unknown asset');
      inputReserves = this.asset_2_reserves.value;
      outputReserves = this.asset_1_reserves.value;
      outAsset = Asset(this.asset1Id.value);
    }

    // Calculate output using constant product formula with fee
    // net_input = input * (10000 - fee_bps) / 10000
    const netInput = this.mulDivFloor(incomingAmount, FEE_BPS_BASE - feeBps, FEE_BPS_BASE);

    // output = (outputReserves * netInput) / (inputReserves + netInput)
    const outAmount = this.mulDivFloor(outputReserves, netInput, inputReserves + netInput);

    assert(outAmount >= minAmountOut, 'Slippage exceeded');

    // Update reserves in global state
    if (incomingAsset === Asset(this.asset1Id.value)) {
      this.asset_1_reserves.value = inputReserves + incomingAmount;
      this.asset_2_reserves.value = outputReserves - outAmount;
    } else {
      this.asset_2_reserves.value = inputReserves + incomingAmount;
      this.asset_1_reserves.value = outputReserves - outAmount;
    }

    // Send output to the caller (which is the vault contract)
    itxn.assetTransfer({
      assetReceiver: Txn.sender,
      xferAsset: outAsset,
      assetAmount: outAmount,
      fee: Uint64(0),
    }).submit();
  }

  private updateFee(newFeeBps: uint64): void {
    this.total_fee_share.value = newFeeBps;
  }

  private addLiquidity(amount1: uint64, amount2: uint64): void {
    this.asset_1_reserves.value = this.asset_1_reserves.value + amount1;
    this.asset_2_reserves.value = this.asset_2_reserves.value + amount2;
  }
}
