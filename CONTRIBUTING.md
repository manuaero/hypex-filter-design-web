# Contributing

Start with [Getting started](docs/GETTING_STARTED.md) and the [architecture](docs/ARCHITECTURE.md). Keep changes scoped and explain the resulting user behavior, validation and remaining qualification.

## Development

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm exec vitest run tests/relevant-file.test.ts
pnpm build
```

Run the full suite before a release. Tests use synthetic fixtures and simulated panels; do not add tests that silently connect to real hardware, emit audio, invoke filesystem permission prompts or contact vendor services.

The repository’s `AGENTS.md` applies to automated contributors. Read the installed Next.js documentation relevant to a change rather than assuming APIs from another version.

## Design and integration rules

- Put domain calculations in pure modules and consequential workflows in shared application services. Human UI and MCP must use the same draft/review/outcome state.
- Keep Left/Right context explicit. Capture role, session, identity and revision before asynchronous work, and reject stale work rather than retargeting it.
- Preserve unknown fields, original samples, coefficient provenance and recovery bytes. Do not silently reinterpret old browser projects.
- Keep normal editing direct. Use adjacent Apply/Save/Upload for consequential changes; do not require the developer command console.
- Distinguish preparation, actual transmission and verification. Retain partial per-role ledgers and exact request receipts. Do not add blind retries or generic hardware rollback.
- Keep core editing context visible at compact viewport sizes. Test selection/reselection and independent detail scrolling.

Protocol changes need independent literal fixtures or documented primary evidence, plus tests for owned/unowned fields, initial denial, late failure and stale identity. A resource name, a packet plan or simulated acceptance alone does not qualify a physical write.

## Fixtures, dependencies and documentation

Use clearly labeled synthetic identities and measurements. Do not commit user projects, raw serials, local paths, credentials, vendor executables, firmware or manuals without an established redistribution basis. Dependencies must retain their notices.

Public descriptions should identify this as a web implementation of Hypex Filter Design functionality with an MCP server, and explain that it is an independent project. Call the captured-device workflow **Device templates** in user-facing documentation. Internal protocol/API names can remain stable for compatibility.

Contribute original material that you have the right to distribute under the project's [MIT License](LICENSE). Do not submit material whose rights are unclear or assume that the project license covers vendor or third-party assets. Preserve applicable [third-party notices](THIRD_PARTY_NOTICES.md).
