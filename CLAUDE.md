# CLAUDE.md - playwriter-nat Implementation Guide

## Project Overview

**playwriter-nat** is a P2P relay server for [Playwriter MCP](https://github.com/remorses/playwriter) using [Hyperswarm DHT](https://github.com/hyperswarm/hyperswarm) for NAT traversal. It enables multiple isolated playwriter MCP clients to connect to a single relay server over peer-to-peer networks without requiring direct IP access or port forwarding.

**Key Architecture Decision**: All clients connect to a **single shared playwriter serve instance** via individual MCP subprocesses. Playwriter serve manages the Chrome extension and creates isolated browser pages per MCP client. This minimizes resource usage while providing complete isolation through the MCP protocol.

## Architecture

### Core Components

**1. Relay Server (`lib/relay.js`)**
- Main `PlaywriterRelay` class implementing P2P server and client modes
- **Server mode** (`startServer(token, playwrightHost, seed)`):
  - Starts MinimalServe (in-process HTTP server, no external dependency) on port 19988
  - Creates DHT server listening on deterministic key (derived from token or seed)
  - Authenticates clients via DHT public key verification
  - Forwards authenticated clients to MCP subprocesses
  - Health checks every 5 seconds with exponential backoff recovery

- **Client mode** (`connectClient(publicKey)`):
  - Connects to relay server via hyperswarm DHT with 10 retry attempts
  - DHT public key authentication (no separate token verification needed)
  - Bridges stdio ↔ socket for transparent MCP communication

**2. MinimalServe (`lib/minimal-serve.js`)**
- Lightweight HTTP server replacement for playwriter serve
- Listens on localhost:19988
- Zero external dependencies beyond Node.js built-ins
- Responds to health checks without spawning external process
- Ideal for Docker containers and resource-constrained environments

**3. CLI Interface (`lib/cli.js`)**
- Yargs-based command-line interface
- `serve` command: starts relay server (auto-generates token if not provided)
- `--seed` flag: enables persistent DHT key across restarts (same seed = same public key)
- Client mode: connects to existing relay (requires `--host` only)

**4. Entry Point (`bin/cli.js`)**
- Executable entry point
- Error handling for uncaught exceptions

### Data Flow

```
┌────────────────────────────────────────────────────────────────────┐
│ Server Side (Single Machine)                                       │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  playwriter-nat serve --seed persistent-key                │
│           │                                                       │
│           ├─ MinimalServe on localhost:19988 (HTTP health checks)│
│           │                                                       │
│           └─ Listen on hyperswarm DHT                            │
│              (public key = DHT.keyPair(DHT.hash(seed)))          │
│                                                                    │
│  Relay routes authenticated clients:                            │
│  ├─ Client 1 socket → spawn playwriter mcp                      │
│  │                    (isolated browser page via playwriter)     │
│  │                                                                │
│  └─ Client 2 socket → spawn playwriter mcp                      │
│                       (isolated browser page via playwriter)     │
│                                                                    │
│  Health checks every 5s:                                         │
│  └─ Test TCP connection to localhost:19988                      │
│     On failure: exponential backoff recovery (max 10 attempts)  │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│ Client Side (Remote Network)                                       │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Playwriter client ←→ Hyperswarm DHT ←→ Relay ←→ playwriter mcp │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## File Structure

```
playwriter-nat/
├── bin/
│   └── cli.js                # CLI entry point (executable, 22 lines)
├── lib/
│   ├── relay.js              # Core relay class with health checks (465 lines)
│   ├── cli.js                # CLI handler class (155 lines)
│   └── minimal-serve.js      # Lightweight HTTP server (light implementation)
├── package.json              # Dependencies: @hyperswarm/dht, pump, yargs
├── README.md                 # User-facing documentation
└── CLAUDE.md                 # This file (architecture & implementation guide)
```

## Usage

### Start Relay Server

```bash
# Using gxe (recommended)
npx -y gxe@latest AnEntrypoint/playwriter-nat serve

# With persistent key (same key on restart)
npx -y gxe@latest AnEntrypoint/playwriter-nat serve --seed my-persistent-key

# Or locally (if installed)
npm start
```

Output:
```
Playwriter NAT relay server started
- Each client gets isolated page via playwriter mcp subprocess
Public key: 1234567890abcdef...

Connect with:
  npx -y gxe@latest AnEntrypoint/playwriter-nat --host 1234567890abcdef...
```

### Connect Client

From a remote machine with network access to the relay server:

```bash
npx -y gxe@latest AnEntrypoint/playwriter-nat --host 1234567890abcdef...
```

This connects to the relay and bridges playwriter MCP via the P2P socket.

## Implementation Details

### Deterministic Key Generation with Seed

The public key for the relay server is deterministic based on token or seed:

```javascript
const seed = argv.seed || token;
const hash = DHT.hash(Buffer.from(seed));
const keyPair = DHT.keyPair(hash);
```

Using `--seed` enables persistent public key across server restarts. Without `--seed`, a new random token is generated each time.

### Authentication

1. Client connects to server's public key via hyperswarm DHT
2. DHT public key derivation from seed/token proves authentication
3. No separate token verification needed - connection to the public key IS authentication
4. Server accepts connection and spawns playwriter mcp subprocess for that client

### MinimalServe vs External Playwriter Serve

The relay can use either:
- **MinimalServe (default)**: Lightweight HTTP server, no external process, instant startup
- **External playwriter serve**: Requires `playwriter` CLI installed, enables advanced features

Configuration in `lib/relay.js`:
```javascript
this._useMinimalServe = true;  // Change to false for external serve
```

### Health Checks & Recovery

The relay continuously monitors its own health:

1. **Health Check Interval**: Every 5 seconds
2. **Check Method**: TCP connection to localhost:19988
3. **Recovery on Failure**:
   - Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
   - Max 10 recovery attempts
   - After max attempts: graceful shutdown with log

Example recovery flow:
```
[relay] Health check failed: cannot connect to localhost:19988
[relay] Recovery attempt 1/10 in 1000ms
[relay] Recovery attempt 2/10 in 2000ms
[relay] Recovery attempt 3/10 in 4000ms
...
[relay] Max recovery attempts exceeded
```

### Isolation

Each client gets its own `playwriter mcp` subprocess:

- **Per-client process**: Client 1 → subprocess 1, Client 2 → subprocess 2
- **Isolation enforced by**: Playwriter's per-page context management
- **Cleanup on disconnect**: Subprocess killed, socket destroyed, client removed from Map

### Error Handling

**Server side:**
- DHT initialization failures → log and exit
- Port bind failures → log and shutdown
- Client disconnect → cleanup subprocess + socket
- Health check failures → exponential backoff recovery

**Client side:**
- Connection timeout (30 seconds per attempt) → retry with backoff
- Max connection attempts (10) → error and exit(1)
- Socket error → logged and exit(1)
- Disconnection → clean exit(0)

## Persistence & Restarts

### Token vs Seed

- **Token**: Auto-generated 32-char hex on each startup (if not provided)
  - Different token = different public key
  - Clients need new public key each time server restarts

- **Seed**: User-provided string (optional)
  - Same seed = same public key across restarts
  - Clients can reconnect to persistent key

Example:
```bash
npx playwriter-nat serve --seed my-company-relay
# Always produces same public key for this seed

npx playwriter-nat serve
# Generates new random token each time (different public key)
```

## Testing & Verification

Testing is performed via **execution** (not test files). This validates:
- Class instantiation and internal structure
- All API methods exist with correct signatures
- Health check architecture (interval, recovery backoff)
- CLI command parsing
- Token/seed generation
- Package configuration correctness

All critical paths verified via execution (no test files committed).

## Deployment

### Prerequisites

- Node.js 14+ (specified in package.json)
- `@hyperswarm/dht` (installed)
- `pump` stream utility
- `yargs` CLI parsing
- **Optional**: `playwriter` CLI (only if using external serve instead of MinimalServe)

### Production Setup

1. Start relay server using gxe with persistent seed:
   ```bash
   npx -y gxe@latest AnEntrypoint/playwriter-nat serve --seed my-stable-key
   ```

2. Share connection details with clients (public key only)

3. Clients connect using gxe:
   ```bash
   npx -y gxe@latest AnEntrypoint/playwriter-nat --host <public-key>
   ```

### Network Requirements

- **Relay Server**: Must be reachable by at least one client (for DHT bootstrapping)
- **Clients**: Need network access to reach relay via hyperswarm DHT
- **Firewall**: No specific ports required (uses UDP/TCP via hyperswarm)

### Security Considerations

1. **DHT Key**: Derived from seed/token (not transmitted), proves knowledge of server's seed
2. **Network**: Runs over hyperswarm (encrypted by default)
3. **Isolation**: Enforced by playwriter mcp subprocesses and MCP protocol message IDs
4. **Authentication**: Via DHT public key (no separate token verification needed)

## Codebase Quality

**Lines of Code:**
- bin/cli.js: ~22 lines
- lib/cli.js: ~155 lines
- lib/relay.js: ~465 lines
- lib/minimal-serve.js: Lightweight implementation
- package.json: ~31 lines
- README.md: ~51 lines
- CLAUDE.md: This file
- **Total: All production code, zero test files**

**Constraints Enforced:**
- No comments (code is self-documenting)
- No magic constants (all configuration via function parameters)
- Zero dead code or test files
- Error logging on all code paths
- Health checks and recovery on all code paths
- State machine enforces lifecycle (PENDING → OPENING → OPENED or CLOSED)

## Known Limitations

1. **DHT Bootstrap**: Requires at least one client with external network access to bootstrap the DHT network
2. **Single Relay**: Design assumes one relay server (not distributed)
3. **MinimalServe**: Basic HTTP server, no advanced features (adequate for health checks)
4. **Network Dependent**: Requires functional hyperswarm DHT network (internet access)

## Future Improvements

Not implemented (out of scope):
- Load balancing across multiple relays
- Advanced authentication (OAuth, mTLS)
- Metrics/monitoring beyond health checks
- Database of connected clients
- Rate limiting or quotas

## Verification Checklist

✅ Code syntax valid (all files load without errors)
✅ Modules import correctly (@hyperswarm/dht, pump, yargs)
✅ PlaywriterRelay class instantiation verified
✅ All API methods exist with correct signatures
✅ Health check architecture verified (interval, recovery backoff)
✅ CLI parsing and commands work (serve, client modes)
✅ Token generation produces unique 32-char hex values
✅ Seed-based deterministic key generation verified
✅ Package.json correctly configured
✅ All production files present (no dead code)
✅ No test files (verified via execution only)
✅ Documentation complete (CLAUDE.md + README.md)
✅ Architecture matches user requirement: "isolated pages via per-client mcp subprocesses"
✅ MinimalServe HTTP server integrated
✅ Health checks and recovery system functional

## References

- [Playwriter MCP](https://github.com/remorses/playwriter)
- [Hyperswarm DHT](https://github.com/hyperswarm/hyperswarm)
- [Pump](https://github.com/mafintosh/pump) - Stream utility
- [Yargs](https://yargs.js.org/) - CLI parsing
