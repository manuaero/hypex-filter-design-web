# Verification and qualification

Implementation, simulation, browser checks and physical acceptance are tracked separately. A large automated suite does not demonstrate that every HFD feature or amplifier operation is safe on every firmware/device combination.

## V44 firmware workflow checkpoint

File staging, fixed-role review, confirmation, outcomes and journal recovery now share one UI/MCP workflow. The production WebHID adapter is implemented behind an **empty source-owned qualification registry**: physical firmware programming remains unavailable. No UI or tool argument can issue a qualified profile. This is implemented guarded software, not physical programming/reconnect/recovery acceptance.

| V44 check                              | Verified result                                                                                                                                                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical product suite                | **3,013 passed / 3,013 total in 197 files**, zero failures/skips.                                                                                                                                                                 |
| Complete private run                   | **3,121 passed / 3,121 total in 200 files**, including **108 ignored diagnostic assertions in 3 files**. Those diagnostics are not additional public-source coverage.                                                             |
| App/UI focused boundary tests          | **167 passed in 8 files**; exact review confirmation, independent source/assignment leases and covered-role recovery. These are automated tests, not new browser acceptance.                                                      |
| Adapter/core focused tests             | **92 passed in 4 files** using synthetic/injected interfaces and test-only profiles; no production physical profile is issued.                                                                                                    |
| Owned local HTTP MCP protocol          | **10/10 checks passed**: exact source listing of 91 commands, seven nested action declarations, token/origin/host and unpaired-executor guards. This does not qualify paired browser execution or production-Site authentication. |
| Isolated synthetic browser observation | **One baseline check accepted**, with **two unaccepted pairing interruptions retained**. Independent designs and Ready persistence were observed; pairing and a completed firmware UI workflow were not verified.                 |
| Fresh public checks                    | **3,012 passed plus the sole optional-PDF skip: 3,013 total in 197 files**; TypeScript, Next production build and Worker packaging passed.                                                                                        |
| Public export                          | **408 source files plus 13 protected public files: 421 total**. The previous V43 history remains unchanged below.                                                                                                                 |

The owned local HTTP protocol checks exercised health/initialize/notification, the exact source tool definitions, declaration of all seven new nested firmware actions, invalid-token (401), disallowed-origin (403), unknown-host (403) and the unpaired browser-executor guard. The endpoint remained unpaired and forwarded zero hardware calls. The isolated browser accepted only its independent synthetic baseline and Ready persistence. Browser/extension focus prompts interrupted pairing attempts; those observations remain unaccepted rather than being presented as a completed workflow. This evidence does not establish paired MCP command execution, remote MCP or production-Site authentication.

The fresh build produced **24 static assets / 1,991,456 bytes** and a **3,233,279-byte Worker**, SHA-256 `e0cf7a728297d4e209e45d7c71bacf4aba4776a1e23acf8af1dc8cb1892659f6`. Actual compiled client and Worker manual registries report `bundled: false`, `optional: true`; the packaged Worker returns home 200/manual 404 without a process global. The vendor PDF is absent. All five recorded source/built privacy-pattern scans had zero matches; these scans are bounded, not exhaustive secret detection. Generated Next environment bytes stayed unchanged.

Negative cases cover unavailable-profile refusal before hardware access, fresh lock/settings/assignment changes before entry, exact-unit and ambiguous-loader refusal, stale connection poisoning, all-owned-handle cleanup, masked report consistency and full known-memory comparison. Retained durable mutating intents remain crash-ambiguous even without a persisted attempted flag; they require explicit recovery. Recovery retains the original receipt and source, cannot cross reference/physical routes, and can restore only expected-role metadata into unassigned roles after trusted checks. It still requires actual same-unit correlation.

The native runtime command-40 code can return stale TX bytes while resetting. Host send settlement and local request IDs do not prove target acknowledgements or sequence correlation. The adapter retains four reports, 24 external-flash sectors and 15 safe EEPROM images, with separately qualified runtime read profiles and permissions. These known ranges do not prove full program/calibration rollback. No automatic cancel, firmware retry, bridge/settings restore or permission waiver was introduced.

No new completed firmware-workflow browser acceptance, native GUI action, physical amplifier command, firmware update or physical sector read is claimed for V44. The bounded baseline observation and incomplete pairing attempts above remain explicit. The last fresh single-unit physical sector evidence remains the separately dated V35 read. Remaining qualification includes exact runtime-to-loader association, actual unsequenced/late reply behavior, permission policy, reset/output safety, interruption/recovery, two physical amplifiers, macOS USB, acoustic behavior and download delivery. Native EQ-popup/passive/Default and other manual-filter/view acceptance remain separate open work. See [the detailed firmware contract](FIRMWARE-WORKFLOW-v44.md).

## V43 graph-Q and FIR checkpoint

Ten completed offline HFD 5.2.4.24 saves establish the bounded native graph observations: selected Peak Q 1.15→1.19 after +120 chart wheel, then 1.23 after one +360 event over empty chart, then 1.27 after a requested Ctrl-held diagonal move. Wheel magnitude is not an event count, and one requested pointer move does not prove a count of delivered callbacks. The clean AP2 and Asymmetric combined-gesture saves were byte-identical; this does not establish universal stale-cache or internal-refresh no-op behavior. Unknown Shelf1/Shelf2 saved directions follow the native Low branch, independently of Asymmetric's High branch.

Magnitude graph Q gestures now use the native selected-section behavior: wheel input anywhere in the chart applies one signed 0.04 step to the already-selected section, and Ctrl-drag captures Ctrl at drag start and applies one step per qualifying vertical move. LP2, HP2, Shelf2 and Peak support graph Q; Asymmetric and AP2 retain their separate numeric Q controls. Whole-channel response display does not remove the editing selection. Ordinary graph Q explicitly reparses its final three-decimal Text to Double, including an off-grid bound whose visible Text does not change. Input EQ graph editing remains a browser convenience using its separate field-publication profile.

