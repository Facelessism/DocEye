# DocEye

DocEye is a GitHub Action that finds documentation drift: places where your README and docs say one thing and the repository says another.

It is a deterministic static analyzer. It reads Markdown and repository files, compares what the documentation claims with what the repository contains, and reports the differences. It does not use AI or language models, and it never runs commands found in documentation. It understands monorepos, so a scoped command such as *pnpm --filter web build* or *yarn workspace api start* is checked against the package it actually applies to, not the repository root.

## The problem

Documentation goes stale quietly. A script is renamed, a file moves, the project switches package manager, a workflow is deleted, and the README keeps describing the old world. Readers find out by copying a command that no longer works.

## Why DocEye exists

Link checkers catch dead URLs, but most drift is not a URL. DocEye checks the other things a README promises: that the files it names exist, that the scripts it tells you to run are defined, that the package manager and Node.js version it mentions match the repository, and that referenced workflows and Docker files are really there.

## Supported checks

| Rule | Default severity | What it verifies |
|---|---|---|
| `local-links` | error | Relative links, images and HTML references point to files that exist |
| `anchors` | warning | `#fragment` links match a heading or HTML anchor in the target file |
| `external-links` | warning | `http(s)` URLs respond; blocked or flaky servers are reported as warnings, never as broken |
| `package-manager` | warning | Documented `npm`, `pnpm`, `yarn` or `bun` usage matches lockfiles, `packageManager` and `engines` |
| `package-scripts` | error | Documented `run <script>` commands exist in `package.json` |
| `commands` | error | `node <file>` commands refer to files that exist |
| `paths` | warning | File paths written as inline code exist |
| `config-files` | error | "Configuration lives in `<path>`" statements name a real path |
| `runtime` | warning | A documented Node.js requirement is not stricter than `engines.node`, `.nvmrc`, `.node-version`, `.tool-versions` or Volta |
| `workflows` | error | Referenced workflow files and workflow badges exist |
| `docker` | error | `docker build` and `docker compose` commands and Dockerfile references match real files |
| `license` | warning | The license named in the README matches the license file or `package.json` |

Each rule can be set to `error`, `warning`, `notice` or `off`. Where evidence is uncertain, DocEye stays silent rather than guess. Where it can, a finding also carries a `suggestion`: the closest existing script or file name, the workspace that was probably meant, or the command for the package manager the repository actually uses.

## Installation

DocEye runs as a GitHub Action, so there is nothing to install for CI. Add a workflow that checks out your repository and runs it.

