const HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'api.github.com',
  'gist.github.com',
  'gist.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'user-images.githubusercontent.com',
  'avatars.githubusercontent.com',
]);
const REQUEST_HEADERS = [
  'accept', 'range', 'if-range', 'if-none-match',
  'if-modified-since', 'cache-control', 'content-type', 'git-protocol',
];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type, Range, If-Range, If-None-Match, If-Modified-Since, Cache-Control, Git-Protocol',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Disposition, Accept-Ranges, ETag, Last-Modified, Location, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After',
};

function allowed(url) {
  return url.protocol === 'https:' && !url.username && !url.password &&
    !url.port && HOSTS.has(url.hostname);
}

function message(text, status) {
  return new Response(text + '\n', {
    status,
    headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function readableGit(url) {
  return url.hostname === 'github.com' &&
    /^\/[^/]+\/[^/]+\/git-upload-pack$/.test(url.pathname);
}

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
      const response = message('Method not allowed.', 405);
      response.headers.set('Allow', 'GET, HEAD, POST, OPTIONS');
      return response;
    }
    if (incoming.pathname === '/' && !incoming.search) {
      if (request.method === 'POST') return message('POST is only allowed for Git upload-pack (clone/fetch).', 405);
      return new Response(request.method === 'HEAD' ? null : HOME, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" },
      });
    }

    let target;
    try {
      target = new URL(incoming.pathname === '/'
        ? incoming.searchParams.get('url')
        : incoming.pathname.slice(1) + incoming.search);
    } catch {
      return message('Invalid URL. Use /https://github.com/owner/repo/... or /?url=<encoded URL>.', 400);
    }
    if (!allowed(target)) return message('Only HTTPS URLs on supported GitHub hosts are allowed.', 403);
    if (target.hostname === 'github.com') {
      target.pathname = target.pathname.replace(/^(\/[^/]+\/[^/]+)\/blob\//, '$1/raw/');
    }
    if (target.searchParams.get('service') === 'git-receive-pack' || target.pathname.endsWith('/git-receive-pack')) {
      return message('Git push is not supported.', 403);
    }
    if (request.method === 'POST' && (!readableGit(target) ||
      request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-git-upload-pack-request')) {
      return message('POST is only allowed for Git upload-pack (clone/fetch).', 405);
    }

    // Keep byte offsets stable across full downloads and Range requests.
    const headers = new Headers({ 'User-Agent': 'githubproxy-worker', 'Accept-Encoding': 'identity' });
    for (const name of REQUEST_HEADERS) {
      if (request.headers.has(name)) headers.set(name, request.headers.get(name));
    }
    try {
      for (let hop = 0; hop <= 5; hop++) {
        const upstream = await fetch(target.href, {
          method: request.method,
          headers,
          body: request.method === 'POST' ? request.body : undefined,
          redirect: 'manual',
        });
        const location = upstream.headers.get('location');
        if (REDIRECTS.has(upstream.status) && location) {
          await upstream.body?.cancel();
          const next = new URL(location, target);
          if (!allowed(next)) return message('Upstream redirect to an unsupported host was blocked.', 502);
          if (request.method === 'POST') {
            if (!readableGit(next)) return message('Upstream Git redirect was blocked.', 502);
            return new Response(null, {
              status: upstream.status,
              headers: { ...CORS, Location: incoming.origin + '/' + next.href, 'Cache-Control': 'no-store' },
            });
          }
          target = next;
          continue;
        }
        const responseHeaders = new Headers(upstream.headers);
        for (const name of ['set-cookie', 'set-cookie2', 'clear-site-data', 'www-authenticate', 'access-control-allow-credentials', 'access-control-allow-origin', 'content-security-policy', 'content-security-policy-report-only', 'refresh']) {
          responseHeaders.delete(name);
        }
        for (const [name, value] of Object.entries(CORS)) responseHeaders.set(name, value);
        // GitHub hosts user HTML/SVG too; downloaded content must not execute on the proxy origin.
        responseHeaders.set('Content-Security-Policy', "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        responseHeaders.set('X-Content-Type-Options', 'nosniff');
        responseHeaders.set('Referrer-Policy', 'no-referrer');
        return new Response(request.method === 'HEAD' ? null : upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        });
      }
      return message('Too many upstream redirects.', 502);
    } catch {
      return message('Unable to fetch GitHub upstream. Please retry later.', 502);
    }
  },
};

const HOME = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GitHub Proxy</title>
<style>
  :root{color-scheme:light dark;font:16px/1.7 system-ui,sans-serif}
  body{max-width:760px;margin:12vh auto;padding:24px}h1{letter-spacing:-.04em;font-size:2.8rem;margin:0}
  p{opacity:.8}form{display:flex;gap:10px;margin:32px 0}input,button{font:inherit;padding:12px;border:1px solid #8888;border-radius:8px}
  input{min-width:0;flex:1}button{background:#238636;color:white;cursor:pointer}code{overflow-wrap:anywhere}
  @media(max-width:520px){form{flex-direction:column}body{margin-top:5vh}}
</style>
<h1>GitHub Proxy</h1>
<p>通过 Cloudflare 获取 GitHub 公开资源。</p>
<form action="/" method="get"><label for="url" hidden>GitHub 资源链接</label><input id="url" name="url" type="url" placeholder="https://github.com/owner/repo/releases/…" aria-label="GitHub 资源链接" required><button type="submit">获取资源</button></form>
<p>支持 Release、Raw 文件、源码压缩包、Gist、公开 API 和 HTTPS Git clone / fetch。</p>
<p>也可以在完整 GitHub 链接前加上本站地址和斜杠：<br><code>https://你的域名/https://github.com/owner/repo/…</code></p>
<p>支持断点续传；不支持私有仓库、Git push、SSH 或 GitHub 网页完整镜像。速度取决于实际网络链路。</p>
</html>`;
