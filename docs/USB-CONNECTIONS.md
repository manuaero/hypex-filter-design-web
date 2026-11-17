# USB connections and amplifier roles

Open **Manage amplifiers** in the header to discover devices, assign Left and
Right, or load an amplifier's current design. These connection actions change
local browser bindings. They do not change the amplifier's routing, bridge
configuration, volume, mute, power or filter memory.

## Connect once, then reconnect automatically

The first connection to an amplifier requires **Add amplifier** and the browser's
device permission chooser. After permission is granted, the app discovers
permitted Hypex interfaces on startup and follows USB connection events. Desktop
Chrome or Edge with WebHID support is required.

Permissions belong to the browser and page origin. A grant for the hosted app
does not grant the local app access, and a grant for one local port does not
grant another port access. **Find permitted amplifiers** checks the existing
grants; it does not open a permission chooser or grant itself new access.

The browser remembers confirmed serial-to-role assignments and the **Auto
reconnect** preference. A known amplifier returns to its remembered side even if
USB enumeration order changes. Connection failures stay visible with a retry
path. The app does not repeatedly reopen a timed-out interface or close another
controller such as HFD automatically.

Turning Auto reconnect off leaves current connections intact and prevents new
automatic connections. An explicit Add action can still read a selected device's
identity, after which **Use as** can connect it to a side.

## Left and Right are local assignments

A confirmed serial assignment takes precedence over an inferred side. Exclusive
Left or Right digital routing can provide a labeled suggestion for a newly
discovered amplifier. Routing describes its current input configuration; it is
not proof of the physical speaker location. Master/slave mode is not treated as
a Left/Right indicator.

Mono, User mixer, disabled routing and conflicting hints remain unassigned.
Two devices with the same identity are not assigned to separate roles. The app
does not resolve ambiguity by taking whichever device the browser lists first.

| Control                       | Result                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Use as Left / Right**       | Assigns that USB connection to the chosen editing role and remembers the choice.                        |
| **Swap Left and Right**       | Exchanges the two connected amplifier bindings in one local operation.                                  |
| **Unassigned / Disconnect**   | Releases the connection and pauses automatic reconnection for that identity during the current session. |
| **Find permitted amplifiers** | Refreshes discovery while preserving a manual disconnect pause.                                         |
| **Load filters and settings** | Reads the connected amplifier into that side's local design.                                            |

Assignments and swaps preserve both existing designs in their editing roles.
They do not move designs between sides or upload either design. Use the explicit
load action when the local design should reflect the newly assigned amplifier.
Connection changes are refused while an amplifier operation or owned noise
generation is active.

A manual disconnect pause survives hotplug events and Find scans in the current
session. Explicit assignment, Add or Connect can resume that identity. The pause
is session-local; Auto reconnect and confirmed side assignments are persistent.
Turn Auto reconnect off when automatic startup connections are unwanted. If
browser storage is unavailable, the interface reports that assignments are only
remembered for the current session.

## Load the current filters and settings

**Load filters and settings** reads all three crossover presets, their physical
input EQ, each preset's selected FIR placement, and current device metadata.
The selected hardware preset is reflected in the workspace selection without
sending a preset-selection command. The operation saves exact crossover and FIR
recovery images in browser storage and retains the captured device metadata with
the design.

The complete detached result is checked before replacing one role's local
project. The other role and its design stay intact. Replacement is one Undo
step. Undo restores the local design; it does not change amplifier memory. A
stale document or connection refuses publication. A workspace persistence failure
is reported separately rather than claiming that the loaded design is durable.

The captured EQ includes its metadata and coefficients; unused padding is not a
whole-byte EQ backup. Some native project-template fields have marked host-only
defaults because the device does not supply those values. Those defaults are not
measured amplifier settings. The exact recovery-image claim applies to the
crossover and FIR images, not to every byte of an entire device configuration.

The read uses identity, status and memory getters. It does not mute, select a
hardware preset, apply device settings, program filter memory or apply bridge
configuration. Connecting and reconnecting also do not automatically load over
an edited local design.

The recovered design has explicit limits:

- Crossover sections retain compiled raw coefficients. The read does not recover
  the original filter shape, frequency/Q labels or separately factored channel
  gain and polarity from those banks.
- Only the selected FIR placement is decoded. Inactive flags, filenames and raw
  recovery bytes are retained; inactive tap caches are not invented.
- Original measurements, microphone calibration and driver labels are not
  restored from the amplifier. Load those separately from a saved project.
- Sequential reads and metadata checks are not an atomic snapshot against another
  controller. The result is rejected if the checked identity or configuration
  changes during capture.

## Agent access

The UI and `fusion_devices` use the same discovery and assignment service.
`status` is cached; `discover` checks previously permitted interfaces. Assignment,
swap and disconnect require the current discovery revision. The explicit `read`
action uses the same complete read operation as the human load button.

Agents cannot supply HID objects, bypass the browser chooser, infer a different
protocol profile or turn a role assignment into a device-setting write. Existing
`fusion_connect` and `fusion_disconnect` remain available for their explicit
connection workflows.

## Evidence and limits

A Windows Chrome session connected the available FA503 as Right, identified
DSP3-213/core 5.1 with firmware 5.7, read all 135 crossover sections, then completed
the full load action. The loaded project was persisted. After a normal browser
reload, the amplifier automatically reconnected to Right and the same project
was visible. Reported source, volume and hardware preset were retained; bridge
remained off. No amplifier write or bridge action was requested in that sequence.

Focused software tests separately exercise two independent simulated devices,
reversed enumeration order, routing conflicts, manual assignment, swap,
disconnect suppression, hotplug races, stale operations, persistence failures,
effect replay and the shared MCP path. Their coverage does not establish every
physical operation.

The physical evidence covers the named read-only Windows session with one amp.
Two physical amplifiers, macOS USB, uploads, firmware programming, cross-tab
ownership arbitration and complete HFD feature parity remain unqualified.
MCP checks for this increment use the admitted application executor; they do not
establish a new HTTP or hosted-pairing acceptance run.
Bridge configuration must never be applied during testing with the connected
drivers.

Browser permission behavior follows the [WebHID standard](https://hid.spec.whatwg.org/)
and [Chrome's WebHID documentation](https://developer.chrome.com/docs/capabilities/hid).
