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
  performSetFarmEmissionRate,
  getFarmStats,
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
        creatorFeeRate: 20,
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
        creatorFeeRate: 20, // 20%
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
        creatorFeeRate: 20,
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

    it('should handle 100% fee rate correctly', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 100,
        minSwapThreshold: 2_000_000,
      });

      await optInToAsset(algod, bob, deployment.alphaAssetId);
      await fundAsset(algod, creator, bob.addr, deployment.alphaAssetId, 100_000_000);

      await performUserOptIn(algod, deployment, bob);
      await performDeposit(algod, deployment, bob, 100_000_000);

      // Compound yield
      await performCompoundYield(algod, deployment, creator, 50_000_000, 100);

      const stats = await getVaultStats(algod, deployment);
      expect(stats.creatorUnclaimedAlpha).toBeGreaterThan(0); // All to creator

      // Share price should stay at 1:1 (no yield to vault)
      expect(stats.sharePrice).toBe(SCALE);
    });

    it('should reject non-creator/rarefi from calling compoundYield', async () => {
      const deployment = await deployCompoundingVaultForTest(algod, creator);

      await optInToAsset(algod, alice, deployment.alphaAssetId);
      await optInToAsset(algod, alice, deployment.usdcAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.alphaAssetId, 100_000_000);
      await fundAsset(algod, creator, alice.addr, deployment.usdcAssetId, 100_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);

      // Alice tries to call compoundYield (should fail - only creator/rarefi allowed)
      await expect(
        performCompoundYield(algod, deployment, alice, 10_000_000, 100)
      ).rejects.toThrow();
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

  describe('Flash Deposit Protection', () => {
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

    it('should allow deposits when USDC balance is below threshold', async () => {
      // Send USDC below threshold (5 USDC, threshold is 10 USDC)
      const belowThreshold = MIN_SWAP_THRESHOLD - 5_000_000; // 5 USDC
      await fundAsset(algod, creator, deployment.vaultAddress, deployment.usdcAssetId, belowThreshold);

      // Check vault USDC balance
      const stats = await getVaultStats(algod, deployment);
      expect(stats.usdcBalance).toBe(belowThreshold);
      expect(stats.usdcBalance).toBeLessThan(MIN_SWAP_THRESHOLD);

      // Deposit should succeed
      await performDeposit(algod, deployment, alice, 10_000_000);

      const shares = await getUserShares(algod, deployment, alice.addr);
      expect(shares).toBe(110_000_000); // 100 + 10

      console.log('Below threshold: Deposit succeeded with USDC balance:', belowThreshold / 1_000_000);
    });

    it('should REJECT deposits when USDC balance equals threshold', async () => {
      // Add more USDC to reach exactly the threshold
      const currentStats = await getVaultStats(algod, deployment);
      const toAdd = MIN_SWAP_THRESHOLD - currentStats.usdcBalance;
      if (toAdd > 0) {
        await fundAsset(algod, creator, deployment.vaultAddress, deployment.usdcAssetId, toAdd);
      }

      // Verify USDC is at threshold
      const stats = await getVaultStats(algod, deployment);
      expect(stats.usdcBalance).toBe(MIN_SWAP_THRESHOLD);

      console.log('At threshold: USDC balance is exactly', stats.usdcBalance / 1_000_000);

      // Deposit should be rejected
      await expect(
        performDeposit(algod, deployment, alice, 10_000_000)
      ).rejects.toThrow();

      console.log('At threshold: Deposit correctly rejected');
    });

    it('should allow deposits again after compound clears the USDC', async () => {
      // Perform compound to clear the USDC
      const statsBefore = await getVaultStats(algod, deployment);
      console.log('Before compound: USDC balance', statsBefore.usdcBalance / 1_000_000);

      await performCompoundYield(algod, deployment, creator, 0, 100); // 0 = use existing balance

      // Verify USDC is cleared
      const statsAfter = await getVaultStats(algod, deployment);
      expect(statsAfter.usdcBalance).toBe(0);
      console.log('After compound: USDC balance', statsAfter.usdcBalance);

      // Deposit should now succeed
      await performDeposit(algod, deployment, alice, 20_000_000);

      const shares = await getUserShares(algod, deployment, alice.addr);
      expect(shares).toBeGreaterThan(0);

      console.log('After compound: Deposit succeeded');
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

    it('should allow setting farm emission rate', async () => {
      await performSetFarmEmissionRate(algod, deployment, creator, 1000); // 10%

      const farmStats = await getFarmStats(algod, deployment);
      expect(farmStats.farmEmissionRate).toBe(1000);

      console.log('Farm emission rate:', farmStats.farmEmissionRate, 'bps');
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

      // Deploy with 20% creator fee
      deployment = await deployCompoundingVaultForTest(algod, creator, {
        creatorFeeRate: 20, // 20%
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
});
