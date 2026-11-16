# Channel delay

The Delay and Global delay fields share their authoring operation with
`fusion_channel_set`. Typing keeps a local draft until Enter or blur. The wheel
uses one signed event, regardless of the number of wheel detents reported by the
browser. Browser arrow buttons use the same Text callback, but their recurrence
is a browser convenience rather than a verified native key mapping.

## Numeric behavior

HFD's microsecond field bounds and formats Text, rounds to DSP samples, and
formats the result again to integer microseconds. At 93750 Hz, entered `1`
becomes `0`, `6` becomes `11`, and `16` becomes `21`. Passive presentation uses
the native Single display path; reading an imported project does not normalize
its stored Double values.

Local delay bounds come from the current runtime, independently of a saved
local `MaxDelay`. A fresh offline FA503 designer has a 19200 µs limit. A current
connected core with VersionNr greater than 1, or VersionNr 1 and BuildNr at least
50, has a 32000 µs limit. These fields are the two components of the identified
DSP core version, not the firmware bundle version or XML `buildnr`. Changing
connections invalidates a field gesture even when both sessions select equal
bounds.

Global delay uses that channel's saved `MaxDelay`. A browser-created design
uses the native factory duration of 7000 samples. An imported legacy snapshot
with missing global-limit metadata must be reopened from its original HFD
project before editing delays; the app does not guess its bound. Native XML
import/export retains both local and global maxima independently of the values.

The callback does not apply an extra clamp after sample rounding. For example,
the native saved global limit `74666.6666666667` can produce canonical `74667`.
The stored maximum remains separate. Re-entering literal `0` at an existing
value of `0` can still update the local saved limit from `19` to `19200`.
Passive focus and blur without input do not perform this callback.

## Linked channels and stereo roles

A notified local-delay callback writes the source Delay and maximum, then
copies processing to each immediate linked follower. This can also replace the
follower's gain, inversion and mute. It preserves the follower's additional
gain, labels, identities and measurements. It copies both delay maxima and
uses the native raw-cache interpretation rules; an unresolved source does not
gain upload permission through the copy. A chain is not flattened to its root.

After the copy, the current Global field Text is read directly and broadcast
to all three channels of that preset. It is not sample-quantized again. A
Global-delay callback normalizes the selected Global field and broadcasts its
result without copying linked-channel processing. Other presets retain their
values and metadata.

Left and Right remain independent documents. A typed linked edit sends the
original Text through each role's own profile, using each role's own current
Global Text. A wheel with `basis: each` evaluates a fresh field event separately
for each role. A fixed source basis mirrors a changed canonical value through
the destination profile. If the source value remains equal, the destination
stays unchanged while any source notification still performs its metadata,
follower-copy and Global effects. This stereo policy is a browser feature.

Every selected role and complete final proposal is validated before the
workspace publishes an edit. All resulting changes form one Undo step. An
invalid second role leaves both originals intact. Delay edits make no amplifier
calls; applying a design still requires the explicit upload workflow.

## MCP

Use one delay intent per call:

```json
{ "target": "both", "preset": 1, "channel": 1, "patch": { "delayUs": "16" } }
```

```json
{
  "target": "both",
  "preset": 1,
  "channel": 1,
  "patch": { "delayWheel": { "parameter": "local", "direction": "up", "basis": "each" } }
}
```

`globalDelayUs` and wheel `parameter: global` select Global delay. Results report
each role's normalized Text, canonical value and callback maximum. Wheel
results also distinguish notification from a canonical change. Runtime
identity, bounds, sample rate, Global field Text and opaque continuous wheel
state are internal context, not accepted command arguments. Mixed delay/scalar
patches are refused so callback ordering is explicit.

## Evidence and limits

Thirteen actual offline HFD Saves establish the named numeric, maximum, same-Text
and immediate linked-copy cases. The last four Saves distinguish load/save
effects from explicit delay input. The linked case retained a conflicting
follower at baseline, then changed its gain, inversion, mute, local delay and
maximum after the source edit without visiting the follower graph. All 135
biquad/direct/root-cache records were exact across that edit.

HFD was restored to a preserved project without saving, closed normally, and
the metadata-only exclusive HID handle was released. Original project and
restore bytes remained exact. Settings outside recent projects were exact and
ASIO selections stayed empty. This is native GUI/file evidence, not a USB bus
trace or physical upload test. General-format/getter precision vectors and
connected-runtime bound selection have separate native source evidence.

Broader native File Open delay normalization and alternate selectable delay
units remain unqualified. This change does not establish complete HFD parity,
physical two-amplifier acceptance, macOS USB behavior or new amplifier state.
