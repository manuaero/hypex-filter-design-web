# Numeric editing and agent commands

Numeric fields can remain focused while an agent changes the same workspace. An accepted command must survive a later Escape or blur from that older field session. Left and Right must retain independent values and a command targeting both roles must remain one Undo step.

## Transaction boundary

Design numeric fields use a workspace-issued focus session. It is held only in memory; a project file or MCP argument cannot supply it. Local changes made during a current session retain the existing grouped-edit behavior.

The workspace treats document writes outside the current field's own callback as independent of that field. Numeric callbacks use a synchronous operation bound to the current focus session; that authority does not continue across an asynchronous task. The production Studio tool adapter also marks document commands as independent of older legacy editing groups.

The workspace first validates the complete detached proposal for every target. Only an admitted edit can finish the preceding local group and create its own history entry. A refusal does not end a valid field or graph session. This boundary also covers native graph metadata and other document writers that do not pass through the usual tool-edit adapter.

If a person changes a field and an agent then changes both roles, Undo first removes the agent command. A second Undo can remove the earlier local group. If the field was only focused, the agent command is the sole document change. Undo and Redo retain complete project pairs, including native hints, exact cached filter vectors, provenance and unrelated channels.

## Stale field sessions

After an independent command or editing-context boundary, the previous field session cannot cancel or end a newer transaction. Escape discards that stale draft without emitting its earlier baseline into the workspace. Blur also avoids submitting stale text. A later local edit uses a new session against the current editing context.

The identity is separate from a document reference: returning to the same canonical values does not revive an older session. Existing owned graph gestures keep their separate ownership and stale-cancellation protection.

This behavior is automatic. There is no extra Run, synchronization or confirmation action for ordinary design editing. Device operations retain their existing explicit action controls.

## Verification boundary

The regression was reproduced through the actual Studio component adapter and shared tool executor: a successful Both-target compensation command, and a successful Both-target channel Gain command, were both erased by Escape in the pre-existing focused field. A separate failing case established the same problem for a native graph-metadata write outside the usual edit adapter. The retained failing tests compare complete project pairs.

Automated component/store tests are distinct from a browser session. Chrome's pending extension handoff still prevents completed production-browser interaction and paired production-client authentication acceptance. This change makes no new native HFD, physical amplifier, two-amplifier, macOS, acoustic or download-delivery claim.

The next ordinary channel Gain boundary/wheel oracle remains prepared only. HFD was not launched for that V47 preflight. Its temporary metadata-only USB exclusion was released without an explicit transfer. No amplifier setting or bridge configuration was applied.
