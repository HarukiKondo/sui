// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
/* eslint-disable eqeqeq */

/**
 * Implements a `kiosk-cli`. To view available commands, run:
 * ```sh
 * $ node index.js help
 * ```
 *
 * Alternatively, via the `pnpm`:
 * ```sh
 * pnpm cli help
 * ```
 *
 * This package allows for:
 * - Creating a Kiosk;
 * - Placing items into the Kiosk;
 * - Listing items in the Kiosk for sale;
 * - Purchasing items from the Kiosk;
 * - Taking items from the Kiosk;
 * - Locking items in the Kiosk;
 * - Delisting items from the Kiosk;
 * - Viewing the inventory of the sender;
 * - Viewing the contents of a Kiosk;
 */

import {
  RawSigner,
  testnetConnection,
  Ed25519Keypair,
  TransactionBlock,
  JsonRpcProvider,
  formatAddress,
  isValidSuiAddress,
  isValidSuiObjectId,
  MIST_PER_SUI,
  bcs,
} from '@mysten/sui.js';
import { program } from 'commander';
import {
  createKioskAndShare,
  fetchKiosk,
  place,
  list,
  queryTransferPolicy,
  delist,
  withdrawFromKiosk,
  take,
  lock,
  purchaseAndResolvePolicies,
  mainnetEnvironment,
  testnetEnvironment,
  getOwnedKiosks,
  KIOSK_LISTING,
} from '@mysten/kiosk';

/**
 * List of known types for shorthand search in the `search` command.
 */
const KNOWN_TYPES = {
  suifren:
    '0x80d7de9c4a56194087e0ba0bf59492aa8e6a5ee881606226930827085ddf2332::suifrens::SuiFren<0x80d7de9c4a56194087e0ba0bf59492aa8e6a5ee881606226930827085ddf2332::capy::Capy>',
};

/** JsonRpcProvider for the Testnet */
const provider = new JsonRpcProvider(testnetConnection);

/**
 * Create the signer instance from the mnemonic.
 */
const signer = (function (mnemonic) {
  if (!mnemonic) {
    console.log('Requires MNEMONIC; set with `export MNEMONIC="..."`');
    process.exit(1);
  }

  const keypair = Ed25519Keypair.deriveKeypair(process.env.MNEMONIC);
  const provider = new JsonRpcProvider(testnetConnection);
  return new RawSigner(keypair, provider);
})(process.env.MNEMONIC);

program
  .name('kiosk-cli')
  .description(
    'Simple CLI to interact with Kiosk smart contracts. \nRequires MNEMONIC environment variable.',
  )
  .version('0.0.1');

program
  .command('new')
  .description('create and share a Kiosk; send OwnerCap to sender')
  .action(newKiosk);

program
  .command('inventory')
  .description('view the inventory of the sender')
  .option('-a, --address <address>', "Fetch another user's inventory")
  .option('--cursor', 'Fetch inventory starting from this cursor')
  .option('--only-display', 'Only show items that have Display')
  .option('-f, --filter <type>', 'Filter by type')
  .action(showInventory);

program
  .command('contents')
  .description('list all Items and Listings in the Kiosk owned by the sender')
  .option('--id <id>', 'The ID of the Kiosk to look up')
  .option('--address <address>', 'The address of the Kiosk owner')
  .action(showKioskContents);

program
  .command('place')
  .description("place an item from the sender's inventory into the Kiosk")
  .argument('<item ID>', 'The ID of the item to place')
  .action(placeItem);

program
  .command('lock')
  .description('lock an item in the user Kiosk (requires TransferPolicy)')
  .argument('<item ID>', 'The ID of the item to place')
  .action(lockItem);

program
  .command('take')
  .description('Take an item from the Kiosk and transfer to sender or to <address>')
  .argument('<item ID>', 'The ID of the item to take')
  .option('-a, --address <address>')
  .action(takeItem);

program
  .command('list')
  .description('list an item in the Kiosk for the specified amount of SUI')
  .argument('<item ID>', 'The ID of the item to list')
  .argument('<amount MIST>', 'The amount of SUI to list the item for')
  .action(listItem);