Imported native Unknown shelf direction now follows its type-specific branch: ordinary Shelf1/Shelf2 use Low, while Asymmetric uses its distinct High branch. The raw native direction enum survives ordinary parameter and bypass edits; an explicit direction choice records the corresponding Low/High enum even when it matches Unknown's effective direction. Contradictory type/direction choices are rejected, and legacy filters without this metadata do not acquire an invented enum. Untouched caches remain retained.

Ordinary preset FIR transfer sends only the selected input or output placement. Effective graph FIRs in the inactive placement remain in the project. A compact, initially collapsed disclosure keeps the advisory count, transfer meaning and role/preset scope visible; all detailed warnings remain available in a bounded scroll area. Channel controls retain their compact editing context. No extra hardware write is implied by these software changes.

The V3 integration repair separates whole-channel response scope from the active editing object. Real Studio and real InteractivePlot regressions cover Crossover and Input EQ wheel/Ctrl paths, per-role bypass/cache preservation and exact Undo. A fresh controller starts in selected-section scope; Whole channel is a valid user-selected response view, not a missing editing selection. Ordinary graph and field publication are separately tested. Exact canonical-bound source no-ops remain quiet even with an unsupported fixed-source peer; changing off-grid events still validate every intended graph destination. Native EQ popup/passive-selection/Default acceptance remains open.

| V43 check                               | Verified result                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Canonical development-source tests      | **2,934 passed / 2,934 total in 194 files**, zero failures/skips.                                                                    |
| Complete unfiltered private R2 run      | **3,042 passed / 3,042 total in 197 files**, including **108 ignored diagnostic assertions in 3 files**; no filters or omissions.    |
| Fresh public suite                      | **2,933 passed plus one optional exact-PDF skip: 2,934 total in 194 files**, zero failures, complete inventory and unchanged source. |
| Typecheck / Next / Worker packaging     | Passed on the checked public source.                                                                                                 |
| Final isolated Studio browser iteration | **36 accepted; 1 unaccepted; 37 final-iteration attempts**. Initial **4 accepted / 1 unaccepted / 5 attempts** retained separately.  |
| Export inventory / command registry     | **401 source + 13 protected public files = 414 files; 91 commands**.                                                                 |

The final private R2 run passed **3,042/3,042 assertions in 197 files**: **2,934 canonical product tests in 194 files**, plus **108 included ignored diagnostic assertions in 3 files**. The ignored diagnostics are not additional public-source coverage. No filter or omission was added. The earlier unfiltered private run passed all **3,042 assertions in 197 files** and typecheck, but its release validation correctly failed because the expected inventory did not include the discovered ignored diagnostics. That original failed inventory receipt is retained; it is not presented as a product-test failure or silently replaced. Two workers, unchanged timeouts and unchanged canonical source snapshots were retained. Existing ignored diagnostic outputs and their historical proofs remain separately disclosed in the private R2 receipt; none are distributed as canonical public coverage.

Public checks completed at **2026-11-16T00:31:28.828Z** with v24.22.1. The Worker is **3,143,429 bytes**, SHA-256 `bb7a87cf62c9b2a590fb817bf6926e9d5049711399e4693a181ee86b4537cbfb`; **24 static assets total 1,927,151 bytes**. Actual compiled client and Worker report optional manual `bundled: false`, `optional: true`; the packaged Worker returns home 200/manual 404 in an isolated process-free runtime. The vendor PDF is absent. The optional exact-PDF skip is the only public omission; fallback tests ran, the generated Next environment file stayed unchanged, and all five source/built privacy-pattern categories had zero matches. These are bounded scans, not exhaustive secret detection.

Final QA-v2 recorded **36 accepted checks and 1 unaccepted checks among 37 final-iteration attempts**. The initial iteration separately retains **4 accepted checks and 1 unaccepted assertion among 5 attempts**, including the real expanded-FIR-advisory layout defect that led to the compact disclosure. Across both iterations there are **42 observed attempts**, with original results retained rather than all counted as passing. One retained final-iteration assertion ran before its intended wheel input had been issued after an automation-session interruption. After reestablishing input setup, the same intended event passed with the unchanged peer cache retained; no product source changed. The 7 pre-interruption checks use retained visible-output records; subsequent checks come from immediate durable recovery records. Interrupted batches contribute no inferred results for unobserved actions. Both final synthetic designs matched their seed processing fingerprints with all 24 FIR banks and 54,000 taps retained, persistence Ready and no blocked I/O attempts. This is synthetic local UI/shared-executor evidence, not remote MCP transport, native-popup or physical-write acceptance.

Commands used the full unfiltered `vitest run --maxWorkers=2`, `tsc --noEmit --incremental false`, Next production build and Worker packaging. Only README, MCP and verification prose is finalized after completed checks; all 401 source files remain byte-exact. Public-source build verification is not a public hosted deployment. No new physical amplifier transfer, bridge configuration, power/noise/audio operation or fresh hardware-sector hash is claimed. The dated V35 single-unit read-only evidence remains separate. Production firmware programming/reconnect/recovery, remote MCP transport, physical FIR behavior, two physical amplifiers, macOS and full hardware parity remain open.

## V42 Input EQ parameter checkpoint

Input EQ now uses the source-qualified parameter profile described above: F 10–50,000 Hz/one decimal, Q 0.1–20/three decimals, gain −15.9…15.9 dB/two decimals; all three store Double. Typed raw decimal Text uses shared bounded Extended parsing/formatting. Its complete frequency wheel uses directional decades followed by FloatEdit bounds/format/reparse; Q and gain use 0.04 and 0.1 respectively. Ordinary output frequency, AdditionalGain, codec/import ranges and upload guards remain separate.

