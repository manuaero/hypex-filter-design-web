# Firmware workflow and qualification

Firmware files, review, execution status and recovery history share one workflow
between the browser interface and MCP. Left and Right retain independent staged
files and fixed target identities. The production USB adapter is implemented
behind a source-owned qualification registry. That registry is empty: physical
firmware programming remains unavailable.

## Files and review

Inspection retains the original file bytes as Text and its SHA-256 privately for
the page lifetime, within a 4 MiB execution budget per role. Larger valid files
remain inspectable without becoming executable. The filename and container
header words do not establish a firmware version. Only an exact recognized
content profile supplies an expected version; this does not identify the
firmware currently running on an amplifier.

A normal update review requires every intended role's exact current stage ID.
Changing a file, clearing it or explicitly reassigning an amplifier invalidates
the affected operation context. Expected USB disappearance during an admitted
firmware transition retains the operation's captured assignment and source.

Review is explicit. Program requires confirmation for that exact shared review
ID, so an agent replacing a review cannot inherit a person's earlier checkbox
approval. Both targets are prepared before a coordinated operation begins;
neither a current UI selection nor linked editing silently changes the target.

## USB transition and stream

Native runtime command `40/00` is distinct from bootloader stream traffic even
though both use command byte `0x40`. The known runtime code can return stale TX
data while resetting. The dedicated entry path retires the ordinary transport,
sends the fixed 64-byte frame once and bounds host send settlement to 5 seconds.
Its `sent` result means host settlement, not a target acknowledgement or proof
that a bootloader appeared. Rejection or timeout is unconfirmed; a late host
promise cannot revive the old connection or trigger a retry.

Stream sends use the physical interface's own queue and a final synchronous
assignment/epoch fence immediately before sending. An asynchronous or rejected
fence authorizes no send. Local request IDs and connection epochs are routing
metadata; they do not create target-echoed sequence numbers. Actual delayed or
duplicate command-40 reply behavior still requires independent qualification.

The native record stream preserves its two passes and only attempts command
`0x43` after both pass checkpoints succeed. No automatic `0x41`, reentry,
rollback or settings replay is added. Reference simulations have their own
capabilities and result qualifier; they cannot grant a physical channel or
promote a reference recovery journal into a physical update.

## Preservation and recovery

The adapter captures 43 known images: four native reports, 24 external-flash
sectors and 15 safe EEPROM ranges. Original bytes remain evidence. Qualified
report masks distinguish stable fields from changing telemetry or padding;
identity, permissions and known memory ranges are checked separately. A new
runtime needs its own complete readback and permission profile. A core 5.5
metadata report cannot borrow the ordinary core 5.1 controls or preservation
reader.

Matching these known ranges is not a full original-program backup or proof of
all calibration and output-state effects. Those limits remain explicit in
recovery records. Loader VID/PID, a B-prefixed descriptor, major 99 or a single
visible candidate do not establish the same physical amplifier.

Recovery uses the journal's original source and before-images. It can target
only the affected role of a partial Both operation, without reentering the
other amplifier. A durable write intent with no persisted send flag remains
ambiguous after a crash; it is not evidence that the request was never sent.
Unresolved mutating intents require explicit recovery.

After a page reload, an eligible recovery may restore the historical expected
assignment metadata into an unassigned role. This does not select, open or
identify a USB interface. It cannot replace an active assignment, and the
qualified loader correlator must still establish the exact unit. Original
journal bindings remain unchanged.

## MCP

Firmware operations extend the existing `fusion_device_read` command; the
registry remains at 91 commands. Normal file inspection and parameter editing
need no developer console. A client can inspect the shared update state with:

```json
{
  "name": "fusion_device_read",
  "arguments": {
    "target": "both",
    "firmware": { "action": "update-status" }
  }
}
```

Review, confirmed apply, discard, history, bounded record export and recovery
use the same owner-admitted controller as the visible interface. Tool arguments
cannot supply a USB transport, permission grant, physical profile, target
identity or arbitrary expected version. File-stage inspection metadata remains
separate from execution admission.

## Remaining qualification

An enabled physical profile still requires evidence for same-unit runtime and
loader association, unsequenced reply delivery, fresh permission checks,
complete before/after readback, safe output and reset behavior, interruption and
recovery. No firmware transition, programming, bridge configuration or actual
amplifier command is qualified by software doubles. Two physical amplifiers,
macOS USB and acoustic behavior remain open. See
[verification](VERIFICATION.md) for checkpoint results.

## Software verification

The complete private run passed 3,121 tests in 200 files: 3,013 canonical
tests and 108 retained local diagnostic cases. Nonincremental TypeScript
checking also passed. The new work adds 79 canonical cases covering transport
retirement, production-adapter boundaries, shared review ownership and
recovery. These are software tests using doubles; they do not qualify USB
programming on an amplifier.

An isolated browser loaded the actual workspace with two independent synthetic
projects and ready persistence. Local MCP pairing was interrupted by a browser
password-extension prompt. Paired browser-to-MCP execution is therefore not
verified by this checkpoint. No amplifier commands were sent in this work.
