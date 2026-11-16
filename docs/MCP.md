# MCP server

Agents use the same controllers and validation as the human interface. Normal users can work entirely through visible controls; the optional command console is a development aid.

The current registry contains **91 commands**, including stateless native parameter-wheel adjustments, shared amplifier-mode review, native digital mixer editing and Native Save artifacts. Query `tools/list` on the running server for exact names, descriptions and strict schemas. Public preset, channel, filter and audio-channel numbers are one-based; internal model indices are zero-based.

## V48 native channel Gain profile

The existing `fusion_channel_set` command keeps the 91-command registry. `patch.gain` accepts a finite number or original raw Text string. Raw Text is normalized separately for every role in the native FA503 factory -125..24 dB/two-decimal Double profile, then each channel applies its own AdditionalGain ceiling. For example, raw 18 can publish 14 in a role with AdditionalGain 10 and 18 in a role with AdditionalGain 0, even when the first role already stores 14. Explicit typed requests are not flattened to the selected role's capped result.

A sole `patch.gainWheel` object accepts `direction: "up" | "down"` and optional `basis: "each" | "left" | "right"`. Each is the default: one fresh passive field 0.1 dB event per role. A fixed source mirrors only a changed canonical source result, through each destination's own callback ceiling; a source canonical no-op skips the mirror after all-target preflight. Replies return each role's canonical value and displayed Text. Opaque state, custom bounds/step and caller eligibility flags are not accepted. Continuous human wheel state stays local to its field; commands deliberately start fresh. The conditional hardware-compensation intent stays separate. All targets validate before publication; canonical no-ops preserve caches and history.

Human typed Gain remains a local raw draft until Enter/blur and uses the V47 scoped field lease. Every own commit/wheel callback stays within that lease; accepted independent edits cannot be erased by stale Escape. A channel-only foreign revision fence refreshes transient state without ending valid own groups. This multi-role freshness policy and keyboard arrow recurrence are browser extensions, not native stereo/arrow acceptance. Master volume and BQ/Input EQ profiles remain separate.

Actual offline HFD saves qualify normal minimum/maximum, half rounding and signed wheel/coupled-ceiling cases. A separate conflicting imported 24/Add10 file was normalized to 14 on load before Save; it is not a native wheel oracle. The current connected MCP declaration/schema and actual browser/Agent Access pairing remain unqualified. Earlier dated transport results below do not establish V48 acceptance. See [channel Gain scope](CHANNEL-GAIN-v48.md).

## V47 focused numeric edits and independent commands

Managed numeric fields own an opaque focus lease. The shared workspace validates an independent edit before committing pending local field work; the accepted edit then gets its own Undo step. This default store boundary also protects graph writeback that does not use the usual adapter edit path. Only a synchronous callback scoped to the current field lease continues that field's own group. Escape from an older focus cannot roll an accepted independent edit back. A refused proposal or canonical no-op does not invoke the independent boundary or discard the current local draft. No new command or caller-supplied lease/override flag is introduced; the registry remains **91 commands**.

Stale focused drafts and opaque wheel state are discarded even when the canonical numeric value happens to be unchanged. A genuine subsequent local edit starts a fresh lease from the current value. Selection, Undo/Redo and project replacement retire stale field ownership. These boundaries are shared by normal inspector editing and existing executor commands; normal editing requires no generic Run action.

This is source and automated component/executor coverage, not new V47 browser, production-client, remote-authentication or HTTP/WebSocket network acceptance. V46's synthetic Node fixture result remains dated V46 history. Native ordinary channel-Gain text/wheel checks remain prepared and unexecuted. See [numeric transaction scope](NUMERIC-TRANSACTIONS-v47.md).

## V46 conditional hardware gain and atomic channel edits

The existing `fusion_channel_set` command accepts a sole `patch.hardwareGain` boolean. It adds no command; the registry remains **91 commands**. This is a crossover-project design callback, with no USB operation or arbitrary AdditionalGain scalar.

