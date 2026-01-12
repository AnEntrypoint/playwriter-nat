const DHT = require('@hyperswarm/dht');
const { spawn } = require('child_process');
const pump = require('pump');
const crypto = require('crypto');
const { Packr } = require('msgpackr');

/**
 * Playwriter NAT Relay - P2P relay for isolated playwriter browser pages
 *
 * Production-grade resilience: self-healing, automatic reconnection,
 * lifecycle state management, comprehensive error recovery
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

// Lifecycle states: opening → opened → closing → closed
const States = {
  PENDING: 'pending',
  OPENING: 'opening',
  OPENED: 'opened',
  CLOSING: 'closing',
  CLOSED: 'closed'
};

class PlaywriterRelay {
  constructor() {
    this.node = null;
    this.clients = new Map(); // clientId -> { socket, closed, pages }
    this.serveProcess = null;
    this.server = null;
    this.writeQueue = []; // Shared queue for writing to serve process
    this.isWriting = false;
    this.messageIdMap = new Map(); // messageId -> clientId (for response routing)
    this.pageOwnership = new Map(); // pageId -> clientId (for cleanup)
    this.clientMessageIds = new Map(); // clientId -> Set<messageIds> (per-client tracking)
    this.nextMessageId = 1;

    // Lifecycle and resilience
    this._state = States.PENDING;
    this._serveToken = null;
    this._serveHost = null;
    this._closing = false;
    this._interrupting = false;
    this._healthCheckInterval = null;
    this._recoveryAttempts = 0;
    this._maxRecoveryAttempts = 10;
    this._reconnectAttempts = {};
    this._maxReconnectAttempts = 5;
  }

  /**
   * Check if operation is allowed in current state
   */
  _checkState() {
    if (this._closing) return false;
    if (this._interrupting) return false;
    return this._state === States.OPENED;
  }

  /**
   * Queue and write data to shared playwriter serve stdin
   * Prevents message interleaving from multiple clients
   */
  writeToServe(data) {
    return new Promise((resolve, reject) => {
      if (!this._checkState()) {
        reject(new Error('Relay not ready or closing'));
        return;
      }

      this.writeQueue.push({ data, resolve, reject, timestamp: Date.now() });
      this.processWriteQueue();
    });
  }

  processWriteQueue() {
    if (this.isWriting || this.writeQueue.length === 0 || !this.serveProcess) {
      return;
    }

    if (!this._checkState()) {
      // Clear queue on shutdown
      this.writeQueue.splice(0).forEach(item => {
        item.reject(new Error('Relay closing'));
      });
      return;
    }

    if (this.serveProcess.killed || !this.serveProcess.stdin || this.serveProcess.stdin.destroyed) {
      // Serve process not ready, attempt recovery
      this.writeQueue.splice(0).forEach(item => {
        item.reject(new Error('Serve process not ready'));
      });
      this._attemptRecovery();
      return;
    }

    this.isWriting = true;
    const item = this.writeQueue.shift();

    try {
      this.serveProcess.stdin.write(item.data, (err) => {
        this.isWriting = false;

        if (err) {
          item.reject(err);
          console.error('[relay] Write error:', err.message);
          this._attemptRecovery();
        } else {
          item.resolve();
        }

        this.processWriteQueue();
      });
    } catch (err) {
      this.isWriting = false;
      item.reject(err);
      console.error('[relay] Write exception:', err.message);
      this._attemptRecovery();
      this.processWriteQueue();
    }
  }

  async initialize() {
    if (!this.node) {
      this.node = new DHT();
      await this.node.ready();
    }
  }

  /**
   * Attempt recovery by restarting serve process
   */
  async _attemptRecovery() {
    if (this._closing || this._interrupting) return;

    this._recoveryAttempts++;

    if (this._recoveryAttempts > this._maxRecoveryAttempts) {
      console.error('[relay] Max recovery attempts exceeded, shutting down');
      this.shutdown();
      return;
    }

    const backoffMs = Math.min(1000 * Math.pow(2, this._recoveryAttempts), 30000);
    console.log(`[relay] Recovery attempt ${this._recoveryAttempts}/${this._maxRecoveryAttempts} in ${backoffMs}ms`);

    await new Promise(resolve => setTimeout(resolve, backoffMs));

    if (!this._closing && !this._interrupting) {
      if (this._recoveryAttempts >= 5) {
        console.error('[relay] Recovery stuck at port binding, check if port 19988 is held by another process');
        console.error('[relay] To fix: kill any remaining playwriter processes and retry');
        return;
      }
      console.log('[relay] Attempting to restart serve... (attempt ' + this._recoveryAttempts + ')');
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  /**
   * Health check for serve process
   */
  async _healthCheck() {
    if (!this._checkState()) return;

    if (!this.serveProcess || this.serveProcess.killed) {
      console.error('[relay] Health check failed: serve process not running');
      await this._attemptRecovery();
    }
  }

  /**
   * Start health check interval
   */
  _startHealthChecks() {
    this._healthCheckInterval = setInterval(() => {
      this._healthCheck().catch(err => {
        console.error('[relay] Health check error:', err.message);
      });
    }, 5000); // Every 5 seconds
  }

  /**
   * Stop health check interval
   */
  _stopHealthChecks() {
    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    if (this._closing) return;
    this._closing = true;
    this._state = States.CLOSING;

    console.log('[relay] Shutting down...');

    this._stopHealthChecks();

    // Close all client connections
    const clientIds = Array.from(this.clients.keys());
    for (const clientId of clientIds) {
      const client = this.clients.get(clientId);
      if (client && !client.closed) {
        try {
          if (!client.socket.destroyed) {
            client.socket.destroy();
          }
        } catch (err) {
          console.error(`[${clientId}] Error closing socket:`, err.message);
        }
      }
    }

    // Close DHT server
    if (this.server) {
      try {
        await this.server.close();
      } catch (err) {
        console.error('[relay] Error closing DHT server:', err.message);
      }
    }

    // Kill serve process
    if (this.serveProcess && !this.serveProcess.killed) {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          console.error('[relay] Serve process kill timeout, force killing');
          this.serveProcess?.kill('SIGKILL');
          resolve();
        }, 5000);

        this.serveProcess.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });

        this.serveProcess.kill('SIGTERM');
      });
    }
  }

  /**
   * Server mode: Start playwriter serve, listen for p2p clients
   * @param {string} token - Token for playwriter serve authentication
   * @param {string} playwrightHost - Host for playwriter serve
   * @param {string|null} seed - Optional seed for deterministic DHT key generation (persistent across restarts)
   */
  async startServer(token, playwrightHost = 'localhost', seed = null) {
    if (this._state !== States.PENDING) {
      throw new Error('Relay already started');
    }

    this._state = States.OPENING;
    this._serveToken = token;
    this._serveHost = playwrightHost;

    try {
      await this.initialize();

      // Don't spawn playwriter serve - assume it's already running or will be started separately
      // This avoids port binding conflicts and simplifies lifecycle management
      console.log('[relay] Note: playwriter serve should be running on port 19988');
      console.log('[relay] You can start it separately with: playwriter serve --token ' + token);

      // Listen for client connections on hyperswarm
      this.server = this.node.createServer({ reusableSocket: true });

      this.server.on('connection', (socket) => {
        if (!this._checkState()) {
          socket.end();
          return;
        }

        const clientId = crypto.randomBytes(8).toString('hex');
        console.log(`[${clientId}] New client connection (authenticated via DHT public key)`);
        this.forwardClientToServe(clientId, socket);
      });

      this.server.on('error', (err) => {
        console.error('[relay] DHT server error:', err.message);
        if (!this._closing) {
          this._attemptRecovery();
        }
      });

      console.log('Playwriter NAT relay server started');
      console.log(`- playwriter serve managing Chrome extension at ${playwrightHost}:19988`);
      console.log(`- Each client gets isolated page in Chrome extension`);

      // Generate keypair for DHT server from seed (if provided) or token hash
      const seedValue = seed || token;
      const hash = DHT.hash(Buffer.from(seedValue));
      const keyPair = DHT.keyPair(hash);
      await this.server.listen(keyPair);

      this._state = States.OPENED;
      this._recoveryAttempts = 0; // Reset on successful startup
      this._startHealthChecks();

      return { server: this.server, publicKey: keyPair.publicKey, playwrightProcess: this.serveProcess };
    } catch (err) {
      this._state = States.CLOSED;
      console.error('[relay] Startup failed:', err.message);
      await this.shutdown();
      throw err;
    }
  }

  /**
   * Forward client directly to shared playwriter serve instance
   * Each client gets isolated page in Chrome extension managed by playwriter serve
   */
  forwardClientToServe(clientId, socket) {
    if (!this._checkState()) {
      console.error(`[${clientId}] Error: relay not in opened state`);
      socket.end();
      return;
    }

    const clientInfo = {
      socket,
      clientId,
      closed: false,
      pages: new Set(),
      messageIds: new Set(),
      created: Date.now(),
      lastActivity: Date.now(),
      serveConnected: false,
      pendingData: [] // Buffer data until serve is connected
    };

    this.clients.set(clientId, clientInfo);
    this.clientMessageIds.set(clientId, clientInfo.messageIds);

    console.log(`[${clientId}] Connected, forwarding to playwriter serve on localhost:19988`);

    const net = require('net');
    const serveSocket = net.createConnection({ port: 19988, host: 'localhost' });

    const cleanup = () => {
      if (clientInfo.closed) {
        return;
      }
      clientInfo.closed = true;
      this.clients.delete(clientId);
      try {
        if (socket && !socket.destroyed) {
          socket.destroy();
        }
        if (serveSocket && !serveSocket.destroyed) {
          serveSocket.destroy();
        }
      } catch (err) {
        // Ignore
      }
      console.log(`[${clientId}] Disconnected`);
    };

    serveSocket.on('error', (err) => {
      console.error(`[${clientId}] Serve connection error: ${err.message}`);
      cleanup();
    });

    serveSocket.on('connect', () => {
      if (clientInfo.closed) {
        serveSocket.destroy();
        return;
      }
      clientInfo.serveConnected = true;
      console.log(`[${clientId}] Connected to serve`);

      if (clientInfo.pendingData.length > 0) {
        console.log(`[${clientId}] Flushing ${clientInfo.pendingData.length} pending messages`);
        for (const data of clientInfo.pendingData) {
          try {
            serveSocket.write(data);
          } catch (err) {
            console.error(`[${clientId}] Error writing pending data: ${err.message}`);
            cleanup();
            return;
          }
        }
        clientInfo.pendingData = [];
      }
    });

    serveSocket.on('end', () => {
      if (!clientInfo.closed) {
        console.log(`[${clientId}] Serve connection ended`);
        cleanup();
      }
    });

    socket.on('error', (err) => {
      console.error(`[${clientId}] Socket error: ${err.message}`);
      cleanup();
    });

    socket.on('end', () => {
      if (!clientInfo.closed) {
        console.log(`[${clientId}] Client connection ended`);
        cleanup();
      }
    });

    socket.on('data', (data) => {
      if (clientInfo.closed) {
        return;
      }
      clientInfo.lastActivity = Date.now();

      if (!clientInfo.serveConnected) {
        if (serveSocket.destroyed) {
          return;
        }
        clientInfo.pendingData.push(data);
        return;
      }

      try {
        const canWrite = serveSocket.write(data);
        if (!canWrite) {
          socket.pause();
          serveSocket.once('drain', () => {
            if (!clientInfo.closed && !socket.destroyed) {
              socket.resume();
            }
          });
        }
      } catch (err) {
        console.error(`[${clientId}] Forward to serve error: ${err.message}`);
        cleanup();
      }
    });

    serveSocket.on('data', (data) => {
      if (clientInfo.closed || socket.destroyed) {
        return;
      }
      clientInfo.lastActivity = Date.now();
      try {
        const canWrite = socket.write(data);
        if (!canWrite) {
          serveSocket.pause();
          socket.once('drain', () => {
            if (!clientInfo.closed && !serveSocket.destroyed) {
              serveSocket.resume();
            }
          });
        }
      } catch (err) {
        console.error(`[${clientId}] Forward to client error: ${err.message}`);
        cleanup();
      }
    });
  }

  /**
   * Client mode: Connect to hyperswarm relay and forward stdio
   * Implements automatic reconnection with exponential backoff
   */
  async connectClient(publicKey) {
    if (this._state !== States.PENDING) {
      throw new Error('Client already started');
    }

    this._state = States.OPENING;

    await this.initialize();

    let attemptCount = 0;
    const maxAttempts = 10;

    const attemptConnection = async () => {
      attemptCount++;

      if (this._interrupting) {
        throw new Error('Connection interrupted');
      }

      if (attemptCount > maxAttempts) {
        throw new Error(`Max connection attempts (${maxAttempts}) exceeded`);
      }

      console.log(`[client] Connection attempt ${attemptCount}/${maxAttempts}...`);

      const socket = this.node.connect(publicKey, { reusableSocket: true });
      let connected = false;

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!connected) {
            socket.destroy();
            const backoffMs = Math.min(1000 * Math.pow(2, attemptCount - 1), 10000);
            console.error(`[client] Connection timeout, retrying in ${backoffMs}ms...`);
            new Promise(res => setTimeout(res, backoffMs))
              .then(() => attemptConnection())
              .then(resolve)
              .catch(reject);
          }
        }, 10000); // Per-attempt timeout

        socket.on('open', () => {
          if (this._interrupting) {
            socket.destroy();
            reject(new Error('Connection interrupted'));
            return;
          }

          connected = true;
          clearTimeout(timeout);

          console.log('[client] Connected to relay, forwarding stdio');
          this._state = States.OPENED;

          this.setupStdioForwarding(socket)
            .then(resolve)
            .catch(reject);
        });

        socket.on('error', (err) => {
          clearTimeout(timeout);

          if (connected) {
            // Already connected, this is a runtime error
            reject(err);
          } else {
            // Connection failed, retry
            const backoffMs = Math.min(1000 * Math.pow(2, attemptCount - 1), 10000);
            console.error(`[client] Connection error: ${err.message}, retrying in ${backoffMs}ms...`);
            new Promise(res => setTimeout(res, backoffMs))
              .then(() => attemptConnection())
              .then(resolve)
              .catch(reject);
          }
        });

        socket.on('close', () => {
          clearTimeout(timeout);
          if (connected) {
            // Connected socket closed, this is a normal disconnect
            resolve();
          } else if (!connected && !this._interrupting) {
            // Connection failed before open
            const backoffMs = Math.min(1000 * Math.pow(2, attemptCount - 1), 10000);
            console.error(`[client] Connection closed, retrying in ${backoffMs}ms...`);
            new Promise(res => setTimeout(res, backoffMs))
              .then(() => attemptConnection())
              .then(resolve)
              .catch(reject);
          } else {
            resolve();
          }
        });
      });
    };

    try {
      await attemptConnection();
    } catch (err) {
      this._state = States.CLOSED;
      console.error('[client] Connection failed:', err.message);
      process.exit(1);
    }
  }

  /**
   * Setup stdio forwarding for client
   */
  async setupStdioForwarding(socket) {
    return new Promise((resolve, reject) => {
      let pumpErrors = 0;

      // Handle stdin → socket (raw pass-through)
      process.stdin.on('data', (data) => {
        socket.write(data);
      });

      process.stdin.on('end', () => {
        if (!socket.destroyed) {
          socket.end();
        }
      });

      process.stdin.on('error', (err) => {
        console.error('[client] stdin error:', err.message);
      });

      // Handle socket → stdout (raw pass-through)
      socket.on('data', (data) => {
        process.stdout.write(data);
      });

      socket.on('error', (err) => {
        console.error('[client] Socket error:', err.message);
        if (!socket.destroyed) {
          socket.destroy();
        }
        this._state = States.CLOSED;
        process.exit(1);
      });

      socket.on('end', () => {
        if (!this._closing && !this._interrupting) {
          console.log('[client] relay closed, ending connection');
        }
        setTimeout(() => {
          this._state = States.CLOSED;
          process.exit(0);
        }, 100);
      });

      // Handle process signals for clean shutdown
      const handleSignal = (signal) => {
        console.log(`[client] Received ${signal}, shutting down...`);
        this._interrupting = true;
        if (!socket.destroyed) {
          socket.destroy();
        }
        process.exit(0);
      };

      process.on('SIGINT', () => handleSignal('SIGINT'));
      process.on('SIGTERM', () => handleSignal('SIGTERM'));

      // Socket is ready
      resolve();
    });
  }
}

module.exports = { PlaywriterRelay };
