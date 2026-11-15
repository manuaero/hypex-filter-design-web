# Verification and qualification

Implementation, simulation, browser checks and physical acceptance are tracked separately. A large automated suite does not demonstrate that every HFD feature or amplifier operation is safe on every firmware/device combination.

## Reproduce software checks

```sh
pnpm typecheck
pnpm test
pnpm build
```

For a focused change, run the relevant test file:

```sh
pnpm exec vitest run tests/amplifier-modes.test.ts
```

Record source revision, exact commands and results for a release. Final source-wide totals/build results belong to that frozen release; this document does not substitute a prior total for a new run.

## Exported-source release results

The clean public export was verified on Windows on 2026-11-15 using Node.js 24.22.1 and pnpm 11.25.0. The initial public Git revision is assigned at publication. No private repository history, hosting bindings, vendor PDF or vendor firmware is included.

| Check                          | Result                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Independent dependency install | Passed with the frozen lockfile and offline package cache; no dependency links into the private checkout.                          |
| Complete automated suite       | **2,169 passed, 1 skipped, 0 failed; 2,170 total tests across 161 files.**                                                         |
| Typecheck                      | Passed.                                                                                                                            |
| Production build               | Passed; 24 static assets totaling 1,802,259 bytes and a 2,962,560-byte packaged Worker.                                            |
| Optional manual                | Absent as intended; actual compiled client and Worker registries both report `bundled: false`, `optional: true`.                   |
| Worker asset routes            | Actual packaged Worker returned 200 for the home asset and 404 for the absent manual in an isolated process-free runtime.          |
| Public source scan             | No private Site IDs, token/private-key patterns, local user paths, actual serial candidates or known private project labels found. |

Commands run:

```sh
pnpm install --frozen-lockfile --offline
pnpm exec vitest run --reporter=default --reporter=json --outputFile=../hypex-filter-design-web-public-v31.tests.json
pnpm typecheck
pnpm build
```

The one intentional skip is `accepts the optional exact installed PDF bytes when supplied locally` in `tests/help-resources.test.ts`, because the public source omits the vendor PDF. Synthetic PDF packaging, MIME, fallback and optional-asset tests ran normally. Existing bridge tests emitted non-failing React `act(...)` warnings; no test failures were suppressed.

The Worker check evaluated the actual built bundle in isolation, without a real hosted account or browser actor. The client check evaluated the actual compiled help-registry initializer. They establish build-time fallback behavior, not completed browser PDF download or physical hardware acceptance. Raw machine reports are retained outside the public source export.

## Evidence categories

| Category                      | What it establishes                                                                                  | What it does not establish                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Static/numerical fixtures     | Recovered formats, formulas, field ownership and known-answer calculations.                          | Live device behavior or universal model compatibility.           |
| Unit/controller/storage tests | Validation, CAS/readback, immutable receipts, stale-target fences, permissions and partial outcomes. | Acoustic output or physical transport timing.                    |
| Real-component simulation     | Human controls and MCP use actual controllers/sessions over simulated panels.                        | A successful real amplifier setter.                              |
| Browser UI checks             | Layout, graph interaction, draft/review visibility, storage reload and explicit action flow.         | All hardware permutations or all browsers/operating systems.     |
| One-amplifier checks          | Behavior observed on that individual target with the recorded setup.                                 | Simultaneous two-amplifier operation or another firmware family. |

## Implemented software coverage

The automated suite covers filter coefficients, native/legacy metadata, measurement/calibration/time analysis, EQ/FIR behavior, fixed-target asynchronous imports, large chunked files, workspace persistence and Undo, directory save/recovery/archive, canonical actor admission, permissions, authentication and manual support-code flow, limiter/defaults/Device template plans and partial ledgers.

Mode-service tests specifically cover native dependent fields, owned-field baseline changes, fresh permissions, unrelated-field preservation, blocked-before-send versus lost-ACK outcomes, and absence of added mute/restart/retry behavior. Firmware-journal tests cover strict durability, full allowed before-images, immutable source/recovery binding, capacity, corrupt data, CAS, readback loss and receipt replay. Their existence does not enable physical firmware updates.

Browser checks have exercised compact layouts, graph/inspector context, numeric gestures, independent role selection, project reload/Undo, shared controller outcomes, granted-directory simulation and large file-transfer resumption. Recent configuration/limiter/Defaults/Device template UI acceptance used isolated simulated panels with no real USB/audio/filesystem writes.

## Physical evidence and remaining limits

Only one physical FA503 was available for the recorded development checks. Earlier IIR designs were uploaded and the original preset image restored and independently hash-verified. Later read-only recovery checks verified DSP On and the original preset checksum after exclusive USB access was recovered. They did not send power, volume, mute, configuration or filter setters. Runtime volume changes made independently must not be overwritten from stale snapshots.

The physical setup has connected speaker drivers. No bridge/configuration Apply was performed as part of the recent workflow qualification. Do not treat simulated bridge, limiter, Defaults, restore or Device template success as permission to test those writes on connected drivers.

Remaining qualification includes:

- Two simultaneously connected physical amplifiers and exact paired outcomes.
- macOS WebHID/device/reconnect behavior; complete browser/OS coverage beyond the Windows Chromium development target.
- Physical FIR/EQ/limiter/Defaults/Device template/configuration and recovery behavior across supported firmware.
- Actual microphone/output routing, latency and acoustic sweep results; browser audio is not native ASIO.
- Physical OEM/password/support-code behavior and automatic vendor request transport.
- A qualified physical firmware programming/reconnect/preservation/recovery adapter. Physical programming is disabled.
- Conditional accessories, four-output DSP3-224 workflows and other hardware families.
- Fresh native comparisons for remaining detailed display/interaction behavior.

Known software limitations also remain, including a conditional/OEM custom digital mixer weight editor, ordinary connected Save integration with fresh physical metadata, and historical non-directory owner migration. File formats and grouped source coverage must not be advertised as exhaustive HFD parity.

## Report reproducible evidence

Include the source revision, OS/browser, operation and whether the target was simulated or physical. Prefer synthetic projects and redacted structured ledgers. Do not publish pairing tokens, credentials, recovery codes, raw serials, user paths, personal measurements or recovery exports containing private data.

An unconfirmed result means inspection is required. Repeating an operation under a new request ID can repeat a real write; a timeout alone is not a safe retry signal.
