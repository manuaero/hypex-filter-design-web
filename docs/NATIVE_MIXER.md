# Native digital User mixer

The digital mixer is conditional in HFD. A commercial FA503 does not expose
editable User mixer weights. The browser follows that eligibility rule and
does not offer a manufacturing Enable mixer setter.

An eligible configured OEM StereoDSP device has three preset matrices. Each
contains Digital Left and Digital Right contributions for CH1, CH2 and CH3.
Values range from -1 to 1; negative values invert that contribution and zero
is allowed. The two contributions are not normalized to a sum of one.

## Edit and save

In Device settings, choose the preset and the explicit Left, Right or
Left + Right Save target. Eligible targets are read automatically on entry.
Each amplifier keeps its own draft. Both uses those independent drafts.

The editor displays current and planned quantized values. Opening a row applies
native two-decimal formatting, so a stored value may produce a planned change
before typing. Other preset rows retain exact captured words. Cancel restores
the captured row and closes it; Edit mixer explicitly reopens it. Other preset
drafts are retained. Numeric edits stage a draft; **Save mixer** performs fresh
review and explicit save of only the selected preset row. A shared MCP review
remains visible in this panel. The developer console is optional.

Native values use signed Q8 words. Edited values pass through Single/Q24
conversion before their upper 16 bits are transmitted. The planned value can
differ from the displayed decimal: +0.10 becomes 25/256, while -0.10 becomes
-26/256.

Committed native text changes are parsed, clamped and reformatted to two
decimal places. Browser numeric edits perform that normalization on Enter or
blur through the shared controller: typed 0.105 becomes 0.11 before the
Single/Q24 conversion. Editing one cell does not repeatedly round other cells.

## Eligibility and outcomes

The native group requires the device's SystemSetup flag and supported
product/module metadata. The weight editor additionally requires configured
OEM module 1, core 1.50 or later and the actual StereoDSP flag. Live sessions
remain restricted to the supported three-preset/three-output FA503 core 5.1
profile; the visibility predicate does not add other hardware families.

Commercial module 9 offers Left + Right, Right and Left in the digital selector.
User mixer and Disabled require editor eligibility. An unsupported current
value stays visibly unavailable. The Digital channel selector is hidden when
its native group is absent; the mixer panel retains a read-only reason. Permissions
are independently checked using settings entry and DigitalLeftRight access.

Before any write, all changed-target before-images must pass durable storage
write/readback, followed by a common fresh identity/permission/matrix barrier.
Each changed device receives one matrix-write attempt and an independent
readback. Unchanged roles are skipped. A partial or unconfirmed outcome retains
its per-role ledger without automatic retry or rollback.

Saved mixer records exposes bounded local history and **Download record**.
Records contain original reports, desired bytes and outcome evidence; keep them
private. They support inspection, not automatic restore. Replaying a consumed
Save returns its ledger without another device write.

Mixer Save adds no common-settings, mute, DSP power, bridge, limiter, Defaults,
credential, firmware or manufacturing write. Physical OEM mixer writes and
two-amplifier operation remain unqualified. Browser download completion is a
separate check from the record/export workflow.

## MCP

`fusion_native_mixer` provides status, refresh-history, load, open, edit, cancel,
review, save, discard-review and export-record. Roles are explicit; presets and
channels are one-based. Open/edit/review require an exact controller revision.
Save requires a one-use review ID and `confirm: true`. Record export uses
checked file-transfer chunks. Raw packets and manufacturing flags are refused.

See [MCP setup](MCP.md) and [verification limits](VERIFICATION.md).
