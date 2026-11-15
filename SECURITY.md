# Security

## Report a vulnerability

Use this repository’s private vulnerability reporting channel if enabled. If it is unavailable, request a private contact route without publishing exploit details or sensitive data. Do not attach real pairing tokens, passwords, emails, support codes, private device identities or recovery exports to a public issue.

No supported-version policy or security audit certification is implied. Report the source revision and a minimal synthetic test case.

## Local application and MCP

The app requires explicit browser permissions for HID, audio and directories. The local MCP service binds to loopback and checks Host, Origin and bearer token. Its token grants application-command access, including permitted device writes; pair only clients you trust. Do not expose the service through a public tunnel or reuse a token in source control.

Loopback HTTP/WebSocket is not end-to-end encryption. The browser and local processes are part of the trust boundary. The optional hosted queue uses authenticated encryption for stored transient command/results, but its authenticated HTTPS Worker handles plaintext. An MCP client receives data returned by the tools it calls.

Browser workspace authority gives new admitted actors a shared persistent owner and distinct scopes. Pairing revocation blocks new admissions; an operation already admitted may finish. Local-human approval is still required to adopt old directory records. Tool arguments cannot assign an authority owner.

## Stored data and exports

Projects, measurements, file chunks, directory capabilities and recovery journals are browser-origin data. They are not encrypted at rest by this application. Other trusted same-origin code, browser profile access and exported files remain security concerns. Origin changes and browser-data clearing can make data or grants unavailable.

Recovery files may contain exact configuration, names, device identity and audio/measurement data. Store them privately. Default authentication status avoids secrets; explicit email-read operations intentionally return the requested address. Do not mistake a secret-free status view for a guarantee that every explicit export is non-sensitive.

The app stylesheet may request fonts from Google Fonts. Browser/device permission services and an operator-configured hosted authentication system may also make network requests. Do not describe the full application as network-isolated by default.

## Hardware outcomes

Browser permission is not assurance that a requested setting is appropriate for attached drivers. Bridge, limiter, Defaults, restore, Device templates, noise and capture can have consequential electrical or audible effects. Use fixed targets and review the operation’s result. Undo does not reverse a USB write or emitted audio.

A timeout or lost ACK can occur after a write. The transport faults on ambiguous replies, and workflows retain available attempt/verification information. Inspect that ledger before taking another action; do not bypass it with a new request ID or an ad hoc raw packet.

Physical firmware programming remains disabled until an appropriate adapter is qualified. Do not remove that gate because a reference engine or simulator passes. The project does not provide a local vendor unlock-code generator.

## Supply chain

Use the committed lockfile and inspect dependency changes. Vendor binaries, firmware bundles and the optional vendor PDF are not part of the public distribution. Original project material uses the [MIT License](LICENSE); check [third-party notices](THIRD_PARTY_NOTICES.md) for the separate terms of dependencies and vendor material.
