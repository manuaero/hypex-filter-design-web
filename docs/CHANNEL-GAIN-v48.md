# Ordinary channel Gain

Fusion Studio is a web implementation of the Hypex Filter Design Windows app’s functionality, with an MCP server. Ordinary channel **design Gain** now uses a shared FA503 field profile in the inspector, channel planner and existing MCP command. Live amplifier master volume remains a separate control with separate limits.

## Shared field behavior

The recovered factory profile is −125 to +24 dB, two-decimal Text and final Double storage. A committed request is bounded/formatted, then coupled to that channel’s own AdditionalGain ceiling. For example, raw Gain18 with AdditionalGain10 becomes Gain14. An uncompensated role receiving that same original request becomes Gain18. Ordinary Gain edits preserve AdditionalGain, the document’s hardware-gain hint and retained filter/cache literals.

The human field sends its original dirty Text on Enter or blur, before a selected-role cap can discard the original request. Every intended role normalizes that request independently. This is whole-value commit behavior; the observations do not establish every native textual keystroke callback.

A wheel action is one signed factory 0.1 dB event. Its magnitude does not multiply the step. Changed Text invokes the ordinary channel callback, which caps and explicitly publishes its final parsed Double. This differs from the BQ gain field’s later display-only guard. If AddValue does not notify a Text change, the shared late guard can still alter Text without publishing a new canonical Gain; an unconditional final getter would be incorrect.

Passive presentation is separate: native source narrows an existing Double to Single before bounded two-decimal display. Display does not rewrite imported metadata. Arbitrary fractional AdditionalGain arithmetic, off-grid stored values and unchanged-Text internal wheel state have source-derived tests; they are not all native screenshot or Save oracles. In particular, the observed raw `0.005` commit does not qualify passive presentation of an imported Double 0.005.

Human wheel state is private to the current field. Context changes and accepted foreign document revisions discard stale transient state; continuous own edits retain their state. That multi-role freshness rule is a browser policy tested with synthetic independent projects, not a native two-amplifier observation. The existing keyboard-arrow adjustment is also a browser extension, now using the offline −125…24 range so a newly valid Gain24 cannot jump to the obsolete18 ceiling. Native arrow increment parity is not claimed.

## UI and MCP share one plan

The existing `fusion_channel_set` accepts `patch.gain` as a finite number or original raw Text. It also accepts a **sole** wheel intent:

```json
{
  "target": "both",
  "preset": 1,
  "channel": 1,
  "patch": { "gainWheel": { "direction": "up", "basis": "each" } }
}
```

`each` is the command default: each role starts from its own canonical Gain, passive presentation and AdditionalGain. A fixed `left` or `right` basis mirrors a changed source event’s canonical value through each destination’s own callback ceiling. The source result is not reparsed. If the source canonical value does not change, no mirror is applied, after all selected roles pass structural/read-only/context validation. The human Mirror action uses its current role as the source.

Commands are stateless fresh-field events. They cannot supply opaque state, custom bounds, step values, eligibility or source-event override flags. Results distinguish each role’s Text and canonical value. The registry remains **91 commands**; the running endpoint’s strict schema is authoritative. This increment does not establish that a cached connected-plugin declaration has refreshed.

All roles preflight before publication. Linked destinations remain read-only for processing edits. Actual Gain changes use the existing scoped link propagation; unchanged peers, metadata, unrelated presets and retained coefficient provenance stay intact. Canonical no-ops add no history. Local callbacks retain the [V47 focused-field authority](NUMERIC-TRANSACTIONS-v47.md), and accepted independent commands remain separately undoable.

The compiler now accepts the same offline channel range and applies Gain plus AdditionalGain once. It does not normalize passive imports. Unresolved first-cache interpretation, nonfinite values, Q8.24 overflow and quantized-instability refusals remain in force. The independent unity-scale word predictions in tests are software arithmetic checks, not native wire captures or physical programming acceptance.

## Completed normal native Saves

The normal series has twelve completed offline Saves. The current actual runtime Settings supplied min−125, FA maximum24 and step0.1. Root used classic screenshots and physical input with fresh metadata-only HID exclusion held; the HFD main view was disconnected. These are native saved-file observations, not simulator substitutes.

| Checkpoint | Action/context                             | Saved P1/CH1 Gain / AdditionalGain |
| ---------- | ------------------------------------------ | ---------------------------------- |
| 00         | Opened baseline                            | 0 / 10                             |
| 01         | Compensation Off preparation               | 0 / 0                              |
| 02         | Explicit selection, raw `-125.0001`, Tab   | −125 / 0                           |
| 03         | Raw `24.0001`, Tab                         | 24 / 0                             |
| 04         | Raw `0.005`, Tab                           | 0.01 / 0                           |
| 05         | One positive wheel request of magnitude360 | 0.11 / 0                           |
| 06         | One negative wheel request of magnitude120 | 0.01 / 0                           |
| 07         | Compensation On preparation                | 0.01 / 10                          |
| 08         | Raw Gain18, committed                      | 14 / 10                            |
| 09         | Raw Gain13.95, committed                   | 13.95 / 10                         |
| 10         | One positive120 wheel request              | 14 / 10                            |
| 11         | Positive360 request at the coupled ceiling | 14 / 10; byte-identical to10       |