```json
{
  "name": "fusion_channel_set",
  "arguments": {
    "target": "both",
    "preset": 1,
    "channel": 1,
    "patch": { "hardwareGain": false }
  }
}
```

Off sets the selected channel's compensation to 0 dB. On sets it to 10 dB and commits coupled Gain through the recovered factory callback; Gain 18 dB becomes 14 dB. Explicit same-checked requests still run the callback, so imported compensation 6 can normalize to 10 and a conflicting document hint can be corrected. Passive import does not perform that normalization. The typed `hfdGainLowered` hint reflects the selected callback, not an OR over every channel and not measured amplifier state.

Eligibility comes from trusted editor context, never JSON flags. A fresh channel must already have finite nonzero compensation. An admitted existing view stays available after Off, across normal gain edits, Save and channel navigation; project replacement/reopening clears that view context. Thus the same human/agent context can turn it back On. Every requested role must admit the action, including the existing independent-root guard. A headless adapter without retained trusted context can use only fresh eligibility.

All channel edits now preflight every selected role before one explicit-role transaction. Metadata-only changes preserve dirty imported followers; actual processing changes synchronize only the selected preset/root group in each changed role. Canonical no-ops preserve cache/provenance and create no Undo entry. Ordinary scalar bounds and authoring behavior remain unchanged. The separate compensation callback has source-qualified Single passive display and two-decimal Double publication; broader native ordinary Gain typing/wheel/custom-preference behavior remains unqualified.

Eleven paired Node integration checks passed against the actual owned loopback HTTP/WebSocket server and a Node fixture WS client using the production workspace authority/store/shared executor. They cover both-role edits/Undo, compensation Off/On, strict refusal, linked-peer admission and revocation. They do not qualify the production AgentAccess client, actual Studio/browser, Site authentication, remote-client execution, amplifier or download behavior. A dated connected-session catalog listed all 91 source names but did not advertise the newer hardware-gain and graph-drag argument declarations; the cause is unestablished, so name equality does not establish argument-schema parity. See [hardware gain details](HARDWARE-GAIN-v46.md).

## V45 ordinary graph position edits

`fusion_filter_adjust` adds strict `surface: "graph-drag"` arguments without adding a command; the registry remains **91 commands**. Supply one-based `target`, `preset`, `channel`, `index`, absolute `frequency` (0.001–50,000 Hz), and finite `originAxisY`/`axisY`. Extra field-wheel arguments, raw coefficients, a source basis or a serialized gesture token are refused.

```json
{
  "name": "fusion_filter_adjust",
  "arguments": {
    "target": "both",
    "preset": 1,
    "channel": 1,
    "index": 1,
    "surface": "graph-drag",
    "frequency": 6319.0052,
    "originAxisY": 0,
    "axisY": 3.05
  }
}
```

The 0.001–50,000 Hz interval is the currently supported browser graph contract, not a universal native configured range. Frequency is an absolute graph position stored as Single, independently of the typed one-decimal frequency path. Y subtraction uses Extended arithmetic before narrowing its cumulative delta to Single; gain then uses each role's captured Double origin, bounded formatting and final two-decimal Double reparse. Peak/Shelf1/Shelf2 use the ordinary −125…24 dB defaults. No field-wheel AdditionalGain ceiling or shelf midpoint factor2 is applied. Asymmetric, all-pass and other inactive gain fields retain their exact values; secondary frequency/Q are not graph targets. Raw/Unity and linked destinations are refused before editing either role. Numerical stability and upload guards remain in force.

Each command is one stateless event with fresh per-role origins. Repeating it starts from the newly stored values; it does not continue a human pointer gesture. The human gesture captures both origins once and groups its accepted moves into one Undo. Both routes share structural preflight, explicit role keys, actual-change filtering, cache/provenance preservation on canonical no-ops and one atomic edit. An already matching peer retains its whole state. Independent edits retire an active owned drag; its later cancel cannot overwrite that newer work.

