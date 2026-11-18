// anvil — GraphQL v4 at /api/graphql: a small hand-written parser and
// executor for exactly the documents gh and github-mcp-server send (viewer,
// repository reads, issue / pull-request reads and mutations, __type
// introspection, node(id:) and batched operations). No GraphQL library.

import { isoOf, squashMerge, STRANGER_LOGIN, VIEWER_ID, VIEWER_LOGIN, type Forge, type Issue, type Pull, type Repo } from './store.ts';
import { b64url, commentGlobalId, decodeGlobalId, issueGlobalId, pullGlobalId, repoGlobalId, unb64url } from './util.ts';

// ---------------------------------------------------------------------------
// tokens and parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      at += 1;
      continue;
    }
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (ch === '.' && source.slice(at, at + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      at += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      at += 1;
      continue;
    }
    if (ch === '"') {
      let out = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\' && at + 1 < source.length) {
          const esc = source[at + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          at += 2;
        } else {
          out += source[at];
          at += 1;
        }
      }
      at += 1;
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let end = at;
      let isFloat = false;
      if (source[end] === '-') end += 1;
      while (end < source.length && /[0-9]/.test(source[end])) end += 1;
      if (source[end] === '.') {
        isFloat = true;
        end += 1;
        while (end < source.length && /[0-9]/.test(source[end])) end += 1;
      }
      if (source[end] === 'e' || source[end] === 'E') {
        isFloat = true;
        end += 1;
        if (source[end] === '+' || source[end] === '-') end += 1;
        while (end < source.length && /[0-9]/.test(source[end])) end += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(at, end) });
      at = end;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let end = at;
      while (end < source.length && /[_A-Za-z0-9]/.test(source[end])) end += 1;
      tokens.push({ kind: 'name', value: source.slice(at, end) });
      at = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface Selection {
  alias: string;
  name: string;
  args: Record<string, Value>;
  selections: Selection[];
  typeCondition?: string;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selections: Selection[];
}

class Parser {
  private at = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token {
    const token = this.tokens[this.at];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.at += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, { type: string; selections: Selection[] }> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, { type: string; selections: Selection[] }>();
    while (this.peek() !== undefined) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, variables: [], selections: this.parseSelectionSet(fragments, new Map()) });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        const kind = token.value as 'query' | 'mutation';
        let name: string | null = null;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') name = this.next().value;
        const variables = this.parseVariableDefinitions();
        const selections = this.parseSelectionSet(fragments, new Map());
        operations.push({ kind, name, variables, selections });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in a fragment');
        const type = this.expectName();
        const selections = this.parseSelectionSet(fragments, new Map());
        fragments.set(fragName, { type, selections });
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token)} in GraphQL document`);
    }
    return { operations, fragments };
  }

  /** Skip ($var: Type = default, ...) collecting the variable names. */
  private parseVariableDefinitions(): string[] {
    const names: string[] = [];
    if (this.peek()?.kind !== 'punct' || this.peek()?.value !== '(') return names;
    this.next();
    while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const dollar = this.next();
      if (dollar.kind !== 'punct' || dollar.value !== '$') throw new Error('expected $ in a variable definition');
      names.push(this.expectName());
      // Skip the type: names, brackets, ! — up to , or ) at depth 0, or = default.
      let depth = 0;
      while (this.peek() !== undefined) {
        const token = this.peek()!;
        if (token.kind === 'punct' && token.value === '[') depth += 1;
        else if (token.kind === 'punct' && token.value === ']') depth -= 1;
        else if (depth === 0 && token.kind === 'punct' && (token.value === ',' || token.value === ')')) break;
        else if (depth === 0 && token.kind === 'punct' && token.value === '=') {
          this.next();
          this.parseValue();
          continue;
        }
        this.next();
      }
      if (this.peek()?.kind === 'punct' && this.peek()?.value === ',') this.next();
    }
    this.expectPunct(')');
    return names;
  }

  private parseSelectionSet(
    fragments: Map<string, { type: string; selections: Selection[] }>,
    expanding: Map<string, boolean>,
  ): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      const token = this.peek()!;
      if (token.kind === 'spread') {
        this.next();
        const next = this.peek();
        if (next !== undefined && next.kind === 'name' && next.value === 'on') {
          this.next();
          const type = this.expectName();
          const inner = this.parseSelectionSet(fragments, expanding);
          for (const selection of inner) out.push({ ...selection, typeCondition: type });
        } else if (next !== undefined && next.kind === 'name') {
          const fragName = this.next().value;
          const fragment = fragments.get(fragName);
          if (fragment !== undefined && !expanding.get(fragName)) {
            expanding.set(fragName, true);
            for (const selection of fragment.selections) {
              out.push({ ...selection, typeCondition: selection.typeCondition ?? fragment.type });
            }
            expanding.delete(fragName);
          }
        } else {
          throw new Error('bad fragment spread in GraphQL document');
        }
        continue;
      }
      const first = this.expectName();
      let alias = first;
      let name = first;
      const maybeColon = this.peek();
      if (maybeColon !== undefined && maybeColon.kind === 'punct' && maybeColon.value === ':') {
        this.next();
        name = this.expectName();
      }
      const args = this.parseArguments();
      let selections: Selection[] = [];
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
        selections = this.parseSelectionSet(fragments, expanding);
      }
      out.push({ alias, name, args, selections });
    }
    this.expectPunct('}');
    return out;
  }

  private parseArguments(): Record<string, Value> {
    const args: Record<string, Value> = {};
    if (this.peek()?.kind !== 'punct' || this.peek()?.value !== '(') return args;
    this.next();
    while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === ',') this.next();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        items.push(this.parseValue());
        if (this.peek()?.kind === 'punct' && this.peek()?.value === ',') this.next();
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, Value> = {};
      while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === ',') this.next();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)} in GraphQL document`);
  }
}

