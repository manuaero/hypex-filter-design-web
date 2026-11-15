import assets from './assets.generated';
import { handleSiteApi, type SiteEnv } from './api';
export default {
  async fetch(request: Request, env: SiteEnv) {
    const api = await handleSiteApi(request, env);
    if (api) return api;
    const path = new URL(request.url).pathname,
      key = path === '/' ? '/index.html' : path,
      asset = assets[key] ?? assets[`${key}/index.html`];
    if (!asset) return new Response('Not found', { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    return new Response(
      request.method === 'HEAD'
        ? null
        : Uint8Array.from(atob(asset.base64), (c) => c.charCodeAt(0)),
      {
        headers: {
          'Content-Type': asset.type,
          'Cache-Control': key.includes('/_next/static/')
            ? 'public,max-age=31536000,immutable'
            : 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Permissions-Policy': 'hid=(self)',
        },
      },
    );
  },
};
