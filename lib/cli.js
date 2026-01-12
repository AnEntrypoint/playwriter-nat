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
      .usage('$0 [options]')
      .option('host', {
        alias: 'h',
        type: 'string',
        description: 'Relay public key to connect to (client mode). If not set, runs as relay server'
      })
      .option('token', {
        alias: 't',
        type: 'string',
        description: 'Authentication token (auto-generated if not provided, server mode only)'
      })
      .option('seed', {
        alias: 's',
        type: 'string',
        description: 'Seed for deterministic DHT key generation (server mode only, enables key persistence across restarts)'
      })
      .help('help')
      .alias('help', '?')
      .example(
        '$0',
        'Start relay server (generates random token and temporary key)'
      )
      .example(
        '$0 --token mysecret',
        'Start relay server with specific token'
      )
      .example(
        '$0 --seed mypersistentkey',
        'Start relay server with persistent DHT key (same seed = same public key on restart)'
      )
      .example(
        '$0 --host <public-key>',
        'Connect to relay server'
      )
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
      if (argv.host) {
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
