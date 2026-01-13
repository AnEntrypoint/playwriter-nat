# Quick Start - Get Pages Navigating in 2 Minutes

## Step 1: Start the Relay (Terminal 1)

```bash
npm start
```

You'll see:
```
✓ Server started on port 19988
✓ Extension should connect to: ws://localhost:19988/extension
[minimal-serve] Chrome extension connected
```

**The relay is ready. The extension has connected.**

## Step 2: Navigate Pages (Terminal 2)

```bash
node demo-complete.js
```

**Your browser will navigate through 4 pages.**

Or send custom pages:
```bash
node send-navigation.js https://your-site.com
```

---

## What's Happening

1. **Relay** is listening on `ws://localhost:19988`
2. **Browser extension** connected to `/extension` endpoint
3. **Navigation commands** sent to `/cdp` endpoint
4. **Browser** receives commands and navigates pages
5. **Real-time** bidirectional communication

---

## See It Working

### In Browser
- Click the Playwriter extension icon
- Click on a tab to control
- Watch the tab navigate to: example.com → google.com → github.com → wikipedia.org

### In Terminal 1 (Relay)
```
[cdp:xxx→serve] {"id":1,"method":"Page.navigate","params":{"url":"https://example.com"}}
[extension→serve] {"id":1}
```

### In Terminal 2 (Commands)
```
✓ Connected to relay for: https://example.com
✓ Response received: {"id":1}
✓ Command executed - check your browser!
```

---

## Architecture

```
Browser → Extension → Relay → MCP Client
   ↑                    ↓
   └────────────────────┘
    (bidirectional messages)
```

---

## Commands

| Command | Purpose |
|---------|---------|
| `npm start` | Start relay server |
| `node demo-complete.js` | Navigate 4 pages |
| `node send-navigation.js https://url.com` | Navigate custom page |
| `node start-relay.js` | Relay with real-time monitoring |
| `node test-simulator.js` | Test without real extension |

---

## Troubleshooting

### Extension not connecting?
1. Make sure Chrome Playwriter extension is installed
2. Click extension icon in Chrome
3. Click a tab to control
4. Check relay logs: `[minimal-serve] Chrome extension connected`

### Pages not changing?
1. Check browser - tab should be active
2. Check relay logs for command forwarding
3. Run: `node demo-complete.js` to test

### Port 19988 already in use?
- Relay will find next available port (19989, 19990, etc.)
- Check logs for actual port being used
- Update `send-navigation.js` with correct port if needed

---

## What You're Seeing

**✓ Relay running on port 19988**
**✓ Extension connected via WebSocket**
**✓ Commands flowing: client → relay → extension → browser**
**✓ Browser pages changing in real-time**
**✓ Full bidirectional communication**

---

## Production Ready

The system is fully functional:
- Extension auto-connects
- Commands execute instantly
- Pages navigate in real-time
- Multiple clients supported
- Error handling and recovery

---

**That's it! Pages are changing. You're done.**

For more details, see:
- `PAGES_CHANGING_PROOF.md` - Evidence of working system
- `EXTENSION_SETUP.md` - Detailed setup guide
- `VERIFICATION_COMPLETE.md` - Full test results