Inspector and palette share the profile, with local Text until Enter/blur and palette changes until Apply. Paired edits preflight complete destination banks before one Undo. Normal edits clear only actually changed design caches; a mirrored peer already holding the result keeps its exact coefficients, provenance and bypass. Explicit Reset/Remove still clears retained caches. Passive imports are not silently rewritten. Exact zero retains the previous internal value before formatting/reparse, which can round an off-grid previous Double. Native Text-change-dependent passive selection remains an open acceptance question.

Development source passed **2,806/2,806 tests across 188 files**, with global typecheck and unchanged source snapshots. Fresh public checks passed **2,805 plus the sole optional-PDF skip: 2,806 total in 188 files**, typecheck, Next production build and Worker packaging. Both suites used two workers, no omissions/filters or timeout increases. The reviewed public export contains **392 source plus 13 protected public files, 405 total**. Only these three protected prose files are finalized after checks; historical V41 evidence below is retained.

Actual isolated Studio work recorded **45 accepted browser checks and two retained initial unaccepted assertions** among 47 observed attempts. The immediate graph-footer heading assertion was corrected by subsequent DOM and later footer observations. A fast leading-dot commit initially appeared unchanged; its cause remains unproven. Observed-draft commits, three repeated wheel/Undo/leading-dot sequences and five separate JSDOM diagnostics passed. No product defect was reproduced, but JSDOM does not adjudicate the browser observation and its timing qualification remains open. The checks used synthetic designs through visible controls and the shared executor. One CDP event timed out after navigation; verification resumed after capability refresh. Two compact input-targeted checkbox actions reported unchanged, while the visible Mirror label worked. These delivery observations are retained without claiming every attempted browser action passed. This is not remote MCP transport, actual native EQ-popup or physical-amplifier acceptance. The shared registry contains **91 commands**, including `fusion_eq_adjust`. The native popup, passive-selection model-normalization lifecycle and Default EQ confirmation still need their own acceptance; source-derived profile tests do not close those gaps.

Five completed offline native channel saves separately examined Open/Save, unselected graph, channel gain −6 dB, inversion and selecting the Peak. All BQ cached coefficients and stored root metadata stayed unchanged across those saves; channel gain and inversion were stored separately, and selecting then saving caused no coefficient change. No baked-cache/de-embedding transition was observed. Screenshots and source context do not establish full pixel response, upload byte acceptance or general gain/cache lifecycle equivalence. The owned source file stayed exact, native HFD closed before metadata exclusion was released, and no amplifier setters were performed.

The fresh public build produced **24 static assets / 1,920,841 bytes** and a **3,133,777-byte Worker**, SHA-256 `b11c6b45fc21c25a7ae9cec3337c636bfc046a486da6f28969149d1c3ed38921`. Actual compiled client/Worker optional-manual fallback passed; the packaged Worker returned home 200/manual 404 without a process global. The vendor PDF is absent, and all five recorded source/built privacy-pattern scans had zero matches. These are bounded checks, not exhaustive secret detection or a public hosted-deployment claim.

Wire behavior and native/physical uploads, two physical amplifiers, macOS USB, acoustic input/output, browser download delivery and qualified production firmware programming/reconnect/recovery remain open. Bridge configuration was not set or applied. The earlier dated single-device physical evidence remains historical; V42 adds no fresh sector-read claim. See [Input EQ field scope](HFD-INPUT-EQ-FIELDS-v42.md).

## V41 raw coefficient checkpoint

Disabled raw sections now show and edit their retained vector. One scalar edit mirrors that scalar independently across Left/Right; all destinations preflight before a single Undo. Exact typed values remain local until Enter/blur, incomplete text and Escape do not edit the design, and editing-context/cache changes discard stale drafts. Direct raw creation supplies complete Unity coefficients; conversion retains the current unbypassed response. Full-vector overrides clear stale original-cache provenance only when their values change.

Browser-exported XML now preserves unresolved first-cache interpretation on its own channel gain object. Reopening standalone XML, or falling back from a missing/stale sidecar, retains the exact vector and compilation refusal. Resolved exports remove that marker. This is browser metadata; no new native HFD handling is inferred. Free-coefficient authoring remains an explicit browser extension: the inspected native graph selector excludes internal Free/NotDefined types and has no five-coefficient fields.

Development source passed **2,742/2,742 tests across 186 files**, global typecheck and an unchanged 380-file source/configuration snapshot. The fresh public checkout passed **2,741 tests plus the sole optional-PDF skip: 2,742 total in 186 files**, typecheck, Next production build and Worker packaging. Complete inventories, two workers and unchanged timeouts were retained. Public source and built assets had zero matches for the five recorded privacy patterns. The exact source export has **387 source plus 13 protected public files, 400 total**; only README, MCP and verification prose was finalized after those checks.

Actual Studio acceptance passed **29/29 Chrome checks**: retained disabled vectors, draft commits/cancel, independent paired edits, one Undo, linked-target refusal, UI/MCP conversion, palette staging/Apply/Cancel, direct raw Add, stability refusal, unresolved XML reopen and reload persistence. At **1024×768**, all five coefficient inputs were visible without document scrolling. Both final synthetic designs matched their starting processing state. The 160 bundled product sources and three generated QA assets remained byte-exact. External I/O was blocked and its attempt counters remained empty. This is isolated local acceptance through UI and shared-executor console, not production browser or network-MCP acceptance.

The private deployment succeeded with MCP enabled and unchanged owner-only access. This increment performed no native GUI or amplifier operations. Bridge configuration was untouched. Firmware programming, two physical amplifiers, macOS USB, acoustic acceptance and browser download delivery remain unqualified. Existing UI/JSON signed-zero canonicalization is retained. See [explicit coefficient editing](HFD-RAW-COEFFICIENT-EDITOR.md).

## V40 ordinary parameter wheel checkpoint

