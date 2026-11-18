// anvil — MCP endpoint at /mcp: JSON-RPC 2.0 over streamable HTTP. Speaks the
// 2026-07-28 discovery handshake first (server/discover) and falls back to the
// classic initialize handshake; tools share the same Forge as REST and GraphQL.

import { squashMerge, type Forge } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_NAME = 'anvil';
const SERVER_VERSION = '0.1.0';
const DISCOVER_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

// Frozen at module load so two tools/list calls answer byte-identical.
const TOOLS: ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Short repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge an open pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface RpcReply {
  status: number;
  json: unknown;
}

function rpcError(id: unknown, code: number, message: string): RpcReply {
  return { status: 200, json: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): RpcReply {
  return { status: 200, json: { jsonrpc: '2.0', id, result } };
}

/** Pick a named argument, accepting the common synonyms the clients use. */
function arg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (args[name] !== undefined) return args[name];
  return undefined;
}

function strArg(args: Record<string, unknown>, ...names: string[]): string | undefined {
  const value = arg(args, ...names);
  return typeof value === 'string' ? value : undefined;
}

function numArg(args: Record<string, unknown>, ...names: string[]): number | undefined {
  const value = arg(args, ...names);
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** Split "owner/repo" into its parts, if that is what was passed. */
function splitFullName(args: Record<string, unknown>): { owner?: string; repo?: string } {
  const full = arg(args, 'full_name', 'fullName');
  if (typeof full === 'string') {
    const slash = full.indexOf('/');
    if (slash > 0) return { owner: full.slice(0, slash), repo: full.slice(slash + 1) };
  }
  return {};
}

function toolText(payload: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
  };
}

function toolError(message: string): Record<string, unknown> {
  return toolText({ error: message }, true);
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => name.toLowerCase().endsWith(entry.name));
  if (tool === undefined) return toolError(`unknown tool: ${name}`);

  const full = splitFullName(args);
  const owner = strArg(args, 'owner', 'owner_login') ?? full.owner;
  const repoName = strArg(args, 'repo', 'repository', 'name') ?? full.repo;

  if (tool.name === 'create_repo') {
    const repoTitle = strArg(args, 'name');
    if (repoTitle === undefined || repoTitle === '') return toolError('missing required argument: name');
    const description = strArg(args, 'description') ?? '';
    const isPrivate = arg(args, 'private') === true;
    const created = forge.createRepo(repoTitle, isPrivate, description);
    if (created === null) return toolError(`repository already exists: ${repoTitle}`);
    return toolText(repoJson(created));
  }

  if (owner === undefined || repoName === undefined) return toolError('missing required argument: owner or repo');
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return toolError(`repository not found: ${owner}/${repoName}`);

  if (tool.name === 'get_repo') return toolText(repoJson(repo));

  if (tool.name === 'create_issue') {
    const title = strArg(args, 'title');
    if (title === undefined || title === '') return toolError('missing required argument: title');
    const body = strArg(args, 'body') ?? '';
    const issue = forge.createIssue(repo, title, body, []);
    return toolText(issueJson(repo, issue));
  }

  if (tool.name === 'list_issues') {
    const state = strArg(args, 'state') ?? 'open';
    const listed = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    return toolText({ issues: listed.map((issue) => issueJson(repo, issue)) });
  }

  if (tool.name === 'create_pull_request') {
    const title = strArg(args, 'title');
    const head = strArg(args, 'head', 'head_branch');
    const base = strArg(args, 'base', 'base_branch');
    if (title === undefined || head === undefined || base === undefined) {
      return toolError('missing required argument: title, head or base');
    }
    const headSha = forge.branchTip(repo, head);
    const baseSha = forge.branchTip(repo, base);
    if (headSha === undefined) return toolError(`head branch not found: ${head}`);
    if (baseSha === undefined) return toolError(`base branch not found: ${base}`);
    const body = strArg(args, 'body') ?? '';
    const pull = forge.createPull(repo, title, body, head, headSha, base, baseSha);
    return toolText(pullJson(repo, pull, forge));
  }

  if (tool.name === 'merge_pull_request') {
    const number = numArg(args, 'pull_number', 'number', 'pullNumber');
    if (number === undefined) return toolError('missing required argument: pull_number');
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return toolError(`pull request not found: ${number}`);
    if (pull.merged) return toolText(pullJson(repo, pull, forge));
    if (pull.state !== 'open') return toolError(`pull request is not open: ${number}`);
    const sha = squashMerge(forge, repo, pull);
    if (sha === null) return toolError('pull request has merge conflicts');
    return toolText(pullJson(repo, pull, forge));
  }

  return toolError(`unknown tool: ${name}`);
}

/**
 * Handle POST /mcp. `raw` is the request body bytes; a body that is not JSON
 * is a parse error (HTTP 400, -32700). Notifications (no id) answer 202 with
 * an empty body.
 */
export function handleMcp(forge: Forge, raw: Buffer): RpcReply {
  let request: unknown;
  try {
    request = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const rpc = request as RpcRequest;
  const id = rpc.id;
  const isNotification = id === undefined;
  if (typeof rpc.method !== 'string') {
    return rpcError(id, -32600, 'Invalid Request');
  }

  switch (rpc.method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      return rpcResult(id, {
        serverInfo,
        protocolVersion: DISCOVER_VERSION,
        supportedVersions: [DISCOVER_VERSION, LEGACY_VERSION],
        capabilities: { tools: {} },
        _meta: { serverInfo },
      });
    }
    case 'initialize': {
      const params = (rpc.params ?? {}) as Record<string, unknown>;
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : LEGACY_VERSION;
      return rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'notifications/initialized':
      return { status: 202, json: null };
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const params = (rpc.params ?? {}) as Record<string, unknown>;
      const name = params.name;
      if (typeof name !== 'string') return rpcError(id, -32602, 'missing tool name');
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return rpcError(id, -32602, 'tool arguments must be an object');
      }
      // An unknown tool name is a JSON-RPC error (-32602), not a result with
      // isError: the conformance suite requires an error object here.
      const known = TOOLS.some((entry) => name.toLowerCase().endsWith(entry.name));
      if (!known) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const result = callTool(forge, name, args);
      return rpcResult(id, result);
    }
    default:
      if (isNotification) return { status: 202, json: null };
      return rpcError(id, -32601, `Method not found: ${rpc.method}`);
  }
}