To check a repository locally before pushing, build the command line tool from source (see [Development](#development)) and run:

```bash
pnpm doceye [directory] [--config file] [--readme file] [--no-external-links] [--cache-file file] [--fail-on level] [--format text|json|sarif] [--output file]
```

Exit code `0` means no findings at or above `--fail-on`, `1` means findings were found, `2` means a usage or configuration error. Run `pnpm doceye --help` for the full list of flags.

## GitHub Action example

Create a workflow file in your repository:

```yaml
name: Docs
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  pull-requests: write

jobs:
  doceye:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: your-org/doceye@v1
        with:
          fail-on: error
```

### Inputs

| Input | Default | Description |
|---|---|---|
| `readme` | `README.md` | Path to the README |
| `config` | empty | Path to a configuration file; if empty, the default file names described under Configuration are looked for |
| `check-external-links` | `true` | Set to `false` to make no network requests |
| `comment` | `true` | On pull requests, create or update one summary comment |
| `fail-on` | `error` | Lowest severity that fails the step: `error`, `warning`, `notice` or `none` |
| `json-file` | empty | Write a JSON report to this path inside the workspace |
| `sarif-file` | empty | Write a SARIF 2.1.0 report to this path, for upload with `github/codeql-action/upload-sarif` |
| `cache-file` | empty | A `.json` path inside the workspace where successful external link results are remembered between runs |
| `github-token` | `${{ github.token }}` | Token used for the pull request comment |

The action sets one output, `findings-count`. Findings appear as annotations on the run and in the job summary; GitHub only shows the first 10 annotations per severity level, so the log and job summary are the complete record. On fork pull requests the token is read-only, so posting the comment is skipped with a warning instead of failing the check.

### Caching external link results

Checking external URLs is the slowest and flakiest part of a run. Point `cache-file` at a path inside the workspace and persist it between runs with `actions/cache`, and a URL that was fine recently is not requested again until it expires (`external-links.cache-hours` in the config, default 7 days). A link that was broken is always rechecked, so a stale cache can never hide real drift.

```yaml
      - uses: actions/cache@v4
        with:
          path: .doceye-cache
          key: doceye-links-${{ github.run_id }}
          restore-keys: doceye-links-
      - uses: your-org/doceye@v1
        with:
          cache-file: .doceye-cache/links.json
```

### Code scanning

```yaml
      - uses: your-org/doceye@v1
        with:
          sarif-file: doceye.sarif
          fail-on: none   # let code scanning own the pass/fail decision
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: doceye.sarif
```

## Configuration

Configuration is optional. DocEye looks in the repository root for a file named .doceye.yml, .doceye.yaml, doceye.yml or doceye.yaml, in that order, and uses the first one it finds. Unknown keys and misspelled rule names are rejected with a clear error.

```yaml
readme: README.md
docs:
  - docs
rules:
  local-links: error
  anchors: warning
  package-manager: notice
  docker: off
ignore:
  - https://example.com/temporary
  - docs/legacy/**
external-links:
  enabled: true
  max-urls: 100
  timeout-ms: 10000
  concurrency: 5
  retries: 2
  cache-file: .doceye-cache/links.json
  cache-hours: 168
fail-on: error
```

`ignore` entries are matched against both the documentation file a finding is in and the thing it refers to (a URL or path). `*` matches within one path segment, `**` across segments, and every other character, including `?`, is literal.

## Example output

```text
DocEye found 3 documentation issues (2 errors, 1 warning).

ERROR [local-links]
README.md:42
Broken local link: docs/setup.md
  No file or directory exists at "docs/setup.md" in the repository.

ERROR [package-scripts]
README.md:57
README.md references package script "deploy", but package.json does not define it.
  Command: pnpm run deploy. Scripts defined in package.json: build, test.

WARNING [package-manager]
README.md:17
README.md uses npm ("npm install"), but repository configuration indicates pnpm.
  Repository evidence: pnpm-lock.yaml. Also at line 18.
```

## Development

DocEye is TypeScript with strict compiler settings. It requires Node.js 22 or newer and uses pnpm.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` bundles the action into `dist/index.js`, which is what `action.yml` runs; `pnpm build:cli` bundles the command line tool into `dist-cli/index.js`, which `pnpm doceye` runs. Commit `dist/` when you release; `dist-cli/` is disposable and gitignored. The core engine lives in `src/check.ts` and has no GitHub dependency; `src/index.ts` is the thin action entry point and `src/cli.ts` the thin command line entry point. Each rule is a small function in `src/checks/`, and the test suite in `tests/` builds temporary repositories to exercise them. The test named `self.test.ts` runs DocEye against this repository, so this README is checked by the tool it describes.

## Security model

- Nothing found in documentation is ever executed. Commands are split into words and inspected statically, and shell substitutions are never evaluated.
- Every path is resolved inside the repository root. Links or files that escape it, including through symlinks, are treated as missing and are never read.
- Symlinked directories are not followed when discovering documentation, and file reads have a size cap.
- The link checker never contacts localhost, private, link-local or otherwise internal addresses, including when a public URL redirects to one.
- Network use is bounded: unique URLs are capped, concurrency and redirects are limited, each request has a timeout, retries are limited, and a total time budget applies.
- The link checker's own DNS lookup rejects non-public addresses, so a hostname that resolves to an internal or metadata address (DNS rebinding) is refused at connection time, not just checked by its literal text.
- A configured link-result cache file is validated on every read and is only ever overwritten if it already holds a valid DocEye cache, so pointing it at an existing file cannot be used to corrupt or replace that file.
- Pull request comments are a single summary. Repository text is sanitized so it cannot mention users or inject markup.

## Limitations

- Only Markdown files are checked: the README plus files under the configured `docs` directories.
- Documentation is analyzed with fixed patterns, so unusual phrasing of a claim can be missed.
- Commands are assumed to run from the repository root, and commands after a `cd` into another directory are skipped.
- Workspace and directory scopes are resolved for `--filter`, `-w`/`--workspace(s)`, `--prefix`/`--dir`/`--cwd`/`-C`, and `yarn workspace <name>`; a selector with a glob, `...`, or a variable is left unchecked, as is `-r`/`--workspaces` filtered against dependency graphs rather than package names.
- The license check compares identifiers only and is not legal analysis.
- External link results depend on the runner's network; servers that block automated requests are reported as unverified.

## Roadmap

- Support for more package ecosystems beyond the npm family
- Additional documentation formats

## License

MIT
