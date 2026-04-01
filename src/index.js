#!/usr/bin/env node
/**
 * @mammoth-protocol/mcp-server
 *
 * MCP server for Mammoth Protocol. Exposes Mammoth on-chain data and
 * buy execution as native tools for any MCP-compatible AI agent.
 *
 * Compatible with: Claude Desktop, Cursor, Windsurf, Cline, Eliza,
 * Virtuals, ai16z, and any agent using the Model Context Protocol.
 *
 * Usage:
 *   npx @mammoth-protocol/mcp-server
 *
 * With wallet (for buy execution):
 *   MAMMOTH_WALLET_KEY=[base58-private-key] npx @mammoth-protocol/mcp-server
 *
 * With custom RPC:
 *   SOLANA_RPC_URL=https://your-rpc.com npx @mammoth-protocol/mcp-server
 */

'use strict';

const { McpServer, ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { MammothClient, MammothMonitor, DEVNET_RPC, MAINNET_RPC } = require('@mammoth-protocol/sdk');

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC_URL = process.env.SOLANA_RPC_URL || DEVNET_RPC;
const WALLET_KEY = process.env.MAMMOTH_WALLET_KEY || null;
const CLUSTER = process.env.SOLANA_CLUSTER || 'devnet';

// ─── Setup ───────────────────────────────────────────────────────────────────

const connection = new Connection(RPC_URL, 'confirmed');

let wallet = null;
if (WALLET_KEY) {
  try {
    const secretKey = Uint8Array.from(JSON.parse(WALLET_KEY));
    const keypair = Keypair.fromSecretKey(secretKey);
    wallet = {
      publicKey: keypair.publicKey,
      signTransaction: async (tx) => { tx.sign(keypair); return tx; },
      signAllTransactions: async (txs) => txs.map(tx => { tx.sign(keypair); return tx; }),
    };
  } catch {
    // wallet key not parseable as JSON array — try base58
    try {
      const bs58 = require('bs58');
      const secretKey = bs58.decode(WALLET_KEY);
      const keypair = Keypair.fromSecretKey(secretKey);
      wallet = {
        publicKey: keypair.publicKey,
        signTransaction: async (tx) => { tx.sign(keypair); return tx; },
        signAllTransactions: async (txs) => txs.map(tx => { tx.sign(keypair); return tx; }),
      };
    } catch {
      console.error('[mammoth-mcp] Warning: MAMMOTH_WALLET_KEY could not be parsed. Buy execution will be unavailable.');
    }
  }
}

const client = new MammothClient({ connection, wallet, cluster: CLUSTER });
const monitor = new MammothMonitor({ connection });

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'mammoth-protocol',
  version: '0.1.0',
  description: 'Mammoth Protocol — cycle-driven token issuance on Solana. Raises with rights-based anti-dilution for existing holders. Bounded bonding curves. Deterministic treasury routing.',
});

// ─────────────────────────────────────────────────────────────────────────────
//  TOOLS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * mammoth_get_open_cycles
 * List all currently active cycles. The primary discovery tool for agents
 * scanning for entry opportunities.
 */
