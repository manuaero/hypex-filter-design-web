# Project Save semantics

Ordinary HFD folder Save preserves two distinct states: the document written to
files and the open document after the writer returns. The web implementation
uses this distinction for the shared UI and MCP folder writer. Save review,
file generation and historical receipt lookup are passive.

## Files first, then the current preset

The folder capture keeps an immutable preimage of the selected role's design.
`Config.xml` and its matching `FusionProject.json` sidecar describe that same
preimage, with the current runtime preset recorded as the selected preset. An
imported `hfdSelectedPreset` is retained source metadata; it does not replace the
explicit current-preset context captured for this Save. Generic JSON and HFD ZIP
downloads retain their own captured metadata and do not acquire folder-Save
effects.

After an admitted ordinary writer invocation returns normally, the open
document's current preset is reconciled using the raw Global-delay rule:

- Equal Global values leave all three channels unchanged, including differing
  or absent maximum metadata.
- If any Global value differs, all three channels receive the first channel's
  raw Global value and its known finite maximum.
- The operation does not format Text, round to samples, impose runtime bounds,
  copy channel processing or touch other presets.

For example, a current preset containing Global values `[101, 113, 127]` and
maxima `[71001, 71003, 71007]` is written with those values. After Save, the open
document contains `[101, 101, 101]` and `[71001, 71001, 71001]`. A later Save can
write the reconciled values. This timing is intentional; normalizing before
serialization would change the first file.

The post-state changes only Global delay and its maximum. It does not rewrite
the live imported preset hint or infer native dirty-flag behavior. A browser
workspace can therefore be saved to its own persistence while differing from
the earlier folder preimage.

## Roles, Undo and asynchronous work

A single-role folder Save targets the explicitly selected Left or Right
document. Mirror does not extend that Save to the other role. Each role uses
its own document, preset context and delay metadata. The underlying operation
can preflight both role contexts before one independent workspace publication;
this is not a claim that two filesystem writes are atomic.

The Save attempt checks the workspace owner, document revision, original
document identity, current preset and relevant raw delay state before writing
and again before publishing the post-state. Preparing or canceling a review
does not publish a change. Stale context cannot silently apply a delayed Save
effect to another design or preset.

An actual changed post-state publishes once as one Undo step, independently of
Mirror. Undo restores the previous workspace design; it does not undo files
already written. Replaying a completed file receipt after Undo returns that
historical result without writing files or reapplying the post-state. Reloading
a journal also does not recreate permission to publish a Save effect.

Workspace persistence follows publication. If persistence fails afterward, the
latest open design remains available for recovery. Retrying that persistence
does not repeat the file write or the Undoable edit. Browser storage and an
external folder do not form one atomic transaction.

## Return values and uncertainty

Native source places reconciliation after the serializer call, without testing
its Boolean success result first. The internal lifecycle therefore distinguishes
a normal `false` return from a writer that did not return normally. That source
ordering does not establish how a real failed native save behaves in the GUI.

Cancellation or refusal before a writer invocation has no post-Save effect.
Thrown errors, partial folder writes and unknown outcomes are not converted into
a normal `false` return. They retain their explicit failure or recovery status.
A completed historical receipt cannot create a second post-Save publication.

## Native evidence

Source analysis of HFD 5.2.4.24 identifies ordinary Save at `0xc51160`. It reaches
the serializer through `0xc7c610`; the serializer call is at `0xc7c666` and current
preset reconciliation at `0xc7c678`. The serializer's Boolean result is returned
later at `0xc7c6b2`, with no Boolean success gate before reconciliation. Saving an
old document before Open uses a separate path that reconciles before writing;
it is not this ordinary Save lifecycle.

Four offline Saves through the visible HFD File menu qualify the successful
ordinary path. Each case selected preset 2 and performed two ordinary Saves
without visiting a Graph or editing a field between them:

| Case                | First Save                                                     | Second Save                                                |
| ------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| Differing values    | Preserved `[101, 113, 127]` and maxima `[71001, 71003, 71007]` | Wrote `[101, 101, 101]` and maxima `[71001, 71001, 71001]` |
| Equal-value control | Preserved uniform values and differing maxima                  | Byte-identical output, with a later file timestamp         |

The first files also changed the selected-preset number and renumbered 15 sink
descriptors, including three input-FIR descriptors. Those incidental differences
are distinct from delay reconciliation. Across the two Saves, the differing
case's only processing changes were the two destination Global values and their
maxima; the control had no XML differences. Biquad parameters, coefficient
caches, gains, local delay/maxima and FIR processing/resources were retained.

The original and restore projects remained byte-exact. HFD was restored without
saving and closed normally before the metadata-only exclusive USB handle was
released. No explicit device transfer or amplifier configuration command was
used in this experiment.

The GUI comparison qualifies successful ordinary Save and the preset-selection
precondition only. Native failed-serializer returns, exceptions, runtime Save
As, dirty-flag semantics and the save-old-before-Open path remain separate. Pure
software vectors for signed zero or missing metadata do not establish those
cases in the native GUI. This evidence does not qualify physical upload,
macOS USB, two physical amplifiers or complete HFD parity.