program
  .command('delist')
  .description('delist an item from the Kiosk')
  .argument('<item ID>', 'The ID of the item to delist')
  .action(delistItem);

program
  .command('purchase')
  .description('purchase an item from the specified Kiosk')
  .argument('<item ID>', 'The ID of the item to purchase')
  .option(
    '--kiosk <ID>',
    'The ID of the Kiosk to purchase from (speeds up purchase by skipping search)',
  )
  .option(
    '-t, --target ["kiosk" | <address>]',
    'Purchase destination: "kiosk" for user Kiosk or \ncustom address (defaults to sender)',
  )
  .action(purchaseItem);

program
  .command('search')
  .description('search open listings in Kiosks')
  .argument('<type>', 'The type of the item to search for. \nAvailable aliases: "suifren", "test"')
  .action(searchType);

program
  .command('policy')
  .description('search for a TransferPolicy for the specified type')
  .argument('<type>', 'The type of the item to search for. \nAvailable aliases: "suifren", "test"')
  .action(searchPolicy);

program
  .command('withdraw')
  .description('Withdraw all profits from the Kiosk to the Kiosk Owner')
  .action(withdrawAll);

program
  .command('publisher')
  .description('View the Publisher objects owned by the user')
  .action(showPublisher);

program.parse(process.argv);

/**
 * Command: `new`
 * Description: creates and shares a Kiosk
 */
async function newKiosk() {
  const sender = await signer.getAddress();
  const kioskCap = await findKioskCap().catch(() => null);

  if (kioskCap !== null) {
    throw new Error(`Kiosk already exists for ${sender}`);
  }

  const txb = new TransactionBlock();
  const cap = createKioskAndShare(txb);
  txb.transferObjects([cap], txb.pure(sender, 'address'));

  return sendTx(txb);
}

/**
 * Command: `inventory`
 * Description: view the inventory of the sender (or a specified address)
 */
async function showInventory({ address, onlyDisplay, cursor, filter }) {
  const owner = address || (await signer.getAddress());

  if (!isValidSuiAddress(owner)) {
    throw new Error(`Invalid SUI address: "${owner}"`);
  }

  const options = {
    owner,
    cursor,
    options: {
      showType: true,
      showDisplay: true,
    },
  };

  if (filter) {
    options.filter = { StructType: KNOWN_TYPES[filter] || filter };
  }

  const { data, nextCursor, hasNextPage } = await provider.getOwnedObjects(options);

  if (hasNextPage) {
    console.log('Showing first page of results. Use `--cursor` to get the next page.');
    console.log('Next cursor: %s', nextCursor);
  }

  const list = data
    .filter(({ data, error }) => !error && data)
    .sort((a, b) => a.data.type.localeCompare(b.data.type))
    .map(({ data }) => ({
      objectId: data.objectId,
      type: formatType(data.type),
      hasDisplay: !!data.display.data,
    }));

  console.log('- Owner %s', owner);
  if (onlyDisplay) {
    console.table(list.filter(({ hasDisplay }) => hasDisplay));
  } else {
    console.table(list);
  }
}

/**
 * Command: `contents`
 * Description: Show the contents of the Kiosk owned by the sender (or the
 * specified address) or directly by the specified Kiosk ID
 */
async function showKioskContents({ id, address }) {
  let kioskId = null;

  if (id) {
    if (!isValidSuiObjectId(id)) {
      throw new Error(`Invalid Kiosk ID: "${id}"`);
    }

    kioskId = id;
  } else {
    const sender = address || (await signer.getAddress());

    if (!isValidSuiAddress(sender)) {
      throw new Error(`Invalid SUI address: "${sender}"`);
    }

    const kioskCap = await findKioskCap(sender).catch(() => null);
    if (kioskCap == null) {
      throw new Error(`No Kiosk found for ${sender}`);
    }
    kioskId = kioskCap.kioskId;
  }

  const {
    data: { items, kiosk },
    hasNextPage,
    nextCursor,
  } = await fetchKiosk(
    provider,
    kioskId,
    { limit: 1000 },
    {
      withListingPrices: true,
      withKioskFields: true,
    },
  );

  if (hasNextPage) {
    console.log('Next cursor:   %s', nextCursor);
  }

  console.log('Description');
  console.log('- Kiosk ID:    %s', kioskId);
  console.log('- Profits:     %s', kiosk.profits);
  console.log('- UID Exposed: %s', kiosk.allowExtensions);
  console.log('- Item Count:  %s', kiosk.itemCount);

  const tabledItems = items
    .map((item) => ({
      objectId: item.objectId,
      type: formatType(item.type),
      isLocked: item.isLocked,
      listed: !!item.listing,
      isPublic: (item.listing && !item.listing.isExclusive) || false,
      'price (SUI)': item.listing ? formatAmount(item.listing.price) : 'N/A',
    }))
    .sort((a, b) => a.listed - b.listed);

  console.table(tabledItems);
}