For the isolated ordinary Gain Saves, full XML comparison found only the selected Gain value and its duplicated parent descriptor changed. All eight other Gain records and every BQ/root/cache literal stayed exact. The Off/On preparation states also change their documented compensation/hint metadata. Equal saved bytes at11 establish the resulting state, not native callback count or absence of callbacks.

The first click-only minimum-entry attempt returned visible0.00 and was not saved as an ordinary Gain case. Its cause is unisolated. Explicit Home/Shift/End selection, physical ASCII input and Tab then produced the accepted minimum Save; the first attempt is not evidence of a Tab-cancel rule.

## Separate synthetic conflict experiment

A new synthetic input was reconstructed from the archived baseline by changing only P1/CH1 Gain0 to24 while retaining AdditionalGain10 and the true document hint. It is not a native Save. Native FileOpen/Graph initialization already displayed14, and the separate completed Save12 retained Gain14/Add10.

Comparison against the reconstructed input found Gain24→14, fifteen sink-ID renumberings and seven duplicated parent descriptors. All other Gain records and all 135 BQ/root/cache literals were exact. This combined load/Graph initialization does not isolate the responsible callback. No wheel was performed from canonical24 because that starting state had already normalized. Consequently, the source-derived unchanged-Text first-wheel conflict remains unqualified by native execution; neither the pure helper nor passive browser import was changed to fabricate that oracle.

## Source and verification boundaries

Installed HFD 5.2.4.24 source evidence includes:

- `c64b74..c64c9c`: ordinary Gain normalization, AdditionalGain ceiling and final Text getter/Double publication. `c64990` performs the inhibited normalization; `c64bf0..c64c03` passes Extended maximum minus Double AdditionalGain directly to bounded SetValue; `c64c21..c64c37` publishes the final getter.
- `c60826→c69020`: passive Double-to-Single presentation. Bound getters are `c6d4d0` and `c6d3dc`; this field’s runtime limits replace its resource defaults.
- `c642b0..c64396`: sign-only wheel dispatch through step getter `c6d3a8` and AddValue `ba6a48`, followed by the distinct inhibited outer guard. Native field setter/formatter paths include `ba6ecc` and `ba7034`.

The implementation is in [channel-gain.ts](../src/domain/channel-gain.ts), [channel-editing.ts](../src/domain/channel-editing.ts), [hardware-gain.ts](../src/domain/hardware-gain.ts) and [dsp.ts](../src/domain/dsp.ts). Tests use public-safe parameter literals and synthetic containers; native project contents and personal identifiers are not included.

| Focused evidence                                    | Actual result                                                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure channel profile and existing numeric profiles  | 202 passed in 8 files; 28 new cases.                                                                                                                                                        |
| Channel planning/compiler and retained regressions  | 149 passed in 9 files; 21 new cases.                                                                                                                                                        |
| Actual Studio component/shared-executor integration | 144 passed in 8 files; 32 new cases. These are automated components, not a browser session.                                                                                                 |
| TypeScript and exact owned-file format checks       | Passed for all three frozen owner scopes.                                                                                                                                                   |
| Unfiltered private full suite                       | Final rerun: 3,395 passed in 217 files, including 3,287 canonical assertions in 214 files and 108 retained diagnostic assertions in 3 files. Typecheck passed; checked source stayed exact. |
| Fresh public tests/build/export                     | See the current [verification record](VERIFICATION.md) for the independently checked public checkout and build results.                                                                     |

Focused suites overlap and must not be summed into a full-suite count. Original planner/UI failure reports and the corrected test-setup refusal remain retained separately. The first full private run’s sole failure still expected Gain−125 to be rejected. Root updated only that existing test to accept −125 and reject −125.01; no product change was made for that failure, and the original failed run is retained. Left/Right behavior is tested on independent synthetic projects; simultaneous physical stereo operation is not established. One physical target’s metadata interface was excluded for this offline native session, without amplifier protocol commands. This is not a two-amplifier acceptance result.

Root restored the untouched offline input for a final Gain0.00/checked view, then closed Designer/Main normally before releasing exclusion. Actual user Settings before/after matched byte-for-byte outside the recent-project list; all three ASIO selection value attributes were empty. The original and Restore remained exact, and normal Work matched saved11. Metadata sharing exclusion/error32 is not physical USB disconnection, kernel policy or a bus trace.

There were no amplifier protocol commands, bridge applications, uploads, firmware or audio operations in this native session. No fresh physical filter-sector/state, acoustic, macOS, two-amplifier, production-browser, remote-MCP or download-delivery acceptance follows. Do not set or apply bridge configuration during testing. This bounded channel-Gain work does not claim full HFD parity.
