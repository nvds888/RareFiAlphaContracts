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

async function compileVaultContract(algodClient: algosdk.Algodv2) {
  const artifactsDir = path.resolve(__dirname, '../../contracts/artifacts');

  const approvalPath = path.join(artifactsDir, 'RareFiVault.approval.teal');
  const clearPath = path.join(artifactsDir, 'RareFiVault.clear.teal');
  const arc56Path = path.join(artifactsDir, 'RareFiVault.arc56.json');

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

export interface VaultDeploymentResult {
  vaultAppId: number;
  vaultAddress: string;
  alphaAssetId: number;   // deposit asset
  usdcAssetId: number;    // yield asset
  ibusAssetId: number;    // swap asset (project token)
  poolAppId: number;      // MockTinymanPool app ID
  poolAddress: string;    // MockTinymanPool address
  arc56Spec: any;
  poolArc56Spec: any;
}

export async function deployVaultForTest(
  algod: algosdk.Algodv2,
  creator: { addr: string | algosdk.Address; sk: Uint8Array },
  overrides?: {
    creatorFeeRate?: number;
    minSwapThreshold?: number;
    alphaSupply?: number;
    usdcSupply?: number;
    ibusSupply?: number;
    poolFeeBps?: number;        // Pool fee in basis points (default 30 = 0.3%)
    poolReserveUsdc?: number;   // Initial USDC reserve in pool
    poolReserveIbus?: number;   // Initial IBUS reserve in pool
  },
): Promise<VaultDeploymentResult> {
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

  const ibusAssetId = await createTestAsset(
    algod,
    creatorAccount,
    'IBUS-Test',
    'IBUSt',
    overrides?.ibusSupply ?? TOKEN_SUPPLY,
  );

  // Parameters
  const creatorFeeRate = overrides?.creatorFeeRate ?? 5; // 5% default (max 6%)
  const minSwapThreshold = overrides?.minSwapThreshold ?? 2_000_000; // 2 USDC default
  const poolFeeBps = overrides?.poolFeeBps ?? 30; // 0.3% default
  const poolReserveUsdc = overrides?.poolReserveUsdc ?? 10_000_000_000; // 10,000 USDC
  const poolReserveIbus = overrides?.poolReserveIbus ?? 10_000_000_000; // 10,000 IBUS

  // ========================================
  // Step 1: Deploy MockTinymanPool
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
  // The pool accepts ABI-style creation with 4-byte method selector
  const createPoolSelector = new Uint8Array([0x00, 0x00, 0x00, 0x00]); // Dummy 4-byte selector
  const createPoolTxn = algosdk.makeApplicationCreateTxnFromObject({
    sender: creatorAddr,
    approvalProgram: poolCompiled.approvalProgram,
    clearProgram: poolCompiled.clearProgram,
    numGlobalByteSlices: 1, // stateHolder
    numGlobalInts: 3, // asset1Id, asset2Id, initialized
    numLocalByteSlices: 0,
    numLocalInts: 5,  // asset_1_id, asset_2_id, asset_1_reserves, asset_2_reserves, total_fee_share
    extraPages: 0,
    suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
    appArgs: [
      createPoolSelector,
      encodeUint64(usdcAssetId),
      encodeUint64(ibusAssetId),
      encodeUint64(poolReserveUsdc),
      encodeUint64(poolReserveIbus),
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
    foreignAssets: [usdcAssetId, ibusAssetId],
    suggestedParams: { ...suggestedParams, fee: 3000, flatFee: true },
  });
  const signedPoolOptInTxn = poolOptInTxn.signTxn(creator.sk);
  const poolOptInTxID = await algod.sendRawTransaction(signedPoolOptInTxn).do();
  await algosdk.waitForConfirmation(algod, poolOptInTxID.txid, 5);

  // Creator opts into pool app (to become state holder for local state)
  // The vault will read pool state from creator's local state within the pool app
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
      encodeUint64(poolReserveIbus),
      encodeUint64(poolFeeBps),
    ],
    suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
  });
  const signedInitPoolTxn = initPoolTxn.signTxn(creator.sk);
  const initPoolTxID = await algod.sendRawTransaction(signedInitPoolTxn).do();
  await algosdk.waitForConfirmation(algod, initPoolTxID.txid, 5);

  // IMPORTANT: The state holder address is the creator's address
  // The vault reads pool state from this address's local state within the pool app
  const poolStateHolderAddress = creatorAddr;

  // Fund pool with IBUS liquidity (so it can swap USDC -> IBUS)
  suggestedParams = await algod.getTransactionParams().do();
  const fundPoolIbusTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: creatorAddr,
    receiver: poolAddress,
    amount: poolReserveIbus,
    assetIndex: ibusAssetId,
    suggestedParams,
  });
  const signedFundPoolIbusTxn = fundPoolIbusTxn.signTxn(creator.sk);
  const fundPoolIbusTxID = await algod.sendRawTransaction(signedFundPoolIbusTxn).do();
  await algosdk.waitForConfirmation(algod, fundPoolIbusTxID.txid, 5);

  // ========================================
  // Step 2: Deploy RareFiVault
  // ========================================
  const vaultCompiled = await compileVaultContract(algod);
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
      ibusAssetId,
      creatorFeeRate,
      minSwapThreshold,
      5000, // maxSlippageBps (50% for testing)
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
    numGlobalInts: 14, // depositAsset, yieldAsset, swapAsset, creatorFeeRate, creatorUnclaimedYield, totalDeposits, yieldPerToken, minSwapThreshold, maxSlippageBps, totalYieldGenerated, tinymanPoolAppId, farmBalance, farmEmissionRate, assetsOptedIn
    numLocalByteSlices: 0,
    numLocalInts: 3, // depositedAmount, userYieldPerToken, earnedYield
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
    amount: 200_300_000, // 200 ALGO setup fee + 0.3 ALGO for asset MBR
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
    suggestedParams: { ...(await algod.getTransactionParams().do()), fee: 5000, flatFee: true }, // 1 outer + 1 payment to rarefi + 3 asset opt-ins
    appForeignAssets: [alphaAssetId, usdcAssetId, ibusAssetId],
  });

  await vaultOptInAtc.execute(algod, 5);

  return {
    vaultAppId,
    vaultAddress,
    alphaAssetId,
    usdcAssetId,
    ibusAssetId,
    poolAppId,
    poolAddress: poolStateHolderAddress, // State holder address (where pool state is stored)
    arc56Spec: vaultCompiled.arc56Spec,
    poolArc56Spec: poolCompiled.arc56Spec,
  };
}

