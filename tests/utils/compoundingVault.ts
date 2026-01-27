import algosdk from 'algosdk';
import fs from 'fs';
import path from 'path';
import { createTestAsset } from './assets';

export const TOKEN_SUPPLY = 100_000_000_000_000; // 100M tokens with 6 decimals
export const TOKEN_DECIMALS = 6;

function safeToNumber(value: any): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return parseInt(value) || 0;
}

async function compileCompoundingVaultContract(algodClient: algosdk.Algodv2) {
  const artifactsDir = path.resolve(__dirname, '../../contracts/artifacts');

  const approvalPath = path.join(artifactsDir, 'RareFiAlphaCompoundingVault.approval.teal');
  const clearPath = path.join(artifactsDir, 'RareFiAlphaCompoundingVault.clear.teal');
  const arc56Path = path.join(artifactsDir, 'RareFiAlphaCompoundingVault.arc56.json');

  if (!fs.existsSync(approvalPath)) {
    throw new Error(`Approval program not found: ${approvalPath}. Run 'npm run compile' first.`);
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
    throw new Error(`Pool approval program not found: ${approvalPath}. Run compile for MockTinymanPool first.`);
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

export interface CompoundingVaultDeploymentResult {
  vaultAppId: number;
  vaultAddress: string;
  alphaAssetId: number;   // deposit & yield asset (Alpha)
  usdcAssetId: number;    // USDC (airdrops come in as this)
  poolAppId: number;      // MockTinymanPool app ID (USDC/Alpha)
  poolAddress: string;    // MockTinymanPool address
  arc56Spec: any;
  poolArc56Spec: any;
}

export async function deployCompoundingVaultForTest(
  algod: algosdk.Algodv2,
  creator: { addr: string | algosdk.Address; sk: Uint8Array },
  overrides?: {
    creatorFeeRate?: number;
    minSwapThreshold?: number;
    alphaSupply?: number;
    usdcSupply?: number;
    poolFeeBps?: number;        // Pool fee in basis points (default 30 = 0.3%)
    poolReserveUsdc?: number;   // Initial USDC reserve in pool
    poolReserveAlpha?: number;  // Initial Alpha reserve in pool
  },
): Promise<CompoundingVaultDeploymentResult> {
  const creatorAddr = typeof creator.addr === 'string' ? creator.addr : creator.addr.toString();
  const creatorAccount = { addr: creatorAddr, sk: creator.sk };

  // Create test assets
  const alphaAssetId = await createTestAsset(
    algod,
    creatorAccount,
    'Alpha-Test',
    'ALPHAT',
    overrides?.alphaSupply ?? TOKEN_SUPPLY,
  );

  const usdcAssetId = await createTestAsset(
    algod,
    creatorAccount,
    'USDC-Test',
    'USDCt',
    overrides?.usdcSupply ?? TOKEN_SUPPLY,
  );

  // Parameters
  const creatorFeeRate = overrides?.creatorFeeRate ?? 20; // 20% default
  const minSwapThreshold = overrides?.minSwapThreshold ?? 2_000_000; // 2 USDC default
  const poolFeeBps = overrides?.poolFeeBps ?? 30; // 0.3% default
  const poolReserveUsdc = overrides?.poolReserveUsdc ?? 10_000_000_000; // 10,000 USDC
  const poolReserveAlpha = overrides?.poolReserveAlpha ?? 10_000_000_000; // 10,000 Alpha

  // ========================================
  // Step 1: Deploy MockTinymanPool (USDC/Alpha)
  // ========================================
  const poolCompiled = await compilePoolContract(algod);

  let suggestedParams = await algod.getTransactionParams().do();

  // Helper to encode uint64 as 8-byte big-endian
  const encodeUint64 = (n: number): Uint8Array => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(n));
    return new Uint8Array(buf);
  };

  // Create pool with raw app args (4-byte selector + uint64 args)
  const createPoolSelector = new Uint8Array([0x00, 0x00, 0x00, 0x00]); // Dummy 4-byte selector
  const createPoolTxn = algosdk.makeApplicationCreateTxnFromObject({
    sender: creatorAddr,
    approvalProgram: poolCompiled.approvalProgram,
    clearProgram: poolCompiled.clearProgram,
    numGlobalByteSlices: 1, // stateHolder
    numGlobalInts: 3, // asset1Id, asset2Id, initialized
    numLocalByteSlices: 0,
    numLocalInts: 4,  // asset_1_id, asset_1_reserves, asset_2_reserves, total_fee_share
    extraPages: 0,
    suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
    appArgs: [
      createPoolSelector,
      encodeUint64(usdcAssetId),
      encodeUint64(alphaAssetId),
      encodeUint64(poolReserveUsdc),
      encodeUint64(poolReserveAlpha),
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
    amount: 500_000, // 0.5 ALGO
    suggestedParams,
  });
  const signedFundPoolTxn = fundPoolTxn.signTxn(creator.sk);
  const fundPoolTxID = await algod.sendRawTransaction(signedFundPoolTxn).do();
  await algosdk.waitForConfirmation(algod, fundPoolTxID.txid, 5);

  // Pool opts into assets (raw app args)
  suggestedParams = await algod.getTransactionParams().do();
  const poolOptInTxn = algosdk.makeApplicationCallTxnFromObject({
    sender: creatorAddr,
    appIndex: poolAppId,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    appArgs: [new TextEncoder().encode('optInAssets')],
    foreignAssets: [usdcAssetId, alphaAssetId],
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
      encodeUint64(poolReserveAlpha),
      encodeUint64(poolFeeBps),
    ],
    suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
  });
  const signedInitPoolTxn = initPoolTxn.signTxn(creator.sk);
  const initPoolTxID = await algod.sendRawTransaction(signedInitPoolTxn).do();
  await algosdk.waitForConfirmation(algod, initPoolTxID.txid, 5);

  // IMPORTANT: The state holder address is the creator's address
  const poolStateHolderAddress = creatorAddr;

  // Fund pool with Alpha liquidity (so it can swap USDC -> Alpha)
  suggestedParams = await algod.getTransactionParams().do();
  const fundPoolAlphaTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: creatorAddr,
    receiver: poolAddress,
    amount: poolReserveAlpha,
    assetIndex: alphaAssetId,
    suggestedParams,
  });
  const signedFundPoolAlphaTxn = fundPoolAlphaTxn.signTxn(creator.sk);
  const fundPoolAlphaTxID = await algod.sendRawTransaction(signedFundPoolAlphaTxn).do();
  await algosdk.waitForConfirmation(algod, fundPoolAlphaTxID.txid, 5);

  // ========================================
  // Step 2: Deploy RareFiAlphaCompoundingVault
  // ========================================
  const vaultCompiled = await compileCompoundingVaultContract(algod);
  const vaultContract = new algosdk.ABIContract(vaultCompiled.arc56Spec);

  suggestedParams = await algod.getTransactionParams().do();
  const createVaultMethod = vaultContract.getMethodByName('createVault');

  const vaultAtc = new algosdk.AtomicTransactionComposer();
  vaultAtc.addMethodCall({
    appID: 0,
    method: createVaultMethod,
    methodArgs: [
      alphaAssetId,
      usdcAssetId,
      creatorFeeRate,
      minSwapThreshold,
      poolAppId,
      poolStateHolderAddress, // Use state holder (where pool state is in local state)
      creatorAddr, // rarefiAddress = creator for testing
    ],
    sender: creatorAddr,
    signer: algosdk.makeBasicAccountTransactionSigner({ sk: creator.sk, addr: algosdk.decodeAddress(creatorAddr) }),
    suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
    approvalProgram: vaultCompiled.approvalProgram,
    clearProgram: vaultCompiled.clearProgram,
    numGlobalByteSlices: 3, // creatorAddress, rarefiAddress, tinymanPoolAddress
    numGlobalInts: 11, // alphaAsset, usdcAsset, creatorFeeRate, creatorUnclaimedAlpha, totalShares, totalAlpha, minSwapThreshold, totalYieldCompounded, tinymanPoolAppId, farmBalance, farmEmissionRate
    numLocalByteSlices: 0,
    numLocalInts: 1, // userShares
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
    amount: 500_000, // 0.5 ALGO
    suggestedParams,
  });
  const signedFundVaultTxn = fundVaultTxn.signTxn(creator.sk);
  const fundVaultTxID = await algod.sendRawTransaction(signedFundVaultTxn).do();
  await algosdk.waitForConfirmation(algod, fundVaultTxID.txid, 5);

  // Vault opts into assets
  const paymentTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: creatorAddr,
    receiver: vaultAddress,
    amount: 5_400_000, // 5.4 ALGO
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
    suggestedParams: { ...(await algod.getTransactionParams().do()), fee: 3000, flatFee: true },
    appForeignAssets: [alphaAssetId, usdcAssetId],
  });

  await vaultOptInAtc.execute(algod, 5);

  return {
    vaultAppId,
    vaultAddress,
    alphaAssetId,
    usdcAssetId,
    poolAppId,
    poolAddress: poolStateHolderAddress, // State holder address (where pool state is stored)
    arc56Spec: vaultCompiled.arc56Spec,
    poolArc56Spec: poolCompiled.arc56Spec,
  };
}

