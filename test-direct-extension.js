const WebSocket = require('ws');

async function test() {
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  DIRECT EXTENSION TEST - SEND COMMANDS VIA /extension ENDPOINT     ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  const ws = new WebSocket('ws://localhost:19988/extension');
  let messageLog = [];

  ws.on('open', () => {
    console.log('✓ Connected to /extension endpoint\n');

    // Send navigation command directly to extension
    const cmd = {
      id: 1,
      method: 'Page.navigate',
      params: { url: 'https://example.com' }
    };

    console.log(`[${new Date().toLocaleTimeString()}] → Sending navigation command`);
    console.log(`  Method: ${cmd.method}`);
    console.log(`  URL: ${cmd.params.url}\n`);

    ws.send(JSON.stringify(cmd));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      messageLog.push(msg);
      console.log(`[${new Date().toLocaleTimeString()}] ← Received response`);
      console.log(`  Message: ${JSON.stringify(msg).substring(0, 120)}\n`);
    } catch (e) {
      // Ignore
    }
  });

  ws.on('error', (err) => {
    console.error('✗ Error:', err.message);
  });

  await new Promise(r => setTimeout(r, 3000));

  console.log(`✓ Test complete - received ${messageLog.length} messages`);
  ws.close();
}

test().catch(console.error);
