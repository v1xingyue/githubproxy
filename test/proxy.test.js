import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const origin = 'https://proxy.example';
const run = (path, init) => worker.fetch(new Request(origin + path, init));

async function withUpstream(mock, check) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await check(); } finally { globalThis.fetch = original; }
}

test('home, HEAD and preflight need no upstream', async () => {
  await withUpstream(() => assert.fail('unexpected upstream request'), async () => {
    assert.match(await (await run('/')).text(), /GitHub Proxy/);
    assert.equal(await (await run('/', { method: 'HEAD' })).text(), '');
    assert.equal((await run('/', { method: 'POST' })).status, 405);
    const response = await run('/https://github.com/a/b', { method: 'OPTIONS' });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  });
});

test('invalid targets and write methods never reach upstream', async () => {
  await withUpstream(() => assert.fail('unexpected upstream request'), async () => {
    for (const path of [
      '/https://example.com/a', '/http://github.com/a', '/https://github.com.evil.test/a',
      '/https://github.com@127.0.0.1/a', '/https://u:p@github.com/a',
      '/https://github.com:8443/a', '/https://127.0.0.1/a',
      '/https://github.com/a/b.git/git-receive-pack',
      '/https://github.com/a/b.git/info/refs?service=git-receive-pack',
    ]) assert.equal((await run(path)).status, 403, path);
    assert.equal((await run('/no-url')).status, 400);
    assert.equal((await run('/?url=oops')).status, 400);
    assert.equal((await run('/https://github.com/a/b', { method: 'DELETE' })).status, 405);
    for (const path of ['/https://api.github.com/repos/a/b/issues', '/https://github.com/a/b.git/git-upload-pack']) {
      assert.equal((await run(path, { method: 'POST', body: 'bad' })).status, 405);
    }
  });
});

test('streams partial downloads with safe headers and intact query strings', async () => {
  await withUpstream(async (url, init) => {
    assert.equal(url, 'https://raw.githubusercontent.com/a/b/main/file?x=1&x=2');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.get('range'), 'bytes=1-3');
    assert.equal(init.headers.get('if-range'), '"v1"');
    assert.equal(init.headers.get('accept-encoding'), 'identity');
    for (const name of ['authorization', 'cookie', 'x-secret', 'origin', 'referer']) assert.equal(init.headers.get(name), null);
    return new Response('bcd', { status: 206, headers: {
      'Content-Range': 'bytes 1-3/10', 'Content-Length': '3', 'Accept-Ranges': 'bytes',
      'Content-Disposition': 'attachment; filename="file"', ETag: '"v1"',
      'Set-Cookie': 'bad=1', 'Clear-Site-Data': '"*"', 'Refresh': '0;url=https://evil.test',
      'Access-Control-Allow-Credentials': 'true',
    } });
  }, async () => {
    const response = await run('/https://raw.githubusercontent.com/a/b/main/file?x=1&x=2', { headers: {
      Range: 'bytes=1-3', 'If-Range': '"v1"', Authorization: 'secret', Cookie: 'private=1',
      'X-Secret': 'secret', Origin: origin, Referer: origin, 'Accept-Encoding': 'gzip',
    } });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), 'bcd');
    assert.equal(response.headers.get('content-range'), 'bytes 1-3/10');
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="file"');
    assert.equal(response.headers.get('etag'), '"v1"');
    for (const name of ['set-cookie', 'clear-site-data', 'refresh', 'access-control-allow-credentials']) assert.equal(response.headers.get(name), null);
    assert.match(response.headers.get('content-security-policy'), /sandbox/);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  });
});

test('query input preserves signed URLs and blob links become raw links', async () => {
  await withUpstream(async url => {
    assert.equal(url, 'https://github.com/a/b/raw/main/file?token=a%2Bb&x=2');
    return new Response('ok');
  }, async () => {
    const target = 'https://github.com/a/b/blob/main/file?token=a%2Bb&x=2';
    assert.equal(await (await run('/?url=' + encodeURIComponent(target))).text(), 'ok');
  });
});

test('follows release redirects through allowed hosts and retains Range', async () => {
  let calls = 0;
  await withUpstream(async (url, init) => {
    assert.equal(init.headers.get('range'), 'bytes=0-2');
    calls++;
    if (calls === 1) return new Response(null, { status: 302, headers: { Location: 'https://release-assets.githubusercontent.com/asset?sig=a%2Bb&x=1' } });
    assert.equal(url, 'https://release-assets.githubusercontent.com/asset?sig=a%2Bb&x=1');
    return new Response('zip');
  }, async () => {
    assert.equal(await (await run('/https://github.com/a/b/releases/download/v1/file.zip', { headers: { Range: 'bytes=0-2' } })).text(), 'zip');
    assert.equal(calls, 2);
  });
});

test('blocks unsafe redirects, redirect loops and network failures', async () => {
  for (const location of ['https://evil.test/file', 'http://github.com/file', 'https://u:p@github.com/file']) {
    let calls = 0;
    await withUpstream(async () => {
      calls++;
      return new Response(null, { status: 302, headers: { Location: location } });
    }, async () => {
      assert.equal((await run('/https://github.com/a/b')).status, 502);
      assert.equal(calls, 1);
    });
  }
  let calls = 0;
  await withUpstream(async () => {
    calls++;
    return new Response(null, { status: 301, headers: { Location: '/loop' } });
  }, async () => {
    assert.equal((await run('/https://github.com/a/b')).status, 502);
    assert.equal(calls, 6);
  });
  await withUpstream(async () => { throw new Error('sensitive internal detail'); }, async () => {
    const response = await run('/https://github.com/a/b');
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /sensitive/);
  });
});

test('Git upload-pack streams body and protocol header; POST redirects stay on proxy', async () => {
  const init = { method: 'POST', body: 'git request', headers: {
    'Content-Type': 'application/x-git-upload-pack-request', 'Git-Protocol': 'version=2',
  } };
  await withUpstream(async (url, options) => {
    assert.equal(options.method, 'POST');
    assert.equal(await new Response(options.body).text(), 'git request');
    assert.equal(options.headers.get('git-protocol'), 'version=2');
    return new Response('pack', { headers: { 'Content-Type': 'application/x-git-upload-pack-result' } });
  }, async () => assert.equal(await (await run('/https://github.com/a/b.git/git-upload-pack', init)).text(), 'pack'));
  await withUpstream(async () => new Response(null, { status: 307, headers: { Location: '/a/c.git/git-upload-pack' } }), async () => {
    const response = await run('/https://github.com/a/b.git/git-upload-pack', init);
    assert.equal(response.status, 307);
    assert.equal(response.headers.get('location'), origin + '/https://github.com/a/c.git/git-upload-pack');
  });
});

test('HEAD, conditional requests and upstream error statuses are preserved', async () => {
  for (const status of [200, 304, 404, 429]) {
    await withUpstream(async (url, init) => {
      assert.equal(init.method, 'HEAD');
      assert.equal(init.headers.get('if-none-match'), '"tag"');
      return new Response(null, { status, headers: { ETag: '"tag"', 'Retry-After': '60' } });
    }, async () => {
      const response = await run('/https://api.github.com/repos/a/b', { method: 'HEAD', headers: { 'If-None-Match': '"tag"' } });
      assert.equal(response.status, status);
      assert.equal(await response.text(), '');
      assert.equal(response.headers.get('retry-after'), '60');
    });
  }
});
