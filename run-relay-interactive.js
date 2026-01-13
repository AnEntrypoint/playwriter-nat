#!/usr/bin/env node

/**
 * Interactive relay server that monitors extension connection and activity
 *
 * This server:
 * 1. Starts MinimalServe on an available port
 * 2. Monitors when the extension connects
 * 3. Logs all CDP commands and responses in real-time
 * 4. Shows active connections
 */

const { PlaywriterRelay } = require('./lib/relay');
const crypto = require('crypto');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

let relay = null;
let serverRunning = false;

async function startServer() {
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║  PLAYWRITER RELAY SERVER - INTERACTIVE MODE                     ║');
  console.log('║  Waiting for browser extension to connect...                    ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  relay = new PlaywriterRelay();
  const token = crypto.randomBytes(16).toString('hex');
  const seed = process.argv[2] || 'playwriter-' + Date.now();

  try {
    const result = await relay.startServer(token, 'localhost', seed);
    serverRunning = true;

    console.log('\n✓ SERVER READY\n');
    console.log(`  Port: ${result.port}`);
    console.log(`  Relay listening on: ws://localhost:${result.port}\n`);

    console.log('INSTRUCTIONS:\n');
    console.log('1. Open Playwriter browser extension in Chrome');
    console.log('2. Click on a tab you want to control');
    console.log('3. Extension will auto-connect to ws://localhost:' + result.port + '/extension');
    console.log('4. This console will show connection status and commands\n');

    console.log('MONITORING EXTENSION STATUS:\n');

    // Monitor extension connection
    const checkInterval = setInterval(() => {
      const hasExtension = relay.minimalServe?.extensionSocket !== null &&
                          relay.minimalServe?.extensionSocket !== undefined;

      if (hasExtension) {
        console.log(`[${new Date().toLocaleTimeString()}] ✓ Extension CONNECTED`);
        console.log(`  Active clients: ${relay.clients.size}`);
        console.log(`  Open MCP connections: ${relay.minimalServe.mcpClients.size}`);

        if (relay.minimalServe.extensionSocket.readyState === 1) {
          console.log(`  Extension socket state: OPEN\n`);
        }

        clearInterval(checkInterval);

        // Once extension is connected, monitor its activity
        monitorExtensionActivity(relay, result.port);
      }
    }, 1000);

    // Cleanup on exit
    process.on('SIGINT', async () => {
      console.log('\n\n[*] Shutting down...');
      clearInterval(checkInterval);
      if (relay) {
        await relay.shutdown().catch(() => {});
      }
      process.exit(0);
    });

  } catch (err) {
    console.error('✗ Failed to start relay:', err.message);
    process.exit(1);
  }
}

function monitorExtensionActivity(relay, port) {
  console.log('═══════════════════════════════════════════════════════════════════\n');
  console.log('EXTENSION ACTIVITY LOG\n');

  const originalExtensionHandleMessage = relay.minimalServe.extensionSocket?.on;
  const originalSend = relay.minimalServe.extensionSocket?.send;

  // Override message handler to log
  if (relay.minimalServe.extensionSocket) {
    relay.minimalServe.extensionSocket.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Log incoming messages
        const timestamp = new Date().toLocaleTimeString();
        if (msg.method) {
          console.log(`[${timestamp}] ← COMMAND: ${msg.method}`);
          if (msg.params) {
            console.log(`           Parameters: ${JSON.stringify(msg.params).substring(0, 80)}`);
          }
        } else if (msg.result) {
          console.log(`[${timestamp}] ← RESPONSE (id=${msg.id}): Success`);
        } else if (msg.error) {
          console.log(`[${timestamp}] ← ERROR (id=${msg.id}): ${msg.error.message}`);
        }
      } catch (e) {
        // Ignore parse errors
      }
    });
  }

  console.log(`\nRelay is monitoring extension on port ${port}`);
  console.log('All CDP commands will be logged above as they arrive.\n');
}

startServer().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

// Prevent process from exiting
rl.on('line', () => {
  // Just keep running
});
