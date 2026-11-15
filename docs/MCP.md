# MCP server

Agents use the same controllers and validation as the human interface. Normal users can work entirely through visible controls; the optional command console is a development aid.

The current registry contains **86 commands**, including shared amplifier-mode review. Query `tools/list` on the running server for exact names, descriptions and strict schemas. Public preset, channel, filter and audio-channel numbers are one-based; internal model indices are zero-based.

## Pair a local client

1. Run `pnpm dev` and open `http://127.0.0.1:3210`.
2. Run `pnpm mcp` in another terminal.
3. Read the JSON printed by the server. It includes `url`, `bridge` and a generated `token` unless a token was supplied through the environment.
4. In **Agent access**, enter `ws://127.0.0.1:3211/bridge` and the token, then connect.
5. Configure your MCP client to use the HTTP URL and bearer token.

A client configuration commonly takes this form; use your client’s own configuration format:

```json
{
  "mcpServers": {
    "fusion-studio": {
      "url": "http://127.0.0.1:3211/mcp",
      "headers": {
        "Authorization": "Bearer <pairing token>"
      }
    }
  }
}
```

The local server binds to loopback. Host, Origin and token checks protect the HTTP endpoint and WebSocket pairing. Only one browser bridge is paired to a server at a time. Keep that page open: it owns browser data, permissions and device sessions.

Optional environment variables:

| Variable                 | Purpose                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `FUSION_MCP_PORT`        | Loopback port; default 3211.                                                                 |
| `FUSION_MCP_TOKEN`       | Explicit token of at least 32 characters; otherwise a random token is generated and printed. |
| `FUSION_BROWSER_ORIGINS` | Comma-separated permitted browser origins; defaults to the two local port-3210 origins.      |

Do not expose the loopback server to the internet or place a real token in project files, screenshots, issues or version control.

## Start with non-hardware actions

Read the current state:

```json
{ "name": "fusion_state", "arguments": { "includeProjects": false } }
```

Preview a filter without editing a project or accessing a device:

```json
{
  "name": "fusion_preview_filter",
  "arguments": {
    "filter": { "kind": "peak", "frequency": 1000, "q": 0.707, "gain": -3 },
    "frequencies": [100, 1000, 10000]
  }
}
```

Add a design section to an explicit destination:

```json
{
  "name": "fusion_filter_add",
  "arguments": {
    "target": "left",
    "preset": 1,
    "channel": 1,
    "frequency": 1000,
    "kind": "peak"
  }
}
```

That design edit does not upload the section. Inspect state and use Undo when appropriate. Hardware upload is a separate operation.

## Command families

| Purpose                      | Representative commands                                                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State, selection and history | `fusion_state`, `fusion_select`, `fusion_view`, `fusion_history`                                                                                                                                   |
| Projects and storage         | `fusion_project_new`, `fusion_project_import`, `fusion_project_export`, `fusion_workspace_storage`, `fusion_project_sources`, `fusion_project_directory`                                           |
| Filters and channels         | `fusion_filter_palette`, `fusion_preview_filter`, `fusion_filter_add`, `fusion_filter_set`, `fusion_channel_set`, `fusion_channel_link`, `fusion_biquad_exchange`                                  |
| EQ and FIR                   | `fusion_eq_set`, `fusion_eq_bank`, `fusion_eq_read`, `fusion_eq_upload`, `fusion_fir_set`, `fusion_fir_read`, `fusion_fir_upload`                                                                  |
| Measurements and analysis    | `fusion_hfd_measurement`, `fusion_microphone`, `fusion_analyze`, `fusion_time_analyze`, `fusion_audio`                                                                                             |
| Device state and settings    | `fusion_device_read`, `fusion_controls`, `fusion_amplifier_modes`, `fusion_limiter_editor`, `fusion_device_defaults`                                                                               |
| Device templates             | `fusion_device_clone`                                                                                                                                                                              |
| Backup/upload/recovery       | `fusion_backup`, `fusion_configuration_backup`, `fusion_upload`, `fusion_upload_all`, `fusion_restore`                                                                                             |
| Large files                  | `fusion_file_upload_begin`, `fusion_file_upload_chunk`, `fusion_file_upload_commit`, `fusion_file_export`, `fusion_file_chunk_read`, `fusion_file_status`, `fusion_file_list`, `fusion_file_close` |
| Help                         | `fusion_help`                                                                                                                                                                                      |

Some older clients cache tool names. Existing validated compatibility namespaces expose selected newer operations; use the server’s current schema rather than guessing nested arguments. Firmware inspection and authentication actions are available through `fusion_device_read` namespaces. Physical firmware programming remains disabled.

## Reviews, identities and receipts

Consequential workflows expose review/apply stages with an immutable review or request ID. Confirm the role, physical identity and before/after values. A Both operation may contain independent per-role drafts; it is not necessarily one identical patch.

Trusted transport context is passed separately from tool arguments. Do not supply owner/session identities to bypass it. Pairing admits a client to the local workspace; local-human legacy adoption still requires the actual human UI context.

An error, timeout or browser disconnect can occur after a device accepted a write. Read the operation’s retained ledger before retrying. Consumed requests replay their historical receipt rather than sending again. Undo changes a browser design; it does not undo a hardware setter or an audible sweep.

## Large files and filesystem grants

Use chunked transfers for large WAVs, folders and recovery exports. Decoded chunks are 256 KiB and have explicit byte counts/SHA-256 verification. A transfer handle is owner/scope bound, expires after inactivity or its absolute lifetime, and can require explicit same-owner rebind after reconnection. Immutable export chunks can be resumed and checked byte-for-byte.

Commit binds the destination and expected document revision. Reuse its request/commit identity when resolving an uncertain result; allocating a new request is not a safe generic retry.

Agents can read or save only through already granted filesystem roots. Missing/revoked grants return a human-grant requirement instead of opening a picker or accepting arbitrary paths. Directory saves remain multi-file, non-atomic operations with separate recovery.

## Hosted transport

The optional hosted bridge has its own authentication and browser-lease checks. It does not use the local bearer token. Queue encryption protects transient stored command/results, but the authenticated server processes plaintext; an agent also receives data explicitly returned by tools. Hosted authentication and deployment are separate from local setup.