/**
 * Command: `place`
 * Description: Place an item into the Kiosk owned by the sender
 */
async function placeItem(itemId) {
  const kioskCap = await findKioskCap().catch(() => null);
  const owner = await signer.getAddress();

  if (kioskCap === null) {
    throw new Error('No Kiosk found for sender; use `new` to create one');
  }

  if (!isValidSuiObjectId(itemId)) {
    throw new Error('Invalid Item ID: "%s"', itemId);
  }

  const item = await provider.getObject({
    id: itemId,
    options: { showType: true, showOwner: true },
  });

  if ('error' in item || !item.data) {
    throw new Error(`Item ${itemId} not found; error: ` + item.error);
  }

  if (!('AddressOwner' in item.data.owner) || item.data.owner.AddressOwner !== owner) {
    throw new Error(`Item ${itemId} is not owned by ${owner}; use \`inventory\` to see your items`);
  }

  const txb = new TransactionBlock();
  const capArg = txb.objectRef({ ...kioskCap });
  const itemArg = txb.objectRef({ ...item.data });
  const kioskArg = txb.object(kioskCap.kioskId);

  place(txb, item.data.type, kioskArg, capArg, itemArg);

  return sendTx(txb);
}

/**
 * Command: `lock`
 * Description: Lock an item in the Kiosk owned by the sender (requires TransferPolicy)
 */
async function lockItem(itemId) {
  const kioskCap = await findKioskCap().catch(() => null);
  const owner = await signer.getAddress();

  if (kioskCap === null) {
    throw new Error('No Kiosk found for sender; use `new` to create one');
  }

  if (!isValidSuiObjectId(itemId)) {
    throw new Error('Invalid Item ID: "%s"', itemId);
  }

  const item = await provider.getObject({
    id: itemId,
    options: { showType: true, showOwner: true },
  });

  if ('error' in item || !item.data) {
    throw new Error(`Item ${itemId} not found; error: ` + item.error);
  }

  if (!('AddressOwner' in item.data.owner) || item.data.owner.AddressOwner !== owner) {
    throw new Error(`Item ${itemId} is not owned by ${owner}; use \`inventory\` to see your items`);
  }

  const [policy] = await queryTransferPolicy(provider, item.data.type);

  if (!policy) {
    throw new Error(`Item ${itemId} with type ${item.data.type} does not have a TransferPolicy`);
  }

  const txb = new TransactionBlock();
  const capArg = txb.objectRef({ ...kioskCap });
  const itemArg = txb.objectRef({ ...item.data });
  const policyArg = txb.object(policy.id);
  const kioskArg = txb.object(kioskCap.kioskId);

  lock(txb, item.data.type, kioskArg, capArg, policyArg, itemArg);

  return sendTx(txb);
}

/**
 * Command: `take`
 * Description: Take an item from the Kiosk and transfer to sender (or to
 * --address <address>)
 */
async function takeItem(itemId, { address }) {
  const kioskCap = await findKioskCap().catch(() => null);
  const receiver = address || (await signer.getAddress());

  if (!isValidSuiAddress(receiver)) {
    throw new Error('Invalid receiver address: "%s"', receiver);
  }

  if (!isValidSuiObjectId(itemId)) {
    throw new Error('Invalid Item ID: "%s"', itemId);
  }

  if (kioskCap === null) {
    throw new Error('No Kiosk found for sender; use `new` to create one');
  }

  const item = await provider.getObject({ id: itemId, options: { showType: true } });

  if ('error' in item || !item.data) {
    throw new Error(`Item ${itemId} not found; error: ` + item.error);
  }

  const txb = new TransactionBlock();
  const kioskArg = txb.object(kioskCap.kioskId);
  const capArg = txb.objectRef({ ...kioskCap });
  const taken = take(txb, item.data.type, kioskArg, capArg, itemId);

  txb.transferObjects([taken], txb.pure(receiver, 'address'));

  return sendTx(txb);
}

