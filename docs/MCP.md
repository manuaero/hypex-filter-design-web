# MCP server

Agents use the same controllers and validation as the human interface. Normal users can work entirely through visible controls; the optional command console is a development aid.

The current registry contains **89 commands**, including shared amplifier-mode review, native digital mixer editing and Native Save artifacts. Query `tools/list` on the running server for exact names, descriptions and strict schemas. Public preset, channel, filter and audio-channel numbers are one-based; internal model indices are zero-based.

## Pair a local client

1. Run `pnpm dev` and open `http://127.0.0.1:3210`.
2. Run `pnpm mcp` in another terminal.
3. Read the JSON printed by the server. It includes `url`, `bridge` and a generated `token` unless a token was supplied through the environment.
4. In **Agent access**, enter `ws://127.0.0.1:3211/bridge` and the token, then connect.
5. Configure your MCP client to use the HTTP URL and bearer token.

A client configuration commonly takes this form; use your client’s own configuration format:

```json
{
  "mcpServers": {
    "fusion-studio": {
      "url": "http://127.0.0.1:3211/mcp",
      "headers": {
        "Authorization": "Bearer <pairing token>"
      }
    }
  }
}
```

The local server binds to loopback. Host, Origin and token checks protect the HTTP endpoint and WebSocket pairing. Only one browser bridge is paired to a server at a time. Keep that page open: it owns browser data, permissions and device sessions.

Optional environment variables:

| Variable                 | Purpose                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `FUSION_MCP_PORT`        | Loopback port; default 3211.                                                                 |
| `FUSION_MCP_TOKEN`       | Explicit token of at least 32 characters; otherwise a random token is generated and printed. |
| `FUSION_BROWSER_ORIGINS` | Comma-separated permitted browser origins; defaults to the two local port-3210 origins.      |

Do not expose the loopback server to the internet or place a real token in project files, screenshots, issues or version control.

## Start with non-hardware actions

Read the current state:

```json
{ "name": "fusion_state", "arguments": { "includeProjects": false } }
```

Preview a filter without editing a project or accessing a device:

```json
{
  "name": "fusion_preview_filter",
  "arguments": {
    "filter": { "kind": "peak", "frequency": 1000, "q": 0.707, "gain": -3 },
    "frequencies": [100, 1000, 10000]
  }
}
```

Add a design section to an explicit destination:

```json
{
  "name": "fusion_filter_add",
  "arguments": {
    "target": "left",
    "preset": 1,
    "channel": 1,
    "frequency": 1000,
    "kind": "peak"
  }
}
```

That design edit does not upload the section. Inspect state and use Undo when appropriate. Hardware upload is a separate operation.

## Manual crossover parameter commits and retained bypass

`fusion_filter_set`, `fusion_filter_add` and manual palette draft edits use the
same ordinary crossover frequency normalizer as the visible fields. Numeric
arguments deliberately use their canonical decimal text: for example, 10.35
commits to 10.4 Hz stored as IEEE Single. Finite values clamp to 10–50,000 Hz;
zero uses the corresponding role's previous field value. Unsupported text,
NaN and Infinity are rejected. Diagnostic `fusion_preview_filter` and input EQ
retain their separate contracts.

`fusion_filter_set` Q/Q2 and BQ gain patches, and manual palette updates, also use shared raw-text normalization. Ordinary FA503 defaults are Q **0.1–20**, three decimals, and BQ gain **−125…24 dB**, two decimals. Both store IEEE Double. Numeric command arguments deliberately use `String(number)` as canonical decimal text: `q: 0.4005` commits to 0.401, while `gain: 7.555` commits to 7.56. Exact Q zero reuses that field's own previous Value before three-decimal formatting for each target; gain zero is accepted. This explicit commit can therefore round higher-precision imported Q metadata. Only supplied fields are normalized. These defaults do not import every native custom preference or replace the separate input-EQ, channel-gain, diagnostic or hardware contracts.

