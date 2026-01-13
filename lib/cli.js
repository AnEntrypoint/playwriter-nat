const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');
const crypto = require('crypto');
const { PlaywriterRelay } = require('./relay');

/**
 * CLI interface for playwriter-nat
 */
class CLI {
  static createCLI() {
    return yargs(hideBin(process.argv))
      .scriptName('playwriter-nat')
      .usage('$0 <command> [options]')
      .command('serve', 'Connect to relay server as MCP client', (yargs) => {
        return yargs.option('host', {
          alias: 'h',
          type: 'string',
          description: 'Relay public key to connect to',
          demandOption: true
        });
      })
      .command('$0', 'Start relay server (default)', (yargs) => {
        return yargs
          .option('host', {
            alias: 'h',
            type: 'string',
            description: 'Relay public key to connect to (client mode)'
          })
          .option('token', {
            alias: 't',
            type: 'string',
            description: 'Authentication token (auto-generated if not provided)'
          })
          .option('seed', {
            alias: 's',
            type: 'string',
            description: 'Seed for deterministic DHT key generation'
          });
      })
      .help('help')
      .alias('help', '?')
      .example('$0', 'Start relay server')
      .example('$0 --seed mypersistentkey', 'Start with persistent DHT key')
      .example('$0 serve --host <public-key>', 'Connect to relay as MCP client')
      .argv;
  }

  static async handleServeCommand(argv) {
    const token = argv.token || crypto.randomBytes(16).toString('hex');
    if (!argv.token) {
      console.log(`Generated token: ${token}`);
    }

    const seed = argv.seed || null;
    if (seed) {
      console.log(`Using seed for deterministic key generation`);
    }

    const relay = new PlaywriterRelay();

    // Setup graceful shutdown handlers
    const handleShutdown = async (signal) => {
      console.log(`\n[relay] Received ${signal}, shutting down...`);
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('SIGTERM');
      await relay.shutdown();
      process.exit(0);
    };

    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (err) => {
      console.error('[relay] Uncaught exception:', err.message);
      console.error(err.stack);
      relay.shutdown().finally(() => process.exit(1));
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      console.error('[relay] Unhandled rejection:', reason);
      relay.shutdown().finally(() => process.exit(1));
    });

    try {
      const result = await relay.startServer(token, 'localhost', seed);
      const publicKey = typeof result === 'string' ? result : result.publicKey;
      const port = typeof result === 'object' ? result.port : 19988;

      console.log(`\nRelay server started`);
      console.log(`Public key: ${publicKey}`);
      console.log(`Port: ${port}\n`);
      console.log('Connect with:');
      console.log(
        `  npx -y gxe@latest AnEntrypoint/playwriter-nat serve --host ${publicKey}`
      );
      console.log('e.g.:');
      console.log(
        `  claude mcp add -s user playwriter npx -- -y gxe@latest AnEntrypoint/playwriter-nat serve --host ${publicKey}`
      );
      console.log('\nPress Ctrl+C to stop.\n');
    } catch (err) {
      console.error('[relay] Failed to start:', err.message);
      await relay.shutdown();
      process.exit(1);
    }
  }

  static async handleClientCommand(argv) {
    if (!argv.host) {
      console.error('Error: --host (public key) is required');
      process.exit(1);
    }

    const publicKey = Buffer.from(argv.host, 'hex');
    const relay = new PlaywriterRelay();

    // Handle uncaught exceptions
    process.on('uncaughtException', (err) => {
      console.error('[client] Uncaught exception:', err.message);
      console.error(err.stack);
      relay.shutdown?.().finally(() => process.exit(1));
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      console.error('[client] Unhandled rejection:', reason);
      relay.shutdown?.().finally(() => process.exit(1));
    });

    try {
      await relay.connectClient(publicKey);
    } catch (err) {
      console.error('[client] Connection failed:', err.message);
      process.exit(1);
    }
  }

  static async main() {
    const argv = CLI.createCLI();

    try {
      const isServeCommand = argv._ && argv._[0] === 'serve';
      if (isServeCommand || argv.host) {
        await CLI.handleClientCommand(argv);
      } else {
        await CLI.handleServeCommand(argv);
      }
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  }
}

module.exports = CLI;
