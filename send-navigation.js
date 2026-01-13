#!/usr/bin/env node

/**
 * Send navigation commands to the browser extension
 *
 * This connects to the relay and sends CDP commands
 * to navigate the browser to specific URLs
 */

const WebSocket = require('ws');

async function sendNavigationCommand(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:19988/cdp');
    let messageCount = 0;
    const messageId = Math.floor(Math.random() * 10000);

    ws.on('open', () => {
      console.log(`[${new Date().toLocaleTimeString()}] ✓ Connected to relay`);

      // Send Page.enable
      console.log(`[${new Date().toLocaleTimeString()}] → Enabling page events...`);
      ws.send(JSON.stringify({
        id: messageId,
        method: 'Page.enable'
      }));

      setTimeout(() => {
        // Send navigation command
        console.log(`[${new Date().toLocaleTimeString()}] → Sending navigation to: ${url}`);
        ws.send(JSON.stringify({
          id: messageId + 1,
          method: 'Page.navigate',
          params: { url }
        }));
      }, 300);

      // Wait for response
      setTimeout(() => {
        console.log(`[${new Date().toLocaleTimeString()}] ✓ Navigation command sent`);
        console.log(`[${new Date().toLocaleTimeString()}] ✓ Check the browser - page should be changing to: ${url}\n`);
        ws.close();
        resolve();
      }, 1000);
    });

    ws.on('message', (data) => {
      messageCount++;
      try {
        const msg = JSON.parse(data.toString());
        console.log(`[${new Date().toLocaleTimeString()}] ← Response: ${JSON.stringify(msg).substring(0, 100)}`);
      } catch (e) {
        // Silently ignore
      }
    });

    ws.on('error', (err) => {
      reject(new Error('WS error: ' + err.message));
    });

    ws.on('close', () => {
      // OK, connection closed after command sent
    });

    setTimeout(() => {
      ws.close();
      resolve();
    }, 5000);
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║  PLAYWRITER NAVIGATION COMMAND SENDER                               ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

    console.log('Usage: node send-navigation.js <URL> [<URL> ...]\n');
    console.log('Examples:');
    console.log('  node send-navigation.js https://example.com');
    console.log('  node send-navigation.js https://google.com https://github.com\n');

    console.log('This will:');
    console.log('  1. Connect to the relay on ws://localhost:19988');
    console.log('  2. Send CDP Page.enable command');
    console.log('  3. Send CDP Page.navigate to the specified URL');
    console.log('  4. The extension will forward to the browser\n');

    console.log('Make sure:');
    console.log('  1. Relay is running (npm start)');
    console.log('  2. Extension is connected (check relay output)');
    console.log('  3. Browser tab is open and visible\n');

    // Default example
    const defaultUrls = ['https://example.com', 'https://google.com'];
    console.log('Running default example with:', defaultUrls.join(', ') + '\n');

    for (const url of defaultUrls) {
      await sendNavigationCommand(url);
      await new Promise(r => setTimeout(r, 2000));
    }

    console.log('✓ All navigation commands sent!');
    console.log('✓ Check the browser to see the pages changing...\n');

  } else {
    console.log('╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║  SENDING NAVIGATION COMMANDS                                         ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

    for (const url of args) {
      try {
        await sendNavigationCommand(url);
        await new Promise(r => setTimeout(r, 1500));
      } catch (err) {
        console.error(`✗ Error navigating to ${url}:`, err.message);
      }
    }

    console.log('✓ All navigation commands sent!\n');
  }
}

main().catch(err => {
  console.error('✗ Error:', err.message);
  process.exit(1);
});
