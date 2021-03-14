const path = require('path');
const fs = require('fs');
const _ = require('lodash');
const Bluebird = require('bluebird');
const web3Util = require('web3-utils');
const chalk = require('chalk');
const debug = require('debug')('dotcli');
const stringify = require('fast-safe-stringify');

const configureWeb3 = require('dot-abi-cli').configureWeb3;

exports.command = 'sync-products';
exports.desc = `Create or update products described in a file`;
exports.builder = function(yargs) {
  yargs
    .option('products', {
      type: 'string'
    })
    .demandOption(
      'products',
      'Please provide a path to the file that describes your products'
    )
    .coerce('products', function(arg) {
      return require(arg);
    })
    .option('inventory', {
      description: 'sync inventory levels',
      type: 'boolean',
      default: false
    });
  return yargs;
};

exports.handler = async function(argv) {
  const { web3 } = await configureWeb3(argv);

  // TODO -- we do this a lot, abstract out
  const combinedAbiFle = path.join(
    __dirname,
    '..',
    '..',
    'dot-license.abi.json'
  );
  const combined = JSON.parse(fs.readFileSync(combinedAbiFle));
  let contracts = _.reduce(
    combined.contracts,
    (acc, attributes, rawName) => {
      if (attributes.abi) {
        let name = rawName.split(':')[1];
        acc[name] = {
          abi: JSON.parse(attributes.abi),
          devdoc: JSON.parse(attributes.devdoc),
          userdoc: JSON.parse(attributes.userdoc)
        };
      }
      return acc;
    },
    {}
  );

  const contract = new web3.eth.Contract(
    contracts.LicenseCore.abi,
    argv.contractAddress
  );

  const products = argv.products(argv, require);

  console.log(`Syncing ${products.length} products...`);

  const haveProduct = productInfo => {
    const p = productInfo;
    return (
      p['0'] !== '0' ||
      p['1'] !== '0' ||
      p['2'] !== '0' ||
      p['3'] !== '0' ||
      p['4'] !== false
    );
  };

  const handleResponse = response => {
    return new Promise(function(resolve, reject) {
      let timeout;

      return response
        .once('transactionHash', function(hash) {
          console.log(`Transaction: ${chalk.yellow(hash)}`);
          timeout = setTimeout(
            () => reject(new Error(`Timeout: waiting for receipt of ${hash}.`)),
            30 * 1000
          );
        })
        .once('receipt', function(receipt) {
          console.log('Receipt:', chalk.green(stringify(receipt, null, 2)));
          clearTimeout(timeout);
          return resolve(receipt);
        })
        .once('error', function(error) {
          console.log(chalk.red('Error:'), error);
          clearTimeout(timeout);
          return reject(error);
        });
    });
  };

  const handleWrite = async (functionName, transactionArguments) => {
    const accounts = await web3.eth.getAccountsAsync();
    const from = argv.from || accounts[0];

    // build sendOpts
    const sendOpts = {
      from
    };

    if (argv.gasPrice) sendOpts.gasPrice = argv.gasPrice;
    if (argv.gasLimit) sendOpts.gas = argv.gasLimit;
    if (argv.value) sendOpts.value = argv.value;

    if (argv.ledger) {
      console.log(
        chalk.yellow('Please confirm transaction on device:'),
        stringify(
          _.merge(
            {
              method: functionName,
              args: transactionArguments
            },
            sendOpts
          ),
          null,
          2
        )
      );
    }
    // debug(`${functionName}: ${JSON.stringify(transactionArguments, null, 2)}`);
    const response = contract.methods[functionName](
      ...transactionArguments
    ).send(sendOpts);
    return handleResponse(response);
  };

  const createProduct = async product => {
    console.log(chalk.blue('Creating'), product);
    const transactionArguments = [
      product.productId,
      product.price,
      product.initialInventoryQuantity,
      product.supply,
      product.interval
    ];
    await handleWrite('createProduct', transactionArguments);
  };

  const updateProduct = async (product, existingProductInfo) => {
    // The two things that can be changed are: 1) price and 2) renewable
    let neededUpdate = false;

    // Check price
    if (product.price.toString() !== existingProductInfo['0'].toString()) {
      neededUpdate = true;

      console.log(chalk.blue('Updating price for'), product);
      const transactionArguments = [product.productId, product.price];
      await handleWrite('setPrice', transactionArguments);
    }

    // Check renewable
    if (product.renewable !== existingProductInfo['4']) {
      console.log('existingProductInfo', existingProductInfo);
      neededUpdate = true;

      console.log(chalk.blue('Updating renewable for'), product);
      const transactionArguments = [product.productId, product.renewable];
      await handleWrite('setRenewable', transactionArguments);
    }

    if (
      argv.inventory &&
      _.isNumber(product.inventory) &&
      product.inventory.toString() != existingProductInfo['1'].toString()
    ) {
      neededUpdate = true;
      const wanted = product.inventory;
      const actual = parseInt(existingProductInfo['1']); // careful about overflows
      const difference = wanted - actual;
      const incrementing = difference > 0;

      if (incrementing) {
        console.log(chalk.blue(`Adding ${difference} inventory for`), product);
        const transactionArguments = [product.productId, difference];
        await handleWrite('incrementInventory', transactionArguments);
      } else {
        console.log(
          chalk.blue(`Removing ${difference * -1} inventory for`),
          product
        );
        const transactionArguments = [product.productId, difference * -1];
        await handleWrite('decrementInventory', transactionArguments);
      }
    }

    if (!neededUpdate) {
      console.log(
        chalk.green(
          `Product ${product.productId} ${product.name} is up-to-date`
        )
      );
    }
  };

  const syncProduct = async product => {
    const existingProductInfo = await contract.methods
      .productInfo(product.productId)
      .call();

    if (haveProduct(existingProductInfo)) {
      try {
        await updateProduct(product, existingProductInfo);
      } catch (err) {
        console.log(product, existingProductInfo, err);
      }
    } else {
      await createProduct(product);
    }
  };

  await Bluebird.mapSeries(products, product => syncProduct(product));
};
