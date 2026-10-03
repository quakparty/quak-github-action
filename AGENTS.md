# Repository guidelines

`quakparty/quak-github-action`, the GitHub Action for the [Quak API](https://quak.party): CI/CD events become audible
on Sonos speakers. Public, MIT. The user guide is the README and https://quak.party/apps/github.

## Language

Everything in this repository is in English: code, comments, error messages, README, these notes and commit messages.

## Design

- **One action, explicit `type`:** text, sound, clip, file or url, plus the input of the same name. This order holds
  everywhere (inputs, code, tests, README). No talk, no stop, no management.
- **No `workspace` input:** keys made with `POST /v1/keys` belong to one workspace (scope `play`), so the action sends
  no `X-Quak-Workspace`.
- **Built on [`@quak/js`](https://github.com/quakparty/quak-js)**, pinned exactly and bundled into `dist/index.js`.
  The action passes its own `fetch` (timeout, `redirect: "manual"`) and the internal option
  `client: "github-action/<version>"`, which the API maps to the platform `GITHUB`. Missing client features go into
  `@quak/js`, not around it.
- **Runtime:** JavaScript action, `runs.using: node24`. Developed and tested with Bun.
- **An announcement never breaks a run:** no retries (a lost answer can still mean the play went out), no side effects
  on the repository, no `permissions`. Every failure is one clear error annotation and the step stays green, unless
  `fail-on-error` is `true`. Pull requests from forks and Dependabot runs get no secrets: an empty key there is a
  warning, also with `fail-on-error`.
- **The log:** one info line per play (what, where, credits used), annotations only when there is something to look
  at (skipped: notice; ignored processing inputs, failed speakers: warning; failures: error). Never the text, the URL
  or the credit balance (logs of public repositories are public, the balance goes to the debug log); the key is masked
  first. Errors carry message, input, hint, HTTP status, code and request ID on one line.
- **Validation:** everything the API's limits fix (numbers, booleans, `volumes`, intensities, text length, file size,
  `process: false` for text and file) is checked before the request, all problems at once. `effect` and `ambience`
  are beta, their values stay the API's to check.
- **Processing:** sounds and clips play as stored unless `process: true`, URLs are processed unless `process: false`.
  The action never switches processing on by itself; it warns about inputs that have no effect without it.

## Structure

- `action.yml`: inputs and outputs, `main: dist/index.js`.
- `src/main.ts`: entry point. `src/run.ts`: one run (inputs → request → log and outputs), returns the exit code.
  `src/inputs.ts`: reading and checking the inputs. `src/github.ts`: workflow commands and `GITHUB_OUTPUT`, by hand
  instead of `@actions/core`.
- `dist/index.js`: the bundle (`bun run build`), committed, never edited by hand. CI fails when it is out of date.
- `test/`: `bun:test`, `fetch` is always injected.

## Commands

`bun install`, `bun run lint`, `bun test`, `bun run build`, `bun run format`. Before every commit that touches code:
`bun run format && bun run lint && bun test && bun run build`, and commit `dist/` with it.

## Rules

- **Dependencies:** always the newest **stable** version, pinned exactly, never beta, RC or canary (check
  `npm view <package> versions`, the `latest` tag can point to an RC). Agree on major updates first.
- Tests never make real requests and never contain real keys.
- **English only:** this repository is public, so README, docs, agent notes, comments and test data are English. No
  German, also no planning notes to translate later.
- **No planning files here:** open points and ideas go to the shared Quak backlog, which is kept outside this
  repository. Nothing like a TODO list or roadmap lives in this repository.
- Releases: `vX.Y.Z` tags plus the moving major tag `v1`. Changes to names, inputs or outputs also go to the page
  https://quak.party/apps/github.
