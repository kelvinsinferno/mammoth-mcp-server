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
 *
 * Safety env vars:
 *   MAMMOTH_MAX_BUY_LAMPORTS — per-tool-call spending cap (default: 0.5 SOL)
 *   MAMMOTH_ALLOW_BUYS      — must be "true" to arm buy execution (default: false)
 */

'use strict';

const { McpServer, ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { MammothClient, MammothMonitor, DEVNET_RPC, MAINNET_RPC } = require('@mammoth-protocol/sdk');
const pkg = require('../package.json');

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC_URL = process.env.SOLANA_RPC_URL || DEVNET_RPC;
const WALLET_KEY = process.env.MAMMOTH_WALLET_KEY || null;
const CLUSTER = process.env.SOLANA_CLUSTER || 'devnet';
// FIX MCP-1: Spending limit + opt-in flag for buy execution
const ALLOW_BUYS = process.env.MAMMOTH_ALLOW_BUYS === 'true';
// FIX (re-audit): Strictly parse MAX_BUY_LAMPORTS — exit if operator set a bogus value
let MAX_BUY_LAMPORTS = 500_000_000; // 0.5 SOL default
// FIX M2 (round 5): Session cumulative cap across ALL buy calls prevents parallel-drain
// attacks. Default is 10x per-call cap; operator can override via env.
let MAX_SESSION_LAMPORTS = 5_000_000_000; // 5 SOL default cumulative
if (process.env.MAMMOTH_MAX_BUY_LAMPORTS !== undefined) {
  const n = Number(process.env.MAMMOTH_MAX_BUY_LAMPORTS);
  // FIX H1 (final audit): Reject 0 — ambiguous sentinel (could mean "disabled" or "never allow").
  // Operators must pick a positive integer value.
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    console.error(`[mammoth-mcp] FATAL: MAMMOTH_MAX_BUY_LAMPORTS=${process.env.MAMMOTH_MAX_BUY_LAMPORTS} is not a positive integer.`);
    process.exit(1);
  }
  MAX_BUY_LAMPORTS = n;
}
if (process.env.MAMMOTH_MAX_SESSION_LAMPORTS !== undefined) {
  const n = Number(process.env.MAMMOTH_MAX_SESSION_LAMPORTS);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    console.error(`[mammoth-mcp] FATAL: MAMMOTH_MAX_SESSION_LAMPORTS=${process.env.MAMMOTH_MAX_SESSION_LAMPORTS} is not a positive integer.`);
    process.exit(1);
  }
  MAX_SESSION_LAMPORTS = n;
}

// FIX M2: Track cumulative spending + in-flight lock to prevent parallel drain
let sessionSpentLamports = 0;
let buyInFlight = false;

// FIX M-R8-2 (round 9): Rolling 60s window rate limit — true quota protection.
// Semaphore caps concurrency; this caps total volume. A looping agent can't burn
// RPC quota past this ceiling regardless of how long each request takes.
const READ_RATE_LIMIT_PER_MIN = 120;
const readTimestamps = [];
function checkRateLimit() {
  const now = Date.now();
  const cutoff = now - 60_000;
  // Drop timestamps older than 60s
  while (readTimestamps.length > 0 && readTimestamps[0] < cutoff) {
    readTimestamps.shift();
  }
  if (readTimestamps.length >= READ_RATE_LIMIT_PER_MIN) {
    throw new Error(`Read rate limit exceeded (${READ_RATE_LIMIT_PER_MIN}/min). Back off.`);
  }
  readTimestamps.push(now);
}

