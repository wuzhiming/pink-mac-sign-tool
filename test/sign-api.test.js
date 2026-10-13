const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const AdmZip = require('adm-zip');
const { createSignRouter } = require('../sign-api');

let root, base, server, lastOptions, release;
before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sign-api-test-'));
    const app = express();
    app.use('/api/sign', createSignRouter({ tempRoot: root, processor: async (dir, options, logger) => {
        lastOptions = options;
        const name = (await fs.readdir(dir))[0];
        if (name === 'failure.bin') throw new Error('private server credential');
        if (name === 'empty.bin') return logger('No binaries found to process.');
        if (name === 'verify.bin') return logger('[Warning] Verification failed for fixture');
        if (name === 'slow.bin') await new Promise(resolve => { release = resolve; });
        await fs.writeFile(path.join(dir, 'processed.txt'), 'processor ran');
    } }));
    // Real business logic is used only with a non-binary fixture, never real signing credentials.
    app.use('/real/sign', createSignRouter({ tempRoot: root }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.remove(root);
});
async function post(name, query = '', data = 'fixture', endpoint = '/api/sign') {
    const body = new FormData();
    body.append('file', new Blob([data]), name);
    return fetch(base + endpoint + query, { method: 'POST', body });
}
async function errorIs(response, status, code) {
    assert.equal(response.status, status);
    const result = await response.json();
    assert.equal(result.error.code, code);
    assert.ok(!JSON.stringify(result).includes('private server credential'));
}
async function cleaned() {
    for (let i = 0; i < 100; i++) {
        if (!(await fs.readdir(root)).length) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepEqual(await fs.readdir(root), []);
}
test('single upload returns ZIP and passes explicit boolean options to shared processor', async () => {
    const response = await post('example.bin', '?sign=true&notarize=false&addExecPermission=false');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/zip/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(lastOptions, { sign: true, notarize: false, addExecPermission: false });
    const archive = new AdmZip(Buffer.from(await response.arrayBuffer()));
    assert.equal(archive.readAsText('processed.txt'), 'processor ran');
    assert.equal(archive.readAsText('example.bin'), 'fixture');
    await cleaned();
});
test('ZIP uploads preserve directory structure and omitted options default true', async () => {
    const zip = new AdmZip();
    zip.addFile('nested/example.bin', Buffer.from('fixture'));
    const response = await post('example.zip', '', zip.toBuffer());
    assert.equal(response.status, 200);
    assert.deepEqual(lastOptions, { sign: true, notarize: true, addExecPermission: true });
    const archive = new AdmZip(Buffer.from(await response.arrayBuffer()));
    assert.equal(archive.readAsText('nested/example.bin'), 'fixture');
    await cleaned();
});
test('invalid options, wrong file counts and invalid ZIP are rejected', async () => {
    for (const query of ['?sign=0', '?sign=false&notarize=true', '?unknown=true', '?sign=true&sign=false']) {
        await errorIs(await post('a.bin', query), 400, 'INVALID_OPTIONS');
    }
    const body = new FormData();
    body.append('file', new Blob(['a']), 'a.bin');
    body.append('file', new Blob(['b']), 'b.bin');
    await errorIs(await fetch(base + '/api/sign', { method: 'POST', body }), 400, 'FILE_COUNT');
    await errorIs(await post('broken.zip'), 400, 'INVALID_ZIP');
    await cleaned();
});
test('signing errors, no binaries and verification warnings never return a success ZIP', async () => {
    await errorIs(await post('failure.bin'), 422, 'SIGN_FAILED');
    await errorIs(await post('empty.bin'), 422, 'NO_BINARIES');
    await errorIs(await post('verify.bin'), 422, 'VERIFY_FAILED');
    await errorIs(await post('not-a-binary.txt', '?sign=false&notarize=false&addExecPermission=false', 'plain text', '/real/sign'), 422, 'NO_BINARIES');
    await cleaned();
});
test('busy requests are rejected, then capacity is released', async () => {
    const pending = post('slow.bin');
    for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 10));
    try {
        assert.ok(release);
        const busy = await post('another.bin');
        assert.equal(busy.headers.get('retry-after'), '30');
        await errorIs(busy, 503, 'BUSY');
    } finally { release?.(); }
    const response = await pending;
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    await cleaned();
});
