# Claude Max API Proxy

**Use your Claude Max subscription ($200/month) with any OpenAI-compatible client — no separate API costs!**

This proxy wraps the Claude Code CLI as a subprocess and exposes an OpenAI-compatible HTTP API, allowing tools like [OpenClaw](https://github.com/openclaw/openclaw), [Continue.dev](https://continue.dev/), or any OpenAI-compatible client to use your Claude Max subscription instead of paying per-API-call.

> Fork of [atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy) with subprocess pool prewarming, API key auth, effort control, and enhanced logging.

## Why This Exists

| Approach | Cost | Limitation |
|----------|------|------------|
| Claude API | ~$15/M input, ~$75/M output tokens | Pay per use |
| Claude Max | $200/month flat | OAuth blocked for third-party API use |
| **This Proxy** | $0 extra (uses Max subscription) | Routes through CLI |

Anthropic blocks OAuth tokens from being used directly with third-party API clients. The Claude Code CLI *can* use OAuth tokens. This proxy bridges the gap.

## How It Works

```
Your App (OpenClaw, Continue.dev, etc.)
         ↓
    HTTP Request (OpenAI format)
         ↓
   Claude Max API Proxy
         ↓
   Subprocess Pool (prewarmed)
         ↓
   Claude Code CLI (spawn)
         ↓
   Anthropic API (via OAuth)
         ↓
   Response → OpenAI format → Your App
```

## Features

- **OpenAI-compatible API** — Drop-in replacement for OpenAI endpoints
- **Subprocess pool with prewarming** — Pre-spawns CLI processes to eliminate cold-start latency
- **Streaming support** — Real-time SSE with TTFB tracking and client disconnect detection
- **Multiple models** — Opus, Sonnet, Haiku with flexible aliases
- **API key authentication** — Optional Bearer token auth via `PROXY_API_KEY`
- **Effort control** — Pass `effort` parameter (low/medium/high) to control reasoning depth
- **Tool restrictions** — Pass `tools_allowed` to limit available CLI tools
- **Session management** — Map `user` field to persistent CLI sessions
- **Zero configuration** — Uses existing Claude CLI authentication
- **Secure by design** — `spawn()` (not shell) prevents injection attacks

## Prerequisites

1. **Claude Max subscription** ($200/month) — [Subscribe here](https://claude.ai)
2. **Claude Code CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth login
   ```

## Installation

```bash
git clone https://github.com/zhouyunmail/claude-max-api-proxy.git
cd claude-max-api-proxy
npm install
npm run build
```

## Quick Start

```bash
# Start the server (default: 127.0.0.1:3456)
npm start

# Or with custom config
PROXY_HOST=0.0.0.0 POOL_SIZE=5 PROXY_API_KEY=my-secret npm start
```

## Usage Examples

```bash
# Health check (includes pool stats)
curl http://localhost:3456/health

# List available models
curl http://localhost:3456/v1/models

# Chat completion (non-streaming)
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-secret" \
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Chat completion (streaming)
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Explain quicksort"}],
    "stream": true
  }'

# With effort control
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Solve this math problem..."}],
    "effort": "high"
  }'
```

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="my-secret"  # or "not-needed" if PROXY_API_KEY is not set
)

response = client.chat.completions.create(
    model="claude-sonnet-4",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

### Continue.dev

```json
{
  "models": [{
    "title": "Claude (Max)",
    "provider": "openai",
    "model": "claude-sonnet-4",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "not-needed"
  }]
}
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check with pool stats (size, ready, hit rate) |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completions (streaming & non-streaming) |

## Available Models

| Model ID | Aliases | Description |
|----------|---------|-------------|
| `claude-opus-4` | `opus`, `claude-opus-4-6` | Most capable, best for complex tasks |
| `claude-sonnet-4` | `sonnet`, `claude-sonnet-4-5`, `claude-sonnet-4-6` | Balanced performance and speed |
| `claude-haiku-4` | `haiku`, `claude-haiku-4-5` | Fastest, best for simple tasks |

Unknown model names default to Opus.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_HOST` | `127.0.0.1` | Bind address (use `0.0.0.0` for network access) |
| `PROXY_API_KEY` | _(none)_ | Bearer token for `/v1/*` routes (optional) |
| `CLAUDE_BIN` | `claude` | Path to Claude Code CLI binary |
| `POOL_SIZE` | `3` | Number of pre-warmed processes per model |
| `DEBUG` | _(none)_ | Set `1` to log request paths and body samples |
| `DEBUG_SUBPROCESS` | _(none)_ | Set `1` to log subprocess I/O |

## Subprocess Pool

The proxy maintains a pool of pre-spawned Claude CLI processes to minimize response latency:

- **Prewarming** — `POOL_SIZE` processes per model are spawned at startup
- **Hit/Miss tracking** — Pool stats available via `/health` endpoint
- **Auto-cleanup** — Idle processes (>5 min) are killed and replaced
- **Cold-start fallback** — If pool is empty or request needs special args (session/effort/tools), a new process is spawned on demand

## Running as a Service

### systemd (Linux)

```bash
# Enable and start
systemctl --user enable claude-max-api-proxy
systemctl --user start claude-max-api-proxy

# Check status / logs
systemctl --user status claude-max-api-proxy
journalctl --user -u claude-max-api-proxy -f
```

### launchctl (macOS)

```bash
# Start
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist

# Restart
launchctl kickstart -k gui/$(id -u)/com.openclaw.claude-max-proxy

# Stop
launchctl bootout gui/$(id -u)/com.openclaw.claude-max-proxy
```

## Architecture

```
src/
├── types/
│   ├── claude-cli.ts      # Claude CLI JSON streaming types
│   └── openai.ts          # OpenAI API types (request/response/tool calls)
├── adapter/
│   ├── openai-to-cli.ts   # OpenAI request → CLI format + model mapping
│   └── cli-to-openai.ts   # CLI response → OpenAI format + token tracking
├── subprocess/
│   ├── manager.ts         # CLI process lifecycle + tool name mapping
│   └── pool.ts            # Process pool with prewarming + hit/miss stats
├── server/
│   ├── index.ts           # Express server + auth middleware
│   ├── routes.ts          # API route handlers (streaming + non-streaming)
│   └── standalone.ts      # Entry point
└── index.ts               # Package exports
```

## Troubleshooting

**"Claude CLI not found"** — Install and authenticate:
```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

**Streaming returns empty** — Use `-N` flag with curl to disable buffering.

**High latency on first request** — The pool may still be warming up. Check `/health` for pool readiness.

## License

MIT

## Acknowledgments

- Originally created by [atalovesyou](https://github.com/atalovesyou/claude-max-api-proxy)
- Powered by [Claude Code CLI](https://github.com/anthropics/claude-code)
