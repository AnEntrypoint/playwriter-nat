# playwriter-nat

P2P relay for [playwriter](https://github.com/remorses/playwriter) using hyperswarm for NAT traversal. Multiple clients connect to a single shared playwriter serve instance with isolated pages per client.

## Quick Start

[gxe](https://github.com/AnEntrypoint/gxe) runs npx-compatible projects directly from GitHub:

### Server (where Chrome runs)

```bash
npx -y gxe@latest AnEntrypoint/playwriter-nat serve
```

This outputs:
```
Public key: 1a2b3c4d5e6f7g8h...
```

### Client (any machine)

```bash
npx -y gxe@latest AnEntrypoint/playwriter-nat --host 1a2b3c4d5e6f7g8h...
```

Each client gets its own isolated playwriter page context. No installation needed - gxe clones, installs, and runs in one command.

---

## How It Works

- **Server**: Spawns playwriter serve, listens on DHT for client connections
- **Client**: Connects over hyperswarm, forwards stdio to shared playwriter serve
- **Isolation**: Each client gets isolated page context, protected by MCP message IDs
- **Queuing**: Atomic message queue prevents command interleaving

---

## Features

- **Zero setup**: Single command, DHT-based authentication
- **Per-client isolation**: Each client has independent page context
- **P2P tunneling**: Works across NAT without port forwarding
- **Minimal code**: Production-ready, fully tested
- **Atomic delivery**: Prevents protocol corruption and interleaving

---

## License

MIT
