const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const express = require('express');
const AdmZip = require('adm-zip');
const { createLogRouter } = require('../log-api');

let root, work, server, base;
before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'log-api-test-'));
    work = path.join(root, 'requests');
    await fs.ensureDir(work);
    const parser = path.join(root, 'parser');
    await fs.writeFile(parser, `#!${process.execPath}
const fs = require('node:fs');
const input = fs.readFileSync(process.argv[2], 'utf8');
if (input === 'slow') { setTimeout(() => {}, 10000); }
else if (input === 'bad') { console.error('base64 decode err: invalid data'); fs.writeFileSync('decrypt_source.txt', 'partial'); }
else if (input === 'empty') { fs.writeFileSync('decrypt_source.txt', ''); }
else { fs.writeFileSync('decrypt_source.txt', 'decoded:' + input); }
`, { mode: 0o755 });
    const app = express();
    app.use('/api/logs', createLogRouter({ parserPath: parser, tempRoot: work, parserTimeoutMs: 3000, requestTimeoutMs: 10000 }));
    app.use('/timeout', createLogRouter({ parserPath: parser, tempRoot: work, parserTimeoutMs: 300 }));
    app.use('/missing', createLogRouter({ parserPath: path.join(root, 'missing'), tempRoot: work }));
    app.use('/real', createLogRouter({ tempRoot: work }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.remove(root);
});

async function post(data, name = 'sample.txt', route = '/api/logs/decrypt') {
    const body = new FormData();
    body.append('file', new Blob([data]), name);
    return fetch(base + route, { method: 'POST', body });
}
function zip(files) {
    const archive = new AdmZip();
    for (const [name, data] of Object.entries(files)) archive.addFile(name, Buffer.from(data));
    return archive.toBuffer();
}
async function errorIs(response, status, code) {
    assert.equal(response.status, status);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const body = await response.json();
    assert.equal(body.error.code, code);
    return body.error;
}
async function cleaned() {
    // res.download completes just before asynchronous removal.
    for (let i = 0; i < 100; i++) {
        if (!(await fs.readdir(work)).length) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepEqual(await fs.readdir(work), []);
}

test('single file is returned as an attachment with a Unicode filename', async () => {
    const response = await post('encrypted', '中文 日志.txt');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''decrypt_%E4%B8%AD/);
    assert.match(response.headers.get('content-type'), /text\/plain/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-log-count'), '1');
    assert.equal(await response.text(), 'decoded:encrypted');
    await cleaned();
});

test('ZIP keeps directory names, isolates duplicate basenames, excludes metadata', async () => {
    const response = await post(zip({ 'a/same.txt': 'one', '中文/same.txt': 'two', '__MACOSX/._same.txt': 'ignored', '.DS_Store': 'ignored' }), 'logs.ZIP');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-log-count'), '2');
    const result = new AdmZip(Buffer.from(await response.arrayBuffer()));
    assert.deepEqual(result.getEntries().filter(e => !e.isDirectory).map(e => e.entryName), ['a/same.txt', '中文/same.txt']);
    assert.equal(result.readAsText('a/same.txt'), 'decoded:one');
    assert.equal(result.readAsText('中文/same.txt'), 'decoded:two');
    await cleaned();
});

test('parser errors with exit code 0 and empty results are rejected', async () => {
    await errorIs(await post('bad'), 422, 'DECRYPT_FAILED');
    await errorIs(await post('empty'), 422, 'EMPTY_RESULT');
    await errorIs(await post(''), 422, 'EMPTY_LOG');
    const error = await errorIs(await post(zip({ 'a.txt': 'good', 'b.txt': 'bad' }), 'batch.zip'), 422, 'DECRYPT_FAILED');
    assert.equal(error.file, 'b.txt');
    await cleaned();
});

test('malformed, nested, empty, duplicate-path and over-limit ZIPs fail clearly', async () => {
    await errorIs(await post('not a zip', 'logs.zip'), 400, 'INVALID_ZIP');
    await errorIs(await post(zip({}), 'logs.zip'), 400, 'EMPTY_ZIP');
    await errorIs(await post(zip({ 'inner.zip': 'x' }), 'logs.zip'), 400, 'NESTED_ZIP');
    await errorIs(await post(zip({ 'a.txt': '' }), 'logs.zip'), 422, 'EMPTY_LOG');
    await errorIs(await post(zip({ 'A.txt': 'a', 'a.txt': 'b' }), 'logs.zip'), 400, 'DUPLICATE_PATH');
    await errorIs(await post(zip(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`${i}.txt`, 'x']))), 'logs.zip'), 413, 'ZIP_LIMIT');
    await cleaned();
});