export async function performUserOptIn(
  algod: algosdk.Algodv2,
  deployment: CompoundingVaultDeploymentResult,
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
  deployment: CompoundingVaultDeploymentResult,
  user: { addr: string | algosdk.Address; sk: Uint8Array },
  amount: number,
  slippageBps: number = 100, // 1% default slippage for auto-compound
) {
  const contract = new algosdk.ABIContract(deployment.arc56Spec);
  const suggestedParams = await algod.getTransactionParams().do();
  const userAddr = typeof user.addr === 'string' ? user.addr : user.addr.toString();
  const signer = algosdk.makeBasicAccountTransactionSigner({
    sk: user.sk,
    addr: algosdk.decodeAddress(userAddr),
  });

  const atc = new algosdk.AtomicTransactionComposer();

  // Asset transfer first
  const alphaTransfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: userAddr,
    receiver: deployment.vaultAddress,
    amount: amount,
    assetIndex: deployment.alphaAssetId,
    suggestedParams,
  });
  atc.addTransaction({ txn: alphaTransfer, signer });

  // Then deposit call with slippageBps for potential auto-compound
  // Include pool references in case auto-compound is triggered
  atc.addMethodCall({
    appID: deployment.vaultAppId,
    method: contract.getMethodByName('deposit'),
    methodArgs: [slippageBps],
    sender: userAddr,
    signer,
    suggestedParams: { ...suggestedParams, fee: 5000, flatFee: true }, // Higher fee for potential inner txns
    appForeignAssets: [deployment.alphaAssetId, deployment.usdcAssetId],
    appForeignApps: [deployment.poolAppId],
    appAccounts: [deployment.poolAddress],
  });

  await atc.execute(algod, 5);
}

