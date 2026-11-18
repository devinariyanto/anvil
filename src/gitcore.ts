// anvil — git object layer: hashing, loose object encoding, trees, commits,
// packfiles (read + write, including delta resolution) and pkt-line framing.
// Written from the git wire format itself; only node:crypto and node:zlib.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjKind = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjKind;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const KIND_CODE: Record<ObjKind, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_KIND: Record<number, ObjKind> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The SHA-1 id of an object: sha1("<type> <size>\0" + bytes). */
export function hashObject(type: ObjKind, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** Build a commit body. `stamp` is seconds since the epoch; identity is "Name <mail>". */
export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  stamp: number;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author} ${input.stamp} +0000`);
  lines.push(`committer ${input.committer} ${input.stamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

/** Build an annotated tag body. */
export function buildTag(input: {
  object: string;
  type: ObjKind;
  tag: string;
  message: string;
  tagger: string;
  stamp: number;
}): Buffer {
  return Buffer.from(
    `object ${input.object}\ntype ${input.type}\ntag ${input.tag}\ntagger ${input.tagger} ${input.stamp} +0000\n\n${input.message}`,
    'utf8',
  );
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Split a commit body into its headers and message. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree body into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) throw new Error('tree entry has no mode');
    const mode = data.subarray(at, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0) throw new Error('tree entry has no name');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

/** Git's tree sort: directory names compare as if they ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Encode entries as a tree body, in git's order. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// packfiles

/** Encode one pack object header: type code + size in git's varint form. */
function packObjectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let rest = size;
  let first = (type << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Write a packfile of whole objects (no deltas): header, deflated entries, SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  parts.push(head);
  for (const object of list) {
    parts.push(packObjectHeader(KIND_CODE[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Check a packfile's trailer against its bytes. */
export function packChecksumOk(pack: Buffer): boolean {
  if (pack.length < 32) return false;
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return actual === expected;
}

function readSizeVarint(buf: Buffer, at: number): { size: number; next: number } {
  let size = buf[at] & 0x0f;
  let shift = 4;
  let pos = at + 1;
  let byte = buf[at];
  while (byte & 0x80) {
    byte = buf[pos];
    size |= (byte & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { size, next: pos };
}

function readOfsBase(buf: Buffer, at: number): { baseOffset: number; next: number } {
  let byte = buf[at];
  let offset = byte & 0x7f;
  let pos = at + 1;
  while (byte & 0x80) {
    byte = buf[pos];
    offset = ((offset + 1) << 7) | (byte & 0x7f);
    pos += 1;
  }
  return { baseOffset: offset, next: pos };
}

function readDeltaSize(buf: Buffer, at: number): { size: number; next: number } {
  let size = 0;
  let shift = 0;
  let pos = at;
  for (;;) {
    const byte = buf[pos];
    size |= (byte & 0x7f) << shift;
    shift += 7;
    pos += 1;
    if (!(byte & 0x80)) break;
  }
  return { size, next: pos };
}

/** Apply a git delta to its base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const baseSize = readDeltaSize(delta, 0);
  if (baseSize.size !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readDeltaSize(delta, baseSize.next);
  const out: Buffer[] = [];
  let produced = 0;
  let at = resultSize.next;
  while (at < delta.length) {
    const op = delta[at];
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          offset |= delta[at] << (bit * 8);
          at += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          size |= delta[at] << (bit * 8);
          at += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(at, at + op));
      produced += op;
      at += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize.size || produced !== resultSize.size) throw new Error('delta result size mismatch');
  return result;
}

export interface PackRead {
  objects: Map<string, GitObject>;
  deltaCount: number;
  declared: number;
}

/**
 * Read a packfile into objects. `lookup` resolves REF_DELTA bases the pack itself
 * does not carry (objects the server already holds). Throws on a bad header,
 * a bad trailer, or an unresolvable delta.
 */
export function readPack(pack: Buffer, lookup?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  if (!packChecksumOk(pack)) throw new Error('pack trailer checksum mismatch');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declared = pack.readUInt32BE(8);
  interface Raw {
    type: number;
    data: Buffer;
    ofsBase?: number;
    refBase?: string;
    offset: number;
    oid: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let at = 12;
  let deltas = 0;
  for (let index = 0; index < declared; index += 1) {
    const start = at;
    const type = (pack[at] >> 4) & 0x7;
    const sizeInfo = readSizeVarint(pack, at);
    at = sizeInfo.next;
    let ofsBase: number | undefined;
    let refBase: string | undefined;
    if (type === 6) {
      const ofs = readOfsBase(pack, at);
      ofsBase = start - ofs.baseOffset;
      at = ofs.next;
      deltas += 1;
    } else if (type === 7) {
      refBase = pack.subarray(at, at + 20).toString('hex');
      at += 20;
      deltas += 1;
    }
    const end = findInflateEnd(pack, at);
    const data = inflateSync(pack.subarray(at, end));
    if (data.length !== sizeInfo.size) throw new Error('pack object size mismatch');
    const entry: Raw = { type, data, offset: start, oid: '' };
    if (ofsBase !== undefined) entry.ofsBase = ofsBase;
    if (refBase !== undefined) entry.refBase = refBase;
    raw.push(entry);
    byOffset.set(start, entry);
    at = end;
  }
  const resolved = new Map<string, GitObject>();
  const byOid = new Map<string, GitObject>();
  const resolve = (entry: Raw, seen: Set<number>): GitObject => {
    if (entry.type === 6 || entry.type === 7) {
      if (seen.has(entry.offset)) throw new Error('delta cycle');
      seen.add(entry.offset);
      let base: GitObject | undefined;
      if (entry.ofsBase !== undefined) {
        const baseEntry = byOffset.get(entry.ofsBase);
        if (baseEntry === undefined) throw new Error('ofs-delta base outside the pack');
        base = resolve(baseEntry, seen);
      } else if (entry.refBase !== undefined) {
        base = byOid.get(entry.refBase) ?? lookup?.(entry.refBase);
        if (base === undefined) throw new Error(`ref-delta base ${entry.refBase} is not available`);
      }
      if (base === undefined) throw new Error('delta with no base');
      const data = applyDelta(base.data, entry.data);
      const object: GitObject = { type: base.type, data };
      entry.oid = hashObject(object.type, object.data);
      resolved.set(entry.oid, object);
      byOid.set(entry.oid, object);
      return object;
    }
    const type = CODE_KIND[entry.type];
    if (type === undefined) throw new Error(`unknown pack object type ${entry.type}`);
    const object: GitObject = { type, data: entry.data };
    entry.oid = hashObject(type, entry.data);
    resolved.set(entry.oid, object);
    byOid.set(entry.oid, object);
    return object;
  };
  for (const entry of raw) resolve(entry, new Set());
  return { objects: resolved, deltaCount: deltas, declared };
}

/** Find where the zlib stream starting at `at` ends: inflateSync throws on a
 * truncated stream and ignores trailing bytes, so the smallest end that
 * inflates cleanly is the true end. An exponential probe keeps the work
 * proportional to the object's own compressed size (a binary search over the
 * whole pack would re-inflate the entire pack for every object). */
function findInflateEnd(pack: Buffer, at: number): number {
  const limit = pack.length - 20; // the 20-byte trailer is never stream data
  let step = 16;
  let prevFail = at + 2; // too short to be a complete zlib stream
  for (;;) {
    const end = Math.min(at + step, limit);
    if (end <= prevFail) throw new Error('could not inflate a pack object');
    try {
      inflateSync(pack.subarray(at, end));
    } catch {
      if (end >= limit) throw new Error('could not inflate a pack object');
      prevFail = end;
      step *= 2;
      continue;
    }
    // Binary search the smallest working end in (prevFail, end].
    let low = prevFail;
    let high = end;
    let answer = end;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      try {
        inflateSync(pack.subarray(at, mid));
        answer = mid;
        high = mid - 1;
      } catch {
        low = mid + 1;
      }
    }
    return answer;
  }
}

// ---------------------------------------------------------------------------
// pkt-line framing

export type PktKind = 'data' | 'flush' | 'delim' | 'end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Encode one pkt-line: 4 hex digits of (length + 4) then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

/** Decode a whole buffer of pkt-lines. Throws on a malformed length prefix. */
export function decodePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let at = 0;
  while (at < buf.length) {
    if (at + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(at, at + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (head === '0002') {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    const length = Number.parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || at + length > buf.length) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(head)}`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

/** Decode pkt-lines up to (and including) the first flush; the rest is raw data. */
export function decodePktLinesUntilFlush(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let at = 0;
  while (at < buf.length) {
    if (at + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(at, at + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, rest: buf.subarray(at + 4) };
    }
    if (head === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (head === '0002') {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    const length = Number.parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || at + length > buf.length) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(head)}`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}
