# Playwriter Extension Setup Guide

## Quick Start

### 1. Start the Relay Server

```bash
npm start
# Or with a custom seed for persistent key:
# npm start -- --seed my-relay-key
```

The relay will start on port 19988 (or find an alternative if busy).

Output will show:
```
Playwriter NAT relay server started
- Listening on port 19988
- WebSocket Extension: ws://localhost:19988/extension
```

### 2. Open the Playwriter Browser Extension

1. Install the [Playwriter MCP extension](https://chromewebstore.google.com/detail/playwriter-mcp/jfeammnjpkecdekppnclgkkffahnhfhe) in Chrome
2. Click the **Playwriter icon** in your Chrome toolbar
3. Click on a tab you want to control
4. The extension will automatically connect to the relay

### 3. The Extension Will Auto-Connect

When you click on a tab, the extension:
1. Detects the local relay server on port 19988 (or alternative port)
2. Creates a WebSocket connection to `ws://localhost:19988/extension`
3. Identifies itself as "extension" to the relay
4. Begins forwarding Chrome DevTools Protocol (CDP) commands

### 4. Verify Connection

You'll see logs showing:
```
[minimal-serve] Chrome extension connected
```

Once connected, the extension relay is ready to receive commands from playwriter MCP clients.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Playwriter Relay Server (this project)                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  MinimalServe (HTTP + WebSocket on port 19988)            │
│     ├─ /extension    ← Browser extension connects here    │
│     ├─ /cdp          ← MCP clients connect here           │
│     └─ /health       ← Health check endpoint              │
│                                                             │
│  When extension connects:                                  │
│     Extension Socket ←→ MCP Client Socket                  │
│     (bidirectional message forwarding)                     │
│                                                             │
│  When MCP client connects:                                 │
│     New playwriter MCP subprocess spawned                  │
│     (isolated page for this client)                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Troubleshooting

### Extension doesn't auto-connect

**Check logs for port:**
The relay finds a free port automatically if 19988 is busy. Look for output:
```
[relay] Found free port: 19989
```

**Configure extension to use correct port:**

If the extension is trying to connect to port 19988 but the relay is on 19989, you may need to set an environment variable or configuration. Check the extension settings panel.

### "Port 19988 already in use"

The relay automatically finds the next available port (19989, 19990, etc.). You can see which port is being used in the logs.

### Extension connects but no page changes

1. The extension has connected successfully
2. You need to start an MCP client to send navigation commands
3. The MCP client connects to the relay, gets a subprocess
4. Commands flow: MCP client → relay → extension → Chrome tab

### HTTP health check works but extension doesn't connect

The extension needs to:
1. Detect the relay is running (via HTTP health check)
2. Upgrade to WebSocket on `/extension` endpoint
3. Send initial handshake message

If logs show `[minimal-serve] Chrome extension connected` then it worked. If not, check extension console for errors.

## Direct Testing (Without Real Extension)

Run the simulator to test relay functionality without the actual browser extension:

```bash
node test-simulator.js
```

This proves:
- MinimalServe works ✓
- WebSocket connections work ✓
- Message forwarding works ✓
- CDP commands are transmitted ✓

## Environment Variables

### Port Configuration

The relay normally uses port 19988. To use a different port:

```bash
PLAYWRITER_PORT=20000 npm start
```

(This would require modifying the relay code to support the env var)

## Files

- `lib/relay.js` - Main relay server
- `lib/minimal-serve.js` - HTTP + WebSocket server
- `bin/cli.js` - CLI entry point
- `test-simulator.js` - Verify relay works without real extension

## Next Steps

1. **Start relay**: `npm start`
2. **Open extension**: Click Playwriter icon in Chrome → click a tab
3. **Verify connection**: Look for `[minimal-serve] Chrome extension connected` in logs
4. **Send commands**: Use playwriter MCP client to send navigation commands

## Real Extension Behavior

Once the extension is connected to the relay:

1. Extension creates WebSocket tunnel to relay
2. Extension identifies as `/extension` client
3. Relay forwards all messages bidirectionally:
   - MCP client commands → extension
   - Extension responses → MCP clients
4. Each MCP client gets an isolated subprocess
5. Playwriter processes commands via the connected tab

## References

- [Playwriter MCP GitHub](https://github.com/remorses/playwriter)
- [Chrome Extension Development](https://developer.chrome.com/docs/extensions/)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