export async function performWithdraw(
  algod: algosdk.Algodv2,
  deployment: CompoundingVaultDeploymentResult,
  user: { addr: string | algosdk.Address; sk: Uint8Array },
  shareAmount: number, // 0 = withdraw all
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
    methodArgs: [shareAmount],
    sender: userAddr,
    signer,
    suggestedParams: { ...suggestedParams, fee: 2000, flatFee: true },
    appForeignAssets: [deployment.alphaAssetId],
  });

  await atc.execute(algod, 5);
}

/**
 * Simulates yield coming in and being compounded to Alpha
 * 1. Sends USDC to vault (simulating yield airdrop)
 * 2. Calls compoundYield to swap USDC -> Alpha via MockTinymanPool
 */
export async function performCompoundYield(
  algod: algosdk.Algodv2,
  deployment: CompoundingVaultDeploymentResult,
  sender: { addr: string | algosdk.Address; sk: Uint8Array },
  usdcAmount: number,
  slippageBps: number = 50, // 0.5% default slippage
) {
  const contract = new algosdk.ABIContract(deployment.arc56Spec);
  const senderAddr = typeof sender.addr === 'string' ? sender.addr : sender.addr.toString();
  const signer = algosdk.makeBasicAccountTransactionSigner({
    sk: sender.sk,
    addr: algosdk.decodeAddress(senderAddr),
  });

  // Step 1: Send USDC to vault (simulating yield airdrop)
  let suggestedParams = await algod.getTransactionParams().do();
  const usdcTransfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: senderAddr,
    receiver: deployment.vaultAddress,
    amount: usdcAmount,
    assetIndex: deployment.usdcAssetId,
    suggestedParams,
  });
  const signedUsdcTransfer = usdcTransfer.signTxn(sender.sk);
  const usdcTxID = await algod.sendRawTransaction(signedUsdcTransfer).do();
  await algosdk.waitForConfirmation(algod, usdcTxID.txid, 5);

  // Step 2: Call compoundYield to swap USDC -> Alpha
  suggestedParams = await algod.getTransactionParams().do();
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: deployment.vaultAppId,
    method: contract.getMethodByName('compoundYield'),
    methodArgs: [slippageBps],
    sender: senderAddr,
    signer,
    suggestedParams: { ...suggestedParams, fee: 5000, flatFee: true }, // Higher fee for inner txns
    appForeignAssets: [deployment.usdcAssetId, deployment.alphaAssetId],
    appForeignApps: [deployment.poolAppId],
    appAccounts: [deployment.poolAddress],
  });

  await atc.execute(algod, 5);
}