server.tool(
  'mammoth_get_open_cycles',
  'List all Mammoth Protocol cycles where public buying is currently open. Returns price, fill %, curve type, and supply for each active cycle.',
  {},
  async () => {
    try {
      const cycles = await monitor.getOpenCycles();
      if (cycles.length === 0) {
        return { content: [{ type: 'text', text: 'No active cycles found on Mammoth Protocol at this time.' }] };
      }
      const lines = cycles.map(c => {
        const pct = c.cycle.supplyCap.toNumber() > 0
          ? ((c.cycle.minted.toNumber() / c.cycle.supplyCap.toNumber()) * 100).toFixed(1)
          : '0.0';
        const priceSOL = (c.cycle.basePrice.toNumber() / 1e9).toFixed(6);
        const curveKey = Object.keys(c.cycle.curveType)[0];
        return `- Mint: ${c.projectMint}\n  Cycle #${c.cycle.cycleIndex} | Curve: ${curveKey} | Price: ${priceSOL} SOL | Fill: ${pct}% | Cap: ${c.cycle.supplyCap.toNumber().toLocaleString()} tokens`;
      });
      return {
        content: [{
          type: 'text',
          text: `**Active Mammoth Cycles (${cycles.length})**\n\n${lines.join('\n\n')}\n\nUse mammoth_get_cycle_snapshot with a mint address for full details and buy quotes.`,
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error fetching cycles: ${err.message}` }] };
    }
  }
);

/**
 * mammoth_get_cycle_snapshot
 * Full decision snapshot for a single cycle — everything an agent needs
 * to make a buy decision.
 */
server.tool(
  'mammoth_get_cycle_snapshot',
  'Get a full snapshot of the current cycle for a Mammoth project — price, fill progress, curve type, rights window status, and key parameters. Use this before buying.',
  { mintAddress: z.string().describe('The Solana mint address of the Mammoth project token (base58)') },
  async ({ mintAddress }) => {
    try {
      const snap = await monitor.getCycleSnapshot(mintAddress);
      if (!snap) {
        return { content: [{ type: 'text', text: `No active cycle found for mint ${mintAddress}.` }] };
      }
      const text = `**Mammoth Cycle Snapshot**
Mint: ${snap.projectMint}
Cycle Index: ${snap.cycleIndex}
Status: ${snap.status}
Curve: ${snap.curveType}

Supply Cap: ${snap.supplyCap.toLocaleString()} tokens
Minted: ${snap.minted.toLocaleString()} tokens (${snap.pctFilled}% filled)
Remaining: ${(snap.supplyCap - snap.minted).toLocaleString()} tokens

Current Price: ${snap.currentPriceSol.toFixed(6)} SOL per token (${snap.currentPriceLamports.toLocaleString()} lamports)
Base Price: ${(snap.basePrice / 1e9).toFixed(6)} SOL per token
SOL Raised: ${snap.solRaised.toFixed(4)} SOL

Rights Window: ${snap.rightsWindowActive ? `ACTIVE — expires ${new Date(snap.rightsWindowEnd * 1000).toISOString()}` : snap.rightsWindowEnd ? 'EXPIRED' : 'None'}

Use mammoth_buy_quote to calculate exact tokens out for a given SOL amount before committing.`;
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error fetching snapshot: ${err.message}` }] };
    }
  }
);

/**
 * mammoth_get_projects
 * Discover all Mammoth projects.
 */