```json
{
  "name": "fusion_filter_set",
  "arguments": {
    "target": "left",
    "preset": 1,
    "channel": 1,
    "index": 1,
    "patch": { "q": 0.4005, "gain": 7.555 }
  }
}
```

This edits the design; it does not send an amplifier write. A numerically stored value can still fail compilation. The observed native Peak at −125 dB has a pole exactly at one; imported and regenerated versions are both refused by the unchanged stability guard. No invalid native coefficient is silently repaired to make an Upload succeed.

Only explicitly supplied frequencies are normalized. Opening an imported
project, inspecting it, or changing only its kind does not rewrite latent
frequency precision. Type changes preserve Enabled unless it is explicitly
provided. A Both palette replacement retains each destination's independent
Enabled flag; an explicit draft Enabled value overrides both. Add creates an
enabled new section. Explicit Unity produces a valid Unity response; the
native dropdown's observed Boost/Cut/NaN edge case is not reproduced.

V39 also observed a NaN cache after a direct HP2-to-Peak type change, so this is not a Unity-only native edge case. A later native Q edit repaired that saved cache. Nonfinite imported caches remain refused; finite zero-gain Peak cancellation is a separate accepted case.

These are design edits. Apply commits a preview to the design; Upload remains
a separate amplifier action.

## Native Delete, broader Reset and reusable slots

The normal card Remove and graph Delete actions share `fusion_filter_delete`:

```json
{
  "name": "fusion_filter_delete",
  "arguments": { "target": "both", "preset": 1, "channel": 1, "index": 1 }
}
```

Choose `left`, `right` or `both`; preset/channel are 1–3 and index is 1–15.
The schema is strict and accepts no caller identity or coefficient payload.
Both edits that explicit slot in each independent project and retains each
role's own latent values. Delete preserves the slot IDs, Enabled state,
frequency/Q/gain/direction fields, and replaces the section response/cache
with Unity. It is an undoable design edit with no amplifier call. Linked
followers stay read-only and follow their master.

A Unity slot is unused even when Enabled is true. `fusion_filter_add` and the
visible Add palette can reuse it while retaining its identity; palette settings
remain the user's explicit choice. `fusion_filter_reset` and the inspector's
Reset remain broader operations that restore disabled Unity/default parameters.
Input-EQ removal and preset Clear have their separate scopes.

