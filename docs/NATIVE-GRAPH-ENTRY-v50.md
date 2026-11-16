# Channel graph entry and saved selection

Opening an output graph can change the editable HFD document. This behavior is
separate from reading a file or formatting a number. The browser implementation
uses one shared operation for explicit human and MCP graph navigation.

Each role keeps its own record of graphs opened during the current project
lifetime. The record includes the preset and channel identity. Replacing a
project clears that role's record synchronously, including replacement with the
same channel IDs. Ordinary edits, Save, Numeric remounting and Undo do not create
a fresh graph. The record is private application state, never caller-supplied
MCP arguments or serialized project data.

On a fresh graph entry, a nonzero stored AdditionalGain invokes the compensation
initialization callback. It sets the channel offset to 10 and the document's
gain-lowered hint to true. An independent channel also stores the Gain obtained
from the bounded passive Single presentation and the ordinary two-decimal Gain
callback. A linked channel retains its stored Gain: the native linked-source
guard suppresses that store, while still admitting the compensation and hint
updates. Zero AdditionalGain does not manufacture a visible compensation
callback.

The selected channel's microphone-application flag is cleared only when the
project explicitly records `hfdCalibration.loaded: false`. A referenced file
whose browser resource is unavailable, or a legacy project without calibration
metadata, does not establish this condition. The operation preserves filter
parameters, coefficients, provenance, cache interpretation and other channels.
It performs no amplifier I/O.

The entry changes and existing graph-flag writeback are validated before one
document edit. A successful canonical no-op records the visit without adding
history. A refusal does not record it. Undo restores the prior document without
reapplying initialization; Redo restores the accepted result. Existing import
or replacement history is separate: an explicit replacement that opens a
visible graph can have its replacement transaction followed by one combined
initialization transaction.

Opening a non-EQ filter palette first admits and visibly opens its source graph,
before the filter draft is staged. Every captured target and the draft are
validated before this entry. Any initialization has its own prior Undo boundary;
Apply remains one filter edit, and one Undo restores the complete pre-Apply
projects. Returning from Apply is an internal selection, not another graph
initialization or explicit native channel-navigation action. Both-role filter
editing still initializes only the visible source graph and retains each role's
own bypass state and caches.

Mirror L/R edits does not construct or initialize the other role's graph.
Selecting a channel while Help, Device settings, Input EQ or the signal chain
is shown does not initialize a hidden crossover graph. Opening that graph is
the explicit entry action. Status reads, parsing, hydration and rendering remain
passive.

## Saved native selection

`Project.hfdSelectedGroupId` preserves the native `selectedgroupid` signed32
integer independently of processing. New projects use the native automatic-open
sentinel `-1`. Unsupported integer IDs are retained as metadata; they are not
mapped to an arbitrary browser channel. Importing XML without this element
leaves the typed field absent. Legacy JSON without the typed field retains its
source XML value on export.

Qualified explicit channel navigation writes the selected group, 1 through 3.
Automatic graph construction after replacement retains the file's value,
including `-1`. The browser's existing import selection remains in effect:
automatic retargeting from the native file's saved preset and positive group is
still a separate File Open gap. This increment does not claim complete native
File Open navigation parity.

## Native evidence and limits

Classic screenshot and physical-input checks used HFD 5.2.4.24 with the connected
interface excluded through the reviewed metadata-only ownership handle. The
handle was released only after HFD closed. This is not a physical USB
disconnection or a bus trace. No amplifier command, upload, audio, firmware or
bridge-configuration action was performed.

The independent-channel check retained Gain24/Add10 before visiting channel2.
Opening that graph and saving changed Gain to14, cleared unavailable microphone
application and recorded group2. The other eight Gains and all 135 biquad/cache
records stayed exact. Returning to already visible, already normalized graphs
saved identically; that does not establish genuine Hide/Show behavior.

The linked-channel input did **not** retain cached Gain24 until its first view.
Native load/refresh had already changed it to source Gain0 and copied the source
Peak into the target section. That original comparison was stopped. A separate
view check started from the actual saved Gain0/Add6 state. First entry retained
Gain0, changed Add6 to10, cleared microphone application and recorded group2;
all 135 biquad/cache records were unchanged during this separate step. The early
microphone flag change did not match the source channel and remains unisolated.
These observations do not qualify a linked Gain24 cap, arbitrary reuse, an
instrumented callback count, global passive-import normalization or every native
linked-refresh side effect.

The linked checkbox was observed as visible and checked, but its Enabled
property and manual linked-channel toggling were not tested. First-entry
callback admission does not establish that every manual linked control is
editable.

The earlier completed browser round used released V48 source: 12 UI assertions,
52 actual local MCP requests and 20 paired assertions with synthetic projects.
It established direct gain/compensation editing, independent caps and origins,
graph dragging, foreign-edit cancellation, exact Undo and normal persistence.
Those dated results are not acceptance of this new graph-entry implementation.
Current source and browser validation are recorded separately in
[verification](VERIFICATION.md). Two physical amplifiers, macOS, acoustics,
download delivery and production firmware programming remain separate work.
