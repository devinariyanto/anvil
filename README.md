# anvil

[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/github-core-clone-01)
[![make.fun](https://img.shields.io/badge/built%20for-make.fun-green)](https://make.fun)
[![license](https://img.shields.io/badge/license-MIT-lightgrey)](./LICENSE)

**anvil** is a GitHub-compatible git forge written from scratch in Node 22
stdlib only — no dependencies, no git binary, no network at runtime.

It speaks the three surfaces a GitHub client expects:

- **REST v3** (`/api/v3`): repositories, branches, commits, contents, labels,
  issues, comments and pull requests, with pagination and squash merges.
- **GraphQL v4** (`/api/graphql`): repository/issue/pull-request reads,
  mutations, cursor pagination, `node(id:)` and `__type` introspection.
- **MCP** (`/mcp`): JSON-RPC 2.0 tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`)
  over the 2026-07-28 discovery handshake (with the classic `initialize`
  fallback).
- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack v2 (`ls-refs`,
  `fetch`, shallow/deepen) and v0, receive-pack v0 with report-status,
  fast-forward-only pushes, and packfiles written as whole objects.

Everything lives in memory in one `Forge` store, so REST, GraphQL, MCP and
git all see the same repositories, issues and pull requests.

## Run

```sh
MAKEFUN_SHOP_TOKEN=test-token-123 ANVIL_LOCAL=1 node --experimental-strip-types main.ts
```

In a make.fun trial the entry binds an ephemeral port, registers it at
`$MAKEFUN_ENV_URL/register`, and exits when `GET /done` reports done.