Ordinary output Q1/Q2 and BQ-gain wheels now share the recovered native behavior across the inspector, creation palette and `fusion_filter_adjust`. A delivered event applies one factory step, **0.04 for Q/Q2** or **0.1 dB for gain**, using its direction. Actual native +120 and +360 events each produced one step. Q/Q2 use three displayed decimals and 0.1–20 bounds; gain uses two decimals and −125…24 dB. Both store Double. Inspector wheels edit the design; palette wheels remain local until Apply. Unchanged formatted Text normally retains exact imported values, caches and history. Frequency's Single path, keyboard increments, graph gestures and input EQ remain separate. This supersedes the V39 wheel-as-extension statement below for these ordinary output parameter wheels only.

The AdditionalGain ceiling has distinct visible and stored results:

| Native observed field after one positive event | Saved BQ gain | Saved AdditionalGain |
| --- | ---: | ---: |
| 14.00 from typed 17.95 | 18.05 | 10 |
| 14.00 from typed 13.95 | 14.05 | 10 |

A once-inhibited native notification changes the visible field without replacing the preceding canonical value. The browser retains that transient field state during continuous wheel events and displays an adjacent **Stored … dB** detail. Analysis, compilation and exports use the saved canonical value. Passive refresh or blur ends the transient state. Commands return Text and value separately and deliberately start from a fresh passive field on every call; they do not share a human field's private state. The default Both basis advances each role independently; an explicit source basis mirrors its changed stored value. All targets validate before one document transaction, and unchanged sources do not overwrite the other role.

Classic HFD 5.2.4.24 screenshot/mouse/keyboard work produced **22 actual native saves**, with one synthetic input counted separately. Reverse Q/Q2/gain events restored several earlier saved files byte for byte. The endpoint cases that included typing before the wheel had no intermediate save, so their screenshots establish the visible bound no-op; their complete XML differences are not misattributed to the wheel alone. Focused Up-key checks changed neither Q nor gain in their two tested contexts, without qualifying every keyboard/focus path.

The synthetic input changed only AdditionalGain 0→6 in an owned copy. Native reopening and immediate Save, without filter selection or parameter input, changed only AdditionalGain 6→10 and gainlowered false→true. The web importer preserves the supplied metadata instead of silently reproducing that native load normalization. Saved coefficients and independently evaluated Q24/response predictions remain separate from native display or hardware acceptance.

One native save exposed a one-ULP importer loss: divide/multiply reconstruction changed b1 from −1.92017414830364 to −1.9201741483036399. Base and unresolved classification now retain the original native Doubles directly. The initial failing comparison is retained, and exact-cache regressions cover both the parameter section and custom/raw ambiguity. No tolerance, ambiguity or stability guard was weakened. Native −125 and −124.9 dB Peak caches have a pole exactly at one: imported and regenerated coefficients agree, while both compiler paths correctly refuse them. Scalar Q24 predictions do not establish safe programming data.

| V40 check | Verified result |
| --- | --- |
| Complete development-source suite | **2,691 passed / 2,691 total across 185 files**, zero failures/pending, two workers, no omissions or timeout increases. |
| Frozen test inputs | All **377 source/test/configuration files** and the separately checked `.gitignore` remained unchanged. |
| Global typecheck / formatting | Passed for the frozen owners' source. |
| Actual Studio browser acceptance | **29/29 checks passed** in Chrome with genuine tab-scoped wheel input and the shared command console; zero failures or blocked I/O attempts. All 160 bundled product source files remained unchanged. |
| Shared command registry | **90 commands**; `fusion_filter_adjust` is a stateless design action. |
| Fresh V40 public tests, typecheck and Next/Worker builds | **2,690 passed plus the sole optional-PDF skip: 2,691 total across 185 files**; global typecheck, Next production build and Worker packaging passed. The reviewed export has **385 source files plus 13 protected public files: 398 total**. |
| V40 publication / physical qualification | Private V40 deployment succeeded with MCP enabled and unchanged owner-only access. No new amplifier programming or physical sector read was performed. |

Fresh V40 public verification completed at **2026-11-15T20:12:45.008Z**, using Node.js v24.22.1. The full suite used two workers, unchanged timeouts and no omissions. The one skip is the optional exact installed-PDF identity test; the public source omits that vendor PDF and its fallback tests ran. The generated Next environment file stayed unchanged.

The build produced **24 static assets totaling 1,911,164 bytes** and a **3,118,426-byte Worker**, SHA-256 `541e830fb314897934af4aaf0de9a038326a6444a7944c08a68d433f9996ecc1`. Actual compiled client and Worker registries report manual `bundled: false`, `optional: true`; the actual packaged Worker returns home 200/manual 404 in an isolated process-free runtime. Source and built-output pattern scans found zero matches in all five categories; these are bounded scans, not exhaustive secret detection. These are public-source build checks, not a public hosted deployment or additional physical acceptance.

An ignored generated QA stylesheet was formatted after bundling; the initial strict asset-hash failure is retained, while an independent comparison established formatting-only changes with all 160 product sources and the original JavaScript unchanged; reconstruction checks and later unused fixture guards add no browser qualification.

Browser checks cover independent roles, field-local drafts and continuous wheel state, displayed/stored gain, source and each-role command bases, preserved imported precision/cache, no-op history, strict unstable-filter refusal, whole-project Undo and reload. They use actual Studio with synthetic/native-file seeds, not two physical amplifiers or remote MCP transport. Download delivery is not established.

Native HFD stayed disconnected under verified metadata-only exclusion and closed normally before release; recorded checks reported zero explicit transfers and healthy device presence afterward. Saved Settings changed only in the recent-project region, with all other bytes and the three empty saved ASIO names retained. This is no fresh physical-read claim. The earlier dated V35 single-unit IIR evidence remains separate. Complete HFD parity, remaining raw/cache/type/gesture/view and conditional-device cases, two physical amplifiers, macOS USB, acoustic capture/output, download delivery and qualified production firmware programming/reconnect/recovery remain open. No unqualified upload attempt is inferred from numerical agreement.

## V39 manual Q/gain implementation checkpoint

