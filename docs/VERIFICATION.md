# Verification and qualification

Implementation, simulation, browser checks and physical acceptance are tracked separately. A large automated suite does not demonstrate that every HFD feature or amplifier operation is safe on every firmware/device combination.

## V35 native graph and Fit truncated checkpoint

The development-source suite passed **2,465 of 2,465 tests across 178 files** with
`maxWorkers: 2` and unchanged test timeouts. One existing test timed out in the
first complete run, then passed in isolation; the subsequent complete run
passed. These are development-source results, not a substitute for checking the
public export.

Fresh public-checkout verification completed on **2026-11-15**, using Node.js
24.22.1. The full suite used two workers with no timeout changes or omitted
cases. Its sole skip was the optional exact installed-PDF identity test because
the public export omits the vendor PDF; synthetic manual/fallback tests ran.

| Check                                         | V35 result                                                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Development-source full suite                 | 2,465 passed, zero failures; 178 files, two workers.                                                                                         |
| Fresh public-checkout suite                   | **2,464 passed, 1 skipped, 0 failed; 2,465 total across 178 files.**                                                                         |
| Fresh public-checkout typecheck               | Passed.                                                                                                                                      |
| Fresh public-checkout production build        | Next production build and Worker packaging passed.                                                                                           |
| Static assets                                 | 24 assets totaling 1,894,394 bytes.                                                                                                          |
| Packaged Worker                               | 3,093,484 bytes.                                                                                                                             |
| Optional manual                               | Vendor PDF absent; compiled client and Worker report `bundled: false`, `optional: true`.                                                     |
| Actual packaged Worker                        | Home returned 200 and absent manual returned 404 in an isolated runtime without `process`.                                                   |
| Source and built privacy scans                | Zero matches in each checked category: private hosting IDs, token/key shapes, local user paths, actual serial candidates and private labels. |
| Generated Next environment file               | Unchanged by the build.                                                                                                                      |
| Final complete workspace/selection comparison | Passed: both complete projects and selection exact at revision 28; roles Offline, persistence Ready.                                         |

Worker SHA-256:
`75528f15b4db49d2377c275ac29085eb7ba7f8087dedc93db3c8a44c2fdaa5a7`.
The privacy scans are bounded pattern checks, not an exhaustive secret audit.
The Worker/client checks establish build fallback and routing behavior, not
browser download completion, a live hosted deployment or device compatibility.

Commands run from the public checkout:

```sh
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/vitest/vitest.mjs run --maxWorkers=2 --reporter=default --reporter=json --outputFile=../hypex-filter-design-web-public-v35.tests.json
node node_modules/next/dist/bin/next build
node scripts/build-worker.mjs
```

### Independent native graph observations

Classic HFD 5.2.4.24 was exercised with an owned synthetic project while a
verified exclusive handle held the amplifier interface. Native HFD remained
offline: no Take or audio capture and no bridge or other amplifier setting
operation was performed. Screenshots and saved native checkpoints were compared
with the browser domain calculations.

At a 48 kHz measurement rate, entering 417 microseconds stored phase-start sample
20, and entering 250 microseconds stored sample 12. Extracted native phase traces
matched the calculated curves within approximately four degrees. The phase-sum
fixture supports the mean direction of unit phase vectors, rather than an
amplitude-weighted phase result. Hiding a channel curve did not change the sum.
Turning sharing off changed exactly six fields: the shared start and group for
all three channels of the selected preset. Turning it back on changed those same
six fields, including the unloaded channel. The local crop, phase start, other
presets, coefficients and DAT bytes were preserved by that sharing change.

Independent pixel extraction calibrated each saved native time axis from its
visible tick labels and measured gridline centers. The shared views predict a
raw CH1 arrival at 0.416667 ms and black timed arrivals at 0.208333 and 0.625 ms.
Fresh unshared views predict overlapping raw/first timed arrivals at 0.416667 ms
and a later timed arrival at 0.833333 ms. The measured positions were:

| Native view                            | Raw CH1 arrival (ms) | Black timed arrivals (ms) | Timing tolerance |
| -------------------------------------- | -------------------- | ------------------------- | ---------------- |
| Shared, before/after Step zoom history | 0.417525             | 0.209227, 0.624921        | ±3.71 µs         |
| Fresh unshared                         | 0.416184             | 0.416184, 0.833566        | ±5.38 µs         |
| Wider unshared                         | 0.417387             | 0.417387, 0.833457        | ±8.03 µs         |
| Unshared, before Truncate              | 0.416502             | 0.416502, 0.834324        | ±5.82 µs         |