Fresh native Add can save an enabled zero-gain Peak with a direct Unity cache;
a later regenerated zero-gain Peak can instead have cancelling coefficients.
The importer preserves either supplied cache. An exactly unit gain multiplier
is unambiguous for base/effective interpretation, so the first case now compiles
without a false unresolved-cache block. Nonunit, inverted and near-unit
ambiguity guards remain unchanged. See [verification](VERIFICATION.md#v37-native-filter-lifecycle-checkpoint)
for the bounded native/browser evidence and completed public-source checks.

## Command families

| Purpose                      | Representative commands                                                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State, selection and history | `fusion_state`, `fusion_select`, `fusion_view`, `fusion_history`                                                                                                                                                 |
| Projects and storage         | `fusion_project_new`, `fusion_project_import`, `fusion_project_export`, `fusion_project_save`, `fusion_workspace_storage`, `fusion_project_sources`, `fusion_project_directory`                                  |
| Filters and channels         | `fusion_filter_palette`, `fusion_preview_filter`, `fusion_filter_add`, `fusion_filter_set`, `fusion_filter_delete`, `fusion_filter_reset`, `fusion_channel_set`, `fusion_channel_link`, `fusion_biquad_exchange` |
| EQ and FIR                   | `fusion_eq_set`, `fusion_eq_bank`, `fusion_eq_read`, `fusion_eq_upload`, `fusion_fir_set`, `fusion_fir_read`, `fusion_fir_upload`                                                                                |
| Measurements and analysis    | `fusion_hfd_measurement`, `fusion_microphone`, `fusion_analyze`, `fusion_time_analyze`, `fusion_audio`                                                                                                           |
| Device state and settings    | `fusion_device_read`, `fusion_controls`, `fusion_amplifier_modes`, `fusion_limiter_editor`, `fusion_device_defaults`                                                                                             |
| Device templates             | `fusion_device_clone`                                                                                                                                                                                            |
| Backup/upload/recovery       | `fusion_backup`, `fusion_configuration_backup`, `fusion_upload`, `fusion_upload_all`, `fusion_restore`                                                                                                           |
| Large files                  | `fusion_file_upload_begin`, `fusion_file_upload_chunk`, `fusion_file_upload_commit`, `fusion_file_export`, `fusion_file_chunk_read`, `fusion_file_status`, `fusion_file_list`, `fusion_file_close`               |
| Help                         | `fusion_help`                                                                                                                                                                                                    |

Some older clients cache tool names. Existing validated compatibility namespaces expose selected newer operations; use the server’s current schema rather than guessing nested arguments. Firmware inspection and authentication actions are available through `fusion_device_read` namespaces. Physical firmware programming remains disabled.

## Read-only firmware runtime identity

`fusion_device_read` exposes `firmware.action` values `runtime-status`,
`runtime-read` and `runtime-clear` with an explicit `target` of `left`, `right`
or `both`:

```json
{ "target": "both", "firmware": { "action": "runtime-read" } }
```

Status returns the shared cached reports and Clear invalidates them without
device I/O. Read sends eight matched metadata requests per captured target. It
uses the exact live Session or remembered granted HID object, with no chooser,
device enumeration or VID/PID search. Both publishes new reports together or
neither. A previous result can remain visibly stale after failure.

Known reported 5.82/core 5.5 can be diagnosed without admitting ordinary
controls. Staged exact-file SHA recognition is independent of reported runtime
metadata; neither proves the installed image hash or bootloader family.
Production firmware programming remains unavailable. The normal UI has explicit
Read/Clear actions and does not require this console. See the
[runtime workflow and exact file profiles](FIRMWARE_RUNTIME.md).

## Native digital User mixer

`fusion_native_mixer` uses the same conditional editor and exact independent
Left/Right drafts as the human panel. Presets and channels are one-based.

| Action                             | Behavior                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `status`                           | Cached capability, matrices, drafts, review, outcomes and bounded history; no I/O.             |
| `load`                             | Read an explicit target and open only the chosen preset with native formatting.                |
| `open`, `edit`                     | Open or edit a row at the exact controller revision; no hardware write.                        |
| `cancel`                           | Restore the captured row and close it without reopening on ordinary rerenders.                 |
| `review`                           | Freshly check the fixed target/preset/revision and publish the shared review.                  |
| `save`                             | Require that one-use review ID and `confirm: true`; journal, preflight, write once and verify. |
| `discard-review`                   | Discard the pending review.                                                                    |
| `refresh-history`, `export-record` | Read local history or create checked chunks for a retained record.                             |

The current `revision` comes from status or load. Edit specifies target, preset,
channel, input (`left` or `right`) and value. A Both operation uses each device's
own row, preserving other physical presets. Commercial module 9 does not expose
the native weight editor. Manufacturing Enable mixer is read-only; raw packets
and arbitrary settings are rejected. Partial/uncertain results never retry or
roll back automatically. See [the mixer workflow](NATIVE_MIXER.md).

## Native Save artifacts

`fusion_project_save` shares the human Save controller:

| Action    | Behavior                                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stage`   | Bind an explicit `target`, `expectedRevision` and `mode: "auto"` or `"design"` synchronously, without I/O.                                                                         |
| `status`  | Return cached owner-admitted capture summaries, not raw projects or file text.                                                                                                     |
| `resolve` | Resolve the capture `id`; the first connected Auto resolve performs matched read-only metadata/EQ capture. Successful subsequent resolves reuse the artifact with zero device I/O. |
| `release` | Release the `id` and invalidate any late result. No hardware setter or session close is sent.                                                                                      |

Auto captures use the initially bound session and identity. The current physical profile is commercial FA503 / DSP3-213 core 5.1. Design mode and initially offline Auto roles use frozen document exports without a hardware busy gate. A Both request publishes detached results only if every selected role succeeds and all connected-capture role/revision/session fences remain valid. Nothing is published into the workspace.

Stage using the document revision obtained from current state:

```json
{
  "name": "fusion_project_save",
  "arguments": {
    "action": "stage",
    "target": "left",
    "expectedRevision": 7,
    "mode": "auto"
  }
}
```

Use the returned ID rather than inventing one. To obtain a chunked export:

```json
{
  "name": "fusion_file_export",
  "arguments": {
    "operation": {
      "workflow": "native-project-save",
      "parameters": {
        "id": "<returned capture ID>",
        "slot": "left",
        "format": "zip"
      }
    }
  }
}
```

Formats are `json`, `hfd-xml`, `folder` and `zip`. The slot must belong to that capture. Folder Prepare also accepts `exportId` to reuse the artifact and optional `metadata: "auto" | "design"`. Without an export ID, a new Prepare captures its original role/session before awaits and resolves only after durable replay and directory-grant checks. Existing prepared/archived request replay, Commit, Retry and Recover use retained files without recapturing hardware.

Ordinary `fusion_project_export` and ordinary project file-export workflows remain document snapshots without device reads. Use the explicit Native Save workflow when fresh connected metadata is wanted. A failed capture must be released and staged under a new ID, or replaced by an explicit Design only choice; it does not silently fall back. Offline/design-only artifacts retain their frozen JSON after later edits.

Capture IDs and artifacts are page-local: at most eight IDs and an aggregate 80 million text characters / 640 MB for detached projects and resolved file text. Live IDs are not silently evicted. Prepared directory journals have separate durable storage and exact receipt replay. Do not treat a page-local capture ID as a durable journal receipt or allocate a new filesystem request to bypass an uncertain commit.

The actual MCP `stage` → `resolve` → file export → chunk read → `release` path has been checked against one physical FA503 on firmware 5.7/core 5.1. A 65,467-byte JSON artifact was delivered in one hash-verified chunk, containing all three nine-band physical EQ banks. No device setter was sent and the workspace projects/selection stayed exact. This verifies that read/export path, not paired hardware behavior, browser download completion or independent HFD GUI equivalence.

## Reviews, identities and receipts

Consequential workflows expose review/apply stages with an immutable review or request ID. Confirm the role, physical identity and before/after values. A Both operation may contain independent per-role drafts; it is not necessarily one identical patch.

Trusted transport context is passed separately from tool arguments. Do not supply owner/session identities to bypass it. Pairing admits a client to the local workspace; local-human legacy adoption still requires the actual human UI context.

An error, timeout or browser disconnect can occur after a device accepted a write. Read the operation’s retained ledger before retrying. Consumed requests replay their historical receipt rather than sending again. Undo changes a browser design; it does not undo a hardware setter or an audible sweep.

## Large files and filesystem grants

Use chunked transfers for large WAVs, folders and recovery exports. Decoded chunks are 256 KiB and have explicit byte counts/SHA-256 verification. A transfer handle is owner/scope bound, expires after inactivity or its absolute lifetime, and can require explicit same-owner rebind after reconnection. Immutable export chunks can be resumed and checked byte-for-byte.

Commit binds the destination and expected document revision. Reuse its request/commit identity when resolving an uncertain result; allocating a new request is not a safe generic retry.

Agents can read or save only through already granted filesystem roots. Missing/revoked grants return a human-grant requirement instead of opening a picker or accepting arbitrary paths. Directory saves remain multi-file, non-atomic operations with separate recovery.

## Hosted transport

The optional hosted bridge has its own authentication and browser-lease checks. It does not use the local bearer token. Queue encryption protects transient stored command/results, but the authenticated server processes plaintext; an agent also receives data explicitly returned by tools. Hosted authentication and deployment are separate from local setup.
