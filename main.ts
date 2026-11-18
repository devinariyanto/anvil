// anvil — entry point: bind an ephemeral port, register it with the make.fun
// trial environment, then wait until the trial says it is done.
//
//   MAKEFUN_ENV_URL   base URL of the trial environment (required in a trial;
//                     without it the process exits 1, unless ANVIL_LOCAL=1)
//   ANVIL_LOCAL       set to "1" to serve locally without registering
//   MAKEFUN_SHOP_TOKEN the Bearer token the forge accepts
//   PORT              optional fixed port for local runs (default: ephemeral)

import { createApp } from './src/server.ts';

const TRIAL = process.env.MAKEFUN_ENV_URL?.replace(/\/+$/, '');
const LOCAL = process.env.ANVIL_LOCAL === '1';
const FIXED_PORT = Number(process.env.PORT ?? 0);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, payload: unknown, timeoutMs = 5000): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`POST ${url} answered ${response.status}`);
  return response.json().catch(() => null);
}

async function getJson(url: string, timeoutMs = 5000): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  return response.json();
}

/** Register the port, retrying with exponential backoff. Returns false if the
 * environment never answers. */
async function register(base: string, port: number): Promise<boolean> {
  let waitMs = 250;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      await postJson(`${base}/register`, { port });
      return true;
    } catch (err) {
      console.error(`register attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
      await sleep(waitMs);
      waitMs = Math.min(waitMs * 2, 8000);
    }
  }
  return false;
}

/** Poll GET /done until the trial reports done. */
async function waitDone(base: string): Promise<void> {
  let waitMs = 500;
  for (;;) {
    try {
      const body = (await getJson(`${base}/done`)) as { done?: unknown };
      if (body.done === true) return;
      waitMs = 500;
    } catch (err) {
      console.error(`poll /done failed: ${err instanceof Error ? err.message : err}`);
      waitMs = Math.min(waitMs * 2, 8000);
    }
    await sleep(waitMs);
  }
}

async function main(): Promise<number> {
  if (TRIAL === undefined && !LOCAL) {
    console.error('MAKEFUN_ENV_URL is not set; refusing to serve without a trial environment.');
    return 1;
  }

  const { server } = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(FIXED_PORT, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server did not bind a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
  console.log(`anvil listening on 127.0.0.1:${port}`);

  if (TRIAL === undefined) {
    // Local mode: serve until killed.
    return new Promise<number>(() => {});
  }

  if (!(await register(TRIAL, port))) {
    console.error('could not register with the trial environment; exiting.');
    server.close();
    return 1;
  }
  await waitDone(TRIAL);
  console.log('trial reported done; shutting down.');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
