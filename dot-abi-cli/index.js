const debug = require('debug')('dotcli');
const fs = require('fs');
const Bluebird = require('bluebird');
const _ = require('lodash');
const stringify = require('fast-safe-stringify');
const chalk = require('chalk');
const FauxSubscriptionSubprovider = require('./lib/FauxSubscriptionSubprovider');
let _engine;
const configure = require('./lib/config');

const handleResponse = (response, argv, abi, functionAbi) => {
  // TODO, convert this to a promise like:
  // return new Promise(function(resolve, reject) {...})
  return response
    .once('transactionHash', function(hash) {
      console.log('transactionHash', hash);
    })
    .once('receipt', function(receipt) {
      console.log('receipt once', receipt);
    })
    .once('confirmation', function(confNumber, receipt) {
      console.log('Confirmation', confNumber);
      console.log('Blockhash', receipt.blockHash);
      console.log('Receipt', receipt);

      if (_.get(receipt, ['events'])) {
        console.log('Events', stringify(receipt.events, null, 2));
      }

      // TODO, bubble this up
      process.exit(0);
    })
    .on('error', function(error) {
      console.log('error', error);
    });
};

const handleRead = async (argv, abi, functionAbi, web3) => {
  const contract = new web3.eth.Contract(abi, argv.contractAddress);
  const transactionArguments = (functionAbi.inputs || []).map(
    input => argv[input.name]
  );
  const response = await contract.methods[functionAbi.name](
    ...transactionArguments
  ).call();
  console.log(response);
};

const handleWrite = async (argv, abi, functionAbi, web3) => {
  const contract = new web3.eth.Contract(abi, argv.contractAddress);

  const accounts = await web3.eth.getAccountsAsync();
  const from = argv.from || accounts[0];
  const transactionArguments = (functionAbi.inputs || []).map(
    input => argv[input.name]
  );

  // build sendOpts
  const sendOpts = {
    from,
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
            method: functionAbi.name,
            args: transactionArguments,
          },
          sendOpts
        ),
        null,
        2
      )
    );
  }
  const response = contract.methods[functionAbi.name](
    ...transactionArguments
  ).send(sendOpts);
  return handleResponse(response);
};

const buildAbiCommands = (yargs, pathToFile, opts) => {
  let combined = JSON.parse(fs.readFileSync(pathToFile));

  let contracts = _.reduce(
    combined.contracts,
    (acc, attributes, rawName) => {
      if (attributes.abi) {
        let name = rawName.split(':')[1];
        acc[name] = {
          abi: JSON.parse(attributes.abi),
          devdoc: JSON.parse(attributes.devdoc),
          userdoc: JSON.parse(attributes.userdoc),
        };
      }
      return acc;
    },
    {}
  );

  const sanitizeParam = p => p.replace(/^_/, '');
  const sp = sanitizeParam;

  const docName = iface => {
    const argumentTypes = iface.inputs.map(i => i.type);
    return iface.name + '(' + argumentTypes.join(',') + ')';
  };

  const buildCommands = (contract, opts = {}) => {
    let abiFunctions = contract.abi
      .filter(iface => iface.type === 'function')
      .filter(iface => !_.get(opts, ['methods', docName(iface), 'skip']));

    _.sortBy(abiFunctions, 'name').forEach(iface => {
      const userdoc =
        _.get(contract.userdoc, ['methods', docName(iface)]) ||
        _.get(opts, ['methods', docName(iface), 'userdoc']);
      const devdoc = _.get(contract.devdoc, ['methods', docName(iface)], {});

      // doc required
      if (!userdoc) {
        debug('no userdoc for ' + iface.name);
        return;
      }

      let commandConfigurationOpts = _.get(opts, ['methods', docName(iface)]);

      let positionalArgumentsString = iface.inputs
        .map(p => `<${sp(p.name)}>`)
        .join(' ');
      let commandString = _.compact([
        iface.name,
        positionalArgumentsString,
      ]).join(' ');

      yargs.command(
        commandString,
        userdoc.notice,
        yargs => {
          iface.inputs.forEach(input => {
            const description = _.get(devdoc, ['params', sp(input.name)]);
            yargs.positional(sp(input.name), {
              describe: description,
            });
            yargs.demand(sp(input.name));
            if (input.name != sp(input.name)) {
              yargs.alias(sp(input.name), input.name);
            }
            // TODO add:
            // * type parsing
            // * input validation (addresses)
          });
          if (iface.payable) {
            yargs.demand('value');
          }
          if (_.get(commandConfigurationOpts, 'dangerous')) {
            const confirmationOptionName = `yes-im-sure-${iface.name}`;
            yargs.option(confirmationOptionName, {
              type: 'boolean',
              demandOption: true,
              default: undefined,
            });
            yargs.demandOption(
              confirmationOptionName,
              `${
                iface.name
              } is dangerous, pass --${confirmationOptionName} if you're absolutely sure you want to do this`
            );
          }
        },
        async argv => {
          debug(stringify(argv, null, 2));
          debug(stringify(iface, null, 2));

          const { web3 } = await configure(argv, opts);

          if (iface.constant) {
            await handleRead(argv, contract.abi, iface, web3);
          } else {
            await handleWrite(argv, contract.abi, iface, web3);
          }
          // _engine.stop();
        }
      );
    });
  };

  const buildCommandsFor = opts.contracts
    ? _.values(_.pick(contracts, opts.contracts))
    : _.values(contracts);
  buildCommandsFor.forEach(c => buildCommands(c, opts));

  return yargs;
};

function buildDefaultOptions(yargs, pathToCombinedAbiFile, opts) {
  return (
    yargs
      .usage('Usage: $0 <command> [options]')
      .describe('web3', 'web3 provider url')
      .default('web3', process.env.WEB3_PROVIDER_URL || 'http://localhost:8545')
      .option('from', { description: 'from address' })
      .option('gasPrice', {
        description: 'gas price in wei to use for this transaction',
        default: process.env.GAS_PRICE,
      })
      .option('gasLimit', {
        description: 'maximum gas provided for this transaction',
        default: process.env.GAS_LIMIT,
      })
      .option('value', {
        description: 'The value transferred for the transaction in wei',
      })
      .describe('contract-address', 'address to contract')
      // .demand('contract-addresss') // hmm this is demanded, but the ordering is difficult
      .option('network-id', {
        description: 'The network ID',
        default: process.env.NETWORK_ID,
      })
      .option('ledger', {
        description: 'use a ledger',
        default: process.env.USE_LEDGER,
      })
      .boolean('ledger')
      .option('hd-path', {
        description: 'hd-path (used for hardware wallets)',
        default: "44'/60'/0'/0",
      })
      // .option('hardware-confirm', {
      //   description: 'when using a hardware wallet, ask for on-device confirmation',
      //   default: true
      // })
      // .boolean('hardware-confirm')
      .demandCommand()
      .help()
      .version()
  );
}

const dotAbiCli = (yargs, pathToCombinedAbiFile, opts) => {
  let builder = buildDefaultOptions(yargs, pathToCombinedAbiFile, opts);
  return buildAbiCommands(builder, pathToCombinedAbiFile, opts);
};

dotAbiCli.configureWeb3 = configure;

module.exports = dotAbiCli;
