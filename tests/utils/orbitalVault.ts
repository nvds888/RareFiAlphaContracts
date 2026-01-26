import algosdk from 'algosdk';
import fs from 'fs';
import path from 'path';
import { createTestAsset } from './assets';

export const TOKEN_SUPPLY = 100_000_000_000_000; // 100M tokens with 6 decimals
export const TOKEN_DECIMALS = 6;
export const RATE_PRECISION = 1_000_000; // 1e6 for exchange rate

function safeToNumber(value: any): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return parseInt(value) || 0;
}

// Helper to encode uint64 as 8-byte big-endian
function encodeUint64(n: number): Uint8Array {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(n));
  return new Uint8Array(buf);
}

async function compileOrbitalVaultContract(algodClient: algosdk.Algodv2) {
  const artifactsDir = path.resolve(__dirname, '../../contracts/artifacts');

  const approvalPath = path.join(artifactsDir, 'OrbitalVault.approval.teal');
  const clearPath = path.join(artifactsDir, 'OrbitalVault.clear.teal');
  const arc56Path = path.join(artifactsDir, 'OrbitalVault.arc56.json');

  if (!fs.existsSync(approvalPath)) {
    throw new Error(`Approval program not found: ${approvalPath}. Run compile for OrbitalVault first.`);
  }

  const approvalTeal = fs.readFileSync(approvalPath, 'utf8');
  const clearTeal = fs.readFileSync(clearPath, 'utf8');
  const arc56Spec = JSON.parse(fs.readFileSync(arc56Path, 'utf8'));

  const approvalResponse = await algodClient.compile(approvalTeal).do();
  const clearResponse = await algodClient.compile(clearTeal).do();

  return {
    approvalProgram: new Uint8Array(Buffer.from(approvalResponse.result, 'base64')),
    clearProgram: new Uint8Array(Buffer.from(clearResponse.result, 'base64')),
    arc56Spec,
  };
}

async function compileMockOrbitalContract(algodClient: algosdk.Algodv2) {
  const artifactsDir = path.resolve(__dirname, '../../contracts/artifacts');

  const approvalPath = path.join(artifactsDir, 'MockOrbital.approval.teal');
  const clearPath = path.join(artifactsDir, 'MockOrbital.clear.teal');
  const arc56Path = path.join(artifactsDir, 'MockOrbital.arc56.json');

  if (!fs.existsSync(approvalPath)) {
    throw new Error(`MockOrbital approval program not found: ${approvalPath}. Run compile first.`);
  }

  const approvalTeal = fs.readFileSync(approvalPath, 'utf8');
  const clearTeal = fs.readFileSync(clearPath, 'utf8');
  const arc56Spec = JSON.parse(fs.readFileSync(arc56Path, 'utf8'));

  const approvalResponse = await algodClient.compile(approvalTeal).do();
  const clearResponse = await algodClient.compile(clearTeal).do();

  return {
    approvalProgram: new Uint8Array(Buffer.from(approvalResponse.result, 'base64')),
    clearProgram: new Uint8Array(Buffer.from(clearResponse.result, 'base64')),
    arc56Spec,
  };
}

async function compilePoolContract(algodClient: algosdk.Algodv2) {
  const artifactsDir = path.resolve(__dirname, '../../contracts/artifacts');

  const approvalPath = path.join(artifactsDir, 'MockTinymanPool.approval.teal');
  const clearPath = path.join(artifactsDir, 'MockTinymanPool.clear.teal');
  const arc56Path = path.join(artifactsDir, 'MockTinymanPool.arc56.json');

  if (!fs.existsSync(approvalPath)) {
    throw new Error(`Pool approval program not found: ${approvalPath}. Run compile first.`);
  }

  const approvalTeal = fs.readFileSync(approvalPath, 'utf8');
  const clearTeal = fs.readFileSync(clearPath, 'utf8');
  const arc56Spec = JSON.parse(fs.readFileSync(arc56Path, 'utf8'));

  const approvalResponse = await algodClient.compile(approvalTeal).do();
  const clearResponse = await algodClient.compile(clearTeal).do();

  return {
    approvalProgram: new Uint8Array(Buffer.from(approvalResponse.result, 'base64')),
    clearProgram: new Uint8Array(Buffer.from(clearResponse.result, 'base64')),
    arc56Spec,
  };
}

