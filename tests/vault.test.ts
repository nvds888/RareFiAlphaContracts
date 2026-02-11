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
  performContributeFarm,
  performSetFarmEmissionRate,
  performUpdateCreatorFeeRate,
  getFarmStats,
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
        creatorFeeRate: 5,
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
        creatorFeeRate: 5, // 5%
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
      // Creator fee = 5% of that
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
        creatorFeeRate: 5,
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

    it('should handle maximum 6% fee rate correctly', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 6, // Maximum allowed
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
      expect(stats.creatorUnclaimedYield).toBeGreaterThan(0); // Creator gets 6%

      // User gets 94%
      const pending = await getPendingYield(algod, deployment, bob.addr);
      expect(pending).toBeGreaterThan(0);

      // Verify ~6% to creator
      const totalYield = stats.creatorUnclaimedYield + pending;
      const creatorRatio = stats.creatorUnclaimedYield / totalYield;
      expect(creatorRatio).toBeCloseTo(0.06, 2);
    });

    it('should allow anyone to call swapYield (permissionless)', async () => {
      const deployment = await deployVaultForTest(algod, creator);

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.usdcAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 100_000_000);
      await fundAsset(algod, creator, alice.addr, deployment.usdcAssetId, 100_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);

      // Alice calls swapYield - should succeed (permissionless)
      await performSwapYield(algod, deployment, alice, 10_000_000, 100);

      const stats = await getVaultStats(algod, deployment);
      expect(stats.usdcBalance).toBe(0); // USDC was swapped
      expect(stats.yieldPerToken).toBeGreaterThan(0);
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

    // Track everything for verification
    let totalYieldDistributed = 0;
    let totalCreatorFee = 0;
    let totalUserYield = 0;

    beforeAll(async () => {
      // Generate additional accounts programmatically
      const charlieAccount = algosdk.generateAccount();
      const daveAccount = algosdk.generateAccount();

      charlie = { addr: charlieAccount.addr.toString(), sk: charlieAccount.sk };
      dave = { addr: daveAccount.addr.toString(), sk: daveAccount.sk };

      // Fund new accounts with ALGO from creator
      const suggestedParams = await algod.getTransactionParams().do();
      const fundCharlieTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: creator.addr,
        receiver: charlie.addr,
        amount: 10_000_000, // 10 ALGO
        suggestedParams,
      });
      const fundDaveTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: creator.addr,
        receiver: dave.addr,
        amount: 10_000_000, // 10 ALGO
        suggestedParams,
      });

      const signedFundCharlie = fundCharlieTxn.signTxn(creator.sk);
      const signedFundDave = fundDaveTxn.signTxn(creator.sk);

      await algod.sendRawTransaction(signedFundCharlie).do();
      const { txid } = await algod.sendRawTransaction(signedFundDave).do();
      await algosdk.waitForConfirmation(algod, txid, 5);

      // Deploy with 5% creator fee
      deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 5, // 5%
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
            // Swap 100 USDC worth of yield
      const yieldAmount = 100_000_000;
      await performSwapYield(algod, deployment, creator, yieldAmount, 100);

      const stats = await getVaultStats(algod, deployment);

      // With 1:1 pool and 0.3% fee, swap output ≈ 99.7 IBUS
      // Creator gets 5% ≈ 4.98 IBUS
      // Users get 95% ≈ 94.71 IBUS

      // Check proportional distribution:
      // Alice (1000/2000 = 50%): ~47.36 IBUS
      // Bob (500/2000 = 25%): ~23.68 IBUS
      // Charlie (300/2000 = 15%): ~14.21 IBUS
      // Dave (200/2000 = 10%): ~9.47 IBUS

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

      // Verify creator gets ~5%
      const totalUserPending = alicePending + bobPending + charliePending + davePending;
      const creatorRatio = stats.creatorUnclaimedYield / (totalUserPending + stats.creatorUnclaimedYield);
      expect(creatorRatio).toBeCloseTo(0.05, 2);
    });

    it('Phase 3: Alice claims, Bob withdraws partially', async () => {
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

      // Note: Total pending includes historical yield.
      // Bob accumulated more yield early (500 tokens vs Dave's 200)
      // Dave only recently increased to 700 tokens.
      // From the third swap alone (80 USDC), Dave (35%) got more than Bob (15%)
      // But Bob's total is higher due to historical accumulation.
      // This is correct behavior - accumulator pattern preserves historical entitlements.

      // Verify all users have pending yield
      expect(alicePending).toBeGreaterThan(0);
      expect(bobPending).toBeGreaterThan(0);
      expect(davePending).toBeGreaterThan(0);

      // Alice (50% of 2000) should have more than both
      expect(alicePending).toBeGreaterThan(bobPending);
      expect(alicePending).toBeGreaterThan(davePending);
    });

    it('Phase 7: Creator claims accumulated fees', async () => {
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

    it('should correctly handle creator with 5% fee over multiple swaps', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 5,
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

      // Creator should have ~5% of total
      const totalYield = stats.creatorUnclaimedYield + alicePending;
      const creatorRatio = stats.creatorUnclaimedYield / totalYield;

      console.log('Creator fee test over 5 swaps:');
      console.log('  Total yield distributed:', totalYield / 1_000_000);
      console.log('  Creator fee:', stats.creatorUnclaimedYield / 1_000_000);
      console.log('  User yield:', alicePending / 1_000_000);
      console.log('  Creator ratio:', (creatorRatio * 100).toFixed(2) + '%');

      expect(creatorRatio).toBeCloseTo(0.05, 2); // ~5% to creator
    });
  });

  /**
   * AUTO-SWAP ON DEPOSIT
   * Tests that deposits automatically trigger a swap when USDC balance >= minSwapThreshold
   * This protects against flash deposits by swapping BEFORE the new deposit is credited.
   */
  describe('Auto-Swap on Deposit', () => {
    let deployment: VaultDeploymentResult;
    const MIN_SWAP_THRESHOLD = 10_000_000; // 10 USDC threshold for testing

    beforeAll(async () => {
      deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: MIN_SWAP_THRESHOLD,
      });

      // Setup Alice with Alpha tokens
      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 5_000_000_000);

      // Alice opts in and makes initial deposit (before any USDC arrives)
      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);
    });

    it('should allow deposits when USDC balance is below threshold (no auto-swap)', async () => {
      // Send USDC below threshold (5 USDC, threshold is 10 USDC)
      const belowThreshold = MIN_SWAP_THRESHOLD - 5_000_000; // 5 USDC
      await fundAsset(algod, creator, deployment.vaultAddress, deployment.usdcAssetId, belowThreshold);

      // Check vault USDC balance
      const stats = await getVaultStats(algod, deployment);
      expect(stats.usdcBalance).toBe(belowThreshold);
      expect(stats.usdcBalance).toBeLessThan(MIN_SWAP_THRESHOLD);

      // Deposit should succeed without triggering swap
      await performDeposit(algod, deployment, alice, 10_000_000);

      const deposit = await getUserDeposit(algod, deployment, alice.addr);
      expect(deposit).toBe(110_000_000); // 100 + 10

      // USDC should still be there (no swap triggered)
      const statsAfter = await getVaultStats(algod, deployment);
      expect(statsAfter.usdcBalance).toBe(belowThreshold);

      console.log('Below threshold: Deposit succeeded without auto-swap, USDC balance:', belowThreshold / 1_000_000);
    });

    it('should AUTO-SWAP when USDC balance meets threshold on deposit', async () => {
      // Add more USDC to reach exactly the threshold
      const currentStats = await getVaultStats(algod, deployment);
      const toAdd = MIN_SWAP_THRESHOLD - currentStats.usdcBalance;
      if (toAdd > 0) {
        await fundAsset(algod, creator, deployment.vaultAddress, deployment.usdcAssetId, toAdd);
      }

      // Verify USDC is at threshold
      const statsBefore = await getVaultStats(algod, deployment);
      expect(statsBefore.usdcBalance).toBe(MIN_SWAP_THRESHOLD);
      const yieldPerTokenBefore = statsBefore.yieldPerToken;

      console.log('At threshold: USDC balance is exactly', statsBefore.usdcBalance / 1_000_000);

      // Deposit should trigger auto-swap THEN process deposit
      await performDeposit(algod, deployment, alice, 10_000_000);

      const statsAfter = await getVaultStats(algod, deployment);

      // USDC should be 0 after auto-swap
      expect(statsAfter.usdcBalance).toBe(0);

      // yieldPerToken should increase (yield distributed to existing holders before new deposit)
      expect(statsAfter.yieldPerToken).toBeGreaterThan(yieldPerTokenBefore);

      console.log('Auto-swap triggered: USDC balance now', statsAfter.usdcBalance);
      console.log('yieldPerToken increased from', yieldPerTokenBefore / SCALE, 'to', statsAfter.yieldPerToken / SCALE);
    });

    it('should allow withdrawals when USDC balance is at threshold', async () => {
      // Add USDC to reach threshold
      await fundAsset(algod, creator, deployment.vaultAddress, deployment.usdcAssetId, MIN_SWAP_THRESHOLD);

      const stats = await getVaultStats(algod, deployment);
      expect(stats.usdcBalance).toBeGreaterThanOrEqual(MIN_SWAP_THRESHOLD);

      // Withdrawal should succeed (no swap needed)
      const depositBefore = await getUserDeposit(algod, deployment, alice.addr);
      await performWithdraw(algod, deployment, alice, 10_000_000);
      const depositAfter = await getUserDeposit(algod, deployment, alice.addr);

      expect(depositAfter).toBe(depositBefore - 10_000_000);
      console.log('At threshold: Withdrawal succeeded');
    });

    it('should give new depositor correct yield (not capturing pre-existing yield)', async () => {
      // Setup fresh deployment
      const deployment2 = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: MIN_SWAP_THRESHOLD,
      });

      // Setup Alice (existing depositor)
      await optInToAsset(algod, alice, deployment2.alphaAssetId);
      await optInToAsset(algod, alice, deployment2.ibusAssetId);
      await fundAsset(algod, creator, alice.addr, deployment2.alphaAssetId, 5_000_000_000);

      await performUserOptIn(algod, deployment2, alice);
      await performDeposit(algod, deployment2, alice, 100_000_000);

      // USDC yield arrives at threshold
      await fundAsset(algod, creator, deployment2.vaultAddress, deployment2.usdcAssetId, MIN_SWAP_THRESHOLD);

      // Setup Bob (new depositor who will trigger auto-swap)
      await optInToAsset(algod, bob, deployment2.alphaAssetId);
      await optInToAsset(algod, bob, deployment2.ibusAssetId);
      await fundAsset(algod, creator, bob.addr, deployment2.alphaAssetId, 1_000_000_000);
      await performUserOptIn(algod, deployment2, bob);

      // Get Alice's pending yield before Bob's deposit
      const alicePendingBefore = await getPendingYield(algod, deployment2, alice.addr);

      // Bob deposits - should trigger auto-swap first, then process his deposit
      await performDeposit(algod, deployment2, bob, 100_000_000);

      // Alice should have received all the yield (she was the only depositor when swap happened)
      const alicePendingAfter = await getPendingYield(algod, deployment2, alice.addr);
      expect(alicePendingAfter).toBeGreaterThan(alicePendingBefore);

      // Bob should have 0 pending yield (he wasn't deposited during the swap)
      const bobPending = await getPendingYield(algod, deployment2, bob.addr);
      expect(bobPending).toBe(0);

      console.log('Alice pending yield: before', alicePendingBefore / 1_000_000, 'after', alicePendingAfter / 1_000_000);
      console.log('Bob pending yield:', bobPending / 1_000_000);
      console.log('Flash deposit protected: Bob did not capture pre-existing yield');
    });
  });

  /**
   * FLASH DEPOSIT ATTACK SCENARIO
   * Demonstrates that auto-swap on deposit prevents yield theft by
   * distributing yield to existing depositors BEFORE the new deposit is credited.
   */
  describe('Flash Deposit Attack Prevention', () => {
    it('should prevent attacker from stealing yield via flash deposit (auto-swap protection)', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 10_000_000, // 10 USDC
      });

      // Setup Alice (legitimate user)
      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 1_000_000_000);

      // Setup Bob (attacker)
      await optInToAsset(algod, bob, deployment.alphaAssetId);
      await optInToAsset(algod, bob, deployment.ibusAssetId);
      await fundAsset(algod, creator, bob.addr, deployment.alphaAssetId, 1_000_000_000);

      // Alice deposits first (legitimate user)
      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);

      console.log('Setup: Alice deposited 100 tokens');

      // USDC airdrop arrives at the vault (simulating Alpha Arcade airdrop)
      const yieldAmount = 50_000_000; // 50 USDC
      await fundAsset(algod, creator, deployment.vaultAddress, deployment.usdcAssetId, yieldAmount);

      console.log('Airdrop: 50 USDC arrived at vault');

      // Bob (attacker) opts in
      await performUserOptIn(algod, deployment, bob);

      // ATTACK ATTEMPT: Bob tries to deposit when yield is pending
      // With auto-swap, this will succeed BUT the swap happens FIRST
      // So Alice gets all the yield, THEN Bob's deposit is credited
      await performDeposit(algod, deployment, bob, 100_000_000);

      console.log('Bob deposited - auto-swap executed first');

      // Check yield distribution
      const alicePending = await getPendingYield(algod, deployment, alice.addr);
      const bobPending = await getPendingYield(algod, deployment, bob.addr);

      // Alice gets 100% of the yield (she was the only depositor when swap happened)
      // With 50 USDC swapped at ~1:1 rate minus 0.3% fee = ~49.85 IBUS
      expect(alicePending).toBeGreaterThan(49_000_000);

      // Bob has 0 pending yield (he wasn't deposited when swap happened)
      expect(bobPending).toBe(0);

      console.log('Result: Alice receives all yield:', alicePending / 1_000_000, 'IBUS');
      console.log('Attack prevented: Bob got 0 from pre-existing yield');

      // Verify both have correct deposits
      const aliceDeposit = await getUserDeposit(algod, deployment, alice.addr);
      const bobDeposit = await getUserDeposit(algod, deployment, bob.addr);
      expect(aliceDeposit).toBe(100_000_000);
      expect(bobDeposit).toBe(100_000_000);

      console.log('Both users have their deposits:', aliceDeposit / 1_000_000, 'and', bobDeposit / 1_000_000);
    });
  });

  /**
   * COMPREHENSIVE MULTI-USER STRESS TEST
   * Tests with 6 users, varying deposit sizes from very small (1.2 ALPHA) to very large (500k ALPHA)
   * This tests accounting precision across extreme ranges
   */
  describe('Multi-User Stress Test - Extreme Balance Ranges', () => {
    let deployment: VaultDeploymentResult;
    let charlie: { addr: string; sk: Uint8Array };
    let dave: { addr: string; sk: Uint8Array };
    let eve: { addr: string; sk: Uint8Array };
    let frank: { addr: string; sk: Uint8Array };

    // Using 6 decimals: 1 ALPHA = 1_000_000 microAlpha
    const WHALE_DEPOSIT = 500_000_000_000;      // 500,000 ALPHA (whale)
    const LARGE_DEPOSIT = 50_000_000_000;       // 50,000 ALPHA
    const MEDIUM_DEPOSIT = 5_000_000_000;       // 5,000 ALPHA
    const SMALL_DEPOSIT = 100_000_000;          // 100 ALPHA
    const TINY_DEPOSIT = 10_000_000;            // 10 ALPHA
    const MICRO_DEPOSIT = 1_200_000;            // 1.2 ALPHA (just above minimum)

    beforeAll(async () => {
      // Generate additional accounts
      const charlieAccount = algosdk.generateAccount();
      const daveAccount = algosdk.generateAccount();
      const eveAccount = algosdk.generateAccount();
      const frankAccount = algosdk.generateAccount();

      charlie = { addr: charlieAccount.addr.toString(), sk: charlieAccount.sk };
      dave = { addr: daveAccount.addr.toString(), sk: daveAccount.sk };
      eve = { addr: eveAccount.addr.toString(), sk: eveAccount.sk };
      frank = { addr: frankAccount.addr.toString(), sk: frankAccount.sk };

      // Fund new accounts with ALGO
      const suggestedParams = await algod.getTransactionParams().do();
      for (const user of [charlie, dave, eve, frank]) {
        const fundTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender: creator.addr,
          receiver: user.addr,
          amount: 10_000_000, // 10 ALGO
          suggestedParams,
        });
        const signedFund = fundTxn.signTxn(creator.sk);
        const { txid } = await algod.sendRawTransaction(signedFund).do();
        await algosdk.waitForConfirmation(algod, txid, 5);
      }

      // Deploy with large pool reserves to handle whale deposits
      deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 5,
        minSwapThreshold: 2_000_000,
        poolReserveUsdc: 1_000_000_000_000,  // 1M USDC
        poolReserveIbus: 1_000_000_000_000,  // 1M IBUS
      });

      // Fund all users with Alpha and IBUS opt-in
      for (const user of [alice, bob, charlie, dave, eve, frank]) {
        await optInToAsset(algod, user, deployment.alphaAssetId);
        await optInToAsset(algod, user, deployment.ibusAssetId);
        await fundAsset(algod, creator, user.addr, deployment.alphaAssetId, WHALE_DEPOSIT * 2);
      }
    });

    it('Phase 1: Extreme range deposits - whale to micro', async () => {
      // Alice: Whale (500k ALPHA)
      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, WHALE_DEPOSIT);

      // Bob: Large (50k ALPHA)
      await performUserOptIn(algod, deployment, bob);
      await performDeposit(algod, deployment, bob, LARGE_DEPOSIT);

      // Charlie: Medium (5k ALPHA)
      await performUserOptIn(algod, deployment, charlie);
      await performDeposit(algod, deployment, charlie, MEDIUM_DEPOSIT);

      // Dave: Small (100 ALPHA)
      await performUserOptIn(algod, deployment, dave);
      await performDeposit(algod, deployment, dave, SMALL_DEPOSIT);

      // Eve: Tiny (10 ALPHA)
      await performUserOptIn(algod, deployment, eve);
      await performDeposit(algod, deployment, eve, TINY_DEPOSIT);

      // Frank: Micro (1.2 ALPHA)
      await performUserOptIn(algod, deployment, frank);
      await performDeposit(algod, deployment, frank, MICRO_DEPOSIT);

      const stats = await getVaultStats(algod, deployment);
      const expectedTotal = WHALE_DEPOSIT + LARGE_DEPOSIT + MEDIUM_DEPOSIT + SMALL_DEPOSIT + TINY_DEPOSIT + MICRO_DEPOSIT;
      expect(stats.totalDeposits).toBe(expectedTotal);

      console.log('Phase 1 - Deposits registered:');
      console.log('  Alice (whale):', WHALE_DEPOSIT / 1_000_000, 'ALPHA');
      console.log('  Bob (large):', LARGE_DEPOSIT / 1_000_000, 'ALPHA');
      console.log('  Charlie (medium):', MEDIUM_DEPOSIT / 1_000_000, 'ALPHA');
      console.log('  Dave (small):', SMALL_DEPOSIT / 1_000_000, 'ALPHA');
      console.log('  Eve (tiny):', TINY_DEPOSIT / 1_000_000, 'ALPHA');
      console.log('  Frank (micro):', MICRO_DEPOSIT / 1_000_000, 'ALPHA');
      console.log('  Total:', stats.totalDeposits / 1_000_000, 'ALPHA');
    });

    it('Phase 2: Large yield distribution - verify micro depositor gets yield', async () => {
      // Large yield: 10,000 USDC
      const largeYield = 10_000_000_000;
      await performSwapYield(algod, deployment, creator, largeYield, 100);

      const stats = await getVaultStats(algod, deployment);
      const totalDeposits = stats.totalDeposits;

      // Get pending yields
      const alicePending = await getPendingYield(algod, deployment, alice.addr);
      const bobPending = await getPendingYield(algod, deployment, bob.addr);
      const charliePending = await getPendingYield(algod, deployment, charlie.addr);
      const davePending = await getPendingYield(algod, deployment, dave.addr);
      const evePending = await getPendingYield(algod, deployment, eve.addr);
      const frankPending = await getPendingYield(algod, deployment, frank.addr);

      // Frank (micro depositor) should still get yield
      expect(frankPending).toBeGreaterThan(0);

      // Verify proportional distribution
      // Alice has ~90% of deposits, so should get ~90% of user yield
      const totalUserPending = alicePending + bobPending + charliePending + davePending + evePending + frankPending;
      const aliceRatio = alicePending / totalUserPending;
      const expectedAliceRatio = WHALE_DEPOSIT / totalDeposits;
      expect(aliceRatio).toBeCloseTo(expectedAliceRatio, 1);

      console.log('Phase 2 - Large yield (10k USDC):');
      console.log('  Alice pending:', alicePending / 1_000_000, 'IBUS');
      console.log('  Bob pending:', bobPending / 1_000_000, 'IBUS');
      console.log('  Charlie pending:', charliePending / 1_000_000, 'IBUS');
      console.log('  Dave pending:', davePending / 1_000_000, 'IBUS');
      console.log('  Eve pending:', evePending / 1_000_000, 'IBUS');
      console.log('  Frank (micro) pending:', frankPending / 1_000_000, 'IBUS');
      console.log('  Alice ratio:', (aliceRatio * 100).toFixed(2) + '%', '(expected:', (expectedAliceRatio * 100).toFixed(2) + '%)');
    });

    it('Phase 3: Multiple small yields - dust accumulation test', async () => {
      // 10 small yields of 5 USDC each (just above minimum)
      for (let i = 0; i < 10; i++) {
        await performSwapYield(algod, deployment, creator, 5_000_000, 100);
      }

      // Even micro depositor should have accumulated something
      const frankPending = await getPendingYield(algod, deployment, frank.addr);
      expect(frankPending).toBeGreaterThan(0);

      console.log('Phase 3 - After 10 small yields:');
      console.log('  Frank (micro) accumulated:', frankPending / 1_000_000, 'IBUS');
    });

    it('Phase 4: Whale withdrawal - verify accounting stays correct', async () => {
      // Alice withdraws half
      const aliceDepositBefore = await getUserDeposit(algod, deployment, alice.addr);
      const withdrawAmount = Math.floor(aliceDepositBefore / 2);

      await performWithdraw(algod, deployment, alice, withdrawAmount);

      const stats = await getVaultStats(algod, deployment);
      const aliceDepositAfter = await getUserDeposit(algod, deployment, alice.addr);

      expect(aliceDepositAfter).toBe(aliceDepositBefore - withdrawAmount);

      // Verify total deposits is correct
      const expectedTotal = aliceDepositAfter + LARGE_DEPOSIT + MEDIUM_DEPOSIT + SMALL_DEPOSIT + TINY_DEPOSIT + MICRO_DEPOSIT;
      expect(stats.totalDeposits).toBe(expectedTotal);

      console.log('Phase 4 - After whale partial withdrawal:');
      console.log('  Alice withdrew:', withdrawAmount / 1_000_000, 'ALPHA');
      console.log('  Alice remaining:', aliceDepositAfter / 1_000_000, 'ALPHA');
      console.log('  Total deposits:', stats.totalDeposits / 1_000_000, 'ALPHA');
    });

    it('Phase 5: Micro depositor claims and re-deposits', async () => {
      const frankPendingBefore = await getPendingYield(algod, deployment, frank.addr);

      // Frank claims
      const frankIbusBefore = await getAssetBalance(algod, frank.addr, deployment.ibusAssetId);
      await performClaim(algod, deployment, frank);
      const frankIbusAfter = await getAssetBalance(algod, frank.addr, deployment.ibusAssetId);

      const frankClaimed = frankIbusAfter - frankIbusBefore;
      expect(frankClaimed).toBeCloseTo(frankPendingBefore, -3);

      // Frank deposits more (doubling his position)
      await performDeposit(algod, deployment, frank, MICRO_DEPOSIT);

      const frankDepositAfter = await getUserDeposit(algod, deployment, frank.addr);
      expect(frankDepositAfter).toBe(MICRO_DEPOSIT * 2);

      console.log('Phase 5 - Frank (micro):');
      console.log('  Claimed:', frankClaimed / 1_000_000, 'IBUS');
      console.log('  New deposit:', frankDepositAfter / 1_000_000, 'ALPHA');
    });

    it('Phase 6: Very small yield - verify no one loses out', async () => {
      // Minimum yield (2 USDC)
      await performSwapYield(algod, deployment, creator, 2_000_000, 100);

      // All depositors should have pending yield
      const alicePending = await getPendingYield(algod, deployment, alice.addr);
      const frankPending = await getPendingYield(algod, deployment, frank.addr);

      expect(alicePending).toBeGreaterThan(0);
      // Frank may get 0 due to rounding with such small yield, but should not lose existing yield
      // The key is no negative yield or lost funds

      console.log('Phase 6 - After minimum yield:');
      console.log('  Alice pending:', alicePending / 1_000_000, 'IBUS');
      console.log('  Frank pending:', frankPending / 1_000_000, 'IBUS');
    });

    it('Phase 7: Final accounting verification - all users close out', async () => {
      // Track vault IBUS balance before close outs
      const vaultIbusBefore = await getAssetBalance(algod, deployment.vaultAddress, deployment.ibusAssetId);

      // Get creator fees
      const stats = await getVaultStats(algod, deployment);
      const creatorUnclaimedBefore = stats.creatorUnclaimedYield;

      // Everyone claims and closes out
      for (const user of [alice, bob, charlie, dave, eve, frank]) {
        const pending = await getPendingYield(algod, deployment, user.addr);
        if (pending > 0) {
          try {
            await performClaim(algod, deployment, user);
          } catch (e) {
            // May fail if 0 yield
          }
        }
        await performCloseOut(algod, deployment, user);
      }

      // Creator claims fees
      await performClaimCreator(algod, deployment, creator);

      // Final stats
      const finalStats = await getVaultStats(algod, deployment);
      expect(finalStats.totalDeposits).toBe(0);

      // Check for dust - should be minimal
      const vaultIbusAfter = await getAssetBalance(algod, deployment.vaultAddress, deployment.ibusAssetId);

      console.log('Phase 7 - Final accounting:');
      console.log('  Total deposits:', finalStats.totalDeposits);
      console.log('  Vault IBUS before:', vaultIbusBefore / 1_000_000);
      console.log('  Vault IBUS after (dust):', vaultIbusAfter / 1_000_000);
      console.log('  Creator claimed:', creatorUnclaimedBefore / 1_000_000, 'IBUS');

      // Dust should be minimal (less than 1 IBUS with 6 users)
      expect(vaultIbusAfter).toBeLessThan(1_000_000);
    });
  });

  /**
   * PRECISION AND ROUNDING DEEP DIVE
   * Tests edge cases for rounding errors with prime numbers and extreme ratios
   */
  describe('Precision and Rounding Deep Dive', () => {
    it('should handle prime number deposits with prime yield correctly', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      // Setup users
      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, bob, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await optInToAsset(algod, bob, deployment.ibusAssetId);

      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 100_000_000_000);
      await fundAsset(algod, creator, bob.addr, deployment.alphaAssetId, 100_000_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performUserOptIn(algod, deployment, bob);

      // Prime number deposits
      const aliceDeposit = 17_000_003; // Prime-ish
      const bobDeposit = 31_000_007;   // Prime-ish

      await performDeposit(algod, deployment, alice, aliceDeposit);
      await performDeposit(algod, deployment, bob, bobDeposit);

      // Prime yield
      const yieldAmount = 7_000_013; // Prime-ish

      await performSwapYield(algod, deployment, creator, yieldAmount, 100);

      const alicePending = await getPendingYield(algod, deployment, alice.addr);
      const bobPending = await getPendingYield(algod, deployment, bob.addr);

      // Expected ratio: Alice/Bob = 17_000_003 / 31_000_007 ≈ 0.548
      const actualRatio = alicePending / bobPending;
      const expectedRatio = aliceDeposit / bobDeposit;

      expect(actualRatio).toBeCloseTo(expectedRatio, 2);

      // Verify total pending matches vault IBUS balance
      const stats = await getVaultStats(algod, deployment);
      const totalPending = alicePending + bobPending;

      // Allow for small rounding difference (< 10 micro-units)
      expect(Math.abs(stats.swapAssetBalance - totalPending)).toBeLessThan(10);

      console.log('Prime number test:');
      console.log('  Alice deposit:', aliceDeposit);
      console.log('  Bob deposit:', bobDeposit);
      console.log('  Yield:', yieldAmount);
      console.log('  Alice pending:', alicePending);
      console.log('  Bob pending:', bobPending);
      console.log('  Actual ratio:', actualRatio.toFixed(6));
      console.log('  Expected ratio:', expectedRatio.toFixed(6));
      console.log('  Vault IBUS:', stats.swapAssetBalance);
      console.log('  Total pending:', totalPending);
      console.log('  Difference:', stats.swapAssetBalance - totalPending);
    });

    it('should handle extreme ratio (whale vs dust) without losing dust yield', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
        poolReserveUsdc: 1_000_000_000_000,
        poolReserveIbus: 1_000_000_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, bob, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await optInToAsset(algod, bob, deployment.ibusAssetId);

      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 600_000_000_000);
      await fundAsset(algod, creator, bob.addr, deployment.alphaAssetId, 10_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performUserOptIn(algod, deployment, bob);

      // Alice: 500,000 ALPHA (whale)
      // Bob: 1 ALPHA (dust)
      const whaleDeposit = 500_000_000_000;
      const dustDeposit = 1_000_000; // 1 ALPHA (minimum)

      await performDeposit(algod, deployment, alice, whaleDeposit);
      await performDeposit(algod, deployment, bob, dustDeposit);

      // Ratio is 500,000:1 = 500,000x difference

      // Large yield to ensure dust user gets something
      const yieldAmount = 100_000_000_000; // 100,000 USDC

      await performSwapYield(algod, deployment, creator, yieldAmount, 100);

      const bobPending = await getPendingYield(algod, deployment, bob.addr);

      // Bob should get ~0.0002% of yield ≈ 200 IBUS
      // With 1e9 scale, this should be detectable
      expect(bobPending).toBeGreaterThan(0);

      // Expected: ~(1/500001) * ~99700 IBUS = ~0.199 IBUS = ~199,000 microIBUS
      const expectedBobYield = Math.floor((dustDeposit / (whaleDeposit + dustDeposit)) * 99_700_000_000);

      console.log('Extreme ratio test (500,000:1):');
      console.log('  Alice (whale):', whaleDeposit / 1_000_000, 'ALPHA');
      console.log('  Bob (dust):', dustDeposit / 1_000_000, 'ALPHA');
      console.log('  Bob pending yield:', bobPending);
      console.log('  Expected (approx):', expectedBobYield);

      // Within 10% of expected (accounting for swap fees and rounding)
      expect(bobPending).toBeGreaterThan(expectedBobYield * 0.9);
      expect(bobPending).toBeLessThan(expectedBobYield * 1.1);
    });

    it('should accumulate many small yields without losing precision', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 100_000_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000); // 100 ALPHA

      // 20 minimum yields
      for (let i = 0; i < 20; i++) {
        await performSwapYield(algod, deployment, creator, 2_000_000, 100);
      }

      const pending = await getPendingYield(algod, deployment, alice.addr);
      const stats = await getVaultStats(algod, deployment);

      // Should have accumulated ~40 USDC worth of IBUS (minus fees)
      // Approximately 39.88 IBUS (0.3% swap fee on each)
      expect(pending).toBeGreaterThan(39_000_000);

      // Vault balance should match pending (Alice is only depositor)
      expect(Math.abs(stats.swapAssetBalance - pending)).toBeLessThan(100);

      console.log('Many small yields test (20x 2 USDC):');
      console.log('  Total pending:', pending / 1_000_000, 'IBUS');
      console.log('  Vault IBUS:', stats.swapAssetBalance / 1_000_000);
    });

    it('should handle deposit-withdraw-deposit cycle without yield loss', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 500_000_000_000);

      await performUserOptIn(algod, deployment, alice);

      let totalYieldReceived = 0;

      // Round 1: Deposit 100, get yield, claim
      await performDeposit(algod, deployment, alice, 100_000_000);
      await performSwapYield(algod, deployment, creator, 10_000_000, 100);

      let pending = await getPendingYield(algod, deployment, alice.addr);
      const ibusBefore1 = await getAssetBalance(algod, alice.addr, deployment.ibusAssetId);
      await performClaim(algod, deployment, alice);
      const ibusAfter1 = await getAssetBalance(algod, alice.addr, deployment.ibusAssetId);
      totalYieldReceived += (ibusAfter1 - ibusBefore1);

      // Withdraw all
      await performWithdraw(algod, deployment, alice, 0);

      // Round 2: Deposit 200, get yield, claim
      await performDeposit(algod, deployment, alice, 200_000_000);
      await performSwapYield(algod, deployment, creator, 20_000_000, 100);

      const ibusBefore2 = await getAssetBalance(algod, alice.addr, deployment.ibusAssetId);
      await performClaim(algod, deployment, alice);
      const ibusAfter2 = await getAssetBalance(algod, alice.addr, deployment.ibusAssetId);
      totalYieldReceived += (ibusAfter2 - ibusBefore2);

      // Withdraw all
      await performWithdraw(algod, deployment, alice, 0);

      // Round 3: Deposit 50, get yield, claim
      await performDeposit(algod, deployment, alice, 50_000_000);
      await performSwapYield(algod, deployment, creator, 5_000_000, 100);

      const ibusBefore3 = await getAssetBalance(algod, alice.addr, deployment.ibusAssetId);
      await performClaim(algod, deployment, alice);
      const ibusAfter3 = await getAssetBalance(algod, alice.addr, deployment.ibusAssetId);
      totalYieldReceived += (ibusAfter3 - ibusBefore3);

      // Final state check
      const finalStats = await getVaultStats(algod, deployment);

      console.log('Deposit-withdraw cycles:');
      console.log('  Round 1 yield:', (ibusAfter1 - ibusBefore1) / 1_000_000, 'IBUS');
      console.log('  Round 2 yield:', (ibusAfter2 - ibusBefore2) / 1_000_000, 'IBUS');
      console.log('  Round 3 yield:', (ibusAfter3 - ibusBefore3) / 1_000_000, 'IBUS');
      console.log('  Total received:', totalYieldReceived / 1_000_000, 'IBUS');
      console.log('  Vault IBUS remaining:', finalStats.swapAssetBalance);

      // Vault should have near-zero IBUS (all claimed)
      expect(finalStats.swapAssetBalance).toBeLessThan(100);
    });
  });

  /**
   * COMPREHENSIVE 10-PHASE MULTI-USER SCENARIO
   * Simulates a realistic usage pattern over time with varying user actions
   */
  describe('Comprehensive 10-Phase Real-World Scenario', () => {
    let deployment: VaultDeploymentResult;
    let charlie: { addr: string; sk: Uint8Array };
    let dave: { addr: string; sk: Uint8Array };

    // Track accounting
    let expectedTotalDeposits = 0;
    const userDeposits: Record<string, number> = {};
    const userYieldClaimed: Record<string, number> = {};

    beforeAll(async () => {
      const charlieAccount = algosdk.generateAccount();
      const daveAccount = algosdk.generateAccount();
      charlie = { addr: charlieAccount.addr.toString(), sk: charlieAccount.sk };
      dave = { addr: daveAccount.addr.toString(), sk: daveAccount.sk };

      const suggestedParams = await algod.getTransactionParams().do();
      for (const user of [charlie, dave]) {
        const fundTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender: creator.addr,
          receiver: user.addr,
          amount: 10_000_000,
          suggestedParams,
        });
        const signed = fundTxn.signTxn(creator.sk);
        const { txid } = await algod.sendRawTransaction(signed).do();
        await algosdk.waitForConfirmation(algod, txid, 5);
      }

      deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 5, // 5%
        minSwapThreshold: 5_000_000,
        poolReserveUsdc: 500_000_000_000,
        poolReserveIbus: 500_000_000_000,
      });

      for (const user of [alice, bob, charlie, dave]) {
        await optInToAsset(algod, user, deployment.alphaAssetId);
        await optInToAsset(algod, user, deployment.ibusAssetId);
        await fundAsset(algod, creator, user.addr, deployment.alphaAssetId, 200_000_000_000);
        userYieldClaimed[user.addr] = 0;
      }
    });

    it('Phase 1: Initial deposits - varying sizes', async () => {
      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000_000); // 100k ALPHA
      userDeposits['alice'] = 100_000_000_000;

      await performUserOptIn(algod, deployment, bob);
      await performDeposit(algod, deployment, bob, 25_000_000_000); // 25k ALPHA
      userDeposits['bob'] = 25_000_000_000;

      const stats = await getVaultStats(algod, deployment);
      expect(stats.totalDeposits).toBe(125_000_000_000);

      console.log('Phase 1: Alice 100k, Bob 25k');
    });

    it('Phase 2: First yield distribution', async () => {
      await performSwapYield(algod, deployment, creator, 1_000_000_000, 100); // 1000 USDC

      const alicePending = await getPendingYield(algod, deployment, alice.addr);
      const bobPending = await getPendingYield(algod, deployment, bob.addr);

      // Alice: 80%, Bob: 20% of user yield (creator gets 5%)
      expect(alicePending / bobPending).toBeCloseTo(4.0, 1);

      console.log('Phase 2: 1000 USDC yield distributed');
    });

    it('Phase 3: Charlie joins late', async () => {
      await performUserOptIn(algod, deployment, charlie);
      await performDeposit(algod, deployment, charlie, 50_000_000_000); // 50k ALPHA
      userDeposits['charlie'] = 50_000_000_000;

      // Charlie should have 0 pending (joined after yield)
      const charliePending = await getPendingYield(algod, deployment, charlie.addr);
      expect(charliePending).toBe(0);

      console.log('Phase 3: Charlie joined with 50k');
    });

    it('Phase 4: Second yield - includes Charlie', async () => {
      await performSwapYield(algod, deployment, creator, 500_000_000, 100); // 500 USDC

      const charliePending = await getPendingYield(algod, deployment, charlie.addr);
      expect(charliePending).toBeGreaterThan(0);

      console.log('Phase 4: 500 USDC yield, Charlie now has pending');
    });

    it('Phase 5: Alice partial withdrawal', async () => {
      // Alice withdraws 30k
      await performWithdraw(algod, deployment, alice, 30_000_000_000);
      userDeposits['alice'] -= 30_000_000_000;

      const aliceDeposit = await getUserDeposit(algod, deployment, alice.addr);
      expect(aliceDeposit).toBe(70_000_000_000);

      console.log('Phase 5: Alice withdrew 30k, now has 70k');
    });

    it('Phase 6: Dave joins with small deposit', async () => {
      await performUserOptIn(algod, deployment, dave);
      await performDeposit(algod, deployment, dave, 5_000_000); // 5 ALPHA (small)
      userDeposits['dave'] = 5_000_000;

      const stats = await getVaultStats(algod, deployment);
      console.log('Phase 6: Dave joined with 5 ALPHA, total:', stats.totalDeposits / 1_000_000);
    });

    it('Phase 7: Large yield distribution', async () => {
      await performSwapYield(algod, deployment, creator, 5_000_000_000, 100); // 5000 USDC

      // Even Dave should get something
      const davePending = await getPendingYield(algod, deployment, dave.addr);
      expect(davePending).toBeGreaterThan(0);

      console.log('Phase 7: 5000 USDC yield, Dave pending:', davePending / 1_000_000);
    });

    it('Phase 8: Bob claims and re-deposits', async () => {
      const bobIbusBefore = await getAssetBalance(algod, bob.addr, deployment.ibusAssetId);
      await performClaim(algod, deployment, bob);
      const bobIbusAfter = await getAssetBalance(algod, bob.addr, deployment.ibusAssetId);
      userYieldClaimed[bob.addr] = bobIbusAfter - bobIbusBefore;

      await performDeposit(algod, deployment, bob, 10_000_000_000); // +10k
      userDeposits['bob'] += 10_000_000_000;

      const bobDeposit = await getUserDeposit(algod, deployment, bob.addr);
      expect(bobDeposit).toBe(35_000_000_000);

      console.log('Phase 8: Bob claimed and added 10k, now has 35k');
    });

    it('Phase 9: Multiple small yields', async () => {
      for (let i = 0; i < 5; i++) {
        await performSwapYield(algod, deployment, creator, 100_000_000, 100); // 100 USDC each
      }

      const stats = await getVaultStats(algod, deployment);
      console.log('Phase 9: 5x 100 USDC yields, total yield generated:', stats.yieldPerToken);
    });

    it('Phase 10: Final accounting - everyone withdraws', async () => {
      // Get final vault state
      const statsBefore = await getVaultStats(algod, deployment);

      // Everyone claims their yield
      let totalUserYieldClaimed = 0;
      for (const [name, user] of [['alice', alice], ['bob', bob], ['charlie', charlie], ['dave', dave]] as const) {
        const pending = await getPendingYield(algod, deployment, user.addr);
        if (pending > 0) {
          const ibusBefore = await getAssetBalance(algod, user.addr, deployment.ibusAssetId);
          await performClaim(algod, deployment, user);
          const ibusAfter = await getAssetBalance(algod, user.addr, deployment.ibusAssetId);
          totalUserYieldClaimed += (ibusAfter - ibusBefore);
        }
      }

      // Creator claims fees
      const creatorIbusBefore = await getAssetBalance(algod, creator.addr, deployment.ibusAssetId);
      await performClaimCreator(algod, deployment, creator);
      const creatorIbusAfter = await getAssetBalance(algod, creator.addr, deployment.ibusAssetId);
      const creatorClaimed = creatorIbusAfter - creatorIbusBefore;

      // Everyone withdraws deposits
      for (const user of [alice, bob, charlie, dave]) {
        const deposit = await getUserDeposit(algod, deployment, user.addr);
        if (deposit > 0) {
          await performWithdraw(algod, deployment, user, 0);
        }
      }

      // Final state check
      const statsAfter = await getVaultStats(algod, deployment);

      console.log('Phase 10 - Final accounting:');
      console.log('  Total deposits:', statsAfter.totalDeposits);
      console.log('  User yield claimed:', totalUserYieldClaimed / 1_000_000, 'IBUS');
      console.log('  Creator claimed:', creatorClaimed / 1_000_000, 'IBUS');
      console.log('  Vault IBUS remaining (dust):', statsAfter.swapAssetBalance);

      // All deposits withdrawn
      expect(statsAfter.totalDeposits).toBe(0);

      // Minimal dust remaining
      expect(statsAfter.swapAssetBalance).toBeLessThan(1000);
    });
  });

  /**
   * FARM FEATURE COMPREHENSIVE TESTS
   * Tests farming with and without farm bonus
   */
  describe('Farm Feature - Comprehensive Tests', () => {
    describe('Without Farm (baseline)', () => {
      let deployment: VaultDeploymentResult;
      let baselineYield: number;

      beforeAll(async () => {
        deployment = await deployVaultForTest(algod, creator, {
          creatorFeeRate: 5,
          minSwapThreshold: 2_000_000,
        });

        await optInToAsset(algod, alice, deployment.alphaAssetId);
        await optInToAsset(algod, alice, deployment.ibusAssetId);
        await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 10_000_000_000);

        await performUserOptIn(algod, deployment, alice);
        await performDeposit(algod, deployment, alice, 1_000_000_000);
      });

      it('should swap without farm bonus', async () => {
        const farmStats = await getFarmStats(algod, deployment);
        expect(farmStats.farmBalance).toBe(0);
        expect(farmStats.farmEmissionRate).toBe(0);

        // Swap 100 USDC
        await performSwapYield(algod, deployment, creator, 100_000_000, 100);

        const pending = await getPendingYield(algod, deployment, alice.addr);
        baselineYield = pending;

        console.log('Without farm - yield:', pending / 1_000_000, 'IBUS');
      });
    });

    describe('With Farm Active', () => {
      let deployment: VaultDeploymentResult;
      let yieldWithoutFarm: number;
      let yieldWithFarm: number;

      beforeAll(async () => {
        deployment = await deployVaultForTest(algod, creator, {
          creatorFeeRate: 5,
          minSwapThreshold: 2_000_000,
        });

        await optInToAsset(algod, alice, deployment.alphaAssetId);
        await optInToAsset(algod, alice, deployment.ibusAssetId);
        await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 10_000_000_000);

        await performUserOptIn(algod, deployment, alice);
        await performDeposit(algod, deployment, alice, 1_000_000_000);
      });

      it('should show no farm bonus initially', async () => {
        await performSwapYield(algod, deployment, creator, 100_000_000, 100);
        yieldWithoutFarm = await getPendingYield(algod, deployment, alice.addr);

        console.log('Baseline (no farm):', yieldWithoutFarm / 1_000_000, 'IBUS');
      });

      it('should allow contributing IBUS to farm', async () => {
        // Creator needs to fund vault with IBUS for farm
        await fundAsset(algod, creator, creator.addr, deployment.ibusAssetId, 1_000_000_000);

        await performContributeFarm(algod, deployment, creator, 500_000_000); // 500 IBUS

        const farmStats = await getFarmStats(algod, deployment);
        expect(farmStats.farmBalance).toBe(500_000_000);

        console.log('Farm balance:', farmStats.farmBalance / 1_000_000, 'IBUS');
      });

      it('should set farm emission rate', async () => {
        await performSetFarmEmissionRate(algod, deployment, creator, 5000); // 50%

        const farmStats = await getFarmStats(algod, deployment);
        expect(farmStats.farmEmissionRate).toBe(5000);

        console.log('Farm emission rate:', farmStats.farmEmissionRate, 'bps (50%)');
      });

      it('should add farm bonus to swap', async () => {
        // Claim existing yield first
        await performClaim(algod, deployment, alice);

        const farmBefore = await getFarmStats(algod, deployment);

        // Another swap
        await performSwapYield(algod, deployment, creator, 100_000_000, 100);

        const farmAfter = await getFarmStats(algod, deployment);
        yieldWithFarm = await getPendingYield(algod, deployment, alice.addr);

        // Farm should have decreased
        expect(farmAfter.farmBalance).toBeLessThan(farmBefore.farmBalance);

        // More yield with farm bonus
        expect(yieldWithFarm).toBeGreaterThan(yieldWithoutFarm);

        const farmBonus = farmBefore.farmBalance - farmAfter.farmBalance;

        console.log('With farm:');
        console.log('  Yield:', yieldWithFarm / 1_000_000, '(was', yieldWithoutFarm / 1_000_000, ')');
        console.log('  Farm bonus used:', farmBonus / 1_000_000, 'IBUS');
        console.log('  Improvement:', ((yieldWithFarm / yieldWithoutFarm - 1) * 100).toFixed(2) + '%');
      });

      it('should deplete farm over multiple swaps', async () => {
        const farmBefore = await getFarmStats(algod, deployment);

        // Multiple swaps to deplete farm
        for (let i = 0; i < 5; i++) {
          await performSwapYield(algod, deployment, creator, 100_000_000, 100);
        }

        const farmAfter = await getFarmStats(algod, deployment);

        console.log('Farm depletion:');
        console.log('  Before:', farmBefore.farmBalance / 1_000_000, 'IBUS');
        console.log('  After:', farmAfter.farmBalance / 1_000_000, 'IBUS');
      });
    });

    describe('Farm Edge Cases', () => {
      it('should handle swap when farm is empty but emission rate set', async () => {
        const deployment = await deployVaultForTest(algod, creator, {
          creatorFeeRate: 0,
          minSwapThreshold: 2_000_000,
        });

        await optInToAsset(algod, alice, deployment.alphaAssetId);
        await optInToAsset(algod, alice, deployment.ibusAssetId);
        await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 10_000_000_000);

        await performUserOptIn(algod, deployment, alice);
        await performDeposit(algod, deployment, alice, 1_000_000_000);

        // Set emission rate but no farm balance
        await performSetFarmEmissionRate(algod, deployment, creator, 5000);

        const farmStats = await getFarmStats(algod, deployment);
        expect(farmStats.farmBalance).toBe(0);
        expect(farmStats.farmEmissionRate).toBe(5000);

        // Swap should still work
        await performSwapYield(algod, deployment, creator, 100_000_000, 100);

        const pending = await getPendingYield(algod, deployment, alice.addr);
        expect(pending).toBeGreaterThan(0);

        console.log('Empty farm swap:', pending / 1_000_000, 'IBUS');
      });

      it('should cap farm bonus at available balance', async () => {
        const deployment = await deployVaultForTest(algod, creator, {
          creatorFeeRate: 0,
          minSwapThreshold: 2_000_000,
        });

        await optInToAsset(algod, alice, deployment.alphaAssetId);
        await optInToAsset(algod, alice, deployment.ibusAssetId);
        await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 10_000_000_000);

        await performUserOptIn(algod, deployment, alice);
        await performDeposit(algod, deployment, alice, 1_000_000_000);

        // Small farm, high emission rate
        await fundAsset(algod, creator, creator.addr, deployment.ibusAssetId, 10_000_000);
        await performContributeFarm(algod, deployment, creator, 1_000_000); // 1 IBUS
        await performSetFarmEmissionRate(algod, deployment, creator, 10000); // 100%

        const farmBefore = await getFarmStats(algod, deployment);

        // Large swap that would request more than farm balance
        await performSwapYield(algod, deployment, creator, 100_000_000, 100);

        const farmAfter = await getFarmStats(algod, deployment);

        // Farm should be completely depleted
        expect(farmAfter.farmBalance).toBe(0);

        console.log('Farm cap test:');
        console.log('  Farm before:', farmBefore.farmBalance / 1_000_000);
        console.log('  Farm after:', farmAfter.farmBalance / 1_000_000);
      });

      it('should correctly distribute yield with farm bonus among multiple users', async () => {
        const deployment = await deployVaultForTest(algod, creator, {
          creatorFeeRate: 5,
          minSwapThreshold: 2_000_000,
        });

        await optInToAsset(algod, alice, deployment.alphaAssetId);
        await optInToAsset(algod, bob, deployment.alphaAssetId);
        await optInToAsset(algod, alice, deployment.ibusAssetId);
        await optInToAsset(algod, bob, deployment.ibusAssetId);

        await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 10_000_000_000);
        await fundAsset(algod, creator, bob.addr, deployment.alphaAssetId, 10_000_000_000);

        await performUserOptIn(algod, deployment, alice);
        await performUserOptIn(algod, deployment, bob);

        // Alice: 600 tokens, Bob: 400 tokens (60/40 split)
        await performDeposit(algod, deployment, alice, 600_000_000);
        await performDeposit(algod, deployment, bob, 400_000_000);

        // Setup farm
        await fundAsset(algod, creator, creator.addr, deployment.ibusAssetId, 500_000_000);
        await performContributeFarm(algod, deployment, creator, 200_000_000); // 200 IBUS
        await performSetFarmEmissionRate(algod, deployment, creator, 5000); // 50%

        // Swap with farm bonus
        await performSwapYield(algod, deployment, creator, 100_000_000, 100);

        const alicePending = await getPendingYield(algod, deployment, alice.addr);
        const bobPending = await getPendingYield(algod, deployment, bob.addr);

        // Ratio should be 60/40 = 1.5
        const ratio = alicePending / bobPending;
        expect(ratio).toBeCloseTo(1.5, 1);

        console.log('Multi-user with farm:');
        console.log('  Alice (60%):', alicePending / 1_000_000, 'IBUS');
        console.log('  Bob (40%):', bobPending / 1_000_000, 'IBUS');
        console.log('  Ratio:', ratio.toFixed(3), '(expected: 1.5)');
      });
    });
  });

  /**
   * 10-PHASE SCENARIO WITH FARM
   * Comprehensive test combining all features
   */
  describe('10-Phase Real-World Scenario with Farm', () => {
    let deployment: VaultDeploymentResult;
    let charlie: { addr: string; sk: Uint8Array };
    let dave: { addr: string; sk: Uint8Array };

    beforeAll(async () => {
      const charlieAccount = algosdk.generateAccount();
      const daveAccount = algosdk.generateAccount();
      charlie = { addr: charlieAccount.addr.toString(), sk: charlieAccount.sk };
      dave = { addr: daveAccount.addr.toString(), sk: daveAccount.sk };

      const suggestedParams = await algod.getTransactionParams().do();
      for (const user of [charlie, dave]) {
        const fundTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender: creator.addr,
          receiver: user.addr,
          amount: 10_000_000,
          suggestedParams,
        });
        const signed = fundTxn.signTxn(creator.sk);
        const { txid } = await algod.sendRawTransaction(signed).do();
        await algosdk.waitForConfirmation(algod, txid, 5);
      }

      deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 5,
        minSwapThreshold: 5_000_000,
        poolReserveUsdc: 500_000_000_000,
        poolReserveIbus: 500_000_000_000,
      });

      for (const user of [alice, bob, charlie, dave]) {
        await optInToAsset(algod, user, deployment.alphaAssetId);
        await optInToAsset(algod, user, deployment.ibusAssetId);
        await fundAsset(algod, creator, user.addr, deployment.alphaAssetId, 200_000_000_000);
      }
    });

    it('Phase 1: Initial deposits', async () => {
      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000_000); // 100k

      await performUserOptIn(algod, deployment, bob);
      await performDeposit(algod, deployment, bob, 25_000_000_000); // 25k

      const stats = await getVaultStats(algod, deployment);
      expect(stats.totalDeposits).toBe(125_000_000_000);

      console.log('Phase 1: Alice 100k, Bob 25k');
    });

    it('Phase 2: First swap (no farm)', async () => {
      await performSwapYield(algod, deployment, creator, 1_000_000_000, 100);

      const alicePending = await getPendingYield(algod, deployment, alice.addr);
      const bobPending = await getPendingYield(algod, deployment, bob.addr);

      expect(alicePending / bobPending).toBeCloseTo(4.0, 1);

      console.log('Phase 2: First swap, Alice/Bob ratio:', (alicePending / bobPending).toFixed(2));
    });

    it('Phase 3: Enable farm', async () => {
      await fundAsset(algod, creator, creator.addr, deployment.ibusAssetId, 2_000_000_000);
      await performContributeFarm(algod, deployment, creator, 1_000_000_000); // 1000 IBUS
      await performSetFarmEmissionRate(algod, deployment, creator, 2000); // 20%

      const farmStats = await getFarmStats(algod, deployment);
      expect(farmStats.farmBalance).toBe(1_000_000_000);

      console.log('Phase 3: Farm enabled with 1000 IBUS, 20% emission');
    });

    it('Phase 4: Charlie joins, swap with farm', async () => {
      await performUserOptIn(algod, deployment, charlie);
      await performDeposit(algod, deployment, charlie, 50_000_000_000); // 50k

      const farmBefore = await getFarmStats(algod, deployment);

      await performSwapYield(algod, deployment, creator, 500_000_000, 100);

      const farmAfter = await getFarmStats(algod, deployment);
      expect(farmAfter.farmBalance).toBeLessThan(farmBefore.farmBalance);

      const farmUsed = farmBefore.farmBalance - farmAfter.farmBalance;
      console.log('Phase 4: Farm bonus used:', farmUsed / 1_000_000, 'IBUS');
    });

    it('Phase 5: Alice claims', async () => {
      const alicePending = await getPendingYield(algod, deployment, alice.addr);
      const ibusBefore = await getAssetBalance(algod, alice.addr, deployment.ibusAssetId);

      await performClaim(algod, deployment, alice);

      const ibusAfter = await getAssetBalance(algod, alice.addr, deployment.ibusAssetId);
      const claimed = ibusAfter - ibusBefore;

      expect(claimed).toBeCloseTo(alicePending, -5);

      console.log('Phase 5: Alice claimed:', claimed / 1_000_000, 'IBUS');
    });

    it('Phase 6: Dave joins with small amount', async () => {
      await performUserOptIn(algod, deployment, dave);
      await performDeposit(algod, deployment, dave, 5_000_000); // 5 ALPHA

      const daveDeposit = await getUserDeposit(algod, deployment, dave.addr);
      expect(daveDeposit).toBe(5_000_000);

      console.log('Phase 6: Dave joined with 5 ALPHA');
    });

    it('Phase 7: Large swap draining farm', async () => {
      const farmBefore = await getFarmStats(algod, deployment);

      for (let i = 0; i < 3; i++) {
        await performSwapYield(algod, deployment, creator, 2_000_000_000, 100);
      }

      const farmAfter = await getFarmStats(algod, deployment);

      console.log('Phase 7: Farm drain:');
      console.log('  Before:', farmBefore.farmBalance / 1_000_000);
      console.log('  After:', farmAfter.farmBalance / 1_000_000);
    });

    it('Phase 8: Bob withdraws all', async () => {
      const bobPending = await getPendingYield(algod, deployment, bob.addr);
      await performClaim(algod, deployment, bob);
      await performWithdraw(algod, deployment, bob, 0);

      const bobDeposit = await getUserDeposit(algod, deployment, bob.addr);
      expect(bobDeposit).toBe(0);

      console.log('Phase 8: Bob withdrew all');
    });

    it('Phase 9: Final swaps without farm', async () => {
      const farmBefore = await getFarmStats(algod, deployment);

      for (let i = 0; i < 3; i++) {
        await performSwapYield(algod, deployment, creator, 100_000_000, 100);
      }

      // Farm should be at or near 0, no bonus applied
      const farmAfter = await getFarmStats(algod, deployment);

      console.log('Phase 9: Final swaps, farm:', farmAfter.farmBalance / 1_000_000);
    });

    it('Phase 10: Complete close out', async () => {
      // Everyone claims
      for (const user of [alice, charlie, dave]) {
        const pending = await getPendingYield(algod, deployment, user.addr);
        if (pending > 0) {
          try {
            await performClaim(algod, deployment, user);
          } catch (e) {
            // May fail if 0
          }
        }
      }

      // Creator claims
      await performClaimCreator(algod, deployment, creator);

      // Everyone withdraws
      for (const user of [alice, charlie, dave]) {
        const deposit = await getUserDeposit(algod, deployment, user.addr);
        if (deposit > 0) {
          await performWithdraw(algod, deployment, user, 0);
        }
      }

      const stats = await getVaultStats(algod, deployment);

      console.log('Phase 10 - Final:');
      console.log('  Total deposits:', stats.totalDeposits);
      console.log('  IBUS remaining:', stats.swapAssetBalance);

      expect(stats.totalDeposits).toBe(0);
      expect(stats.swapAssetBalance).toBeLessThan(1000);
    });
  });

  /**
   * CREATOR FEE RATE UPDATE TESTS
   * Tests the updateCreatorFeeRate method with 0-6% constraint
   */
  describe('Creator Fee Rate Update', () => {
    let deployment: VaultDeploymentResult;

    beforeAll(async () => {
      deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 3, // Start at 3%
        minSwapThreshold: 2_000_000,
      });
    });

    it('should allow creator to update fee rate within valid range (0-6%)', async () => {
      // Update to 5%
      await performUpdateCreatorFeeRate(algod, deployment, creator, 5);

      // Verify by doing a swap and checking creator gets 5%
      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.ibusAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 1_000_000_000);
      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);

      await performSwapYield(algod, deployment, creator, 100_000_000, 100);

      const stats = await getVaultStats(algod, deployment);
      expect(stats.creatorUnclaimedYield).toBeGreaterThan(0);

      console.log('Fee rate updated to 5%, creator unclaimed:', stats.creatorUnclaimedYield / 1_000_000);
    });

    it('should allow creator to set fee rate to 0%', async () => {
      const newDeployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 3,
        minSwapThreshold: 2_000_000,
      });

      await performUpdateCreatorFeeRate(algod, newDeployment, creator, 0);

      // Setup and swap
      await optInToAsset(algod, bob, newDeployment.alphaAssetId);
      await optInToAsset(algod, bob, newDeployment.ibusAssetId);
      await fundAsset(algod, creator, bob.addr, newDeployment.alphaAssetId, 1_000_000_000);
      await performUserOptIn(algod, newDeployment, bob);
      await performDeposit(algod, newDeployment, bob, 100_000_000);

      await performSwapYield(algod, newDeployment, creator, 100_000_000, 100);

      const stats = await getVaultStats(algod, newDeployment);
      expect(stats.creatorUnclaimedYield).toBe(0);

      console.log('Fee rate set to 0%, creator unclaimed:', stats.creatorUnclaimedYield);
    });

    it('should allow creator to set fee rate to maximum 6%', async () => {
      const newDeployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await performUpdateCreatorFeeRate(algod, newDeployment, creator, 6);

      console.log('Fee rate set to maximum 6%');
    });

    it('should reject fee rate above 6%', async () => {
      const newDeployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 3,
        minSwapThreshold: 2_000_000,
      });

      await expect(
        performUpdateCreatorFeeRate(algod, newDeployment, creator, 7)
      ).rejects.toThrow();

      console.log('Correctly rejected fee rate of 7%');
    });

    it('should reject non-creator updating fee rate', async () => {
      const newDeployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 3,
        minSwapThreshold: 2_000_000,
      });

      await expect(
        performUpdateCreatorFeeRate(algod, newDeployment, alice, 5)
      ).rejects.toThrow();

      console.log('Correctly rejected non-creator fee rate update');
    });
  });

  /**
   * FARM EMISSION RATE MINIMUM CONSTRAINT TESTS
   * Tests that emission rate cannot go below 10% when farm has balance
   */
  describe('Farm Emission Rate Minimum Constraint', () => {
    it('should allow setting emission rate to 0% when farm balance is 0', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      // Farm balance is 0, should allow setting to 0%
      await performSetFarmEmissionRate(algod, deployment, creator, 0);

      const farmStats = await getFarmStats(algod, deployment);
      expect(farmStats.farmEmissionRate).toBe(0);
      expect(farmStats.farmBalance).toBe(0);

      console.log('Set emission rate to 0% with empty farm - OK');
    });

    it('should allow setting emission rate to 5% when farm balance is 0', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      // Farm balance is 0, should allow any rate
      await performSetFarmEmissionRate(algod, deployment, creator, 500); // 5%

      const farmStats = await getFarmStats(algod, deployment);
      expect(farmStats.farmEmissionRate).toBe(500);

      console.log('Set emission rate to 5% with empty farm - OK');
    });

    it('should reject setting emission rate below 10% when farm has balance', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      // First, contribute to farm
      await fundAsset(algod, creator, creator.addr, deployment.ibusAssetId, 100_000_000);
      await performContributeFarm(algod, deployment, creator, 50_000_000);

      const farmStatsBefore = await getFarmStats(algod, deployment);
      expect(farmStatsBefore.farmBalance).toBe(50_000_000);

      // Try to set emission rate to 5% (500 bps) - should fail
      await expect(
        performSetFarmEmissionRate(algod, deployment, creator, 500)
      ).rejects.toThrow();

      // Try to set to 0% - should also fail
      await expect(
        performSetFarmEmissionRate(algod, deployment, creator, 0)
      ).rejects.toThrow();

      console.log('Correctly rejected emission rate below 10% when farm has balance');
    });

    it('should allow setting emission rate to exactly 10% when farm has balance', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      // Contribute to farm
      await fundAsset(algod, creator, creator.addr, deployment.ibusAssetId, 100_000_000);
      await performContributeFarm(algod, deployment, creator, 50_000_000);

      // Set to exactly 10% (1000 bps) - should succeed
      await performSetFarmEmissionRate(algod, deployment, creator, 1000);

      const farmStats = await getFarmStats(algod, deployment);
      expect(farmStats.farmEmissionRate).toBe(1000);

      console.log('Set emission rate to 10% with funded farm - OK');
    });

    it('should allow setting emission rate above 10% when farm has balance', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      // Contribute to farm
      await fundAsset(algod, creator, creator.addr, deployment.ibusAssetId, 100_000_000);
      await performContributeFarm(algod, deployment, creator, 50_000_000);

      // Set to 50% (5000 bps) - should succeed
      await performSetFarmEmissionRate(algod, deployment, creator, 5000);

      const farmStats = await getFarmStats(algod, deployment);
      expect(farmStats.farmEmissionRate).toBe(5000);

      console.log('Set emission rate to 50% with funded farm - OK');
    });

    it('should allow contributions when emission rate is 0, but then require min 10% to change', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      // Emission rate starts at 0
      const farmStatsBefore = await getFarmStats(algod, deployment);
      expect(farmStatsBefore.farmEmissionRate).toBe(0);

      // Contribution should work even with 0 emission rate
      await fundAsset(algod, creator, creator.addr, deployment.ibusAssetId, 100_000_000);
      await performContributeFarm(algod, deployment, creator, 50_000_000);

      const farmStatsAfter = await getFarmStats(algod, deployment);
      expect(farmStatsAfter.farmBalance).toBe(50_000_000);
      expect(farmStatsAfter.farmEmissionRate).toBe(0); // Still 0

      // Now try to set to 5% - should fail
      await expect(
        performSetFarmEmissionRate(algod, deployment, creator, 500)
      ).rejects.toThrow();

      // Must set to at least 10%
      await performSetFarmEmissionRate(algod, deployment, creator, 1000);

      const farmStatsFinal = await getFarmStats(algod, deployment);
      expect(farmStatsFinal.farmEmissionRate).toBe(1000);

      console.log('Contribution works at 0% emission, then requires min 10% to update - OK');
    });
  });

  /**
   * SENDER VALIDATION TESTS
   * Tests that contributeFarm validates the sender matches the asset transfer
   */
  describe('Sender Validation', () => {
    let senderAlice: { addr: string; sk: Uint8Array };
    let senderBob: { addr: string; sk: Uint8Array };

    beforeAll(async () => {
      // Get accounts from KMD
      const wallets = await kmd.listWallets();
      const defaultWallet = wallets.wallets.find((w: any) => w.name === 'unencrypted-default-wallet');
      const walletHandle = (await kmd.initWalletHandle(defaultWallet.id, '')).wallet_handle_token;
      const addresses = (await kmd.listKeys(walletHandle)).addresses;

      const getAccount = async (index: number) => {
        const addr = addresses[index];
        const keyResponse = await kmd.exportKey(walletHandle, '', addr);
        return { addr, sk: keyResponse.private_key };
      };

      senderAlice = await getAccount(1);
      senderBob = await getAccount(2);
      await kmd.releaseWalletHandle(walletHandle);
    });

    it('should reject contributeFarm when asset transfer sender differs from caller', async () => {
      const deployment = await deployVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      // Fund Alice with IBUS
      await optInToAsset(algod, senderAlice, deployment.ibusAssetId);
      await fundAsset(algod, creator, senderAlice.addr, deployment.ibusAssetId, 100_000_000);

      // Try to have Alice send the asset but Bob call contributeFarm
      // This should fail because the sender validation requires transfer.sender === Txn.sender
      const contract = new algosdk.ABIContract(deployment.arc56Spec);
      const suggestedParams = await algod.getTransactionParams().do();

      const aliceSigner = algosdk.makeBasicAccountTransactionSigner({
        sk: senderAlice.sk,
        addr: algosdk.decodeAddress(senderAlice.addr),
      });
      const bobSigner = algosdk.makeBasicAccountTransactionSigner({
        sk: senderBob.sk,
        addr: algosdk.decodeAddress(senderBob.addr),
      });

      // Alice creates and signs asset transfer
      const ibusTransfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: senderAlice.addr,
        receiver: deployment.vaultAddress,
        amount: 10_000_000,
        assetIndex: deployment.ibusAssetId,
        suggestedParams,
      });

      const atc = new algosdk.AtomicTransactionComposer();
      atc.addTransaction({ txn: ibusTransfer, signer: aliceSigner });

      // Bob calls contributeFarm (different sender than asset transfer)
      atc.addMethodCall({
        appID: deployment.vaultAppId,
        method: contract.getMethodByName('contributeFarm'),
        methodArgs: [],
        sender: senderBob.addr,  // Bob is calling, but Alice sent the asset
        signer: bobSigner,
        suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
        appForeignAssets: [deployment.ibusAssetId],
      });

      // This should fail because transfer.sender (Alice) !== Txn.sender (Bob)
      await expect(atc.execute(algod, 5)).rejects.toThrow();

      console.log('contributeFarm sender mismatch rejected - OK');
    });
  });
});
