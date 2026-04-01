# @mammoth-protocol/mcp-server

MCP (Model Context Protocol) server for [Mammoth Protocol](https://mammoth-protocol.vercel.app).

Makes Mammoth a native tool for any LLM agent — Claude, GPT, Gemini, Eliza, Virtuals, ai16z, and any other MCP-compatible system. No custom integration per agent. One server, all of them.

---

## Quick Start

```bash
npx @mammoth-protocol/mcp-server
```

Read-only by default (discovery, quotes, snapshots). Add a wallet for buy execution:

```bash
MAMMOTH_WALLET_KEY='[your-keypair-json-array]' npx @mammoth-protocol/mcp-server
```

---

## Connect to Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mammoth": {
      "command": "npx",
      "args": ["@mammoth-protocol/mcp-server"],
      "env": {
        "SOLANA_CLUSTER": "devnet"
      }
    }
  }
}
```

With buy execution:

```json
{
  "mcpServers": {
    "mammoth": {
      "command": "npx",
      "args": ["@mammoth-protocol/mcp-server"],
      "env": {
        "SOLANA_CLUSTER": "mainnet-beta",
        "SOLANA_RPC_URL": "https://your-rpc-endpoint.com",
        "MAMMOTH_WALLET_KEY": "[your,keypair,as,json,array]"
      }
    }
  }
}
```

---

## Connect to Cursor / Windsurf / Cline

Add to your MCP config file (`.cursor/mcp.json` or equivalent):

```json
{
  "mcpServers": {
    "mammoth": {
      "command": "npx",
      "args": ["@mammoth-protocol/mcp-server"]
    }
  }
}
```

---

## Connect to a Custom Agent (Eliza, Virtuals, ai16z)

```js
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['@mammoth-protocol/mcp-server'],
  env: { SOLANA_CLUSTER: 'devnet' },
});

const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(transport);

// List all open cycles
const result = await client.callTool({ name: 'mammoth_get_open_cycles', arguments: {} });
console.log(result.content[0].text);

// Get snapshot for a specific project
const snap = await client.callTool({
  name: 'mammoth_get_cycle_snapshot',
  arguments: { mintAddress: 'YOUR_MINT_ADDRESS' }
});

// Get a buy quote
const quote = await client.callTool({
  name: 'mammoth_buy_quote',
  arguments: { mintAddress: 'YOUR_MINT_ADDRESS', solAmount: 0.5 }
});
```

---

## Available Tools

| Tool | Description |
|---|---|
| `mammoth_get_open_cycles` | All active cycles with price, fill %, and curve type |
| `mammoth_get_cycle_snapshot` | Full decision snapshot for a specific mint |
| `mammoth_get_projects` | All Mammoth projects with supply mode and cycle count |
| `mammoth_get_rights_window_cycles` | Cycles where rights window is currently open |
| `mammoth_check_rights` | Check if a wallet has unexercised rights |
| `mammoth_buy_quote` | Calculate tokens out for SOL in — no transaction |
| `mammoth_buy_tokens` | Execute a buy (requires `MAMMOTH_WALLET_KEY`) |
| `mammoth_protocol_reference` | Full protocol mechanics and parameter reference |

## Available Resources

| URI | Description |
|---|---|
| `mammoth://protocol/reference` | Protocol constants and parameter definitions |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SOLANA_RPC_URL` | Devnet public RPC | RPC endpoint (use a private endpoint for production) |
| `SOLANA_CLUSTER` | `devnet` | `devnet` or `mainnet-beta` |
| `MAMMOTH_WALLET_KEY` | none | Keypair as JSON array or base58 string. Required for buy execution. |

---

## Why Mammoth for AI Agents

Mammoth Protocol is designed for autonomous participation:

- **Bounded curves** — deterministic pricing. A bot calculates exact cost before submitting. No AMM slippage surprises.
- **Cycle events** — agents only need to act at defined moments (cycle open, rights window, close). No constant monitoring required.
- **Rights system** — a bot holding from Cycle 1 gets guaranteed first access to Cycle 2 at base price. Structurally advantaged position.
- **AuthorityConfig** — a principal (human or AI) can delegate specific operations to an operator bot with explicit permissions and spending limits.

```
No other launchpad was built for this.
```

---

## For Portfolio AI Agents

If you're building an AI that manages a user's high-growth crypto allocation:

1. Call `mammoth_get_open_cycles` to discover available cycles
2. Call `mammoth_get_cycle_snapshot` on interesting projects
3. Call `mammoth_buy_quote` to calculate exact outcome
4. Present to user or execute autonomously (if authorized)
5. Subscribe to `CycleOpened` events via the SDK for zero-latency triggers

The whole flow is programmatic. No UI. No human clicking buttons.

---

## SDK

For direct programmatic access (without MCP):

```bash
npm install @mammoth-protocol/sdk
```

[SDK docs →](https://github.com/kelvinsinferno/mammoth-sdk)

---

## Links

- **Protocol:** https://mammoth-protocol.vercel.app
- **AI Reference:** https://mammoth-protocol.vercel.app/ai-reference
- **Protocol Reference:** https://mammoth-protocol.vercel.app/protocol
- **SDK:** https://github.com/kelvinsinferno/mammoth-sdk

---

MIT — Kelvinsinferno Studio