server.tool(
  'mammoth_get_projects',
  'List all projects deployed on Mammoth Protocol with their supply mode, current cycle number, and total minted.',
  {},
  async () => {
    try {
      const projects = await client.fetchAllProjects();
      if (!projects || projects.length === 0) {
        return { content: [{ type: 'text', text: 'No projects found on Mammoth Protocol.' }] };
      }
      const lines = projects.map(p => {
        const a = p.account;
        const supplyKey = Object.keys(a.supplyMode)[0];
        const opKey = a.operatorType ? Object.keys(a.operatorType)[0] : 'human';
        return `- Mint: ${a.mint.toBase58()}\n  Creator: ${a.creator.toBase58().slice(0, 8)}... | Mode: ${supplyKey} | Cycle: #${a.currentCycle} | Operator: ${opKey}`;
      });
      return {
        content: [{
          type: 'text',
          text: `**Mammoth Projects (${projects.length})**\n\n${lines.join('\n\n')}\n\nUse mammoth_get_cycle_snapshot with a mint address for cycle details.`,
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error fetching projects: ${err.message}` }] };
    }
  }
);

/**
 * mammoth_get_rights_window_cycles
 * Cycles currently in a rights window — guaranteed below-market access
 * for existing holders before public buying opens.
 */
server.tool(
  'mammoth_get_rights_window_cycles',
  'List Mammoth cycles currently in a rights window. During a rights window, existing holders can buy at base price before public. This is a structurally advantaged entry point.',
  {},
  async () => {
    try {
      const cycles = await monitor.getCyclesInRightsWindow();
      if (cycles.length === 0) {
        return { content: [{ type: 'text', text: 'No cycles currently in a rights window.' }] };
      }
      const lines = cycles.map(c => {
        const hrs = Math.floor(c.rightsWindowSecondsRemaining / 3600);
        const mins = Math.floor((c.rightsWindowSecondsRemaining % 3600) / 60);
        const priceSOL = (c.cycle.basePrice.toNumber() / 1e9).toFixed(6);
        return `- Mint: ${c.projectMint}\n  Cycle #${c.cycle.cycleIndex} | Base Price: ${priceSOL} SOL | Rights window closes in: ${hrs}h ${mins}m`;
      });
      return {
        content: [{
          type: 'text',
          text: `**Cycles in Rights Window (${cycles.length})**\n\nThese cycles allow existing holders to buy at base price before public access.\n\n${lines.join('\n\n')}\n\nUse mammoth_check_rights to see if your wallet has rights.`,
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

/**
 * mammoth_check_rights
 * Check if a wallet has unexercised rights on any Mammoth project.
 */
server.tool(
  'mammoth_check_rights',
  'Check if a wallet address has unexercised rights on any Mammoth project. Rights give the holder guaranteed access to buy at base price during a rights window — before public buying opens.',
  { walletAddress: z.string().describe('Solana wallet address to check (base58)') },
  async ({ walletAddress }) => {
    try {
      const rights = await monitor.getUnexercisedRights(walletAddress);
      if (rights.length === 0) {
        return { content: [{ type: 'text', text: `Wallet ${walletAddress} has no unexercised rights on any active Mammoth cycle.` }] };
      }
      const lines = rights.map(r => {
        const expiry = new Date(r.expiry * 1000).toISOString();
        return `- Mint: ${r.projectMint}\n  Cycle #${r.cycleIndex} | Rights: ${r.rightsAmount.toLocaleString()} tokens | Exercised: ${r.exercisedAmount.toLocaleString()} | Remaining: ${r.remainingRights.toLocaleString()} | Expires: ${expiry}`;
      });
      return {
        content: [{
          type: 'text',
          text: `**Unexercised Rights for ${walletAddress.slice(0, 8)}...**\n\n${lines.join('\n\n')}\n\nUse mammoth_buy_quote to calculate cost, then mammoth_buy_tokens to exercise.`,
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

/**
 * mammoth_buy_quote
 * Get a deterministic buy quote without transacting.
 * This is the "check before you buy" tool — pure math, no RPC.
 */
server.tool(
  'mammoth_buy_quote',
  'Calculate how many tokens you receive for a given SOL amount on a Mammoth cycle. Returns exact tokens out, effective price, protocol fee, and price impact. No transaction submitted.',
  {
    mintAddress: z.string().describe('Mammoth project mint address'),
    solAmount: z.number().positive().describe('SOL amount to spend (e.g. 0.5)'),
  },
  async ({ mintAddress, solAmount }) => {
    try {
      const snap = await monitor.getCycleSnapshot(mintAddress);
      if (!snap) {
        return { content: [{ type: 'text', text: `No active cycle for mint ${mintAddress}.` }] };
      }
      if (snap.status !== 'active') {
        return { content: [{ type: 'text', text: `Cycle is not in Active status (current: ${snap.status}). Cannot buy right now.` }] };
      }

      const solLamports = Math.floor(solAmount * 1e9);
      const pricePerToken = snap.currentPriceLamports;
      const feeBps = 200; // 2%
      const netLamports = Math.floor(solLamports * (1 - feeBps / 10000));
      const tokensOut = pricePerToken > 0 ? Math.floor(netLamports / pricePerToken) : 0;
      const fee = solLamports - netLamports;
      const remaining = snap.supplyCap - snap.minted;

      if (tokensOut <= 0) {
        return { content: [{ type: 'text', text: `SOL amount too small. Minimum purchase at current price (${snap.currentPriceSol.toFixed(6)} SOL/token): ${(snap.currentPriceLamports / 1e9 * 1.02).toFixed(6)} SOL.` }] };
      }
      if (tokensOut > remaining) {
        return { content: [{ type: 'text', text: `Order too large. Only ${remaining.toLocaleString()} tokens remain in this cycle. Reduce SOL amount to ~${((remaining * pricePerToken * 1.02) / 1e9).toFixed(4)} SOL.` }] };
      }

      const text = `**Buy Quote — ${mintAddress.slice(0, 8)}...**
SOL In: ${solAmount} SOL
Protocol Fee (2%): ${(fee / 1e9).toFixed(6)} SOL
Net SOL for tokens: ${(netLamports / 1e9).toFixed(6)} SOL

Tokens Out: ${tokensOut.toLocaleString()} tokens
Effective Price: ${(netLamports / tokensOut / 1e9).toFixed(6)} SOL per token
Current Listed Price: ${snap.currentPriceSol.toFixed(6)} SOL per token

Cycle Fill After Purchase: ${(((snap.minted + tokensOut) / snap.supplyCap) * 100).toFixed(1)}%
Tokens Remaining After: ${(remaining - tokensOut).toLocaleString()}

Ready to buy? Use mammoth_buy_tokens with mintAddress and solAmount.`;
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  }
);

/**
 * mammoth_buy_tokens
 * Execute a buy. Requires MAMMOTH_WALLET_KEY to be set in server config.
 */
server.tool(
  'mammoth_buy_tokens',
  'Buy tokens from an active Mammoth cycle. Requires the server to be configured with MAMMOTH_WALLET_KEY. Always run mammoth_buy_quote first to confirm the expected outcome.',
  {
    mintAddress: z.string().describe('Mammoth project mint address'),
    tokenAmount: z.number().int().positive().describe('Number of tokens to buy (integer)'),
  },
  async ({ mintAddress, tokenAmount }) => {
    if (!wallet) {
      return {
        content: [{
          type: 'text',
          text: 'Buy execution requires MAMMOTH_WALLET_KEY to be set in the MCP server environment. The server is currently running in read-only mode.',
        }],
      };
    }
    try {
      const result = await client.buyTokens(mintAddress, tokenAmount);
      return {
        content: [{
          type: 'text',
          text: `**Purchase Confirmed**\nMint: ${mintAddress}\nTokens: ${tokenAmount.toLocaleString()}\nTransaction: ${result.signature}\nView on explorer: https://explorer.solana.com/tx/${result.signature}?cluster=devnet`,
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Buy failed: ${err.message}` }] };
    }
  }
);

/**
 * mammoth_protocol_reference
 * Returns the full structured protocol reference — for agents that need
 * to understand the protocol before acting.
 */
server.tool(
  'mammoth_protocol_reference',
  'Get the complete Mammoth Protocol reference — mechanics, instructions, error codes, and parameter definitions. Use this to understand how the protocol works before taking any action.',
  {},
  async () => {
    const ref = `# Mammoth Protocol Reference

## What It Is
Mammoth Protocol is a Solana-native, cycle-driven token issuance framework.
Program ID: DUnfGXcmPJgjSHvrPxeqPPYjrx6brurKUBJ4cVGVFR31
Web: https://mammoth-protocol.vercel.app

## Core Thesis
Markets don't hate dilution — they hate forced dilution.
Mammoth makes future issuance an opportunity for existing holders, not a threat.

## Key Mechanics

### Cycle-Based Rights Issuance
Tokens are only issued through discrete, bounded minting cycles. No continuous emissions.
Each cycle has: supply cap, bonding curve, rights window (optional), deterministic treasury routing.

### Rights-Based Anti-Dilution
Before each new cycle opens publicly, existing holders get pro-rata rights at base price.
Rights are non-transferable, cycle-specific, and auto-expire when the cycle closes.

### Cycle State Machine
Pending → RightsWindow → Active → Closed

### Supply Modes
- Fixed: hard cap set at genesis
- Elastic: no cap until irreversible set_hard_cap is called

### Bonding Curve Types
- Step: price jumps at defined token intervals (step_size, step_increment)
- Linear: gradual price from base to end price as supply fills
- ExpLite: exponential-style curve, max asymmetry for early buyers

### Protocol Economics
- 2% fee on all trades
- 2% protocol stake in every token created

### Treasury Routing (configurable by creator)
Default: 70% creator / 20% reserve / 10% sink. Enforced on-chain.

## Instructions
- create_project(supply_mode, total_supply, public_allocation_bps, creator_bps, reserve_bps, sink_bps, launch_at, operator_type)
- open_cycle(curve_type, supply_cap, base_price, rights_window_duration, step_size, step_increment, end_price, growth_factor_k)
- exercise_rights(amount) — during rights window, base price
- buy_tokens(amount) — during Active status, bonding curve price
- close_cycle() — creator or authorized operator
- set_hard_cap(hard_cap) — Elastic mode only, IRREVERSIBLE
- initialize_authority(operator, can_open_cycle, can_close_cycle, can_set_hard_cap, can_route_treasury, spending_limit_lamports)

## Error Codes
- CycleNotActive (6004): buy_tokens called when cycle is not Active
- RightsWindowClosed (6005): exercise_rights called after rights window expired
- SupplyCapExceeded (6006): purchase would exceed cycle cap
- InsufficientAuthority (6001): operator lacks permission
- HardCapAlreadySet (6007): set_hard_cap already called — irreversible

## For AI Agents
Use mammoth_get_open_cycles to discover entry opportunities.
Use mammoth_get_cycle_snapshot for full cycle data before acting.
Use mammoth_buy_quote to calculate exact outcome before transacting.
Use mammoth_check_rights to check rights holdings before a rights window closes.
Subscribe to events (CycleOpened, CycleActivated) via the SDK MammothMonitor for zero-latency triggers.

## SDK
npm install @mammoth-protocol/sdk
GitHub: https://github.com/kelvinsinferno/mammoth`;

    return { content: [{ type: 'text', text: ref }] };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  RESOURCES
// ─────────────────────────────────────────────────────────────────────────────

server.resource(
  'protocol-reference',
  'mammoth://protocol/reference',
  { mimeType: 'text/plain', description: 'Mammoth Protocol constants and parameter reference' },
  async () => {
    return {
      contents: [{
        uri: 'mammoth://protocol/reference',
        mimeType: 'text/plain',
        text: `Mammoth Protocol Constants
Program ID: DUnfGXcmPJgjSHvrPxeqPPYjrx6brurKUBJ4cVGVFR31
Protocol Fee: 200 bps (2%)
Protocol Stake: 200 bps (2% of each token created)
Default Treasury: 7000 creator / 2000 reserve / 1000 sink (all configurable)
Token Decimals: 6
Curve Types: Step | Linear | ExpLite
Supply Modes: Fixed | Elastic
Cycle States: Pending | RightsWindow | Active | Closed`,
      }],
    };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[mammoth-mcp] Server running. Cluster: ${CLUSTER} | RPC: ${RPC_URL} | Wallet: ${wallet ? wallet.publicKey.toBase58().slice(0, 8) + '...' : 'read-only'}`);
}

main().catch((err) => {
  console.error('[mammoth-mcp] Fatal error:', err);
  process.exit(1);
});