export interface OrbitalVaultDeploymentResult {
  vaultAppId: number;
  vaultAddress: string;
  orbitalAppId: number;          // MockOrbital app ID
  orbitalAddress: string;        // MockOrbital address
  poolAppId: number;             // MockTinymanPool app ID
  poolAddress: string;           // MockTinymanPool address
  usdcAssetId: number;           // USDC asset ID
  cUsdcAssetId: number;          // cUSDC (LST receipt token) asset ID
  projectAsaId: number;          // Project ASA (yield paid in this)
  arc56Spec: any;
  orbitalArc56Spec: any;
  poolArc56Spec: any;
}

export async function deployOrbitalVaultForTest(
  algod: algosdk.Algodv2,
  creator: { addr: string | algosdk.Address; sk: Uint8Array },
  overrides?: {
    depositFeeBps?: number;
    withdrawFeeBps?: number;
    minHarvestThreshold?: number;
    usdcSupply?: number;
    cUsdcSupply?: number;
    projectAsaSupply?: number;
    poolFeeBps?: number;
    poolReserveUsdc?: number;
    poolReserveProjectAsa?: number;
    initialOrbitalRate?: number;  // Initial exchange rate (1e6 = 1.0)
  },
): Promise<OrbitalVaultDeploymentResult> {
  const creatorAddr = typeof creator.addr === 'string' ? creator.addr : creator.addr.toString();
  const creatorAccount = { addr: creatorAddr, sk: creator.sk };

  // Create test assets
  const usdcAssetId = await createTestAsset(
    algod,
    creatorAccount,
    'USDC-Test',
    'USDCt',
    overrides?.usdcSupply ?? TOKEN_SUPPLY,
  );

  const cUsdcAssetId = await createTestAsset(
    algod,
    creatorAccount,
    'cUSDC-Test',
    'cUSDCt',
    overrides?.cUsdcSupply ?? TOKEN_SUPPLY,
  );

  const projectAsaId = await createTestAsset(
    algod,
    creatorAccount,
    'ProjectASA-Test',
    'PROJt',
    overrides?.projectAsaSupply ?? TOKEN_SUPPLY,
  );

  // Parameters
  const depositFeeBps = overrides?.depositFeeBps ?? 0;
  const withdrawFeeBps = overrides?.withdrawFeeBps ?? 0;
  const minHarvestThreshold = overrides?.minHarvestThreshold ?? 1_000_000; // 1 USDC
  const poolFeeBps = overrides?.poolFeeBps ?? 30; // 0.3%
  const poolReserveUsdc = overrides?.poolReserveUsdc ?? 10_000_000_000; // 10,000 USDC
  const poolReserveProjectAsa = overrides?.poolReserveProjectAsa ?? 10_000_000_000; // 10,000 ASA

  // ========================================
  // Step 1: Deploy MockOrbital
  // ========================================
  const orbitalCompiled = await compileMockOrbitalContract(algod);

  let suggestedParams = await algod.getTransactionParams().do();

  // Create MockOrbital with initialization args
  const createOrbitalSelector = new Uint8Array([0x00, 0x00, 0x00, 0x00]); // Dummy 4-byte selector
  const createOrbitalTxn = algosdk.makeApplicationCreateTxnFromObject({
    sender: creatorAddr,
    approvalProgram: orbitalCompiled.approvalProgram,
    clearProgram: orbitalCompiled.clearProgram,
    numGlobalByteSlices: 1, // creator
    numGlobalInts: 4,       // usdcAssetId, cUsdcAssetId, total_deposits, circulating_lst
    numLocalByteSlices: 0,
    numLocalInts: 0,
    extraPages: 0,
    suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
    appArgs: [
      createOrbitalSelector,
      encodeUint64(usdcAssetId),
      encodeUint64(cUsdcAssetId),
    ],
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
  });

  const signedCreateOrbitalTxn = createOrbitalTxn.signTxn(creator.sk);
  const createOrbitalTxID = await algod.sendRawTransaction(signedCreateOrbitalTxn).do();
  const orbitalConfirmedTxn = await algosdk.waitForConfirmation(algod, createOrbitalTxID.txid, 5);
  const orbitalAppId = safeToNumber(orbitalConfirmedTxn.applicationIndex);
  const orbitalAddress = algosdk.getApplicationAddress(orbitalAppId).toString();

  // Fund MockOrbital for MBR
  suggestedParams = await algod.getTransactionParams().do();
  const fundOrbitalTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: creatorAddr,
    receiver: orbitalAddress,
    amount: 500_000, // 0.5 ALGO
    suggestedParams,
  });
  const signedFundOrbitalTxn = fundOrbitalTxn.signTxn(creator.sk);
  const fundOrbitalTxID = await algod.sendRawTransaction(signedFundOrbitalTxn).do();
  await algosdk.waitForConfirmation(algod, fundOrbitalTxID.txid, 5);

  // MockOrbital opts into assets
  suggestedParams = await algod.getTransactionParams().do();
  const orbitalOptInTxn = algosdk.makeApplicationCallTxnFromObject({
    sender: creatorAddr,
    appIndex: orbitalAppId,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    appArgs: [new TextEncoder().encode('optInAssets')],
    foreignAssets: [usdcAssetId, cUsdcAssetId],
    suggestedParams: { ...suggestedParams, fee: 3000, flatFee: true },
  });
  const signedOrbitalOptInTxn = orbitalOptInTxn.signTxn(creator.sk);
  const orbitalOptInTxID = await algod.sendRawTransaction(signedOrbitalOptInTxn).do();
  await algosdk.waitForConfirmation(algod, orbitalOptInTxID.txid, 5);

  // Fund MockOrbital with cUSDC (so it can mint cUSDC to depositors)
  suggestedParams = await algod.getTransactionParams().do();
  const fundOrbitalCusdcTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: creatorAddr,
    receiver: orbitalAddress,
    amount: TOKEN_SUPPLY / 2, // Half the supply
    assetIndex: cUsdcAssetId,
    suggestedParams,
  });
  const signedFundOrbitalCusdcTxn = fundOrbitalCusdcTxn.signTxn(creator.sk);
  const fundOrbitalCusdcTxID = await algod.sendRawTransaction(signedFundOrbitalCusdcTxn).do();
  await algosdk.waitForConfirmation(algod, fundOrbitalCusdcTxID.txid, 5);

  // ========================================
  // Step 2: Deploy MockTinymanPool (USDC/ProjectASA)
  // ========================================
  const poolCompiled = await compilePoolContract(algod);

  suggestedParams = await algod.getTransactionParams().do();
  const createPoolSelector = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
  const createPoolTxn = algosdk.makeApplicationCreateTxnFromObject({
    sender: creatorAddr,
    approvalProgram: poolCompiled.approvalProgram,
    clearProgram: poolCompiled.clearProgram,
    numGlobalByteSlices: 1, // stateHolder
    numGlobalInts: 3, // asset1Id, asset2Id, initialized
    numLocalByteSlices: 0,
    numLocalInts: 4, // asset_1_id, asset_1_reserves, asset_2_reserves, total_fee_share
    extraPages: 0,
    suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
    appArgs: [
      createPoolSelector,
      encodeUint64(usdcAssetId),
      encodeUint64(projectAsaId),
      encodeUint64(poolReserveUsdc),
      encodeUint64(poolReserveProjectAsa),
      encodeUint64(poolFeeBps),
    ],
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
  });

  const signedCreatePoolTxn = createPoolTxn.signTxn(creator.sk);
  const createPoolTxID = await algod.sendRawTransaction(signedCreatePoolTxn).do();
  const poolConfirmedTxn = await algosdk.waitForConfirmation(algod, createPoolTxID.txid, 5);
  const poolAppId = safeToNumber(poolConfirmedTxn.applicationIndex);
  const poolAddress = algosdk.getApplicationAddress(poolAppId).toString();

  // Fund pool for MBR
  suggestedParams = await algod.getTransactionParams().do();
  const fundPoolTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: creatorAddr,
    receiver: poolAddress,
    amount: 500_000,
    suggestedParams,
  });
  const signedFundPoolTxn = fundPoolTxn.signTxn(creator.sk);
  const fundPoolTxID = await algod.sendRawTransaction(signedFundPoolTxn).do();
  await algosdk.waitForConfirmation(algod, fundPoolTxID.txid, 5);

  // Pool opts into assets
  suggestedParams = await algod.getTransactionParams().do();
  const poolOptInTxn = algosdk.makeApplicationCallTxnFromObject({
    sender: creatorAddr,
    appIndex: poolAppId,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    appArgs: [new TextEncoder().encode('optInAssets')],
    foreignAssets: [usdcAssetId, projectAsaId],
    suggestedParams: { ...suggestedParams, fee: 3000, flatFee: true },
  });
  const signedPoolOptInTxn = poolOptInTxn.signTxn(creator.sk);
  const poolOptInTxID = await algod.sendRawTransaction(signedPoolOptInTxn).do();
  await algosdk.waitForConfirmation(algod, poolOptInTxID.txid, 5);

  // Creator opts into pool app (to become state holder for local state)
  suggestedParams = await algod.getTransactionParams().do();
  const creatorOptInPoolTxn = algosdk.makeApplicationOptInTxnFromObject({
    sender: creatorAddr,
    appIndex: poolAppId,
    suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
  });
  const signedCreatorOptInPoolTxn = creatorOptInPoolTxn.signTxn(creator.sk);
  const creatorOptInPoolTxID = await algod.sendRawTransaction(signedCreatorOptInPoolTxn).do();
  await algosdk.waitForConfirmation(algod, creatorOptInPoolTxID.txid, 5);

  // Initialize pool local state (creator is the state holder)
  suggestedParams = await algod.getTransactionParams().do();
  const initPoolTxn = algosdk.makeApplicationCallTxnFromObject({
    sender: creatorAddr,
    appIndex: poolAppId,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    appArgs: [
      new TextEncoder().encode('initializePool'),
      encodeUint64(poolReserveUsdc),
      encodeUint64(poolReserveProjectAsa),
      encodeUint64(poolFeeBps),
    ],
    suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
  });
  const signedInitPoolTxn = initPoolTxn.signTxn(creator.sk);
  const initPoolTxID = await algod.sendRawTransaction(signedInitPoolTxn).do();
  await algosdk.waitForConfirmation(algod, initPoolTxID.txid, 5);

  // IMPORTANT: The state holder address is the creator's address
  const poolStateHolderAddress = creatorAddr;

  // Fund pool with project ASA liquidity
  suggestedParams = await algod.getTransactionParams().do();
  const fundPoolAsaTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: creatorAddr,
    receiver: poolAddress,
    amount: poolReserveProjectAsa,
    assetIndex: projectAsaId,
    suggestedParams,
  });
  const signedFundPoolAsaTxn = fundPoolAsaTxn.signTxn(creator.sk);
  const fundPoolAsaTxID = await algod.sendRawTransaction(signedFundPoolAsaTxn).do();
  await algosdk.waitForConfirmation(algod, fundPoolAsaTxID.txid, 5);

  // ========================================
  // Step 3: Deploy OrbitalVault
  // ========================================
  const vaultCompiled = await compileOrbitalVaultContract(algod);
  const vaultContract = new algosdk.ABIContract(vaultCompiled.arc56Spec);

  suggestedParams = await algod.getTransactionParams().do();
  const createVaultMethod = vaultContract.getMethodByName('createVault');

  const vaultAtc = new algosdk.AtomicTransactionComposer();
  vaultAtc.addMethodCall({
    appID: 0,
    method: createVaultMethod,
    methodArgs: [
      usdcAssetId,
      cUsdcAssetId,
      projectAsaId,
      orbitalAppId,
      poolAppId,
      poolStateHolderAddress, // Use state holder address (where pool state is in local state)
      depositFeeBps,
      withdrawFeeBps,
      minHarvestThreshold,
      creatorAddr, // rarefiAddress = creator for testing
    ],
    sender: creatorAddr,
    signer: algosdk.makeBasicAccountTransactionSigner({ sk: creator.sk, addr: algosdk.decodeAddress(creatorAddr) }),
    suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
    approvalProgram: vaultCompiled.approvalProgram,
    clearProgram: vaultCompiled.clearProgram,
    numGlobalByteSlices: 4,  // creator, rarefiAddress, tinymanPoolAddress, isPaused (bool stored as bytes)
    numGlobalInts: 16,       // all uint64 fields
    numLocalByteSlices: 0,
    numLocalInts: 5,         // userShares, userUsdcYieldPerShare, userAsaYieldPerShare, userUnrealizedUsdc, earnedAsa
    extraPages: 1,
  });

  const vaultResult = await vaultAtc.execute(algod, 5);
  const vaultTxid = vaultResult.txIDs[0];
  const vaultConfirmedTxn = await algod.pendingTransactionInformation(vaultTxid).do();
  const vaultAppId = safeToNumber(vaultConfirmedTxn.applicationIndex);
  const vaultAddress = algosdk.getApplicationAddress(vaultAppId).toString();

  // Fund vault for MBR
  suggestedParams = await algod.getTransactionParams().do();
  const fundVaultTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: creatorAddr,
    receiver: vaultAddress,
    amount: 500_000,
    suggestedParams,
  });
  const signedFundVaultTxn = fundVaultTxn.signTxn(creator.sk);
  const fundVaultTxID = await algod.sendRawTransaction(signedFundVaultTxn).do();
  await algosdk.waitForConfirmation(algod, fundVaultTxID.txid, 5);

  // Vault opts into assets
  const paymentTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: creatorAddr,
    receiver: vaultAddress,
    amount: 200_300_000, // 200 ALGO setup fee + 0.3 ALGO for 3 asset MBR
    suggestedParams: { ...(await algod.getTransactionParams().do()), fee: 1000, flatFee: true },
  });

  const vaultOptInAtc = new algosdk.AtomicTransactionComposer();
  vaultOptInAtc.addTransaction({
    txn: paymentTxn,
    signer: algosdk.makeBasicAccountTransactionSigner({ sk: creator.sk, addr: algosdk.decodeAddress(creatorAddr) }),
  });

  vaultOptInAtc.addMethodCall({
    appID: vaultAppId,
    method: vaultContract.getMethodByName('optInAssets'),
    methodArgs: [],
    sender: creatorAddr,
    signer: algosdk.makeBasicAccountTransactionSigner({ sk: creator.sk, addr: algosdk.decodeAddress(creatorAddr) }),
    suggestedParams: { ...(await algod.getTransactionParams().do()), fee: 5000, flatFee: true },
    appForeignAssets: [usdcAssetId, cUsdcAssetId, projectAsaId],
    appForeignApps: [orbitalAppId],
  });

  await vaultOptInAtc.execute(algod, 5);

  return {
    vaultAppId,
    vaultAddress,
    orbitalAppId,
    orbitalAddress,
    poolAppId,
    poolAddress: poolStateHolderAddress, // Return state holder address as poolAddress for tests
    usdcAssetId,
    cUsdcAssetId,
    projectAsaId,
    arc56Spec: vaultCompiled.arc56Spec,
    orbitalArc56Spec: orbitalCompiled.arc56Spec,
    poolArc56Spec: poolCompiled.arc56Spec,
  };
}