// FIX M1 (round 7) + M-R7-2/M-R7-3 (round 8): Queueing semaphore for read tools.
// Prevents RPC quota burn from parallel invocations by looping/compromised agents.
// Callers queue (not throw) with a 30s timeout to avoid stuck request accumulation.
const MAX_CONCURRENT_READS = 3;
const SEMAPHORE_WAIT_MS = 30_000;
let activeReads = 0;
const waiters = [];
function _releaseNext() {
  if (waiters.length > 0) {
    const next = waiters.shift();
    next();
  }
}
async function withReadSemaphore(fn) {
  checkRateLimit(); // FIX M-R8-2: Rolling window rate limit
  if (activeReads >= MAX_CONCURRENT_READS) {
    // FIX M-R8-1 (round 9): Keep reference to the waiter closure so timeout can
    // splice it correctly. Previous code used indexOf(resolve) which was always -1
    // (the actual waiter was a different wrapper function), leaking orphans.
    await new Promise((resolve, reject) => {
      const waiter = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`Read queue timeout (${SEMAPHORE_WAIT_MS}ms). Too many concurrent requests.`));
      }, SEMAPHORE_WAIT_MS);
      waiters.push(waiter);
    });
  }
  activeReads++;
  try {
    return await fn();
  } finally {
    activeReads--;
    _releaseNext();
  }
}