The existing `surface: "field"` and graph-Q `surface: "graph"` contracts remain separate. Input EQ graph editing remains a separately qualified browser convenience. These are design edits, with no amplifier I/O. Ten owned local HTTP checks passed while unpaired, including the exact 91-command listing, strict graph-drag declaration and token/origin/host guards. They do not establish paired graph execution, remote MCP or production authentication. The isolated browser recorded one baseline and three unaccepted setup interruptions. See [graph drag details](GRAPH-DRAG-v45.md).

## V44 shared firmware workflow

Firmware actions extend the existing `fusion_device_read` namespace; the registry remains at **91 commands**. Normal file inspection, runtime identity, update review and execution admission are distinct. A filename, content profile, runtime version, loader product name or caller-supplied flag cannot qualify physical programming. The physical-profile registry is empty, so update review refuses unavailable physical routes before device I/O.

```json
{
  "name": "fusion_device_read",
  "arguments": {
    "target": "both",
    "firmware": { "action": "update-status" }
  }
}
```

- `update-status` returns the shared cached workflow. `update-history` reads owner-bound local journal history, with `offset` and `limit` (1–16). These are not device reads.
- `update-review` requires exact current `stageIds` for every intended role. Left and Right retain independent files and captured identities.
- `update-apply` requires that fixed `reviewId` and `confirm: true`; consumed operations replay their retained outcome rather than sending again. The human checkbox is bound to the exact shared review ID.
- `update-discard` discards the identified pending review. `update-review-recovery` takes `recordId` and an explicit covered-role target; it uses the original journal source and before-images, not a newly staged file. A partial Both record may be reviewed for only its affected role.
- `update-export` returns owner-admitted record pages using `recordId`, `offset` and `limit` (up to 16,384 characters). Raw source/images stay out of ordinary status summaries.

Cold-page recovery may restore historical expected-role metadata only after trusted owner, execution-route, source and qualification checks. It refuses occupied or conflicting assignments, never opens a device by that metadata alone, and still requires independently qualified same-unit loader correlation. No command accepts a transport, physical profile, fabricated identity or arbitrary expected firmware version. Reference-simulation journals cannot become physical execution authority.

Runtime entry sends fixed `40/00` once, retires the old transport and bounds host settlement to five seconds; a settled host send is not a target acknowledgement. Physical stream sends do not acquire a retry capability from reference simulations. There is no automatic cancel `0x41`, reentry, rollback or settings replay. Matching 43 known before/after images is not a full original-program or calibration backup. See [workflow and qualification](FIRMWARE-WORKFLOW-v44.md).

## V43 graph-Q and selected FIR transfer

`fusion_filter_adjust` defaults to `surface: "field"`. Field Q/Q2/gain keeps its existing publication, continuous-human-versus-stateless-command distinction and AdditionalGain display/store behavior. An unchanged final displayed Text alone does not prove an unchanged canonical value: the gain postguard can change Text after a model callback.

Use `surface: "graph"` only with `parameter: "q"` for a fresh stateless native Magnitude graph-Q event. Its factory step is 0.04 with ordinary Q bounds 0.1–20 and three-decimal Text; explicit graph GetValue publishes the resulting Double even when visible Text is unchanged. For example, an upward graph event at imported Q 20.0004 publishes 20, while the ordinary field's same-Text bound event retains 20.0004. No device is accessed.

```json
{
  "name": "fusion_filter_adjust",
  "arguments": {
    "target": "both",
    "preset": 1,
    "channel": 1,
    "index": 1,
    "parameter": "q",
    "direction": "up",
    "surface": "graph",
    "basis": "each"
  }
}
```

Graph Q supports LP2, HP2, Shelf2 and Peak. Each-role basis requires supported graph types for each event. For a fixed-source Both basis, a source event that would change the canonical value validates every destination before either project changes. An exact canonical-bound source no-op stays quiet, does not mirror, and does not reject an unsupported peer merely for its graph-Q type; structural and read-only target checks still apply. An off-grid bound that rounds to a different canonical value is a real change and must pass those peer checks. Asymmetric/AP2 numeric field Q remains available through the default field surface. Unsupported changing pairs refuse atomically, unchanged supported peers retain their exact caches, and Undo restores the design.

