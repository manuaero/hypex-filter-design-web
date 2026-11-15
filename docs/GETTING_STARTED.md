# Getting started

## 1. Run the application

Install Node.js 22.13 or newer and the package manager pinned in `package.json`:

```sh
pnpm install
pnpm dev
```

Use `http://127.0.0.1:3210` consistently. `localhost` and `127.0.0.1` are different browser origins, even when both reach your computer. Desktop Chrome and Edge are the intended WebHID browsers. macOS device access has not been qualified.

Wait for workspace storage to report Ready before editing. If storage reports an error, use its recovery/export and retry controls; clearing browser data can remove the only local record of a project or operation.

## 2. Design without hardware

Choose Left or Right, then a preset and output. Add a filter using the palette or graph. Selecting its point reveals frequency, Q, gain or asymmetric pole/zero details in the adjacent inspector. Design changes do not upload themselves to an amplifier.

Use the advanced signal-chain view for channel processing, links, section exchange and preset transfers. Linked edits are an explicit scope choice. Left and Right still retain separate measurements and document identities.

Import measurement text, FRD or supported WAV data through Measurements. Browser processing and the HFD analysis model are separate modes. HFD mode retains original samples, crop bounds, phase reference and correction options; changing the processing mode should be intentional.

Input EQ is separate from output crossover filters. FIR coefficients must come from an external design at the supported processing sample rate; the app is not an automatic FIR designer.

## 3. Save projects

Project JSON preserves browser-specific state. Native folder export writes `Config.xml`, measurement resources and a browser sidecar. HFD consumes the native files; the sidecar preserves additional browser state only while its native-file bindings remain valid. Later native-file changes invalidate stale browser snapshots.

The library stores browser-owned project snapshots. A granted source directory instead opens fresh filesystem content. A human must grant directory access explicitly; agents can use existing grants but cannot choose arbitrary operating-system paths or silently invoke a picker.

For directory Save/Save As:

1. Capture the intended role and design revision.
2. Grant a read/write directory and select a direct-child project folder.
3. Prepare and inspect the create/replace/unchanged file list.
4. Save the reviewed files and inspect the verified result.

Before-images and desired bytes are retained for recovery. Existing unrelated files are preserved. New files introduced by a save are listed and retained during recovery; no whole-folder rollback is promised. Partial or uncertain saves must be resolved with their original request rather than replaced by an unrelated new request.

Completed recovery records can be explicitly archived after review, removing local recovery bytes while retaining a historical receipt. Exporting a ZIP does not prove that an external backup was durably stored. Review that trade-off before removing recovery data.

## 4. Connect an amplifier

Close HFD and other controllers using the same USB interface. Use the app’s connection action, grant the device in the browser chooser and assign it explicitly to Left or Right. Verify the displayed identity before any write. One physical amplifier cannot occupy both roles.

Inspect device status and create appropriate backups before changing hardware. Preset design selection and the amplifier’s active preset are different controls. A Save writes project files; an Upload programs the amplifier.

Safe validated settings update when editing finishes. Master/Slave, bridge and soft-clip changes use the shared amplifier-mode review and explicit Apply. Limiter, Defaults, Device templates and restore operations have their own fixed-target review or action. Some operations intentionally mute the amplifier; the outcome states what was confirmed.

Bridge changes affect output wiring and limiter requirements. Never apply or test a bridge change with incompatible connected drivers. This project’s recent bridge/configuration workflow checks used simulated panels, not live speaker drivers.

## 5. Optional capture and agents

Browser measurement capture requires explicit microphone/output configuration and permission. A Take emits an audible sweep and replaces the selected measurement after preflight; Undo restores design data, not emitted audio. Routing, sample clocks and latency depend on browser and device behavior and are not ASIO-equivalence claims.

Agent access is optional. Follow [MCP.md](MCP.md) to pair a trusted client. Ordinary controls work directly without the command console.

## Troubleshooting

| Symptom                             | Action                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| No device chooser or WebHID support | Use a supported desktop browser in a secure context. Permission must originate from a human action.                                                |
| Unexpected HID reply or timeout     | Stop issuing commands, close competing controllers and inspect the visible state. The transport faults rather than reusing a possibly stale reply. |
| Storage is not Ready                | Export available recovery data and retry storage. Do not assume an in-memory change is durably saved.                                              |
| Granted folder unavailable          | Regrant the intended directory through a human picker. No stale filesystem snapshot is silently substituted.                                       |
| MCP browser disconnected            | Keep the app open and reconnect its local bridge. Inspect any prior operation before retrying.                                                     |
| Help PDF unavailable                | Use the official Hypex or DIYclassD link. The vendor PDF is not included in the public source.                                                     |

See [verification limits](VERIFICATION.md) before relying on an unqualified device operation.
