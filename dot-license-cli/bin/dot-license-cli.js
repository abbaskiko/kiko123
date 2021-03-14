const path = require('path');
const yargs = require('yargs');
const dotAbiCli = require('dot-abi-cli');
const HDWalletProvider = require('truffle-hdwallet-provider');
const NonceTrackerSubprovider = require('web3-provider-engine/subproviders/nonce-tracker');

require('../lib/config');

let dotAbiCliConfig = {
  contracts: ['LicenseCore'],
  methods: {
    'setCEO(address)': {
      // skip: true
      dangerous: true,
    },
    'setNewAddress(address)': {
      // skip: true
      dangerous: true,
    },
    'ceoAddress()': {
      userdoc: {
        notice: "Get the CEO's Address",
      },
    },
    'cfoAddress()': {
      userdoc: {
        notice: "Get the CFO's Address",
      },
    },
    'unpause()': { userdoc: { notice: 'Unpause the contract' } },
    'paused()': {
      userdoc: { notice: 'Checks if the contract is paused' },
    },
    'newContractAddress()': {
      userdoc: { notice: 'Gets the new contract address' },
    },
    'setNewAddress(address)': {
      userdoc: { notice: 'Sets a new contract address' },
      dangerous: true,
    },
    'products()': { userdoc: { notice: 'Gets the products' } },
    'cooAddress()': { userdoc: { notice: 'Get the COOs address' } },
    'affiliateProgram()': {
      userdoc: { notice: 'Get the affiliate program address' },
    },
    'allProductIds()': { userdoc: { notice: 'Get all product ids' } },
    'withdrawalAddress()': {
      userdoc: { notice: 'Get the withdrawal address' },
    },
    'createPromotionalPurchase(uint256,uint256,address,uint256)': {
      userdoc: { notice: 'Creates a promotional purchase' },
    },
  },
};

let builder = dotAbiCli(
  yargs,
  path.join(__dirname, '..', 'lib', 'dot-license.abi.json'),
  dotAbiCliConfig
);

builder = builder
  .default('contract-address', process.env.LICENSE_CORE_ADDRESS)
  .demand('contract-address')
  .commandDir(path.join(__dirname, '..', 'lib', 'cmds', 'license'))
  .wrap(yargs.terminalWidth());

if (process.env.KEY_MNEMONIC) {
  let provider = new HDWalletProvider(
    process.env.KEY_MNEMONIC,
    process.env.WEB3_PROVIDER_URL,
    process.env.HD_KEY_IDX ? parseInt(process.env.HD_KEY_IDX) : 0
  );
  provider.engine.addProvider(new NonceTrackerSubprovider());
  builder
    .option('provider', {
      hidden: true,
    })
    .default('provider', provider, '(provider)');
}

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

builder.argv;