function evaluate(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => evaluate(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value.fields)) out[key] = evaluate(entry, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// schema surface (introspection)

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'isPrivate'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Ref: ['name'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------------------
// wrappers: plain objects carrying a __typename plus their fields

interface Wrapper {
  __typename: string;
  [key: string]: unknown;
}

interface Ctx {
  forge: Forge;
}

function userWrapper(login: string): Wrapper {
  const id = login === VIEWER_LOGIN ? VIEWER_ID : login === STRANGER_LOGIN ? 1002 : login === 'quinnkeller' ? 1001 : VIEWER_ID;
  return { __typename: 'User', login, id, name: 'ada iversen', email: 'adaiversen@example.invalid', url: `https://github.com/${login}` };
}

function repoWrapper(repo: Repo): Wrapper {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    __typename: 'Repository',
    id: repoGlobalId(repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userWrapper(repo.owner),
    defaultBranchRef: tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.isPrivate,
    _repo: repo,
  };
}

function issueWrapper(repo: Repo, issue: Issue): Wrapper {
  return {
    __typename: 'Issue',
    id: issueGlobalId(repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    author: userWrapper(issue.user),
    _repo: repo,
    _issue: issue,
  };
}

function pullWrapper(repo: Repo, pull: Pull, forge: Forge): Wrapper {
  const open = pull.state === 'open';
  const mergeable = !open ? 'UNKNOWN' : forge.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
  return {
    __typename: 'PullRequest',
    id: pullGlobalId(repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRef: { __typename: 'Ref', name: pull.headRef },
    baseRef: { __typename: 'Ref', name: pull.baseRef },
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    _repo: repo,
    _pull: pull,
  };
}

function findRepoById(forge: Forge, id: number): Repo | undefined {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

/** Resolve a global id to its wrapper, or null. */
function nodeWrapper(forge: Forge, id: string): Wrapper | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'R' && decoded.parts[0] !== undefined) {
    const repo = findRepoById(forge, decoded.parts[0]);
    return repo === undefined ? null : repoWrapper(repo);
  }
  if (decoded.kind === 'I' && decoded.parts[0] !== undefined && decoded.parts[1] !== undefined) {
    const repo = findRepoById(forge, decoded.parts[0]);
    const issue = repo?.issues.find((entry) => entry.number === decoded.parts[1]);
    return repo === undefined || issue === undefined ? null : issueWrapper(repo, issue);
  }
  if (decoded.kind === 'PR' && decoded.parts[0] !== undefined && decoded.parts[1] !== undefined) {
    const repo = findRepoById(forge, decoded.parts[0]);
    const pull = repo?.pulls.find((entry) => entry.number === decoded.parts[1]);
    return repo === undefined || pull === undefined ? null : pullWrapper(repo, pull, forge);
  }
  return null;
}

// ---------------------------------------------------------------------------
// execution

interface GqlError {
  message: string;
  path?: (string | number)[];
}

function typeOf(value: unknown): string | null {
  if (typeof value === 'object' && value !== null && typeof (value as Wrapper).__typename === 'string') {
    return (value as Wrapper).__typename;
  }
  return null;
}

const ROOT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

/** Field resolvers that need the store (computed fields, connections, mutations). */
function specialField(
  typename: string,
  parent: Wrapper,
  field: string,
  args: Record<string, unknown>,
  ctx: Ctx,
): { found: boolean; value: unknown } {
  const forge = ctx.forge;
  if (typename === 'Query' && field === 'viewer') return { found: true, value: userWrapper(VIEWER_LOGIN) };
  if (typename === 'Query' && field === 'repository') {
    const owner = args.owner;
    const name = args.name;
    if (typeof owner !== 'string' || typeof name !== 'string') return { found: true, value: null };
    const repo = forge.getRepo(owner, name);
    return { found: true, value: repo === undefined ? null : repoWrapper(repo) };
  }
  if (typename === 'Query' && field === 'node') {
    if (typeof args.id !== 'string') return { found: true, value: null };
    return { found: true, value: nodeWrapper(forge, args.id) };
  }
  if (typename === 'Query' && field === '__type') {
    if (typeof args.name !== 'string') return { found: true, value: null };
    const name = args.name;
    const fields = TYPE_FIELDS[name];
    const enums = ENUM_VALUES[name];
    if (fields === undefined && enums === undefined) return { found: true, value: null };
    return {
      found: true,
      value: {
        __typename: '__Type',
        name,
        kind: enums !== undefined ? 'ENUM' : 'OBJECT',
        fields: fields === undefined ? null : fields.map((entry) => ({ __typename: '__Field', name: entry })),
        enumValues: enums === undefined ? null : enums.map((entry) => ({ __typename: '__EnumValue', name: entry })),
      },
    };
  }
  if (typename === 'Repository' && field === 'issue') {
    const repo = parent._repo as Repo;
    const number = args.number;
    if (typeof number !== 'number') return { found: true, value: null };
    const issue = repo.issues.find((entry) => entry.number === number);
    return { found: true, value: issue === undefined ? null : issueWrapper(repo, issue) };
  }
  if (typename === 'Repository' && field === 'issues') {
    const repo = parent._repo as Repo;
    return { found: true, value: issuesConnection(repo, args) };
  }
  if (typename === 'Repository' && field === 'pullRequests') {
    const repo = parent._repo as Repo;
    return { found: true, value: pullsConnection(repo, forge, args) };
  }
  if (typename === 'Repository' && field === 'pullRequest') {
    const repo = parent._repo as Repo;
    const number = args.number;
    if (typeof number !== 'number') return { found: true, value: null };
    const pull = repo.pulls.find((entry) => entry.number === number);
    return { found: true, value: pull === undefined ? null : pullWrapper(repo, pull, forge) };
  }
  if (typename === 'PullRequest' && field === 'files') {
    const repo = parent._repo as Repo;
    const pull = parent._pull as Pull;
    const files = forge.pullFiles(repo, pull);
    const first = typeof args.first === 'number' ? args.first : files.length;
    const nodes = files.slice(0, first).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions }));
    return { found: true, value: { __typename: 'PullRequestChangedFileConnection', nodes, pageInfo: { __typename: 'PageInfo', hasNextPage: files.length > first, endCursor: null } } };
  }
  if (typename === 'Mutation') return mutationField(parent, field, args, ctx);
  return { found: false, value: undefined };
}