/**
 * Command: `list`
 * Description: Lists an item in the Kiosk for the specified amount of SUI
 */
async function listItem(itemId, amount) {
  const kioskCap = await findKioskCap().catch(() => null);

  if (kioskCap === null) {
    throw new Error('No Kiosk found for sender; use `new` to create one');
  }

  if (!isValidSuiObjectId(itemId)) {
    throw new Error('Invalid Item ID: "%s"', itemId);
  }

  const item = await provider.getObject({ id: itemId, options: { showType: true } });

  if ('error' in item || !item.data) {
    throw new Error(`Item ${itemId} not found; error: ` + item.error);
  }

  const txb = new TransactionBlock();
  const kioskArg = txb.object(kioskCap.kioskId);
  const capArg = txb.objectRef({ ...kioskCap });
  list(txb, item.data.type, kioskArg, capArg, itemId, amount);

  return sendTx(txb);
}

/**
 * Command: `delist`
 * Description: Delists an active listing in the Kiosk
 */
async function delistItem(itemId) {
  const kioskCap = await findKioskCap().catch(() => null);

  if (kioskCap === null) {
    throw new Error('No Kiosk found for sender; use `new` to create one');
  }

  if (!isValidSuiObjectId(itemId)) {
    throw new Error('Invalid Item ID: "%s"', itemId);
  }

  const item = await provider.getObject({ id: itemId, options: { showType: true } });

  if ('error' in item || !item.data) {
    throw new Error(`Item ${itemId} not found; error: ` + item.error);
  }

  const txb = new TransactionBlock();
  const kioskArg = txb.object(kioskCap.kioskId);
  const capArg = txb.objectRef({ ...kioskCap });
  delist(txb, item.data.type, kioskArg, capArg, itemId);

  return sendTx(txb);
}

/**
 * Command: `purchase`
 * Description: Purchases an item from the specified Kiosk
 *
 * TODO:
 * - add destination "kiosk" or "user" (kiosk by default)
 */