export async function performClaimCreator(
  algod: algosdk.Algodv2,
  deployment: CompoundingVaultDeploymentResult,
  creator: { addr: string | algosdk.Address; sk: Uint8Array },
) {
  const contract = new algosdk.ABIContract(deployment.arc56Spec);
  const suggestedParams = await algod.getTransactionParams().do();
  const creatorAddr = typeof creator.addr === 'string' ? creator.addr : creator.addr.toString();
  const signer = algosdk.makeBasicAccountTransactionSigner({
    sk: creator.sk,
    addr: algosdk.decodeAddress(creatorAddr),
  });

  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: deployment.vaultAppId,
    method: contract.getMethodByName('claimCreator'),
    methodArgs: [],
    sender: creatorAddr,
    signer,
    suggestedParams: { ...suggestedParams, fee: 2000, flatFee: true },
    appForeignAssets: [deployment.alphaAssetId],
  });

  await atc.execute(algod, 5);
}

export async function performCloseOut(
  algod: algosdk.Algodv2,
  deployment: CompoundingVaultDeploymentResult,
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
    suggestedParams: { ...suggestedParams, fee: 2000, flatFee: true },
    appForeignAssets: [deployment.alphaAssetId],
    onComplete: algosdk.OnApplicationComplete.CloseOutOC,
  });

  await atc.execute(algod, 5);
}

export async function getVaultStats(
  algod: algosdk.Algodv2,
  deployment: CompoundingVaultDeploymentResult,
): Promise<{
  totalShares: number;
  totalAlpha: number;
  creatorUnclaimedAlpha: number;
  usdcBalance: number;
  totalYieldCompounded: number;
  sharePrice: number;
}> {
  // Read from global state directly
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

  // Get USDC balance
  const appAddr = algosdk.getApplicationAddress(deployment.vaultAppId).toString();
  const accountInfo = await algod.accountInformation(appAddr).do();

  let usdcBalance = 0;

  for (const asset of accountInfo.assets || []) {
    const assetId = safeToNumber(asset.assetId);
    if (assetId === deployment.usdcAssetId) {
      usdcBalance = safeToNumber(asset.amount);
    }
  }

  const totalShares = globalState['totalShares'] || 0;
  const totalAlpha = globalState['totalAlpha'] || 0;
  const SCALE = 1_000_000_000_000; // 1e12

  // Calculate share price
  let sharePrice = SCALE; // Default 1:1
  if (totalShares > 0) {
    sharePrice = Math.floor((totalAlpha * SCALE) / totalShares);
  }

  return {
    totalShares,
    totalAlpha,
    creatorUnclaimedAlpha: globalState['creatorUnclaimedAlpha'] || 0,
    usdcBalance,
    totalYieldCompounded: globalState['totalYieldCompounded'] || 0,
    sharePrice,
  };
}