export async function performUserOptIn(
  algod: algosdk.Algodv2,
  deployment: OrbitalVaultDeploymentResult,
  user: { addr: string | algosdk.Address; sk: Uint8Array },
) {
  const contract = new algosdk.ABIContract(deployment.arc56Spec);
  const suggestedParams = await algod.getTransactionParams().do();
  const userAddr = typeof user.addr === 'string' ? user.addr : user.addr.toString();
  const signer = algosdk.makeBasicAccountTransactionSigner({
    sk: user.sk,
    addr: algosdk.decodeAddress(userAddr),
  });

  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: deployment.vaultAppId,
    method: contract.getMethodByName('optIn'),
    methodArgs: [],
    sender: userAddr,
    signer,
    suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
    onComplete: algosdk.OnApplicationComplete.OptInOC,
  });

  await atc.execute(algod, 5);
}

export async function performDeposit(
  algod: algosdk.Algodv2,
  deployment: OrbitalVaultDeploymentResult,
  user: { addr: string | algosdk.Address; sk: Uint8Array },
  amount: number,
) {
  const contract = new algosdk.ABIContract(deployment.arc56Spec);
  const suggestedParams = await algod.getTransactionParams().do();
  const userAddr = typeof user.addr === 'string' ? user.addr : user.addr.toString();
  const signer = algosdk.makeBasicAccountTransactionSigner({
    sk: user.sk,
    addr: algosdk.decodeAddress(userAddr),
  });

  const atc = new algosdk.AtomicTransactionComposer();

  // USDC transfer first
  const usdcTransfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: userAddr,
    receiver: deployment.vaultAddress,
    amount: amount,
    assetIndex: deployment.usdcAssetId,
    suggestedParams,
  });
  atc.addTransaction({ txn: usdcTransfer, signer });

  // Then deposit call
  atc.addMethodCall({
    appID: deployment.vaultAppId,
    method: contract.getMethodByName('deposit'),
    methodArgs: [],
    sender: userAddr,
    signer,
    suggestedParams: { ...suggestedParams, fee: 5000, flatFee: true }, // Higher fee for inner txns to Orbital
    appForeignAssets: [deployment.usdcAssetId, deployment.cUsdcAssetId],
    appForeignApps: [deployment.orbitalAppId],
  });

  await atc.execute(algod, 5);
}

