const DHT = require('@hyperswarm/dht');
const { spawn } = require('child_process');
const pump = require('pump');
const crypto = require('crypto');

/**
 * Playwriter NAT Relay - P2P relay for isolated playwriter browser pages
 *
 * Single playwriter serve instance manages Chrome extension and creates
 * isolated pages for each connected MCP client.
 *
 * Key insight: playwriter serve creates isolated pages per MCP connection.
 * No need for separate processes - just forward each client's socket to
 * the single playwriter serve instance.
 *
 * Architecture:
 * 1. Host: playwriter serve --token <secret> (manages Chrome extension)
 * 2. Relay: listens for p2p clients via hyperswarm DHT
 * 3. Per-client: forward socket directly to shared playwriter serve stdio
 * 4. Result: Each client gets isolated page in Chrome browser
 */
class PlaywriterRelay {
  constructor() {
    this.node = null;
    this.clients = new Map(); // clientId -> { socket, closed, pages }
    this.serveProcess = null;
    this.writeQueue = []; // Shared queue for writing to serve process
    this.isWriting = false;
    this.messageIdMap = new Map(); // messageId -> clientId (for response routing)
    this.pageOwnership = new Map(); // pageId -> clientId (for cleanup)
    this.clientMessageIds = new Map(); // clientId -> Set<messageIds> (per-client tracking)
    this.nextMessageId = 1;
  }

  /**
   * Queue and write data to shared playwriter serve stdin
   * Prevents message interleaving from multiple clients
   */
  writeToServe(data) {
    return new Promise((resolve, reject) => {
      this.writeQueue.push({ data, resolve, reject });
      this.processWriteQueue();
    });
  }

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

  async initialize() {
    if (!this.node) {
      this.node = new DHT();
      await this.node.ready();
    }
  }

  /**
   * Server mode: Start playwriter serve, listen for p2p clients
   */
  async startServer(token, playwrightHost = 'localhost') {
    await this.initialize();

    // Start playwriter serve (manages Chrome extension)
    this.serveProcess = spawn('npx', ['playwriter@latest', 'serve', '--token', token, '--host', playwrightHost], {
      stdio: ['ignore', 'pipe', 'pipe']
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
      console.log(`[${clientId}] New client connection`);

      socket.once('data', (data) => {
        const tokenStr = data.toString().trim();
        if (tokenStr !== token) {
          console.log(`[${clientId}] Authentication failed`);
          socket.end();
          return;
        }

        console.log(`[${clientId}] Token verified, connecting to shared playwriter serve`);
        this.forwardClientToServe(clientId, socket);
      });
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

  /**
   * Forward client directly to shared playwriter serve instance
   * Each client gets isolated page in Chrome extension managed by playwriter serve
   */
  forwardClientToServe(clientId, socket) {
    // Ensure we have a reference to the serve process's stdio
    if (!this.serveProcess) {
      console.log(`[${clientId}] Error: playwriter serve not running`);
      socket.end();
      return;
    }

    const clientInfo = {
      socket,
      clientId,
      closed: false,
      pages: new Set(), // Track pages created by this client
      messageIds: new Set() // Track message IDs from this client
    };

    this.clients.set(clientId, clientInfo);
    this.clientMessageIds.set(clientId, clientInfo.messageIds);

    console.log(`[${clientId}] Connected to shared playwriter serve (isolated page managed by extension)`);

    // Forward client→serve with queuing to prevent interleaving
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

    // Forward serve→client (ONLY to originating client based on message ID)
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

    // Handle client disconnection - close all pages owned by this client
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

  /**
   * Client mode: Connect to hyperswarm relay and forward stdio
   */
  async connectClient(publicKey, token) {
    await this.initialize();

    const socket = this.node.connect(publicKey, { reusableSocket: true });

    // Wait for connection
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      }, 10000);

      socket.on('open', () => {
        clearTimeout(timeout);
        resolve();
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Send token
    socket.write(token + '\n');

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
}

module.exports = { PlaywriterRelay };
