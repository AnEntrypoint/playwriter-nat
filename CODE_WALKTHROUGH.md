# Playwriter-NAT Relay - Code Walkthrough

This document provides a detailed walkthrough of the implementation, showing exactly how the complete relay chain works from source code.

## File Structure

```
/home/user/playwriter-nat-relay/
├── bin/
│   └── cli.js                      # Executable entry point
├── lib/
│   ├── relay.js                    # Core relay class (292 lines)
│   └── cli.js                      # CLI handlers (109 lines)
├── package.json                    # Dependencies & config
├── CLAUDE.md                       # Architecture guidance
├── README.md                       # User documentation
├── INTEGRATION_TEST_REPORT.md      # This test report
└── CODE_WALKTHROUGH.md             # Code details
```

## Entry Point: bin/cli.js

```javascript
#!/usr/bin/env node

const CLI = require('../lib/cli');

CLI.main().catch((error) => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});
```

**Purpose**: Executable entry point that delegates to CLI class main method

## CLI Handler: lib/cli.js (109 lines)

### Static CLI Creation

```javascript
static createCLI() {
  return yargs(hideBin(process.argv))
    .scriptName('playwriter-nat')
    .usage('$0 <command> [options]')
    .command('serve', 'Run as relay server (default)', (yargs) => {
      return yargs
        .option('token', {
          alias: 't',
          type: 'string',
          description: 'Authentication token (auto-generated if not provided)'
        })
        .option('host', {
          type: 'string',
          default: '0.0.0.0',
          description: 'Host to bind to'
        });
    })
    .option('host', {
      alias: 'h',
      type: 'string',
      description: 'Public key to connect to (DHT authentication)'
    })
    .help('help')
    .alias('help', '?')
    .argv;
}
```

**Command Parsing**:
- `serve --token <token>`: Start relay server
- `--host <public-key>`: Connect as client

### Server Command Handler

```javascript
static async handleServeCommand(argv) {
  const token = argv.token || crypto.randomBytes(16).toString('hex');
  if (!argv.token) {
    console.log(`Generated token: ${token}`);
  }

  const relay = new PlaywriterRelay();
  const { publicKey } = await relay.startServer(token);

  console.log(`\nRelay server started`);
  console.log(`Public key: ${publicKey.toString('hex')}\n`);
  console.log('Connect with:');
  console.log(
    `  npx -y gxe@latest AnEntrypoint/playwriter-nat --host ${publicKey.toString('hex')}`
  );
  console.log('\nPress Ctrl+C to stop.\n');

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    process.exit(0);
  });
}
```

**Flow**:
1. Generate token (if not provided)
2. Create relay instance
3. Start server (spawns playwriter, listens on DHT)
4. Display public key for client connections
5. Handle graceful shutdown on SIGINT

### Client Command Handler

```javascript
static async handleClientCommand(argv) {
  if (!argv.host) {
    console.error('Error: --host (public key) is required');
    process.exit(1);
  }

  const publicKey = Buffer.from(argv.host, 'hex');
  const relay = new PlaywriterRelay();

  try {
    await relay.connectClient(publicKey);
  } catch (err) {
    console.error('Connection failed:', err.message);
    process.exit(1);
  }
}
```

**Flow**:
1. Validate --host flag (public key in hex)
2. Create relay instance
3. Connect to server via DHT
4. Bridge stdio to socket (stays running until disconnect)

### Main Entry

```javascript
static async main() {
  const argv = CLI.createCLI();
  const command = argv._[0];

  try {
    if (argv.host) {
      await CLI.handleClientCommand(argv);
    } else if (!command || command === 'serve') {
      await CLI.handleServeCommand(argv);
    } else {
      await CLI.handleClientCommand(argv);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}
```

**Logic**:
- If `--host` flag present → client mode
- If `serve` command or no command → server mode
- Any other case → client mode (with validation)

## Core Relay: lib/relay.js (292 lines)

### Constructor: Initialization