Eighteen completed offline HFD 5.2.4.24 saves cover ordinary Q1/Q2 and BQ gain commits, type-entry cache behavior, and first-/second-order all-pass cases. Actual Q text `0.4005` committed to Double 0.401; `0.0001` clamped to 0.100 and `100.0001` to 20.000. Q zero restored the previous value. Asymmetric Q2 `1.3005` committed to Double 1.301, and its following zero save was byte-identical. Gain `7.555` committed to Double 7.56; zero was accepted; `-125.0001` and `24.0001` clamped to −125.00 and 24.00. The recovered ordinary profile defaults are Q 0.1–20 and BQ gain −125…24 dB, separate from input EQ, channel gain and hardware controls.

Raw Text conversion, passive Double display and the model are distinct. The shared bounded Extended parser/formatter now handles manual frequency and Q/gain commits without duplicating the parser. Frequency retains Single storage; Q/gain retain Double. Opening, selecting or displaying an imported field does not normalize its canonical value. Existing wheel/arrow behavior remains a browser extension rather than new native gesture acceptance.

Direct HP2-to-Peak at Q0.4/gain0 also saved NaN coefficients. The earlier Unity-dropdown observation is therefore not exclusive; a later Q commit repaired the native cache. The importer still refuses nonfinite values. All-pass acceptance uses saved coefficients and independent complex-response/Q24 predictions; phase screenshots remain qualitative and are not numeric phase-raster or physical readback evidence.

The minimum-gain Peak exposed a specific native arithmetic stage: complex construction zeroes the tiny real-pair `1−sqrt(...)` term when its absolute value is at most `1e-12`, before a later large multiplication. The implementation now matches only that proved factor stage, reproducing the native saved coefficients within `1e-18`. No global complex zeroing, imported-cache rewrite or tolerance relaxation was introduced. Both imported and regenerated versions have a pole exactly at one and are correctly refused by the strict compiler guard. Accepted −125 dB metadata is not a claim that this Peak is stable or programmable.

| V39 check | Current result |
|---|---|
| Full development-source suite | **2,627 passed / 2,627 total across 183 files**, zero failures/pending, two workers, no omissions or timeout increases. |
| Frozen source | All **373 source/test/configuration files**, including 17 reviewed changed paths, remained unchanged during the full run. |
| Global typecheck / formatting | Passed for the owner-frozen source used by the full run. |
| Actual Studio browser acceptance | **38 accepted checks** across two passes; one obstructed initial assertion is retained separately. Ignored QA fixes changed no production source. |
| Fresh public tests, typecheck and production/Worker builds | **2,626 passed plus the sole optional-PDF skip: 2,627 total across 183 files**; global typecheck, Next production build and Worker packaging passed. The reviewed export has **381 source files plus 13 public docs/assets: 394 files**. |
| Amplifier programming / acoustics | Not established by this software checkpoint. |

The registry remains **89 commands**. The initial browser report retains test-disclosure, locator and tab-binding issues. One final assertion initially ran after a mouse click obstructed by the ignored QA status panel, with no result or project/history change. The observed command then succeeded with keyboard Space, the same assertion passed, and Undo restored both projects. This is 38 accepted checks plus one retained unsuccessful attempt, not 39 initially passing assertions. Harness corrections changed no production source. These checks exercise the actual UI/shared command layer; they do not prove MCP transport or browser download delivery.

Private publication succeeded with MCP enabled and unchanged owner-only access. Public Worker/client smoke checks confirmed the optional-manual fallback without bundling vendor PDFs. Source and build privacy scans passed all five categories. These results do not establish two-amplifier behavior, new firmware support, hardware programming or complete HFD equivalence. The dated earlier physical baseline remains separate.

## V38 manual frequency and retained-bypass checkpoint

Nine new offline HFD 5.2.4.24 checkpoints cover ordinary frequency commits,
disabled type replacement and two native edge cases. Classic screenshots and
real mouse/keyboard input were used while verified interface ownership kept
HFD disconnected. HFD closed normally before release, and the interface
open/close probe and OS inventory recovered cleanly. No amplifier command or
fresh physical sector read occurred; the dated V35 hardware evidence remains
separate. Saved preferences changed only in recent-project entries, with empty
ASIO names retained.

Actual native pole-frequency text committed on Tab as follows: `1` → `10.0`,
`10.35` → `10.4`, `400.04` → `400.0`, and `50001` → `50000.0`. The half-tie
stores IEEE Single 10.399999618530273, serialized by native XML as
10.3999996185303. Returning to 400 restored the complete baseline XML bytes.
Draft text retained the prior curve until commit. A separate F1 zero edit
restored its prior 720 Hz value and the complete preceding XML bytes.

Changing a disabled LP2 at 720 Hz / Q0.4 to HP2 retained Enabled=false and all
latent parameters; only seven type/derived values changed. Selecting Unity
through the native dropdown instead produced Boost/Cut and a NaN cache in
this example. That artifact is rejected by the web importer. Explicit browser
Unity remains a valid intentional extension; this native quirk is not treated
as a valid response or reproduced as an encoding. Native Delete is separate.

The shared manual editor commits raw text using bounded Extended conversion,
one decimal and Single storage, with ordinary bounds of 10–50,000 Hz. It
normalizes only explicitly edited frequencies. Imported values, untouched
latent fields, input EQ, diagnostic previews and the existing wheel/graph
contracts remain separate. The 40 kHz default browser viewport does not narrow
manual authoring. Native custom-axis bound changes remain unqualified.

The full development-source suite passed **2,560/2,560 tests across 181 files**:
zero failures or pending tests, two workers, no omissions and unchanged
timeouts. All **368 source/test/configuration files**, including **13 changed
code/test paths**, remained hash-identical during the run. Global typecheck and
changed-file formatting passed. Four new paths contain the pure manual
normalizer, its tests and sanitized native fixture/test evidence. No vendor
project or machine/device identity is included in those fixtures.

