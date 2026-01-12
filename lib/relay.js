const DHT = require('@hyperswarm/dht');
const { spawn } = require('child_process');
const pump = require('pump');
const crypto = require('crypto');

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
    this.clients = new Map();
    this.serveProcess = null;
    this.server = null;
    this._state = States.PENDING;
    this._serveToken = null;
    this._servePort = 19988;
    this._closing = false;
    this._recoveryAttempts = 0;
    this._maxRecoveryAttempts = 10;
    this._healthCheckInterval = null;
  }

  _checkState() {
    return this._state === States.OPENED;
  }

  async _waitForPort(port, timeout = 30000) {
    const net = require('net');
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const canConnect = await new Promise(resolve => {
        const sock = net.createConnection({ port, host: 'localhost' });
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('error', () => resolve(false));
        setTimeout(() => { sock.destroy(); resolve(false); }, 500);
      });

      if (canConnect) return true;
      await new Promise(r => setTimeout(r, 500));
    }

    throw new Error(`Port ${port} not ready after ${timeout}ms`);
  }

  async initialize() {
    if (!this.node) {
      this.node = new DHT();
      await this.node.ready();
    }
  }

  async _attemptRecovery() {
    if (this._closing) return;

    this._recoveryAttempts++;

    if (this._recoveryAttempts > this._maxRecoveryAttempts) {
      console.error('[relay] Max recovery attempts exceeded');
      await this.shutdown();
      return;
    }

    const backoffMs = Math.min(1000 * Math.pow(2, this._recoveryAttempts), 30000);
    console.log(`[relay] Recovery attempt ${this._recoveryAttempts}/${this._maxRecoveryAttempts} in ${backoffMs}ms`);

    await new Promise(resolve => setTimeout(resolve, backoffMs));
  }

  async _healthCheck() {
    if (!this._checkState()) return;

    const net = require('net');
    const canConnect = await new Promise(resolve => {
      const sock = net.createConnection({ port: this._servePort, host: 'localhost' });
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
      setTimeout(() => { sock.destroy(); resolve(false); }, 2000);
    });

    if (!canConnect) {
      console.error('[relay] Health check failed: cannot connect to localhost:' + this._servePort);
      await this._attemptRecovery();
    }
  }

  _startHealthChecks() {
    this._healthCheckInterval = setInterval(() => {
      this._healthCheck().catch(err => {
        console.error('[relay] Health check error:', err.message);
      });
    }, 5000);
  }

  _stopHealthChecks() {
    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }
  }

  async shutdown() {
    if (this._closing) return;
    this._closing = true;
    this._state = States.CLOSING;

    console.log('[relay] Shutting down...');

    this._stopHealthChecks();

    const clientIds = Array.from(this.clients.keys());
    for (const clientId of clientIds) {
      const client = this.clients.get(clientId);
      if (client && !client.closed) {
        try {
          if (!client.socket.destroyed) {
            client.socket.destroy();
          }
          if (client.mcpProcess && !client.mcpProcess.killed) {
            client.mcpProcess.kill('SIGTERM');
          }
        } catch (err) {
          console.error(`[${clientId}] Error closing:`, err.message);
        }
      }
    }

    if (this.server) {
      try {
        await this.server.close();
      } catch (err) {
        console.error('[relay] Error closing DHT server:', err.message);
      }
    }

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

  async startServer(token, playwrightHost = 'localhost', seed = null) {
    if (this._state !== States.PENDING) {
      throw new Error('Relay already started');
    }

    this._state = States.OPENING;
    this._serveToken = token;
    this._servePort = 19988;

    try {
      await this.initialize();

      console.log('[relay] Starting playwriter serve...');
      this.serveProcess = spawn('playwriter', ['serve', '--token', token], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
      });

      this.serveProcess.stdout.on('data', (data) => {
        console.log('[serve:out]', data.toString().trim());
      });

      this.serveProcess.stderr.on('data', (data) => {
        console.log('[serve:err]', data.toString().trim());
      });

      this.serveProcess.on('error', (err) => {
        console.error('[relay] Failed to start playwriter serve:', err.message);
      });

      this.serveProcess.on('exit', (code, signal) => {
        console.error(`[relay] playwriter serve exited (code=${code}, signal=${signal})`);
        if (!this._closing) {
          this._attemptRecovery();
        }
      });

      console.log('[relay] Waiting for playwriter serve to be ready on port ' + this._servePort);
      await this._waitForPort(this._servePort);
      console.log('[relay] playwriter serve is ready');

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
      console.log(`- Each client gets isolated page via playwriter mcp subprocess`);

      const seedValue = seed || token;
      const hash = DHT.hash(Buffer.from(seedValue));
      const keyPair = DHT.keyPair(hash);
      await this.server.listen(keyPair);

      this._state = States.OPENED;
      this._recoveryAttempts = 0;
      this._startHealthChecks();

      return keyPair.publicKey.toString('hex');
    } catch (err) {
      this._state = States.CLOSED;
      console.error('[relay] Startup failed:', err.message);
      await this.shutdown();
      throw err;
    }
  }

  forwardClientToServe(clientId, socket) {
    if (!this._checkState()) {
      console.error(`[${clientId}] Error: relay not in opened state`);
      socket.end();
      return;
    }

    console.log(`[${clientId}] Spawning playwriter mcp for this client`);

    const mcpProcess = spawn('playwriter', ['mcp', '--host', 'localhost', '--token', this._serveToken], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const clientInfo = {
      socket,
      clientId,
      closed: false,
      mcpProcess
    };

    this.clients.set(clientId, clientInfo);

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
        if (mcpProcess && !mcpProcess.killed) {
          mcpProcess.kill('SIGTERM');
        }
      } catch (err) {
        console.error(`[${clientId}] Cleanup error: ${err.message}`);
      }
      console.log(`[${clientId}] Disconnected`);
    };

    mcpProcess.on('error', (err) => {
      console.error(`[${clientId}] MCP process error: ${err.message}`);
      cleanup();
    });

    mcpProcess.on('exit', (code, signal) => {
      console.error(`[${clientId}] MCP process exited (code=${code}, signal=${signal})`);
      cleanup();
    });

    pump(socket, mcpProcess.stdin, (err) => {
      if (err && !clientInfo.closed) {
        console.error(`[${clientId}] Stdin pump error: ${err.message}`);
        cleanup();
      }
    });

    pump(mcpProcess.stdout, socket, (err) => {
      if (err && !clientInfo.closed) {
        console.error(`[${clientId}] Stdout pump error: ${err.message}`);
        cleanup();
      }
    });

    mcpProcess.stderr.on('data', (data) => {
      console.log(`[${clientId}] mcp:err`, data.toString().trim());
    });

    socket.on('error', (err) => {
      console.error(`[${clientId}] Socket error: ${err.message}`);
      cleanup();
    });

    socket.on('end', cleanup);

    console.log(`[${clientId}] MCP stdio forwarding active`);
  }

  async connectClient(publicKey) {
    if (this._state !== States.PENDING) {
      throw new Error('Client already started');
    }

    this._state = States.OPENING;

    const keyBuffer = typeof publicKey === 'string' ? Buffer.from(publicKey, 'hex') : publicKey;

    await this.initialize();

    let attemptCount = 0;
    const maxAttempts = 10;

    const attemptConnection = async () => {
      attemptCount++;

      if (attemptCount > maxAttempts) {
        throw new Error(`Max connection attempts (${maxAttempts}) exceeded`);
      }

      console.log(`[client] Connection attempt ${attemptCount}/${maxAttempts}...`);

      const socket = this.node.connect(keyBuffer, { reusableSocket: true });
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
        }, 10000);

        socket.on('open', () => {
          connected = true;
          clearTimeout(timeout);
          console.log('[client] Connected to relay, forwarding stdio');
          this._state = States.OPENED;
          pump(process.stdin, socket, (err) => {
            if (err) console.error('[client] Stdin pump error:', err.message);
          });
          pump(socket, process.stdout, (err) => {
            if (err) console.error('[client] Stdout pump error:', err.message);
          });
          resolve();
        });

        socket.on('error', (err) => {
          console.error('[client] Connection failed:', err.message);
          reject(err);
        });

        socket.on('close', () => {
          if (connected) {
            console.log('[client] Connection closed');
            process.exit(0);
          }
        });
      });
    };

    return attemptConnection();
  }
}

module.exports = { PlaywriterRelay };