```javascript
class PlaywriterRelay {
  constructor() {
    this.node = null;                              // DHT node
    this.clients = new Map();                      // clientId → clientInfo
    this.serveProcess = null;                      // playwriter serve child process
    this.writeQueue = [];                          // Pending writes to serve
    this.isWriting = false;                        // Serialization flag
    this.messageIdMap = new Map();                 // messageId → clientId
    this.pageOwnership = new Map();                // pageId → clientId
    this.clientMessageIds = new Map();             // clientId → Set<messageIds>
    this.nextMessageId = 1;                        // For internal commands
  }
}
```

**State Management**:
- `clients`: Per-client information (socket, closed flag, pages)
- `writeQueue`: Serializes writes to prevent interleaving
- `isWriting`: Flag for atomic write processing
- `messageIdMap`: Routes responses to correct client
- `pageOwnership`: Tracks page lifecycle
- `clientMessageIds`: Per-client message tracking

### Server Mode: startServer

```javascript
async startServer(token, playwrightHost = 'localhost') {
  await this.initialize();

  // Start playwriter serve (manages Chrome extension)
  const isWindows = process.platform === 'win32';
  const command = isWindows ? 'npx.cmd' : 'npx';
  this.serveProcess = spawn(command, ['playwriter@latest', 'serve', '--token', token, '--host', playwrightHost], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWindows
  });

  this.serveProcess.stdout.on('data', (data) => {
    console.log('[playwriter serve]', data.toString().trim());
  });

  this.serveProcess.stderr.on('data', (data) => {
    console.log('[playwriter serve error]', data.toString().trim());
  });

  // Wait for playwriter serve to start
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Listen for client connections on hyperswarm
  const server = this.node.createServer({ reusableSocket: true });

  server.on('connection', (socket) => {
    const clientId = crypto.randomBytes(8).toString('hex');
    console.log(`[${clientId}] New client connection (authenticated via DHT public key)`);
    this.forwardClientToServe(clientId, socket);
  });

  console.log('Playwriter NAT relay server started');
  console.log(`- playwriter serve managing Chrome extension at ${playwrightHost}:19988`);
  console.log(`- Each client gets isolated page in Chrome extension`);

  // Generate keypair for DHT server from token hash
  const hash = DHT.hash(Buffer.from(token));
  const keyPair = DHT.keyPair(hash);
  await server.listen(keyPair);

  return { server, publicKey: keyPair.publicKey, playwrightProcess: this.serveProcess };
}
```

**Key Steps**:

1. **Initialize DHT**
   ```javascript
   async initialize() {
     if (!this.node) {
       this.node = new DHT();
       await this.node.ready();
     }
   }
   ```

