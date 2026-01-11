const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');
const crypto = require('crypto');
const { PlaywriterRelay } = require('./relay');

/**
 * CLI interface for playwriter-nat-relay
 */
class CLI {
  static createCLI() {
    return yargs(hideBin(process.argv))
      .scriptName('playwriter-nat-relay')
      .usage('$0 <command> [options]')
      .command('serve', 'Run as relay server (default)', (yargs) => {
        return yargs
          .option('token', {
            alias: 't',
            type: 'string',
            description: 'Authentication token (auto-generated if not provided)'
          })
          .option('host', {
            type: 'string',
            default: '0.0.0.0',
            description: 'Host to bind to'
          });
      })
      .option('host', {
        alias: 'h',
        type: 'string',
        description: 'Discovery key or public key to connect to'
      })
      .option('token', {
        alias: 't',
        type: 'string',
        description: 'Authentication token'
      })
      .help('help')
      .alias('help', '?')
      .example(
        '$0 serve --token mysecret',
        'Start relay server with token'
      )
      .example(
        '$0 serve',
        'Start relay server (generates random token)'
      )
      .example(
        '$0 --host <key> --token mysecret',
        'Connect to relay server'
      )
      .argv;
  }

  static async handleServeCommand(argv) {
    const token = argv.token || crypto.randomBytes(16).toString('hex');
    if (!argv.token) {
      console.log(`Generated token: ${token}`);
    }

    const relay = new PlaywriterRelay();
    const { publicKey } = await relay.startServer(token);

    console.log(`\nRelay server started`);
    console.log(`Public key: ${publicKey.toString('hex')}`);
    console.log(`Token: ${token}\n`);
    console.log('Connect with:');
    console.log(
      `  npx playwriter-nat-relay --host ${publicKey.toString('hex')} --token ${token}`
    );
    console.log('\nPress Ctrl+C to stop.\n');

    process.on('SIGINT', () => {
      console.log('\nShutting down...');
      process.exit(0);
    });
  }

  static async handleClientCommand(argv) {
    if (!argv.host) {
      console.error('Error: --host (discovery key) is required');
      process.exit(1);
    }

    if (!argv.token) {
      console.error('Error: --token is required');
      process.exit(1);
    }

    const publicKey = Buffer.from(argv.host, 'hex');
    const relay = new PlaywriterRelay();

    try {
      await relay.connectClient(publicKey, argv.token);
    } catch (err) {
      console.error('Connection failed:', err.message);
      process.exit(1);
    }
  }

  static async main() {
    const argv = CLI.createCLI();
    const command = argv._[0];

    try {
      if (!command || command === 'serve') {
        await CLI.handleServeCommand(argv);
      } else {
        await CLI.handleClientCommand(argv);
      }
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  }
}

module.exports = CLI;
