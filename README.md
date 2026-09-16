# Ikuna MCP

Connect your AI client to the workspace context in the Ikuna app running on your Mac.

`ikuna-mcp` 0.1.1 is listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=ikuna) as `io.github.RobertoHanas/ikuna-mcp`.

## Connect

1. Install Node.js 18 or later, including `npx`.
2. Open Ikuna and enable the capabilities you want to share in **Settings → AI Connections**.
3. Add this entry to your MCP client's `mcpServers` configuration, keeping your other servers:

```json
"ikuna": { "command": "npx", "args": ["-y", "ikuna-mcp"] }
```

For clients such as Claude Desktop, Claude Code, and Cursor, a complete JSON configuration is:

```json
{
  "mcpServers": {
    "ikuna": {
      "command": "npx",
      "args": ["-y", "ikuna-mcp"]
    }
  }
}
```

For Codex, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.ikuna]
command = "npx"
args = ["-y", "ikuna-mcp"]
startup_timeout_sec = 30
```

Restart or reconnect your MCP client after saving. Ask it to check Ikuna's health, then ask about your workspace. Your available tools depend on the capabilities enabled in Ikuna.

The first run downloads this small package from npm. Later runs use npm's cache. If your client cannot find `npx`, use the full executable path reported by `command -v npx` as `command` and ensure Node.js is on that client's `PATH`.

## Requirements and troubleshooting

This package runs locally on macOS. It requires an Ikuna build that includes the MCP helper at `Contents/bin/ikuna-mcp`.

- **Ikuna is installed but closed:** open Ikuna, leave it running, and reconnect the MCP client. The npm bridge exits with an error when Ikuna is closed; it does not open the app for you.
- **Ikuna is not installed:** install it from [the official Ikuna product page](https://www.brnsft.com/ikuna), open it, and reconnect the MCP client.
- **MCP helper unavailable:** update Ikuna to a build with AI Connections support.
- **Discovery timeout:** quit and reopen Ikuna, then retry. Running-app discovery has a short deadline and errors are written to stderr, never mixed with MCP responses.
- **More than one Ikuna copy running:** quit the extra copies. All copies share the local bridge service, so use one running installation at a time.
- **Tools unavailable or approval required:** review the capabilities in Ikuna's AI Connections settings. Installing this package does not change permissions.

Custom installation locations are discovered automatically from the running app. To select a particular running bundle explicitly:

```json
"ikuna": {
  "command": "npx",
  "args": ["-y", "ikuna-mcp", "--app-path", "/Applications/Ikuna.app"]
}
```

`IKUNA_APP_PATH` is the equivalent environment variable. A selected bundle must already be running. The optional `IKUNA_MCP_CLIENT_ID` environment variable is passed through to Ikuna for connection bookkeeping; it does not grant access.

## How it works

```text
MCP client → npx ikuna-mcp → Ikuna.app/Contents/bin/ikuna-mcp → local XPC bridge → Ikuna
```

The npm package discovers the running Ikuna bundle and launches its embedded native helper with the client's stdio streams. The native helper provides the signed XPC connection, request deadlines, and per-client protocol sessions. Ikuna remains responsible for tools, workspace data, approvals, and mutations. The package has no runtime dependencies, reads no workspace database, and opens no network listener.

The MCP Registry manifest is included as `server.json`. Maintainers can follow [RELEASE.md](RELEASE.md) to publish the npm package and listing together.
