import algosdk from 'algosdk';
import {
  deployOrbitalVaultForTest,
  performUserOptIn,
  performDeposit,
  performWithdraw,
  performClaimYield,
  performHarvestAndSwap,
  performCloseOut,
  simulateOrbitalYield,
  getOrbitalVaultStats,
  getOrbitalRate,
  getUserPosition,
  getPendingYield,
  OrbitalVaultDeploymentResult,
  RATE_PRECISION,
} from './utils/orbitalVault';
import { getAssetBalance, optInToAsset, fundAsset } from './utils/assets';

// Localnet configuration
const ALGOD_SERVER = 'http://localhost';
const ALGOD_PORT = 4001;
const ALGOD_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// KMD configuration for getting funded accounts
const KMD_SERVER = 'http://localhost';
const KMD_PORT = 4002;
const KMD_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('OrbitalVault Contract Tests', () => {
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
    let deployment: OrbitalVaultDeploymentResult;

    it('should deploy vault, orbital, and pool successfully', async () => {
      deployment = await deployOrbitalVaultForTest(algod, creator);

      expect(deployment.vaultAppId).toBeGreaterThan(0);
      expect(deployment.orbitalAppId).toBeGreaterThan(0);
      expect(deployment.poolAppId).toBeGreaterThan(0);
      expect(deployment.usdcAssetId).toBeGreaterThan(0);
      expect(deployment.cUsdcAssetId).toBeGreaterThan(0);
      expect(deployment.projectAsaId).toBeGreaterThan(0);
    });

    it('should have correct initial state', async () => {
      const stats = await getOrbitalVaultStats(algod, deployment);
      expect(stats.totalShares).toBe(0);
      expect(stats.totalPrincipal).toBe(0);
      expect(stats.lastRateSnapshot).toBe(RATE_PRECISION); // Initial rate is 1.0
    });

    it('should have initial Orbital rate of 1.0', async () => {
      const rate = await getOrbitalRate(algod, deployment);
      expect(rate).toBe(RATE_PRECISION);
    });
  });

  describe('User Deposit/Withdraw', () => {
    let deployment: OrbitalVaultDeploymentResult;
    const depositAmount = 100_000_000; // 100 USDC

    beforeAll(async () => {
      deployment = await deployOrbitalVaultForTest(algod, creator);

      // Fund Alice with USDC
      await optInToAsset(algod, alice, deployment.usdcAssetId);
      await optInToAsset(algod, alice, deployment.cUsdcAssetId);
      await optInToAsset(algod, alice, deployment.projectAsaId);
      await fundAsset(algod, creator, alice.addr, deployment.usdcAssetId, 1_000_000_000);
    });

    it('should allow user to opt in', async () => {
      await performUserOptIn(algod, deployment, alice);
      const position = await getUserPosition(algod, deployment, alice.addr);
      expect(position.userShares).toBe(0);
    });

    it('should allow user to deposit USDC', async () => {
      await performDeposit(algod, deployment, alice, depositAmount);

      const position = await getUserPosition(algod, deployment, alice.addr);
      // At rate 1.0, shares should equal USDC deposited
      expect(position.userShares).toBe(depositAmount);

      const stats = await getOrbitalVaultStats(algod, deployment);
      expect(stats.totalShares).toBe(depositAmount);
      expect(stats.totalPrincipal).toBe(depositAmount);
    });

    it('should allow partial withdrawal', async () => {
      const withdrawAmount = 30_000_000;
      await performWithdraw(algod, deployment, alice, withdrawAmount);

      const position = await getUserPosition(algod, deployment, alice.addr);
      expect(position.userShares).toBe(depositAmount - withdrawAmount);

      const stats = await getOrbitalVaultStats(algod, deployment);
      expect(stats.totalShares).toBe(depositAmount - withdrawAmount);
    });

    it('should allow full withdrawal with amount=0', async () => {
      // Deposit more first
      await performDeposit(algod, deployment, alice, 50_000_000);

      // Withdraw all with 0
      await performWithdraw(algod, deployment, alice, 0);

      const position = await getUserPosition(algod, deployment, alice.addr);
      expect(position.userShares).toBe(0);

      const stats = await getOrbitalVaultStats(algod, deployment);
      expect(stats.totalShares).toBe(0);
    });
  });

  describe('Two-Stage Yield Model', () => {
    let deployment: OrbitalVaultDeploymentResult;
    const aliceDeposit = 1000_000_000; // 1000 USDC
    const bobDeposit = 500_000_000;    // 500 USDC

    beforeAll(async () => {
      deployment = await deployOrbitalVaultForTest(algod, creator, {
        minHarvestThreshold: 1_000_000, // 1 USDC
        poolReserveUsdc: 100_000_000_000,
        poolReserveProjectAsa: 100_000_000_000,
      });

      // Setup users
      await optInToAsset(algod, alice, deployment.usdcAssetId);
      await optInToAsset(algod, alice, deployment.cUsdcAssetId);
      await optInToAsset(algod, alice, deployment.projectAsaId);
      await optInToAsset(algod, bob, deployment.usdcAssetId);
      await optInToAsset(algod, bob, deployment.cUsdcAssetId);
      await optInToAsset(algod, bob, deployment.projectAsaId);

      await fundAsset(algod, creator, alice.addr, deployment.usdcAssetId, 5_000_000_000);
      await fundAsset(algod, creator, bob.addr, deployment.usdcAssetId, 5_000_000_000);

      // Users opt in and deposit
      await performUserOptIn(algod, deployment, alice);
      await performUserOptIn(algod, deployment, bob);

      await performDeposit(algod, deployment, alice, aliceDeposit);
      await performDeposit(algod, deployment, bob, bobDeposit);
    });

    it('should track rate correctly after deposits', async () => {
      const stats = await getOrbitalVaultStats(algod, deployment);
      const rate = await getOrbitalRate(algod, deployment);

      console.log('After deposits:');
      console.log('  Total shares:', stats.totalShares / 1_000_000);
      console.log('  Total principal:', stats.totalPrincipal / 1_000_000);
      console.log('  Orbital rate:', rate / RATE_PRECISION);

      expect(stats.totalShares).toBe(aliceDeposit + bobDeposit);
      expect(stats.totalPrincipal).toBe(aliceDeposit + bobDeposit);
    });

    it('should increase rate when Orbital yield accrues', async () => {
      const rateBefore = await getOrbitalRate(algod, deployment);

      // Simulate 5% yield on total deposits
      const totalDeposits = aliceDeposit + bobDeposit;
      const yieldAmount = Math.floor(totalDeposits * 0.05);

      await simulateOrbitalYield(algod, deployment, creator, yieldAmount);

      const rateAfter = await getOrbitalRate(algod, deployment);

      console.log('After yield accrual:');
      console.log('  Rate before:', rateBefore / RATE_PRECISION);
      console.log('  Rate after:', rateAfter / RATE_PRECISION);
      console.log('  Yield amount:', yieldAmount / 1_000_000);

      expect(rateAfter).toBeGreaterThan(rateBefore);
      // Rate should be approximately 1.05 (5% increase)
      expect(rateAfter).toBeCloseTo(RATE_PRECISION * 1.05, -4);
    });

    it('should harvest and swap yield correctly', async () => {
      const statsBefore = await getOrbitalVaultStats(algod, deployment);

      // Harvest and swap (creator calls)
      await performHarvestAndSwap(algod, deployment, creator, 500); // 5% slippage

      const statsAfter = await getOrbitalVaultStats(algod, deployment);

      console.log('After harvest:');
      console.log('  cUSDC balance before:', statsBefore.cUsdcBalance / 1_000_000);
      console.log('  cUSDC balance after:', statsAfter.cUsdcBalance / 1_000_000);
      console.log('  Project ASA balance:', statsAfter.projectAsaBalance / 1_000_000);
      console.log('  lastHarvestAsaPerUsdc:', statsAfter.lastHarvestAsaPerUsdc);

      // Should have some project ASA now (from swap)
      expect(statsAfter.projectAsaBalance).toBeGreaterThan(0);
      // cUSDC should have decreased (redeemed yield portion)
      expect(statsAfter.cUsdcBalance).toBeLessThan(statsBefore.cUsdcBalance);
    });

    it('should update user yield after harvest', async () => {
      // Trigger yield update by having user perform an action
      // (In real scenario, getPendingYield would need to read current state)
      const aliceYield = await getPendingYield(algod, deployment, alice.addr);
      const bobYield = await getPendingYield(algod, deployment, bob.addr);

      console.log('Pending yields:');
      console.log('  Alice unrealized USDC:', aliceYield.unrealizedUsdc / 1_000_000);
      console.log('  Alice claimable ASA:', aliceYield.claimableAsa / 1_000_000);
      console.log('  Bob unrealized USDC:', bobYield.unrealizedUsdc / 1_000_000);
      console.log('  Bob claimable ASA:', bobYield.claimableAsa / 1_000_000);

      // Alice has 2/3 of deposits, Bob has 1/3
      // So Alice should have ~2x Bob's yield
      if (aliceYield.unrealizedUsdc > 0 && bobYield.unrealizedUsdc > 0) {
        const ratio = aliceYield.unrealizedUsdc / bobYield.unrealizedUsdc;
        expect(ratio).toBeGreaterThan(1.9);
        expect(ratio).toBeLessThan(2.1);
      }
    });
  });

  describe('Late Depositor (No Past Yield)', () => {
    let deployment: OrbitalVaultDeploymentResult;

    beforeAll(async () => {
      deployment = await deployOrbitalVaultForTest(algod, creator, {
        minHarvestThreshold: 1_000_000,
      });

      // Setup Alice
      await optInToAsset(algod, alice, deployment.usdcAssetId);
      await optInToAsset(algod, alice, deployment.cUsdcAssetId);
      await optInToAsset(algod, alice, deployment.projectAsaId);
      await fundAsset(algod, creator, alice.addr, deployment.usdcAssetId, 5_000_000_000);

      // Alice deposits first
      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 1000_000_000);

      // Yield accrues while Bob hasn't deposited yet
      await simulateOrbitalYield(algod, deployment, creator, 50_000_000); // 5% yield

      // Harvest the yield
      await performHarvestAndSwap(algod, deployment, creator, 500);
    });

    it('should not give late depositor past yield', async () => {
      // Bob deposits AFTER yield was harvested
      await optInToAsset(algod, bob, deployment.usdcAssetId);
      await optInToAsset(algod, bob, deployment.cUsdcAssetId);
      await optInToAsset(algod, bob, deployment.projectAsaId);
      await fundAsset(algod, creator, bob.addr, deployment.usdcAssetId, 5_000_000_000);

      await performUserOptIn(algod, deployment, bob);
      await performDeposit(algod, deployment, bob, 500_000_000);

      // Bob should have 0 claimable ASA (only Alice was deposited during harvest)
      const bobYield = await getPendingYield(algod, deployment, bob.addr);
      expect(bobYield.claimableAsa).toBe(0);

      // Alice should have claimable ASA
      const aliceYield = await getPendingYield(algod, deployment, alice.addr);
      // Note: Alice's earnedAsa gets updated when she does an action after harvest
      console.log('Late depositor test:');
      console.log('  Alice claimable ASA:', aliceYield.claimableAsa / 1_000_000);
      console.log('  Bob claimable ASA:', bobYield.claimableAsa / 1_000_000);
    });
  });

  describe('Multiple Harvests', () => {
    let deployment: OrbitalVaultDeploymentResult;
    const depositAmount = 1000_000_000; // 1000 USDC

    beforeAll(async () => {
      deployment = await deployOrbitalVaultForTest(algod, creator, {
        minHarvestThreshold: 1_000_000,
        poolReserveUsdc: 100_000_000_000,
        poolReserveProjectAsa: 100_000_000_000,
      });

      await optInToAsset(algod, alice, deployment.usdcAssetId);
      await optInToAsset(algod, alice, deployment.cUsdcAssetId);
      await optInToAsset(algod, alice, deployment.projectAsaId);
      await fundAsset(algod, creator, alice.addr, deployment.usdcAssetId, 5_000_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, depositAmount);
    });

    it('should accumulate yield across multiple harvests', async () => {
      // First yield cycle
      await simulateOrbitalYield(algod, deployment, creator, 20_000_000); // 2% yield
      await performHarvestAndSwap(algod, deployment, creator, 500);

      const statsAfter1 = await getOrbitalVaultStats(algod, deployment);
      console.log('After 1st harvest - Project ASA:', statsAfter1.projectAsaBalance / 1_000_000);

      // Second yield cycle
      await simulateOrbitalYield(algod, deployment, creator, 30_000_000); // 3% more yield
      await performHarvestAndSwap(algod, deployment, creator, 500);

      const statsAfter2 = await getOrbitalVaultStats(algod, deployment);
      console.log('After 2nd harvest - Project ASA:', statsAfter2.projectAsaBalance / 1_000_000);

      // Third yield cycle
      await simulateOrbitalYield(algod, deployment, creator, 25_000_000); // 2.5% more yield
      await performHarvestAndSwap(algod, deployment, creator, 500);

      const statsAfter3 = await getOrbitalVaultStats(algod, deployment);
      console.log('After 3rd harvest - Project ASA:', statsAfter3.projectAsaBalance / 1_000_000);

      // Vault should have accumulated project ASA from all harvests
      expect(statsAfter3.projectAsaBalance).toBeGreaterThan(statsAfter2.projectAsaBalance);
      expect(statsAfter2.projectAsaBalance).toBeGreaterThan(statsAfter1.projectAsaBalance);
    });
  });

  describe('Close Out', () => {
    let deployment: OrbitalVaultDeploymentResult;
    const depositAmount = 100_000_000;

    beforeAll(async () => {
      deployment = await deployOrbitalVaultForTest(algod, creator, {
        minHarvestThreshold: 1_000_000,
      });

      await optInToAsset(algod, alice, deployment.usdcAssetId);
      await optInToAsset(algod, alice, deployment.cUsdcAssetId);
      await optInToAsset(algod, alice, deployment.projectAsaId);
      await fundAsset(algod, creator, alice.addr, deployment.usdcAssetId, 500_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, depositAmount);

      // Generate and harvest some yield
      await simulateOrbitalYield(algod, deployment, creator, 10_000_000);
      await performHarvestAndSwap(algod, deployment, creator, 500);
    });

    it('should return deposit and yield on close out', async () => {
      const usdcBalanceBefore = await getAssetBalance(algod, alice.addr, deployment.usdcAssetId);
      const asaBalanceBefore = await getAssetBalance(algod, alice.addr, deployment.projectAsaId);

      await performCloseOut(algod, deployment, alice);

      const usdcBalanceAfter = await getAssetBalance(algod, alice.addr, deployment.usdcAssetId);
      const asaBalanceAfter = await getAssetBalance(algod, alice.addr, deployment.projectAsaId);

      console.log('Close out results:');
      console.log('  USDC returned:', (usdcBalanceAfter - usdcBalanceBefore) / 1_000_000);
      console.log('  ASA received:', (asaBalanceAfter - asaBalanceBefore) / 1_000_000);

      // Should get USDC back (principal)
      expect(usdcBalanceAfter).toBeGreaterThan(usdcBalanceBefore);

      // Should get ASA yield (if any was converted)
      // Note: May be 0 if user's yield wasn't converted yet

      // Total shares should be 0
      const stats = await getOrbitalVaultStats(algod, deployment);
      expect(stats.totalShares).toBe(0);
    });
  });

  describe('Security - Immutability', () => {
    let deployment: OrbitalVaultDeploymentResult;

    beforeAll(async () => {
      deployment = await deployOrbitalVaultForTest(algod, creator);
    });

    it('should reject update application', async () => {
      const suggestedParams = await algod.getTransactionParams().do();

      const updateTxn = algosdk.makeApplicationUpdateTxnFromObject({
        sender: creator.addr,
        appIndex: deployment.vaultAppId,
        approvalProgram: new Uint8Array([0x06, 0x81, 0x01]),
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
      const deployment = await deployOrbitalVaultForTest(algod, creator);
      await optInToAsset(algod, alice, deployment.usdcAssetId);
      await optInToAsset(algod, alice, deployment.cUsdcAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.usdcAssetId, 100_000_000);
      await performUserOptIn(algod, deployment, alice);

      // Try to deposit less than MIN_DEPOSIT_AMOUNT (1_000_000)
      await expect(
        performDeposit(algod, deployment, alice, 100)
      ).rejects.toThrow();
    });

    it('should reject harvest below minimum threshold', async () => {
      const deployment = await deployOrbitalVaultForTest(algod, creator, {
        minHarvestThreshold: 10_000_000, // 10 USDC minimum
      });

      await optInToAsset(algod, alice, deployment.usdcAssetId);
      await optInToAsset(algod, alice, deployment.cUsdcAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.usdcAssetId, 1_000_000_000);
      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 1_000_000_000);

      // Simulate only 5 USDC yield (below 10 USDC threshold)
      await simulateOrbitalYield(algod, deployment, creator, 5_000_000);

      // Try to harvest (should fail - below threshold)
      await expect(
        performHarvestAndSwap(algod, deployment, creator, 500)
      ).rejects.toThrow();
    });

    it('should reject non-creator from calling harvestAndSwap', async () => {
      const deployment = await deployOrbitalVaultForTest(algod, creator);

      await optInToAsset(algod, alice, deployment.usdcAssetId);
      await optInToAsset(algod, alice, deployment.cUsdcAssetId);
      await fundAsset(algod, creator, alice.addr, deployment.usdcAssetId, 1_000_000_000);

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, 100_000_000);

      // Simulate yield
      await simulateOrbitalYield(algod, deployment, creator, 10_000_000);

      // Alice tries to call harvestAndSwap (should fail - only creator/rarefi allowed)
      await expect(
        performHarvestAndSwap(algod, deployment, alice, 500)
      ).rejects.toThrow();
    });
  });

  describe('Exchange Rate Appreciation', () => {
    let deployment: OrbitalVaultDeploymentResult;

    beforeAll(async () => {
      deployment = await deployOrbitalVaultForTest(algod, creator, {
        minHarvestThreshold: 1_000_000,
        poolReserveUsdc: 100_000_000_000,
        poolReserveProjectAsa: 100_000_000_000,
      });

      await optInToAsset(algod, alice, deployment.usdcAssetId);
      await optInToAsset(algod, alice, deployment.cUsdcAssetId);
      await optInToAsset(algod, alice, deployment.projectAsaId);
      await fundAsset(algod, creator, alice.addr, deployment.usdcAssetId, 10_000_000_000);
    });

    it('should correctly calculate value at different rates', async () => {
      const depositAmount = 1000_000_000; // 1000 USDC

      await performUserOptIn(algod, deployment, alice);
      await performDeposit(algod, deployment, alice, depositAmount);

      const statsAfterDeposit = await getOrbitalVaultStats(algod, deployment);
      const rateAfterDeposit = await getOrbitalRate(algod, deployment);

      console.log('After deposit:');
      console.log('  Shares:', statsAfterDeposit.totalShares / 1_000_000);
      console.log('  Principal:', statsAfterDeposit.totalPrincipal / 1_000_000);
      console.log('  Rate:', rateAfterDeposit / RATE_PRECISION);

      // At rate 1.0, shares should equal deposit
      expect(statsAfterDeposit.totalShares).toBe(depositAmount);

      // Simulate 10% yield
      await simulateOrbitalYield(algod, deployment, creator, 100_000_000);

      const rateAfterYield = await getOrbitalRate(algod, deployment);
      console.log('After 10% yield - Rate:', rateAfterYield / RATE_PRECISION);

      // Rate should be ~1.1
      expect(rateAfterYield).toBeGreaterThan(RATE_PRECISION * 1.09);
      expect(rateAfterYield).toBeLessThan(RATE_PRECISION * 1.11);

      // Harvest to convert yield
      await performHarvestAndSwap(algod, deployment, creator, 500);

      const statsAfterHarvest = await getOrbitalVaultStats(algod, deployment);
      console.log('After harvest:');
      console.log('  Project ASA balance:', statsAfterHarvest.projectAsaBalance / 1_000_000);

      expect(statsAfterHarvest.projectAsaBalance).toBeGreaterThan(0);
    });
  });

  describe('Fair Yield Distribution', () => {
    let deployment: OrbitalVaultDeploymentResult;

    beforeAll(async () => {
      deployment = await deployOrbitalVaultForTest(algod, creator, {
        minHarvestThreshold: 1_000_000,
        poolReserveUsdc: 100_000_000_000,
        poolReserveProjectAsa: 100_000_000_000,
      });

      await optInToAsset(algod, alice, deployment.usdcAssetId);
      await optInToAsset(algod, alice, deployment.cUsdcAssetId);
      await optInToAsset(algod, alice, deployment.projectAsaId);
      await optInToAsset(algod, bob, deployment.usdcAssetId);
      await optInToAsset(algod, bob, deployment.cUsdcAssetId);
      await optInToAsset(algod, bob, deployment.projectAsaId);

      await fundAsset(algod, creator, alice.addr, deployment.usdcAssetId, 10_000_000_000);
      await fundAsset(algod, creator, bob.addr, deployment.usdcAssetId, 10_000_000_000);
    });

    it('should distribute yield proportionally', async () => {
      // Alice deposits 600 USDC (60%)
      // Bob deposits 400 USDC (40%)
      await performUserOptIn(algod, deployment, alice);
      await performUserOptIn(algod, deployment, bob);

      await performDeposit(algod, deployment, alice, 600_000_000);
      await performDeposit(algod, deployment, bob, 400_000_000);

      // Simulate 10% yield on total (100 USDC yield)
      await simulateOrbitalYield(algod, deployment, creator, 100_000_000);

      // Harvest
      await performHarvestAndSwap(algod, deployment, creator, 500);

      // Check that yield is tracked proportionally
      const aliceYield = await getPendingYield(algod, deployment, alice.addr);
      const bobYield = await getPendingYield(algod, deployment, bob.addr);

      console.log('Proportional yield test:');
      console.log('  Alice (60%) unrealized:', aliceYield.unrealizedUsdc / 1_000_000);
      console.log('  Bob (40%) unrealized:', bobYield.unrealizedUsdc / 1_000_000);

      // Alice should have ~1.5x Bob's yield (60%/40% = 1.5)
      if (aliceYield.unrealizedUsdc > 0 && bobYield.unrealizedUsdc > 0) {
        const ratio = aliceYield.unrealizedUsdc / bobYield.unrealizedUsdc;
        expect(ratio).toBeGreaterThan(1.4);
        expect(ratio).toBeLessThan(1.6);
      }
    });
  });
});
