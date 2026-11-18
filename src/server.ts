// anvil — HTTP front door: reads the body, enforces the Bearer gate for the
// API surfaces, and routes each request to the git, REST, GraphQL or MCP
// handler. Every API reply is JSON and carries X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { routeGit } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { routeRest, type RestReply } from './rest.ts';

const MAX_BODY = 64 * 1024 * 1024;

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `anvil-${requestCounter}`;
}

/** The token the trial hands out, or undefined when the server runs open. */
export function expectedToken(): string | undefined {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  return token !== undefined && token !== '' ? token : undefined;
}

function bearerOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match === null ? undefined : match[1];
}

function authorized(req: IncomingMessage): boolean {
  const presented = bearerOf(req);
  if (presented === undefined || presented === '') return false;
  const expected = expectedToken();
  return expected === undefined || presented === expected;
}

function sendJson(res: ServerResponse, status: number, json: unknown, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string> = { ...extraHeaders };
  if (json !== null && json !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
  const body = json === null || json === undefined ? '' : JSON.stringify(json);
  res.writeHead(status, headers);
  res.end(body);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function gitPath(pathname: string): boolean {
  return /\.git(\/|$)/.test(pathname);
}

async function handle(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const method = req.method ?? 'GET';
  const rid = requestId();

  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (gitPath(pathname)) {
    const body = await readBody(req);
    const reply = routeGit(forge, {
      method,
      pathname,
      query: url.searchParams,
      headers: req.headers as Record<string, string | undefined>,
      body,
    });
    if (reply === null) {
      sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': rid });
      return;
    }
    sendRaw(res, reply.status, reply.body, reply.contentType);
    return;
  }

  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Unauthorized' }, { 'x-github-request-id': rid });
      return;
    }
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Invalid JSON' }, { 'x-github-request-id': rid });
      return;
    }
    const headers: Record<string, string> = { 'x-github-request-id': rid };
    const reply: RestReply | null = routeRest(forge, {
      method,
      pathname,
      query: url.searchParams,
      host: req.headers.host ?? '127.0.0.1',
      body: parsed.value,
    });
    if (reply === null) {
      sendJson(res, 404, { message: 'Not Found' }, headers);
      return;
    }
    if (reply.headers !== undefined) Object.assign(headers, reply.headers);
    sendJson(res, reply.status, reply.json, headers);
    return;
  }

  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': rid });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Unauthorized' }, { 'x-github-request-id': rid });
      return;
    }
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Invalid JSON' }, { 'x-github-request-id': rid });
      return;
    }
    const reply = handleGraphql(forge, parsed.value);
    sendJson(res, reply.status, reply.json, { 'x-github-request-id': rid });
    return;
  }

  if (pathname === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': rid });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Unauthorized' }, { 'x-github-request-id': rid });
      return;
    }
    const raw = await readBody(req);
    const reply = handleMcp(forge, raw);
    if (reply.status === 202) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.json, { 'x-github-request-id': rid });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': rid });
}

/** Build the HTTP server for one fresh in-memory forge. */
export function createApp(): { server: Server; forge: Forge } {
  const forge = new Forge();
  const server = createServer((req, res) => {
    handle(forge, req, res).catch((err: unknown) => {
      console.error('handler error', req.method, req.url, err instanceof Error ? err.stack ?? err.message : String(err));
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
  return { server, forge };
}