function mutationField(_parent: Wrapper, field: string, args: Record<string, unknown>, ctx: Ctx): { found: boolean; value: unknown } {
  const forge = ctx.forge;
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (field === 'createIssue') {
    const repo = typeof input.repositoryId === 'string' ? repoFromGlobal(forge, input.repositoryId) : undefined;
    if (repo === undefined) return { found: true, value: { __typename: 'CreateIssuePayload', issue: null } };
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const issue = forge.createIssue(repo, title, body, []);
    return { found: true, value: { __typename: 'CreateIssuePayload', issue: issueWrapper(repo, issue) } };
  }
  if (field === 'closeIssue') {
    const found = typeof input.issueId === 'string' ? issueFromGlobal(forge, input.issueId) : undefined;
    if (found === undefined) return { found: true, value: { __typename: 'CloseIssuePayload', issue: null } };
    found.issue.state = 'closed';
    found.issue.closedAt = isoOf(forge.tick());
    return { found: true, value: { __typename: 'CloseIssuePayload', issue: issueWrapper(found.repo, found.issue) } };
  }
  if (field === 'createPullRequest') {
    const repo = typeof input.repositoryId === 'string' ? repoFromGlobal(forge, input.repositoryId) : undefined;
    if (repo === undefined) return { found: true, value: { __typename: 'CreatePullRequestPayload', pullRequest: null } };
    const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
    const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
    const headSha = forge.branchTip(repo, headRef);
    const baseSha = forge.branchTip(repo, baseRef);
    if (headSha === undefined || baseSha === undefined) return { found: true, value: { __typename: 'CreatePullRequestPayload', pullRequest: null } };
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const pull = forge.createPull(repo, title, body, headRef, headSha, baseRef, baseSha);
    return { found: true, value: { __typename: 'CreatePullRequestPayload', pullRequest: pullWrapper(repo, pull, forge) } };
  }
  if (field === 'mergePullRequest') {
    const found = typeof input.pullRequestId === 'string' ? pullFromGlobal(forge, input.pullRequestId) : undefined;
    if (found === undefined) return { found: true, value: { __typename: 'MergePullRequestPayload', pullRequest: null } };
    if (!found.pull.merged && found.pull.state === 'open') squashMerge(forge, found.repo, found.pull);
    return { found: true, value: { __typename: 'MergePullRequestPayload', pullRequest: pullWrapper(found.repo, found.pull, forge) } };
  }
  if (field === 'addComment') {
    const found = typeof input.subjectId === 'string' ? issueFromGlobal(forge, input.subjectId) : undefined;
    if (found === undefined) return { found: true, value: { __typename: 'AddCommentPayload', commentEdge: null } };
    const body = typeof input.body === 'string' ? input.body : '';
    const seq = forge.tick();
    const comment = { id: found.repo.nextComment, body, user: VIEWER_LOGIN, seq, createdAt: isoOf(seq) };
    found.repo.nextComment += 1;
    found.issue.comments.push(comment);
    return {
      found: true,
      value: {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', id: commentGlobalId(found.repo.id, comment.id), body } },
      },
    };
  }
  return { found: false, value: undefined };
}