Actual Studio acceptance passed **31 bounded browser checks** in isolated
fixtures. They cover local drafts, decimal/Single/Q24 values, cancellation,
whole-project Undo, bypass-preserving type changes, mixed Enabled states in
paired palette replacement, enabled Add, valid Unity, shared Both commands,
untouched imported precision and canonical whole-project reload. Explicit
palette Enabled override is component-tested, not newly browser-transport-
qualified. The registry remains **89 commands**; no blocked hardware/audio/file
I/O attempts appeared in nineteen retained phase snapshots.

Two incorrect browser-test expectations were retained and corrected without
production changes: default `redesign:true` replaces imported caches even
when zero retains frequency, and Add Undo retains the current section
selection. The wrong-slot probe was inspected and undone once before section1
was selected for acceptance. With `redesign:false`, a Both zero edit retains
each role's frequency, cache and complete project. The first focused component
test failure used an obsolete adapter closure; that test was corrected before
the passing focused run. No failed-run evidence was discarded.

The first immediate post-edit reload preserved both projects even though its
preceding snapshot still reported saving. A second reload from observed
Ready/saved state also preserved both complete accepted projects. The final
state was Ready with no unsaved changes. This is browser-origin persistence
evidence, not download delivery or remote authenticated MCP transport proof.
The test tab/server were closed, and the user's port3210 origin stayed intact.

The shared shape controls preserve Enabled independently for each destination
unless it is explicitly overridden. Preview changes use Apply, and Add starts
enabled. Device upload behavior did not change in this increment. Production
firmware programming, the native Default EQ popup, arbitrary raw/gesture/view
cases, complete HFD parity, two physical amplifiers, macOS USB and acoustics
remain unqualified.

### Fresh public-source and production checks

Public verification completed on **2026-11-15 at 17:20:22 UTC**, using Node.js
24.22.1. The full unfiltered suite passed **2,559 tests with one optional skip
and zero failures: 2,560 total in 181 files**. It used two workers, unchanged
timeouts and no omissions. The sole skip checks optional installed vendor-PDF
identity; the public repository omits that PDF and its fallback tests ran.
Global typecheck, Next production build and Worker packaging passed. The
generated Next environment file stayed unchanged.

The public allowlist contains **376 source/test/configuration files plus 13
protected documentation/assets: 389 files total**. The production build has
24 static assets totaling **1,899,983 bytes** and a **3,101,755-byte Worker**,
SHA-256 `a3ee32a446a0a4a6116c70e8f3dfe0c92c7d544f054ad473eb9ac51c48569856`.
The actual compiled client and packaged Worker both report manual
`optional:true`, `bundled:false`, with the official vendor fallback link.
The actual Worker returns home200/manual404 in an isolated runtime without
`process`. Source and built-output privacy scans found zero matches across
five checked categories; these are bounded scans, not exhaustive detection.

The private app update also deployed successfully with MCP enabled and its
owner-only audience unchanged. No public hosted deployment is claimed.
After the tests/build, only README and this verification page gained final
result text; the 376 checked source files and build inputs stayed exact. The
tested manifest and final documentation manifest are recorded separately.

## V37 native filter lifecycle checkpoint

Fresh classic HFD 5.2.4.24 offline GUI work produced nine completed native
checkpoints: a new FA503 design, signed/zero-gain Peak states, a real-pole LP2,
Disable/re-enable, Delete and Add reuse. A freshly verified exclusive interface
handle kept native HFD disconnected; it closed normally before that handle was
released. No actual amplifier command, sector read, bridge/configuration Apply,
Upload, power, firmware, noise or audio Take operation occurred. The last fresh
physical preset hash remains the separately dated v35 read-only check at
2026-11-15 13:40:58 UTC; no new v37 hardware proof is claimed.

| Check                                        | V37 status                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Delete/domain/UI/tool focused regressions    | 101 passed across six files.                                                                        |
| Native import/round-trip focused regressions | 46 passed across three files.                                                                       |
| Global typecheck and changed-file formatting | Passed on the frozen source.                                                                        |
| Full development-source suite                | 2,507 passed across 179 files; zero failures/pending.                                               |
| Actual Studio browser acceptance             | Passed: 19 bounded checks on actual Studio.                                                         |
| Fresh public-checkout suite/typecheck        | 2,506 passed, one optional skip; 2,507 total in 179 files. Typecheck passed.                        |
| Fresh production/client/Worker checks        | Next production build and Worker packaging passed.                                                  |
| Private v37 deployment                       | Succeeded with MCP enabled and unchanged owner-only access; no public hosted deployment is claimed. |

The synchronized public allowlist contains **372 source/test/configuration
files and 13 protected documentation/assets: 385 files total**. Only one new
test file and one sanitized lifecycle fixture were added; no vendor files or
new public documentation paths were introduced. V36 and earlier test/build
evidence below remains unchanged history.

Fresh public verification completed on **2026-11-15 at 16:20:19 UTC**, using
Node.js 24.22.1. The full unfiltered suite passed **2,506 tests, with one skip
and zero failures: 2,507 total across 179 files**. It used two workers,
unchanged timeouts and no omissions. The sole skip is the optional exact
installed vendor-PDF identity test; the vendor PDF is absent and synthetic
manual fallback/routing tests ran. Global typecheck, Next production build
and Worker packaging passed. The generated Next environment file stayed
unchanged.

The build contains **24 static assets totaling 1,895,814 bytes** and a
**3,095,778-byte Worker**, SHA-256:
`c9fc7e86cd799ecc4f8d7f6fd8d9e08302e63bd61e908cfc3b48f529d868c035`.
The actual compiled client and Worker report manual `optional: true`,
`bundled: false`, with the official Hypex fallback link. The actual packaged
Worker returned 200 for home and 404 for the absent manual in an isolated
runtime without `process`. Source and built privacy scans each found zero
matches across five checked categories; these bounded pattern scans are not
exhaustive secret detection. The separately completed private deployment
retained MCP and its existing owner-only audience. No public hosting or new
remote MCP transport acceptance follows from these checks.