export async function getUserShares(
  algod: algosdk.Algodv2,
  deployment: CompoundingVaultDeploymentResult,
  userAddr: string,
): Promise<number> {
  const localState = await getUserLocalState(algod, deployment.vaultAppId, userAddr);
  return localState.userShares;
}

export async function getUserAlphaBalance(
  algod: algosdk.Algodv2,
  deployment: CompoundingVaultDeploymentResult,
  userAddr: string,
): Promise<number> {
  const localState = await getUserLocalState(algod, deployment.vaultAppId, userAddr);
  const stats = await getVaultStats(algod, deployment);

  if (stats.totalShares === 0) {
    return 0;
  }

  // alphaAmount = (shares * totalAlpha) / totalShares
  return Math.floor((localState.userShares * stats.totalAlpha) / stats.totalShares);
}

async function getUserLocalState(
  algod: algosdk.Algodv2,
  appId: number,
  userAddr: string,
): Promise<{
  userShares: number;
}> {
  const accountInfo = await algod.accountInformation(userAddr).do();

  const appLocalState = accountInfo['appsLocalState']?.find(
    (app: any) => safeToNumber(app.id) === appId
  );

  if (!appLocalState) {
    return { userShares: 0 };
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
  };
}

export function getContract(deployment: CompoundingVaultDeploymentResult): algosdk.ABIContract {
  return new algosdk.ABIContract(deployment.arc56Spec);
}

// Farm functions
export async function performContributeFarm(
  algod: algosdk.Algodv2,
  deployment: CompoundingVaultDeploymentResult,
  contributor: { addr: string | algosdk.Address; sk: Uint8Array },
  alphaAmount: number,
) {
  const contract = new algosdk.ABIContract(deployment.arc56Spec);
  const suggestedParams = await algod.getTransactionParams().do();
  const contributorAddr = typeof contributor.addr === 'string' ? contributor.addr : contributor.addr.toString();
  const signer = algosdk.makeBasicAccountTransactionSigner({
    sk: contributor.sk,
    addr: algosdk.decodeAddress(contributorAddr),
  });

  const atc = new algosdk.AtomicTransactionComposer();

  // Asset transfer first
  const alphaTransfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: contributorAddr,
    receiver: deployment.vaultAddress,
    amount: alphaAmount,
    assetIndex: deployment.alphaAssetId,
    suggestedParams,
  });
  atc.addTransaction({ txn: alphaTransfer, signer });

  // Then contributeFarm call
  atc.addMethodCall({
    appID: deployment.vaultAppId,
    method: contract.getMethodByName('contributeFarm'),
    methodArgs: [],
    sender: contributorAddr,
    signer,
    suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
    appForeignAssets: [deployment.alphaAssetId],
  });

  await atc.execute(algod, 5);
}

export async function performSetFarmEmissionRate(
  algod: algosdk.Algodv2,
  deployment: CompoundingVaultDeploymentResult,
  sender: { addr: string | algosdk.Address; sk: Uint8Array },
  emissionRateBps: number,
) {
  const contract = new algosdk.ABIContract(deployment.arc56Spec);
  const suggestedParams = await algod.getTransactionParams().do();
  const senderAddr = typeof sender.addr === 'string' ? sender.addr : sender.addr.toString();
  const signer = algosdk.makeBasicAccountTransactionSigner({
    sk: sender.sk,
    addr: algosdk.decodeAddress(senderAddr),
  });

  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: deployment.vaultAppId,
    method: contract.getMethodByName('setFarmEmissionRate'),
    methodArgs: [emissionRateBps],
    sender: senderAddr,
    signer,
    suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
  });

  await atc.execute(algod, 5);
}

export async function getFarmStats(
  algod: algosdk.Algodv2,
  deployment: CompoundingVaultDeploymentResult,
): Promise<{
  farmBalance: number;
  farmEmissionRate: number;
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

  return {
    farmBalance: globalState['farmBalance'] || 0,
    farmEmissionRate: globalState['farmEmissionRate'] || 0,
  };
}
