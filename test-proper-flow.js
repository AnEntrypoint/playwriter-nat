#!/usr/bin/env node

/**
 * Test proper message flow:
 * 1. Verify extension is connected
 * 2. Send navigation via MCP /cdp endpoint
 * 3. Monitor extension responses
 */

const WebSocket = require('ws');

async function test() {
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  TESTING PROPER MESSAGE FLOW                                         ║');
  console.log('║  MCP Client (/cdp) → Relay → Extension (/extension)                ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  // Step 1: Monitor extension
  console.log('STEP 1: Monitoring extension connection\n');

  let extensionSocket = null;
  let extensionMessages = [];

  // Create a listener that acts like an extension
  const serverWs = require('ws').Server;

  // Instead, let's just directly observe what's happening
  console.log('Connecting as MCP client to /cdp endpoint...\n');

  const mcpClient = new WebSocket('ws://localhost:19988/cdp');
  let mcpConnected = false;

  mcpClient.on('open', () => {
    mcpConnected = true;
    console.log('✓ MCP client connected to /cdp\n');

    // Send command
    console.log('[' + new Date().toLocaleTimeString() + '] Sending Page.navigate command\n');

    const cmd = {
      id: 1,
      method: 'Page.navigate',
      params: { url: 'https://example.com' }
    };

    mcpClient.send(JSON.stringify(cmd));
    console.log('  → ' + JSON.stringify(cmd));
  });

  mcpClient.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log('\n[' + new Date().toLocaleTimeString() + '] Response from extension:\n  ← ' + JSON.stringify(msg));
    } catch (e) {
      // Ignore
    }
  });

  mcpClient.on('error', (err) => {
    console.error('✗ MCP error:', err.message);
  });

  mcpClient.on('close', () => {
    console.log('\n[' + new Date().toLocaleTimeString() + '] MCP client disconnected');
  });

  // Wait and observe
  await new Promise(r => setTimeout(r, 5000));

  console.log('\n═══════════════════════════════════════════════════════════════════════\n');
  console.log('ANALYSIS:\n');

  if (mcpConnected) {
    console.log('✓ MCP client successfully connected to relay');
    console.log('✓ Navigation command sent via /cdp endpoint');
    console.log('✓ This should have been forwarded to extension on /extension\n');

    console.log('Possible issues:');
    console.log('  1. Extension might be disconnecting after receiving command');
    console.log('  2. Extension might not be sending response back');
    console.log('  3. Extension might be in a different state\n');

    console.log('Check relay logs for:');
    console.log('  [minimal-serve] Chrome extension connected');
    console.log('  [cdp:xxx→serve] Page.navigate');
    console.log('  [extension→serve] response with result\n');
  }

  mcpClient.close();
}

test().catch(console.error);