In the human graph, the already-selected filter remains editable while Whole channel response is displayed; hovering a different marker does not change the wheel target. Input EQ graph gestures use its existing field helper and remain a browser extension, with no new EQ graph surface or native-popup claim. Commands are fresh stateless events; they do not reuse a human field's private continuous widget state.

Native Unknown Shelf1/Shelf2 direction is interpreted as Low, separately from Asymmetric's Unknown High branch. The raw enum remains through ordinary parameter/bypass edits; explicit direction edits record Low/High, including a deliberate choice equal to the old effective direction. Contradictory combined choices are refused. Untouched imported caches remain exact.

Ordinary preset uploads transfer only the selected FIR placement. A compact count/meaning/role/preset disclosure explains why inactive graph FIRs remain in the design but are not transferred, with every detailed advisory available before an explicit Upload. Normal UI editing needs no generic Run action. These software/controller checks do not qualify device writes, remote MCP transport or a production firmware programmer.

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

## Ordinary parameter wheel adjustments

`fusion_filter_adjust` applies one native ordinary output Q/Q2 or BQ-gain wheel event to the design. The registry now has **90 commands**. This action does not access an amplifier and does not require the optional command console for human editing.

```json
{
  "name": "fusion_filter_adjust",
  "arguments": {
    "target": "both",
    "preset": 1,
    "channel": 1,
    "index": 1,
    "parameter": "q2",
    "direction": "up",
    "basis": "each"
  }
}
```

Preset/channel are 1–3 and filter index is 1–15. `parameter` is `q`, `q2` or `gain`; `direction` is `up` or `down`. The recovered factory step is 0.04 for Q/Q2 and 0.1 dB for gain, with Double storage and the ordinary bounds described above. Choose a parameter active in the selected source filter. One command is one event. Native +120 and +360 wheel events each produced one step; wheel magnitude is not an event multiplier.

- `basis: "each"` is the default. Both roles advance from their own value and channel AdditionalGain context; the selected parameter must be active in each selected role.
- `basis: "left"` or `"right"` computes an event from that active source parameter and mirrors its changed canonical value; an inactive counterpart field may retain that mirrored value as latent metadata. An unchanged source leaves the other role untouched. A single target accepts only `each` or its matching role.
- All selected destinations must be editable and unlinked before one atomic document edit. Only changed values redesign cached coefficients; an all-bound no-op adds no history entry. A source-based mirror follows the existing manual-field rules for inactive destination parameters.

Results return the computed native event `text` and stored `value` separately. For a source-basis mirror, `text` describes the source event, not a destination widget’s display. The native AdditionalGain post-step ceiling suppresses one notification: with AdditionalGain 10, one event from 13.95 displayed `14.00` but saved gain **14.05**; another from 17.95 displayed `14.00` but saved **18.05**. Analysis, compilation and export use the stored value. Human fields show **Stored … dB** whenever that value differs from their visible text.

Each MCP call begins from a fresh passive field. It never imports or retains a browser field's private transient wheel state. Continuous human wheel gestures may therefore differ from separate commands in this inhibited-ceiling case. `fusion_filter_set` remains the separate absolute text-commit action. These semantics do not qualify keyboard arrows, graph gestures or input EQ.

