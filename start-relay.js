#!/usr/bin/env node

/**
 * Clean relay server starter
 * Starts on port 19988 (default) and waits for extension
 * Shows real-time activity logs
 */

const { PlaywriterRelay } = require('./lib/relay');
const crypto = require('crypto');

async function main() {
  console.clear();
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  PLAYWRITER RELAY SERVER                                             ║');
  console.log('║  Browser Extension ←→ Navigation Commands                           ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  const relay = new PlaywriterRelay();
  const token = crypto.randomBytes(16).toString('hex');

  let extensionConnected = false;
  let navigationsSent = 0;

  try {
    // Start server
    console.log('Starting relay server...\n');
    const result = await relay.startServer(token, 'localhost', 'playwriter');

    console.log(`✓ Server started on port ${result.port}`);
    console.log(`✓ Extension should connect to: ws://localhost:${result.port}/extension\n`);

    // Monitor extension connection
    console.log('═══════════════════════════════════════════════════════════════════════\n');
    console.log('WAITING FOR BROWSER EXTENSION...\n');
    console.log('Instructions:');
    console.log('  1. Open Chrome browser');
    console.log('  2. Click the Playwriter extension icon (top right)');
    console.log('  3. Click on a tab you want to navigate');
    console.log('  4. Extension will auto-connect and appear here\n');

    let statusShown = false;

    const checkInterval = setInterval(() => {
      const hasExtension = relay.minimalServe?.extensionSocket !== null &&
                          relay.minimalServe?.extensionSocket !== undefined;

      if (hasExtension && !statusShown) {
        statusShown = true;
        clearInterval(checkInterval);
        console.log('═══════════════════════════════════════════════════════════════════════\n');
        console.log(`✓ EXTENSION CONNECTED at ${new Date().toLocaleTimeString()}\n`);
        showRelayStatus(relay);
        showRealTimeMonitor(relay);
      }
    }, 500);

    // Keep server running
    process.on('SIGINT', async () => {
      console.log('\n\n[*] Shutting down relay...');
      clearInterval(checkInterval);
      await relay.shutdown().catch(() => {});
      process.exit(0);
    });

  } catch (err) {
    console.error('\n✗ Error:', err.message);
    process.exit(1);
  }
}

function showRelayStatus(relay) {
  console.log('RELAY STATUS:');
  console.log(`  Extension connected: ${relay.minimalServe?.extensionSocket ? 'YES' : 'NO'}`);
  console.log(`  Active clients: ${relay.clients.size}`);
  console.log(`  MCP connections: ${relay.minimalServe.mcpClients.size}\n`);
}

function showRealTimeMonitor(relay) {
  console.log('═══════════════════════════════════════════════════════════════════════\n');
  console.log('REAL-TIME ACTIVITY MONITOR\n');
  console.log('Watch for:');
  console.log('  [extension→serve] = Commands from extension');
  console.log('  [serve→client] = Responses to clients\n');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  // Set up activity monitoring
  const originalExtensionHandlers = relay.minimalServe.extensionSocket?.listeners('message');

  relay.minimalServe.extensionSocket?.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const ts = new Date().toLocaleTimeString();

      if (msg.method) {
        console.log(`[${ts}] ← ${msg.method}`);

        // Watch for navigation
        if (msg.method === 'Page.navigate') {
          const url = msg.params?.url || 'unknown';
          console.log(`         ✓ PAGE NAVIGATION COMMAND: ${url}`);
        }
        if (msg.method === 'Page.enable') {
          console.log(`         → Enabling page events`);
        }
      } else if (msg.result || msg.error) {
        console.log(`[${ts}] ← Response (id=${msg.id})`);

        if (msg.result?.frameId) {
          console.log(`         ✓ Frame navigated: ${msg.result.frameId}`);
        }
      }
    } catch (e) {
      // Silently ignore
    }
  });

  console.log('Waiting for extension commands...\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
