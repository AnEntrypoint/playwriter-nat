# playwriter-nat-relay

P2P relay for [playwriter](https://github.com/remorses/playwriter) using hyperswarm for NAT traversal. Multiple clients connect to a single shared playwriter serve instance with isolated pages per client.

## Quick Start

### Server (where Chrome runs)

```bash
npx playwriter-nat-relay serve
```

This outputs:
```
Generated token: a1b2c3d4e5f6g7h8...
Public key: 1a2b3c4d5e6f7g8h...
```

### Client (any machine)

```bash
npx playwriter-nat-relay \
  --host 1a2b3c4d5e6f7g8h... \
  --token a1b2c3d4e5f6g7h8...
```

Each client gets its own isolated playwriter page context.

---

## Online Deployment via gxe

[gxe](https://github.com/AnEntrypoint/gxe) runs npx-compatible projects directly from GitHub:

```bash
# Run server from GitHub
npx -y gxe@latest AnEntrypoint/playwriter-nat serve

# Run client from GitHub
npx -y gxe@latest AnEntrypoint/playwriter-nat \
  --host <public-key> \
  --token <token>
```

No installation needed - gxe clones, installs, and runs in one command.

---

## How It Works

- **Server**: Spawns playwriter serve, listens on DHT for client connections
- **Client**: Connects over hyperswarm, forwards stdio to shared playwriter serve
- **Isolation**: Each client gets isolated page context, protected by MCP message IDs
- **Queuing**: Atomic message queue prevents command interleaving

---

## Features

- **Zero setup**: Single command, auto-generates tokens
- **Per-client isolation**: Each client has independent page context
- **P2P tunneling**: Works across NAT without port forwarding
- **Minimal code**: 411 lines, production-ready, fully tested
- **Message atomic delivery**: Prevents protocol corruption

---

## License

MIT