export async function performWithdraw(
  algod: algosdk.Algodv2,
  deployment: OrbitalVaultDeploymentResult,
  user: { addr: string | algosdk.Address; sk: Uint8Array },
  amount: number, // 0 = withdraw all
) {
  const contract = new algosdk.ABIContract(deployment.arc56Spec);
  const suggestedParams = await algod.getTransactionParams().do();
  const userAddr = typeof user.addr === 'string' ? user.addr : user.addr.toString();
  const signer = algosdk.makeBasicAccountTransactionSigner({
    sk: user.sk,
    addr: algosdk.decodeAddress(userAddr),
  });

  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: deployment.vaultAppId,
    method: contract.getMethodByName('withdraw'),
    methodArgs: [amount],
    sender: userAddr,
    signer,
    suggestedParams: { ...suggestedParams, fee: 5000, flatFee: true },
    appForeignAssets: [deployment.usdcAssetId, deployment.cUsdcAssetId],
    appForeignApps: [deployment.orbitalAppId],
  });

  await atc.execute(algod, 5);
}

export async function performClaimYield(
  algod: algosdk.Algodv2,
  deployment: OrbitalVaultDeploymentResult,
  user: { addr: string | algosdk.Address; sk: Uint8Array },
) {
  const contract = new algosdk.ABIContract(deployment.arc56Spec);
  const suggestedParams = await algod.getTransactionParams().do();
  const userAddr = typeof user.addr === 'string' ? user.addr : user.addr.toString();
  const signer = algosdk.makeBasicAccountTransactionSigner({
    sk: user.sk,
    addr: algosdk.decodeAddress(userAddr),
  });

  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: deployment.vaultAppId,
    method: contract.getMethodByName('claimYield'),
    methodArgs: [],
    sender: userAddr,
    signer,
    suggestedParams: { ...suggestedParams, fee: 2000, flatFee: true },
    appForeignAssets: [deployment.projectAsaId],
  });

  await atc.execute(algod, 5);
}

