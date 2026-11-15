# Input EQ fields and native cache lifecycle

The input EQ editor has its own numeric profile. It is distinct from output
crossover parameters and from the wider data ranges accepted by imports and
the device codec.

| Field     | Explicit edit bounds | Display/commit precision | Storage | Wheel                                       |
| --------- | -------------------- | ------------------------ | ------- | ------------------------------------------- |
| Frequency | 10–50,000 Hz         | One decimal              | Double  | Directional decades: 1, 10, 100 or 1,000 Hz |
| Q         | 0.1–20               | Three decimals           | Double  | 0.04                                        |
| Gain      | −15.9–15.9 dB        | Two decimals             | Double  | 0.1 dB                                      |

The recovered HFD 5.2.4.24 FormShow installs these fixed limits and steps.
Typed values use the shared Extended decimal parser and native fixed-format
rounding before Double storage. Frequency is not narrowed to the output-BQ
Single format. Exact frequency/Q zero keeps the old internal field value before
formatting and reparse; extra imported precision can therefore round. Gain zero
is accepted. EQ gain has no output-channel AdditionalGain ceiling.

Typing commits on Enter or blur. Invalid/unfinished text and Escape leave the
design intact. Inspector and palette wheels share the same profile; palette
changes remain local until Apply. Shape changes preserve each role's own band
Enabled unless explicitly changed. Whole-EQ activation stays separate.
Bypass and no-op edits retain original coefficient caches; an explicit Reset
redesign clears them, even when gain is already zero.

`fusion_eq_set` uses that profile independently for each selected role. Its
optional `redesign:true` requests explicit cache regeneration for Reset;
otherwise unchanged/bypass edits preserve caches. `fusion_eq_adjust` applies
one stateless signed wheel event to a one-based preset/band index. `basis:each`
advances independent values; `basis:left` or `basis:right` mirrors a changed
source value. A source no-op never mirrors. All destination banks validate
before a single Undoable transaction. Neither command sends amplifier reports.

Native EQ band selection can normalize canonical values when changing the
field's rendered Text invokes its callback. That passive-selection lifecycle
and the actual native Default EQ popup remain open for GUI qualification.
Browser mounting/import/selection continues to preserve untouched values;
the explicit-edit checks here do not establish complete native popup parity.
Generic keyboard-arrow increments and native per-keystroke timing are separate
from the recovered signed-wheel and committed-Text behavior.

## Native channel-cache observations

Five screenshot-driven offline HFD saves cover fresh Open, an unselected graph,
channel gain −6 dB, inversion and selecting the first Peak. The same cached
coefficients and root metadata survived every step. Gain and invert changed only
their own channel metadata. Selecting the Peak displayed its untrimmed section
response while channel gain stayed −6 dB and inversion stayed enabled. Save As
cleared selection and returned the graph to the trimmed channel response.

The initial native Open/Save changed 15 internal sink identifiers. The subsequent
graph-only save was byte-identical; gain and inversion each changed one XML
value; selection/save was byte-identical to the prior state. The original input
file remained exact, and HFD settings outside recent-project text remained exact.
An exclusive metadata-only HID handle blocked HFD's normal read/write USB opens
(verified sharing error 32). This was not a physical USB disconnection or a
kernel policy. HFD closed before the handle was released. Bridge configuration
was untouched.

The public fixtures reconstruct minimal containers from saved parameter/cache
literals and record the real save hashes. They verify base-cache import, channel
gain/inversion applied once, untrimmed selected response and XML reopen. These
cases contain no observed baked-cache transition and do not qualify the separate
native uploader's disabled/Unity first-slot path, actual upload bytes, a physical
amplifier response or the native EQ popup.

## Verification scope

The development checkout passed 2,806 tests across 188 files and global
typechecking, with unchanged source snapshots. Isolated Chrome checks using the
actual Studio and shared command executor accepted 45 assertions. Two initial
unaccepted assertions remain recorded: the graph inspector's derived footer
lagged its visible heading, and a fast leading-decimal commit was first observed
as unchanged. Later observed-draft commits and three repeated wheel/Undo/typed
sequences passed; five targeted Numeric/Studio diagnostics also passed. The
first typed observation's cause remains unproven, so this is not a claim that
every browser attempt passed or that native input timing is qualified.

At 1024 by 768, graph-selected frequency, Q and gain stayed visible in the right
inspector. Both synthetic projects were restored exactly. External device,
audio, network and file operations were blocked in that fixture; none were
attempted. These checks exercise application commands, not remote MCP transport
or browser download delivery. No bridge configuration was set or applied.