All arrivals were within two pixels plus printed-label rounding of their
predictions. Coincident red/black curves and clipped first peaks do not provide
independent height measurements; the later impulse peak measured approximately
0.5. The actual saved imports before and after phase-start sample 20→12 predict
identical timed arrival indices. The requested native timed screenshots all show
the 250-microsecond state: **there is no matched native phase-only before/after
Impulse pair in this evidence**.

Step screenshots support only the early visible levels: grey/black values near
0.999–1.001 before the second timed arrival, then a rise to approximately
1.492–1.506 near 0.625 ms; the red original Step is approximately 0.252 then
1.250. The later flat black trace partly overlaps a major grid line. Reversing
the Step-only zoom restored the exact plot pixels. These short windows do not
verify a terminal sum of 3, every FFT-length endpoint convention or full-record
DC behavior. The pre-Truncate screenshot is not a post-Truncate oracle.

The resulting implementation corrects **Fit truncated** to scan the selected
reference channel's floating-point time grid instead of combining channel crop
bounds or directly dividing integer indices. For example, binary64 grid spacing
can select sample 11 for a requested start of 10 at 48 kHz. The native scan's
bounded defaults and selected-reference behavior have focused tests.

Actual Studio Fit buttons also passed nine browser acceptance assertions in an
isolated origin with hardware, audio and filesystem access blocked. Native saved
fixtures on Left and Right produced ranges of 0.2291667–1365.3125 ms and
0.2291667–2.6458333 ms respectively. With linked edits enabled, the opposite
complete project and processing values were preserved; both complete projects
and saved zoom values matched canonically after reload, with storage Ready.
The shared MCP time-analysis command returned the same bounds. Canonical value
comparison avoids treating JSON object-key order as a state change. These are
browser/offline fixture checks, separate from the independent single-amplifier
read-only evidence; they do not qualify two physical amplifiers.

The native sharing checkbox left stale plot pixels until a project reopen, and
reopen reset the Impulse X range despite retaining its saved Y range. The web app
deliberately recomputes immediately after a shared-crop change. These observations
do not establish complete native viewport restoration or require reproducing a
stale raster in the browser.

### Fresh one-amplifier read-only backup

After native HFD closed and the exclusive handle was released, the actual
Backups UI captured preset 1 from the single physical FA503 at
**2026-11-15 13:40:58 UTC**. Its SHA-256 exactly matched the original recorded
baseline. This was a read-only amplifier operation with a local backup-store
write; it did not replace a workspace project or send an amplifier setter. It
verifies one 4 KiB IIR preset sector, not complete FIR, EQ, configuration,
firmware or acoustic state. The subsequent 37-assertion read-only validation
passed: both complete projects and selection exactly matched their pre-check
state, document revision remained 28, both connection slots were empty and
persistence was Ready.

### Firmware implementation boundary

