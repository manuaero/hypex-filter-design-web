# USB protocol overview

The current live-session implementation targets Hypex FA503 / DSP3-213 core 5.1. Protocol structures and native behavior were established through static inspection, numerical fixtures, simulated transactions and limited physical checks. That evidence is not a blanket guarantee for another product or firmware family.

This overview documents implementation boundaries. It is not a recipe for sending arbitrary packets to a connected speaker system. Use validated application workflows.

## Transport and identity

Normal traffic uses WebHID report ID 0 with a 64-byte payload. Payload byte 0 is the command; it is not the separate HID report-ID prefix. Read-only identification checks the configuration/product/core data, amplifier configuration and stable device identity before a role is admitted.

The transport serializes requests and checks command, payload length and report ID. A timeout, disconnect or unexpected response faults the interface. It does not blindly retry a setter or allow a late reply to satisfy the next command.

Left and Right have independent sessions. The same physical identity must not be assigned twice. EEPROM serial, USB descriptor serial, product name and DSP filename are distinct values. A product label or EEPROM serial alone is not firmware-family proof; ordinary WebHID does not expose every descriptor field required by a firmware/reconnect adapter.

## Record families

| Record/command family  | Current use                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `03`                   | DSP design filename/name data.                                                                                             |
| `05`                   | Runtime and writable control/settings record; status telemetry and one-shot write triggers have different ownership.       |
| `06`                   | Product/core/firmware/capability information.                                                                              |
| `66`                   | Amplifier/configuration/limiter record, with reserved and manufacturing fields preserved.                                  |
| `67`                   | Native per-preset digital mixer values; conditional OEM editor with reviewed single-attempt Save and independent readback. |
| Memory/page operations | Bounded backup, IIR/EQ/FIR images, programming and verification through explicitly allowed ranges.                         |

Codecs preserve unowned fields instead of rebuilding a record from UI defaults. Unknown stored enum values remain visible and are not automatically normalized on mount.

### Important shared values

The common input-source IDs are 0 Auto, 1 XLR, 2 RCA, 3 Sub, 4 S/PDIF, 5 AES, 6 Optical and 7 Future. Availability is model/mode dependent. Future is a native selection whose actual firmware behavior remains unqualified.

In the normal FA503 status payload, byte 51 bit 0 is signal detected, bit 1 is password protected and bit 2 is password matched. Signal alone must not be interpreted as password protection. OEM permissions combine native runtime policy, settings-entry gates and item permissions; a saved template flag never authorizes a live device write.

Master/Slave modes have native dependent-field effects. Slave mode clears wake-on-line, signal detection and fixed startup volume and selects Standby. Master mode clears the three preset source/volume locks. The mode review includes those consequences and rebases unrelated fresh runtime, source, LED and security fields.

## DSP representations

The supported processing design rate is 93,750 Hz. Output paths contain fifteen biquads, with separate metadata and stored coefficient provenance. Native saved caches can represent different calculation stages; imports retain that distinction rather than blindly applying channel gain twice.

Input EQ has three independent nine-band banks. Captured physical EQ is separate from staged design EQ. FIR placement/capacity and enable flags are also separate from whether a tap cache is loaded. Native folders preserve original measurement samples and resources alongside XML; browser-only processing state uses a validated sidecar.

## Conditional native mixer

The User mixer editor requires configured OEM module 1, supported core metadata
and the actual enabled StereoDSP flag, with native group reachability and
settings-entry/DigitalLeftRight permissions checked separately. It is not an
editable feature of commercial FA503 module 9. Manufacturing Enable mixer is
read-only in the browser. Advanced routing admission rechecks actual capability.

Three presets each hold six signed little-endian Q8 weights. Only an explicitly
opened row receives native two-decimal Text formatting; inactive rows retain
exact words. Edited values use Single-to-Q24 conversion followed by the upper
16 bits, rather than direct Q8 rounding. Review fixes each target's own draft.
All required originals are durably verified before any setter and a fresh
common barrier precedes wire admission. One 67/01 attempt is followed by a
separate 67/00 readback. Verification covers the matrix data while allowing the
native variable selector/padding behavior. No mute, common-settings, bridge,
power or manufacturing write is added. Physical OEM writer acceptance remains
unqualified. See [the native mixer workflow](NATIVE_MIXER.md).

