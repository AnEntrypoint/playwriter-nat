const WebSocket = require('ws');
const http = require('http');

class MinimalServe {
  constructor(port = 19988) {
    this.port = port;
    this.server = null;
    this.wss = null;
    this.extensionSocket = null;
    this.mcpClients = new Map();
    this.messageId = 0;
    this.pendingRequests = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        // Handle all HTTP requests - respond with health check response
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          type: 'remote-relay',
          serving: true,
          version: '1.0.0',
          chromium: true,
          protocol: { major: 1, minor: 3 }
        }));
      });

      const wssErrorHandler = (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.port} already in use`));
        } else {
          reject(err);
        }
      };

      const serverErrorHandler = (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.port} already in use`));
        } else {
          reject(err);
        }
      };

      this.wss = new WebSocket.Server({ server: this.server });

      this.wss.on('connection', (ws, req) => {
        const path = req.url;

        if (path === '/extension' || path.includes('extension')) {
          this.handleExtension(ws);
        } else if (path === '/cdp' || path.includes('cdp')) {
          this.handleCDP(ws);
        } else {
          this.handleMCP(ws);
        }
      });

      this.wss.once('error', wssErrorHandler);
      this.server.once('error', serverErrorHandler);

      this.server.listen(this.port, 'localhost', () => {
        this.wss.removeListener('error', wssErrorHandler);
        this.server.removeListener('error', serverErrorHandler);

        this.server.on('error', (err) => {
          console.error('[minimal-serve] Server error:', err.message);
        });

        this.wss.on('error', (err) => {
          console.error('[minimal-serve] WebSocket error:', err.message);
        });

        console.log(`[minimal-serve] Listening on port ${this.port}`);
        console.log(`[minimal-serve] HTTP health checks: http://localhost:${this.port}/health`);
        console.log(`[minimal-serve] WebSocket Extension: ws://localhost:${this.port}/extension`);
        console.log(`[minimal-serve] WebSocket CDP: ws://localhost:${this.port}/cdp`);
        resolve();
      });
    });
  }

  handleExtension(ws) {
    console.log('[minimal-serve] Chrome extension connected');
    this.extensionSocket = ws;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log('[extension→serve]', JSON.stringify(msg).substring(0, 100));

        if (msg.id && this.pendingRequests.has(msg.id)) {
          const { resolve } = this.pendingRequests.get(msg.id);
          this.pendingRequests.delete(msg.id);
          resolve(msg);
        }

        for (const [id, client] of this.mcpClients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(msg));
          }
        }
      } catch (e) {
        console.error('[extension] Parse error:', e.message);
      }
    });

    ws.on('close', () => {
      console.log('[minimal-serve] Chrome extension disconnected');
      this.extensionSocket = null;
    });

    ws.on('error', (err) => {
      console.error('[extension] Error:', err.message);
    });
  }

  handleCDP(ws) {
    const clientId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    console.log(`[minimal-serve] CDP client connected: ${clientId}`);
    this.mcpClients.set(clientId, ws);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log(`[cdp:${clientId}→serve]`, JSON.stringify(msg).substring(0, 80));

        if (this.extensionSocket && this.extensionSocket.readyState === WebSocket.OPEN) {
          this.extensionSocket.send(JSON.stringify(msg));
        } else {
          ws.send(JSON.stringify({
            id: msg.id,
            error: { code: -32000, message: 'Extension not connected' }
          }));
        }
      } catch (e) {
        console.error(`[cdp:${clientId}] Parse error:`, e.message);
      }
    });

    ws.on('close', () => {
      console.log(`[minimal-serve] CDP client disconnected: ${clientId}`);
      this.mcpClients.delete(clientId);
    });
  }

  handleMCP(ws) {
    this.handleCDP(ws);
  }

  sendToExtension(msg) {
    return new Promise((resolve, reject) => {
      if (!this.extensionSocket || this.extensionSocket.readyState !== WebSocket.OPEN) {
        reject(new Error('Extension not connected'));
        return;
      }

      const id = ++this.messageId;
      msg.id = id;

      this.pendingRequests.set(id, { resolve, reject });

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000);

      this.extensionSocket.send(JSON.stringify(msg));
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.extensionSocket) {
        this.extensionSocket.close();
      }

      for (const [id, client] of this.mcpClients) {
        client.close();
      }
      this.mcpClients.clear();

      if (this.server) {
        this.server.close(() => {
          console.log('[minimal-serve] Stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

if (require.main === module) {
  const serve = new MinimalServe(19988);

  serve.start()
    .then(() => {
      console.log('[minimal-serve] Ready');
    })
    .catch((err) => {
      console.error('[minimal-serve] Failed to start:', err.message);
      process.exit(1);
    });

  process.on('SIGTERM', () => {
    serve.stop().then(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    serve.stop().then(() => process.exit(0));
  });
}

module.exports = { MinimalServe };