Commands run from the public checkout:

```sh
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/vitest/vitest.mjs run --maxWorkers=2 --reporter=default --reporter=json --outputFile=../hypex-filter-design-web-public-v37.tests.json
node node_modules/next/dist/bin/next build
node scripts/build-worker.mjs
```

The final unfiltered development-source run passed **2,507 of 2,507 tests
across 179 files**, with two workers and unchanged timeouts. All 364 checked
source/test/configuration hashes, including the 11 frozen changed paths,
stayed unchanged during that run. The first full run had 2,499 passes and
eight failures: two marker tests still matched fixture entries by position
against four-case oracles after the fixture expanded to eight cases. A
test-only correction keyed the eight literal oracles by case name; focused
checks then passed 50 tests in two files, with global typecheck and formatting
passing, before the final full rerun. The original failing run was retained.

### Bounded native observations

- Peak at **2300 Hz / Q 1.150** was saved at **+7.50, −7.50 and 0 dB**. The
  zero-gain state remains an enabled Peak object and has cancelling direct
  coefficients, rather than becoming a Unity type.
- LP2 at **720 Hz / Q 0.400** exercises the real-pole branch. Native Disable
  changed only Enabled; re-enable produced a Config file byte-identical to
  the enabled state. Parameters and literal coefficients survived bypass.
- Native Delete changed that same slot to Unity while retaining Enabled true,
  identity/connectors and latent frequency/Q/gain/direction. Seven saved values
  changed in this case: type, b0, a1, a2, sconst, spoles and zconst; b1/b2 were
  already zero. This is editing-state/cache evidence, not a newly established
  audible filter error.
- Native Add reused that slot. It saved an enabled zero-gain Peak near
  **106.17537689209 Hz**, with Q1 reset to 0.7 and a direct Unity cache. This
  fresh-Add cache differs from the cancelling cache after an explicit gain
  edit to zero, although both transfers are flat. No resets of other latent
  fields are inferred from fields that were already at their observed values.

The current implementation shares native Delete between card Remove, graph
Delete and the strict `fusion_filter_delete` command, with explicit Left,
Right or Both targets. It preserves each slot's identity, latent parameters
and Enabled flag, replaces obsolete section coefficients with Unity, and
resolves an obsolete first-slot cache classification. All Add capacity/find/
commit paths treat Unity as unused regardless of Enabled and preserve the
reused slot identity. The broader Reset, Input-EQ removal and preset Clear
remain separate. The registry contains 89 commands.

The importer now treats an **exactly unit gain multiplier** as an unambiguous
base/effective-cache case while preserving the parsed native values. This
allows the valid fresh-Add Unity cache to compile without silently regenerating
it. Nonunit, inverted and near-unit custom-cache ambiguity guards are unchanged.
No gain/compensation arithmetic or hardware write behavior was changed. Local
Q8.24 checks are software encodings, not observed device readback.

### Actual Studio browser acceptance

All **19 checks passed** on actual Studio in isolated browser fixtures with
hardware/audio/file operations blocked. Card Remove preserved latent values
and freed an enabled Unity slot; Add reused its identity, and Undo restored
the exact projects. Graph context-menu Delete and Undo passed separately.
Bypass retained the native coefficients and latent values while compile
produced Unity, and re-enable restored both complete projects. The shared
Both command retained each role's independent parameters, with one Undo
restoring both exactly. These commands ran through Studio's shared command
interface; no new remote MCP transport or keyboard shortcut acceptance is
claimed.

A separate fresh-native-Add case retained the supplied direct Unity cache,
classified it as base, compiled identity and preserved critical native XML
fields on export. Read-only compile/export commands left both complete
projects unchanged. Both fixtures retained their pre-reload canonical project
values after reload, with persistence Ready and no blocked I/O attempts.
No browser download-delivery or new hardware acceptance follows from these
checks.

Native saves, field observations and fixed literal fixtures precede these
source and browser checks. Existing configurable palette defaults remain a
user choice; this increment does not claim identical native per-keystroke
editing or all fresh-Add defaults.
Native Default EQ remains unaccepted in the disconnected configuration.
Production firmware programming is still missing/disabled; two physical
amplifiers, macOS and full hardware functionality remain unqualified.

## V36 manual-filter and graph-point checkpoint

Four manual-filter states were created and saved through actual mouse/keyboard
interaction in classic HFD 5.2.4.24, using a new native FA503 project. A verified
exclusive interface handle kept native HFD disconnected. It closed normally
before the handle was released. No amplifier setting, bridge, power, filter
Upload, firmware, noise or audio Take operation was performed. No fresh
hardware-sector hash was captured in v36; the preceding v35 read-only match
remains separate evidence.

The frozen development source passed **2,483 of 2,483 tests in 178 files**, with
zero failures or pending tests, two workers, no filters/omissions and unchanged
timeouts. Source/test/configuration hashes stayed unchanged during that run.
The earlier 2,469-test pass preceded the marker fix and is not its final test
result. Focused point/interaction checks passed 84 tests across seven files,
with global typecheck and formatting passing on the frozen source.

| Check                                                       | V36 result                                                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Development-source full suite                               | 2,483 passed; zero failures/pending, 178 files, two workers.                                                           |
| Frozen-source focused checks                                | 84 passed across seven files; global typecheck and formatting passed.                                                  |
| Actual repaired Studio marker/typed-edit browser acceptance | Passed: eight checks on actual Studio components in an isolated origin.                                                |
| Fresh public-checkout suite                                 | **2,482 passed, 1 skipped, 0 failed; 2,483 total across 178 files.**                                                   |
| Fresh public-checkout typecheck                             | Passed.                                                                                                                |
| Fresh public-checkout production build/Worker checks        | Next production build and Worker packaging passed.                                                                     |
| Private v36 deployment                                      | Private deployment succeeded with MCP enabled and unchanged owner-only access; no public hosted deployment is claimed. |

