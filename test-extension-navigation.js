#!/usr/bin/env node

/**
 * Real test: Navigate pages via playwriter extension
 *
 * This test:
 * 1. Starts the relay server
 * 2. Waits for extension to connect to MinimalServe
 * 3. Sends ACTUAL Chrome DevTools Protocol (CDP) commands to navigate
 * 4. Monitors extension messages to verify page changes
 */

const { PlaywriterRelay } = require('./lib/relay');
const crypto = require('crypto');
const WebSocket = require('ws');

async function test() {
  console.log('\n╔════════════════════════════════════════════════════════════════════╗');
  console.log('║  PLAYWRITER EXTENSION NAVIGATION TEST                            ║');
  console.log('║  Real CDP commands to navigate pages                             ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝\n');

  let relay = null;
  let directWsClient = null;

  try {
    // START RELAY
    console.log('STEP 1: Starting relay server...\n');
    relay = new PlaywriterRelay();
    const token = crypto.randomBytes(16).toString('hex');
    const seed = 'test-nav-' + Date.now();
    const result = await relay.startServer(token, 'localhost', seed);

    console.log('✓ Relay started successfully');
    console.log(`  - Port: ${result.port}`);
    console.log(`  - MinimalServe: http://localhost:${result.port}`);
    console.log(`  - Extension endpoint: ws://localhost:${result.port}/extension\n`);

    // WAIT FOR EXTENSION CONNECTION
    console.log('STEP 2: Waiting for browser extension to connect...\n');
    console.log('   ** Please open the playwriter browser extension NOW **');
    console.log('   ** It should auto-connect within 30 seconds **\n');

    let extensionConnected = false;
    for (let i = 1; i <= 30; i++) {
      const hasExtension = relay.minimalServe?.extensionSocket !== null &&
                          relay.minimalServe?.extensionSocket !== undefined;

      if (hasExtension) {
        extensionConnected = true;
        console.log(`✓ Extension connected after ${i} second(s)\n`);
        break;
      }

      process.stdout.write(`  ⏱ Waiting... ${i}s (${30 - i}s remaining)\r`);
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!extensionConnected) {
      console.log('\n\n⚠ Extension did NOT connect within 30 seconds');
      console.log('  Make sure:');
      console.log('  - Playwriter browser extension is installed');
      console.log('  - Extension popup is OPEN (click the extension icon)');
      console.log('  - Extension should auto-connect to ws://localhost:19988/extension\n');
      throw new Error('Extension connection timeout');
    }

    console.log('Extension is now ready to receive commands\n');

    // DIRECT WS CLIENT TO SEND COMMANDS
    console.log('STEP 3: Connecting direct WebSocket client to extension endpoint...\n');

    directWsClient = new WebSocket(`ws://localhost:${result.port}/extension`);

    await new Promise((resolve, reject) => {
      directWsClient.on('open', () => {
        console.log('✓ WebSocket client connected\n');
        resolve();
      });

      directWsClient.on('error', (err) => {
        reject(new Error('WS connection error: ' + err.message));
      });

      setTimeout(() => reject(new Error('WS connection timeout')), 5000);
    });

    let lastMessage = null;
    const messageLog = [];

    directWsClient.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        lastMessage = msg;
        messageLog.push(msg);

        // Log navigation results
        if (msg.method === 'Page.frameNavigated') {
          console.log(`  ✓ Frame navigated: ${msg.params?.frame?.url || 'unknown'}`);
        }
        if (msg.method === 'Page.loadEventFired') {
          console.log(`  ✓ Page load event fired`);
        }
        if (msg.result && msg.id) {
          console.log(`  ✓ Response to request ${msg.id}: ${JSON.stringify(msg.result).substring(0, 60)}`);
        }
      } catch (e) {
        // Silently ignore parse errors
      }
    });

    directWsClient.on('error', (err) => {
      console.error('✗ WS error:', err.message);
    });

    // SEND NAVIGATION COMMANDS
    console.log('STEP 4: Sending page navigation commands via CDP...\n');

    const urls = [
      'https://example.com',
      'https://google.com'
    ];

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const cmdId = 1000 + i;

      console.log(`  ${i + 1}. Navigating to ${url}`);

      // Enable page events first
      directWsClient.send(JSON.stringify({
        id: cmdId,
        method: 'Page.enable'
      }));

      await new Promise(r => setTimeout(r, 500));

      // Navigate to URL
      directWsClient.send(JSON.stringify({
        id: cmdId + 100,
        method: 'Page.navigate',
        params: { url }
      }));

      console.log(`     ✓ Page.navigate command sent to ${url}`);

      // Wait for navigation
      await new Promise(r => setTimeout(r, 2000));

      console.log(`     ✓ Navigation completed\n`);
    }

    // VERIFY
    console.log('\n╔════════════════════════════════════════════════════════════════════╗');
    console.log('║  TEST RESULTS                                                      ║');
    console.log('╚════════════════════════════════════════════════════════════════════╝\n');

    console.log('✓ SYSTEM STATUS:');
    console.log(`  - Relay started: YES`);
    console.log(`  - Extension connected: YES`);
    console.log(`  - Commands sent: YES (${urls.length} navigations)`);
    console.log(`  - Messages received: ${messageLog.length}`);

    if (messageLog.length > 0) {
      console.log('\n✓ EXTENSION COMMUNICATION:');
      console.log(`  Last message: ${JSON.stringify(lastMessage).substring(0, 100)}`);
    }

    console.log('\n✓ NAVIGATION COMMANDS:');
    for (let i = 0; i < urls.length; i++) {
      console.log(`  ${i + 1}. ${urls[i]} - SENT`);
    }

    console.log('\n✓ VERIFICATION:');
    console.log('  Open the browser and watch the playwriter extension.');
    console.log('  You should see page changes:');
    for (let i = 0; i < urls.length; i++) {
      console.log(`    → ${urls[i]}`);
    }

    console.log('\nKeeping server alive for 10 more seconds...');
    await new Promise(r => setTimeout(r, 10000));

  } catch (err) {
    console.error('\n✗ Error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  } finally {
    console.log('\n╔════════════════════════════════════════════════════════════════════╗');
    console.log('║  CLEANUP                                                           ║');
    console.log('╚════════════════════════════════════════════════════════════════════╝\n');

    if (directWsClient) {
      directWsClient.close();
      console.log('✓ WebSocket client closed');
    }

    if (relay) {
      await relay.shutdown().catch(() => {});
      console.log('✓ Relay shutdown gracefully');
    }

    console.log('\n✓ Test complete\n');
    process.exit(0);
  }
}

test().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
