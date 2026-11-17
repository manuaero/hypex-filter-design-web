# Output mute and gain

The output controls stay at the top of the left sidebar. Choose CH1, CH2 or CH3
to edit that output's design gain; each output has its own live mute button.
Additional channel parameters scroll below these controls.

| Control                                 | What changes                                   | When it affects the amp                                                       |
| --------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Live output mute CH1 / CH2 / CH3        | One physical output on the selected amplifier  | Immediately after a deliberate click, with fresh status and verified readback |
| Gain under Design gain · CHn            | The whole selected output's crossover level    | After an explicit crossover upload                                            |
| Preview mute                            | The local response preview                     | It does not send a mute command or encode a muted output in an upload         |
| Gain on a Bell or Low/High shelf filter | That filter's frequency-dependent boost or cut | After an explicit crossover upload                                            |
| Master volume                           | The amplifier's runtime master level           | Immediately after an explicit live control change                             |

## Live output mute

The button shows the reported state of its physical output. It is disabled when
the selected amplifier is offline or an operation is in progress. It does not
change the editing channel or either local design.

Output mute acts on the selected amplifier even when **Link controls** is on.
That preference continues to link master volume, master mute and hardware preset
controls. It does not expand a one-output mute into a stereo-pair operation.

The setter merges one requested bit into freshly read status while holding the
amplifier session reservation. Other output mutes, master mute, volume, source,
active preset and bridge configuration are retained. The Device settings mute
switches use this same per-output intent. MCP can explicitly target either or
both amplifiers through `fusion_controls`:

```json
{
  "target": "right",
  "patch": { "outputMute": { "channel": 2, "muted": true } }
}
```

Channels are numbered 1–3. `outputMute` is a separate intent: it cannot be combined
with another patch field. An explicit Both request preserves each amplifier's
other mute bits independently. No browser or agent mute action runs on load.

An unconfirmed output-mute reply is reported as an error. This intent does not
automatically retry, roll back or send a master-mute command. Check fresh reported
state before deciding whether another deliberate action is needed.

## Raise the whole output while preserving its crossover

Select the output and adjust **Gain** under **Design gain · CHn**. This scales
the entire output response rather than changing one EQ band. Changing it updates
the local design and supports Undo; **Upload** is the separate hardware action.
**Mirror L/R edits** can edit matching design channels, while uploads still use
their explicit targets. A linked follower uses its master channel's processing.

The native design gain profile is −125 to +24 dB. Hardware-gain compensation, when
present, contributes a separate +10 dB design offset and reduces the editable
ceiling accordingly. Master volume has its own −96 to +18 dB range. Neither
numeric limit guarantees remaining DSP, amplifier or driver headroom.

An amplifier read retains raw compiled coefficients. Its displayed design Gain
of 0 dB is an additional offset over that recovered response, not a measurement
of the original project's separately factored gain. Increasing channel Gain can
scale that raw response without converting the sections to new filter shapes.
The original shapes and their frequency/Q labels cannot be reconstructed from
this read alone.

Positive gain can compensate attenuation but also increases signal level and
can cause clipping. At a master setting of +18 dB, lower playback level before
auditioning a boost and check the resulting response and live levels. Applying
the same offset to the intended outputs preserves their existing relative
balance; changing one output changes the speaker's balance. There is no automatic
make-up gain or automatic increase when filters are loaded.

The [Hypex FusionAmp manual](https://www.hypex.nl/media/df/df/c2/1678368740/Fusion%20Manual%20R4.pdf)
distinguishes the gain stages and explains that clipping indication does not
protect speakers. The numerical design-field bounds above come from the
installed HFD profile used by this implementation.

Bell and low/high shelf filters have their own gain parameters. Low/high-pass,
all-pass and custom raw sections do not acquire a general loudness control by
editing a filter's inactive gain metadata. Use channel Gain for a uniform output
level change. Input EQ remains a separate stage and upload operation.

Bridge configuration must never be applied during testing with the connected
drivers. The output controls do not require or apply a bridge configuration.
