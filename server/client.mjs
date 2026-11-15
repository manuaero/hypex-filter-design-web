// Diagnostic MCP client. Credentials arrive through hidden stdin, never argv.
import { readFileSync, writeFileSync } from 'node:fs';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdout.write('Ready for MCP client JSON on stdin (input is hidden).\n');
let input = '';
process.stdin.on('data', async (chunk) => {
  input += chunk;
  if (input.includes('\u0003')) process.exit(130);
  if (!/[\r\n]/.test(input)) return;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  try {
    const config = JSON.parse(input.trim());
    for (let n = 0; n < config.requests.length; n++) {
      const request = config.requests[n];
      if (request.loadText)
        request.params.arguments[request.loadText.field] = readFileSync(
          request.loadText.path,
          'utf8',
        );
      const response = await fetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: n + 1,
          method: request.method,
          params: request.params,
        }),
      });
      const value = await response.json();
      if (request.method === 'tools/list') {
        process.stdout.write(
          JSON.stringify({
            method: request.method,
            status: response.status,
            tools: value.result.tools.map((t) => t.name),
          }) + '\n',
        );
      } else {
        let body = value.result;
        if (request.method === 'tools/call') {
          const text = body?.content?.find((c) => c.type === 'text')?.text;
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
        if (request.saveContent) {
          writeFileSync(
            request.saveContent,
            typeof body?.content === 'string' ? body.content : JSON.stringify(body, null, 2),
          );
          body = { ok: body?.ok, saved: request.saveContent };
        }
        if (request.params?.name === 'fusion_compile' && body?.channels)
          body = { ok: body.ok, channelLengths: body.channels.map((c) => c.length / 2) };
        if (request.params?.name === 'fusion_backup' && body?.backups)
          body = {
            ok: body.ok,
            backups: body.backups.map(({ sector_hex, configuration_hex, status_hex, ...b }) => b),
          };
        process.stdout.write(
          JSON.stringify({
            method: request.params?.name ?? request.method,
            status: response.status,
            result: body,
          }) + '\n',
        );
      }
    }
    process.exit(0);
  } catch (e) {
    process.stderr.write(String(e) + '\n');
    process.exit(1);
  }
});
