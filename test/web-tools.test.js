import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { gzipSync } from 'node:zlib';
import { extractWebText, isPublicAddress, requestWebPage, webFetch, webSearch, webUrl } from '../src/core/web-tools.js';

const html = '<html><head><title>Fixture &amp; title</title><script>do not show</script></head><body><nav>navigation</nav><main><h1>Headline</h1><p>Useful <b>content</b>.</p><p hidden>hidden secret</p><a href="/source?a=1&amp;b=2">Source</a></main><footer>footer</footer></body></html>';

test('public URL checks reject credential, local, metadata, encoded IP, and private IPv6 targets', () => {
  for (const url of ['file:///etc/passwd', 'https://user:pass@example.com', 'http://localhost', 'http://service.local', 'http://2130706433', 'http://0x7f000001', 'http://169.254.169.254', 'http://[::ffff:127.0.0.1]', 'http://[::1]']) assert.throws(() => webUrl(url));
  for (const ip of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '172.16.0.1', '192.168.0.1', '100.100.100.200', '169.254.169.254', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  assert.equal(webUrl('https://example.com/path#fragment').href, 'https://example.com/path');
});

test('HTML extraction removes executable/hidden content, preserves sources and bounds output', async () => {
  const extracted = extractWebText(html, 'https://example.com');
  assert.equal(extracted.title, 'Fixture & title');
  assert.match(extracted.content, /Headline/);
  assert.match(extracted.content, /Useful content/);
  assert.doesNotMatch(extracted.content, /navigation|secret|do not show|footer/);
  assert.equal(extracted.links[0].url, 'https://example.com/source?a=1&b=2');
  const fetched = await webFetch({ url: 'https://example.com', maxChars: 1000 }, {}, async () => ({ url: 'https://example.com/final', contentType: 'text/html', text: html.replace('Useful', 'x'.repeat(2000)) }));
  assert.equal(fetched.content.length, 1000);
  assert.equal(fetched.truncated, true);
  assert.equal(fetched.untrusted, true);
});

test('search parses real-format RSS with escaped URLs and no fabricated fallback results', async () => {
  const rss = '<rss><channel><item><title>A &amp; B</title><link>https://example.com/?a=1&amp;b=2</link><description><![CDATA[<b>Result</b> text]]></description></item><item><title>Local</title><link>http://127.0.0.1/</link></item></channel></rss>';
  const found = await webSearch({ query: 'a & b', maxResults: 5 }, {}, async url => {
    assert.equal(new URL(url).searchParams.get('q'), 'a & b');
    return { text: rss };
  });
  assert.deepEqual(found.results, [{ title: 'A & B', url: 'https://example.com/?a=1&b=2', snippet: 'Result text' }]);
  await assert.rejects(webSearch({ query: 'query' }, {}, async () => ({ text: '<html>captcha</html>' })), /验证|限流/);
  assert.deepEqual((await webSearch({ query: 'query' }, {}, async () => ({ text: '<rss><channel/></rss>' }))).results, []);
});

test('HTTP reader pins DNS, checks redirects, handles compressed content, cancels and limits bodies', async context => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie });
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://fixture.example/html' }); res.end(); }
    else if (req.url === '/private') { res.writeHead(302, { location: 'http://127.0.0.1/private' }); res.end(); }
    else if (req.url === '/binary') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end('binary'); }
    else if (req.url === '/slow') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('started'); }
    else { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' }); res.end(gzipSync(req.url === '/large' ? 'x'.repeat(2 * 1024 * 1024 + 1) : html)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const transport = (url, options, callback) => {
    options.lookup(url.hostname, {}, (error, address, family) => { assert.ifError(error); assert.equal(address, '1.1.1.1'); assert.equal(family, 4); });
    return request(`http://127.0.0.1:${server.address().port}${url.pathname}`, { ...options, lookup: undefined }, callback);
  };
  const options = { lookup: async () => [{ address: '1.1.1.1', family: 4 }], request: transport };
  assert.equal((await requestWebPage('http://fixture.example/redirect', options)).text, html);
  await assert.rejects(requestWebPage('http://fixture.example/private', options), /公开网站/);
  await assert.rejects(requestWebPage('http://fixture.example/binary', options), /二进制/);
  await assert.rejects(requestWebPage('http://fixture.example/large', options), /2 MiB/);
  await assert.rejects(requestWebPage('http://fixture.example/slow', { ...options, timeoutMs: 100 }), /abort|timeout|aborted/i);
  await assert.rejects(requestWebPage('http://fixture.example/html', { ...options, lookup: async () => [{ address: '127.0.0.1', family: 4 }] }), /保留地址/);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(requestWebPage('http://fixture.example/html', { ...options, signal: controller.signal }), /cancelled/);
  assert.ok(seen.every(item => !item.authorization && !item.cookie));
});
