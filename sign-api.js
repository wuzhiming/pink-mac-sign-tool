const express = require('express');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { receiveUpload, RequestError } = require('./upload');
const signing = require('./sign-logic');

const MAX_UPLOAD = 1024 * 1024 * 1024;
const MAX_EXPANDED = 2 * MAX_UPLOAD;

function readOptions(query) {
    const options = {};
    const keys = ['sign', 'notarize', 'addExecPermission'];
    for (const key of Object.keys(query)) {
        if (!keys.includes(key)) throw new RequestError(400, 'INVALID_OPTIONS', `不支持的参数：${key}`);
    }
    for (const key of keys) {
        const value = query[key] ?? 'true';
        if (value !== 'true' && value !== 'false') throw new RequestError(400, 'INVALID_OPTIONS', `${key} 必须为 true 或 false。`);
        options[key] = value === 'true';
    }
    if (options.notarize && !options.sign) throw new RequestError(400, 'INVALID_OPTIONS', '公证需要同时开启签名。');
    return options;
}

function validateZip(file) {
    try {
        const entries = new AdmZip(file).getEntries();
        if (entries.length > 100000) throw new RequestError(413, 'ZIP_LIMIT', 'ZIP 目录项不能超过 100000 个。');
        let size = 0;
        for (const entry of entries) {
            const name = entry.entryName.replace(/\/$/, '');
            if (!name || /[\\:\x00-\x1f\x7f]/.test(name) || name.split('/').some(part => !part || part === '..' || part === '.')) {
                throw new RequestError(400, 'UNSAFE_ZIP', 'ZIP 包含不安全的路径。');
            }
            if (entry.header.encrypted) throw new RequestError(400, 'ENCRYPTED_ZIP', '请上传未设置密码的 ZIP。');
            size += entry.header.size;
            if (size > MAX_EXPANDED) throw new RequestError(413, 'ZIP_LIMIT', 'ZIP 解压后不能超过 2 GiB。');
        }
    } catch (error) {
        if (error instanceof RequestError) throw error;
        throw new RequestError(400, 'INVALID_ZIP', '无法读取 ZIP，请检查文件是否损坏。');
    }
}

function createSignRouter({ processor = signing.processBinaries, tempRoot = os.tmpdir() } = {}) {
    const router = express.Router();
    let active = false;
    router.post('/', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (active) {
            res.set('Retry-After', '30');
            return res.status(503).json({ error: { code: 'BUSY', message: '签名接口正在处理其他任务，请稍后重试。' } });
        }
        active = true;
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.once('aborted', abort);
        res.once('close', abort);
        // Upload has its own deadline; notarization can take much longer.
        const uploadTimer = setTimeout(abort, 10 * 60 * 1000);
        let workDir;
        let released = false;
        const cleanup = async () => {
            if (released) return;
            released = true;
            clearTimeout(uploadTimer);
            req.removeListener('aborted', abort);
            res.removeListener('close', abort);
            if (workDir) await fs.remove(workDir).catch(error => console.error('[Sign cleanup]', error.code));
            active = false;
        };
        try {
            const options = readOptions(req.query);
            // Long-running HTTP response; reverse proxies need matching timeouts.
            res.setTimeout(0);
            workDir = await fs.mkdtemp(path.join(tempRoot, 'web-sign-api-'));
            const file = await receiveUpload(req, path.join(workDir, 'upload'), controller.signal, MAX_UPLOAD);
            clearTimeout(uploadTimer);
            if (/[\\/:\x00-\x1f\x7f]/.test(file.name) || file.name === '.' || file.name === '..' || Buffer.byteLength(file.name) > 220) {
                throw new RequestError(400, 'UNSAFE_NAME', '上传文件名无效。');
            }
            const inputDir = path.join(workDir, 'input');
            await fs.ensureDir(inputDir);
            if (path.extname(file.name).toLowerCase() === '.zip') {
                validateZip(file.path);
                try { signing.unzip(file.path, inputDir); }
                catch { throw new RequestError(400, 'INVALID_ZIP', 'ZIP 无法解压，请检查文件是否损坏。'); }
            } else {
                await fs.move(file.path, path.join(inputDir, file.name));
            }
            const checkConnection = () => {
                if (controller.signal.aborted) throw new RequestError(408, 'CANCELLED', '客户端已断开连接。');
            };
            checkConnection();
            const warnings = [];
            let noBinaries = false;
            try {
                await processor(inputDir, options, message => {
                    checkConnection();
                    if (message === 'No binaries found to process.') noBinaries = true;
                    if (message.includes('[Warning] Verification failed')) warnings.push(message);
                }, { signal: controller.signal, killSignal: 'SIGKILL' });
            } catch (error) {
                if (error instanceof RequestError) throw error;
                // Do not echo command output or server credentials to callers.
                console.error('[Sign API] Processing failed:', error.name);
                throw new RequestError(422, 'SIGN_FAILED', '签名或公证失败，请管理员检查服务器日志、签名证书及 Apple 配置。');
            }
            checkConnection();
            if (noBinaries) throw new RequestError(422, 'NO_BINARIES', '未找到可处理的二进制文件。');
            if (warnings.length) throw new RequestError(422, 'VERIFY_FAILED', '处理后的签名验证未通过，请管理员检查服务器日志。');
            const output = path.join(workDir, 'result.zip');
            await signing.createZip(inputDir, output);
            checkConnection();
            res.set({ 'Content-Type': 'application/zip', 'X-Content-Type-Options': 'nosniff' });
            await new Promise((resolve, reject) => {
                res.download(output, `${file.name}_processed.zip`, error => error ? reject(error) : resolve());
            });
        } catch (error) {
            await cleanup();
            if (!res.headersSent && !res.destroyed) {
                const known = error instanceof RequestError;
                res.status(known ? error.status : 500).json({ error: {
                    code: known ? error.code : 'INTERNAL_ERROR',
                    message: known ? error.message : '签名请求处理失败，请联系管理员。'
                } });
            }
        } finally {
            await cleanup();
        }
    });
    return router;
}

module.exports = { createSignRouter };
