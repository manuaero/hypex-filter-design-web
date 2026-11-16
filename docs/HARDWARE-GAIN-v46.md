# Hardware gain compensation and channel editing

This release adds the native **Gain is lowered by hardware** design action to the channel inspector and the existing `fusion_channel_set` MCP command. It edits the crossover project. It performs no USB operation and does not change the amplifier's physical attenuation, power, bridge configuration or active preset.

## Use the control

The checkbox is conditional. A fresh channel view exposes it when the channel already has a finite nonzero imported `additionalGain`. Turning it off sets that channel's compensation to 0 dB. Turning it on sets compensation to 10 dB and commits ordinary channel Gain through the native callback's display, bounds and final Double getter.

For example, enabling compensation from Gain18 dB changes Gain to14 dB and compensation to10 dB under the recovered FA503 maximum24 dB profile. Disabling it does not restore an earlier Gain value.

The existing view retains the checkbox after Off, including across ordinary gain edits, Save and a visit to another existing channel view. Reopening/replacing the project creates fresh views; a channel saved with compensation0 no longer exposes the checkbox. This presentation eligibility is trusted workspace context. It is not saved in a project file or accepted as a command argument.

Left and Right keep independent origins and metadata. With linked editing enabled, every requested target must admit the action before either document changes. A linked follower's processing is read-only; edit its master or unlink it first. A successful paired compensation action retains the relevant editor context for both roles, so a subsequent paired On can follow Off.

## MCP

Use one-based preset and channel numbers:

```json
{
  "name": "fusion_channel_set",
  "arguments": {
    "target": "both",
    "preset": 1,
    "channel": 1,
    "patch": { "hardwareGain": false }
  }
}
```

`hardwareGain` must be the sole patch field. It is an explicit callback intent, rather than an arbitrary AdditionalGain setter. An already checked imported value6 can therefore become10 on an explicit true action; passive import alone retains6. Equality of the resulting canonical values determines whether a document edit or Undo entry is needed.

The connected Studio supplies the same trusted view eligibility and captured Gain Text to human and agent actions. Successful explicit actions can retain that context; status reads and rejected proposals cannot create it. A headless adapter without a trusted context store can use only fresh native eligibility. Commands do not accept a serialized view, availability override or context token.

All channel edits now use one role-aware planner. Ordinary scalar authoring retains its existing browser bounds and behavior; this release does not qualify the complete native ordinary channel-Gain editor, wheel or arbitrary custom preferences. The compensation callback uses the separate recovered FA503 factory profile: Gain -125..24 dB, two-decimal Text and Double storage, with a compensation ceiling of24 minus0/10 dB. Passive native Gain presentation first narrows the stored Double to Single. Precision boundary predictions remain source evidence unless independently observed in HFD.

## Project and cache behavior

The selected channel's `additionalGain` and the optional project `hfdGainLowered` hint are persisted in JSON and native XML. The hint corresponds to native `device/@gainlowered`; an explicit callback sets it from the selected channel. It is not an OR across all channels or presets and is not proof of physical hardware state.

Untouched imported values, retained biquad Double vectors, source provenance and unresolved cache interpretation remain intact. Compensation is included by the existing analysis/compile path; the action does not redesign or bake cached biquads. Existing stability, Q24 and unresolved-cache upload guards remain in force.

Metadata-only edits preserve linked followers' retained processing. Actual shared-processing edits synchronize only the edited root's group in its preset, independently for each changed role. Unrelated groups and other presets retain their exact state. Paired changes publish atomically in one Undo step, and canonical no-ops leave caches and history untouched.

## Verification scope

The offline oracle used installed HFD5.2.4.24, classic screenshots and physical mouse/keyboard input, with its one USB interface held under a separately verified metadata-only sharing exclusion. That exclusion is not physical disconnection, a kernel policy or bus tracing.

Five actual native File Saves were retained:

| State                       | Observed result                                                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline                    | Reopening the retained native input renumbered fifteen sink IDs; processing stayed unchanged.                                                                                                                                      |
| Off at Gain0                | Only selected-channel AdditionalGain10 to0 and the device hint true tofalse changed.                                                                                                                                               |
| Gain18 while Off            | Only selected-channel Gain0 to18 changed.                                                                                                                                                                                          |
| On with Gain18              | Gain18 to14, AdditionalGain0 to10 and device hint false totrue; all filter caches and the other eight channel Gain nodes stayed exact.                                                                                             |
| Off plus channel navigation | Compensation and hint changed, selected-group metadata changed, and another channel's `applymiccorr` flag changed. This combined case does not isolate the extra flag's cause and does not implement it as a checkbox side effect. |

Separate screenshots established retained Off visibility, an independent fresh channel without the control, return to the existing Off view, fresh Off-project reopening without the control, and reopening an untouched copy of the original offline input. Reopen views are not additional native saved states.

One Unicode numeric-entry attempt did not establish Gain18; physical digit keys later succeeded. Two stale/covered pointer actions were refused before input, and a recreated menu needed a fresh capture. These observations are retained separately from successful parameter oracles.

Actual runtime Settings were captured before and after this session. Bytes outside the recent-project list were identical, and all three ASIO value attributes were empty in both snapshots. HFD was closed normally before the exclusion was released. No actual amplifier command, bridge application, audio operation or fresh physical state/hash read was performed.

Automated domain, component and executor coverage is distinct from browser acceptance. The earlier Chrome extension handoff does not establish this release's browser, paired MCP, production authentication, macOS, two physical amplifiers, acoustic or download-delivery acceptance. Full HFD feature parity remains unfinished.