function repoFromGlobal(forge: Forge, id: string): Repo | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'R' || decoded.parts[0] === undefined) return undefined;
  return findRepoById(forge, decoded.parts[0]);
}

function issueFromGlobal(forge: Forge, id: string): { repo: Repo; issue: Issue } | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'I' || decoded.parts[0] === undefined || decoded.parts[1] === undefined) return undefined;
  const repo = findRepoById(forge, decoded.parts[0]);
  const issue = repo?.issues.find((entry) => entry.number === decoded.parts[1]);
  if (repo === undefined || issue === undefined) return undefined;
  return { repo, issue };
}

function pullFromGlobal(forge: Forge, id: string): { repo: Repo; pull: Pull } | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PR' || decoded.parts[0] === undefined || decoded.parts[1] === undefined) return undefined;
  const repo = findRepoById(forge, decoded.parts[0]);
  const pull = repo?.pulls.find((entry) => entry.number === decoded.parts[1]);
  if (repo === undefined || pull === undefined) return undefined;
  return { repo, pull };
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Wrapper {
  let listed = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    listed = listed.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  if (orderBy !== undefined) {
    const direction = orderBy.direction === 'ASC' ? 1 : -1;
    listed.sort((a, b) => direction * (a.number - b.number));
  }
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    try {
      const text = unb64url(args.after);
      const match = /^offset:(\d+)$/.exec(text);
      if (match !== null) start = Number(match[1]);
    } catch {
      start = 0;
    }
  }
  const first = typeof args.first === 'number' ? args.first : listed.length;
  const page = listed.slice(start, start + first);
  const end = start + page.length;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueWrapper(repo, issue)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: end < listed.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? b64url(`offset:${start}`) : null,
      endCursor: page.length > 0 ? b64url(`offset:${end}`) : null,
    },
    totalCount: listed.length,
  };
}

