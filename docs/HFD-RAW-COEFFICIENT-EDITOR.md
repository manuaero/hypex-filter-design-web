# Explicit coefficient editing

The browser provides an explicit raw biquad editor for `b0`, `b1`, `b2`, `f1`
and `f2`, using the positive-feedback convention already used by the compiler.
This is a browser extension. HFD 5.2.4.24's inspected graph selector offers its
ordinary parameter filters; it does not expose `ftFree` or five coefficient
entry fields. Imported native Free records do not establish a native authoring
workflow or complete compatibility with native selection/recalculation.

Disabling a raw section preserves its five retained values. The inspector shows
those retained values while the channel response applies bypass. Coefficient
text uses round-trip Double display, with finite typed values committed on
Enter or blur. An unfinished draft is discarded when its editing context changes.
These design edits do not send amplifier commands.

A single coefficient edit with linked Left/Right edits merges that field into
each role's independent vector. Other coefficients, bypass state and channel
cache interpretation remain separate. All destinations must be editable before
the paired edit is published; one Undo restores both designs. A whole-filter
palette replacement is an explicit replacement of the complete proposed section.

Direct raw creation (`fusion_filter_add` or the model constructor) starts at
Unity. The palette converts its currently staged section, preserving that
preview. Converting an existing section to raw retains
its current unbypassed cache, or calculates its unbypassed parameter section
when no cache exists. Channel trim and polarity are not baked into that
calculation. Simultaneous parameter fields in an MCP conversion become latent
metadata; they do not redesign the response being captured. Partial edits
require a complete finite baseline; an explicit full vector can repair one.

`fusion_filter_set` accepts a strict, nonempty partial coefficient object for
raw sections, such as `{"coefficients":{"b0":0.5}}`. It uses the same independent
merge and bypass rules as the UI. Full parameter-cache overrides remain
compatible; partial overrides require a raw section. Diagnostic preview still
requires all five supplied coefficients. Upload compilation independently checks
cache interpretation, literal stability and Q24 stability.

Standalone browser-exported HFD XML carries an `unresolved` marker on the
channel's gain object when its first cache has an ambiguous gain interpretation.
Reopening that XML retains the exact vector and compilation refusal, including
when a browser folder sidecar is missing or stale. Resolved exports remove that
per-channel marker. This metadata is a browser round-trip contract; native HFD
does not provide the browser's cache-choice workflow.

## Verification checkpoint

V41 development-source verification passed 2,742 tests across 186 files and
global typecheck, with the complete source snapshot unchanged during the run.
Actual Studio acceptance passed 29 checks in Chrome against synthetic designs:
retained bypassed vectors, finite text drafts, independent paired edits, one
Undo, atomic linked-target refusal, conversion, staged palette Apply/Cancel,
compiler refusal, XML reopen and browser reload. At 1024×768, all five raw fields
were visible without document scrolling. USB, audio, network and filesystem
access were blocked in that isolated fixture; no blocked I/O attempts occurred.

These checks exercise the UI and shared executor through its optional command
console. They do not qualify a network MCP transport, native Free authoring,
physical uploads, macOS USB, two physical amplifiers or download delivery.
The existing UI and JSON number representation canonicalize signed zero;
the core/MCP in-memory coefficient patch can retain it. Stability and Q24
compilation rules remain unchanged.
