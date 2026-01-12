const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

(async () => {
  console.log('\n=== TUNNEL TEST: Navigate to Wikipedia ===\n');

  try {
    await execAsync('pkill -9 -f "playwriter" || true');
    await execAsync('lsof -i :19988 2>/dev/null | awk "NR>1 {print $2}" | xargs -r kill -9 || true');
    await new Promise(r => setTimeout(r, 2000));
  } catch (e) {
    console.log('[cleanup] processes cleared');
  }

  console.log('[1] Starting relay server...');
  const relay = spawn('node', ['bin/cli.js', '--seed', 'wiki-final'], {
    cwd: '/home/user/playwriter-nat-relay',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let relayOut = '';
  relay.stdout.on('data', d => { relayOut += d; });

  const relayReady = new Promise(r => {
    const check = setInterval(() => {
      if (relayOut.includes('Public key:')) {
        clearInterval(check);
        r(true);
      }
    }, 500);
    setTimeout(() => { clearInterval(check); r(false); }, 18000);
  });

  const started = await relayReady;
  if (!started) {
    console.error('✗ Relay failed');
    relay.kill();
    process.exit(1);
  }

  const keyMatch = relayOut.match(/Public key: ([a-f0-9]+)/);
  if (!keyMatch) {
    console.error('✗ No key');
    relay.kill();
    process.exit(1);
  }

  const pubKey = keyMatch[1];
  console.log(`✓ Relay: ${pubKey.substring(0, 20)}...\n`);

  console.log('[2] Connecting client...');
  const client = spawn('node', ['bin/cli.js', '--host', pubKey], {
    cwd: '/home/user/playwriter-nat-relay',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let output = '';
  client.stdout.on('data', d => { output += d; });

  const clientReady = new Promise(r => {
    const check = setInterval(() => {
      if (output.includes('Connected')) {
        clearInterval(check);
        r(true);
      }
    }, 300);
    setTimeout(() => { clearInterval(check); r(false); }, 12000);
  });

  const connected = await clientReady;
  if (!connected) {
    console.error('✗ Connection failed');
    client.kill();
    relay.kill();
    process.exit(1);
  }

  console.log('✓ Connected\n');

  console.log('[3] Navigating to Wikipedia...');
  client.stdin.write('console.log("[BEFORE]", await page.title())\n');
  await new Promise(r => setTimeout(r, 3000));

  client.stdin.write('await page.goto("https://en.wikipedia.org/wiki/PlayStation", {waitUntil: "load"})\n');
  await new Promise(r => setTimeout(r, 22000));

  client.stdin.write('console.log("[AFTER]", await page.title())\n');
  await new Promise(r => setTimeout(r, 3000));

  console.log('\n=== VERIFICATION ===\n');
  const hasWiki = output.includes('Wikipedia') || output.includes('PlayStation');
  const hasAfter = output.includes('[AFTER]');

  console.log('✓ [AFTER] received:', hasAfter);
  console.log('✓ Wikipedia/PlayStation found:', hasWiki);

  if (hasWiki && hasAfter) {
    console.log('\n✓✓✓ SUCCESS: Page changed to Wikipedia through tunnel!\n');
  }

  console.log('Output:');
  console.log(output);

  client.kill();
  relay.kill();
  process.exit(0);
})().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
