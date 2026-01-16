import algosdk from 'algosdk';
import {
  deployVaultForTest,
  performUserOptIn,
  performDeposit,
  performWithdraw,
  performSwapYield,
  performClaim,
  performClaimCreator,
  performCloseOut,
  getVaultStats,
  getPendingYield,
  getUserDeposit,
  VaultDeploymentResult,
} from './utils/vault';
import { getAssetBalance, optInToAsset, fundAsset } from './utils/assets';

// Localnet configuration
const ALGOD_SERVER = 'http://localhost';
const ALGOD_PORT = 4001;
const ALGOD_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// KMD configuration for getting funded accounts
const KMD_SERVER = 'http://localhost';
const KMD_PORT = 4002;
const KMD_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const SCALE = 1_000_000_000; // 1e9

describe('RareFiVault Contract Tests', () => {
  let algod: algosdk.Algodv2;
  let kmd: algosdk.Kmd;
  let creator: { addr: string; sk: Uint8Array };
  let alice: { addr: string; sk: Uint8Array };
  let bob: { addr: string; sk: Uint8Array };

  beforeAll(async () => {
    algod = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_SERVER, ALGOD_PORT);
    kmd = new algosdk.Kmd(KMD_TOKEN, KMD_SERVER, KMD_PORT);

    // Get funded accounts from KMD
    const wallets = await kmd.listWallets();
    const defaultWallet = wallets.wallets.find((w: any) => w.name === 'unencrypted-default-wallet');

    const walletHandle = (await kmd.initWalletHandle(defaultWallet.id, '')).wallet_handle_token;
    const addresses = (await kmd.listKeys(walletHandle)).addresses;

    // Get 3 accounts
    const getAccount = async (index: number) => {
      const addr = addresses[index];
      const keyResponse = await kmd.exportKey(walletHandle, '', addr);
      return { addr, sk: keyResponse.private_key };
    };

    creator = await getAccount(0);
    alice = await getAccount(1);
    bob = await getAccount(2);

    await kmd.releaseWalletHandle(walletHandle);
  });

  describe('Deployment', () => {
    let deployment: VaultDeploymentResult;

    it('should deploy vault and pool successfully', async () => {
      deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 20,
        minSwapThreshold: 2_000_000, // 2 USDC
      });

      expect(deployment.vaultAppId).toBeGreaterThan(0);
      expect(deployment.poolAppId).toBeGreaterThan(0);
      expect(deployment.alphaAssetId).toBeGreaterThan(0);
      expect(deployment.usdcAssetId).toBeGreaterThan(0);
      expect(deployment.ibusAssetId).toBeGreaterThan(0);
    });

    it('should have correct initial state', async () => {
      const stats = await getVaultStats(algod, deployment);
      expect(stats.totalDeposits).toBe(0);
      expect(stats.yieldPerToken).toBe(0);
      expect(stats.creatorUnclaimedYield).toBe(0);
    });
  });

  describe('User Operations', () => {
    let deployment: VaultDeploymentResult;
    const depositAmount = 100_000_000; // 100 tokens

    beforeAll(async () => {
      deployment = await deployVaultForTest(algod, creator);

      // Fund Alice and Bob with Alpha tokens
      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, bob, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await optInToAsset(algod, bob, deployment.ibusAssetId);

      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 1_000_000_000);
      await fundAsset(algod, creator, bob.addr, deployment.alphaAssetId, 500_000_000);
      await fundAsset(algod, creator, alice.addr, deployment.ibusAssetId, 100_000_000);
    });

    it('should allow user to opt in', async () => {
      await performUserOptIn(algod, deployment, alice);
      const deposit = await getUserDeposit(algod, deployment, alice.addr);
      expect(deposit).toBe(0);
    });

    it('should allow user to deposit', async () => {
      await performDeposit(algod, deployment, alice, depositAmount);
      const deposit = await getUserDeposit(algod, deployment, alice.addr);
      expect(deposit).toBe(depositAmount);

      const stats = await getVaultStats(algod, deployment);
      expect(stats.totalDeposits).toBe(depositAmount);
    });

    it('should allow partial withdrawal', async () => {
      const withdrawAmount = 30_000_000;
      await performWithdraw(algod, deployment, alice, withdrawAmount);

      const deposit = await getUserDeposit(algod, deployment, alice.addr);
      expect(deposit).toBe(depositAmount - withdrawAmount);

      const stats = await getVaultStats(algod, deployment);
      expect(stats.totalDeposits).toBe(depositAmount - withdrawAmount);
    });

    it('should allow full withdrawal with amount=0', async () => {
      // Deposit more first
      await performDeposit(algod, deployment, alice, 50_000_000);

      // Withdraw all with 0
      await performWithdraw(algod, deployment, alice, 0);

      const deposit = await getUserDeposit(algod, deployment, alice.addr);
      expect(deposit).toBe(0);
    });
  });

  describe('Yield Distribution via Swap', () => {
    let deployment: VaultDeploymentResult;
    const aliceDeposit = 1000_000_000; // 1000 tokens
    const bobDeposit = 500_000_000;    // 500 tokens
    const yieldAmount = 300_000_000;   // 300 USDC to swap

    beforeAll(async () => {
      deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 20, // 20%
        minSwapThreshold: 2_000_000, // 2 USDC
      });

      // Setup users
      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, bob, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await optInToAsset(algod, bob, deployment.ibusAssetId);
      await optInToAsset(algod, creator, deployment.usdcAssetId);

      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 2_000_000_000);
      await fundAsset(algod, creator, bob.addr, deployment.alphaAssetId, 1_000_000_000);

      // Users opt in and deposit
      await performUserOptIn(algod, deployment, alice);
      await performUserOptIn(algod, deployment, bob);

      await performDeposit(algod, deployment, alice, aliceDeposit);
      await performDeposit(algod, deployment, bob, bobDeposit);
    });

    it('should swap yield and distribute correctly', async () => {
      // Perform swap (sends USDC to vault, then swaps to IBUS)
      await performSwapYield(algod, deployment, creator, yieldAmount, 100); // 1% slippage

      const stats = await getVaultStats(algod, deployment);

      // USDC should be 0 after swap
      expect(stats.usdcBalance).toBe(0);

      // Creator should have received their cut
      // With 1:1 pool ratio and 0.3% fee, swap output ~= 299.1M IBUS
      // Creator fee = 20% of that
      expect(stats.creatorUnclaimedYield).toBeGreaterThan(0);

      // yieldPerToken should be updated
      expect(stats.yieldPerToken).toBeGreaterThan(0);
    });

    it('should calculate pending yield correctly', async () => {
      const alicePending = await getPendingYield(algod, deployment, alice.addr);
      const bobPending = await getPendingYield(algod, deployment, bob.addr);

      // Alice has 2/3 of deposits, Bob has 1/3
      // So Alice should have ~2x Bob's pending yield
      expect(alicePending).toBeGreaterThan(0);
      expect(bobPending).toBeGreaterThan(0);

      // Alice's share should be roughly 2x Bob's (with some tolerance for rounding)
      const ratio = alicePending / bobPending;
      expect(ratio).toBeGreaterThan(1.9);
      expect(ratio).toBeLessThan(2.1);
    });

    it('should allow Alice to claim yield', async () => {
      const ibusBalanceBefore = await getAssetBalance(algod, alice.addr, deployment.ibusAssetId);
      await performClaim(algod, deployment, alice);
      const ibusBalanceAfter = await getAssetBalance(algod, alice.addr, deployment.ibusAssetId);

      const claimed = ibusBalanceAfter - ibusBalanceBefore;
      expect(claimed).toBeGreaterThan(0);

      // Pending yield should now be 0
      const pendingAfter = await getPendingYield(algod, deployment, alice.addr);
      expect(pendingAfter).toBe(0);
    });

    it('should allow Bob to claim yield', async () => {
      const ibusBalanceBefore = await getAssetBalance(algod, bob.addr, deployment.ibusAssetId);
      await performClaim(algod, deployment, bob);
      const ibusBalanceAfter = await getAssetBalance(algod, bob.addr, deployment.ibusAssetId);

      const claimed = ibusBalanceAfter - ibusBalanceBefore;
      expect(claimed).toBeGreaterThan(0);
    });

    it('should allow creator to claim fee', async () => {
      const stats = await getVaultStats(algod, deployment);
      const expectedCreatorYield = stats.creatorUnclaimedYield;

      const ibusBalanceBefore = await getAssetBalance(algod, creator.addr, deployment.ibusAssetId);
      await performClaimCreator(algod, deployment, creator);
      const ibusBalanceAfter = await getAssetBalance(algod, creator.addr, deployment.ibusAssetId);

      const claimed = ibusBalanceAfter - ibusBalanceBefore;
      expect(claimed).toBe(expectedCreatorYield);

      // Creator unclaimed should be 0
      const statsAfter = await getVaultStats(algod, deployment);
      expect(statsAfter.creatorUnclaimedYield).toBe(0);
    });
  });

  describe('Late Depositor (No Past Yield)', () => {
    let deployment: VaultDeploymentResult;

    beforeAll(async () => {
      deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 20,
        minSwapThreshold: 2_000_000,
      });

      // Setup Alice
      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 2_000_000_000);

      // Alice deposits first
      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 1000_000_000);

      // Yield distributed while Bob hasn't deposited yet
      await performSwapYield(algod, deployment, creator, 100_000_000, 100);
    });

    it('should not give late depositor past yield', async () => {
      // Bob deposits AFTER yield was distributed
      await optInToAsset(algod, bob, deployment.alphaAssetId);
      await optInToAsset(algod, bob, deployment.ibusAssetId);
      await fundAsset(algod, creator, bob.addr, deployment.alphaAssetId, 1_000_000_000);

      await performUserOptIn(algod, deployment, bob);
      await performDeposit(algod, deployment, bob, 500_000_000);

      // Bob should have 0 pending yield (only Alice was deposited during distribution)
      const bobPending = await getPendingYield(algod, deployment, bob.addr);
      expect(bobPending).toBe(0);

      // Alice should have yield
      const alicePending = await getPendingYield(algod, deployment, alice.addr);
      expect(alicePending).toBeGreaterThan(0);
    });
  });

  describe('Close Out', () => {
    let deployment: VaultDeploymentResult;
    const depositAmount = 100_000_000;
    const yieldAmount = 50_000_000;

    beforeAll(async () => {
      deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0, // No creator fee for simpler math
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 500_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, depositAmount);

      // Distribute some yield via swap
      await performSwapYield(algod, deployment, creator, yieldAmount, 100);
    });

    it('should return deposit and yield on close out', async () => {
      const alphaBalanceBefore = await getAssetBalance(algod, alice.addr, deployment.alphaAssetId);
      const ibusBalanceBefore = await getAssetBalance(algod, alice.addr, deployment.ibusAssetId);

      await performCloseOut(algod, deployment, alice);

      const alphaBalanceAfter = await getAssetBalance(algod, alice.addr, deployment.alphaAssetId);
      const ibusBalanceAfter = await getAssetBalance(algod, alice.addr, deployment.ibusAssetId);

      // Should get deposit back
      expect(alphaBalanceAfter - alphaBalanceBefore).toBe(depositAmount);

      // Should get yield (swapped IBUS minus pool fee)
      expect(ibusBalanceAfter - ibusBalanceBefore).toBeGreaterThan(0);

      // Total deposits should decrease
      const stats = await getVaultStats(algod, deployment);
      expect(stats.totalDeposits).toBe(0);
    });
  });

  describe('Security - Immutability', () => {
    let deployment: VaultDeploymentResult;

    beforeAll(async () => {
      deployment = await deployVaultForTest(algod, creator);
    });

    it('should reject update application', async () => {
      const suggestedParams = await algod.getTransactionParams().do();

      const updateTxn = algosdk.makeApplicationUpdateTxnFromObject({
        sender: creator.addr,
        appIndex: deployment.vaultAppId,
        approvalProgram: new Uint8Array([0x06, 0x81, 0x01]), // minimal program
        clearProgram: new Uint8Array([0x06, 0x81, 0x01]),
        suggestedParams,
      });

      const signedTxn = updateTxn.signTxn(creator.sk);

      await expect(
        algod.sendRawTransaction(signedTxn).do()
      ).rejects.toThrow();
    });

    it('should reject delete application', async () => {
      const suggestedParams = await algod.getTransactionParams().do();

      const deleteTxn = algosdk.makeApplicationDeleteTxnFromObject({
        sender: creator.addr,
        appIndex: deployment.vaultAppId,
        suggestedParams,
      });

      const signedTxn = deleteTxn.signTxn(creator.sk);

      await expect(
        algod.sendRawTransaction(signedTxn).do()
      ).rejects.toThrow();
    });
  });

  describe('Edge Cases', () => {
    it('should reject deposit below minimum', async () => {
      const deployment = await deployVaultForTest(algod, creator);
      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 100_000_000);
      await performUserOptIn(algod, deployment, alice);

      // Try to deposit less than MIN_DEPOSIT_AMOUNT (1_000_000)
      await expect(
        performDeposit(algod, deployment, alice, 100)
      ).rejects.toThrow();
    });

    it('should reject swap below minimum threshold', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        minSwapThreshold: 10_000_000, // 10 USDC minimum
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 100_000_000);
      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);

      // Try to swap only 5 USDC (below 10 USDC threshold)
      await expect(
        performSwapYield(algod, deployment, creator, 5_000_000, 100)
      ).rejects.toThrow();
    });

    it('should handle zero fee rate correctly', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 100_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);

      // Swap yield
      await performSwapYield(algod, deployment, creator, 50_000_000, 100);

      const stats = await getVaultStats(algod, deployment);
      expect(stats.creatorUnclaimedYield).toBe(0); // No creator fee

      // All yield goes to user
      const pending = await getPendingYield(algod, deployment, alice.addr);
      expect(pending).toBeGreaterThan(0);
    });

    it('should handle 100% fee rate correctly', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 100,
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, bob, deployment.alphaAssetId);
      await optInToAsset(algod, bob, deployment.ibusAssetId);
      await fundAsset(algod, creator, bob.addr, deployment.alphaAssetId, 100_000_000);

      await performUserOptIn(algod, deployment, bob);
      await performDeposit(algod, deployment, bob, 100_000_000);

      // Swap yield
      await performSwapYield(algod, deployment, creator, 50_000_000, 100);

      const stats = await getVaultStats(algod, deployment);
      expect(stats.creatorUnclaimedYield).toBeGreaterThan(0); // All to creator

      // User gets nothing
      const pending = await getPendingYield(algod, deployment, bob.addr);
      expect(pending).toBe(0);
    });

    it('should reject non-creator/rarefi from calling swapYield', async () => {
      const deployment = await deployVaultForTest(algod, creator);

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.usdcAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 100_000_000);
      await fundAsset(algod, creator, alice.addr, deployment.usdcAssetId, 100_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);

      // Alice tries to call swapYield (should fail - only creator/rarefi allowed)
      await expect(
        performSwapYield(algod, deployment, alice, 10_000_000, 100)
      ).rejects.toThrow();
    });
  });

  describe('Multiple Deposits and Yield Tracking', () => {
    let deployment: VaultDeploymentResult;

    beforeAll(async () => {
      deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0, // No fee for easier math
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 5_000_000_000);
    });

    it('should correctly track yield across multiple deposits', async () => {
      // Alice deposits 100
      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);

      // First yield distribution
      await performSwapYield(algod, deployment, creator, 10_000_000, 100);

      const pendingAfterFirst = await getPendingYield(algod, deployment, alice.addr);
      expect(pendingAfterFirst).toBeGreaterThan(0);

      // Alice deposits 200 more (should crystallize first yield)
      await performDeposit(algod, deployment, alice, 200_000_000);

      // Second yield distribution (Alice now has 300 total)
      await performSwapYield(algod, deployment, creator, 30_000_000, 100);

      const pendingAfterSecond = await getPendingYield(algod, deployment, alice.addr);

      // Pending should include yield from both distributions
      expect(pendingAfterSecond).toBeGreaterThan(pendingAfterFirst);

      // Claim all
      const ibusBalanceBefore = await getAssetBalance(algod, alice.addr, deployment.ibusAssetId);
      await performClaim(algod, deployment, alice);
      const ibusBalanceAfter = await getAssetBalance(algod, alice.addr, deployment.ibusAssetId);

      const claimed = ibusBalanceAfter - ibusBalanceBefore;
      expect(claimed).toBeGreaterThan(0);

      // Pending should be 0 after claim
      const pendingAfterClaim = await getPendingYield(algod, deployment, alice.addr);
      expect(pendingAfterClaim).toBe(0);
    });
  });

  /**
   * COMPREHENSIVE INTEGRATION TEST
   * Tests complex scenarios with multiple users, varying deposits, multiple swaps,
   * claims, close-outs, and additional deposits to ensure accounting is solid.
   */
  describe('Comprehensive Integration Test - Accounting Verification', () => {
    let deployment: VaultDeploymentResult;
    let charlie: { addr: string; sk: Uint8Array };
    let dave: { addr: string; sk: Uint8Array };
    let hasEnoughAccounts = false;

    // Track everything for verification
    let totalYieldDistributed = 0;
    let totalCreatorFee = 0;
    let totalUserYield = 0;

    beforeAll(async () => {
      // Get additional accounts (charlie and dave)
      const wallets = await kmd.listWallets();
      const defaultWallet = wallets.wallets.find((w: any) => w.name === 'unencrypted-default-wallet');
      const walletHandle = (await kmd.initWalletHandle(defaultWallet.id, '')).wallet_handle_token;
      const addresses = (await kmd.listKeys(walletHandle)).addresses;

      // Check if we have enough accounts
      if (addresses.length < 5) {
        console.log('Skipping comprehensive test - need 5 accounts, have', addresses.length);
        await kmd.releaseWalletHandle(walletHandle);
        return;
      }

      hasEnoughAccounts = true;
      charlie = {
        addr: addresses[3],
        sk: (await kmd.exportKey(walletHandle, '', addresses[3])).private_key,
      };
      dave = {
        addr: addresses[4],
        sk: (await kmd.exportKey(walletHandle, '', addresses[4])).private_key,
      };
      await kmd.releaseWalletHandle(walletHandle);

      // Deploy with 20% creator fee
      deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 20, // 20%
        minSwapThreshold: 2_000_000,
        poolReserveUsdc: 100_000_000_000,  // 100k USDC
        poolReserveIbus: 100_000_000_000,  // 100k IBUS (1:1 ratio)
      });

      // Setup all users with assets
      for (const user of [alice, bob, charlie, dave]) {
        await optInToAsset(algod, user, deployment.alphaAssetId);
        await optInToAsset(algod, user, deployment.ibusAssetId);
        await fundAsset(algod, creator, user.addr, deployment.alphaAssetId, 10_000_000_000); // 10k Alpha each
      }
    });

    it('Phase 1: Initial deposits with varying amounts', async () => {
      if (!hasEnoughAccounts) {
        console.log('SKIPPED - not enough accounts');
        return;
      }
      // Alice deposits 1000 tokens
      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 1000_000_000);

      // Bob deposits 500 tokens
      await performUserOptIn(algod, deployment, bob);
      await performDeposit(algod, deployment, bob, 500_000_000);

      // Charlie deposits 300 tokens
      await performUserOptIn(algod, deployment, charlie);
      await performDeposit(algod, deployment, charlie, 300_000_000);

      // Dave deposits 200 tokens
      await performUserOptIn(algod, deployment, dave);
      await performDeposit(algod, deployment, dave, 200_000_000);

      const stats = await getVaultStats(algod, deployment);
      // Total = 1000 + 500 + 300 + 200 = 2000 tokens
      expect(stats.totalDeposits).toBe(2000_000_000);

      console.log('Phase 1 - Total deposits:', stats.totalDeposits / 1_000_000);
    });

    it('Phase 2: First yield swap - everyone has deposits', async () => {
      if (!hasEnoughAccounts) return;
      // Swap 100 USDC worth of yield
      const yieldAmount = 100_000_000;
      await performSwapYield(algod, deployment, creator, yieldAmount, 100);

      const stats = await getVaultStats(algod, deployment);

      // With 1:1 pool and 0.3% fee, swap output ≈ 99.7 IBUS
      // Creator gets 20% ≈ 19.94 IBUS
      // Users get 80% ≈ 79.76 IBUS

      // Check proportional distribution:
      // Alice (1000/2000 = 50%): ~39.88 IBUS
      // Bob (500/2000 = 25%): ~19.94 IBUS
      // Charlie (300/2000 = 15%): ~11.96 IBUS
      // Dave (200/2000 = 10%): ~7.97 IBUS

      const alicePending = await getPendingYield(algod, deployment, alice.addr);
      const bobPending = await getPendingYield(algod, deployment, bob.addr);
      const charliePending = await getPendingYield(algod, deployment, charlie.addr);
      const davePending = await getPendingYield(algod, deployment, dave.addr);

      console.log('Phase 2 - Pending yields:');
      console.log('  Alice:', alicePending / 1_000_000);
      console.log('  Bob:', bobPending / 1_000_000);
      console.log('  Charlie:', charliePending / 1_000_000);
      console.log('  Dave:', davePending / 1_000_000);
      console.log('  Creator:', stats.creatorUnclaimedYield / 1_000_000);

      // Verify ratios (Alice should have 2x Bob, etc.)
      expect(alicePending / bobPending).toBeCloseTo(2.0, 1);
      expect(bobPending / davePending).toBeCloseTo(2.5, 1);
      expect(charliePending / davePending).toBeCloseTo(1.5, 1);

      // Verify creator gets ~20%
      const totalUserPending = alicePending + bobPending + charliePending + davePending;
      const creatorRatio = stats.creatorUnclaimedYield / (totalUserPending + stats.creatorUnclaimedYield);
      expect(creatorRatio).toBeCloseTo(0.2, 1);
    });

    it('Phase 3: Alice claims, Bob withdraws partially', async () => {
      if (!hasEnoughAccounts) return;
      // Alice claims her yield
      const aliceIbusBefore = await getAssetBalance(algod, alice.addr, deployment.ibusAssetId);
      const alicePendingBefore = await getPendingYield(algod, deployment, alice.addr);
      await performClaim(algod, deployment, alice);
      const aliceIbusAfter = await getAssetBalance(algod, alice.addr, deployment.ibusAssetId);

      const aliceClaimed = aliceIbusAfter - aliceIbusBefore;
      expect(aliceClaimed).toBeCloseTo(alicePendingBefore, -3); // Within 1000 micro-units (rounding)

      // Alice's pending should now be 0
      const alicePendingAfterClaim = await getPendingYield(algod, deployment, alice.addr);
      expect(alicePendingAfterClaim).toBe(0);

      // Bob withdraws 200 tokens (keeps 300)
      await performWithdraw(algod, deployment, bob, 200_000_000);
      const bobDeposit = await getUserDeposit(algod, deployment, bob.addr);
      expect(bobDeposit).toBe(300_000_000);

      // Bob's pending yield should be crystallized (moved to earnedYield)
      const bobPending = await getPendingYield(algod, deployment, bob.addr);
      expect(bobPending).toBeGreaterThan(0); // He still has pending from phase 2

      console.log('Phase 3 - Alice claimed:', aliceClaimed / 1_000_000);
      console.log('Phase 3 - Bob deposit after withdrawal:', bobDeposit / 1_000_000);
    });

    it('Phase 4: Second yield swap - changed deposit ratios', async () => {
      if (!hasEnoughAccounts) return;
      // Now: Alice 1000, Bob 300, Charlie 300, Dave 200 = 1800 total
      const statsBefore = await getVaultStats(algod, deployment);
      expect(statsBefore.totalDeposits).toBe(1800_000_000);

      // Track pending before second swap
      const alicePendingBefore = await getPendingYield(algod, deployment, alice.addr);
      const bobPendingBefore = await getPendingYield(algod, deployment, bob.addr);
      const charliePendingBefore = await getPendingYield(algod, deployment, charlie.addr);
      const davePendingBefore = await getPendingYield(algod, deployment, dave.addr);

      // Second swap: 50 USDC
      await performSwapYield(algod, deployment, creator, 50_000_000, 100);

      const alicePendingAfter = await getPendingYield(algod, deployment, alice.addr);
      const bobPendingAfter = await getPendingYield(algod, deployment, bob.addr);
      const charliePendingAfter = await getPendingYield(algod, deployment, charlie.addr);
      const davePendingAfter = await getPendingYield(algod, deployment, dave.addr);

      // Alice claimed earlier, so her pending is just from this swap
      // Bob had pending from phase 2 PLUS crystallized on withdraw, PLUS this swap
      // Charlie and Dave accumulated from both swaps

      console.log('Phase 4 - Pending changes:');
      console.log('  Alice:', alicePendingBefore / 1_000_000, '->', alicePendingAfter / 1_000_000);
      console.log('  Bob:', bobPendingBefore / 1_000_000, '->', bobPendingAfter / 1_000_000);
      console.log('  Charlie:', charliePendingBefore / 1_000_000, '->', charliePendingAfter / 1_000_000);
      console.log('  Dave:', davePendingBefore / 1_000_000, '->', davePendingAfter / 1_000_000);

      // Everyone should have gained yield
      expect(alicePendingAfter).toBeGreaterThan(alicePendingBefore);
      expect(bobPendingAfter).toBeGreaterThan(bobPendingBefore);
      expect(charliePendingAfter).toBeGreaterThan(charliePendingBefore);
      expect(davePendingAfter).toBeGreaterThan(davePendingBefore);
    });

    it('Phase 5: Charlie closes out completely', async () => {
      if (!hasEnoughAccounts) return;
      const charlieAlphaBefore = await getAssetBalance(algod, charlie.addr, deployment.alphaAssetId);
      const charlieIbusBefore = await getAssetBalance(algod, charlie.addr, deployment.ibusAssetId);
      const charliePending = await getPendingYield(algod, deployment, charlie.addr);
      const charlieDeposit = await getUserDeposit(algod, deployment, charlie.addr);

      await performCloseOut(algod, deployment, charlie);

      const charlieAlphaAfter = await getAssetBalance(algod, charlie.addr, deployment.alphaAssetId);
      const charlieIbusAfter = await getAssetBalance(algod, charlie.addr, deployment.ibusAssetId);

      // Charlie should get his deposit back
      expect(charlieAlphaAfter - charlieAlphaBefore).toBe(charlieDeposit);

      // Charlie should get his accumulated yield
      const charlieYieldReceived = charlieIbusAfter - charlieIbusBefore;
      expect(charlieYieldReceived).toBeCloseTo(charliePending, -3);

      console.log('Phase 5 - Charlie closed out:');
      console.log('  Deposit returned:', charlieDeposit / 1_000_000);
      console.log('  Yield received:', charlieYieldReceived / 1_000_000);

      // Total deposits should decrease
      const stats = await getVaultStats(algod, deployment);
      expect(stats.totalDeposits).toBe(1500_000_000); // 1800 - 300
    });

    it('Phase 6: Dave deposits more, then third swap', async () => {
      if (!hasEnoughAccounts) return;
      // Dave adds 500 more (now has 700 total)
      const davePendingBefore = await getPendingYield(algod, deployment, dave.addr);
      await performDeposit(algod, deployment, dave, 500_000_000);

      // His pending should be crystallized (same value, just moved to earnedYield)
      const davePendingAfterDeposit = await getPendingYield(algod, deployment, dave.addr);
      expect(davePendingAfterDeposit).toBeCloseTo(davePendingBefore, -3);

      const daveDeposit = await getUserDeposit(algod, deployment, dave.addr);
      expect(daveDeposit).toBe(700_000_000);

      // Now: Alice 1000, Bob 300, Dave 700 = 2000 total
      const statsBefore = await getVaultStats(algod, deployment);
      expect(statsBefore.totalDeposits).toBe(2000_000_000);

      // Third swap: 80 USDC
      await performSwapYield(algod, deployment, creator, 80_000_000, 100);

      // New ratios: Alice 50%, Bob 15%, Dave 35%
      const alicePending = await getPendingYield(algod, deployment, alice.addr);
      const bobPending = await getPendingYield(algod, deployment, bob.addr);
      const davePending = await getPendingYield(algod, deployment, dave.addr);

      console.log('Phase 6 - After third swap:');
      console.log('  Alice pending:', alicePending / 1_000_000);
      console.log('  Bob pending:', bobPending / 1_000_000);
      console.log('  Dave pending:', davePending / 1_000_000);

      // Dave should have more than Bob now (700 vs 300)
      expect(davePending).toBeGreaterThan(bobPending);
    });

    it('Phase 7: Creator claims accumulated fees', async () => {
      if (!hasEnoughAccounts) return;
      const stats = await getVaultStats(algod, deployment);
      const expectedCreatorYield = stats.creatorUnclaimedYield;

      console.log('Phase 7 - Creator accumulated fees:', expectedCreatorYield / 1_000_000);

      const creatorIbusBefore = await getAssetBalance(algod, creator.addr, deployment.ibusAssetId);
      await performClaimCreator(algod, deployment, creator);
      const creatorIbusAfter = await getAssetBalance(algod, creator.addr, deployment.ibusAssetId);

      const creatorClaimed = creatorIbusAfter - creatorIbusBefore;
      expect(creatorClaimed).toBe(expectedCreatorYield);

      const statsAfter = await getVaultStats(algod, deployment);
      expect(statsAfter.creatorUnclaimedYield).toBe(0);

      console.log('Phase 7 - Creator claimed:', creatorClaimed / 1_000_000);
    });

    it('Phase 8: Everyone claims/closes and verify no stuck funds', async () => {
      if (!hasEnoughAccounts) return;
      // Get vault balance before final claims
      const vaultIbusBefore = await getAssetBalance(algod, deployment.vaultAddress, deployment.ibusAssetId);

      // Alice claims
      const alicePending = await getPendingYield(algod, deployment, alice.addr);
      if (alicePending > 0) {
        await performClaim(algod, deployment, alice);
      }

      // Bob closes out
      await performCloseOut(algod, deployment, bob);

      // Dave closes out
      await performCloseOut(algod, deployment, dave);

      // Final stats
      const finalStats = await getVaultStats(algod, deployment);
      expect(finalStats.totalDeposits).toBe(1000_000_000); // Only Alice left

      // Check vault IBUS balance
      const vaultIbusAfter = await getAssetBalance(algod, deployment.vaultAddress, deployment.ibusAssetId);

      console.log('Phase 8 - Final state:');
      console.log('  Total deposits:', finalStats.totalDeposits / 1_000_000);
      console.log('  Vault IBUS before:', vaultIbusBefore / 1_000_000);
      console.log('  Vault IBUS after:', vaultIbusAfter / 1_000_000);
      console.log('  Creator unclaimed:', finalStats.creatorUnclaimedYield / 1_000_000);

      // There might be tiny dust from rounding, but should be < 100 micro-units per user
      // With 4 users max, dust should be < 400 micro-units
      expect(vaultIbusAfter).toBeLessThan(1000); // Less than 0.001 IBUS dust

      // Verify Alice can still withdraw her deposit
      const aliceDeposit = await getUserDeposit(algod, deployment, alice.addr);
      expect(aliceDeposit).toBe(1000_000_000);
    });

    it('Phase 9: Alice final withdrawal - no funds stuck', async () => {
      if (!hasEnoughAccounts) return;
      const aliceAlphaBefore = await getAssetBalance(algod, alice.addr, deployment.alphaAssetId);
      const aliceDeposit = await getUserDeposit(algod, deployment, alice.addr);

      await performWithdraw(algod, deployment, alice, 0); // Withdraw all

      const aliceAlphaAfter = await getAssetBalance(algod, alice.addr, deployment.alphaAssetId);
      expect(aliceAlphaAfter - aliceAlphaBefore).toBe(aliceDeposit);

      const finalStats = await getVaultStats(algod, deployment);
      expect(finalStats.totalDeposits).toBe(0);

      console.log('Phase 9 - All funds withdrawn, totalDeposits:', finalStats.totalDeposits);
    });
  });

  /**
   * ROUNDING ERROR ANALYSIS
   * Test edge cases that might cause precision loss
   */
  describe('Rounding Error Analysis', () => {
    it('should handle odd deposit amounts without significant loss', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      // Odd prime number deposits to test rounding
      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, bob, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await optInToAsset(algod, bob, deployment.ibusAssetId);

      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 5_000_000_000);
      await fundAsset(algod, creator, bob.addr, deployment.alphaAssetId, 5_000_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performUserOptIn(algod, deployment, bob);

      // Prime number deposits: 7 and 13 tokens
      await performDeposit(algod, deployment, alice, 7_000_000);
      await performDeposit(algod, deployment, bob, 13_000_000);

      // Yield: 3 USDC (another prime)
      await performSwapYield(algod, deployment, creator, 3_000_000, 100);

      const alicePending = await getPendingYield(algod, deployment, alice.addr);
      const bobPending = await getPendingYield(algod, deployment, bob.addr);

      // Alice has 7/20 = 35%, Bob has 13/20 = 65%
      const ratio = bobPending / alicePending;
      expect(ratio).toBeCloseTo(13 / 7, 1); // Should be ~1.857

      console.log('Rounding test - Primes:');
      console.log('  Alice (7 tokens):', alicePending / 1_000_000);
      console.log('  Bob (13 tokens):', bobPending / 1_000_000);
      console.log('  Ratio:', ratio, '(expected:', 13 / 7, ')');
    });

    it('should handle very small yield distribution', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 5_000_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 1000_000_000); // 1000 tokens

      // Minimum yield: 2 USDC (threshold)
      await performSwapYield(algod, deployment, creator, 2_000_000, 100);

      const pending = await getPendingYield(algod, deployment, alice.addr);
      expect(pending).toBeGreaterThan(0);

      console.log('Small yield test - 2 USDC on 1000 tokens:', pending / 1_000_000, 'IBUS');
    });

    it('should handle large deposit with small yield', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 50_000_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 10_000_000_000); // 10,000 tokens

      // Small yield relative to deposit
      await performSwapYield(algod, deployment, creator, 2_000_000, 100);

      const pending = await getPendingYield(algod, deployment, alice.addr);
      expect(pending).toBeGreaterThan(0);

      console.log('Large deposit test - 2 USDC on 10,000 tokens:', pending / 1_000_000, 'IBUS');
    });
  });

  /**
   * SECURITY EDGE CASES
   */
  describe('Security Edge Cases', () => {
    it('should prevent double-claiming via rapid transactions', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 5_000_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);
      await performSwapYield(algod, deployment, creator, 50_000_000, 100);

      // First claim
      await performClaim(algod, deployment, alice);

      // Second claim should fail (nothing to claim)
      await expect(performClaim(algod, deployment, alice)).rejects.toThrow();
    });

    it('should handle deposit-claim-deposit-claim correctly', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 5_000_000_000);

      await performUserOptIn(algod, deployment, alice);

      // Round 1
      await performDeposit(algod, deployment, alice, 100_000_000);
      await performSwapYield(algod, deployment, creator, 10_000_000, 100);
      const yield1 = await getPendingYield(algod, deployment, alice.addr);
      await performClaim(algod, deployment, alice);

      // Round 2 - deposit more
      await performDeposit(algod, deployment, alice, 200_000_000);
      await performSwapYield(algod, deployment, creator, 20_000_000, 100);
      const yield2 = await getPendingYield(algod, deployment, alice.addr);
      await performClaim(algod, deployment, alice);

      // Yield 2 should be based on 300 tokens, not 100
      // But the USDC amount was also 2x, so net yield should be higher
      expect(yield2).toBeGreaterThan(yield1);

      console.log('Deposit-claim cycles:');
      console.log('  Round 1 (100 tokens, 10 USDC):', yield1 / 1_000_000);
      console.log('  Round 2 (300 tokens, 20 USDC):', yield2 / 1_000_000);
    });

    it('should correctly handle creator with 20% fee over multiple swaps', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 20,
        minSwapThreshold: 2_000_000,
        poolReserveUsdc: 100_000_000_000,
        poolReserveIbus: 100_000_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 5_000_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 1000_000_000);

      // Multiple small swaps
      let totalCreatorFees = 0;
      let totalUserYield = 0;

      for (let i = 0; i < 5; i++) {
        await performSwapYield(algod, deployment, creator, 10_000_000, 100);
      }

      const stats = await getVaultStats(algod, deployment);
      const alicePending = await getPendingYield(algod, deployment, alice.addr);

      // Creator should have ~20% of total
      const totalYield = stats.creatorUnclaimedYield + alicePending;
      const creatorRatio = stats.creatorUnclaimedYield / totalYield;

      console.log('Creator fee test over 5 swaps:');
      console.log('  Total yield distributed:', totalYield / 1_000_000);
      console.log('  Creator fee:', stats.creatorUnclaimedYield / 1_000_000);
      console.log('  User yield:', alicePending / 1_000_000);
      console.log('  Creator ratio:', (creatorRatio * 100).toFixed(2) + '%');

      expect(creatorRatio).toBeCloseTo(0.2, 1); // ~20% to creator
    });
  });
});