async function purchaseItem(itemId, opts) {
  const { target, kiosk: inputKioskId, env } = opts;

  if (target && target !== 'kiosk' && !isValidSuiAddress(target)) {
    throw new Error(
      'Invalid target address: "%s"; use "kiosk" if you want to store in your Kiosk',
      target,
    );
  }

  if (inputKioskId && !isValidSuiObjectId(inputKioskId)) {
    throw new Error('Invalid Kiosk ID: "%s"', inputKioskId);
  }

  if (!isValidSuiObjectId(itemId)) {
    throw new Error('Invalid Item ID: "%s"', itemId);
  }

  let kioskId = inputKioskId;

  const itemInfo = await provider.getObject({
    id: itemId,
    options: { showType: true, showOwner: true },
  });

  if ('error' in itemInfo || !itemInfo.data) {
    throw new Error(`Item ${itemId} not found; ${itemInfo.error}`);
  }

  if (!('ObjectOwner' in itemInfo.data.owner)) {
    throw new Error(`Item ${itemId} is not owned by an object`);
  }

  if (!kioskId) {
    const itemKeyId = itemInfo.data.owner.ObjectOwner;
    const itemKey = await provider.getObject({ id: itemKeyId, options: { showOwner: true } });

    if ('error' in itemKey || !itemKey.data) {
      throw new Error(`Dynamic Field ${itemId} key not found; ${itemKey.error}`);
    }

    if (!('ObjectOwner' in itemKey.data.owner)) {
      throw new Error(`Dynamic Field ${itemId} key is not owned by an object`);
    }

    kioskId = itemKey.data.owner.ObjectOwner;
  }

  const [kiosk, policies, listing] = await Promise.all([
    provider.getObject({ id: kioskId, options: { showOwner: true } }),
    queryTransferPolicy(provider, itemInfo.data.type),
    provider.getDynamicFieldObject({
      parentId: kioskId,
      name: { type: KIOSK_LISTING, value: { id: itemId, is_exclusive: false } },
    }),
  ]);

  if ('error' in listing || !listing.data) {
    throw new Error(`Item ${itemId} not listed in Kiosk ${kioskId}`);
  }

  if ('error' in kiosk || !kiosk.data) {
    throw new Error(`Kiosk ${kioskId} not found`);
  }

  if ('error' in itemInfo || !itemInfo.data) {
    throw new Error(`Item ${itemId} not found`);
  }

  if (policies.length === 0) {
    throw new Error(`No transfer policy found for type ${itemInfo.data.type}`);
  }

  const envOption = env && env == 'mainnet' ? mainnetEnvironment : testnetEnvironment;
  const price = listing.data.content.fields.value;
  const txb = new TransactionBlock();
  const fromKioskArg = txb.object(kiosk.data.objectId);
  const kioskCap = await findKioskCap().catch(() => null);

  if (kioskCap === null) {
    throw new Error(
      'No Kiosk found for sender; use `new` to create one; cannot place item to Kiosk',
    );
  }

  const ownedKiosk = kioskCap.kioskId;
  const ownedKioskCap = kioskCap.objectId;
  const { item, canTransfer } = purchaseAndResolvePolicies(
    txb,
    itemInfo.data.type,
    price,
    fromKioskArg,
    itemInfo.data.objectId,
    policies[0],
    envOption,
    { ownedKiosk, ownedKioskCap },
  );

  // For the locking policy scenario when an item needs to be locked;
  if (!canTransfer) {
    return sendTx(txb);
  }

  if (target === 'kiosk') {
    place(txb, itemInfo.data.type, ownedKiosk, ownedKioskCap, item);
  } else {
    const receiver = target || (await signer.getAddress());
    txb.transferObjects([item], txb.pure(receiver, 'address'));
  }

  return sendTx(txb);
}

/**
 * Command: `search`
 * Description: Searches for items of the specified type
 */
async function searchType(type) {
  // use known types if available;
  type = KNOWN_TYPES[type] || type;

  const [{ data: listed }, { data: delisted }, { data: purchased }] = await Promise.all([
    provider.queryEvents({
      query: { MoveEventType: `0x2::kiosk::ItemListed<${type}>` },
      limit: 1000,
    }),
    provider.queryEvents({
      query: { MoveEventType: `0x2::kiosk::ItemDelisted<${type}>` },
      limit: 1000,
    }),
    provider.queryEvents({
      query: { MoveEventType: `0x2::kiosk::ItemPurchased<${type}>` },
      limit: 1000,
    }),
  ]);

  const listings = listed
    .filter((e) => {
      const { id: itemId } = e.parsedJson;
      const timestamp = e.timestampMs;
      return !delisted.some((item) => itemId == item.parsedJson.id && timestamp < item.timestampMs);
    })
    .filter((e) => {
      const { id: itemId } = e.parsedJson;
      const timestamp = e.timestampMs;
      return !purchased.some(
        (item) => itemId == item.parsedJson.id && timestamp < item.timestampMs,
      );
    });

  console.log('- Type:', type);
  console.table(
    listings.map((e) => ({
      objectId: e.parsedJson.id,
      kiosk: formatAddress(e.parsedJson.kiosk),
      price: e.parsedJson.price,
    })),
  );
}

async function searchPolicy(type) {
  // use known types if available;
  type = KNOWN_TYPES[type] || type;

  const policies = await queryTransferPolicy(provider, type);

  if (policies.length === 0) {
    console.log(`No transfer policy found for type ${type}`);
    process.exit(0);
  }

  console.log('- Type: %s', formatType(type));
  console.table(
    policies.map((policy) => ({
      id: policy.id,
      owner: 'Shared' in policy.owner ? 'Shared' : 'Owned',
      rules: policy.rules.map((rule) => rule.split('::').slice(1).join('::')),
      balance: policy.balance,
    })),
  );
}

/**
 * Command: `withdraw`
 * Description: Withdraws funds from the Kiosk and send them to sender.
 */
