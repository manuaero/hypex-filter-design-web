# Firmware files and reported runtime identity

Firmware file recognition, reported runtime metadata and permission to control
an amplifier are separate checks. This workflow reads identity/version metadata;
it does not update firmware or verify an installed image.

Ordinary controls remain restricted to the existing FA503 / DSP3-213 core 5.1
profile and each operation's own checks. An exact reported 5.82/core 5.5 profile
can be inspected read-only without becoming a normal controls session.
Production firmware programming, bootloader transition, reconnect, preservation
and recovery are still unimplemented/unqualified. Research involving
5.83/core 5.6 does not add support for that runtime.

## Recognize a staged file

The Firmware panel inspects a native HEX file offline and hashes its exact
content. Filename, header words and version-looking text do not establish a
known profile. The current registry recognizes these complete SHA-256 values:

| Bundle version | Core version | Family   | Exact source-file SHA-256                                          |
| -------------- | ------------ | -------- | ------------------------------------------------------------------ |
| 5.7            | 5.1          | FUSION32 | `00cbaf3fb38e731959fef26eb7b844c2f79987442397e9ce194a0d2b302f00a5` |
| 5.82           | 5.5          | FUSION32 | `8cba0150c33acc338a7581ba89069b174f8786a6d97c68269dc4a540b9c47f61` |

The first is the official FusionAmp 5.7 source file; the second is the 5.82
source file supplied with HFD 5.2.4.24. These are source-file fingerprints, not
hashes read from an amplifier. The public repository distributes neither file.
Whitespace or line-ending changes can change a file hash while leaving decoded
records equivalent; such a file remains an unknown exact-content profile.

A known staged-file match does not prove that the amplifier runs those bytes,
that its bootloader belongs to the file's family, or that programming is
available. An unknown content hash is shown explicitly. Programming stays
unavailable in either case.

## Read the selected runtime

In **Device settings → Firmware**, use **Read runtime identity** for the selected
Left or Right role. It requires the current workspace context and a captured
live or remembered device interface. No runtime read starts merely because the
panel mounted, the selected role changed or a file was staged.

The report shows the actual reported serial, product, firmware/core, DSP name,
hardware fields, recognized report profile, source and timestamp. Core 5.5 is
marked as unavailable for ordinary controls. A stale or failed result is labeled;
an earlier cached report is not silently presented as fresh.

**Clear runtime report** clears cached metadata and invalidates a pending result.
It does not clear the staged file, erase firmware or grant device access. Any
in-flight interface cleanup still belongs to the operation that opened it.

The normal **Connect** action may first show the browser's device chooser.
If that selected amplifier reports the recognized 5.82/core 5.5 profile, normal
Session admission refuses it. Studio then performs the narrow read-only
diagnostic on that same owned interface, closes it and leaves the role
**Offline** for normal controls. A later explicit Read can temporarily reopen
the exact remembered interface; it does not search for another amplifier.

## Read and ownership contract

One runtime inspection performs this sequence twice:

| Request                                             | Read                                                        |
| --------------------------------------------------- | ----------------------------------------------------------- |
| `06/01`                                             | Reported product, core, firmware and configuration metadata |
| `66/00`                                             | Amplifier/module and related hardware metadata              |
| `03/08`                                             | DSP filename/name                                           |
| `65`, length 32, address `0x100`, EEPROM selector 0 | EEPROM serial                                               |

That is eight literal read requests. The unsupported normal-Connect path adds
its initial ordinary `06/01` admission check before those eight reads. Known
metadata fields must match across both passes; unspecified native reply padding
is not treated as identity. This is a consistency check, not an atomic hardware
snapshot. Unknown report tuples fail closed.

The source provider captures the exact HID object, role, serial when known,
session and binding generation. It does not call a chooser, enumerate devices,
search by VID/PID or infer identity from a serial prefix. A live/connecting
interface uses its owning Session queue. A remembered interface is opened only
when ownership is clear and is closed with its listeners on completion or
failure. An ambiguous already-open or reassigned interface is refused.

Both reads require distinct captured serials and preserve independent roles.
New paired reports publish together only after every read and final binding
check succeeds. Failure publishes no newly collected pair; previous reports may
remain with explicit stale/error context. It does not turn a replacement device
into the original target.

No settings, mute, volume, power, flash, credential or bootloader setter is part
of this reader. Runtime reports establish neither the installed-image SHA-256
nor descriptor/bootloader family proof. Those gaps remain separate from
recognizing a local file.

## MCP

The existing `fusion_device_read` namespace shares the same controller/cache:

```json
{ "target": "both", "firmware": { "action": "runtime-status" } }
```

```json
{ "target": "both", "firmware": { "action": "runtime-read" } }
```

```json
{ "target": "both", "firmware": { "action": "runtime-clear" } }
```

Targets are `left`, `right` or `both`. Status and Clear perform no device I/O.
Read uses only captured sources and updates the same human report; it cannot
request a new grant through tool arguments. Trusted workspace admission and
source/role/owner fences apply. The optional developer console uses this same
validated executor; normal human use has adjacent Read/Clear buttons.

Source files are `domain/firmware-profile.ts`,
`hardware/firmware-runtime-inspector.ts`, `application/firmware-runtime-source.ts`
and `application/firmware-runtime.ts`. Automated and isolated synthetic-browser
checks do not establish physical update or two-amplifier acceptance. See
[verification](VERIFICATION.md) and the [USB boundaries](USB_PROTOCOL.md).

## Current acceptance

The development source checkpoint passed 2,450 tests in 178 files and typecheck.
The fresh public checkout passed 2,449 tests with one optional-PDF skip across
178 files, typecheck and production build; see [verification](VERIFICATION.md).
Actual Studio
browser checks used synthetic HID devices to exercise diagnostic-only core 5.5
and mixed core 5.1/5.5 role ownership, read counts and interface cleanup through
the real application path.

One physical 5.7/core 5.1 FA503 completed the read through a live Session and
then through its exact remembered interface. Both application roles were
disconnected afterward, with no amplifier setter or audio operation. Both full
projects and the selection matched their initial state; document revision stayed
28, connection slots were empty before/after, and persistence was Ready with no
unsaved changes. No second physical amplifier or physical core 5.5 runtime was
available for this check.

The browser firmware picker was blocked by an extension file-URL permission and
created no stage. Browser staging through that picker and download delivery
remain unverified. Native offline HFD comparison awaits verified USB absence;
the production firmware writer remains unimplemented.