export async function performHarvestAndSwap(
  algod: algosdk.Algodv2,
  deployment: OrbitalVaultDeploymentResult,
  sender: { addr: string | algosdk.Address; sk: Uint8Array },
  slippageBps: number = 100, // 1% default slippage
) {
  const contract = new algosdk.ABIContract(deployment.arc56Spec);
  const senderAddr = typeof sender.addr === 'string' ? sender.addr : sender.addr.toString();
  const signer = algosdk.makeBasicAccountTransactionSigner({
    sk: sender.sk,
    addr: algosdk.decodeAddress(senderAddr),
  });

  const suggestedParams = await algod.getTransactionParams().do();
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: deployment.vaultAppId,
    method: contract.getMethodByName('harvestAndSwap'),
    methodArgs: [slippageBps],
    sender: senderAddr,
    signer,
    suggestedParams: { ...suggestedParams, fee: 8000, flatFee: true }, // Higher fee for multiple inner txns
    appForeignAssets: [deployment.usdcAssetId, deployment.cUsdcAssetId, deployment.projectAsaId],
    appForeignApps: [deployment.orbitalAppId, deployment.poolAppId],
    appAccounts: [deployment.poolAddress],
  });

  await atc.execute(algod, 5);
}

export async function performCloseOut(
  algod: algosdk.Algodv2,
  deployment: OrbitalVaultDeploymentResult,
  user: { addr: string | algosdk.Address; sk: Uint8Array },
) {
  const contract = new algosdk.ABIContract(deployment.arc56Spec);
  const suggestedParams = await algod.getTransactionParams().do();
  const userAddr = typeof user.addr === 'string' ? user.addr : user.addr.toString();
  const signer = algosdk.makeBasicAccountTransactionSigner({
    sk: user.sk,
    addr: algosdk.decodeAddress(userAddr),
  });

  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: deployment.vaultAppId,
    method: contract.getMethodByName('closeOut'),
    methodArgs: [],
    sender: userAddr,
    signer,
    suggestedParams: { ...suggestedParams, fee: 6000, flatFee: true },
    appForeignAssets: [deployment.usdcAssetId, deployment.cUsdcAssetId, deployment.projectAsaId],
    appForeignApps: [deployment.orbitalAppId],
    onComplete: algosdk.OnApplicationComplete.CloseOutOC,
  });

  await atc.execute(algod, 5);
}