async function withdrawAll() {
  const sender = await signer.getAddress();
  const kioskCap = await findKioskCap(sender).catch(() => null);
  if (kioskCap === null) {
    throw new Error('No Kiosk found for sender; use `new` to create one');
  }

  const kioskId = kioskCap.kioskId;
  const txb = new TransactionBlock();
  const kioskArg = txb.object(kioskId);
  const capArg = txb.objectRef({ ...kioskCap });
  const coin = withdrawFromKiosk(txb, kioskArg, capArg, null);

  txb.transferObjects([coin], txb.pure(sender, 'address'));
  return sendTx(txb);
}

/**
 * Command: `publisher`
 * Description: Shows the Publisher objects of the current user.
 */
async function showPublisher() {
  const sender = await signer.getAddress();
  const result = await provider.getOwnedObjects({
    owner: sender,
    filter: { StructType: '0x2::package::Publisher' },
    options: { showBcs: true },
  });

  if ('error' in result || !result.data) {
    throw new Error(`Error fetching Publisher result: ${result.error}`);
  }

  if (result.data && result.data.length === 0) {
    return console.log('No Publisher objects found for sender');
  }

  console.table(
    result.data.map((o) =>
      bcs.de(
        {
          id: 'address',
          package: 'string',
          module_name: 'string',
        },
        o.data.bcs.bcsBytes,
        'base64',
      ),
    ),
  );
}

/**
 * Find the KioskOwnerCap at the sender address.
 */
async function findKioskCap(address) {
  const sender = address || (await signer.getAddress());

  if (!isValidSuiAddress(sender)) {
    throw new Error(`Invalid address "${sender}"`);
  }

  const { kioskOwnerCaps } = await getOwnedKiosks(provider, sender);

  if (kioskOwnerCaps.length === 0) {
    throw new Error(`No Kiosk found for "${sender}"`);
  }

  return kioskOwnerCaps[0];
}

/**
 * Send the transaction and print the `object changes: created` result.
 * If there are errors, print them.
 */
async function sendTx(txb) {
  return signer
    .signAndExecuteTransactionBlock({
      transactionBlock: txb,
      options: {
        showEffects: true,
        showObjectChanges: true,
      },
    })
    .then((result) => {
      if ('errors' in result) {
        console.error('Errors found: %s', result.errors);
      } else {
        console.table(
          result.objectChanges.map((change) => ({
            objectId: change.objectId,
            type: change.type,
            sender: formatAddress(change.sender),
            objectType: formatType(change.objectType),
          })),
        );
      }
      let gas = result.effects.gasUsed;
      let total = BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate);

      console.log('Computation cost:          %s', gas.computationCost);
      console.log('Storage cost:              %s', gas.storageCost);
      console.log('Storage rebate:            %s', gas.storageRebate);
      console.log('NonRefundable Storage Fee: %s', gas.nonRefundableStorageFee);
      console.log(
        'Total Gas:                 %s SUI (%s MIST)',
        formatAmount(total),
        total.toString(),
      );
    });
}

/**
 * Shortens the type (currently, a little messy).
 */
function formatType(type) {
  let knownIdx = Object.values(KNOWN_TYPES).indexOf(type);
  if (knownIdx !== -1) {
    return Object.keys(KNOWN_TYPES)[knownIdx];
  }

  type = type.replace('0x2', '2');

  while (type.includes('0x')) {
    let pos = type.indexOf('0x');
    let addr = formatAddress(type.slice(pos, pos + 66)).replace('0x', '');
    type = type.replace(type.slice(pos, pos + 66), addr);
  }

  return '0x' + type;
}

/**
 * Formats the MIST into SUI.
 */
function formatAmount(amount) {
  if (!amount) {
    return null;
  }

  if (amount <= MIST_PER_SUI) {
    return Number(amount) / Number(MIST_PER_SUI);
  }

  let len = amount.toString().length;
  let lhs = amount.toString().slice(0, len - 9);
  let rhs = amount.toString().slice(-9);

  return Number(`${lhs}.${rhs}`);
}

process.on('uncaughtException', (err) => {
  console.error(err);
  process.exit(1);
});
