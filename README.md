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
- Impulse, Step, Magnitude and Phase views; measurement import, window/crop controls, smoothing, project microphone correction and optional browser audio capture.
- Role-aware device settings, shared amplifier-mode reviews, limiter editing, device defaults, Device templates, diagnostics and recovery journals.
- A conditional native OEM digital User mixer with independent per-preset Left/Right drafts, quantized previews, explicit coordinated Save and retained operation records.
- Browser project persistence, a project library, granted-directory Open/Save, reviewed recovery and bounded large-file transfers.
- A shared Native Save artifact for JSON, native folders and ZIPs, with fresh read-only physical settings/EQ capture for supported connected targets and an explicit Design only option.
- Offline firmware file inspection and explicit runtime identity reports for known 5.7/core 5.1 and 5.82/core 5.5 profiles. File recognition does not prove the installed image; core 5.5 remains diagnostic-only and production firmware programming is unavailable.
- A local MCP server and optional authenticated hosted bridge. The current registry exposes **88 commands**; the running server’s `tools/list` is authoritative.

Filter and measurement edits update the design directly. Validated numeric settings commit on Enter or blur where appropriate. Consequential changes use adjacent **Apply**, **Save**, **Update** or **Upload** actions. The developer command console is optional; normal editing never requires a generic Run command.

## Preserve your work

Workspace data lives in this browser origin’s IndexedDB storage. A different hostname, port, browser profile or hosted origin has different data and grants. Export project JSON, native project folders and recovery files before changing origin, clearing browser data or moving computers. A project Save is distinct from a hardware Upload.

Directory saves preserve unrelated files and keep verified before-images, but a multi-file directory save is not an atomic filesystem transaction. An unconfirmed hardware result is also not proof that nothing changed. Inspect its ledger before proceeding.

Opening Save stages a fixed role, design revision and initial device session without I/O. In Auto mode, the first resolve reads matched physical settings and all three EQ banks for an initially connected commercial FA503; it does not send setters or replace staged design EQ. JSON downloads and native folder/ZIP saves use that detached artifact. Design only and initially offline exports preserve the frozen design, including downloads after later edits. A failed connected capture needs an explicit retry with a new capture ID or a Design only choice; it never silently substitutes old metadata.

Save artifacts last for this page lifetime and are bounded to eight IDs, 80 million retained text characters and 640 MB across projects/files. Prepared directory journals durably retain their own exact bytes, so their replay and filesystem commit do not recapture hardware. One actual FA503 on firmware 5.7/core 5.1 completed read-only capture through the Save UI and MCP, with hash-verified JSON bytes delivered through a file-transfer chunk. Both workspace projects and selection remained unchanged, and no amplifier setter was sent. Browser download delivery, paired physical capture and independent HFD GUI equivalence remain unverified; see [verification](docs/VERIFICATION.md).

## Use an MCP client

Keep the app running and start the local server in a second terminal:

```sh
pnpm mcp
```

The server prints a loopback MCP URL, a WebSocket bridge URL and a newly generated pairing token. In **Agent access**, connect to `ws://127.0.0.1:3211/bridge` using that token. Configure your MCP client with `http://127.0.0.1:3211/mcp` and `Authorization: Bearer <pairing token>`. Treat the token as a credential: a paired agent can issue application commands, including permitted device writes.

See [MCP setup and workflow guidance](docs/MCP.md).

## Checks and build

```sh
pnpm typecheck
pnpm test
pnpm build
```

The v34 public-checkout checks passed: **2,449 tests passed and one optional-PDF test skipped across 178 files**, with typecheck and production build passing. See [verification](docs/VERIFICATION.md) for the evidence and hardware qualification limits.

The build produces the static application in `out/` and a packaged optional hosted Worker in `dist/server/index.js`. Hosted authentication, database and object-storage bindings require separate deployment configuration. The local app and local MCP server do not require that hosting platform.

The public source does not include vendor executables, firmware bundles or a vendor manual PDF. Help uses official vendor links when the optional local manual is absent.

## Documentation

- [Getting started](docs/GETTING_STARTED.md)
- [Architecture and persistence](docs/ARCHITECTURE.md)
- [MCP server](docs/MCP.md)
- [USB protocol and operation boundaries](docs/USB_PROTOCOL.md)
- [Native digital User mixer](docs/NATIVE_MIXER.md)
- [Firmware files and read-only runtime identity](docs/FIRMWARE_RUNTIME.md)
- [Verification and remaining qualification](docs/VERIFICATION.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## License

Original project code and documentation are available under the [MIT License](LICENSE), copyright 2026 manuaero. Third-party dependencies and vendor materials retain their own terms and are not relicensed by this project. See [third-party notices](THIRD_PARTY_NOTICES.md).
