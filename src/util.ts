// anvil — small shared helpers: opaque global ids, pagination, line shapes.

/** URL-safe base64 without padding. */
export function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function unb64url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

export function repoGlobalId(id: number): string {
  return `R_${b64url(`repo:${id}`)}`;
}

export function issueGlobalId(repoId: number, number: number): string {
  return `I_${b64url(`issue:${repoId}:${number}`)}`;
}

export function pullGlobalId(repoId: number, number: number): string {
  return `PR_${b64url(`pr:${repoId}:${number}`)}`;
}

export function commentGlobalId(repoId: number, commentId: number): string {
  return `C_${b64url(`comment:${repoId}:${commentId}`)}`;
}

/** Decode a global id back into its kind and numeric parts, or null. */
export function decodeGlobalId(id: string): { kind: string; parts: number[] } | null {
  const match = /^([A-Z]+)_(.+)$/.exec(id);
  if (match === null) return null;
  const kind = match[1];
  let text: string;
  try {
    text = unb64url(match[2]);
  } catch {
    return null;
  }
  const fields = text.split(':');
  const head = fields[0];
  if (head === undefined) return null;
  const parts: number[] = [];
  for (const field of fields.slice(1)) {
    const value = Number(field);
    if (!Number.isSafeInteger(value)) return null;
    parts.push(value);
  }
  return { kind, parts };
}

export interface Page {
  page: number;
  perPage: number;
}

/** Read ?page= & ?per_page= (defaults 1 and 30, per_page capped at 100). */
export function pageOf(query: URLSearchParams): Page {
  const pageRaw = Number(query.get('page') ?? '1');
  const perRaw = Number(query.get('per_page') ?? '30');
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.trunc(pageRaw) : 1;
  const perPage = Number.isFinite(perRaw) && perRaw >= 1 ? Math.min(100, Math.trunc(perRaw)) : 30;
  return { page, perPage };
}

/** Slice a list for one page, and the total page count. */
export function paginate<T>(items: readonly T[], page: Page): { items: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / page.perPage));
  const start = (page.page - 1) * page.perPage;
  return { items: items.slice(start, start + page.perPage), totalPages };
}

/** GitHub's Link header for the next page, or null when this is the last page. */
export function nextLink(host: string, pathname: string, query: URLSearchParams, page: Page, totalPages: number): string | null {
  if (page.page >= totalPages) return null;
  const nextParams = new URLSearchParams(query);
  nextParams.set('page', String(page.page + 1));
  nextParams.set('per_page', String(page.perPage));
  const lastParams = new URLSearchParams(query);
  lastParams.set('page', String(totalPages));
  lastParams.set('per_page', String(page.perPage));
  return `<http://${host}${pathname}?${nextParams.toString()}>; rel="next", <http://${host}${pathname}?${lastParams.toString()}>; rel="last"`;
}
