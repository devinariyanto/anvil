// anvil — REST v3 under /api/v3: repositories, branches, commits, contents,
// labels, issues, comments and pull requests, all over the in-memory store.
// Every reply is JSON; every error body carries a string `message`.

import { parseCommit, parseTree } from './gitcore.ts';
import {
  diffFileMaps,
  mergeConflictPaths,
  squashMerge,
  VIEWER_ID,
  VIEWER_LOGIN,
  isoOf,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { commentGlobalId, issueGlobalId, nextLink, pageOf, paginate, pullGlobalId, repoGlobalId } from './util.ts';

/** One routed request, as the HTTP layer hands it over. */
export interface RestRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  host: string;
  body: unknown;
}

export interface RestReply {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

function ok(status: number, json: unknown, headers?: Record<string, string>): RestReply {
  return { status, json, headers };
}

function fail(status: number, message: string): RestReply {
  return { status, json: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

function boolField(body: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

/** The public repository object. */
export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User', html_url: `https://github.com/${repo.owner}` },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    created_at: repo.createdAt,
    updatedAt: repo.updatedAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    watchers_count: 0,
    stargazers_count: 0,
  };
}

function labelJson(label: { name: string; color: string; description: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const found = repo.labels.find((label) => label.name === name);
      return labelJson(found ?? { name, color: 'ededed', description: '' });
    }),
    user: { login: issue.user, id: VIEWER_ID, type: 'User' },
    assignee: null,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(repo: Repo, comment: { id: number; body: string; user: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(repo.id, comment.id),
    body: comment.body,
    user: { login: comment.user, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

export function pullJson(repo: Repo, pull: Pull, forge: Forge): Record<string, unknown> {
  const open = pull.state === 'open';
  return {
    id: pull.id,
    node_id: pullGlobalId(repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
      repo: repoJson(repo),
    },
    merged: pull.merged,
    mergeable: open ? mergeConflictPaths(repo, forge, pull).length === 0 : false,
    merge_commit_sha: pull.mergeSha,
    merged_at: pull.mergedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'open' ? null : pull.mergedAt ?? pull.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Split "Name <mail> 1234567890 +0000" into its parts. */
function splitIdentity(line: string): { name: string; email: string; stamp: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line.trim());
  if (match === null) return { name: line, email: '', stamp: 0 };
  return { name: match[1], email: match[2], stamp: Number(match[3]) };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const view = parseCommit(object.data);
  const author = splitIdentity(view.author);
  const committer = splitIdentity(view.committer);
  return {
    sha: oid,
    commit: {
      // Git stores the message with a trailing newline; the API presents it
      // without, the way GitHub does, so an exact-match read-back works.
      message: view.message.replace(/\n+$/, ''),
      author: { name: author.name, email: author.email, date: new Date(author.stamp * 1000).toISOString() },
      committer: { name: committer.name, email: committer.email, date: new Date(committer.stamp * 1000).toISOString() },
      tree: { sha: view.tree },
    },
    parents: view.parents.map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
  };
}

const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** A repository the token owner may see, or null (any other owner is a 404). */
function needRepo(forge: Forge, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return forge.getRepo(owner, name) ?? null;
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Route one REST request. Returns null when the path is not under /api/v3
 * (the caller then tries the other surfaces).
 */
export function routeRest(forge: Forge, req: RestRequest): RestReply | null {
  const segments = req.pathname.split('/').filter((part) => part !== '').map(decodePath);
  if (segments[0] !== 'api' || segments[1] !== 'v3') return null;
  const rest = segments.slice(2);
  const method = req.method;
  const body = isRecord(req.body) ? req.body : {};

  // GET /api/v3/ — the API root.
  if (rest.length === 0) {
    if (method !== 'GET') return fail(404, 'Not Found');
    return ok(
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return fail(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') return fail(404, 'Not Found');
    return ok(200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: `U_${Buffer.from(`user:${VIEWER_ID}`, 'utf8').toString('base64url')}`,
      type: 'User',
      name: 'ada iversen',
      email: 'adaiversen@example.invalid',
      html_url: `https://github.com/${VIEWER_LOGIN}`,
    });
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const page = pageOf(req.query);
      const listed = paginate(forge.listRepos(), page);
      const headers: Record<string, string> = {};
      const link = nextLink(req.host, req.pathname, req.query, page, listed.totalPages);
      if (link !== null) headers.link = link;
      return ok(200, listed.items.map(repoJson), headers);
    }
    if (method === 'POST') {
      const name = strField(body, 'name');
      if (name === '' || !NAME_OK.test(name)) return fail(422, 'Repository name is invalid');
      const created = forge.createRepo(name, boolField(body, 'private', false), strField(body, 'description'));
      if (created === null) return fail(422, 'Repository already exists');
      return ok(201, repoJson(created));
    }
    return fail(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1];
    const name = rest[2];
    const repo = needRepo(forge, owner, name);
    const tail = rest.slice(3);

    if (tail.length === 0) {
      if (repo === null) return fail(404, 'Not Found');
      if (method === 'GET') return ok(200, repoJson(repo));
      if (method === 'PATCH') {
        const description = body.description;
        if (typeof description === 'string') repo.description = description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        repo.updatedAt = isoOf(forge.tick());
        return ok(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        forge.deleteRepo(owner, name);
        return { status: 204, json: null };
      }
      return fail(404, 'Not Found');
    }

    if (repo === null) return fail(404, 'Not Found');

    // branches
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) ?? '' }, protected: false }));
        return ok(200, list);
      }
      if (tail.length >= 2 && method === 'GET') {
        const branch = tail.slice(1).join('/');
        const tip = forge.branchTip(repo, branch);
        if (tip === undefined) return fail(404, 'Not Found');
        return ok(200, { name: branch, commit: { sha: tip }, protected: false });
      }
      return fail(404, 'Not Found');
    }

    // commits
    if (tail[0] === 'commits') {
      if (tail.length === 1 && method === 'GET') {
        const ref = req.query.get('sha') ?? repo.defaultBranch;
        const tip = forge.resolveRef(repo, ref);
        if (tip === undefined) return ok(200, []);
        const walked = forge.commitWalk(repo, tip);
        const page = pageOf(req.query);
        const listed = paginate(walked, page);
        const items = listed.items.map((oid) => commitJson(repo, oid)).filter((entry) => entry !== null);
        return ok(200, items);
      }
      if (tail.length === 2 && method === 'GET') {
        const found = commitJson(repo, tail[1]);
        if (found === null) return fail(404, 'Not Found');
        return ok(200, found);
      }
      return fail(404, 'Not Found');
    }

    // git refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = strField(body, 'ref');
        const sha = strField(body, 'sha');
        if (!ref.startsWith('refs/')) return fail(422, 'Invalid ref name');
        if (!/^[0-9a-f]{40}$/.test(sha) || repo.objects.get(sha) === undefined) return fail(422, 'Invalid sha');
        if (repo.refs.has(ref)) return fail(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        return ok(201, { ref, object: { sha, type: 'commit' } });
      }
      if (method === 'GET' && tail.length === 2) {
        const list = [...repo.refs.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
        return ok(200, list);
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = `refs/${tail.slice(2).join('/')}`;
        const tip = repo.refs.get(ref);
        if (tip === undefined) return fail(404, 'Not Found');
        return ok(200, { ref, object: { sha: tip, type: 'commit' } });
      }
      return fail(404, 'Not Found');
    }

    // contents
    if (tail[0] === 'contents') {
      return routeContents(forge, repo, tail.slice(1).join('/'), req, body);
    }

    // labels
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) return ok(200, repo.labels.map(labelJson));
      if (method === 'POST' && tail.length === 1) {
        const labelName = strField(body, 'name');
        if (labelName === '') return fail(422, 'Label name is required');
        const existing = repo.labels.find((label) => label.name === labelName);
        if (existing !== undefined) return ok(201, labelJson(existing));
        const label = { name: labelName, color: strField(body, 'color') || 'ededed', description: strField(body, 'description') };
        repo.labels.push(label);
        return ok(201, labelJson(label));
      }
      return fail(404, 'Not Found');
    }

