import algosdk from 'algosdk';
import {
  deployCompoundingVaultForTest,
  performUserOptIn,
  performDeposit,
  performWithdraw,
  performCompoundYield,
  performClaimCreator,
  performCloseOut,
  getVaultStats,
  getUserShares,
  getUserAlphaBalance,
  performContributeFarm,
  performSetEmissionRatio,
  performUpdateCreatorFeeRate,
  performUpdateMaxSlippage,
  performUpdateMinSwapThreshold,
  getFarmStats,
  getFarmStatsABI,
  CompoundingVaultDeploymentResult,
} from './utils/compoundingVault';
import { getAssetBalance, optInToAsset, fundAsset } from './utils/assets';

// Localnet configuration
const ALGOD_SERVER = 'http://localhost';
const ALGOD_PORT = 4001;
const ALGOD_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// KMD configuration for getting funded accounts
const KMD_SERVER = 'http://localhost';
const KMD_PORT = 4002;
const KMD_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const SCALE = 1_000_000_000_000; // 1e12 for share price

describe('RareFiAlphaCompoundingVault Contract Tests', () => {
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
    let deployment: CompoundingVaultDeploymentResult;

    it('should deploy vault and pool successfully', async () => {
      deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 5,
        minSwapThreshold: 2_000_000, // 2 USDC
      });

      expect(deployment.vaultAppId).toBeGreaterThan(0);
      expect(deployment.poolAppId).toBeGreaterThan(0);
      expect(deployment.alphaAssetId).toBeGreaterThan(0);
      expect(deployment.usdcAssetId).toBeGreaterThan(0);
    });

    it('should have correct initial state', async () => {
      const stats = await getVaultStats(algod, deployment);
      expect(stats.totalShares).toBe(0);
      expect(stats.totalAlpha).toBe(0);
      expect(stats.creatorUnclaimedAlpha).toBe(0);
      expect(stats.sharePrice).toBe(SCALE); // 1:1 initially
    });
  });

  describe('User Operations - Share-Based Accounting', () => {
    let deployment: CompoundingVaultDeploymentResult;
    const depositAmount = 100_000_000; // 100 tokens

    beforeAll(async () => {
      deployment = await deployCompoundingVaultForTest(algod, creator);

      // Fund Alice and Bob with Alpha tokens
      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, bob, deployment.alphaAssetId);

      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 1_000_000_000);
      await fundAsset(algod, creator, bob.addr, deployment.alphaAssetId, 500_000_000);
    });

    it('should allow user to opt in', async () => {
      await performUserOptIn(algod, deployment, alice);
      const shares = await getUserShares(algod, deployment, alice.addr);
      expect(shares).toBe(0);
    });

    it('should allow user to deposit and receive shares', async () => {
      await performDeposit(algod, deployment, alice, depositAmount);
      const shares = await getUserShares(algod, deployment, alice.addr);
      // First depositor: 1:1 shares
      expect(shares).toBe(depositAmount);

      const stats = await getVaultStats(algod, deployment);
      expect(stats.totalShares).toBe(depositAmount);
      expect(stats.totalAlpha).toBe(depositAmount);
    });

    it('should allow partial withdrawal', async () => {
      const sharesBefore = await getUserShares(algod, deployment, alice.addr);
      const withdrawShares = 30_000_000;

      await performWithdraw(algod, deployment, alice, withdrawShares);

      const sharesAfter = await getUserShares(algod, deployment, alice.addr);
      expect(sharesAfter).toBe(sharesBefore - withdrawShares);

      const stats = await getVaultStats(algod, deployment);
      expect(stats.totalShares).toBe(depositAmount - withdrawShares);
    });

    it('should allow full withdrawal with shareAmount=0', async () => {
      // Deposit more first
      await performDeposit(algod, deployment, alice, 50_000_000);

      // Withdraw all with 0
      await performWithdraw(algod, deployment, alice, 0);

      const shares = await getUserShares(algod, deployment, alice.addr);
      expect(shares).toBe(0);
    });
  });

  describe('Auto-Compounding Yield', () => {
    let deployment: CompoundingVaultDeploymentResult;
    const aliceDeposit = 1000_000_000; // 1000 tokens
    const bobDeposit = 500_000_000;    // 500 tokens
    const yieldAmount = 300_000_000;   // 300 USDC to swap

    beforeAll(async () => {
      deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 5, // 5%
        minSwapThreshold: 2_000_000, // 2 USDC
      });

      // Setup users
      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, bob, deployment.alphaAssetId);
      await optInToAsset(algod, creator, deployment.usdcAssetId);

      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 2_000_000_000);
      await fundAsset(algod, creator, bob.addr, deployment.alphaAssetId, 1_000_000_000);

      // Users opt in and deposit
      await performUserOptIn(algod, deployment, alice);
      await performUserOptIn(algod, deployment, bob);

      await performDeposit(algod, deployment, alice, aliceDeposit);
      await performDeposit(algod, deployment, bob, bobDeposit);
    });

    it('should compound yield and increase share price', async () => {
      const statsBefore = await getVaultStats(algod, deployment);
      const sharePriceBefore = statsBefore.sharePrice;

      // Perform compound (sends USDC to vault, then swaps to Alpha)
      await performCompoundYield(algod, deployment, creator, yieldAmount, 100); // 1% slippage

      const statsAfter = await getVaultStats(algod, deployment);

      // USDC should be 0 after compound
      expect(statsAfter.usdcBalance).toBe(0);

      // Share price should increase (more Alpha per share)
      expect(statsAfter.sharePrice).toBeGreaterThan(sharePriceBefore);

      // Total shares should stay the same (auto-compounding)
      expect(statsAfter.totalShares).toBe(statsBefore.totalShares);

      // Total Alpha should increase
      expect(statsAfter.totalAlpha).toBeGreaterThan(statsBefore.totalAlpha);

      // Creator should have unclaimed Alpha
      expect(statsAfter.creatorUnclaimedAlpha).toBeGreaterThan(0);

      console.log('Share price before:', sharePriceBefore / SCALE);
      console.log('Share price after:', statsAfter.sharePrice / SCALE);
      console.log('Creator unclaimed:', statsAfter.creatorUnclaimedAlpha / 1_000_000);
    });

    it('should proportionally distribute yield via share value', async () => {
      const aliceAlphaBalance = await getUserAlphaBalance(algod, deployment, alice.addr);
      const bobAlphaBalance = await getUserAlphaBalance(algod, deployment, bob.addr);

      // Alice has 2/3 of shares, Bob has 1/3
      // So Alice should have ~2x Bob's Alpha balance
      const ratio = aliceAlphaBalance / bobAlphaBalance;
      expect(ratio).toBeGreaterThan(1.9);
      expect(ratio).toBeLessThan(2.1);

      // Both should have more than their original deposits
      expect(aliceAlphaBalance).toBeGreaterThan(aliceDeposit);
      expect(bobAlphaBalance).toBeGreaterThan(bobDeposit);

      console.log('Alice Alpha balance:', aliceAlphaBalance / 1_000_000);
      console.log('Bob Alpha balance:', bobAlphaBalance / 1_000_000);
    });

    it('should allow Alice to withdraw with compounded yield', async () => {
      const aliceSharesBefore = await getUserShares(algod, deployment, alice.addr);
      const aliceAlphaBefore = await getAssetBalance(algod, alice.addr, deployment.alphaAssetId);

      // Withdraw all shares
      await performWithdraw(algod, deployment, alice, 0);

      const aliceAlphaAfter = await getAssetBalance(algod, alice.addr, deployment.alphaAssetId);
      const withdrawn = aliceAlphaAfter - aliceAlphaBefore;

      // Should receive more than original deposit due to compounding
      expect(withdrawn).toBeGreaterThan(aliceDeposit);

      console.log('Alice withdrew:', withdrawn / 1_000_000, 'Alpha (original deposit:', aliceDeposit / 1_000_000, ')');
    });

    it('should allow creator to claim fee', async () => {
      const stats = await getVaultStats(algod, deployment);
      const expectedCreatorYield = stats.creatorUnclaimedAlpha;

      const alphaBalanceBefore = await getAssetBalance(algod, creator.addr, deployment.alphaAssetId);
      await performClaimCreator(algod, deployment, creator);
      const alphaBalanceAfter = await getAssetBalance(algod, creator.addr, deployment.alphaAssetId);

      const claimed = alphaBalanceAfter - alphaBalanceBefore;
      expect(claimed).toBe(expectedCreatorYield);

      // Creator unclaimed should be 0
      const statsAfter = await getVaultStats(algod, deployment);
      expect(statsAfter.creatorUnclaimedAlpha).toBe(0);
    });
  });

  describe('Late Depositor (Share Dilution)', () => {
    let deployment: CompoundingVaultDeploymentResult;

    beforeAll(async () => {
      deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 5,
        minSwapThreshold: 2_000_000,
      });

      // Setup Alice
      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 2_000_000_000);

      // Alice deposits first
      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 1000_000_000);

      // Yield distributed and compounded while Bob hasn't deposited yet
      await performCompoundYield(algod, deployment, creator, 100_000_000, 100);
    });

    it('should give late depositor fewer shares per Alpha', async () => {
      const statsBefore = await getVaultStats(algod, deployment);
      console.log('Share price before Bob deposits:', statsBefore.sharePrice / SCALE);

      // Bob deposits AFTER yield was compounded
      await optInToAsset(algod, bob, deployment.alphaAssetId);
      await fundAsset(algod, creator, bob.addr, deployment.alphaAssetId, 1_000_000_000);

      await performUserOptIn(algod, deployment, bob);
      await performDeposit(algod, deployment, bob, 500_000_000);

      const bobShares = await getUserShares(algod, deployment, bob.addr);

      // Bob should get fewer shares than his deposit amount (because share price > 1)
      expect(bobShares).toBeLessThan(500_000_000);

      // But his Alpha balance should be exactly what he deposited (no past yield)
      const bobAlphaBalance = await getUserAlphaBalance(algod, deployment, bob.addr);
      expect(bobAlphaBalance).toBeCloseTo(500_000_000, -3);

      // Alice should still have more from the compounded yield
      const aliceAlphaBalance = await getUserAlphaBalance(algod, deployment, alice.addr);
      expect(aliceAlphaBalance).toBeGreaterThan(1000_000_000);

      console.log('Bob shares:', bobShares / 1_000_000, '(deposited 500 Alpha)');
      console.log('Bob Alpha balance:', bobAlphaBalance / 1_000_000);
      console.log('Alice Alpha balance:', aliceAlphaBalance / 1_000_000);
    });
  });

  describe('Close Out', () => {
    let deployment: CompoundingVaultDeploymentResult;
    const depositAmount = 100_000_000;
    const yieldAmount = 50_000_000;

    beforeAll(async () => {
      deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0, // No creator fee for simpler math
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 500_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, depositAmount);

      // Compound some yield
      await performCompoundYield(algod, deployment, creator, yieldAmount, 100);
    });

    it('should return all Alpha (deposit + yield) on close out', async () => {
      const alphaBalanceBefore = await getAssetBalance(algod, alice.addr, deployment.alphaAssetId);
      const aliceAlphaBalance = await getUserAlphaBalance(algod, deployment, alice.addr);

      await performCloseOut(algod, deployment, alice);

      const alphaBalanceAfter = await getAssetBalance(algod, alice.addr, deployment.alphaAssetId);
      const received = alphaBalanceAfter - alphaBalanceBefore;

      // Should get deposit + compounded yield back
      expect(received).toBeCloseTo(aliceAlphaBalance, -3);
      expect(received).toBeGreaterThan(depositAmount);

      // Total shares should decrease
      const stats = await getVaultStats(algod, deployment);
      expect(stats.totalShares).toBe(0);
    });
  });

  describe('Security - Immutability', () => {
    let deployment: CompoundingVaultDeploymentResult;

    beforeAll(async () => {
      deployment = await deployCompoundingVaultForTest(algod, creator);
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
      const deployment = await deployCompoundingVaultForTest(algod, creator);
      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 100_000_000);
      await performUserOptIn(algod, deployment, alice);

      // Try to deposit less than MIN_DEPOSIT_AMOUNT (1_000_000)
      await expect(
        performDeposit(algod, deployment, alice, 100)
      ).rejects.toThrow();
    });

    it('should reject compound below minimum threshold', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        minSwapThreshold: 10_000_000, // 10 USDC minimum
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 100_000_000);
      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);

      // Try to compound only 5 USDC (below 10 USDC threshold)
      await expect(
        performCompoundYield(algod, deployment, creator, 5_000_000, 100)
      ).rejects.toThrow();
    });

    it('should handle zero fee rate correctly', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 100_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);

      // Compound yield
      await performCompoundYield(algod, deployment, creator, 50_000_000, 100);

      const stats = await getVaultStats(algod, deployment);
      expect(stats.creatorUnclaimedAlpha).toBe(0); // No creator fee

      // All yield goes to vault (share price increase)
      expect(stats.sharePrice).toBeGreaterThan(SCALE);
    });

    it('should handle maximum 6% fee rate correctly', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 6, // Maximum allowed
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, bob, deployment.alphaAssetId);
      await fundAsset(algod, creator, bob.addr, deployment.alphaAssetId, 100_000_000);

      await performUserOptIn(algod, deployment, bob);
      await performDeposit(algod, deployment, bob, 100_000_000);

      // Compound yield
      await performCompoundYield(algod, deployment, creator, 50_000_000, 100);

      const stats = await getVaultStats(algod, deployment);
      expect(stats.creatorUnclaimedAlpha).toBeGreaterThan(0); // Creator gets 6%

      // Share price should increase (94% of yield goes to vault)
      expect(stats.sharePrice).toBeGreaterThan(SCALE);
    });

    it('should allow anyone to call compoundYield (permissionless)', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator);

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.usdcAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 100_000_000);
      await fundAsset(algod, creator, alice.addr, deployment.usdcAssetId, 100_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);

      // Alice calls compoundYield - should succeed (permissionless)
      await performCompoundYield(algod, deployment, alice, 10_000_000, 100);

      const stats = await getVaultStats(algod, deployment);
      expect(stats.usdcBalance).toBe(0); // USDC was swapped
      expect(stats.totalYieldCompounded).toBeGreaterThan(0);
    });

    it('should reject compoundYield when slippage exceeds maxSlippageBps', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 100_000_000);
      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);

      // maxSlippageBps is 5000 (50%) - try 5001
      await expect(
        performCompoundYield(algod, deployment, creator, 10_000_000, 5001)
      ).rejects.toThrow();

      console.log('Correctly rejected slippage above maxSlippageBps');
    });
  });

  describe('Share-Based Accounting Precision', () => {
    it('should handle odd deposit amounts correctly', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      // Odd prime number deposits to test rounding
      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, bob, deployment.alphaAssetId);

      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 5_000_000_000);
      await fundAsset(algod, creator, bob.addr, deployment.alphaAssetId, 5_000_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performUserOptIn(algod, deployment, bob);

      // Prime number deposits: 7 and 13 tokens
      await performDeposit(algod, deployment, alice, 7_000_000);
      await performDeposit(algod, deployment, bob, 13_000_000);

      // Yield: 3 USDC (another prime)
      await performCompoundYield(algod, deployment, creator, 3_000_000, 100);

      const aliceAlpha = await getUserAlphaBalance(algod, deployment, alice.addr);
      const bobAlpha = await getUserAlphaBalance(algod, deployment, bob.addr);

      // Alice has 7/20 = 35%, Bob has 13/20 = 65%
      const ratio = bobAlpha / aliceAlpha;
      expect(ratio).toBeCloseTo(13 / 7, 1); // Should be ~1.857

      console.log('Rounding test - Primes:');
      console.log('  Alice (7 tokens):', aliceAlpha / 1_000_000);
      console.log('  Bob (13 tokens):', bobAlpha / 1_000_000);
      console.log('  Ratio:', ratio, '(expected:', 13 / 7, ')');
    });

    it('should maintain accounting after multiple compounds', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 5_000_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);

      // Multiple compounds
      for (let i = 0; i < 5; i++) {
        await performCompoundYield(algod, deployment, creator, 10_000_000, 100);
      }

      const stats = await getVaultStats(algod, deployment);
      const aliceAlpha = await getUserAlphaBalance(algod, deployment, alice.addr);

      // Verify accounting: totalAlpha should match user's balance
      expect(aliceAlpha).toBeCloseTo(stats.totalAlpha, -3);

      console.log('Multi-compound test:');
      console.log('  Total Alpha in vault:', stats.totalAlpha / 1_000_000);
      console.log('  Alice Alpha balance:', aliceAlpha / 1_000_000);
      console.log('  Share price:', stats.sharePrice / SCALE);
    });
  });

  describe('Auto-Compound on Deposit', () => {
    let deployment: CompoundingVaultDeploymentResult;
    const MIN_SWAP_THRESHOLD = 10_000_000; // 10 USDC threshold for testing

    beforeAll(async () => {
      deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: MIN_SWAP_THRESHOLD,
      });

      // Setup Alice with Alpha tokens
      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 5_000_000_000);

      // Alice opts in and makes initial deposit (before any USDC arrives)
      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);
    });

    it('should allow deposits when USDC balance is below threshold (no auto-compound)', async () => {
      // Send USDC below threshold (5 USDC, threshold is 10 USDC)
      const belowThreshold = MIN_SWAP_THRESHOLD - 5_000_000; // 5 USDC
      await fundAsset(algod, creator, deployment.vaultAddress, deployment.usdcAssetId, belowThreshold);

      // Check vault USDC balance
      const stats = await getVaultStats(algod, deployment);
      expect(stats.usdcBalance).toBe(belowThreshold);
      expect(stats.usdcBalance).toBeLessThan(MIN_SWAP_THRESHOLD);

      // Deposit should succeed without triggering compound
      await performDeposit(algod, deployment, alice, 10_000_000);

      const shares = await getUserShares(algod, deployment, alice.addr);
      expect(shares).toBe(110_000_000); // 100 + 10

      // USDC should still be there (no compound triggered)
      const statsAfter = await getVaultStats(algod, deployment);
      expect(statsAfter.usdcBalance).toBe(belowThreshold);

      console.log('Below threshold: Deposit succeeded without auto-compound, USDC balance:', belowThreshold / 1_000_000);
    });

    it('should AUTO-COMPOUND when USDC balance meets threshold on deposit', async () => {
      // Add more USDC to reach exactly the threshold
      const currentStats = await getVaultStats(algod, deployment);
      const toAdd = MIN_SWAP_THRESHOLD - currentStats.usdcBalance;
      if (toAdd > 0) {
        await fundAsset(algod, creator, deployment.vaultAddress, deployment.usdcAssetId, toAdd);
      }

      // Verify USDC is at threshold
      const statsBefore = await getVaultStats(algod, deployment);
      expect(statsBefore.usdcBalance).toBe(MIN_SWAP_THRESHOLD);
      const sharePriceBefore = statsBefore.sharePrice;

      console.log('At threshold: USDC balance is exactly', statsBefore.usdcBalance / 1_000_000);

      // Deposit should trigger auto-compound THEN process deposit
      await performDeposit(algod, deployment, alice, 10_000_000);

      const statsAfter = await getVaultStats(algod, deployment);

      // USDC should be 0 after auto-compound
      expect(statsAfter.usdcBalance).toBe(0);

      // Share price should increase (yield compounded to existing holders before new deposit)
      expect(statsAfter.sharePrice).toBeGreaterThan(sharePriceBefore);

      console.log('Auto-compound triggered: USDC balance now', statsAfter.usdcBalance);
      console.log('Share price increased from', sharePriceBefore / SCALE, 'to', statsAfter.sharePrice / SCALE);
    });

    it('should give new depositor correct shares (not capturing pre-existing yield)', async () => {
      // Setup fresh deployment
      const deployment2 = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: MIN_SWAP_THRESHOLD,
      });

      // Setup Alice (existing depositor)
      await optInToAsset(algod, alice, deployment2.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment2.alphaAssetId, 5_000_000_000);

      await performUserOptIn(algod, deployment2, alice);
      await performDeposit(algod, deployment2, alice, 100_000_000);

      // USDC yield arrives at threshold
      await fundAsset(algod, creator, deployment2.vaultAddress, deployment2.usdcAssetId, MIN_SWAP_THRESHOLD);

      // Setup Bob (new depositor who will trigger auto-compound)
      await optInToAsset(algod, bob, deployment2.alphaAssetId);
      await fundAsset(algod, creator, bob.addr, deployment2.alphaAssetId, 1_000_000_000);
      await performUserOptIn(algod, deployment2, bob);

      // Get Alice's balance before Bob's deposit
      const aliceAlphaBefore = await getUserAlphaBalance(algod, deployment2, alice.addr);

      // Bob deposits - should trigger auto-compound first, then process his deposit
      await performDeposit(algod, deployment2, bob, 100_000_000);

      // Alice should have received all the yield (she was the only depositor when compound happened)
      const aliceAlphaAfter = await getUserAlphaBalance(algod, deployment2, alice.addr);
      expect(aliceAlphaAfter).toBeGreaterThan(aliceAlphaBefore);

      // Bob's Alpha balance should be close to his deposit (he didn't capture pre-existing yield)
      const bobAlpha = await getUserAlphaBalance(algod, deployment2, bob.addr);
      expect(bobAlpha).toBeCloseTo(100_000_000, -3); // Within 1000 units

      console.log('Alice Alpha balance: before', aliceAlphaBefore / 1_000_000, 'after', aliceAlphaAfter / 1_000_000);
      console.log('Bob Alpha balance:', bobAlpha / 1_000_000, '(deposited 100)');
      console.log('Flash deposit protected: Bob did not capture pre-existing yield');
    });
  });

  describe('Farm Feature', () => {
    let deployment: CompoundingVaultDeploymentResult;

    beforeAll(async () => {
      deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0, // No creator fee to simplify testing
        minSwapThreshold: 2_000_000,
      });

      // Setup Alice
      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 5_000_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);
    });

    it('should allow contributing to farm', async () => {
      await performContributeFarm(algod, deployment, creator, 50_000_000);

      const farmStats = await getFarmStats(algod, deployment);
      expect(farmStats.farmBalance).toBe(50_000_000);

      console.log('Farm balance:', farmStats.farmBalance / 1_000_000);
    });

    it('should allow setting emission ratio', async () => {
      await performSetEmissionRatio(algod, deployment, creator, 1000);

      const farmStats = await getFarmStats(algod, deployment);
      expect(farmStats.emissionRatio).toBe(1000);

      console.log('Emission ratio:', farmStats.emissionRatio);
    });

    it('should add farm bonus during compound', async () => {
      const statsBefore = await getVaultStats(algod, deployment);
      const farmBefore = await getFarmStats(algod, deployment);

      // Compound with farm bonus active
      await performCompoundYield(algod, deployment, creator, 10_000_000, 100);

      const statsAfter = await getVaultStats(algod, deployment);
      const farmAfter = await getFarmStats(algod, deployment);

      // Farm balance should decrease
      expect(farmAfter.farmBalance).toBeLessThan(farmBefore.farmBalance);

      // Total yield compounded should include farm bonus
      const yieldIncrease = statsAfter.totalYieldCompounded - statsBefore.totalYieldCompounded;
      expect(yieldIncrease).toBeGreaterThan(0);

      console.log('Farm bonus test:');
      console.log('  Farm balance before:', farmBefore.farmBalance / 1_000_000);
      console.log('  Farm balance after:', farmAfter.farmBalance / 1_000_000);
      console.log('  Total yield increase:', yieldIncrease / 1_000_000);
    });
  });

  /**
   * COMPREHENSIVE INTEGRATION TEST
   * Tests complex scenarios with multiple users, compounding, and withdrawals
   */
  describe('Comprehensive Integration Test - Auto-Compounding', () => {
    let deployment: CompoundingVaultDeploymentResult;
    let charlie: { addr: string; sk: Uint8Array };

    beforeAll(async () => {
      // Generate charlie account programmatically
      const charlieAccount = algosdk.generateAccount();
      charlie = { addr: charlieAccount.addr.toString(), sk: charlieAccount.sk };

      // Fund charlie with ALGO from creator
      const suggestedParams = await algod.getTransactionParams().do();
      const fundCharlieTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: creator.addr,
        receiver: charlie.addr,
        amount: 10_000_000, // 10 ALGO
        suggestedParams,
      });
      const signedFundCharlie = fundCharlieTxn.signTxn(creator.sk);
      const { txid } = await algod.sendRawTransaction(signedFundCharlie).do();
      await algosdk.waitForConfirmation(algod, txid, 5);

      // Deploy with 5% creator fee
      deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 5, // 5%
        minSwapThreshold: 2_000_000,
        poolReserveUsdc: 100_000_000_000,  // 100k USDC
        poolReserveAlpha: 100_000_000_000, // 100k Alpha (1:1 ratio)
      });

      // Setup all users with assets
      for (const user of [alice, bob, charlie]) {
        await optInToAsset(algod, user, deployment.alphaAssetId);
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

      // Charlie deposits 500 tokens
      await performUserOptIn(algod, deployment, charlie);
      await performDeposit(algod, deployment, charlie, 500_000_000);

      const stats = await getVaultStats(algod, deployment);
      expect(stats.totalShares).toBe(2000_000_000);
      expect(stats.totalAlpha).toBe(2000_000_000);

      console.log('Phase 1 - Total shares:', stats.totalShares / 1_000_000);
    });

    it('Phase 2: First compound - everyone benefits', async () => {

      const statsBefore = await getVaultStats(algod, deployment);

      // Compound 100 USDC worth of yield
      await performCompoundYield(algod, deployment, creator, 100_000_000, 100);

      const statsAfter = await getVaultStats(algod, deployment);

      // Share price should increase
      expect(statsAfter.sharePrice).toBeGreaterThan(statsBefore.sharePrice);

      // Check proportional distribution:
      // Alice (1000/2000 = 50%)
      // Bob (500/2000 = 25%)
      // Charlie (500/2000 = 25%)

      const aliceAlpha = await getUserAlphaBalance(algod, deployment, alice.addr);
      const bobAlpha = await getUserAlphaBalance(algod, deployment, bob.addr);
      const charlieAlpha = await getUserAlphaBalance(algod, deployment, charlie.addr);

      console.log('Phase 2 - Alpha balances:');
      console.log('  Alice:', aliceAlpha / 1_000_000);
      console.log('  Bob:', bobAlpha / 1_000_000);
      console.log('  Charlie:', charlieAlpha / 1_000_000);
      console.log('  Share price:', statsAfter.sharePrice / SCALE);

      // Verify ratios
      expect(aliceAlpha / bobAlpha).toBeCloseTo(2.0, 1);
    });

    it('Phase 3: Alice withdraws half, Bob withdraws all', async () => {

      const aliceSharesBefore = await getUserShares(algod, deployment, alice.addr);
      const bobSharesBefore = await getUserShares(algod, deployment, bob.addr);

      // Alice withdraws half her shares
      await performWithdraw(algod, deployment, alice, Math.floor(aliceSharesBefore / 2));

      // Bob withdraws all
      await performWithdraw(algod, deployment, bob, 0);

      const aliceSharesAfter = await getUserShares(algod, deployment, alice.addr);
      const bobSharesAfter = await getUserShares(algod, deployment, bob.addr);

      expect(aliceSharesAfter).toBeCloseTo(aliceSharesBefore / 2, -3);
      expect(bobSharesAfter).toBe(0);

      console.log('Phase 3 - After withdrawals:');
      console.log('  Alice shares:', aliceSharesAfter / 1_000_000, '(was', aliceSharesBefore / 1_000_000, ')');
      console.log('  Bob shares:', bobSharesAfter / 1_000_000, '(was', bobSharesBefore / 1_000_000, ')');
    });

    it('Phase 4: Second compound - only remaining users benefit', async () => {

      const aliceAlphaBefore = await getUserAlphaBalance(algod, deployment, alice.addr);
      const charlieAlphaBefore = await getUserAlphaBalance(algod, deployment, charlie.addr);

      // Compound more yield
      await performCompoundYield(algod, deployment, creator, 50_000_000, 100);

      const aliceAlphaAfter = await getUserAlphaBalance(algod, deployment, alice.addr);
      const charlieAlphaAfter = await getUserAlphaBalance(algod, deployment, charlie.addr);

      // Both should have gained
      expect(aliceAlphaAfter).toBeGreaterThan(aliceAlphaBefore);
      expect(charlieAlphaAfter).toBeGreaterThan(charlieAlphaBefore);

      // Bob has 0 shares, so no change in his potential Alpha
      const bobAlpha = await getUserAlphaBalance(algod, deployment, bob.addr);
      expect(bobAlpha).toBe(0);

      console.log('Phase 4 - After second compound:');
      console.log('  Alice Alpha:', aliceAlphaBefore / 1_000_000, '->', aliceAlphaAfter / 1_000_000);
      console.log('  Charlie Alpha:', charlieAlphaBefore / 1_000_000, '->', charlieAlphaAfter / 1_000_000);
    });

    it('Phase 5: Creator claims fees', async () => {

      const stats = await getVaultStats(algod, deployment);
      const expectedCreatorAlpha = stats.creatorUnclaimedAlpha;

      console.log('Phase 5 - Creator accumulated fees:', expectedCreatorAlpha / 1_000_000);

      const creatorAlphaBefore = await getAssetBalance(algod, creator.addr, deployment.alphaAssetId);
      await performClaimCreator(algod, deployment, creator);
      const creatorAlphaAfter = await getAssetBalance(algod, creator.addr, deployment.alphaAssetId);

      const creatorClaimed = creatorAlphaAfter - creatorAlphaBefore;
      expect(creatorClaimed).toBe(expectedCreatorAlpha);

      const statsAfter = await getVaultStats(algod, deployment);
      expect(statsAfter.creatorUnclaimedAlpha).toBe(0);

      console.log('Phase 5 - Creator claimed:', creatorClaimed / 1_000_000);
    });

    it('Phase 6: Final withdrawals and accounting verification', async () => {

      // Get vault state before final withdrawals
      const statsBefore = await getVaultStats(algod, deployment);
      const aliceAlphaBefore = await getUserAlphaBalance(algod, deployment, alice.addr);
      const charlieAlphaBefore = await getUserAlphaBalance(algod, deployment, charlie.addr);

      console.log('Phase 6 - Before final withdrawals:');
      console.log('  Total Alpha in vault:', statsBefore.totalAlpha / 1_000_000);
      console.log('  Alice Alpha:', aliceAlphaBefore / 1_000_000);
      console.log('  Charlie Alpha:', charlieAlphaBefore / 1_000_000);

      // Both close out
      await performCloseOut(algod, deployment, alice);
      await performCloseOut(algod, deployment, charlie);

      // Verify final state
      const statsAfter = await getVaultStats(algod, deployment);
      expect(statsAfter.totalShares).toBe(0);

      // Vault should have minimal dust left
      expect(statsAfter.totalAlpha).toBeLessThan(1000); // Less than 0.001 Alpha dust

      console.log('Phase 6 - Final state:');
      console.log('  Total shares:', statsAfter.totalShares);
      console.log('  Total Alpha:', statsAfter.totalAlpha);
    });
  });

  /**
   * COMPREHENSIVE MULTI-USER STRESS TEST - EXTREME BALANCE RANGES
   * Tests with 6 users, from very small (1.2 ALPHA) to very large (500k ALPHA)
   */
  describe('Multi-User Stress Test - Extreme Balance Ranges', () => {
    let deployment: CompoundingVaultDeploymentResult;
    let charlie: { addr: string; sk: Uint8Array };
    let dave: { addr: string; sk: Uint8Array };
    let eve: { addr: string; sk: Uint8Array };
    let frank: { addr: string; sk: Uint8Array };

    // Using 6 decimals: 1 ALPHA = 1_000_000 microAlpha
    const WHALE_DEPOSIT = 500_000_000_000;      // 500,000 ALPHA
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
          amount: 10_000_000,
          suggestedParams,
        });
        const signed = fundTxn.signTxn(creator.sk);
        const { txid } = await algod.sendRawTransaction(signed).do();
        await algosdk.waitForConfirmation(algod, txid, 5);
      }

      // Deploy with large pool reserves
      deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 5,
        minSwapThreshold: 2_000_000,
        poolReserveUsdc: 1_000_000_000_000,  // 1M USDC
        poolReserveAlpha: 1_000_000_000_000, // 1M Alpha
      });

      // Fund all users with Alpha
      for (const user of [alice, bob, charlie, dave, eve, frank]) {
        await optInToAsset(algod, user, deployment.alphaAssetId);
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
      expect(stats.totalAlpha).toBe(expectedTotal);
      expect(stats.totalShares).toBe(expectedTotal); // First deposits, 1:1 shares

      console.log('Phase 1 - Deposits registered:');
      console.log('  Alice (whale):', WHALE_DEPOSIT / 1_000_000, 'ALPHA');
      console.log('  Bob (large):', LARGE_DEPOSIT / 1_000_000, 'ALPHA');
      console.log('  Charlie (medium):', MEDIUM_DEPOSIT / 1_000_000, 'ALPHA');
      console.log('  Dave (small):', SMALL_DEPOSIT / 1_000_000, 'ALPHA');
      console.log('  Eve (tiny):', TINY_DEPOSIT / 1_000_000, 'ALPHA');
      console.log('  Frank (micro):', MICRO_DEPOSIT / 1_000_000, 'ALPHA');
    });

    it('Phase 2: Large compound - verify micro depositor benefits', async () => {
      const statsBefore = await getVaultStats(algod, deployment);

      // Large yield: 10,000 USDC
      await performCompoundYield(algod, deployment, creator, 10_000_000_000, 100);

      const statsAfter = await getVaultStats(algod, deployment);

      // Share price should increase
      expect(statsAfter.sharePrice).toBeGreaterThan(statsBefore.sharePrice);

      // Verify micro depositor (Frank) benefits
      const frankAlpha = await getUserAlphaBalance(algod, deployment, frank.addr);
      expect(frankAlpha).toBeGreaterThan(MICRO_DEPOSIT);

      // Calculate expected ratio (Frank should have gained proportionally)
      const frankGain = frankAlpha - MICRO_DEPOSIT;
      const expectedFrankShare = MICRO_DEPOSIT / statsBefore.totalAlpha;

      console.log('Phase 2 - Large compound (10k USDC):');
      console.log('  Share price:', statsBefore.sharePrice / SCALE, '->', statsAfter.sharePrice / SCALE);
      console.log('  Frank Alpha:', frankAlpha / 1_000_000, '(gained:', frankGain / 1_000_000, ')');
      console.log('  Frank share of pool:', (expectedFrankShare * 100).toFixed(6) + '%');
    });

    it('Phase 3: Multiple small compounds - dust accumulation test', async () => {
      const frankAlphaBefore = await getUserAlphaBalance(algod, deployment, frank.addr);

      // 10 small compounds
      for (let i = 0; i < 10; i++) {
        await performCompoundYield(algod, deployment, creator, 5_000_000, 100);
      }

      const frankAlphaAfter = await getUserAlphaBalance(algod, deployment, frank.addr);
      expect(frankAlphaAfter).toBeGreaterThan(frankAlphaBefore);

      console.log('Phase 3 - After 10 small compounds:');
      console.log('  Frank Alpha:', frankAlphaBefore / 1_000_000, '->', frankAlphaAfter / 1_000_000);
    });

    it('Phase 4: Whale partial withdrawal - verify share price stays correct', async () => {
      const statsBefore = await getVaultStats(algod, deployment);
      const aliceSharesBefore = await getUserShares(algod, deployment, alice.addr);

      // Alice withdraws half her shares
      const withdrawShares = Math.floor(aliceSharesBefore / 2);
      await performWithdraw(algod, deployment, alice, withdrawShares);

      const statsAfter = await getVaultStats(algod, deployment);

      // Share price should stay the same (withdrawal doesn't affect price)
      expect(statsAfter.sharePrice).toBeCloseTo(statsBefore.sharePrice, -6);

      // Total shares should decrease
      expect(statsAfter.totalShares).toBe(statsBefore.totalShares - withdrawShares);

      console.log('Phase 4 - Whale partial withdrawal:');
      console.log('  Alice withdrew:', withdrawShares / 1_000_000, 'shares');
      console.log('  Share price unchanged:', statsAfter.sharePrice / SCALE);
    });

    it('Phase 5: Micro depositor doubles position, then compound', async () => {
      const frankSharesBefore = await getUserShares(algod, deployment, frank.addr);
      const statsBefore = await getVaultStats(algod, deployment);

      // Frank deposits more (doubling his position)
      await performDeposit(algod, deployment, frank, MICRO_DEPOSIT);

      const statsAfterDeposit = await getVaultStats(algod, deployment);
      const frankSharesAfter = await getUserShares(algod, deployment, frank.addr);

      // Frank should get fewer shares (share price > 1)
      const newShares = frankSharesAfter - frankSharesBefore;
      expect(newShares).toBeLessThan(MICRO_DEPOSIT);

      // Compound yield
      await performCompoundYield(algod, deployment, creator, 100_000_000, 100);

      const frankAlphaFinal = await getUserAlphaBalance(algod, deployment, frank.addr);

      console.log('Phase 5 - Frank doubles position:');
      console.log('  Old shares:', frankSharesBefore / 1_000_000);
      console.log('  New shares gained:', newShares / 1_000_000, '(deposited 1.2 ALPHA at price', statsAfterDeposit.sharePrice / SCALE, ')');
      console.log('  Total shares:', frankSharesAfter / 1_000_000);
      console.log('  Frank Alpha value:', frankAlphaFinal / 1_000_000);
    });

    it('Phase 6: Final accounting - all users close out', async () => {
      // Get vault state before close outs
      const statsBefore = await getVaultStats(algod, deployment);

      // Creator claims fees first
      await performClaimCreator(algod, deployment, creator);

      // Everyone closes out
      let totalAlphaWithdrawn = 0;
      for (const user of [alice, bob, charlie, dave, eve, frank]) {
        const alphaBefore = await getAssetBalance(algod, user.addr, deployment.alphaAssetId);
        await performCloseOut(algod, deployment, user);
        const alphaAfter = await getAssetBalance(algod, user.addr, deployment.alphaAssetId);
        totalAlphaWithdrawn += (alphaAfter - alphaBefore);
      }

      // Final stats
      const statsAfter = await getVaultStats(algod, deployment);
      expect(statsAfter.totalShares).toBe(0);

      // Dust should be minimal
      expect(statsAfter.totalAlpha).toBeLessThan(1000);

      console.log('Phase 6 - Final accounting:');
      console.log('  Total Alpha withdrawn:', totalAlphaWithdrawn / 1_000_000);
      console.log('  Vault Alpha remaining (dust):', statsAfter.totalAlpha);
    });
  });

  /**
   * FARM FEATURE COMPREHENSIVE TESTS
   * Tests farming with and without farm bonus across multiple scenarios
   */
  describe('Farm Feature - Comprehensive Tests', () => {
    describe('Without Farm (baseline)', () => {
      let deployment: CompoundingVaultDeploymentResult;

      beforeAll(async () => {
        deployment = await deployCompoundingVaultForTest(algod, creator, {
          creatorFeeRate: 5,
          minSwapThreshold: 2_000_000,
        });

        await optInToAsset(algod, alice, deployment.alphaAssetId);
        await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 10_000_000_000);

        await performUserOptIn(algod, deployment, alice);
        await performDeposit(algod, deployment, alice, 1_000_000_000);
      });

      it('should compound without farm bonus', async () => {
        const statsBefore = await getVaultStats(algod, deployment);
        const farmStats = await getFarmStats(algod, deployment);

        expect(farmStats.farmBalance).toBe(0);
        expect(farmStats.emissionRatio).toBe(0);

        // Compound 100 USDC
        await performCompoundYield(algod, deployment, creator, 100_000_000, 100);

        const statsAfter = await getVaultStats(algod, deployment);

        // ~100 USDC * 0.997 (swap fee) * 0.8 (creator fee) = ~79.76 Alpha added
        const alphaAdded = statsAfter.totalAlpha - statsBefore.totalAlpha;

        console.log('Without farm - compound result:');
        console.log('  Alpha added (no farm):', alphaAdded / 1_000_000);
      });
    });

    describe('With Farm Active', () => {
      let deployment: CompoundingVaultDeploymentResult;
      let alphaAddedWithoutFarm: number;
      let alphaAddedWithFarm: number;

      beforeAll(async () => {
        deployment = await deployCompoundingVaultForTest(algod, creator, {
          creatorFeeRate: 5,
          minSwapThreshold: 2_000_000,
        });

        await optInToAsset(algod, alice, deployment.alphaAssetId);
        await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 10_000_000_000);

        await performUserOptIn(algod, deployment, alice);
        await performDeposit(algod, deployment, alice, 1_000_000_000);
      });

      it('should show no farm bonus initially', async () => {
        const statsBefore = await getVaultStats(algod, deployment);

        await performCompoundYield(algod, deployment, creator, 100_000_000, 100);

        const statsAfter = await getVaultStats(algod, deployment);
        alphaAddedWithoutFarm = statsAfter.totalAlpha - statsBefore.totalAlpha;

        console.log('Baseline (no farm):', alphaAddedWithoutFarm / 1_000_000, 'ALPHA');
      });

      it('should allow contributing to farm', async () => {
        await performContributeFarm(algod, deployment, creator, 500_000_000); // 500 ALPHA

        const farmStats = await getFarmStats(algod, deployment);
        expect(farmStats.farmBalance).toBe(500_000_000);

        console.log('Farm balance:', farmStats.farmBalance / 1_000_000, 'ALPHA');
      });

      it('should set emission ratio', async () => {
        await performSetEmissionRatio(algod, deployment, creator, 5000); // 50%

        const farmStats = await getFarmStats(algod, deployment);
        expect(farmStats.emissionRatio).toBe(5000);

        console.log('Emission ratio:', farmStats.emissionRatio);
      });

      it('should add farm bonus to compound', async () => {
        const statsBefore = await getVaultStats(algod, deployment);
        const farmBefore = await getFarmStats(algod, deployment);

        await performCompoundYield(algod, deployment, creator, 100_000_000, 100);

        const statsAfter = await getVaultStats(algod, deployment);
        const farmAfter = await getFarmStats(algod, deployment);

        alphaAddedWithFarm = statsAfter.totalAlpha - statsBefore.totalAlpha;

        // Farm should have decreased
        expect(farmAfter.farmBalance).toBeLessThan(farmBefore.farmBalance);

        // More Alpha should be added with farm bonus
        expect(alphaAddedWithFarm).toBeGreaterThan(alphaAddedWithoutFarm);

        const farmBonus = farmBefore.farmBalance - farmAfter.farmBalance;

        console.log('With farm:');
        console.log('  Alpha added:', alphaAddedWithFarm / 1_000_000, '(was', alphaAddedWithoutFarm / 1_000_000, ')');
        console.log('  Farm bonus used:', farmBonus / 1_000_000, 'ALPHA');
        console.log('  Improvement:', ((alphaAddedWithFarm / alphaAddedWithoutFarm - 1) * 100).toFixed(2) + '%');
      });

      it('should deplete farm over multiple compounds', async () => {
        const farmBefore = await getFarmStats(algod, deployment);

        // Multiple compounds to deplete farm
        for (let i = 0; i < 5; i++) {
          await performCompoundYield(algod, deployment, creator, 100_000_000, 100);
        }

        const farmAfter = await getFarmStats(algod, deployment);

        console.log('Farm depletion:');
        console.log('  Before:', farmBefore.farmBalance / 1_000_000, 'ALPHA');
        console.log('  After:', farmAfter.farmBalance / 1_000_000, 'ALPHA');
      });
    });

    describe('Farm + Creator Fee Interaction', () => {
      it('should apply creator fee on total output including farm bonus', async () => {
        const CREATOR_FEE = 5; // 5%
        const deployment = await deployCompoundingVaultForTest(algod, creator, {
          creatorFeeRate: CREATOR_FEE,
          minSwapThreshold: 2_000_000,
        });

        await optInToAsset(algod, alice, deployment.alphaAssetId);
        await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 10_000_000_000);

        await performUserOptIn(algod, deployment, alice);
        await performDeposit(algod, deployment, alice, 1_000_000_000);

        // Setup farm: 500 Alpha, high emission ratio to get a big bonus
        await performContributeFarm(algod, deployment, creator, 500_000_000); // 500 Alpha
        await performSetEmissionRatio(algod, deployment, creator, 5000); // 50%

        const farmBefore = await getFarmStats(algod, deployment);
        const statsBefore = await getVaultStats(algod, deployment);

        // Trigger compound
        await performCompoundYield(algod, deployment, creator, 100_000_000, 100);

        const farmAfter = await getFarmStats(algod, deployment);
        const statsAfter = await getVaultStats(algod, deployment);

        const farmBonus = farmBefore.farmBalance - farmAfter.farmBalance;
        expect(farmBonus).toBeGreaterThan(0);

        // Total yield compounded = swap output + farm bonus
        const totalYieldCompounded = statsAfter.totalYieldCompounded - statsBefore.totalYieldCompounded;

        // Creator should get exactly CREATOR_FEE% of total (swap + farm bonus)
        const creatorCut = statsAfter.creatorUnclaimedAlpha - statsBefore.creatorUnclaimedAlpha;
        const expectedCreatorCut = Math.floor(totalYieldCompounded * CREATOR_FEE / 100);

        // Vault (depositors) get the rest
        const vaultCut = statsAfter.totalAlpha - statsBefore.totalAlpha;
        const expectedVaultCut = totalYieldCompounded - expectedCreatorCut;

        // Verify creator fee is taken on TOTAL (swap + farm), not just swap
        expect(creatorCut).toBe(expectedCreatorCut);
        expect(vaultCut).toBe(expectedVaultCut);

        // Verify farm bonus is included (creator cut > what it would be without farm)
        const swapOnlyOutput = totalYieldCompounded - farmBonus;
        const creatorCutWithoutFarm = Math.floor(swapOnlyOutput * CREATOR_FEE / 100);
        expect(creatorCut).toBeGreaterThan(creatorCutWithoutFarm);

        console.log('Farm + Creator Fee interaction:');
        console.log('  Total yield (swap + farm):', totalYieldCompounded / 1_000_000, 'ALPHA');
        console.log('  Farm bonus:', farmBonus / 1_000_000, 'ALPHA');
        console.log('  Creator cut (5% of total):', creatorCut / 1_000_000, 'ALPHA');
        console.log('  Creator cut if no farm:', creatorCutWithoutFarm / 1_000_000, 'ALPHA');
        console.log('  Vault cut (depositors):', vaultCut / 1_000_000, 'ALPHA');
      });
    });

    describe('Farm Edge Cases', () => {
      it('should handle compound when farm is empty', async () => {
        const deployment = await deployCompoundingVaultForTest(algod, creator, {
          creatorFeeRate: 0,
          minSwapThreshold: 2_000_000,
        });

        await optInToAsset(algod, alice, deployment.alphaAssetId);
        await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 10_000_000_000);

        await performUserOptIn(algod, deployment, alice);
        await performDeposit(algod, deployment, alice, 1_000_000_000);

        // Set emission ratio but no farm balance
        await performSetEmissionRatio(algod, deployment, creator, 5000);

        const statsBefore = await getVaultStats(algod, deployment);
        await performCompoundYield(algod, deployment, creator, 100_000_000, 100);
        const statsAfter = await getVaultStats(algod, deployment);

        // Should still work, just without bonus
        expect(statsAfter.totalAlpha).toBeGreaterThan(statsBefore.totalAlpha);

        console.log('Empty farm compound:', (statsAfter.totalAlpha - statsBefore.totalAlpha) / 1_000_000, 'ALPHA');
      });

      it('should cap farm bonus at available balance', async () => {
        const deployment = await deployCompoundingVaultForTest(algod, creator, {
          creatorFeeRate: 0,
          minSwapThreshold: 2_000_000,
        });

        await optInToAsset(algod, alice, deployment.alphaAssetId);
        await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 10_000_000_000);

        await performUserOptIn(algod, deployment, alice);
        await performDeposit(algod, deployment, alice, 1_000_000_000);

        // Small farm, high emission ratio
        await performContributeFarm(algod, deployment, creator, 1_000_000); // 1 ALPHA
        await performSetEmissionRatio(algod, deployment, creator, 10000); // 100%

        const farmBefore = await getFarmStats(algod, deployment);

        // Large compound that would exceed farm if uncapped
        await performCompoundYield(algod, deployment, creator, 100_000_000, 100); // ~100 Alpha from swap

        const farmAfter = await getFarmStats(algod, deployment);

        // Farm should be completely depleted
        expect(farmAfter.farmBalance).toBe(0);

        console.log('Farm cap test:');
        console.log('  Farm before:', farmBefore.farmBalance / 1_000_000);
        console.log('  Farm after:', farmAfter.farmBalance / 1_000_000);
      });
    });
  });

  /**
   * PRECISION AND ROUNDING DEEP DIVE
   * Tests edge cases for share calculations with extreme values
   */
  describe('Precision and Rounding Deep Dive', () => {
    it('should handle prime number deposits with prime compound correctly', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, bob, deployment.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 100_000_000_000);
      await fundAsset(algod, creator, bob.addr, deployment.alphaAssetId, 100_000_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performUserOptIn(algod, deployment, bob);

      // Prime number deposits
      const aliceDeposit = 17_000_003;
      const bobDeposit = 31_000_007;

      await performDeposit(algod, deployment, alice, aliceDeposit);
      await performDeposit(algod, deployment, bob, bobDeposit);

      // Prime compound
      await performCompoundYield(algod, deployment, creator, 7_000_013, 100);

      const aliceAlpha = await getUserAlphaBalance(algod, deployment, alice.addr);
      const bobAlpha = await getUserAlphaBalance(algod, deployment, bob.addr);

      // Expected ratio should match deposit ratio
      const actualRatio = aliceAlpha / bobAlpha;
      const expectedRatio = aliceDeposit / bobDeposit;

      expect(actualRatio).toBeCloseTo(expectedRatio, 2);

      // Verify total accounting
      const stats = await getVaultStats(algod, deployment);
      const totalUserAlpha = aliceAlpha + bobAlpha;

      // Should match totalAlpha minus rounding (< 10 units)
      expect(Math.abs(stats.totalAlpha - totalUserAlpha)).toBeLessThan(10);

      console.log('Prime number test:');
      console.log('  Alice:', aliceAlpha / 1_000_000, 'Alpha');
      console.log('  Bob:', bobAlpha / 1_000_000, 'Alpha');
      console.log('  Ratio:', actualRatio.toFixed(6), '(expected:', expectedRatio.toFixed(6), ')');
    });

    it('should handle extreme ratio (500k:1) without losing dust value', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
        poolReserveUsdc: 1_000_000_000_000,
        poolReserveAlpha: 1_000_000_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, bob, deployment.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 600_000_000_000);
      await fundAsset(algod, creator, bob.addr, deployment.alphaAssetId, 10_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performUserOptIn(algod, deployment, bob);

      // Whale vs dust
      const whaleDeposit = 500_000_000_000;
      const dustDeposit = 1_000_000;

      await performDeposit(algod, deployment, alice, whaleDeposit);
      await performDeposit(algod, deployment, bob, dustDeposit);

      // Large compound to ensure dust user gets something
      await performCompoundYield(algod, deployment, creator, 100_000_000_000, 100);

      const bobAlpha = await getUserAlphaBalance(algod, deployment, bob.addr);

      // Bob should have gained from compound
      expect(bobAlpha).toBeGreaterThan(dustDeposit);

      const bobGain = bobAlpha - dustDeposit;
      const expectedGainRatio = dustDeposit / (whaleDeposit + dustDeposit);

      console.log('Extreme ratio test (500,000:1):');
      console.log('  Bob deposit:', dustDeposit / 1_000_000, 'Alpha');
      console.log('  Bob final:', bobAlpha / 1_000_000, 'Alpha');
      console.log('  Bob gain:', bobGain / 1_000_000, 'Alpha');
      console.log('  Expected share:', (expectedGainRatio * 100).toFixed(6) + '%');
    });

    it('should accumulate many small compounds without precision loss', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 100_000_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);

      const statsBefore = await getVaultStats(algod, deployment);

      // 20 minimum compounds
      for (let i = 0; i < 20; i++) {
        await performCompoundYield(algod, deployment, creator, 2_000_000, 100);
      }

      const statsAfter = await getVaultStats(algod, deployment);
      const aliceAlpha = await getUserAlphaBalance(algod, deployment, alice.addr);

      // Total should match Alice's balance (she's only depositor)
      expect(Math.abs(statsAfter.totalAlpha - aliceAlpha)).toBeLessThan(100);

      console.log('Many small compounds (20x 2 USDC):');
      console.log('  Alice Alpha:', aliceAlpha / 1_000_000);
      console.log('  Total Alpha:', statsAfter.totalAlpha / 1_000_000);
      console.log('  Share price:', statsAfter.sharePrice / SCALE);
    });

    it('should handle deposit-withdraw-deposit cycles with share price changes', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 500_000_000_000);

      await performUserOptIn(algod, deployment, alice);

      // Round 1: Deposit 100, compound, check value
      await performDeposit(algod, deployment, alice, 100_000_000);
      await performCompoundYield(algod, deployment, creator, 10_000_000, 100);

      const round1Alpha = await getUserAlphaBalance(algod, deployment, alice.addr);
      const round1Stats = await getVaultStats(algod, deployment);

      // Withdraw all
      await performWithdraw(algod, deployment, alice, 0);

      // Round 2: Deposit 200 at new share price
      await performDeposit(algod, deployment, alice, 200_000_000);
      const round2Shares = await getUserShares(algod, deployment, alice.addr);
      const round2Stats = await getVaultStats(algod, deployment);

      // Share price is 1:1 again after complete withdrawal
      expect(round2Shares).toBe(200_000_000);
      expect(round2Stats.sharePrice).toBe(SCALE);

      // Compound and check
      await performCompoundYield(algod, deployment, creator, 20_000_000, 100);
      const round2Alpha = await getUserAlphaBalance(algod, deployment, alice.addr);

      console.log('Deposit-withdraw cycles:');
      console.log('  Round 1: 100 deposit ->', round1Alpha / 1_000_000, 'Alpha');
      console.log('  Round 2: 200 deposit ->', round2Alpha / 1_000_000, 'Alpha');
    });
  });

  /**
   * 10-PHASE REAL-WORLD SCENARIO WITH FARM
   * Comprehensive test simulating realistic usage with farming enabled
   */
  describe('10-Phase Real-World Scenario with Farm', () => {
    let deployment: CompoundingVaultDeploymentResult;
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

      deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 5,
        minSwapThreshold: 5_000_000,
        poolReserveUsdc: 500_000_000_000,
        poolReserveAlpha: 500_000_000_000,
      });

      for (const user of [alice, bob, charlie, dave]) {
        await optInToAsset(algod, user, deployment.alphaAssetId);
        await fundAsset(algod, creator, user.addr, deployment.alphaAssetId, 200_000_000_000);
      }
    });

    it('Phase 1: Initial deposits - varying sizes', async () => {
      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000_000); // 100k

      await performUserOptIn(algod, deployment, bob);
      await performDeposit(algod, deployment, bob, 25_000_000_000); // 25k

      const stats = await getVaultStats(algod, deployment);
      expect(stats.totalShares).toBe(125_000_000_000);

      console.log('Phase 1: Alice 100k, Bob 25k');
    });

    it('Phase 2: First compound (no farm)', async () => {
      await performCompoundYield(algod, deployment, creator, 1_000_000_000, 100);

      const stats = await getVaultStats(algod, deployment);
      const aliceAlpha = await getUserAlphaBalance(algod, deployment, alice.addr);
      const bobAlpha = await getUserAlphaBalance(algod, deployment, bob.addr);

      expect(aliceAlpha / bobAlpha).toBeCloseTo(4.0, 1);

      console.log('Phase 2: Compound 1000 USDC, share price:', stats.sharePrice / SCALE);
    });

    it('Phase 3: Enable farm with 1000 Alpha', async () => {
      await performContributeFarm(algod, deployment, creator, 1_000_000_000);
      await performSetEmissionRatio(algod, deployment, creator, 2000); // 20%

      const farmStats = await getFarmStats(algod, deployment);
      expect(farmStats.farmBalance).toBe(1_000_000_000);
      expect(farmStats.emissionRatio).toBe(2000);

      console.log('Phase 3: Farm enabled with 1000 Alpha, ratio:', farmStats.emissionRatio);
    });

    it('Phase 4: Charlie joins, compound with farm bonus', async () => {
      await performUserOptIn(algod, deployment, charlie);
      await performDeposit(algod, deployment, charlie, 50_000_000_000); // 50k

      const farmBefore = await getFarmStats(algod, deployment);
      const statsBefore = await getVaultStats(algod, deployment);

      await performCompoundYield(algod, deployment, creator, 500_000_000, 100);

      const farmAfter = await getFarmStats(algod, deployment);
      const statsAfter = await getVaultStats(algod, deployment);

      expect(farmAfter.farmBalance).toBeLessThan(farmBefore.farmBalance);

      console.log('Phase 4: Charlie joined, compound with farm:');
      console.log('  Farm used:', (farmBefore.farmBalance - farmAfter.farmBalance) / 1_000_000);
    });

    it('Phase 5: Alice partial withdrawal', async () => {
      const aliceSharesBefore = await getUserShares(algod, deployment, alice.addr);
      await performWithdraw(algod, deployment, alice, Math.floor(aliceSharesBefore / 3));

      const aliceSharesAfter = await getUserShares(algod, deployment, alice.addr);
      expect(aliceSharesAfter).toBeCloseTo((aliceSharesBefore * 2) / 3, -5);

      console.log('Phase 5: Alice withdrew 1/3 of shares');
    });

    it('Phase 6: Dave joins with small amount', async () => {
      await performUserOptIn(algod, deployment, dave);
      await performDeposit(algod, deployment, dave, 5_000_000); // 5 Alpha

      const daveShares = await getUserShares(algod, deployment, dave.addr);
      const stats = await getVaultStats(algod, deployment);

      // Dave gets fewer shares due to share price > 1
      expect(daveShares).toBeLessThan(5_000_000);

      console.log('Phase 6: Dave joined with 5 Alpha, got', daveShares / 1_000_000, 'shares');
    });

    it('Phase 7: Large compound draining farm', async () => {
      const farmBefore = await getFarmStats(algod, deployment);

      // Multiple large compounds
      for (let i = 0; i < 3; i++) {
        await performCompoundYield(algod, deployment, creator, 2_000_000_000, 100);
      }

      const farmAfter = await getFarmStats(algod, deployment);

      console.log('Phase 7: Large compounds:');
      console.log('  Farm before:', farmBefore.farmBalance / 1_000_000);
      console.log('  Farm after:', farmAfter.farmBalance / 1_000_000);
    });

    it('Phase 8: Bob withdraws all', async () => {
      const bobAlphaBefore = await getAssetBalance(algod, bob.addr, deployment.alphaAssetId);
      const bobAlphaValue = await getUserAlphaBalance(algod, deployment, bob.addr);

      await performWithdraw(algod, deployment, bob, 0);

      const bobAlphaAfter = await getAssetBalance(algod, bob.addr, deployment.alphaAssetId);
      const withdrawn = bobAlphaAfter - bobAlphaBefore;

      expect(withdrawn).toBeCloseTo(bobAlphaValue, -5);

      console.log('Phase 8: Bob withdrew all:', withdrawn / 1_000_000, 'Alpha');
    });

    it('Phase 9: Final compounds', async () => {
      // Multiple small compounds
      for (let i = 0; i < 5; i++) {
        await performCompoundYield(algod, deployment, creator, 100_000_000, 100);
      }

      const stats = await getVaultStats(algod, deployment);
      console.log('Phase 9: Final share price:', stats.sharePrice / SCALE);
    });

    it('Phase 10: Complete close out - verify accounting', async () => {
      const statsBefore = await getVaultStats(algod, deployment);

      // Creator claims fees
      await performClaimCreator(algod, deployment, creator);

      // Everyone closes out
      for (const user of [alice, charlie, dave]) {
        const shares = await getUserShares(algod, deployment, user.addr);
        if (shares > 0) {
          await performCloseOut(algod, deployment, user);
        }
      }

      // Bob already withdrew, just close out
      try {
        await performCloseOut(algod, deployment, bob);
      } catch (e) {
        // May fail if already closed
      }

      const statsAfter = await getVaultStats(algod, deployment);

      console.log('Phase 10 - Final accounting:');
      console.log('  Total shares:', statsAfter.totalShares);
      console.log('  Total Alpha:', statsAfter.totalAlpha);
      console.log('  Dust remaining:', statsAfter.totalAlpha);

      // Minimal dust
      expect(statsAfter.totalAlpha).toBeLessThan(1000);
    });
  });

  /**
   * CREATOR FEE RATE UPDATE TESTS
   * Tests the updateCreatorFeeRate method with 0-6% constraint
   */
  describe('Creator Fee Rate Update', () => {
    let deployment: CompoundingVaultDeploymentResult;

    beforeAll(async () => {
      deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 3, // Start at 3%
        minSwapThreshold: 2_000_000,
      });
    });

    it('should allow creator to update fee rate within valid range (0-6%)', async () => {
      // Update to 5%
      await performUpdateCreatorFeeRate(algod, deployment, creator, 5);

      // Verify by doing a compound and checking creator gets 5%
      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 1_000_000_000);
      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);

      await performCompoundYield(algod, deployment, creator, 100_000_000, 100);

      const stats = await getVaultStats(algod, deployment);
      // Creator fee should be approximately 5% of the compound output
      expect(stats.creatorUnclaimedAlpha).toBeGreaterThan(0);

      console.log('Fee rate updated to 5%, creator unclaimed:', stats.creatorUnclaimedAlpha / 1_000_000);
    });

    it('should allow creator to set fee rate to 0%', async () => {
      const newDeployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 3,
        minSwapThreshold: 2_000_000,
      });

      await performUpdateCreatorFeeRate(algod, newDeployment, creator, 0);

      // Setup and compound
      await optInToAsset(algod, bob, newDeployment.alphaAssetId);
      await fundAsset(algod, creator, bob.addr, newDeployment.alphaAssetId, 1_000_000_000);
      await performUserOptIn(algod, newDeployment, bob);
      await performDeposit(algod, newDeployment, bob, 100_000_000);

      await performCompoundYield(algod, newDeployment, creator, 100_000_000, 100);

      const stats = await getVaultStats(algod, newDeployment);
      expect(stats.creatorUnclaimedAlpha).toBe(0);

      console.log('Fee rate set to 0%, creator unclaimed:', stats.creatorUnclaimedAlpha);
    });

    it('should allow creator to set fee rate to maximum 6%', async () => {
      const newDeployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await performUpdateCreatorFeeRate(algod, newDeployment, creator, 6);

      console.log('Fee rate set to maximum 6%');
    });

    it('should reject fee rate above 6%', async () => {
      const newDeployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 3,
        minSwapThreshold: 2_000_000,
      });

      await expect(
        performUpdateCreatorFeeRate(algod, newDeployment, creator, 7)
      ).rejects.toThrow();

      console.log('Correctly rejected fee rate of 7%');
    });

    it('should reject non-creator updating fee rate', async () => {
      const newDeployment = await deployCompoundingVaultForTest(algod, creator, {
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
   * MAX SLIPPAGE UPDATE TESTS
   * Tests updateMaxSlippage constraints: creator-only, range 5-100% (500-10000 bps)
   */
  describe('Max Slippage', () => {
    it('should allow creator to update maxSlippageBps', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      // Default is 5000 (50%), update to 2000 (20%)
      await performUpdateMaxSlippage(algod, deployment, creator, 2000);

      const appInfo = await algod.getApplicationByID(deployment.vaultAppId).do();
      const globalState: Record<string, number> = {};
      for (const kv of appInfo.params?.globalState || []) {
        let key: string;
        if (kv.key instanceof Uint8Array) {
          key = new TextDecoder().decode(kv.key);
        } else {
          key = Buffer.from(kv.key as string, 'base64').toString('utf8');
        }
        if (kv.value.type === 2) {
          globalState[key] = Number(kv.value.uint);
        }
      }
      expect(globalState['maxSlippageBps']).toBe(2000);
      console.log('Creator updated maxSlippageBps to 2000 (20%)');
    });

    it('should reject maxSlippageBps below 5% (500 bps)', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await expect(
        performUpdateMaxSlippage(algod, deployment, creator, 499)
      ).rejects.toThrow();

      console.log('Correctly rejected maxSlippageBps below minimum (499)');
    });

    it('should reject maxSlippageBps above 100% (10000 bps)', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await expect(
        performUpdateMaxSlippage(algod, deployment, creator, 10001)
      ).rejects.toThrow();

      console.log('Correctly rejected maxSlippageBps above maximum (10001)');
    });

    it('should reject non-creator updating maxSlippageBps', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await expect(
        performUpdateMaxSlippage(algod, deployment, alice, 2000)
      ).rejects.toThrow();

      console.log('Correctly rejected non-creator maxSlippage update');
    });
  });

  /**
   * CREATOR CLAIM ACCESS CONTROL TEST
   */
  describe('Creator Claim Access Control', () => {
    it('should reject non-creator calling claimCreator', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 5,
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.usdcAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 100_000_000);
      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);

      // Generate some yield so there's something to claim
      await performCompoundYield(algod, deployment, creator, 10_000_000, 100);

      // Alice (non-creator) tries to claim creator fees
      await expect(
        performClaimCreator(algod, deployment, alice)
      ).rejects.toThrow();

      console.log('Correctly rejected non-creator calling claimCreator');
    });
  });

  /**
   * EMISSION RATIO CONSTRAINT TESTS
   * Tests that emission ratio must be positive and dynamic rate floors at 10%
   */
  describe('Emission Ratio Constraints', () => {
    it('should reject setting emission ratio to 0', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      // Ratio must be > 0
      await expect(
        performSetEmissionRatio(algod, deployment, creator, 0)
      ).rejects.toThrow();

      console.log('Correctly rejected emission ratio of 0');
    });

    it('should allow setting any positive emission ratio', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      // Small ratio
      await performSetEmissionRatio(algod, deployment, creator, 500);
      let farmStats = await getFarmStats(algod, deployment);
      expect(farmStats.emissionRatio).toBe(500);

      // Large ratio (no max cap)
      await performSetEmissionRatio(algod, deployment, creator, 4_000_000);
      farmStats = await getFarmStats(algod, deployment);
      expect(farmStats.emissionRatio).toBe(4_000_000);

      console.log('Set emission ratio to various values - OK');
    });

    it('should allow setting large emission ratios (no max cap)', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      // Contribute to farm
      await performContributeFarm(algod, deployment, creator, 50_000_000);

      // Set very large ratio - should succeed (no max cap)
      await performSetEmissionRatio(algod, deployment, creator, 10_000_000);

      const farmStats = await getFarmStats(algod, deployment);
      expect(farmStats.emissionRatio).toBe(10_000_000);

      console.log('Set large emission ratio with funded farm - OK');
    });

    it('should allow contributions when emission ratio is not yet set', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      // Emission ratio starts at 0 (not yet set)
      const farmStatsBefore = await getFarmStats(algod, deployment);
      expect(farmStatsBefore.emissionRatio).toBe(0);

      // Contribution should work even without ratio set
      await performContributeFarm(algod, deployment, creator, 50_000_000);

      const farmStatsAfter = await getFarmStats(algod, deployment);
      expect(farmStatsAfter.farmBalance).toBe(50_000_000);
      expect(farmStatsAfter.emissionRatio).toBe(0); // Still 0

      // Set ratio to activate dynamic emissions
      await performSetEmissionRatio(algod, deployment, creator, 4_000_000);

      const farmStatsFinal = await getFarmStats(algod, deployment);
      expect(farmStatsFinal.emissionRatio).toBe(4_000_000);

      console.log('Contribution works without ratio set, then ratio activates emissions - OK');
    });

    it('should reject non-creator/non-rarefi setting emission ratio', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await expect(
        performSetEmissionRatio(algod, deployment, alice, 5000)
      ).rejects.toThrow();

      console.log('Correctly rejected non-creator/non-rarefi setting emission ratio');
    });

    it('should enforce 10% floor when dynamic rate would be lower', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 10_000_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 1_000_000_000); // 1000 Alpha

      // Tiny farm (1 Alpha) with small ratio on large deposits → rate would be far below 10%
      await performContributeFarm(algod, deployment, creator, 1_000_000); // 1 Alpha
      await performSetEmissionRatio(algod, deployment, creator, 100); // very small ratio

      // Dynamic rate = 1_000_000 * 100 / 1_000_000_000 = 0.1 bps → floored to 1000 bps (10%)
      const farmStats = await getFarmStatsABI(algod, deployment);
      expect(farmStats.currentDynamicRate).toBe(1000); // 10% floor

      console.log('10% floor enforced: dynamic rate =', farmStats.currentDynamicRate, 'bps (10%)');
    });

    it('should return correct currentDynamicRate from getFarmStats', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 10_000_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 1_000_000_000); // 1000 Alpha

      // No farm → rate should be 0
      let farmStats = await getFarmStatsABI(algod, deployment);
      expect(farmStats.currentDynamicRate).toBe(0);

      // Fund farm and set ratio
      await performContributeFarm(algod, deployment, creator, 500_000_000); // 500 Alpha
      await performSetEmissionRatio(algod, deployment, creator, 5000); // 50%

      // Dynamic rate = 500_000_000 * 5000 / 1_000_000_000 = 2500 bps (25%)
      farmStats = await getFarmStatsABI(algod, deployment);
      expect(farmStats.currentDynamicRate).toBe(2500);
      expect(farmStats.farmBalance).toBe(500_000_000);
      expect(farmStats.emissionRatio).toBe(5000);

      // After a compound, farm depletes → rate should decrease
      await performCompoundYield(algod, deployment, creator, 100_000_000, 100);

      const farmStatsAfter = await getFarmStatsABI(algod, deployment);
      expect(farmStatsAfter.currentDynamicRate).toBeLessThan(2500);
      expect(farmStatsAfter.farmBalance).toBeLessThan(500_000_000);

      console.log('getFarmStats ABI returns:');
      console.log('  Before compound: rate =', farmStats.currentDynamicRate, 'bps (' + (farmStats.currentDynamicRate / 100).toFixed(1) + '%)');
      console.log('  After compound: rate =', farmStatsAfter.currentDynamicRate, 'bps (' + (farmStatsAfter.currentDynamicRate / 100).toFixed(1) + '%), farm:', farmStatsAfter.farmBalance / 1_000_000, 'Alpha');
    });

    it('should return rate 0 when all users withdraw (totalAlpha = 0)', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 10_000_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 1_000_000_000);

      // Setup farm
      await performContributeFarm(algod, deployment, creator, 50_000_000);
      await performSetEmissionRatio(algod, deployment, creator, 5000);

      // Rate should be positive
      let farmStats = await getFarmStatsABI(algod, deployment);
      expect(farmStats.currentDynamicRate).toBeGreaterThan(0);

      // Withdraw all deposits
      await performWithdraw(algod, deployment, alice, 0);

      // Rate should be 0 (no depositors)
      farmStats = await getFarmStatsABI(algod, deployment);
      expect(farmStats.currentDynamicRate).toBe(0);
      expect(farmStats.farmBalance).toBe(50_000_000); // Farm still funded

      console.log('Rate = 0 when totalAlpha = 0, farm still has', farmStats.farmBalance / 1_000_000, 'Alpha');
    });
  });


  /**
   * MIN SWAP THRESHOLD UPDATE TESTS
   * Tests the updateMinSwapThreshold method with 0.20-50 USDC constraint
   */
  describe('Min Swap Threshold Update', () => {
    it('should allow creator to update threshold within valid range', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        minSwapThreshold: 2_000_000,
      });

      // Update to 10 USDC
      await performUpdateMinSwapThreshold(algod, deployment, creator, 10_000_000);

      console.log('Threshold updated to 10 USDC');
    });

    it('should allow setting threshold to minimum (0.20 USDC)', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        minSwapThreshold: 2_000_000,
      });

      await performUpdateMinSwapThreshold(algod, deployment, creator, 200_000);

      console.log('Threshold set to minimum 0.20 USDC');
    });

    it('should allow setting threshold to maximum (50 USDC)', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        minSwapThreshold: 2_000_000,
      });

      await performUpdateMinSwapThreshold(algod, deployment, creator, 50_000_000);

      console.log('Threshold set to maximum 50 USDC');
    });

    it('should reject threshold above 50 USDC', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        minSwapThreshold: 2_000_000,
      });

      await expect(
        performUpdateMinSwapThreshold(algod, deployment, creator, 50_000_001)
      ).rejects.toThrow();

      console.log('Correctly rejected threshold above 50 USDC');
    });

    it('should reject threshold below minimum (0.20 USDC)', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        minSwapThreshold: 2_000_000,
      });

      await expect(
        performUpdateMinSwapThreshold(algod, deployment, creator, 100_000)
      ).rejects.toThrow();

      console.log('Correctly rejected threshold below 0.20 USDC');
    });

    it('should reject createVault with threshold above 50 USDC', async () => {
      await expect(
        deployCompoundingVaultForTest(algod, creator, {
          minSwapThreshold: 50_000_001,
        })
      ).rejects.toThrow();

      console.log('Correctly rejected createVault with threshold above 50 USDC');
    });

    it('should reject non-creator/non-rarefi updating threshold', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        minSwapThreshold: 2_000_000,
      });

      await expect(
        performUpdateMinSwapThreshold(algod, deployment, alice, 5_000_000)
      ).rejects.toThrow();

      console.log('Correctly rejected non-creator threshold update');
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
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 0,
        minSwapThreshold: 2_000_000,
      });

      // Fund Alice with Alpha
      await optInToAsset(algod, senderAlice, deployment.alphaAssetId);
      await fundAsset(algod, creator, senderAlice.addr, deployment.alphaAssetId, 100_000_000);

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
      const alphaTransfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: senderAlice.addr,
        receiver: deployment.vaultAddress,
        amount: 10_000_000,
        assetIndex: deployment.alphaAssetId,
        suggestedParams,
      });

      const atc = new algosdk.AtomicTransactionComposer();
      atc.addTransaction({ txn: alphaTransfer, signer: aliceSigner });

      // Bob calls contributeFarm (different sender than asset transfer)
      atc.addMethodCall({
        appID: deployment.vaultAppId,
        method: contract.getMethodByName('contributeFarm'),
        methodArgs: [],
        sender: senderBob.addr,  // Bob is calling, but Alice sent the asset
        signer: bobSigner,
        suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
        appForeignAssets: [deployment.alphaAssetId],
      });

      // This should fail because transfer.sender (Alice) !== Txn.sender (Bob)
      await expect(atc.execute(algod, 5)).rejects.toThrow();

      console.log('contributeFarm sender mismatch rejected - OK');
    });
  });
});