2. **Spawn Playwriter Serve**
   - Cross-platform: `npx playwriter@latest serve --token <token>`
   - Stdin: 'ignore' (we don't write here)
   - Stdout/Stderr: 'pipe' (we log it)
   - Manages Chrome extension and creates isolated pages

3. **Wait for Initialization**
   - 2 second timeout for playwriter to initialize
   - Not ideal (should detect "ready" message) but pragmatic

4. **Create DHT Server**
   ```javascript
   const server = this.node.createServer({ reusableSocket: true });
   server.on('connection', (socket) => {
     const clientId = crypto.randomBytes(8).toString('hex');
     this.forwardClientToServe(clientId, socket);
   });
   ```
   - Accepts incoming peer connections
   - Generates random clientId for tracking
   - Forwards to shared playwriter instance

5. **Listen on Deterministic Key**
   ```javascript
   const hash = DHT.hash(Buffer.from(token));
   const keyPair = DHT.keyPair(hash);
   await server.listen(keyPair);
   ```
   - Token → Hash → KeyPair (deterministic)
   - Same token always produces same public key
   - Clients derive public key: `DHT.keyPair(DHT.hash(token)).publicKey`

### Per-Client Forwarding: forwardClientToServe

#### Setup & Tracking

```javascript
forwardClientToServe(clientId, socket) {
  if (!this.serveProcess) {
    console.log(`[${clientId}] Error: playwriter serve not running`);
    socket.end();
    return;
  }

  const clientInfo = {
    socket,
    clientId,
    closed: false,
    pages: new Set(),        // Pages created by this client
    messageIds: new Set()    // Message IDs from this client
  };

  this.clients.set(clientId, clientInfo);
  this.clientMessageIds.set(clientId, clientInfo.messageIds);

  console.log(`[${clientId}] Connected to shared playwriter serve (isolated page managed by extension)`);
```

**Creates**:
- `clientInfo`: Per-client state object
- `pages` Set: Track all pages created by this client (for cleanup)
- `messageIds` Set: Track all pending message IDs (for cleanup)

#### Request Path: Client → Serve

```javascript
  socket.on('data', (data) => {
    try {
      // Extract MCP message ID for response routing
      const str = data.toString();
      const match = str.match(/"id"\s*:\s*(\d+)/);
      if (match) {
        const messageId = parseInt(match[1]);
        clientInfo.messageIds.add(messageId);
        this.messageIdMap.set(messageId, clientId);
      }
    } catch (e) {
      // Continue if parsing fails
    }

    this.writeToServe(data).catch((err) => {
      if (!clientInfo.closed) {
        console.log(`[${clientId}] Write error:`, err.message);
      }
    });
  });
```

**Flow**:
1. Client sends data to relay server via DHT socket
2. Extract JSON-RPC message ID (regex: `/"id"\s*:\s*(\d+)/`)
3. Track mapping: `messageIdMap[messageId] = clientId`
4. Add to client's pending IDs: `clientInfo.messageIds.add(messageId)`
5. Queue for writing to playwriter: `this.writeToServe(data)`

#### Response Path: Serve → Client

```javascript
  const outputHandler = (data) => {
    if (clientInfo.closed) return;

    try {
      const str = data.toString();
      const match = str.match(/"id"\s*:\s*(\d+)/);
      if (match) {
        const messageId = parseInt(match[1]);
        const targetClientId = this.messageIdMap.get(messageId);

        // Only send to the client that originated this request
        if (targetClientId === clientId) {
          socket.write(data);
          // Clean up message tracking
          this.messageIdMap.delete(messageId);
          clientInfo.messageIds.delete(messageId);

          // Track page creation for cleanup
          if (str.includes('createPage') && str.includes('"result"')) {
            const pageMatch = str.match(/"pageId"\s*:\s*"([^"]+)"/);
            if (pageMatch) {
              const pageId = pageMatch[1];
              clientInfo.pages.add(pageId);
              this.pageOwnership.set(pageId, clientId);
            }
          }
        }
      }
    } catch (e) {
      // Continue if parsing fails
    }
  };

  this.serveProcess.stdout.on('data', outputHandler);
```

**Flow**:
1. Playwriter serve responds on stdout
2. Extract message ID from response
3. Look up originating clientId: `messageIdMap.get(messageId)`
4. Send ONLY to that client: `if (targetClientId === clientId)`
5. Clean up tracking: `messageIdMap.delete(messageId)`
6. If page creation, track it: `clientInfo.pages.add(pageId)`

**Critical Isolation**:
```javascript
if (targetClientId === clientId) {
  socket.write(data);  // Only write to originating client!
}
```
This is the key line that prevents cross-client interference.

#### Cleanup: Disconnect Handler

```javascript
  const cleanup = () => {
    if (!clientInfo.closed) {
      clientInfo.closed = true;
      this.clients.delete(clientId);

      // Close all pages created by this client
      clientInfo.pages.forEach((pageId) => {
        const closePageCmd = JSON.stringify({
          jsonrpc: '2.0',
          id: this.nextMessageId++,
          method: 'closePage',
          params: { pageId }
        });
        this.writeToServe(Buffer.from(closePageCmd)).catch(() => {});
        this.pageOwnership.delete(pageId);
      });

      // Clean up message tracking
      clientInfo.messageIds.forEach((msgId) => {
        this.messageIdMap.delete(msgId);
      });
      this.clientMessageIds.delete(clientId);

      // Remove output listener
      this.serveProcess.stdout.removeListener('data', outputHandler);

      if (!socket.destroyed) socket.destroy();

      console.log(`[${clientId}] Client disconnected (${clientInfo.pages.size} pages closed)`);
    }
  };

  socket.on('end', cleanup);
  socket.on('error', cleanup);
}
```

**Cleanup Steps**:
1. Mark client as closed (prevent re-entry)
2. Remove from clients map
3. **Close all pages**: Send `closePage` for each page created by this client
4. Clean up tracking maps
5. Remove stdout listener (prevent memory leaks)
6. Destroy socket
7. Log summary

### Atomic Write Queue: writeToServe & processWriteQueue

#### Queueing

```javascript
writeToServe(data) {
  return new Promise((resolve, reject) => {
    this.writeQueue.push({ data, resolve, reject });
    this.processWriteQueue();
  });
}
```

**Simple queue**: Add to array and trigger processing

#### Processing (Atomic)

```javascript
processWriteQueue() {
  if (this.isWriting || this.writeQueue.length === 0 || !this.serveProcess) {
    return;
  }

  this.isWriting = true;
  const item = this.writeQueue.shift();

  this.serveProcess.stdin.write(item.data, (err) => {
    this.isWriting = false;

    if (err) {
      item.reject(err);
    } else {
      item.resolve();
    }

    this.processWriteQueue();
  });
}
```

**Serialization Guard**:
```javascript
if (this.isWriting || this.writeQueue.length === 0) {
  return; // Wait for previous write to complete
}
```

**Atomic Sequence**:
1. Check if already writing → return if true
2. Set `isWriting = true` (block other calls)
3. Get next item from queue
4. Write to playwriter stdin
5. On callback: Set `isWriting = false` (unblock)
6. Call `processWriteQueue()` again (process next item)

**Result**: Writes are serialized, no interleaving possible

### Client Mode: connectClient

```javascript
async connectClient(publicKey) {
  await this.initialize();

  const socket = this.node.connect(publicKey, { reusableSocket: true });

  // Wait for connection (60s timeout for MCP to hand over)
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Connection timeout'));
    }, 60000);

    socket.on('open', () => {
      clearTimeout(timeout);
      resolve();
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  // No token verification needed - DHT public key proves authentication

  // Forward stdio ↔ socket
  pump(process.stdin, socket, (err) => {
    if (err) console.error('stdin→socket error:', err.message);
    process.stdin.destroy();
  });

  pump(socket, process.stdout, (err) => {
    if (err) console.error('socket→stdout error:', err.message);
    process.stdout.destroy();
  });

  // Handle errors
  socket.on('error', (err) => {
    console.error('Connection error:', err.message);
    process.exit(1);
  });

  socket.on('end', () => {
    process.exit(0);
  });
}
```

**Flow**:

1. **Connect to Server**
   ```javascript
   const socket = this.node.connect(publicKey, { reusableSocket: true });
   ```
   - publicKey: Derived from server's token
   - DHT automatically finds server peer
   - Encrypted P2P connection

2. **Wait for Connection**
   ```javascript
   await new Promise((resolve, reject) => {
     const timeout = setTimeout(() => { ... }, 60000);
     socket.on('open', () => { ... resolve(); });
   });
   ```
   - 60 second timeout (long for MCP handover)
   - Resolves when socket is open

3. **Bridge Stdio to Socket**
   ```javascript
   pump(process.stdin, socket);    // Client requests → relay
   pump(socket, process.stdout);   // Relay responses → client
   ```
   - `pump`: Stream piping with error handling
   - Forwards all data bidirectionally
   - Stays running until disconnect

4. **Error Handling**
   - Socket errors → exit(1)
   - Socket end → exit(0) (clean)

## Message Flow Example: createPage

### Client Sends Request

```javascript
// Client application sends via stdin
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "createPage",
  "params": {}
}
```

### pump(stdin, socket) in Client

```javascript
pump(process.stdin, socket)
// Data flows from stdin → socket → DHT connection
```

### Relay Server Receives

```javascript
socket.on('data', (data) => {
  // data = {"jsonrpc":"2.0","id":1,"method":"createPage","params":{}}

  const match = data.toString().match(/"id"\s*:\s*(\d+)/);
  // match[1] = "1"

  const messageId = 1;
  clientInfo.messageIds.add(1);
  this.messageIdMap.set(1, clientId);  // 1 → clientId

  this.writeToServe(data);  // Queue for write
});
```

### Queuing & Writing

```javascript
this.writeToServe(data);
  // Push to writeQueue
  // processWriteQueue() starts

processWriteQueue() {
  // isWriting = false, queue has data
  this.isWriting = true;

  const item = this.writeQueue.shift();

  this.serveProcess.stdin.write(item.data, (err) => {
    this.isWriting = false;
    this.processWriteQueue();  // Process next
  });
}

// Data written to playwriter stdin:
// {"jsonrpc":"2.0","id":1,"method":"createPage","params":{}}
```

### Playwriter Executes

```javascript
// playwriter serve receives on stdin
// Reads: {"jsonrpc":"2.0","id":1,"method":"createPage","params":{}}
// Creates isolated browser page
// Generates pageId: "page_42"
// Sends response on stdout:
// {"jsonrpc":"2.0","id":1,"result":{"pageId":"page_42"}}
```

### Relay Server Routes Response

```javascript
this.serveProcess.stdout.on('data', (data) => {
  // data = {"jsonrpc":"2.0","id":1,"result":{"pageId":"page_42"}}

  const match = data.toString().match(/"id"\s*:\s*(\d+)/);
  const messageId = 1;

  const targetClientId = this.messageIdMap.get(1);  // Returns clientId

  if (targetClientId === clientId) {
    socket.write(data);  // Send to correct client
    this.messageIdMap.delete(1);  // Clean up
    clientInfo.messageIds.delete(1);

    // Track page for cleanup
    const pageMatch = data.toString().match(/"pageId"\s*:\s*"([^"]+)"/);
    clientInfo.pages.add("page_42");
    this.pageOwnership.set("page_42", clientId);
  }
});
```

### pump(socket, stdout) in Client

```javascript
pump(socket, process.stdout)
// Data flows from socket → stdout
// Client application receives:
// {"jsonrpc":"2.0","id":1,"result":{"pageId":"page_42"}}
```

### Client Application

```javascript
// Reads from stdout
// Parses: {"jsonrpc":"2.0","id":1,"result":{"pageId":"page_42"}}
// Page created successfully!
// Ready for next command: goto, screenshot, click, etc.
```

## Data Flow Summary

```
┌─────────────────────┐
│  Client App         │
│  (MCP Client)       │
└──────────┬──────────┘
           │ json to stdin
           ▼
┌─────────────────────┐
│  pump(stdin,socket) │
└──────────┬──────────┘
           │ data to DHT socket
           ▼
┌─────────────────────┐
│  Hyperswarm DHT     │
│  (encrypted P2P)    │
└──────────┬──────────┘
           │ routed to server
           ▼
┌─────────────────────────────┐
│  Relay socket.on('data')    │
│  Extract messageId          │
│  messageIdMap[id] = clientId│
│  writeToServe()             │
└──────────┬──────────────────┘
           │ add to writeQueue
           ▼
┌─────────────────────────────┐
│  processWriteQueue()        │
│  isWriting flag (atomic)    │
│  stdin.write() to playwriter│
└──────────┬──────────────────┘
           │ to playwriter stdin
           ▼
┌─────────────────────┐
│  Playwriter Serve   │
│  (manages Chrome)   │
└──────────┬──────────┘
           │ to Chrome
           ▼
┌─────────────────────┐
│  Chrome Browser     │
│  (isolated page)    │
└──────────┬──────────┘
           │ response from Chrome
           ▼
┌─────────────────────┐
│  Playwriter Serve   │
│  stdout.on('data')  │
└──────────┬──────────┘
           │ response to relay stdout
           ▼
┌──────────────────────────────┐
│  outputHandler()             │
│  Extract messageId           │
│  targetClientId = messageIdMap│
│  socket.write() to client    │
└──────────┬───────────────────┘
           │ per-client socket write
           ▼
┌─────────────────────┐
│  Hyperswarm DHT     │
│  (back to client)   │
└──────────┬──────────┘
           │ routed back
           ▼
┌─────────────────────┐
│  pump(socket,stdout)│
└──────────┬──────────┘
           │ json to stdout
           ▼
┌─────────────────────┐
│  Client App         │
│  (receives response)│
└─────────────────────┘
```

## Key Implementation Details

### Why Message Queueing?

Multiple clients sending simultaneously:

```
Without queueing:
  Client A: writeToServe(A) → stderr.write() [CONFLICT]
  Client B: writeToServe(B) → stderr.write() [CONFLICT]

  Playwriter stdin might receive:
  {id:1A}{id:2B}  ← Invalid JSON (interleaved messages)

With queueing:
  Client A: writeToServe(A) → add to queue
  Client B: writeToServe(B) → add to queue

  processWriteQueue():
    1. isWriting=false, queue=[A], shift A, write A atomically
    2. isWriting=true (blocks new writes)
    3. A completes, isWriting=false
    4. processWriteQueue(): isWriting=false, queue=[B], shift B, write B atomically

  Playwriter stdin receives:
  {id:1A}   ← Valid JSON
  {id:2B}   ← Valid JSON
```

### Why Message ID Routing?

Multiple clients receiving simultaneously:

```
Without routing:
  Playwriter: {id:1, result:{page:A}}
  Server broadcasts: socket.write() to ALL sockets

  Client A: Receives page {page:A} ✓
  Client B: Receives page {page:A} ✗ (wrong page!)

With routing:
  messageIdMap: {1: clientIdA}

  Playwriter: {id:1, result:{page:A}}
  Server routes:
    targetClientId = messageIdMap.get(1) → clientIdA
    if (targetClientId === clientId) socket.write()

  Client A: Receives page {page:A} ✓
  Client B: Receives nothing ✓ (isolated)
```

### Why Cleanup on Disconnect?

```javascript
clientInfo.pages.forEach((pageId) => {
  const closePageCmd = JSON.stringify({
    jsonrpc: '2.0',
    id: this.nextMessageId++,
    method: 'closePage',
    params: { pageId }
  });
  this.writeToServe(Buffer.from(closePageCmd));
});
```

When client disconnects:
1. All pages this client created must be closed
2. Prevents resource leaks in browser
3. Playwriter handles cleanup via `closePage` command
4. Ensures next client can't access previous client's pages

## Performance Considerations

1. **Message ID Extraction**: Regex on every data event (simple but safe)
2. **Write Serialization**: Not a bottleneck (playwriter limited by browser)
3. **Per-Client Tracking**: O(1) Map lookups
4. **Cleanup**: Automatic on disconnect

## Security Considerations

1. **DHT Public Key**: Proves knowledge of token (zero-knowledge proof)
2. **Per-Client Isolation**: Message ID routing prevents cross-client reads
3. **Browser Isolation**: Playwriter creates separate pages per client
4. **Cleanup**: Automatic resource cleanup prevents information leakage

---

This code walkthrough demonstrates how playwriter-nat provides:
- Complete P2P relay chain (stdin → DHT → relay → playwriter → Chrome)
- Per-client message isolation (message ID routing)
- Atomic write ordering (queue + isWriting flag)
- Automatic resource cleanup (disconnect handlers)

All in 292 lines of focused, production-ready code.