    // issues
    if (tail[0] === 'issues') {
      return routeIssues(forge, repo, tail.slice(1), req, body);
    }

    // pulls
    if (tail[0] === 'pulls') {
      return routePulls(forge, repo, tail.slice(1), req, body);
    }

    return fail(404, 'Not Found');
  }

  return fail(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// contents

function routeContents(forge: Forge, repo: Repo, path: string, req: RestRequest, body: Record<string, unknown>): RestReply {
  const method = req.method;
  const refParam = req.query.get('ref') ?? undefined;
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : undefined;

  /** The commit a read/write starts from, and the branch it belongs to. */
  const startPoint = (wantedBranch: string | undefined): { tip: string | undefined; branch: string } => {
    if (wantedBranch !== undefined) {
      return { tip: forge.branchTip(repo, wantedBranch), branch: wantedBranch };
    }
    if (refParam !== undefined) {
      const resolved = forge.resolveRef(repo, refParam);
      return { tip: resolved, branch: refParam };
    }
    return { tip: forge.branchTip(repo, repo.defaultBranch), branch: repo.defaultBranch };
  };

  if (method === 'GET') {
    const { tip } = startPoint(undefined);
    if (tip === undefined) return fail(404, 'Not Found');
    const files = forge.flatTree(repo, tip);
    if (path === '') {
      return ok(200, directoryListing(repo, files, '', tip));
    }
    const file = files.get(path);
    if (file !== undefined) {
      const object = repo.objects.get(file.oid);
      const content = object === undefined ? Buffer.alloc(0) : object.data;
      return ok(200, {
        type: 'file',
        encoding: 'base64',
        size: content.length,
        name: path.split('/').pop() ?? path,
        path,
        content: content.toString('base64'),
        sha: file.oid,
      });
    }
    const prefix = `${path}/`;
    if ([...files.keys()].some((key) => key.startsWith(prefix))) {
      return ok(200, directoryListing(repo, files, path, tip));
    }
    return fail(404, 'Not Found');
  }

  if (method === 'PUT') {
    const message = strField(body, 'message');
    const contentB64 = strField(body, 'content');
    if (contentB64 === '') return fail(422, 'Content is required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return fail(422, 'Content is not valid base64');
    }
    const wantedBranch = branch ?? repo.defaultBranch;
    let { tip } = startPoint(wantedBranch);
    if (tip === undefined && wantedBranch !== repo.defaultBranch) {
      // A write to a branch that does not exist yet starts from the default tip.
      tip = forge.branchTip(repo, repo.defaultBranch);
    }
    const files = tip === undefined ? new Map<string, { oid: string; mode: string }>() : forge.flatTree(repo, tip);
    const existing = files.get(path);
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (givenSha !== undefined) {
      if (existing === undefined || existing.oid !== givenSha) return fail(409, 'Conflict: sha does not match the current blob');
    }
    const blobOid = forge.putObject(repo, 'blob', content);
    const isNew = existing === undefined;
    files.set(path, { oid: blobOid, mode: '100644' });
    const parents = tip === undefined ? [] : [tip];
    const commitSha = forge.makeCommit(repo, files, parents, message === '' ? `Update ${path}` : message);
    repo.refs.set(`refs/heads/${wantedBranch}`, commitSha);
    repo.updatedAt = isoOf(forge.tick());
    return ok(isNew ? 201 : 200, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, encoding: 'base64' },
      commit: { sha: commitSha, message: message === '' ? `Update ${path}` : message },
    });
  }

  if (method === 'DELETE') {
    const wantedBranch = branch ?? repo.defaultBranch;
    const { tip } = startPoint(wantedBranch);
    if (tip === undefined) return fail(404, 'Not Found');
    const files = forge.flatTree(repo, tip);
    const existing = files.get(path);
    if (existing === undefined) return fail(404, 'Not Found');
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (givenSha !== undefined && givenSha !== existing.oid) return fail(409, 'Conflict: sha does not match the current blob');
    files.delete(path);
    const message = strField(body, 'message');
    const commitSha = forge.makeCommit(repo, files, [tip], message === '' ? `Delete ${path}` : message);
    repo.refs.set(`refs/heads/${wantedBranch}`, commitSha);
    repo.updatedAt = isoOf(forge.tick());
    return ok(200, { commit: { sha: commitSha } });
  }

  return fail(404, 'Not Found');
}