## Connected Native Save

For commercial FA503 module 9 / DSP3-213 core 5.1, the read-only Save path compares two metadata snapshots, selected-placement FIR filename fields and exactly three 256-byte physical EQ pages. A final metadata pass follows the repeated EQ/name reads. Relevant identity/settings changes or a failed required read reject the capture. A protected source can be read without granting permission for any write.

This path reads the data needed for serialized device information; it does not turn IIR/FIR flash into editable designs or capture an original firmware image. Non-wire host values are marked as explicit fresh-host defaults. They do not claim continuity with retained state in another running application.

Save staging sends nothing. Initial connected resolution sends only validated reads, with no amplifier setter, backup write or workspace metadata update. A paired request returns all detached results together or no artifact. Successful cached resolution and durable folder-request replay send no further reads. A missing/replaced target never silently becomes an offline save; that alternative requires an explicit Design only choice.

JSON and native files share the captured artifact, including a sidecar rebound to the emitted physical metadata. Staged EQ remains independent, ordinary offline exporters retain their prior contract, and existing prepared filesystem overwrites are never armed to a later selection or refreshed capture.

One actual FA503 on firmware 5.7/core 5.1 completed the read-only Save UI and MCP capture/export path, including three physical nine-band EQ banks and hash-verified JSON delivery. DSP was On, bridge was Off and no errors or warnings were reported. The amplifier was disconnected after the reads, without settings, power, filter, bridge, firmware, audio or credential setters. This does not establish independent HFD GUI equivalence, browser download completion or physical paired capture.

## Operation safety and recovery

Each workflow defines its owned fields, permissions, before-images, order and verification. Read-only preflight is distinct from an actual wire attempt. Paired operations check intended targets before writes and retain an independent role ledger when an operation becomes partial.

Backups preserve exact bytes and hashes; they are not permission grants. Some operations intentionally mute, while a reviewed mode change does not add an unrequested mute or DSP restart. Failure handling must follow that operation’s contract, without generic rollback, failure-mute or retry behavior.

Connected drivers make bridge, limiter, defaults, restore, Device templates and power operations consequential. Those recent workflows have simulation coverage; they were not qualified by applying bridge/configuration changes to the connected speaker drivers.

## Firmware boundary

The narrow runtime reader accepts exact known reported FA503 5.7/core 5.1 and
5.82/core 5.5 profiles. It sends only `06/01`, `66/00`, `03/08` and a 32-byte
EEPROM serial read at `0x100`, twice. Captured object/session queues and final
role/identity fences govern the read; a remembered interface is temporarily
owned and closed, without a chooser or device enumeration. Two matched
projections are not an atomic hardware snapshot.

Ordinary core 5.5 controls remain blocked even after a diagnostic report. Exact
local-file SHA profiles do not establish the installed image hash or
descriptor/bootloader family. Research on 5.83/core 5.6 does not expand support.
See [firmware files and runtime identity](FIRMWARE_RUNTIME.md) for explicit human
Read/Clear and the shared MCP namespace.

Firmware files can be inspected and staged per role. The source includes a bounded reference program engine and strict recovery journal for simulation. A journal records exact source content, known before-images, unknown preservation gaps, actual attempts and reconnect results.

Physical firmware programming remains disabled until a qualified adapter proves bootloader identity/correlation, descriptor family, preservation, timeout behavior and recovery. A complete reconstructed packet plan or a successful simulated two-pass stream does not establish that adapter. No vendor firmware bundle or original firmware image is distributed here.

## Authentication boundary

Password/email operations use explicit encodings, fresh permission/identity checks and secret-free default status. Manual support-code recovery separates reviewed challenge installation from submission of a vendor-supplied code. It does not derive codes locally or automatically contact vendor infrastructure. Physical recovery and automatic request transport remain unqualified.

See [verification](VERIFICATION.md) for evidence categories and [security](../SECURITY.md) before sharing logs or recovery exports.