// FIX H-B (round 6): Uniform error sanitization for ALL handlers.
// Previously only buy_tokens sanitized — other handlers could leak RPC URLs
// containing API keys (Helius, QuickNode, etc.) via RPC error messages.
function sanitizeError(err) {
  // FIX (round 10): Walk err.cause chain and include err.logs (Solana SendTransactionError).
  const parts = [];
  let cur = err;
  let depth = 0;
  while (cur && depth < 3) {
    if (cur.message) parts.push(cur.message);
    else if (typeof cur === 'string') parts.push(cur);
    if (cur.logs && Array.isArray(cur.logs)) {
      parts.push('[logs: ' + cur.logs.slice(0, 3).join('; ') + ']');
    }
    cur = cur.cause;
    depth++;
  }
  const raw = parts.length > 0 ? parts.join(' | ') : String(err);
  // Redact RPC URLs (http/https/ws/wss) — may contain API keys
  // Also redact Bearer/Authorization/api-key patterns
  return raw
    .replace(/(https?|wss?):\/\/[^\s'"]+/gi, '[rpc-url-redacted]')
    .replace(/(?:Bearer|api[-_]?key|Authorization)[:\s=]+[^\s'",}]+/gi, '[auth-redacted]')
    .slice(0, 500);
}

// FIX MCP-4/MCP-10: Solana base58 pubkey validation
const SOLANA_PUBKEY_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const validatePubkey = (field, val) => {
  if (!SOLANA_PUBKEY_REGEX.test(val)) {
    throw new Error(`${field} is not a valid Solana address: ${val}`);
  }
  try {
    new PublicKey(val);
  } catch {
    throw new Error(`${field} is not a valid Solana address: ${val}`);
  }
};

// ─── Setup ───────────────────────────────────────────────────────────────────

const connection = new Connection(RPC_URL, 'confirmed');

// FIX MCP-3: Exit with error if MAMMOTH_WALLET_KEY is set but unparseable.
// FIX MCP-2: Do NOT include the raw key in any error message.
let wallet = null;
if (WALLET_KEY) {
  const tryParseJson = () => {
    try {
      const secretKey = Uint8Array.from(JSON.parse(WALLET_KEY));
      return Keypair.fromSecretKey(secretKey);
    } catch {
      return null;
    }
  };
  const tryParseBase58 = () => {
    try {
      const bs58 = require('bs58');
      const secretKey = bs58.decode(WALLET_KEY);
      return Keypair.fromSecretKey(secretKey);
    } catch {
      return null;
    }
  };

  const keypair = tryParseJson() || tryParseBase58();
  if (!keypair) {
    console.error('[mammoth-mcp] FATAL: MAMMOTH_WALLET_KEY is set but could not be parsed as JSON array or base58 string. Refusing to start — operator intent was unclear. Unset MAMMOTH_WALLET_KEY to run read-only.');
    process.exit(1);
  }
  wallet = {
    publicKey: keypair.publicKey,
    signTransaction: async (tx) => { tx.sign(keypair); return tx; },
    signAllTransactions: async (txs) => txs.map(tx => { tx.sign(keypair); return tx; }),
  };
}

// FIX MCP-9: Catch MammothClient / MammothMonitor constructor failures
let client, monitor;
try {
  client = new MammothClient({ connection, wallet, cluster: CLUSTER });
  monitor = new MammothMonitor({ connection });
} catch (err) {
  console.error(`[mammoth-mcp] FATAL: failed to initialize Mammoth SDK: ${err.message}`);
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// FIX MCP-8: Cluster-aware explorer URL
function explorerTxUrl(signature) {
  if (CLUSTER === 'mainnet-beta') {
    return `https://explorer.solana.com/tx/${signature}`;
  }
  return `https://explorer.solana.com/tx/${signature}?cluster=${CLUSTER}`;
}

// FIX MCP-7: Cap result set sizes to avoid context window exhaustion
const DEFAULT_LIMIT = 25;
function truncateList(items, limit) {
  const n = Math.min(items.length, limit);
  return {
    items: items.slice(0, n),
    truncated: items.length > n,
    total: items.length,
  };
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'mammoth-protocol',
  version: pkg.version, // FIX MCP-13: Read from package.json instead of hardcoding
  description: 'Mammoth Protocol — cycle-driven token issuance on Solana. Raises with rights-based anti-dilution for existing holders. Bounded bonding curves. Deterministic treasury routing.',
});

// ─────────────────────────────────────────────────────────────────────────────
//  TOOLS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * mammoth_get_open_cycles
 */
server.tool(
  'mammoth_get_open_cycles',
  'List all Mammoth Protocol cycles where public buying is currently open. Returns price, fill %, curve type, and supply for each active cycle.',
  {
    limit: z.number().int().positive().max(100).optional().describe(`Max results to return (default ${DEFAULT_LIMIT}, max 100)`),
  },
  async ({ limit }) => {
    try {
      return await withReadSemaphore(async () => {
      const cycles = await monitor.getOpenCycles();
      if (cycles.length === 0) {
        return { content: [{ type: 'text', text: 'No active cycles found on Mammoth Protocol at this time.' }] };
      }
      const { items, truncated, total } = truncateList(cycles, limit || DEFAULT_LIMIT);
      const lines = items.map(c => {
        const pct = c.cycle.supplyCap.toNumber() > 0
          ? ((c.cycle.minted.toNumber() / c.cycle.supplyCap.toNumber()) * 100).toFixed(1)
          : '0.0';
        const priceSOL = (c.cycle.basePrice.toNumber() / 1e9).toFixed(6);
        const curveKey = Object.keys(c.cycle.curveType)[0];
        return `- Mint: ${c.projectMint}\n  Cycle #${c.cycle.cycleIndex} | Curve: ${curveKey} | Price: ${priceSOL} SOL | Fill: ${pct}% | Cap: ${c.cycle.supplyCap.toNumber().toLocaleString()} tokens`;
      });
      const suffix = truncated ? `\n\n(showing first ${items.length} of ${total} — use limit param to see more)` : '';
      return {
        content: [{
          type: 'text',
          text: `**Active Mammoth Cycles (${total})**\n\n${lines.join('\n\n')}${suffix}\n\nUse mammoth_get_cycle_snapshot with a mint address for full details and buy quotes.`,
        }],
      };
      }); // end withReadSemaphore
    } catch (err) {
      return { content: [{ type: 'text', text: `Error fetching cycles: ${sanitizeError(err)}` }] };
    }
  }
);

/**
 * mammoth_get_cycle_snapshot
 */
server.tool(
  'mammoth_get_cycle_snapshot',
  'Get a full snapshot of the current cycle for a Mammoth project — price, fill progress, curve type, rights window status, and key parameters. Use this before buying.',
  { mintAddress: z.string().describe('The Solana mint address of the Mammoth project token (base58)') },
  async ({ mintAddress }) => {
    try {
      return await withReadSemaphore(async () => {
      validatePubkey('mintAddress', mintAddress); // FIX MCP-4
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
      }); // end withReadSemaphore
    } catch (err) {
      return { content: [{ type: 'text', text: `Error fetching snapshot: ${sanitizeError(err)}` }] };
    }
  }
);

/**
 * mammoth_get_projects
 */
server.tool(
  'mammoth_get_projects',
  'List all projects deployed on Mammoth Protocol with their supply mode, current cycle number, and total minted.',
  {
    limit: z.number().int().positive().max(100).optional().describe(`Max results to return (default ${DEFAULT_LIMIT}, max 100)`),
  },
  async ({ limit }) => {
    try {
      return await withReadSemaphore(async () => {
      const projects = await client.fetchAllProjects();
      if (!projects || projects.length === 0) {
        return { content: [{ type: 'text', text: 'No projects found on Mammoth Protocol.' }] };
      }
      const { items, truncated, total } = truncateList(projects, limit || DEFAULT_LIMIT);
      const lines = items.map(p => {
        const a = p.account;
        const supplyKey = Object.keys(a.supplyMode)[0];
        const opKey = a.operatorType ? Object.keys(a.operatorType)[0] : 'human';
        return `- Mint: ${a.mint.toBase58()}\n  Creator: ${a.creator.toBase58().slice(0, 8)}... | Mode: ${supplyKey} | Cycle: #${a.currentCycle} | Operator: ${opKey}`;
      });
      const suffix = truncated ? `\n\n(showing first ${items.length} of ${total} — use limit param to see more)` : '';
      return {
        content: [{
          type: 'text',
          text: `**Mammoth Projects (${total})**\n\n${lines.join('\n\n')}${suffix}\n\nUse mammoth_get_cycle_snapshot with a mint address for cycle details.`,
        }],
      };
      }); // end withReadSemaphore
    } catch (err) {
      return { content: [{ type: 'text', text: `Error fetching projects: ${sanitizeError(err)}` }] };
    }
  }
);

/**
 * mammoth_get_rights_window_cycles
 */
server.tool(
  'mammoth_get_rights_window_cycles',
  'List Mammoth cycles currently in a rights window. During a rights window, existing holders can buy at base price before public. This is a structurally advantaged entry point.',
  {
    limit: z.number().int().positive().max(100).optional().describe(`Max results to return (default ${DEFAULT_LIMIT}, max 100)`),
  },
  async ({ limit }) => {
    try {
      return await withReadSemaphore(async () => {
      const cycles = await monitor.getCyclesInRightsWindow();
      if (cycles.length === 0) {
        return { content: [{ type: 'text', text: 'No cycles currently in a rights window.' }] };
      }
      const { items, truncated, total } = truncateList(cycles, limit || DEFAULT_LIMIT);
      const lines = items.map(c => {
        const hrs = Math.floor(c.rightsWindowSecondsRemaining / 3600);
        const mins = Math.floor((c.rightsWindowSecondsRemaining % 3600) / 60);
        const priceSOL = (c.cycle.basePrice.toNumber() / 1e9).toFixed(6);
        return `- Mint: ${c.projectMint}\n  Cycle #${c.cycle.cycleIndex} | Base Price: ${priceSOL} SOL | Rights window closes in: ${hrs}h ${mins}m`;
      });
      const suffix = truncated ? `\n\n(showing first ${items.length} of ${total})` : '';
      return {
        content: [{
          type: 'text',
          text: `**Cycles in Rights Window (${total})**\n\nThese cycles allow existing holders to buy at base price before public access.\n\n${lines.join('\n\n')}${suffix}\n\nUse mammoth_check_rights to see if your wallet has rights.`,
        }],
      };
      }); // end withReadSemaphore
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${sanitizeError(err)}` }] };
    }
  }
);

/**
 * mammoth_check_rights
 */
server.tool(
  'mammoth_check_rights',
  'Check if a wallet address has unexercised rights on any Mammoth project. Rights give the holder guaranteed access to buy at base price during a rights window — before public buying opens.',
  { walletAddress: z.string().describe('Solana wallet address to check (base58)') },
  async ({ walletAddress }) => {
    try {
      return await withReadSemaphore(async () => {
      validatePubkey('walletAddress', walletAddress); // FIX MCP-10
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
      }); // end withReadSemaphore
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${sanitizeError(err)}` }] };
    }
  }
);

/**
 * mammoth_buy_quote
 *
 * FIX MCP-5/MCP-6: Use SDK's computeBuyQuote which walks the actual curve,
 * not a flat spot-price approximation. This matches what buyTokens will actually cost.
 */
server.tool(
  'mammoth_buy_quote',
  'Calculate how many tokens you receive for a given SOL amount on a Mammoth cycle. Uses the SDK\'s curve-aware integration so quotes match on-chain execution. No transaction submitted.',
  {
    mintAddress: z.string().describe('Mammoth project mint address'),
    solAmount: z.number().positive().describe('SOL amount to spend (e.g. 0.5)'),
  },
  async ({ mintAddress, solAmount }) => {
    try {
      return await withReadSemaphore(async () => {
      validatePubkey('mintAddress', mintAddress);
      const snap = await monitor.getCycleSnapshot(mintAddress);
      if (!snap) {
        return { content: [{ type: 'text', text: `No active cycle for mint ${mintAddress}.` }] };
      }
      if (snap.status !== 'active') {
        return { content: [{ type: 'text', text: `Cycle is not in Active status (current: ${snap.status}). Cannot buy right now.` }] };
      }

      // Use SDK's curve-aware quote (ExpLite/Linear/Step all properly integrated).
      // Fetch the raw cycle account so we can pass it to computeBuyQuote.
      const { computeBuyQuote } = require('@mammoth-protocol/sdk');
      const project = await client.fetchProject(mintAddress);
      if (!project) {
        return { content: [{ type: 'text', text: `Project not found for mint ${mintAddress}.` }] };
      }
      const cycleIdx = (typeof project.account.currentCycle === 'number'
        ? project.account.currentCycle
        : project.account.currentCycle.toNumber()) - 1;
      if (cycleIdx < 0) {
        return { content: [{ type: 'text', text: `No cycle has been opened for this project yet.` }] };
      }
      const cycle = await client.fetchCycle(mintAddress, cycleIdx);
      if (!cycle) {
        return { content: [{ type: 'text', text: `Cycle ${cycleIdx} not found.` }] };
      }
      const quote = computeBuyQuote(cycle.account, solAmount);
      if (!quote || quote.tokensOut <= 0) {
        return { content: [{ type: 'text', text: `SOL amount too small at current price (${snap.currentPriceSol.toFixed(6)} SOL/token). Increase amount.` }] };
      }

      // FIX (re-audit): Derive fee percentage from quote instead of hardcoding
      const feePct = solAmount > 0 ? ((quote.fee / solAmount) * 100).toFixed(2) : '0.00';
      const text = `**Buy Quote — ${mintAddress.slice(0, 8)}...**
SOL In: ${solAmount} SOL
Protocol Fee (${feePct}%): ${quote.fee.toFixed(6)} SOL

Tokens Out: ${quote.tokensOut.toLocaleString()} tokens
Effective Price: ${quote.effectivePrice.toFixed(6)} SOL per token
Price After Purchase: ${quote.newPrice.toFixed(6)} SOL per token
Price Impact: ${(((quote.newPrice - snap.currentPriceSol) / snap.currentPriceSol) * 100).toFixed(2)}%

Cycle Fill After Purchase: ${(((snap.minted + quote.tokensOut) / snap.supplyCap) * 100).toFixed(1)}%
Tokens Remaining After: ${(quote.remainingAfter).toLocaleString()}

Ready to buy? Use mammoth_buy_tokens with mintAddress and tokenAmount=${Math.floor(quote.tokensOut)}.`;
      return { content: [{ type: 'text', text }] };
      }); // end withReadSemaphore
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${sanitizeError(err)}` }] };
    }
  }
);

/**
 * mammoth_buy_tokens
 *
 * FIX MCP-1: Multiple guardrails on buy execution:
 * - MAMMOTH_ALLOW_BUYS env must be "true" (opt-in)
 * - tokenAmount bounded to what's affordable under MAX_BUY_LAMPORTS
 * - Sanity-check against the current cycle's price before sending
 */
server.tool(
  'mammoth_buy_tokens',
  'Buy tokens from an active Mammoth cycle. Requires MAMMOTH_WALLET_KEY AND MAMMOTH_ALLOW_BUYS=true in server env. Two caps: MAMMOTH_MAX_BUY_LAMPORTS (per-call, default 0.5 SOL) and MAMMOTH_MAX_SESSION_LAMPORTS (cumulative per server session, default 5 SOL). Always run mammoth_buy_quote first.',
  {
    mintAddress: z.string().describe('Mammoth project mint address'),
    tokenAmount: z.number().int().positive().describe('Number of tokens to buy (integer, must be > 0)'),
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
    if (!ALLOW_BUYS) {
      return {
        content: [{
          type: 'text',
          text: 'Buy execution is gated behind MAMMOTH_ALLOW_BUYS=true. Set this env var to arm buy execution. Until then, this server will not submit buy transactions.',
        }],
      };
    }
    // FIX M2 (round 5): Prevent parallel buys draining beyond MAX_BUY_LAMPORTS per call
    if (buyInFlight) {
      return {
        content: [{
          type: 'text',
          text: 'Another buy is in flight. Wait for it to complete before submitting another. (This prevents parallel-call drain attacks.)',
        }],
      };
    }
    buyInFlight = true;
    try {
      // FIX (round 10): Apply rate limit to buy too — prevents abuse via repeated failed buys.
      checkRateLimit();
      validatePubkey('mintAddress', mintAddress);
      if (!Number.isInteger(tokenAmount) || tokenAmount <= 0) {
        return { content: [{ type: 'text', text: `tokenAmount must be a positive integer, got ${tokenAmount}` }] };
      }
      // FIX H3 (final audit): Hard ceiling at 1e15 to prevent JS Number precision loss
      if (tokenAmount > 1e15) {
        return { content: [{ type: 'text', text: `tokenAmount too large (max 1e15). For larger amounts use the SDK directly with BigInt.` }] };
      }

      // Pre-flight cost check using curve-aware integration (matches contract).
      // FIX (re-audit): spot-price estimate was wrong for Step/ExpLite curves —
      // cap could be bypassed at step boundaries. Compute actual cost from the cycle.
      const { computeBuyQuote: sdkComputeBuyQuote } = require('@mammoth-protocol/sdk');
      const snap = await monitor.getCycleSnapshot(mintAddress);
      if (!snap) {
        return { content: [{ type: 'text', text: `No active cycle for mint ${mintAddress}.` }] };
      }
      if (snap.status !== 'active') {
        return { content: [{ type: 'text', text: `Cycle is not in Active status (current: ${snap.status}). Cannot buy right now.` }] };
      }
      if (tokenAmount > snap.supplyCap - snap.minted) {
        return { content: [{ type: 'text', text: `Order too large. Only ${(snap.supplyCap - snap.minted).toLocaleString()} tokens remain in this cycle.` }] };
      }

      // Binary search: find smallest SOL input that yields >= tokenAmount tokens
      // using the same curve integration the contract will use.
      const project = await client.fetchProject(mintAddress);
      if (!project) {
        return { content: [{ type: 'text', text: `Project not found for mint ${mintAddress}.` }] };
      }
      const _cc = typeof project.account.currentCycle === 'number'
        ? project.account.currentCycle : project.account.currentCycle.toNumber();
      const cycleIdx = _cc - 1;
      if (cycleIdx < 0) {
        return { content: [{ type: 'text', text: `No cycle has been opened for this project yet.` }] };
      }
      const cycle = await client.fetchCycle(mintAddress, cycleIdx);
      if (!cycle) {
        return { content: [{ type: 'text', text: `Cycle ${cycleIdx} not found.` }] };
      }

      // Find the SOL amount needed via binary search on computeBuyQuote
      let loSol = 0, hiSol = MAX_BUY_LAMPORTS / 1e9 * 2; // search up to 2x the cap
      let bestQuote = null;
      let bestMidSol = 0;
      for (let i = 0; i < 40; i++) {
        const midSol = (loSol + hiSol) / 2;
        const q = sdkComputeBuyQuote(cycle.account, midSol);
        if (!q) break;
        if (q.tokensOut >= tokenAmount) {
          bestQuote = q;
          bestMidSol = midSol; // FIX H2 (final audit): track the actual SOL input
          hiSol = midSol;
        } else {
          loSol = midSol;
        }
      }
      if (!bestQuote) {
        return { content: [{ type: 'text', text: `Unable to compute cost for ${tokenAmount} tokens on this curve.` }] };
      }
      // FIX H2: Use bestMidSol (the actual SOL input) for cap check, not derived fields.
      const estTotalLamports = Math.ceil(bestMidSol * 1e9);
      if (estTotalLamports > MAX_BUY_LAMPORTS) {
        return {
          content: [{
            type: 'text',
            text: `Buy rejected by per-call cap. Estimated total cost (curve-aware, inc. fee): ${(estTotalLamports / 1e9).toFixed(6)} SOL. MAMMOTH_MAX_BUY_LAMPORTS is ${(MAX_BUY_LAMPORTS / 1e9).toFixed(6)} SOL.`,
          }],
        };
      }
      // FIX M2: Enforce cumulative session cap across ALL buy calls
      if (sessionSpentLamports + estTotalLamports > MAX_SESSION_LAMPORTS) {
        return {
          content: [{
            type: 'text',
            text: `Buy rejected by session cap. Already spent: ${(sessionSpentLamports / 1e9).toFixed(6)} SOL. This buy: ${(estTotalLamports / 1e9).toFixed(6)} SOL. Session cap: ${(MAX_SESSION_LAMPORTS / 1e9).toFixed(6)} SOL. Restart the MCP server to reset.`,
          }],
        };
      }
      const estWithFee = estTotalLamports;

      // FIX TOCTOU: Pass max_sol_cost to contract so the on-chain tx is bounded
      // regardless of price changes between snapshot and submission.
      // FIX H1 (round 5): Give slippageCap 1% headroom above est, but don't clamp to MAX_BUY_LAMPORTS
      // at the edge — if est+1% exceeds MAX, the per-call check already rejected it above.
      const slippageCap = Math.min(MAX_BUY_LAMPORTS, Math.ceil(estTotalLamports * 1.01));

      // FIX H1 (round 7): Reserve session budget BEFORE submitting tx.
      // If the timeout fires but the tx eventually lands on-chain, the wallet still spent
      // the money. Reserving upfront means a retry doesn't double-spend. On DETERMINISTIC
      // failure (e.g., cycle closed, insufficient funds known before send), refund the
      // reservation. On timeout/unknown failure, keep the reservation (conservative).
      sessionSpentLamports += slippageCap;

      let shouldRefund = false;
      try {
        // FIX M-B: Timeout wrapper — but NOTE: timing out does NOT refund the reservation
        // because the tx may have landed on-chain even after the local timeout.
        const BUY_TIMEOUT_MS = 60_000;
        const result = await Promise.race([
          client.buyTokens(mintAddress, tokenAmount, slippageCap),
          new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT:buy_tokens timed out after 60s — tx state unknown; session budget RESERVED')), BUY_TIMEOUT_MS)),
        ]);
        return {
          content: [{
            type: 'text',
            text: `**Purchase Confirmed**\nMint: ${mintAddress}\nTokens: ${tokenAmount.toLocaleString()}\nEst. Cost: ${(estWithFee / 1e9).toFixed(6)} SOL\nSlippage cap: ${(slippageCap / 1e9).toFixed(6)} SOL\nSession spent: ${(sessionSpentLamports / 1e9).toFixed(6)} / ${(MAX_SESSION_LAMPORTS / 1e9).toFixed(3)} SOL\nTransaction: ${result.signature}\nView on explorer: ${explorerTxUrl(result.signature)}`,
          }],
        };
      } catch (err) {
        const msg = err?.message || String(err);
        // FIX H-R7-1 (round 8): Invert logic — assume pre-flight unless the error
        // STRONGLY INDICATES the tx might have been submitted. Previous approach missed
        // many transient/network errors (ECONNREFUSED, fetch failed, etc.) and kept
        // reservations burned unnecessarily.
        // Keep reservation ONLY when tx submission is possible:
        // - TIMEOUT: (our own timeout, tx may have landed)
        // - SendTransactionError, Transaction (signature + submitted)
        // - BlockhashNotFound (can occur post-send during retry)
        // - Anchor error codes 6000+ (on-chain program errors mean tx DID submit)
        // FIX H-R8-2 (round 9): Simulation failures are PRE-flight — tx never submitted.
        // If the error mentions "Simulation failed" / "Transaction simulation failed", treat
        // as refundable even if it ALSO contains custom program error / AnchorError.
        const isSimulationFailure = /Simulation failed|Transaction simulation failed/i.test(msg);
        const possiblySubmitted = !isSimulationFailure && (
          /^TIMEOUT:|SendTransactionError|Transaction signature|\btransaction was submitted\b|\bblockhash not found\b/i.test(msg)
        );
        if (!possiblySubmitted) {
          // Pre-flight or network error — safe to refund
          shouldRefund = true;
          sessionSpentLamports = Math.max(0, sessionSpentLamports - slippageCap);
        }
        return { content: [{ type: 'text', text: `Buy failed: ${sanitizeError(err)}${shouldRefund ? ' (session budget refunded — pre-flight error)' : ' (session budget NOT refunded — tx state unknown)'}` }] };
      }
    } catch (err) {
      return { content: [{ type: 'text', text: `Buy failed: ${sanitizeError(err)}` }] };
    } finally {
      // Always release the in-flight lock
      buyInFlight = false;
    }
  }
);

/**
 * mammoth_protocol_reference
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
- exercise_rights(amount, max_sol_cost) — during rights window, base price with on-chain cost cap
- buy_tokens(amount, max_sol_cost) — during Active status, bonding curve price with on-chain cost cap
- close_cycle() — creator or authorized operator
- set_hard_cap(hard_cap) — Elastic mode only, IRREVERSIBLE
- initialize_authority(operator, can_open_cycle, can_close_cycle, can_set_hard_cap, can_route_treasury, spending_limit_lamports)
- update_authority(operator, can_open_cycle, can_close_cycle, can_set_hard_cap, can_route_treasury, spending_limit_lamports)
- set_rights_merkle_root(root, holder_count, total_committed)
- claim_rights(proof, rights_amount)
- reclaim_cycle_rent()
- rotate_creator(new_creator)
- withdraw_reserve(amount)

## Error Handling
Mammoth returns structured custom errors through Anchor/Solana transaction failures. Exact custom error names and numbers can evolve as the contract is hardened. For agent-safe handling, prefer the SDK's parsed error layer instead of hardcoding legacy numeric mappings in prompts or tools.

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
  const armed = wallet && ALLOW_BUYS ? 'ARMED' : (wallet ? 'wallet-loaded, buys-DISARMED' : 'read-only');
  // FIX H-R8-1 (round 9): Don't print full RPC URL — may contain API key.
  // Print only host portion, or redacted if URL parsing fails.
  let rpcDisplay = 'unknown';
  try {
    const u = new URL(RPC_URL);
    rpcDisplay = u.host;
  } catch {
    rpcDisplay = '[rpc-url-redacted]';
  }
  console.error(`[mammoth-mcp] Server running. Cluster: ${CLUSTER} | RPC host: ${rpcDisplay} | Wallet: ${wallet ? wallet.publicKey.toBase58().slice(0, 8) + '...' : 'none'} | Mode: ${armed} | Spending cap: ${(MAX_BUY_LAMPORTS / 1e9).toFixed(3)} SOL`);
}

main().catch((err) => {
  console.error('[mammoth-mcp] Fatal error:', err);
  process.exit(1);
});