/** The immediate children of `dir` inside a flat file map. */
function directoryListing(repo: Repo, files: Map<string, { oid: string; mode: string }>, dir: string, tip: string): Record<string, unknown>[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { type: string; oid: string }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      seen.set(rest, { type: 'file', oid: entry.oid });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) {
        // A directory's sha is its tree id, read off the tip's tree.
        seen.set(name, { type: 'dir', oid: dirTreeOid(repo, dir === '' ? name : `${dir}/${name}`, tip) });
      }
    }
  }
  return [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, entry]) => ({
      type: entry.type,
      name,
      path: prefix + name,
      sha: entry.oid,
      size: entry.type === 'file' ? (repo.objects.get(entry.oid)?.data.length ?? 0) : 0,
    }));
}

/** The tree id of a directory path, walked from the given commit's tree. */
function dirTreeOid(repo: Repo, dirPath: string, tip: string): string {
  const commit = repo.objects.get(tip);
  if (commit === undefined) return '';
  let treeOid = parseCommit(commit.data).tree;
  for (const part of dirPath.split('/')) {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined) return '';
    const found = parseTree(tree.data).find((entry) => entry.name === part && entry.mode === '40000');
    if (found === undefined) return '';
    treeOid = found.oid;
  }
  return treeOid;
}

// ---------------------------------------------------------------------------
// issues

