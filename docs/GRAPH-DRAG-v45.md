# Ordinary crossover graph dragging

Ordinary Magnitude marker dragging now shares a position planner between the
visible editor and `fusion_filter_adjust`. Graph Q gestures retain their own
profile. Input EQ and typed numeric controls keep their separate contracts.

## Position and publication

The graph rounds Single pointer coordinates to native nearest/even integer
pixels, projects them through the displayed axes and clamps both axes to the
visible range. Frequency follows the absolute cursor position, including an
off-center grab, and is stored as Single. It does not use a frequency ratio
from the grab point or the typed field's one-decimal conversion.

Peak and first/second-order shelf gain use the captured filter's Double gain
plus the cumulative vertical axis change. The native path subtracts the two
Double axis values in Extended precision, narrows that delta to Single, then
adds it to the original Double gain in Extended precision. The bounded numeric
setter formats two decimal places; the explicit getter publishes a Double.
The supported FA profile is −125 to +24 dB. This graph path does not apply the
numeric wheel's AdditionalGain ceiling.

An exact zero narrowed vertical delta leaves gain untouched. Other manual
filter kinds retain their inactive gain, and asymmetric sections retain their
secondary frequency and Q. Imported values are changed only by an admitted
edit; the planner does not normalize a project on import.

## Two independent amplifiers

Linked editing applies one absolute frequency to the selected roles and the
same vertical movement to each role's own captured gain. For example, a +1 dB
movement from Left +3 / Right −2 gives Left +4 / Right −1. Each destination is
validated before a single transaction. Unchanged destinations retain their
coefficient cache, provenance and bypass state.

Continuous moves retain their original per-role gain even after both roles
reach a limit, so moving back can restore their distinct values. Selection,
filter identity, kind, links and accepted document revision fence the operation.
An unrelated accepted edit commits the pending drag before creating its own
history entry; cancelling the stale drag cannot restore over that later edit.
One ordinary drag remains one Undo operation.

## MCP

The existing tool has a strict `graph-drag` surface; the registry remains at
91 commands. Each command is a new stateless position event, with the current
filters as its origins. It does not continue a human's pointer gesture.

```json
{
  "name": "fusion_filter_adjust",
  "arguments": {
    "target": "both",
    "surface": "graph-drag",
    "frequency": 2300,
    "originAxisY": 0,
    "axisY": 1
  }
}
```

Frequency is an already-projected point in the supported plot-axis range
0.001–50,000 Hz. Parameter, direction and basis fields belong to other surfaces
and are rejected here. Structural, stability and upload guards remain separate.
Normal graph editing requires no command console or submission button.

## Native verification scope

Classic screenshot-driven HFD 5.2.4.24 checks used a separate owned project
while its main window showed disconnected. Completed native File saves retain
the entire XML for comparison:

| Case                                           | Observed native result                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Interior diagonal drag                         | 2300 Hz / +7.5 dB became **6319.00537109375 Hz / +10.55 dB**; Q stayed 1.15.                   |
| Off-center grab, no horizontal movement        | Frequency snapped to **6514.17333984375 Hz**, with gain **+12.84 dB**.                         |
| Upper gain limit after vertical background pan | Gain stored **24**; frequency stored **7978.66162109375 Hz**.                                  |
| Horizontal-only drag                           | Gain remained **24**; only primary frequency and its own generated coefficient values changed. |

Two earlier upper-limit input requests produced no visible change. They remain
unaccepted observations; one completed native Save also proved no XML change.
A requested OS mouse move is not proof of a delivered native callback count.
The accepted upper-limit case followed visible channel selection and an interior
endpoint; no particular cause of the earlier failures is inferred.

Source-predicted precision boundaries are tested separately from these native
Saves. These checks do not establish every filter family's UI lifecycle, all
custom preference profiles, physical filter programming, two physical units,
macOS USB or acoustic behavior. No amplifier command or bridge configuration
was applied in these offline checks.

The native exclusion used a metadata-only exclusive handle and observed normal
read/write-open sharing failure. It is not physical USB disconnection or bus
tracing. HFD closed normally before the handle was released. The initial
settings snapshots were installer-template files. The actual user settings were
captured after the checks, with empty ASIO device/input/output values; a fresh
runtime-settings before/after preservation claim is not made.
