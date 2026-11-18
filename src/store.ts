// anvil — the forge's in-memory store: repositories, git objects and refs,
// issues, labels, comments and pull requests. One process, no disk, no clock
// reads for ordering: a monotonically increasing sequence number stamps
// everything, so two runs that take the same requests in the same order
// produce the same ids, the same commit hashes and the same listings.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type ObjKind,
} from './gitcore.ts';

/** The login the bearer token names. The trial's scenario is fixed and
 * published in the kit, so its first generated user is the token owner and
 * its third is the unrelated stranger the ownership checks use. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
export const VIEWER_ID = 1000;

export const IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;

/** Fixed epoch (2025-01-01T00:00:00Z); sequence seconds are added to it. */
const EPOCH_SEC = 1_735_689_600;

export function stampOf(seq: number): number {
  return EPOCH_SEC + seq;
}

export function isoOf(seq: number): string {
  return new Date(stampOf(seq) * 1000).toISOString();
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  seq: number;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  mergeSha: string | null;
  mergedAt: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Label[];
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private seq = 0;

  /** The next sequence number (also the deterministic clock). */
  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.getRepo(VIEWER_LOGIN, name) !== undefined) return null;
    const seq = this.tick();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER_LOGIN,
      description,
      isPrivate,
      defaultBranch: 'main',
      seq,
      createdAt: isoOf(seq),
      updatedAt: isoOf(seq),
      objects: new Map(),
      refs: new Map(),
      labels: [],
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  // ------------------------------------------------------------- git objects

  putObject(repo: Repo, type: ObjKind, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** Resolve a branch name, a full ref, or a raw commit id to a commit id. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) return tag;
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const object = repo.objects.get(ref);
      if (object !== undefined && object.type === 'commit') return ref;
      if (object !== undefined && object.type === 'tag') return parseTag(object.data).object;
    }
    return undefined;
  }

  /** Peel a tag object to its commit, or return the id unchanged. */
  peel(repo: Repo, oid: string): string {
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') return parseTag(object.data).object;
    return oid;
  }

  /** Flatten a commit's tree into path -> {oid, mode}. */
  flatTree(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return out;
    const root = parseCommit(commit.data).tree;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined) return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(root, '');
    return out;
  }

  /** Build (and store) the tree for a flat path map; returns the root tree id. */
  buildTreeFor(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, value] of files) {
      const parts = path.split('/');
      let node = root;
      for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index];
        if (!node.dirs.has(part)) node.dirs.set(part, make());
        node = node.dirs.get(part)!;
      }
      node.files.set(parts[parts.length - 1], value);
    }
    const build = (node: Node): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Make a commit on top of `parents` with the given flat file map. */
  makeCommit(repo: Repo, files: Map<string, { oid: string; mode: string }>, parents: string[], message: string): string {
    const seq = this.tick();
    const tree = this.buildTreeFor(repo, files);
    const data = buildCommit({
      tree,
      parents,
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: IDENTITY,
      committer: IDENTITY,
      stamp: stampOf(seq),
    });
    return this.putObject(repo, 'commit', data);
  }

  /** Every object id reachable from the tips (commits, trees, blobs, tags). */
  reachable(repo: Repo, tips: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const view = parseCommit(object.data);
        stack.push(view.tree);
        for (const parent of view.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return seen;
  }

  /** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return false;
  }

  /** A merge base of two commits: the first common ancestor found walking both sides. */
  mergeBase(repo: Repo, left: string, right: string): string | null {
    const leftAncestors = new Set<string>();
    const stack = [left];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (leftAncestors.has(oid)) continue;
      leftAncestors.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    const queue = [right];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (leftAncestors.has(oid)) return oid;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return null;
  }

  /** Commits reachable from `tip`, newest first (parents after their child). */
  commitWalk(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return out;
  }

  // ------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const seq = this.tick();
    const issue: Issue = {
      id: repo.id * 100000 + repo.nextIssue,
      number: repo.nextIssue,
      title,
      body,
      state: 'open',
      labels: [...labels],
      user: VIEWER_LOGIN,
      seq,
      createdAt: isoOf(seq),
      updatedAt: isoOf(seq),
      closedAt: null,
      comments: [],
    };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return issue;
  }

  // ------------------------------------------------------------- pull requests

  createPull(repo: Repo, title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string): Pull {
    const seq = this.tick();
    const pull: Pull = {
      id: repo.id * 100000 + repo.nextPull,
      number: repo.nextPull,
      title,
      body,
      state: 'open',
      merged: false,
      headRef,
      headSha,
      baseRef,
      baseSha,
      mergeSha: null,
      mergedAt: null,
      seq,
      createdAt: isoOf(seq),
      updatedAt: isoOf(seq),
    };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /** The files a pull request changes, diffed merge-base -> head. */
  pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const base = this.mergeBase(repo, baseTip, headTip) ?? pull.baseSha;
    return diffFileMaps(this.flatTree(repo, base), this.flatTree(repo, headTip), repo);
  }

  /** Is this pull request mergeable right now (no three-way conflict)? */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    return mergeConflictPaths(repo, this, pull).length === 0;
  }
}