/**
 * Simulate yield accrual in MockOrbital by adding USDC to total_deposits
 * This increases the exchange rate, simulating lending yield
 */
export async function simulateOrbitalYield(
  algod: algosdk.Algodv2,
  deployment: OrbitalVaultDeploymentResult,
  sender: { addr: string | algosdk.Address; sk: Uint8Array },
  yieldAmount: number,
) {
  const senderAddr = typeof sender.addr === 'string' ? sender.addr : sender.addr.toString();
  const signer = algosdk.makeBasicAccountTransactionSigner({
    sk: sender.sk,
    addr: algosdk.decodeAddress(senderAddr),
  });

  // Send USDC to Orbital (representing yield earned from lending)
  let suggestedParams = await algod.getTransactionParams().do();
  const usdcTransfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: senderAddr,
    receiver: deployment.orbitalAddress,
    amount: yieldAmount,
    assetIndex: deployment.usdcAssetId,
    suggestedParams,
  });

  // Call accrueInterest to update total_deposits
  const accrueInterestTxn = algosdk.makeApplicationCallTxnFromObject({
    sender: senderAddr,
    appIndex: deployment.orbitalAppId,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    appArgs: [
      new TextEncoder().encode('accrueInterest'),
      encodeUint64(yieldAmount),
    ],
    foreignAssets: [deployment.usdcAssetId],
    suggestedParams: { ...suggestedParams, fee: 2000, flatFee: true },
  });

  // Submit as atomic group
  const group = algosdk.assignGroupID([usdcTransfer, accrueInterestTxn]);
  const signedGroup = [
    group[0].signTxn(sender.sk),
    group[1].signTxn(sender.sk),
  ];
  const txID = await algod.sendRawTransaction(signedGroup).do();
  await algosdk.waitForConfirmation(algod, txID.txid, 5);
}

