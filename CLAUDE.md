# Claude Max API Proxy

OpenAI-compatible API proxy that wraps the Claude Code CLI.

## Build

```bash
npm run build    # Compile TypeScript
npm run dev      # Watch mode for development
```

## Service Management

The proxy runs as a Linux systemd --user service on port 3456.

**Service file:** `~/.config/systemd/user/claude-max-api-proxy.service`

**Logs:** `journalctl --user -u claude-max-api-proxy -f`

### Restart the service

```bash
systemctl --user restart claude-max-api-proxy
```

### Stop the service

```bash
systemctl --user stop claude-max-api-proxy
```

### Start the service

```bash
systemctl --user start claude-max-api-proxy
```

### Reload after service file changes

```bash
systemctl --user daemon-reload
systemctl --user restart claude-max-api-proxy
```

### Check status

```bash
systemctl --user status claude-max-api-proxy
```

## Architecture

- `src/types/claude-cli.ts` - Claude CLI JSON streaming types and type guards
- `src/types/openai.ts` - OpenAI-compatible API types
- `src/adapter/openai-to-cli.ts` - Converts OpenAI requests to CLI input
- `src/adapter/cli-to-openai.ts` - Converts CLI output to OpenAI responses
- `src/subprocess/manager.ts` - Spawns and manages Claude CLI subprocesses
- `src/server/routes.ts` - Express route handlers (streaming + non-streaming)
- `src/server/standalone.js` - Server entry point
