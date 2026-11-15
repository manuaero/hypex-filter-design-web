# Fusion Studio

Fusion Studio is a web implementation of the Hypex Filter Design Windows app’s functionality, with an MCP server.

Design crossovers, inspect measurements and manage Hypex FA503 amplifier settings in a browser. Left and Right have independent projects and device identities, with shared controls where appropriate. The interface and agents use the same application services.

![Filter editor with a persistent parameter inspector](docs/images/filter-editor.jpg)

_Filter editor with a persistent parameter inspector._

This is an independent project. Software implementation and simulation coverage do not establish complete HFD compatibility or qualify every hardware operation. Current live protocol support targets FA503 / DSP3-213 core 5.1. Other device families, macOS USB behavior and simultaneous operation of two physical amplifiers remain unqualified.

## Start locally

Use Node.js 22.13 or newer and pnpm 11.25.0. Development has used Node.js 24.

```sh
pnpm install
pnpm dev
```

Open [the local application](http://127.0.0.1:3210) in desktop Chrome or Edge. Windows Chromium browsers are the development target; recorded browser acceptance primarily uses Chrome. A secure browser context and an explicit browser device grant are required for WebHID. Close other software that owns the same amplifier USB interface before connecting.

The app works offline for design tasks. No amplifier or agent connection is needed to create filters, import measurements or inspect responses.

## What is implemented

- Three presets, three output channels and fifteen biquad slots per channel; low/high-pass, shelves, asymmetric shelves, peak, all-pass, unity and explicit raw coefficients.
- A compact graph editor with a persistent parameter inspector, advanced signal-chain editing, channel links, gain, delay, polarity and response sums.
- Nine-band input EQ, independent live EQ activation, three-bank transfer and explicit EQ upload.
- Input/output FIR placement, text coefficient import, retained bypass state and original-data exports.
- Impulse, Step, Magnitude and Phase views; measurement import, window/crop controls, selected-reference Fit truncated bounds, smoothing, project microphone correction and optional browser audio capture.
- Role-aware device settings, shared amplifier-mode reviews, limiter editing, device defaults, Device templates, diagnostics and recovery journals.
- A conditional native OEM digital User mixer with independent per-preset Left/Right drafts, quantized previews, explicit coordinated Save and retained operation records.
- Browser project persistence, a project library, granted-directory Open/Save, reviewed recovery and bounded large-file transfers.
- A shared Native Save artifact for JSON, native folders and ZIPs, with fresh read-only physical settings/EQ capture for supported connected targets and an explicit Design only option.
- Offline firmware file inspection and explicit runtime identity reports for known 5.7/core 5.1 and 5.82/core 5.5 profiles. File recognition does not prove the installed image; core 5.5 remains diagnostic-only and production firmware programming is unavailable.
- A local MCP server and optional authenticated hosted bridge. The current registry exposes **90 commands**; the running server’s `tools/list` is authoritative.

Manual crossover frequency text commits on Enter or blur, using HFD's one-decimal conversion and Single storage. Ordinary edits use 10–50,000 Hz; incomplete drafts stay local, and typing zero retains the previous value. Imported and untouched parameters retain their original precision. Changing shape preserves bypass, including each role's independent Enabled state during linked replacement. Preview Add/Replace still uses an explicit Apply action.

Ordinary crossover Q1/Q2 and BQ gain now share native raw-text commits in the inspector, palette and MCP. Recovered FA503 defaults are Q 0.1–20 with three decimals and gain −125…24 dB with two decimals; both store Double. Zero retains the previous Q, while gain zero is accepted. Passive display leaves imported values untouched. Native nonfinite caches remain rejected, and extreme filters that fail coefficient stability checks remain unprogrammable. See [verification](docs/VERIFICATION.md).

Ordinary output Q1/Q2 and BQ-gain wheel edits now follow the native factory steps: 0.04 for Q and 0.1 dB for gain per delivered event, using its direction rather than multiplying by wheel magnitude. Inspector wheels update the design directly; palette wheels remain in the local preview until Apply. An unchanged formatted value preserves exact imported values and caches. AdditionalGain can cap the visible field while the stored BQ gain is higher; an adjacent **Stored … dB** detail exposes the value used for analysis, compilation and export. Continuous wheel state is local to that field. [MCP wheel adjustments](docs/MCP.md#ordinary-parameter-wheel-adjustments) are stateless events; keyboard increments, frequency wheels and graph gestures keep their separate contracts. Exact native cached coefficients also survive base/custom-cache classification without a one-ULP reconstruction loss.

Remove/Delete keeps a section's slot identity, Enabled flag and latent parameters while making its transfer Unity. The broader Reset remains separate, and Add can reuse an enabled Unity slot. A valid fresh native zero-gain Peak cache is accepted when the gain multiplier is exactly one, while nonunit and inverted-cache ambiguity guards remain. See [verification](docs/VERIFICATION.md) for the bounded acceptance and remaining limits.

The v36 development checkpoint compares four actual offline HFD manual-filter states—low/high asymmetric shelves and a high Shelf2 at ±6 dB—using saved coefficients and independent screenshot measurements. It also corrects filter-point positions to follow each section's own unbypassed response. Actual Studio marker and typed-edit checks passed for those fixed states; this is bounded software acceptance, not complete native or hardware parity. See [verification](docs/VERIFICATION.md).

Filter and measurement edits update the design directly. Validated numeric settings commit on Enter or blur where appropriate. Consequential changes use adjacent **Apply**, **Save**, **Update** or **Upload** actions. The developer command console is optional; normal editing never requires a generic Run command.

## Preserve your work

Workspace data lives in this browser origin’s IndexedDB storage. A different hostname, port, browser profile or hosted origin has different data and grants. Export project JSON, native project folders and recovery files before changing origin, clearing browser data or moving computers. A project Save is distinct from a hardware Upload.

Directory saves preserve unrelated files and keep verified before-images, but a multi-file directory save is not an atomic filesystem transaction. An unconfirmed hardware result is also not proof that nothing changed. Inspect its ledger before proceeding.

Opening Save stages a fixed role, design revision and initial device session without I/O. In Auto mode, the first resolve reads matched physical settings and all three EQ banks for an initially connected commercial FA503; it does not send setters or replace staged design EQ. JSON downloads and native folder/ZIP saves use that detached artifact. Design only and initially offline exports preserve the frozen design, including downloads after later edits. A failed connected capture needs an explicit retry with a new capture ID or a Design only choice; it never silently substitutes old metadata.

Save artifacts last for this page lifetime and are bounded to eight IDs, 80 million retained text characters and 640 MB across projects/files. Prepared directory journals durably retain their own exact bytes, so their replay and filesystem commit do not recapture hardware. One actual FA503 on firmware 5.7/core 5.1 completed read-only capture through the Save UI and MCP, with hash-verified JSON bytes delivered through a file-transfer chunk. Both workspace projects and selection remained unchanged, and no amplifier setter was sent. Browser download delivery and paired physical capture remain unverified. A separate v35 offline native HFD graph comparison now supports the tested phase, visibility, shared-crop and Fit truncated behavior; it does not establish complete HFD equivalence. See [verification](docs/VERIFICATION.md).

## Use an MCP client

Keep the app running and start the local server in a second terminal:

```sh
pnpm mcp
```

The server prints a loopback MCP URL, a WebSocket bridge URL and a newly generated pairing token. In **Agent access**, connect to `ws://127.0.0.1:3211/bridge` using that token. Configure your MCP client with `http://127.0.0.1:3211/mcp` and `Authorization: Bearer <pairing token>`. Treat the token as a credential: a paired agent can issue application commands, including permitted device writes.

See [MCP setup and workflow guidance](docs/MCP.md).

## Checks and build

V41 development-source verification passed **2,742/2,742 tests in 186 files**; the public checkout passed **2,741 tests plus the sole optional-PDF skip, 2,742 total in 186 files**. Both runs used two workers, no test filters or changed timeouts, with unchanged source snapshots and passing typecheck. The public Next production build and Worker packaging passed. Actual Studio acceptance passed **29/29 Chrome checks** against synthetic designs with blocked external I/O; all five raw fields were visible at 1024×768 without document scrolling. The reviewed public export contains **387 source files plus 13 protected public files: 400 total**. Private deployment succeeded with MCP enabled and owner-only access preserved. See [verification](docs/VERIFICATION.md#v41-raw-coefficient-checkpoint).

V40 development-source checks passed **2,691/2,691 tests across 185 files**, with zero failures or pending tests, two workers, unchanged timeouts and all 377 source/test/configuration hashes plus the recorded `.gitignore` unchanged. Actual Studio acceptance passed **29/29 browser checks** in Chrome using genuine tab-scoped wheel input and the shared command console; no blocked I/O attempts were recorded and the 160 bundled product source files stayed unchanged. Native evidence comprises 22 actual HFD saves and a separately labeled synthetic input. Private V40 deployment succeeded with MCP enabled and unchanged owner-only access. Fresh V40 public-checkout checks passed **2,690 passed plus the sole optional-PDF skip: 2,691 total across 185 files**; global typecheck, Next production build and Worker packaging passed. The reviewed export has **385 source files plus 13 protected public files: 398 total**. The V39 results below remain historical evidence. See [verification](docs/VERIFICATION.md#v40-ordinary-parameter-wheel-checkpoint) for the bounded scope.

V39 development-source checks passed **2,627/2,627 tests across 183 files**, with zero failures or pending tests, two workers, unchanged timeouts and an unchanged 373-file source snapshot. Global typecheck and formatting passed. Actual Studio acceptance recorded **38 accepted browser checks**, with one obstructed initial QA assertion retained separately and the corrected command/Undo checks passing. The public checkout passed **2,626 tests plus the sole optional-PDF skip: 2,627 total in 183 files**, typecheck, Next production build and Worker packaging. The private deployment succeeded with MCP enabled and unchanged owner-only access. The V38 results below remain historical evidence.

V38 development-source checks passed **2,560 tests in 181 files**, with zero failures, two workers, unchanged timeouts, global typecheck and formatting passing. Actual Studio acceptance passed **31 bounded browser checks**, covering committed frequency precision, retained bypass, paired shape changes, Undo, imported values and reload. The fresh public checkout passed **2,559 tests plus one optional-PDF skip: 2,560 total in 181 files**, typecheck, Next production build and Worker packaging. The private deployment succeeded with MCP enabled and unchanged owner-only access. See [verification](docs/VERIFICATION.md) for exact scope and retained test corrections.

```sh
pnpm typecheck
pnpm test
pnpm build
```

V37 development-source checks passed **2,507 tests in 179 files**, with two workers, unchanged timeouts, global typecheck and formatting passing. Actual Studio browser acceptance passed **19 checks** covering Delete/Add identity reuse, Undo, bypass/re-enable, independent Both edits and reload persistence. The first full run exposed eight outdated positional marker-test oracles; a test-only correction preceded the passing full rerun. The fresh public checkout passed **2,506 tests plus one optional-PDF skip: 2,507 total across 179 files**, with zero failures, two workers and unchanged timeouts; typecheck, Next production build and Worker packaging passed. Private deployment succeeded with MCP enabled and unchanged owner-only access; no public hosted deployment is claimed. See [verification](docs/VERIFICATION.md) for the bounded evidence and limits.

The prior v36 public checkout passed **2,482 tests plus one optional-PDF skip: 2,483 total across 178 files**, with zero failures, two workers, unchanged timeouts, typecheck, Next production build and Worker packaging passing. The development-source suite also passed all 2,483 tests. See [verification](docs/VERIFICATION.md) for exact build results and native/browser acceptance limits. These are public-source checks; no public hosted deployment is claimed.

The prior v35 public checkout passed **2,464 tests plus one optional-PDF skip: 2,465 total across 178 files**, with two workers, unchanged timeouts, typecheck and production builds passing. V35 corrects selected-reference floating-grid Fit truncated bounds, supported by independent native graph comparisons and actual Studio/MCP browser checks. These checks qualify the tested behavior, not complete HFD or hardware parity. The development-source first full run had one timeout; that test passed in isolation and the full rerun passed. See [verification](docs/VERIFICATION.md) for exact results, historical v34 numbers and remaining limits.

The build produces the static application in `out/` and a packaged optional hosted Worker in `dist/server/index.js`. Hosted authentication, database and object-storage bindings require separate deployment configuration. The local app and local MCP server do not require that hosting platform.

The public source does not include vendor executables, firmware bundles or a vendor manual PDF. Help uses official vendor links when the optional local manual is absent.

## Documentation

- [Getting started](docs/GETTING_STARTED.md)
- [Architecture and persistence](docs/ARCHITECTURE.md)
- [MCP server](docs/MCP.md)
- [Explicit coefficient editing and cache interpretation](docs/HFD-RAW-COEFFICIENT-EDITOR.md)
- [USB protocol and operation boundaries](docs/USB_PROTOCOL.md)
- [Native digital User mixer](docs/NATIVE_MIXER.md)
- [Firmware files and read-only runtime identity](docs/FIRMWARE_RUNTIME.md)
- [Verification and remaining qualification](docs/VERIFICATION.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## License

Original project code and documentation are available under the [MIT License](LICENSE), copyright 2026 manuaero. Third-party dependencies and vendor materials retain their own terms and are not relicensed by this project. See [third-party notices](THIRD_PARTY_NOTICES.md).