export async function performUserOptIn(
  algod: algosdk.Algodv2,
  deployment: VaultDeploymentResult,
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
  deployment: VaultDeploymentResult,
  user: { addr: string | algosdk.Address; sk: Uint8Array },
  amount: number,
  slippageBps: number = 100, // 1% default slippage for auto-swap
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

  // Then deposit call with slippageBps for potential auto-swap
  // Include pool references in case auto-swap is triggered
  atc.addMethodCall({
    appID: deployment.vaultAppId,
    method: contract.getMethodByName('deposit'),
    methodArgs: [slippageBps],
    sender: userAddr,
    signer,
    suggestedParams: { ...suggestedParams, fee: 5000, flatFee: true }, // Higher fee for potential inner txns
    appForeignAssets: [deployment.alphaAssetId, deployment.usdcAssetId, deployment.ibusAssetId],
    appForeignApps: [deployment.poolAppId],
    appAccounts: [deployment.poolAddress],
  });

  await atc.execute(algod, 5);
}

export async function performWithdraw(
  algod: algosdk.Algodv2,
  deployment: VaultDeploymentResult,
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
    suggestedParams: { ...suggestedParams, fee: 2000, flatFee: true },
    appForeignAssets: [deployment.alphaAssetId],
  });

  await atc.execute(algod, 5);
}

/**
 * Simulates yield coming in and being swapped to project ASA
 * 1. Sends USDC to vault (simulating yield airdrop)
 * 2. Calls swapYield to swap USDC -> IBUS via MockTinymanPool
 */
export async function performSwapYield(
  algod: algosdk.Algodv2,
  deployment: VaultDeploymentResult,
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

  // Step 1: Send USDC to vault (simulating yield airdrop from Alpha)
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

  // Step 2: Call swapYield to swap USDC -> IBUS
  suggestedParams = await algod.getTransactionParams().do();
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: deployment.vaultAppId,
    method: contract.getMethodByName('swapYield'),
    methodArgs: [slippageBps],
    sender: senderAddr,
    signer,
    suggestedParams: { ...suggestedParams, fee: 5000, flatFee: true }, // Higher fee for inner txns
    appForeignAssets: [deployment.usdcAssetId, deployment.ibusAssetId],
    appForeignApps: [deployment.poolAppId],
    appAccounts: [deployment.poolAddress],
  });

  await atc.execute(algod, 5);
}

export async function performClaim(
  algod: algosdk.Algodv2,
  deployment: VaultDeploymentResult,
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
    method: contract.getMethodByName('claim'),
    methodArgs: [],
    sender: userAddr,
    signer,
    suggestedParams: { ...suggestedParams, fee: 2000, flatFee: true },
    appForeignAssets: [deployment.ibusAssetId],
  });

  await atc.execute(algod, 5);
}

