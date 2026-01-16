import algosdk from 'algosdk';

export async function getAssetBalance(
  algod: algosdk.Algodv2,
  address: string | algosdk.Address,
  assetId: number,
): Promise<number> {
  const addrStr = typeof address === 'string' ? address : address.toString();
  const accountInfo = await algod.accountInformation(addrStr).do();
  const asset = accountInfo.assets?.find(
    (a: any) => Number(a.assetId) === assetId,
  );
  return asset ? Number(asset.amount) : 0;
}

export async function optInToAsset(
  algod: algosdk.Algodv2,
  account: { addr: string | algosdk.Address; sk: Uint8Array },
  assetId: number,
) {
  const suggestedParams = await algod.getTransactionParams().do();
  const addr = typeof account.addr === 'string' ? account.addr : account.addr.toString();

  const optInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: addr,
    receiver: addr,
    amount: 0,
    assetIndex: assetId,
    suggestedParams: { ...suggestedParams, fee: 4000, flatFee: true },
  });

  const signedTxn = optInTxn.signTxn(account.sk);
  const txID = await algod.sendRawTransaction(signedTxn).do();
  await algosdk.waitForConfirmation(algod, txID.txid, 5);
}

export async function fundAccount(
  algod: algosdk.Algodv2,
  sender: { addr: string | algosdk.Address; sk: Uint8Array },
  receiver: string,
  amount: number,
) {
  if (amount === 0) return;

  const suggestedParams = await algod.getTransactionParams().do();
  const senderAddr = typeof sender.addr === 'string' ? sender.addr : sender.addr.toString();

  const payTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: senderAddr,
    receiver,
    amount,
    suggestedParams,
  });

  const signedTxn = payTxn.signTxn(sender.sk);
  const txID = await algod.sendRawTransaction(signedTxn).do();
  await algosdk.waitForConfirmation(algod, txID.txid, 5);
}

export async function fundAsset(
  algod: algosdk.Algodv2,
  sender: { addr: string | algosdk.Address; sk: Uint8Array },
  receiver: string,
  assetId: number,
  amount: number,
) {
  if (amount === 0) return;

  const suggestedParams = await algod.getTransactionParams().do();
  const senderAddr = typeof sender.addr === 'string' ? sender.addr : sender.addr.toString();

  const transferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: senderAddr,
    receiver,
    amount,
    assetIndex: assetId,
    suggestedParams,
  });

  const signedTxn = transferTxn.signTxn(sender.sk);
  const txID = await algod.sendRawTransaction(signedTxn).do();
  await algosdk.waitForConfirmation(algod, txID.txid, 5);
}

export async function createTestAsset(
  algodClient: algosdk.Algodv2,
  creator: { addr: string; sk: Uint8Array },
  name: string,
  unitName: string,
  supply: number,
  decimals: number = 6,
): Promise<number> {
  const suggestedParams = await algodClient.getTransactionParams().do();

  const txn = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
    sender: creator.addr,
    assetName: name,
    unitName: unitName,
    total: supply,
    decimals: decimals,
    defaultFrozen: false,
    manager: creator.addr,
    reserve: creator.addr,
    suggestedParams,
  });

  const signedTxn = algosdk.signTransaction(txn, creator.sk);
  const { txid } = await algodClient.sendRawTransaction(signedTxn.blob).do();
  await algosdk.waitForConfirmation(algodClient, txid, 5);

  const confirmedTxn = await algodClient.pendingTransactionInformation(txid).do();
  return safeToNumber(confirmedTxn.assetIndex);
}

function safeToNumber(value: any): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return parseInt(value) || 0;
}
