# Graph Q edits, shelf direction and FIR placement

## Ordinary crossover graph Q

HFD's magnitude-chart Q handler accepts second-order low-pass, high-pass and
shelving filters, plus Boost/Cut. Asymmetric and second-order All-pass filters
have editable numeric Q fields, but their graph gestures do not change Q.
An unsupported Ctrl-drag also does not fall back to a frequency/gain drag.

The selected object owns the chart wheel. A wheel event over empty chart space
does not select a different object based on the pointer's position. The native
handler reduces the wheel delta to its sign. With the recorded settings, one
event adds or subtracts 0.04; a delta of 360 does not request three steps.
The Q field uses bounds 0.1–20, three decimal places and Double storage.
These values are the recorded configuration, rather than a claim about every
possible edited HFD Settings file.

The graph handler inhibits the field notification once, then explicitly reads
the final Text and stores Q. Consequently it can publish the formatted value
even when Text did not change. This differs from the ordinary numeric field's
notification-driven publication. Shared Extended arithmetic retains that
distinction without changing the existing field wheel behavior.

Ctrl is captured at mouse-down. Each qualifying vertical move applies one signed
step to the current field, rather than multiplying the starting Q by a function
of pixel distance. Browser and Windows event delivery are separate; the recorded
single-transition test does not establish equivalence for every event stream.
Ordinary frequency/gain drag mapping is outside this Q-specific qualification.

Input EQ graph interaction remains a browser convenience. Its Q values use the
Input EQ field profile; this work does not qualify a native EQ-popup graph.

The existing `fusion_filter_adjust` command accepts `surface: "graph"` for
primary Q. Its default `surface: "field"` retains ordinary numeric-field
behavior for Q, Q2 and gain. A changed graph edit checks every destination's
graph capability before a single Undoable mutation. Fixed-source edits mirror
only a changed stored source value; an unchanged peer retains its own cached
coefficients, identity and bypass state. Each command starts from canonical
values rather than sharing a person's transient gesture state. The registry
still contains 91 commands, and these design edits perform no amplifier I/O.

## Saved native observations

Ten screenshot-driven native saves retain literal parameters, coefficients and
whole-XML comparisons. The Peak sequence is Q 1.15 → 1.19 after one +120 wheel
event, → 1.23 after one +360 event, → 1.27 after the recorded Ctrl-drag transition.
Frequency and gain remain 2300 Hz and 7.5 dB. Wheel events were delivered over
empty magnitude-chart space. Only the selected biquad's Q and derived cache
values changed in these steps.

All-pass 2 and Asymmetric each have a saved baseline and a subsequent save after
wheel plus Ctrl-drag tests. Each resulting Config.xml is byte-identical to its
corresponding baseline. This establishes those clean-cache examples; native
common regeneration may still run and arbitrary inconsistent imported caches
are not qualified by these observations.

The first wheel event's before-image was not retained; its hash is recorded.
Its preceding native baseline and resulting native XML are retained. The
remaining saved screenshots and action logs retain their own hashes. A requested
single cursor transition is not treated as a measured Windows message count.

The original input file stayed exact. HFD closed normally before the exclusive
metadata-only HID handle was released. That handle blocked observed normal
read/write opens with sharing error 32; it was not a physical USB disconnection,
kernel policy or USB-bus trace. Settings bytes outside the ten recent-project
texts stayed exact and the three ASIO names stayed empty. No amplifier setter
or bridge configuration was applied.

## Unknown shelf direction

The native function selector itself produced Shelf1 and Shelf2 with the valid
stored direction `stUnknown`; the direction control was left untouched. Both
displayed low-shelf responses, and their saved literals support the low-shelf
constructors. Import now maps these types to high shelf only for `stHighShelf`.
The original cached Double coefficients and direction literal remain retained
for passive reopen.

The retained enum also follows function changes. An untouched unknown direction
therefore changes its effective response when moving between a low shelf and
Asymmetric, matching the native constructors. Choosing an explicit direction
updates the stored enum. Explicitly contradictory kind and direction patches
are rejected before editing. Newly created filters without imported direction
metadata keep their existing authoring defaults.

Asymmetric uses a different native branch: only `stLowShelf` selects low, while
`stUnknown` selects high. Its mapping remains separate. The public native-data
fixtures reconstruct small containers from saved literals and hashes; they are
not complete copies of the original native project files.

## FIR transfer placement

Ordinary FIR, complete-project and native settings-copy operations share a
selected-placement planner. It chooses the input bank or three output banks
independently of the graph's Used flags. The document may retain an effective
bank on the other placement; analysis keeps that graph cascade intact.

Such a bank is not transferred. The interface shows an advisory before the
existing Upload action, and application commands return warnings scoped to
role, preset and placement. A transfer does not silently rewrite the document
to remove the other bank. The sidebar keeps a compact count, explanation and
role/preset scope visible; a disclosure retains the complete advisory list in
a bounded scroll area. The native activation packing retains inactive
Enabled bits and clears inactive Loaded bits.

Existing selected-bank capacity, short-cache, encoding, identity, protection,
backup, mute and readback rules remain in force. Shared selection does not make
every transfer policy identical: native settings-copy tiny-cache handling stays
separate from ordinary FIR uploads. Software and simulator checks do not qualify
physical FIR programming, two connected amplifiers, macOS USB or acoustic output.

## Verification scope

The final unfiltered development run passed 3,042 tests in 197 files and global
TypeScript checks with unchanged source. That total includes 2,934 canonical
tests in 194 files and 108 local diagnostic tests in three files. The first run
passed its tests and TypeScript checks but failed the release inventory check,
which had not listed those three discovered diagnostic files. The corrected
run retained them without test filters, omissions or timeout increases.

The final isolated Studio iteration recorded 36 accepted assertions and one
retained unaccepted assertion among 37 observed checks. The unaccepted check
followed an input setup refusal after the automation session restarted; the
design did not change. The subsequently delivered event passed. No results
from the interrupted batch were inferred. An earlier iteration separately
retains four accepted checks and the actual sidebar-overflow failure that led
to the compact disclosure correction.

Browser checks covered wheel and captured-Ctrl edits, whole-channel response
scope, independent mirrored caches and bypass, atomic pair refusal, a canonical
bound no-op, native direction through type changes and reload, graph-point
selection with the inspector visible at 1024×768, and Input EQ's separate graph
profile. The final synthetic projects matched their baselines, retained all
24 FIR banks and 54,000 taps, and had no blocked external-I/O attempts. These
checks used the rendered shared command console; authenticated remote MCP
transport remains unqualified. See [verification](VERIFICATION.md) for release
results and remaining qualification.