export async function performClaimCreator(
  algod: algosdk.Algodv2,
  deployment: VaultDeploymentResult,
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
    appForeignAssets: [deployment.ibusAssetId],
  });

  await atc.execute(algod, 5);
}

export async function performCloseOut(
  algod: algosdk.Algodv2,
  deployment: VaultDeploymentResult,
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
    suggestedParams: { ...suggestedParams, fee: 3000, flatFee: true },
    appForeignAssets: [deployment.alphaAssetId, deployment.ibusAssetId],
    onComplete: algosdk.OnApplicationComplete.CloseOutOC,
  });

  await atc.execute(algod, 5);
}

export async function getVaultStats(
  algod: algosdk.Algodv2,
  deployment: VaultDeploymentResult,
): Promise<{
  totalDeposits: number;
  yieldPerToken: number;
  creatorUnclaimedYield: number;
  usdcBalance: number;
  swapAssetBalance: number;
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

  // Get asset balances
  const appAddr = algosdk.getApplicationAddress(deployment.vaultAppId).toString();
  const accountInfo = await algod.accountInformation(appAddr).do();

  let usdcBalance = 0;
  let swapAssetBalance = 0;

  for (const asset of accountInfo.assets || []) {
    const assetId = safeToNumber(asset.assetId);
    if (assetId === deployment.usdcAssetId) {
      usdcBalance = safeToNumber(asset.amount);
    } else if (assetId === deployment.ibusAssetId) {
      swapAssetBalance = safeToNumber(asset.amount);
    }
  }

  return {
    totalDeposits: globalState['totalDeposits'] || 0,
    yieldPerToken: globalState['yieldPerToken'] || 0,
    creatorUnclaimedYield: globalState['creatorUnclaimedYield'] || 0,
    usdcBalance,
    swapAssetBalance,
  };
}

export async function getPendingYield(
  algod: algosdk.Algodv2,
  deployment: VaultDeploymentResult,
  userAddr: string,
): Promise<number> {
  // Read local state and calculate pending yield
  const localState = await getUserLocalState(algod, deployment.vaultAppId, userAddr);
  const globalState = await getVaultStats(algod, deployment);

  const deposited = localState.depositedAmount;
  let pending = localState.earnedYield;

  if (deposited > 0) {
    const currentYPT = globalState.yieldPerToken;
    const userYPT = localState.userYieldPerToken;

    if (currentYPT > userYPT) {
      pending = pending + Math.floor((deposited * (currentYPT - userYPT)) / 1_000_000_000_000);
    }
  }

  return pending;
}

export async function getUserDeposit(
  algod: algosdk.Algodv2,
  deployment: VaultDeploymentResult,
  userAddr: string,
): Promise<number> {
  const localState = await getUserLocalState(algod, deployment.vaultAppId, userAddr);
  return localState.depositedAmount;
}

async function getUserLocalState(
  algod: algosdk.Algodv2,
  appId: number,
  userAddr: string,
): Promise<{
  depositedAmount: number;
  userYieldPerToken: number;
  earnedYield: number;
}> {
  const accountInfo = await algod.accountInformation(userAddr).do();

  const appLocalState = accountInfo['appsLocalState']?.find(
    (app: any) => safeToNumber(app.id) === appId
  );

  if (!appLocalState) {
    return { depositedAmount: 0, userYieldPerToken: 0, earnedYield: 0 };
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
    depositedAmount: localState['depositedAmount'] || 0,
    userYieldPerToken: localState['userYieldPerToken'] || 0,
    earnedYield: localState['earnedYield'] || 0,
  };
}

export function getContract(deployment: VaultDeploymentResult): algosdk.ABIContract {
  return new algosdk.ABIContract(deployment.arc56Spec);
}

// Farm functions
export async function performContributeFarm(
  algod: algosdk.Algodv2,
  deployment: VaultDeploymentResult,
  contributor: { addr: string | algosdk.Address; sk: Uint8Array },
  ibusAmount: number,
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
  const ibusTransfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: contributorAddr,
    receiver: deployment.vaultAddress,
    amount: ibusAmount,
    assetIndex: deployment.ibusAssetId,
    suggestedParams,
  });
  atc.addTransaction({ txn: ibusTransfer, signer });

  // Then contributeFarm call
  atc.addMethodCall({
    appID: deployment.vaultAppId,
    method: contract.getMethodByName('contributeFarm'),
    methodArgs: [],
    sender: contributorAddr,
    signer,
    suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
    appForeignAssets: [deployment.ibusAssetId],
  });

  await atc.execute(algod, 5);
}