function routeIssues(forge: Forge, repo: Repo, tail: string[], req: RestRequest, body: Record<string, unknown>): RestReply {
  const method = req.method;

  if (tail.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let listed = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      if (sort === 'created') {
        listed = [...listed].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const page = pageOf(req.query);
      const sliced = paginate(listed, page);
      const headers: Record<string, string> = {};
      const link = nextLink(req.host, req.pathname, req.query, page, sliced.totalPages);
      if (link !== null) headers.link = link;
      return ok(200, sliced.items.map((issue) => issueJson(repo, issue)), headers);
    }
    if (method === 'POST') {
      const title = strField(body, 'title');
      if (title === '') return fail(422, 'Title is required');
      const wanted = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
      for (const name of wanted) {
        if (!repo.labels.some((label) => label.name === name)) {
          return fail(422, `Label does not exist: ${name}`);
        }
      }
      const issue = forge.createIssue(repo, title, strField(body, 'body'), wanted);
      return ok(201, issueJson(repo, issue));
    }
    return fail(404, 'Not Found');
  }

  const number = Number(tail[0]);
  if (!Number.isSafeInteger(number) || number < 1) return fail(404, 'Not Found');
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return fail(404, 'Not Found');

  if (tail.length === 1) {
    if (method === 'GET') return ok(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? isoOf(forge.tick()) : null;
      }
      if (Array.isArray(body.labels)) {
        const wanted = body.labels.filter((label): label is string => typeof label === 'string');
        for (const name of wanted) {
          if (!repo.labels.some((label) => label.name === name)) return fail(422, `Label does not exist: ${name}`);
        }
        issue.labels = wanted;
      }
      issue.updatedAt = isoOf(forge.tick());
      return ok(200, issueJson(repo, issue));
    }
    return fail(404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'GET') return ok(200, issue.comments.map((comment) => commentJson(repo, comment)));
    if (method === 'POST') {
      const text = strField(body, 'body');
      if (text === '') return fail(422, 'Comment body is required');
      const seq = forge.tick();
      const comment = { id: repo.nextComment, body: text, user: VIEWER_LOGIN, seq, createdAt: isoOf(seq) };
      repo.nextComment += 1;
      issue.comments.push(comment);
      issue.updatedAt = isoOf(forge.tick());
      return ok(201, commentJson(repo, comment));
    }
    return fail(404, 'Not Found');
  }

  return fail(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// pull requests

function routePulls(forge: Forge, repo: Repo, tail: string[], req: RestRequest, body: Record<string, unknown>): RestReply {
  const method = req.method;

  if (tail.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let listed = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      listed = [...listed].sort((a, b) => b.number - a.number);
      const page = pageOf(req.query);
      const sliced = paginate(listed, page);
      const headers: Record<string, string> = {};
      const link = nextLink(req.host, req.pathname, req.query, page, sliced.totalPages);
      if (link !== null) headers.link = link;
      return ok(200, sliced.items.map((pull) => pullJson(repo, pull, forge)), headers);
    }
    if (method === 'POST') {
      const title = strField(body, 'title');
      if (title === '') return fail(422, 'Title is required');
      const headRaw = strField(body, 'head');
      const baseRaw = strField(body, 'base') || repo.defaultBranch;
      const headRef = headRaw.includes(':') ? (headRaw.split(':').pop() ?? headRaw) : headRaw;
      const baseRef = baseRaw.includes(':') ? (baseRaw.split(':').pop() ?? baseRaw) : baseRaw;
      if (headRef === '') return fail(422, 'Head branch is required');
      const headSha = forge.branchTip(repo, headRef);
      const baseSha = forge.branchTip(repo, baseRef);
      if (headSha === undefined) return fail(422, `Head branch does not exist: ${headRef}`);
      if (baseSha === undefined) return fail(422, `Base branch does not exist: ${baseRef}`);
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
      if (duplicate !== undefined) return fail(422, 'A pull request already exists for this head and base');
      const pull = forge.createPull(repo, title, strField(body, 'body'), headRef, headSha, baseRef, baseSha);
      return ok(201, pullJson(repo, pull, forge));
    }
    return fail(404, 'Not Found');
  }

  const number = Number(tail[0]);
  if (!Number.isSafeInteger(number) || number < 1) return fail(404, 'Not Found');
  const pull = repo.pulls.find((entry) => entry.number === number);

  if (tail.length === 2 && tail[1] === 'files') {
    if (pull === undefined) return fail(404, 'Not Found');
    if (method !== 'GET') return fail(404, 'Not Found');
    return ok(200, forge.pullFiles(repo, pull));
  }

  if (tail.length === 2 && tail[1] === 'merge') {
    if (pull === undefined) return fail(404, 'Not Found');
    if (method !== 'PUT') return fail(404, 'Not Found');
    if (pull.merged) return fail(405, 'Pull request is already merged');
    if (pull.state !== 'open') return fail(405, 'Pull request is closed');
    const sha = squashMerge(forge, repo, pull);
    if (sha === null) return fail(405, 'Merge conflict');
    return ok(200, { sha, merged: true, message: 'Pull request successfully merged' });
  }

  if (tail.length === 1) {
    if (pull === undefined) return fail(404, 'Not Found');
    if (method === 'GET') return ok(200, pullJson(repo, pull, forge));
    return fail(404, 'Not Found');
  }

  return fail(404, 'Not Found');
}