Native reopening of the synthetic AdditionalGain-6 input normalized it to 10, but passive web imports preserve the supplied metadata. That native load behavior is not a request to rewrite browser projects. Exact native cached numerator Doubles are also retained during base/custom interpretation; ambiguity and stability guards remain unchanged. The native −125/−124.9 Peak cases match numerically while both imported and regenerated versions still refuse compilation at a pole of one. Scalar Q24 predictions are not accepted upload packets. See [V40 verification](VERIFICATION.md#v40-ordinary-parameter-wheel-checkpoint).

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
| Filters and channels         | `fusion_filter_palette`, `fusion_preview_filter`, `fusion_filter_add`, `fusion_filter_set`, `fusion_filter_adjust`, `fusion_filter_delete`, `fusion_filter_reset`, `fusion_channel_set`, `fusion_channel_link`, `fusion_biquad_exchange` |
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


## V41 raw coefficient checkpoint

`fusion_filter_set` accepts a strict, nonempty partial coefficient object for raw sections. For example:

```json
{"target":"both","preset":1,"channel":1,"index":1,"patch":{"coefficients":{"b0":0.5}}}
```

Each role merges only `b0` into its own complete finite vector. The other four values, bypass state and first-cache interpretation stay independent. All targets are preflighted before one Undoable edit; malformed or linked destinations refuse the entire operation. An exact no-op retains metadata and history. Raw bypass or latent parameter edits retain the vector under the default redesign option. Full nonraw cache overrides remain compatible; changed vectors clear stale original-coefficient provenance.

Direct raw Add starts at Unity. Conversion captures the current unbypassed section; the palette converts its staged preview and replaces the whole proposed section only on Apply. Human typed coefficients commit on Enter/blur. Partial coefficient authoring does not resolve an ambiguous gain cache or weaken compile stability/Q24 checks. The core/MCP can retain signed zero in memory; existing UI/JSON number semantics canonicalize it. These 29 browser checks exercised the shared executor through the optional developer console, not a remote MCP transport. See [explicit coefficient editing](HFD-RAW-COEFFICIENT-EDITOR.md).

## V42 Input EQ parameter checkpoint

Input EQ frequency, Q and gain have their own recovered FloatEdit authoring profile. Frequency commits to **Double**, unlike the ordinary output-BQ Single path:

| Field | Explicit Text bounds | Fixed display | Wheel event |
| --- | --- | --- | --- |
| Frequency | 10–50,000 Hz | one decimal | directional 1/10/100/1,000 Hz decades |
| Q | 0.1–20 | three decimals | 0.04 |
| Gain | −15.9…15.9 dB | two decimals | 0.1 dB |

Whole Text is parsed/normalized with the recovered Extended arithmetic, then formatted and reparsed to Double. Exact frequency/Q zero keeps the previous internal value before that format/reparse, so excess canonical precision may round; gain zero is accepted. Strict finite browser input and semantic Enter/blur commits are bounded adaptations, not native per-keystroke timing acceptance. Untouched imported parameters are retained. EQ wheels do not use output-channel AdditionalGain.

`fusion_eq_adjust` applies one signed, stateless wheel event. Magnitude, custom steps and private field state are not tool arguments:

```json
{"target":"both","preset":1,"index":1,"parameter":"q","direction":"up","basis":"each"}
```

The default basis advances each selected role independently; `left` or `right` mirrors that selected source's changed value. A source no-op does not overwrite its peer. Each result returns the role's own Text and value. All destination EQ banks validate before a single Undoable design transaction, with no amplifier I/O. `fusion_eq_set` uses the same committed-field profile. Its `patch.enabled` controls one band; the separate top-level `enabled` controls whole-EQ activation. Type changes retain per-role band bypass unless explicitly changed.

Changed design fields clear their own old coefficient/provenance cache. Bypass, exact no-ops and unchanged mirrored peers retain it. Explicit Reset uses `redesign:true` to clear the cache even when scalars already match; ordinary edits leave this false. Human inspector wheels use field-local opaque state, while creation-palette edits stay local until Apply. Passive native band-selection normalization and actual native EQ popup/Default acceptance remain open.

Actual isolated Studio work recorded **45 accepted browser checks and two retained initial unaccepted assertions** among 47 observed attempts. The immediate graph-footer heading assertion was corrected by subsequent DOM and later footer observations. A fast leading-dot commit initially appeared unchanged; its cause remains unproven. Observed-draft commits, three repeated wheel/Undo/leading-dot sequences and five separate JSDOM diagnostics passed. No product defect was reproduced, but JSDOM does not adjudicate the browser observation and its timing qualification remains open. These synthetic browser checks exercise the shared executor, not a remote MCP transport. Native/physical EQ uploads, two physical amplifiers, macOS USB and download delivery are not qualified. See [Input EQ field scope](HFD-INPUT-EQ-FIELDS-v42.md).