A separate read-only static audit compared native HFD 5.2.4.24 and 5.3.1.32
loader discovery and update paths. The serial `B` exception and discovery list
are class admission rules, not same-unit loader correlation or a proved loader
VID/PID allowlist. Loader transition/reply behavior, memory effects and safe
post-reset recovery remain unproved. The native updater has no automatic
complete original PIC32 program backup; an optional additional backup does not
replace those missing contracts or establish rollback. See the
[firmware evidence boundary](FIRMWARE_RUNTIME.md#why-physical-programming-remains-unavailable).

A production firmware programming adapter is still missing and disabled. The
native graph comparison and successful read-only backup do not complete all
features or physical qualification. The dated v34 public results below are
unchanged historical evidence.

## V34 runtime identity checkpoint

The development source checkpoint passed **2,450 tests in 178 files**, global
typecheck and changed-file formatting checks. The fresh public checkout passed
**2,449 tests with one optional-PDF test skipped, zero failures, and 2,450 total
tests across 178 files**. Public typecheck and production build also passed on
2026-11-15 using Node.js 24.22.1. The v33 and earlier release totals below remain
historical evidence.

| Check                      | V34 public result                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| Static assets              | 24 assets totaling 1,894,092 bytes.                                                                      |
| Packaged Worker            | 3,093,080 bytes.                                                                                         |
| Optional manual            | Absent; actual compiled client and Worker registries report `bundled: false`, `optional: true`.          |
| Worker runtime             | Home returned 200 and absent manual returned 404, with `process` absent in the isolated runtime.         |
| Build privacy pattern scan | Zero matches for private Site IDs, token/key shapes, local user paths, actual serials or private labels. |

Worker SHA-256:
`f5036ae01197100bcf657f9ad92b070c28b8830353278dcb3b71a8e37f78a8ff`.
The pattern scan is bounded evidence, not an exhaustive secret audit.

Commands run from the public checkout:

```sh
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/vitest/vitest.mjs run --reporter=default --reporter=json --outputFile=../hypex-filter-design-web-public-v34.tests.json
node node_modules/next/dist/bin/next build
node scripts/build-worker.mjs
```

The intentional skip was `accepts the optional exact installed PDF bytes when
supplied locally`; synthetic manual routing and fallback tests still ran. The
client check evaluated the unchanged compiled registry initializer, and the
Worker check executed the actual packaged bundle. Neither establishes browser
download completion or physical device compatibility.

The actual Studio interface was exercised over synthetic HID devices using the
real transport, Session, inspector, controller and command executor. Reported
5.82/core 5.5 followed diagnostic-only admission and remained Offline for normal
controls. A mixed 5.7/core 5.1 and 5.82/core 5.5 Both read preserved independent
roles, borrowed the live Session and closed the temporarily owned interface.
These browser checks sent no setters and establish no physical core 5.5 or
two-amplifier acceptance.

One physical FA503 on 5.7/core 5.1 was then read through its live Session and,
after disconnecting normal controls, through the exact remembered HID object.
The final application state had both amplifier roles disconnected. No settings,
mute, volume, power, bridge, flash, firmware, credential or audio setter was
sent. Both complete projects and the selection matched their initial state;
document revision stayed 28, both connection slots were empty before/after, and
persistence was Ready with no unsaved changes.

Browser firmware file selection was blocked by the browser-control extension's
file-URL permission; no stage was created. Staging through that picker and
browser download completion remain unverified. At this v34 checkpoint, a second
physical amplifier was unavailable and native offline HFD GUI comparison still
awaited verified USB absence. The v35 exclusive-interface native graph evidence
above supersedes that comparison prerequisite; it does not qualify two-device
operation. Production firmware programming remains unimplemented. See the
[runtime workflow](FIRMWARE_RUNTIME.md) for the supported read-only boundary.

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

## V31 initial public-source baseline

The initial clean public export was verified on Windows on 2026-11-15 using Node.js 24.22.1 and pnpm 11.25.0. These results describe the v31 baseline, not the later Native Save increment. No private repository history, hosting bindings, vendor PDF or vendor firmware is included.

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

## V32 Native Save release checks

The shared Native Save implementation adds read-only connected settings/EQ capture, detached artifacts, durable directory integration and an 87-command registry. Its focused software/simulation regressions cover stale targets, atomic Both results, offline frozen JSON, budgets, release, cache reuse and receipt replay. The one-amplifier evidence below qualifies a specific read/export path; full compatibility remains open.

The actual public checkout was checked on Windows on **2026-11-15**, using Node.js 24.22.1 and pnpm 11.25.0. Source was synced without private history, hosting metadata or vendor assets; the existing public documentation, MIT license and screenshot were preserved. Dependencies and lockfile were unchanged, so no reinstall was required.

| Check                                      | V32 result                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| Fresh public-checkout complete suite/count | **2,253 passed, 1 skipped, 0 failed; 2,254 total tests across 166 files.**              |
| Fresh public-checkout typecheck            | Passed.                                                                                 |
| Fresh public-checkout production build     | Passed; 24 static assets totaling 1,825,705 bytes and a 2,996,375-byte packaged Worker. |
| Actual Save UI capture                     | Passed for one physical FA503, firmware 5.7/core 5.1, using read-only capture.          |
| Actual MCP capture/export delivery         | Passed: 65,467 JSON bytes in one hash-verified transfer chunk.                          |
| Browser download completion                | Unverified; no download event was observed.                                             |
| Two-amplifier physical capture             | Unverified; paired capture has simulation coverage only.                                |
| Independent native HFD GUI equivalence     | Unverified.                                                                             |

Commands run against the synced public checkout:

```sh
pnpm exec vitest run --reporter=dot --reporter=json --outputFile=../hypex-filter-design-web-public-v32.tests.json
pnpm typecheck
pnpm build
```

The one skip remains the optional exact vendor-PDF identity test. Synthetic PDF and no-manual fallback tests ran. The actual compiled client and Worker again report `bundled: false`, `optional: true`; the actual packaged Worker returns 200 for the home asset and 404 for the omitted manual in an isolated process-free runtime. Source privacy scans and relative-link checks passed. Raw reports and hash manifests stay outside the repository. These are the v32 public results; the earlier v31 table remains historical baseline evidence.

### One-amplifier read/export evidence

The actual Save UI and corrected shared MCP path successfully captured a commercial FA503 on firmware 5.7/core 5.1. MCP exercised stage, resolve, JSON file export, chunk read and release. The delivered local artifact contained 65,467 bytes and its hash matched the transfer chunk; three physical EQ banks each contained nine bands.

DSP was On, bridge was Off and no errors or warnings were reported. Both complete workspace projects and the selection matched their initial state after the read/export. The browser amplifier connection was closed afterward. No settings, power, filter, bridge, firmware, audio or credential setter was issued. Device identity, DSP filename, project names and raw hashes are deliberately omitted here.

The browser's download-anchor action produced no observed download event. Its internal Downloads page was unavailable under the browser-control policy, so browser file delivery is not claimed. This is separate from the MCP bytes that were delivered and verified. A successful read/export also does not establish a fresh independent HFD GUI comparison or behavior with two physical amplifiers.

## V33 native mixer release checks

Fresh public-checkout checks on **2026-11-15** passed **2,339 tests, one
optional-PDF skip and zero failures: 2,340 total tests across 171 files**.
Typecheck and production build passed. The registry contains 88 commands.
The build produced 24 static assets totaling 1,874,950 bytes and a
3,065,748-byte Worker. Its actual compiled client and isolated process-free
Worker both report the manual absent and optional; actual Worker routes return
200 for the home page and 404 for the omitted PDF. The skip remains the exact
optional installed-PDF acceptance test. Dependencies and lockfile were unchanged.

The conditional native mixer now has shared human/MCP role/preset drafts,
native formatting and quantized previews, fixed review, strict retained
before-images, all-target barriers and single-attempt write/readback. Fresh
browser simulation checked Cancel, native 0.105-to-0.11 normalization, different
Left/Right values, retained inactive preset drafts/words, human Save of an MCP
review, lost ACK, and zero-I/O replay. Forbidden settings/configuration/bridge/
power writes and barrier violations remained zero. The 995-by-856 browser view
kept both matrices, their context and Save visible without horizontal overflow.

One actual commercial FA503 was checked read-only. It reported module 9,
StereoDSP disabled, DSP On, bridge Off and no errors or warnings. The UI offered
only Left + Right/Right/Left routing, with no editable mixer weights. Both full
workspace projects, selection and revision remained unchanged, and the USB
connection was closed afterward. No hardware setter was invoked. This checks
the commercial eligibility display; it does not qualify a physical OEM mixer
writer or two physical amplifiers. The deployed app's actual shared mixer
command also returned valid cached offline state without changing its projects.

Earlier v31/v32 privacy scans missed a physical device identifier in one test
fixture. V33 replaces it with an explicit synthetic identifier and narrowly
corrects the two public ancestor commits, preserving all other files and commit
metadata. The current source and reachable public branch history pass the
stricter scan. Previously fetched copies or cached old commit views cannot be
recalled by a branch update. Vendor files, private hosting metadata and local
recovery artifacts remain excluded.

At the v33 checkpoint, browser download completion, independent native GUI
comparisons, physical OEM mixer writes and paired physical operation remained
open. V35 adds the bounded native graph comparison above; the other limits and
further native comparisons remain open. Source and simulation coverage must not
be described as exhaustive verified HFD parity.

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

Native Save uses matched read-only metadata/EQ snapshots for the supported commercial FA503 profile. Tests distinguish physical EQ from staged design EQ, compare JSON/native-folder artifacts, preserve original offline JSON after later edits, reject a stale/failing paired target without workspace publication, and retain exact files across directory replay. Capture IDs are bounded and page-local; durable prepared journals have separate retention. Fresh-host default provenance is explicit rather than a claim to retained Windows state.

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

The conditional/OEM digital mixer editor is implemented with shared native-format drafts and reviewed Save; its physical OEM writer remains unqualified. Historical non-directory owner migration remains a software limitation. Ordinary connected Save has a supported-profile implementation and one actual FA503 read/export check; browser download completion, paired physical capture, independent native comparison and other profiles remain open. File formats and grouped source coverage must not be advertised as exhaustive HFD parity.

## Report reproducible evidence

Include the source revision, OS/browser, operation and whether the target was simulated or physical. Prefer synthetic projects and redacted structured ledgers. Do not publish pairing tokens, credentials, recovery codes, raw serials, user paths, personal measurements or recovery exports containing private data.

An unconfirmed result means inspection is required. Repeating an operation under a new request ID can repeat a real write; a timeout alone is not a safe retry signal.