Fresh public verification completed on **2026-11-15 at 15:22:15 UTC**, using
Node.js 24.22.1. The sole skip remains the optional exact installed vendor-PDF
identity test; the PDF is absent and synthetic fallback/routing tests ran. No
cases were omitted and no test timeout was changed.

The build contains **24 static assets totaling 1,894,867 bytes** and a
**3,094,112-byte Worker**, SHA-256:
`a671d1d5ca09847f8109c1855f6ccf29aba7ed8ba8fa478cc3ef2b1f66abc04f`.
The actual compiled client and Worker both report the manual `bundled: false`,
`optional: true`. The actual packaged Worker returned 200 for home and 404 for
the absent manual in an isolated runtime without `process`. Source and built
privacy scans found zero matches in their checked categories; these bounded
pattern checks are not exhaustive secret detection. The generated Next
environment file stayed unchanged. No public hosting acceptance follows from
these builds or from the separately completed private deployment.

Commands run from the public checkout:

```sh
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/vitest/vitest.mjs run --maxWorkers=2 --reporter=default --reporter=json --outputFile=../hypex-filter-design-web-public-v36.tests.json
node node_modules/next/dist/bin/next build
node scripts/build-worker.mjs
```

### Native values and independent response evidence

The native-created baseline stores product 18 / module 9 / 93,750 Hz, with 135
disabled Unity sections. Only the selected first section changed in these
cases; the other 134 remained Unity and all unrelated XML values were retained.

| Native filter   | Entered and saved parameters                                   | Largest public coefficient error |
| --------------- | -------------------------------------------------------------- | -------------------------------- |
| Asymmetric low  | Zeros 800 Hz / Q 0.700; poles 400 Hz / Q 1.300; low direction. | 5.11e−15                         |
| Asymmetric high | Same four parameters; only high direction selected.            | 6.66e−16                         |
| High Shelf2 +6  | 1500 Hz / Q 0.650 / +6.00 dB.                                  | 6.22e−15                         |
| High Shelf2 −6  | Same center/Q/direction; only gain changed to −6.00 dB.        | 1.55e−15                         |

The parser preserves the literal saved coefficient Numbers. Cacheless design
matches all five coefficients within the fixed 1e−10 analysis threshold; the
sanitized regressions check them within 1e−12. Local nearest-even Q8.24 words
also match. These are local numerical checks, not measured wire bytes or an
amplifier upload.

The native asymmetric direction change scales the numerator by 0.25 while
retaining feedback and all four pole/zero parameters, giving a 12.0412 dB shift
without changing phase. Shelf2 deliberately retains inactive secondary fields
from the earlier asymmetric state. Its native ±6 pair is reciprocal: center
magnitudes are approximately ±3.00000037 dB, and the largest complex product
error from unity across 14 numerical samples is 3.45e−13. The latter is a
saved-coefficient calculation, not a native phase screenshot result.

An independent raster analysis evaluates the native literal coefficients,
without relying on the public designer. Twelve asymmetric magnitude samples
match within 0.06541 dB; 16 signed-Shelf2 samples match within 0.02485 dB, each
against a declared ±0.25 dB pixel tolerance. Clipped peaks and selection-marker
regions are excluded. These finite samples do not qualify all frequencies,
parameter limits, phase plots or physical writes.

### Point correction and remaining acceptance

The browser's original asymmetric points were at 0 dB and its Shelf2 points at
±6 dB, despite the correct curves. Native points are on the section's own
response: approximately +4.5828/−7.4584 dB at 800 Hz for the asymmetric pair,
and ±3.00000037 dB at 1500 Hz for Shelf2. The source correction uses
single-precision frequency/dB from the isolated unbypassed parametric response.
It excludes channel gain, FIR, input EQ, measurement, centering and gain-baked
imported caches; invalid/non-finite sections and raw/Unity markers are omitted.
A previous browser check proved numerical edits, cache invalidation, role
isolation and Undo, while exposing the wrong point. It is not reported as
post-fix visual acceptance.

The one-times relative gain drag for shelves/Peak is retained: gain changes by
its original value plus vertical dB movement, without doubling the movement.
Asymmetric dragging remains horizontal. Broader existing Q gestures are browser
extensions, not newly accepted native gesture equivalence.

The final actual Studio browser run passed **eight checks** in an isolated
origin with no hardware use. All four rendered markers matched independently
calculated single-precision anchors within 0.001 dB / 0.05 Hz for DOM/style
serialization. Direct asymmetric direction/frequency edits and Undo, and the
Right shelf −6→+6 edit, invalidated imported caches and matched local Q24
references while preserving the opposite complete project. Dot selection
revealed the parameter inspector without scrolling. Both complete projects
retained their pre-reload canonical hashes after reload; IndexedDB persistence
was Ready with no unsaved changes and an empty blocked-I/O ledger.

A local three-channel compilation retained the expected native +6 shelf words
and complete pre-fix compiled bytes. The marker correction therefore did not
change the DSP output bytes. These are local compiler values, not observed
amplifier wire traffic or an upload. Native HFD was closed and the exclusive
interface handle released before these browser checks; no v36 hardware sector
read or setter occurred. The completed public-source build checks and separate private deployment are
recorded above; they do not establish full hardware parity or a public hosted
instance.

Input-EQ Default GUI acceptance remains open: the disconnected native main
preset editor was unavailable, and its graph EQ inclusion toggle is not that
editor. Connected Save reads physically saved banks, not an unsaved native
editor draft. Production firmware programming remains missing and disabled;
loader correlation, transition/reply handling and safe reconnect/recovery need
an established adapter. An automatic full original-program backup is not an
invented prerequisite. Two physical amplifiers, macOS and full hardware parity
remain unqualified. V35 and earlier results below remain historical evidence.

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