export async function getOrbitalVaultStats(
  algod: algosdk.Algodv2,
  deployment: OrbitalVaultDeploymentResult,
): Promise<{
  totalShares: number;
  totalPrincipal: number;
  lastRateSnapshot: number;
  usdcYieldPerShare: number;
  lastHarvestAsaPerUsdc: number;
  cUsdcBalance: number;
  projectAsaBalance: number;
}> {
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
      globalState[key] = safeToNumber(kv.value.uint);
    }
  }

  // Get asset balances
  const appAddr = algosdk.getApplicationAddress(deployment.vaultAppId).toString();
  const accountInfo = await algod.accountInformation(appAddr).do();

  let cUsdcBalance = 0;
  let projectAsaBalance = 0;

  for (const asset of accountInfo.assets || []) {
    const assetId = safeToNumber(asset.assetId);
    if (assetId === deployment.cUsdcAssetId) {
      cUsdcBalance = safeToNumber(asset.amount);
    } else if (assetId === deployment.projectAsaId) {
      projectAsaBalance = safeToNumber(asset.amount);
    }
  }

  return {
    totalShares: globalState['totalShares'] || 0,
    totalPrincipal: globalState['totalPrincipal'] || 0,
    lastRateSnapshot: globalState['lastRateSnapshot'] || 0,
    usdcYieldPerShare: globalState['usdcYieldPerShare'] || 0,
    lastHarvestAsaPerUsdc: globalState['lastHarvestAsaPerUsdc'] || 0,
    cUsdcBalance,
    projectAsaBalance,
  };
}

