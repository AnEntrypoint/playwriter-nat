const WebSocket = require('ws');
const http = require('http');

class MinimalServe {
  constructor(port = 19988) {
    this.port = port;
    this.server = null;
    this.wss = null;
    this.extensionSocket = null;
    this.mcpClients = new Map();
    this.clientSessions = new Map();
    this.sessionToClient = new Map();
    this.availableSessions = [];
    this.usedSessions = new Set();
    this.messageId = 0;
    this.pendingRequests = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
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

      const errorHandler = (err) => {
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
          this.handleCDP(ws);
        }
      });

      this.wss.once('error', errorHandler);
      this.server.once('error', errorHandler);

      this.server.listen(this.port, 'localhost', () => {
        this.wss.removeListener('error', errorHandler);
        this.server.removeListener('error', errorHandler);
        console.log(`[minimal-serve] Listening on port ${this.port}`);
        console.log(`[minimal-serve] Client isolation: ENABLED`);
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

        if (msg.method === 'forwardCDPEvent' && msg.params?.method === 'Target.attachedToTarget') {
          const sessionId = msg.params?.params?.sessionId;
          if (sessionId && !this.usedSessions.has(sessionId) && !this.availableSessions.includes(sessionId)) {
            this.availableSessions.push(sessionId);
            console.log(`[minimal-serve] Tab available: ${sessionId}`);
          }
        }

        if (msg.id && this.pendingRequests.has(msg.id)) {
          const { resolve, clientId } = this.pendingRequests.get(msg.id);
          this.pendingRequests.delete(msg.id);
          resolve(msg);
          return;
        }

        if (msg.method === 'forwardCDPEvent' && msg.params?.sessionId) {
          const sessionId = msg.params.sessionId;
          const clientId = this.sessionToClient.get(sessionId);
          if (clientId) {
            const client = this.mcpClients.get(clientId);
            if (client && client.ws.readyState === WebSocket.OPEN) {
              client.ws.send(JSON.stringify(msg));
              return;
            }
          }
        }

        if (msg.sessionId) {
          const clientId = this.sessionToClient.get(msg.sessionId);
          if (clientId) {
            const client = this.mcpClients.get(clientId);
            if (client && client.ws.readyState === WebSocket.OPEN) {
              client.ws.send(JSON.stringify(msg));
              return;
            }
          }
        }

        for (const [id, client] of this.mcpClients) {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(msg));
          }
        }
      } catch (e) {
        console.error('[extension] Parse error:', e.message);
      }
    });

    ws.on('close', () => {
      console.log('[minimal-serve] Chrome extension disconnected');
      this.extensionSocket = null;
      this.availableSessions = [];
    });
  }

  assignSessionToClient(clientId) {
    if (this.availableSessions.length > 0) {
      const sessionId = this.availableSessions.shift();
      this.usedSessions.add(sessionId);
      this.clientSessions.set(clientId, sessionId);
      this.sessionToClient.set(sessionId, clientId);
      console.log(`[${clientId}] Assigned isolated session: ${sessionId}`);
      return sessionId;
    }
    return null;
  }

  releaseSessionFromClient(clientId) {
    const sessionId = this.clientSessions.get(clientId);
    if (sessionId) {
      this.clientSessions.delete(clientId);
      this.sessionToClient.delete(sessionId);
      this.usedSessions.delete(sessionId);
      this.availableSessions.push(sessionId);
      console.log(`[${clientId}] Released session: ${sessionId}`);
    }
  }

  handleCDP(ws) {
    const clientId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    console.log(`[minimal-serve] CDP client connected: ${clientId}`);

    const clientInfo = { ws, sessionId: null };
    this.mcpClients.set(clientId, clientInfo);

    setTimeout(() => {
      const sessionId = this.assignSessionToClient(clientId);
      if (sessionId) {
        clientInfo.sessionId = sessionId;
      } else {
        console.log(`[${clientId}] No available sessions, will share default`);
      }
    }, 500);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Handle browser-level commands locally (no session required)
        if (msg.method === 'Browser.getVersion') {
          ws.send(JSON.stringify({
            id: msg.id,
            result: {
              protocolVersion: '1.3',
              product: 'Chrome/Extension-Relay',
              revision: '1.0.0',
              userAgent: 'PlaywriterRelay/1.0',
              jsVersion: 'V8'
            }
          }));
          return;
        }

        if (msg.method === 'Target.setDiscoverTargets' || msg.method === 'Target.setAutoAttach') {
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
          // Send existing tabs as attached targets
          if (msg.method === 'Target.setAutoAttach' && this.availableSessions.length > 0) {
            const sessionId = this.assignSessionToClient(clientId);
            if (sessionId) {
              clientInfo.sessionId = sessionId;
              ws.send(JSON.stringify({
                method: 'Target.attachedToTarget',
                params: {
                  sessionId: sessionId,
                  targetInfo: {
                    targetId: sessionId,
                    type: 'page',
                    title: 'Playwriter Tab',
                    url: 'about:blank',
                    attached: true,
                    browserContextId: 'default-context',
                    canAccessOpener: false
                  },
                  waitingForDebugger: false
                }
              }));
            }
          }
          return;
        }

        if (msg.method === 'Target.getTargets') {
          const targets = [];
          for (const [cid, info] of this.clientSessions) {
            targets.push({
              targetId: info,
              type: 'page',
              title: 'Playwriter Tab',
              url: 'about:blank',
              attached: true
            });
          }
          ws.send(JSON.stringify({ id: msg.id, result: { targetInfos: targets } }));
          return;
        }

        if (!this.extensionSocket || this.extensionSocket.readyState !== WebSocket.OPEN) {
          ws.send(JSON.stringify({
            id: msg.id,
            error: { code: -32000, message: 'Extension not connected' }
          }));
          return;
        }

        const sessionId = this.clientSessions.get(clientId);
        if (sessionId && !msg.sessionId) {
          msg.sessionId = sessionId;
        }

        const wrappedMsg = {
          id: ++this.messageId,
          method: 'forwardCDPCommand',
          params: {
            method: msg.method,
            params: msg.params,
            sessionId: msg.sessionId
          }
        };

        this.pendingRequests.set(wrappedMsg.id, {
          resolve: (result) => {
            ws.send(JSON.stringify({
              id: msg.id,
              result: result.result,
              error: result.error
            }));
          },
          clientId
        });

        this.extensionSocket.send(JSON.stringify(wrappedMsg));
      } catch (e) {
        console.error(`[cdp:${clientId}] Parse error:`, e.message);
      }
    });

    ws.on('close', () => {
      console.log(`[minimal-serve] CDP client disconnected: ${clientId}`);
      this.releaseSessionFromClient(clientId);
      this.mcpClients.delete(clientId);
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.extensionSocket) {
        this.extensionSocket.close();
      }

      for (const [id, client] of this.mcpClients) {
        client.ws.close();
      }
      this.mcpClients.clear();
      this.clientSessions.clear();
      this.sessionToClient.clear();
      this.availableSessions = [];
      this.usedSessions.clear();

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
    .then(() => console.log('[minimal-serve] Ready with isolation'))
    .catch((err) => {
      console.error('[minimal-serve] Failed:', err.message);
      process.exit(1);
    });

  process.on('SIGTERM', () => serve.stop().then(() => process.exit(0)));
  process.on('SIGINT', () => serve.stop().then(() => process.exit(0)));
}

module.exports = { MinimalServe };