/** Line counts for a diff between two file maps. */
export function diffFileMaps(
  oldMap: Map<string, { oid: string; mode: string }>,
  newMap: Map<string, { oid: string; mode: string }>,
  repo: Repo,
): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  const paths = new Set([...oldMap.keys(), ...newMap.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = oldMap.get(path);
    const newEntry = newMap.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
    const oldText = oldEntry === undefined ? '' : (repo.objects.get(oldEntry.oid)?.data.toString('utf8') ?? '');
    const newText = newEntry === undefined ? '' : (repo.objects.get(newEntry.oid)?.data.toString('utf8') ?? '');
    const { added, removed } = lineDiff(oldText, newText);
    const status = oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified';
    out.push({ filename: path, status, additions: added, deletions: removed, changes: added + removed });
  }
  return out;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Multiset line diff: lines present in one side but not the other. */
function lineDiff(oldText: string, newText: string): { added: number; removed: number } {
  const oldCounts = new Map<string, number>();
  for (const line of splitLines(oldText)) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of splitLines(newText)) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else added += 1;
  }
  let removed = 0;
  for (const left of oldCounts.values()) removed += left;
  return { added, removed };
}

/** Paths where the head and the default branch both changed the same file differently. */
export function mergeConflictPaths(repo: Repo, forge: Forge, pull: Pull): string[] {
  const headTip = forge.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = forge.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const base = forge.mergeBase(repo, baseTip, headTip);
  if (base === null) return [];
  const baseMap = forge.flatTree(repo, base);
  const headMap = forge.flatTree(repo, headTip);
  const tipMap = forge.flatTree(repo, baseTip);
  const conflicts: string[] = [];
  const paths = new Set([...baseMap.keys(), ...headMap.keys(), ...tipMap.keys()]);
  for (const path of paths) {
    const atBase = baseMap.get(path)?.oid ?? null;
    const atHead = headMap.get(path)?.oid ?? null;
    const atTip = tipMap.get(path)?.oid ?? null;
    const headChanged = atHead !== atBase;
    const tipChanged = atTip !== atBase;
    if (headChanged && tipChanged && atHead !== atTip) conflicts.push(path);
  }
  return conflicts;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit id, or null on conflict. */
export function squashMerge(forge: Forge, repo: Repo, pull: Pull): string | null {
  const headTip = forge.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = forge.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  if (mergeConflictPaths(repo, forge, pull).length > 0) return null;
  const base = forge.mergeBase(repo, baseTip, headTip) ?? pull.baseSha;
  const baseMap = forge.flatTree(repo, base);
  const headMap = forge.flatTree(repo, headTip);
  const tipMap = forge.flatTree(repo, baseTip);
  const merged = new Map(tipMap);
  for (const [path, entry] of headMap) merged.set(path, entry);
  for (const path of baseMap.keys()) {
    if (!headMap.has(path)) merged.delete(path);
  }
  const seq = forge.tick();
  const sha = forge.makeCommit(repo, merged, [baseTip], `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`);
  void seq;
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeSha = sha;
  pull.mergedAt = isoOf(forge.tick());
  pull.updatedAt = pull.mergedAt;
  return sha;
}