export async function getOrbitalRate(
  algod: algosdk.Algodv2,
  deployment: OrbitalVaultDeploymentResult,
): Promise<number> {
  const appInfo = await algod.getApplicationByID(deployment.orbitalAppId).do();
  const globalState: Record<string, number> = {};

  for (const kv of appInfo.params?.globalState || []) {
    let key: string;
    if (kv.key instanceof Uint8Array) {
      key = new TextDecoder().decode(kv.key);
    } else {
      key = Buffer.from(kv.key as string, 'base64').toString('utf8');
    }
    if (kv.value.type === 2) {
      globalState[key] = safeToNumber(kv.value.uint);
    }
  }

  const totalDeposits = globalState['total_deposits'] || 0;
  const circulatingLst = globalState['circulating_lst'] || 0;

  if (circulatingLst === 0) {
    return RATE_PRECISION; // 1.0
  }

  return Math.floor((totalDeposits * RATE_PRECISION) / circulatingLst);
}

export async function getUserPosition(
  algod: algosdk.Algodv2,
  deployment: OrbitalVaultDeploymentResult,
  userAddr: string,
): Promise<{
  userShares: number;
  userUsdcYieldPerShare: number;
  userUnrealizedUsdc: number;
  earnedAsa: number;
}> {
  const accountInfo = await algod.accountInformation(userAddr).do();

  const appLocalState = accountInfo['appsLocalState']?.find(
    (app: any) => safeToNumber(app.id) === deployment.vaultAppId
  );

  if (!appLocalState) {
    return { userShares: 0, userUsdcYieldPerShare: 0, userUnrealizedUsdc: 0, earnedAsa: 0 };
  }

  const localState: Record<string, number> = {};
  for (const kv of appLocalState.keyValue || []) {
    let key: string;
    if (kv.key instanceof Uint8Array) {
      key = new TextDecoder().decode(kv.key);
    } else {
      key = Buffer.from(kv.key as string, 'base64').toString('utf8');
    }
    if (kv.value.type === 2) {
      localState[key] = safeToNumber(kv.value.uint);
    }
  }

  return {
    userShares: localState['userShares'] || 0,
    userUsdcYieldPerShare: localState['userUsdcYieldPerShare'] || 0,
    userUnrealizedUsdc: localState['userUnrealizedUsdc'] || 0,
    earnedAsa: localState['earnedAsa'] || 0,
  };
}

export async function getPendingYield(
  algod: algosdk.Algodv2,
  deployment: OrbitalVaultDeploymentResult,
  userAddr: string,
): Promise<{ unrealizedUsdc: number; claimableAsa: number }> {
  const userPosition = await getUserPosition(algod, deployment, userAddr);
  const vaultStats = await getOrbitalVaultStats(algod, deployment);

  let unrealizedUsdc = userPosition.userUnrealizedUsdc;

  if (userPosition.userShares > 0) {
    const currentYPS = vaultStats.usdcYieldPerShare;
    const userYPS = userPosition.userUsdcYieldPerShare;

    if (currentYPS > userYPS) {
      // Calculate pending USDC yield: shares * (currentYPS - userYPS) / RATE_PRECISION
      unrealizedUsdc += Math.floor((userPosition.userShares * (currentYPS - userYPS)) / RATE_PRECISION);
    }
  }

  return {
    unrealizedUsdc,
    claimableAsa: userPosition.earnedAsa,
  };
}