function pullsConnection(repo: Repo, forge: Forge, args: Record<string, unknown>): Wrapper {
  const listed = [...repo.pulls].sort((a, b) => a.number - b.number);
  const first = typeof args.first === 'number' ? args.first : listed.length;
  const page = listed.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullWrapper(repo, pull, forge)),
    pageInfo: { __typename: 'PageInfo', hasNextPage: listed.length > first, endCursor: null },
    totalCount: listed.length,
  };
}

/** Execute one selection set against a parent value. */
function execSelections(
  parent: Wrapper,
  typename: string,
  selections: Selection[],
  variables: Record<string, unknown>,
  ctx: Ctx,
  errors: GqlError[],
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.typeCondition !== undefined && selection.typeCondition !== typename) continue;
    const childPath = [...path, selection.alias];
    out[selection.alias] = execField(parent, typename, selection, variables, ctx, errors, childPath);
  }
  return out;
}

function execField(
  parent: Wrapper,
  typename: string,
  selection: Selection,
  variables: Record<string, unknown>,
  ctx: Ctx,
  errors: GqlError[],
  path: (string | number)[],
): unknown {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(selection.args)) args[key] = evaluate(value, variables);

  if (selection.name === '__typename') return typename;

  const special = specialField(typename, parent, selection.name, args, ctx);
  let value: unknown;
  if (special.found) {
    value = special.value;
  } else if (Object.prototype.hasOwnProperty.call(parent, selection.name)) {
    value = parent[selection.name];
  } else {
    const known = TYPE_FIELDS[typename] ?? ROOT_FIELDS[typename] ?? [];
    if (known.length > 0 && !known.includes(selection.name)) {
      errors.push({ message: `Cannot query field "${selection.name}" on type "${typename}".`, path });
      return null;
    }
    errors.push({ message: `Cannot query field "${selection.name}" on type "${typename}".`, path });
    return null;
  }

  if (selection.selections.length === 0) return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (entry === null || typeof entry !== 'object') return entry;
      const childType = typeOf(entry) ?? typename;
      return execSelections(entry as Wrapper, childType, selection.selections, variables, ctx, errors, [...path, index]);
    });
  }
  if (typeof value === 'object') {
    const childType = typeOf(value) ?? typename;
    return execSelections(value as Wrapper, childType, selection.selections, variables, ctx, errors, path);
  }
  return value;
}

export interface GqlReply {
  status: number;
  json: unknown;
}

/** Run one operation body ({query, variables, operationName}) to its response. */
export function runOperation(forge: Forge, body: unknown): { data: unknown; errors: GqlError[] } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'Request body must be a JSON object with a query.' }] };
  }
  const record = body as Record<string, unknown>;
  if (typeof record.query !== 'string' || record.query.trim() === '') {
    return { data: null, errors: [{ message: 'No query provided.' }] };
  }
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  let parsed: ReturnType<Parser['parseDocument']>;
  try {
    parsed = new Parser(tokenize(record.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL syntax error' }] };
  }
  if (parsed.operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation in the GraphQL document.' }] };
  }
  let operation = parsed.operations[0];
  if (typeof record.operationName === 'string') {
    const named = parsed.operations.find((entry) => entry.name === record.operationName);
    if (named !== undefined) operation = named;
  }
  const ctx: Ctx = { forge };
  const errors: GqlError[] = [];
  const root: Wrapper = { __typename: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
  const data = execSelections(root, root.__typename, operation.selections, variables, ctx, errors, []);
  return { data, errors };
}

/** Handle POST /api/graphql (single operation or a JSON array batch). */
export function handleGraphql(forge: Forge, body: unknown): GqlReply {
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      const { data, errors } = runOperation(forge, entry);
      return errors.length > 0 ? { data, errors } : { data };
    });
    return { status: 200, json: results };
  }
  const { data, errors } = runOperation(forge, body);
  return { status: 200, json: errors.length > 0 ? { data, errors } : { data } };
}