test('ZIP traversal, symlinks and oversized declared entries are rejected', async () => {
    const archive = zip({ 'xx/evil.txt': 'x' });
    // Patch both headers; addFile itself normalizes unsafe paths.
    const unsafe = Buffer.from(archive);
    for (let at = unsafe.indexOf('xx/evil.txt'); at !== -1; at = unsafe.indexOf('xx/evil.txt', at + 1)) unsafe.write('../evil.txt', at);
    await errorIs(await post(unsafe, 'unsafe.zip'), 400, 'UNSAFE_NAME');
    const symlink = new AdmZip();
    symlink.addFile('link', Buffer.from('/etc/passwd'));
    symlink.getEntry('link').attr = (0o120777 << 16) >>> 0;
    await errorIs(await post(symlink.toBuffer(), 'link.zip'), 400, 'UNSAFE_ZIP');
    const oversized = zip({ 'large.txt': 'x' });
    const central = oversized.indexOf(Buffer.from('504b0102', 'hex'));
    oversized.writeUInt32LE(101 * 1024 * 1024, central + 24);
    await errorIs(await post(oversized, 'large.zip'), 413, 'ZIP_LIMIT');
    await cleaned();
});

test('multipart contract rejects missing, extra and incorrect fields', async () => {
    const missing = new FormData();
    await errorIs(await fetch(base + '/api/logs/decrypt', { method: 'POST', body: missing }), 400, 'FILE_REQUIRED');
    for (const field of ['wrong', 'file']) {
        const body = new FormData();
        body.append(field, new Blob(['x']), 'a.txt');
        if (field === 'file') body.append('file', new Blob(['x']), 'b.txt');
        await errorIs(await fetch(base + '/api/logs/decrypt', { method: 'POST', body }), 400, 'FILE_COUNT');
    }
    await errorIs(await fetch(base + '/api/logs/decrypt', { method: 'POST', body: 'text' }), 400, 'INVALID_MULTIPART');
    await errorIs(await fetch(base + '/api/logs/decrypt', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=oops' }, body: '--oops\r\n' }), 400, 'INVALID_MULTIPART');
    await cleaned();
});

test('missing parser and timed-out parser return actionable failures', async () => {
    await errorIs(await post('x', 'a.txt', '/missing/decrypt'), 503, 'PARSER_UNAVAILABLE');
    await errorIs(await post('slow', 'a.txt', '/timeout/decrypt'), 504, 'PARSER_TIMEOUT');
    await cleaned();
});

test('aborted upload closes streams, cleans temporary files, and releases capacity', async () => {
    const request = http.request(base + '/api/logs/decrypt', {
        method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test' }
    });
    request.on('error', () => {});
    request.write('--test\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\npartial');
    await new Promise(resolve => setTimeout(resolve, 100));
    request.destroy();
    await cleaned();
    const response = await post('after abort');
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    await cleaned();
});

test('upload limit stops oversized log and cleans it', async () => {
    const response = await post(Buffer.alloc(100 * 1024 * 1024 + 1, 97));
    await errorIs(response, 413, 'UPLOAD_LIMIT');
    await cleaned();
});

test('real binary: sample prefix and a two-log ZIP match direct parser output', { skip: !process.env.SUD_LOG_TEST_FILE }, async () => {
    // Preserve the header and complete lines, never upload or commit the full private log.
    const handle = await fs.open(process.env.SUD_LOG_TEST_FILE, 'r');
    const chunk = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fs.read(handle, chunk, 0, chunk.length, 0);
    await fs.close(handle);
    const sample = chunk.subarray(0, bytesRead).toString().split('\n').slice(0, 20).join('\n') + '\n';
    const baseline = path.join(root, 'baseline');
    await fs.ensureDir(baseline);
    await fs.writeFile(path.join(baseline, 'sample.txt'), sample);
    execFileSync(path.resolve(__dirname, '../bin/sud-log-parser-arm64'), [path.join(baseline, 'sample.txt')], { cwd: baseline, stdio: 'pipe' });
    const expected = await fs.readFile(path.join(baseline, 'decrypt_sample.txt'));
    assert.ok(expected.length > 0);
    assert.notDeepEqual(expected, Buffer.from(sample));
    const single = await post(sample, 'sample.txt', '/real/decrypt');
    assert.equal(single.status, 200);
    assert.deepEqual(Buffer.from(await single.arrayBuffer()), expected);
    const batch = await post(zip({ 'a/sample.txt': sample, 'b/sample.txt': sample }), 'logs.zip', '/real/decrypt');
    assert.equal(batch.status, 200);
    const result = new AdmZip(Buffer.from(await batch.arrayBuffer()));
    assert.deepEqual(result.readFile('a/sample.txt'), expected);
    assert.deepEqual(result.readFile('b/sample.txt'), expected);
    const corrupt = await post(sample + 'this is not valid base64!\n', 'bad.txt', '/real/decrypt');
    await errorIs(corrupt, 422, 'DECRYPT_FAILED');
    await cleaned();
});