export async function performSetFarmEmissionRate(
  algod: algosdk.Algodv2,
  deployment: VaultDeploymentResult,
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

export async function performUpdateCreatorFeeRate(
  algod: algosdk.Algodv2,
  deployment: VaultDeploymentResult,
  sender: { addr: string | algosdk.Address; sk: Uint8Array },
  newFeeRate: number,
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
    method: contract.getMethodByName('updateCreatorFeeRate'),
    methodArgs: [newFeeRate],
    sender: senderAddr,
    signer,
    suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
  });

  await atc.execute(algod, 5);
}

export async function getFarmStats(
  algod: algosdk.Algodv2,
  deployment: VaultDeploymentResult,
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

export async function performUpdateTinymanPool(
  algod: algosdk.Algodv2,
  deployment: VaultDeploymentResult,
  sender: { addr: string | algosdk.Address; sk: Uint8Array },
  newPoolAppId: number,
  newPoolAddress: string,
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
    method: contract.getMethodByName('updateTinymanPool'),
    methodArgs: [newPoolAppId, newPoolAddress],
    sender: senderAddr,
    signer,
    suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
    appForeignApps: [newPoolAppId],
    appAccounts: [newPoolAddress],
  });

  await atc.execute(algod, 5);
}

/**
 * Deploy a MockTinymanPool with specific assets for testing pool validation
 */
export async function deployMockPoolWithAssets(
  algod: algosdk.Algodv2,
  creator: { addr: string | algosdk.Address; sk: Uint8Array },
  asset1Id: number,
  asset2Id: number,
  reserve1: number = 10_000_000_000,
  reserve2: number = 10_000_000_000,
  feeBps: number = 30,
): Promise<{ poolAppId: number; poolAddress: string }> {
  const creatorAddr = typeof creator.addr === 'string' ? creator.addr : creator.addr.toString();

  const artifactsDir = path.resolve(__dirname, '../../contracts/artifacts');
  const approvalPath = path.join(artifactsDir, 'MockTinymanPool.approval.teal');
  const clearPath = path.join(artifactsDir, 'MockTinymanPool.clear.teal');

  const approvalTeal = fs.readFileSync(approvalPath, 'utf8');
  const clearTeal = fs.readFileSync(clearPath, 'utf8');

  const approvalResponse = await algod.compile(approvalTeal).do();
  const clearResponse = await algod.compile(clearTeal).do();

  const approvalProgram = new Uint8Array(Buffer.from(approvalResponse.result, 'base64'));
  const clearProgram = new Uint8Array(Buffer.from(clearResponse.result, 'base64'));

  // Helper to encode uint64 as 8-byte big-endian
  const encodeUint64 = (n: number): Uint8Array => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(n));
    return new Uint8Array(buf);
  };

  let suggestedParams = await algod.getTransactionParams().do();

  const createPoolSelector = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
  const createPoolTxn = algosdk.makeApplicationCreateTxnFromObject({
    sender: creatorAddr,
    approvalProgram,
    clearProgram,
    numGlobalByteSlices: 1,
    numGlobalInts: 3,
    numLocalByteSlices: 0,
    numLocalInts: 5,
    extraPages: 0,
    suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
    appArgs: [
      createPoolSelector,
      encodeUint64(asset1Id),
      encodeUint64(asset2Id),
      encodeUint64(reserve1),
      encodeUint64(reserve2),
      encodeUint64(feeBps),
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

  // Creator opts into pool app (to become state holder)
  suggestedParams = await algod.getTransactionParams().do();
  const creatorOptInPoolTxn = algosdk.makeApplicationOptInTxnFromObject({
    sender: creatorAddr,
    appIndex: poolAppId,
    suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
  });
  const signedCreatorOptInPoolTxn = creatorOptInPoolTxn.signTxn(creator.sk);
  const creatorOptInPoolTxID = await algod.sendRawTransaction(signedCreatorOptInPoolTxn).do();
  await algosdk.waitForConfirmation(algod, creatorOptInPoolTxID.txid, 5);

  // Initialize pool local state
  suggestedParams = await algod.getTransactionParams().do();
  const initPoolTxn = algosdk.makeApplicationCallTxnFromObject({
    sender: creatorAddr,
    appIndex: poolAppId,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    appArgs: [
      new TextEncoder().encode('initializePool'),
      encodeUint64(reserve1),
      encodeUint64(reserve2),
      encodeUint64(feeBps),
    ],
    suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
  });
  const signedInitPoolTxn = initPoolTxn.signTxn(creator.sk);
  const initPoolTxID = await algod.sendRawTransaction(signedInitPoolTxn).do();
  await algosdk.waitForConfirmation(algod, initPoolTxID.txid, 5);

  // Return creator address as pool state holder
  return { poolAppId, poolAddress: creatorAddr };
}
