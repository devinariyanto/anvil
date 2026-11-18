// anvil — git smart HTTP: info/refs advertisements, upload-pack protocol v2
// (plus a v0 fallback) and receive-pack v0 with report-status. Packs are
// written as whole objects; incoming packs may carry deltas and are resolved
// against the objects the repository already holds.

import {
  decodePktLines,
  decodePktLinesUntilFlush,
  isOid,
  parseTree,
  pktLine,
  PKT_DELIM,
  PKT_FLUSH,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitcore.ts';
import { VIEWER_LOGIN, type Forge, type Repo } from './store.ts';

export interface GitRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface GitReply {
  status: number;
  body: Buffer;
  contentType: string;
}

function reply(status: number, body: Buffer, contentType: string): GitReply {
  return { status, body, contentType };
}

function textReply(status: number, text: string, contentType = 'text/plain; charset=utf-8'): GitReply {
  return reply(status, Buffer.from(text, 'utf8'), contentType);
}

function notFound(): GitReply {
  return textReply(404, JSON.stringify({ message: 'Not Found' }), 'application/json; charset=utf-8');
}

const AGENT = 'anvil/1.0';
const UPLOAD_V0_CAPS =
  'multi_ack_detailed multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag agent=anvil/1.0 symref=HEAD:refs/heads/main object-format=sha1';
const RECEIVE_CAPS =
  'report-status side-band-64k delete-refs ofs-delta agent=anvil/1.0 symref=HEAD:refs/heads/main';

/** Sorted ref names of a repository (heads first, then tags). */
function sortedRefs(repo: Repo): string[] {
  return [...repo.refs.keys()].sort((a, b) => {
    const aHead = a.startsWith('refs/heads/');
    const bHead = b.startsWith('refs/heads/');
    if (aHead !== bHead) return aHead ? -1 : 1;
    return a < b ? -1 : 1;
  });
}

function tipOf(repo: Repo): string {
  return repo.refs.get('refs/heads/main') ?? ZERO_OID;
}

/** The v0 ref advertisement body for a service, with the "# service=" preamble. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const names = sortedRefs(repo);
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${tipOf(repo)} HEAD\0${caps}\n`));
    for (const name of names) {
      const oid = repo.refs.get(name)!;
      parts.push(pktLine(`${oid} ${name}\n`));
      const peeled = repo.objects.get(oid)?.type === 'tag' ? peelToCommit(repo, oid) : null;
      if (peeled !== null) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function peelToCommit(repo: Repo, tagOid: string): string | null {
  const object = repo.objects.get(tagOid);
  if (object === undefined || object.type !== 'tag') return null;
  const text = object.data.toString('utf8');
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  return match === null ? null : match[1];
}

/** The v2 capability advertisement body. */
function v2Advertisement(): Buffer {
  const lines = ['version 2', `agent=${AGENT}`, 'ls-refs=unborn', 'fetch=shallow filter', 'object-format=sha1', 'server-option'];
  const parts = lines.map((line) => pktLine(`${line}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** One ls-refs line, with the attributes the client asked for. */
function lsRefLine(repo: Repo, name: string, oid: string, peel: boolean, symrefs: boolean): Buffer {
  const attributes: string[] = [];
  if (name === 'HEAD') {
    if (symrefs) attributes.push('symref-target:refs/heads/main');
  } else if (peel) {
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== null) attributes.push(`peeled:${peeled}`);
    }
  }
  const suffix = attributes.length > 0 ? ` ${attributes.join(' ')}` : '';
  return pktLine(`${oid} ${name}${suffix}\n`);
}

function lsRefsResponse(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean): Buffer {
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const headKept = keep('HEAD');
  if (headKept) parts.push(lsRefLine(repo, 'HEAD', tipOf(repo), peel, symrefs));
  for (const name of sortedRefs(repo)) {
    if (!keep(name)) continue;
    parts.push(lsRefLine(repo, name, repo.refs.get(name)!, peel, symrefs));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Split pack bytes into sideband pkt-lines (band 1 = data). */
function sidebandChunks(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65500;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const slice = pack.subarray(at, Math.min(pack.length, at + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

/**
 * The objects a fetch must send: the closure of the wanted commits, minus
 * everything reachable from the haves, honouring a depth limit. Also answers
 * the shallow boundary (commits whose parents were cut off) and the unshallow
 * set (old shallow commits that are now fully present).
 */
function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  oldShallow: string[],
  depth: number | undefined,
  deepenRelative = false,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  // A relative deepen ("deepen N" + "deepen-relative") deepens the client's
  // current shallow boundary by N: the client's depth at a shallow commit is
  // its generation from the want plus one (the commit itself), so the new
  // absolute depth is max(gen(shallow) + 1 + N) over the reachable shallow
  // lines. An absolute deepen needs no adjustment.
  if (deepenRelative && depth !== undefined && oldShallow.length > 0) {
    const boundary = new Set(oldShallow);
    const gens = new Map<string, number>();
    const walk: { oid: string; gen: number }[] = [];
    for (const want of wants) {
      const object = repo.objects.get(want);
      if (object !== undefined && object.type === 'commit') walk.push({ oid: want, gen: 0 });
      else if (object !== undefined && object.type === 'tag') {
        const target = peelToCommit(repo, want);
        if (target !== null) walk.push({ oid: target, gen: 0 });
      }
    }
    while (walk.length > 0) {
      const { oid, gen } = walk.shift()!;
      if (gens.has(oid)) continue;
      gens.set(oid, gen);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parentOids(object.data)) walk.push({ oid: parent, gen: gen + 1 });
    }
    let deepest = -1;
    for (const oid of boundary) {
      const gen = gens.get(oid);
      if (gen !== undefined && gen > deepest) deepest = gen;
    }
    if (deepest >= 0) depth = deepest + 1 + depth;
  }
  // What the client already holds. A `have` is normally a full closure, but
  // a shallow client sends its boundary commits as `shallow` lines: it holds
  // such a commit and its tree, but NOT its parents. Walking past a shallow
  // boundary would make the server believe the client already has the
  // parents, so a deepen would deliver nothing.
  const shallowSet = new Set(oldShallow);
  const haveObjects = new Set<string>();
  const haveStack = [...haves];
  while (haveStack.length > 0) {
    const oid = haveStack.pop()!;
    if (haveObjects.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    haveObjects.add(oid);
    if (object.type === 'commit') {
      const text = object.data.toString('utf8');
      const head = text.split('\n\n')[0] ?? '';
      for (const line of head.split('\n')) {
        if (line.startsWith('tree ')) haveStack.push(line.slice(5).trim());
        else if (line.startsWith('parent ') && !shallowSet.has(oid)) haveStack.push(line.slice(7).trim());
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) haveStack.push(entry.oid);
    } else if (object.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== null) haveStack.push(peeled);
    }
  }

  // Walk the wanted history, generation by generation.
  const included = new Set<string>();
  const extraTags = new Set<string>();
  interface Front {
    oid: string;
    gen: number;
  }
  const queue: Front[] = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      extraTags.add(want);
      const target = peelToCommit(repo, want);
      if (target !== null) queue.push({ oid: target, gen: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, gen: 0 });
    }
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    if (depth !== undefined && gen >= depth) continue;
    included.add(oid);
    const parents = parentOids(object.data);
    for (const parent of parents) {
      if (!seen.has(parent)) queue.push({ oid: parent, gen: gen + 1 });
    }
  }
  // The shallow boundary is the included commits whose parents were cut off.
  const shallow = new Set<string>();
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    const parents = parentOids(object.data);
    if (parents.length === 0) continue;
    if (parents.some((parent) => !included.has(parent))) shallow.add(oid);
  }
  const unshallow = oldShallow.filter((oid) => included.has(oid) && !shallow.has(oid));

  // The object closure of the included commits (plus wanted tags), minus
  // everything the client already holds. A want the client already has sends
  // nothing new, which is what makes a no-op fetch transfer zero objects.
  // Crucially the closure must NOT cross the depth boundary: a shallow fetch
  // includes only the commits within `depth`, so their trees and blobs are
  // collected without ever walking into a parent commit that was cut off
  // (collectReachable would follow parents and leak the whole history).
  const send = new Set<string>();
  const stack: string[] = [...included];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (send.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    send.add(oid);
    if (object.type === 'commit') {
      const text = object.data.toString('utf8');
      const head = text.split('\n\n')[0] ?? '';
      for (const line of head.split('\n')) {
        if (line.startsWith('tree ')) stack.push(line.slice(5).trim());
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
  for (const oid of [...send]) {
    if (haveObjects.has(oid)) send.delete(oid);
  }
  for (const tag of extraTags) {
    if (!haveObjects.has(tag)) send.add(tag);
  }
  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallow: [...shallow].sort(), unshallow: unshallow.sort() };
}

function parentOids(commitData: Buffer): string[] {
  const parents: string[] = [];
  const text = commitData.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  for (const line of head.split('\n')) {
    if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return parents;
}

function collectReachable(repo: Repo, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const text = object.data.toString('utf8');
      const head = text.split('\n\n')[0] ?? '';
      for (const line of head.split('\n')) {
        if (line.startsWith('tree ')) stack.push(line.slice(5).trim());
        else if (line.startsWith('parent ')) stack.push(line.slice(7).trim());
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== null) stack.push(peeled);
    }
  }
  return seen;
}

/** Route one git smart-HTTP request; null when the path is not a git path. */
export function routeGit(forge: Forge, req: GitRequest): GitReply | null {
  const parts = req.pathname.split('/').filter((part) => part !== '');
  if (parts.length < 2 || !parts[1].endsWith('.git')) return null;
  const owner = parts[0];
  const repoName = parts[1].slice(0, -'.git'.length);
  const tail = parts.slice(2);
  if (owner !== VIEWER_LOGIN) return notFound();
  const repo = forge.getRepo(owner, repoName);
  const service = req.query.get('service') ?? '';

  try {
    if (req.method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
      if (repo === undefined) return notFound();
      if (service === 'git-receive-pack') {
        return reply(200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      }
      if (service === 'git-upload-pack') {
        const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        if (wantsV2) return reply(200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
        return reply(200, v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      }
      return textReply(400, 'unknown service');
    }

    if (req.method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
      if (repo === undefined) return notFound();
      return handleUploadPack(repo, req);
    }

    if (req.method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
      if (repo === undefined) return notFound();
      return handleReceivePack(repo, req);
    }
  } catch (err) {
    return textReply(400, err instanceof Error ? err.message : 'bad request');
  }
  return textReply(404, 'Not Found');
}

function handleUploadPack(repo: Repo, req: GitRequest): GitReply {
  const { packets } = decodePktLines(req.body);
  const lines = packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8'));
  const first = lines[0] ?? '';
  if (first.startsWith('command=ls-refs')) return handleLsRefs(repo, lines);
  if (first.startsWith('command=fetch')) return handleFetch(repo, lines, true);
  // No command line: a v0 fetch (want/have lines).
  return handleFetchV0(repo, lines);
}

function handleLsRefs(repo: Repo, lines: string[]): GitReply {
  // Delim packets are already filtered out by the caller, so the argument
  // lines are simply the ones that are not command/agent/object-format lines.
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const line of lines.slice(1)) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') {
      // Unborn refs are reported by lsRefsResponse via the zero-oid HEAD.
    } else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const body = lsRefsResponse(repo, prefixes, peel, symrefs);
  return reply(200, body, 'application/x-git-upload-pack-result');
}

function parseFetchArgs(lines: string[]): {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  deepenRelative: boolean;
  done: boolean;
} {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let deepenRelative = false;
  let done = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    // In v0 the first want line carries the negotiated features after the oid
    // ("want <oid> thin-pack ofs-delta ..."), so only the first token counts.
    const firstToken = (text: string): string => text.split(/\s+/)[0] ?? '';
    if (line.startsWith('want ')) wants.push(firstToken(line.slice(5).trim()));
    else if (line.startsWith('have ')) haves.push(firstToken(line.slice(5).trim()));
    else if (line.startsWith('shallow ')) shallow.push(firstToken(line.slice(8).trim()));
    else if (line === 'done') done = true;
    else if (line === 'deepen-relative') deepenRelative = true;
    else if (line.startsWith('deepen ')) {
      const value = Number(line.slice(7).trim());
      if (Number.isSafeInteger(value) && value > 0) depth = value;
    }
  }
  return { wants, haves, shallow, depth, deepenRelative, done };
}

function fetchResponseV2(repo: Repo, args: ReturnType<typeof parseFetchArgs>): GitReply {
  // Wire shape, per git's fetch-pack v2 state machine (fetch-pack.c):
  // when the client sent `done`, it skips the acknowledgment round entirely
  // and goes straight to FETCH_GET_PACK, where the first section it peeks
  // for is `shallow-info` (optional) and then `packfile` (required). Sending
  // an `acknowledgments` section first makes it die with
  // "expected 'packfile', received 'acknowledgments'". So with `done` there
  // is no acknowledgments section at all: shallow-info (if any) then
  // packfile, then a flush. Without `done` the client is still negotiating:
  // acknowledge the haves the server holds and send `ready` plus the pack
  // in this same response (a delim separates the sections); with no known
  // have, answer NAK and end with a flush so the client sends another round.
  if (!args.done) {
    const known = args.haves.filter((have) => repo.objects.get(have)?.type === 'commit');
    if (known.length === 0) {
      return reply(
        200,
        Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH]),
        'application/x-git-upload-pack-result',
      );
    }
    const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth, args.deepenRelative);
    const pack = writePack(plan.objects);
    const parts: Buffer[] = [pktLine('acknowledgments\n')];
    for (const have of known) parts.push(pktLine(`ACK ${have}\n`));
    parts.push(pktLine('ready\n'), PKT_DELIM);
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    for (const chunk of sidebandChunks(pack)) parts.push(chunk);
    parts.push(PKT_FLUSH);
    return reply(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
  }
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth, args.deepenRelative);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  for (const chunk of sidebandChunks(pack)) parts.push(chunk);
  parts.push(PKT_FLUSH);
  return reply(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleFetch(repo: Repo, lines: string[], _v2: boolean): GitReply {
  const args = parseFetchArgs(lines);
  return fetchResponseV2(repo, args);
}

function handleFetchV0(repo: Repo, lines: string[]): GitReply {
  const args = parseFetchArgs(lines);
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const chunk of sidebandChunks(pack)) parts.push(chunk);
  parts.push(PKT_FLUSH);
  return reply(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, req: GitRequest): GitReply {
  const { packets, rest } = decodePktLinesUntilFlush(req.body);
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      const caps = line.slice(nul + 1).replace(/\n$/, '');
      if (caps.split(' ').includes('side-band-64k')) sideband = true;
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(line);
    if (match === null) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const read = readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  interface Verdict {
    ref: string;
    ok: boolean;
    reason: string;
  }
  const verdicts: Verdict[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (!unpackOk) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (current === undefined) verdicts.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      else verdicts.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) verdicts.push({ ref: command.ref, ok: false, reason: 'already exists' });
      else if (!isOid(command.newOid) || repo.objects.get(command.newOid) === undefined) verdicts.push({ ref: command.ref, ok: false, reason: 'object not found' });
      else verdicts.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (current === undefined) verdicts.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
    else if (current !== command.oldOid) verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    else if (repo.objects.get(command.newOid) === undefined) verdicts.push({ ref: command.ref, ok: false, reason: 'object not found' });
    else if (!isFastForward(repo, current, command.newOid)) verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    else verdicts.push({ ref: command.ref, ok: true, reason: '' });
  }

  // Apply only the accepted commands.
  for (let index = 0; index < commands.length; index += 1) {
    if (!verdicts[index].ok) continue;
    const command = commands[index];
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
  }

  const reportLines: string[] = [`unpack ${unpackDetail}`];
  for (const verdict of verdicts) {
    reportLines.push(verdict.ok ? `ok ${verdict.ref}` : `ng ${verdict.ref} ${verdict.reason}`);
  }
  // Real git's receive-pack report() flushes the report buffer *inside* the
  // sideband stream (packet_buf_flush before send_sideband), then flushes
  // once more outside it. The inner flush matters: git's receive_status
  // reader stops cleanly on it; without it the reader hits EOF on the
  // demux pipe and dies with "the remote end hung up unexpectedly".
  const inner = Buffer.concat([
    ...reportLines.map((line) => pktLine(`${line}\n`)),
    PKT_FLUSH,
  ]);
  const parts: Buffer[] = [];
  if (sideband) {
    const CHUNK = 65500;
    for (let at = 0; at < inner.length; at += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(at, Math.min(inner.length, at + CHUNK))])));
    }
    if (inner.length === 0) parts.push(pktLine(Buffer.from([1])));
  } else {
    parts.push(inner);
  }
  parts.push(PKT_FLUSH);
  return reply(200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

/** True when `next` descends from `current` (or equals it). */
function isFastForward(repo: Repo, current: string, next: string): boolean {
  if (current === next) return true;
  const seen = new Set<string>();
  const stack = [next];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === current) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parentOids(object.data)) stack.push(parent);
  }
  return false;
}
