const express = require('express');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { decryptUpload, LogError } = require('./log-decrypt');
const { receiveUpload } = require('./upload');

function createLogRouter(options = {}) {
    const router = express.Router();
    const parserPath = path.resolve(options.parserPath || process.env.SUD_LOG_PARSER_PATH || path.join(__dirname, 'bin/sud-log-parser-arm64'));
    const tempRoot = options.tempRoot || os.tmpdir();
    let active = 0;
    router.post('/decrypt', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (active >= 2) {
            res.set('Retry-After', '10');
            return res.status(503).json({ error: { code: 'BUSY', message: '当前解密任务较多，请稍后重试。' } });
        }
        active++;
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.once('aborted', abort);
        res.once('close', abort);
        const timer = setTimeout(abort, options.requestTimeoutMs || 300000);
        let workDir;
        let released = false;
        const cleanup = async () => {
            if (released) return;
            released = true;
            clearTimeout(timer);
            req.removeListener('aborted', abort);
            res.removeListener('close', abort);
            if (workDir) await fs.remove(workDir).catch(error => console.error('[Log cleanup]', error.code));
            active--;
        };
        try {
            workDir = await fs.mkdtemp(path.join(tempRoot, 'web-sign-log-'));
            const file = await receiveUpload(req, path.join(workDir, 'upload'), controller.signal);
            if (file.name.includes('/')) throw new LogError(400, 'UNSAFE_NAME', '上传文件名不能包含目录。');
            const result = await decryptUpload({
                input: file.path, originalName: file.name, workDir, parserPath,
                signal: controller.signal, timeoutMs: options.parserTimeoutMs
            });
            if (controller.signal.aborted) throw new LogError(504, 'REQUEST_TIMEOUT', '请求已取消或超过 5 分钟处理时限。');
            res.set({ 'Content-Type': result.type, 'X-Log-Count': String(result.count), 'X-Content-Type-Options': 'nosniff' });
            // The response contains the file itself; no public log download URL is retained.
            await new Promise((resolve, reject) => {
                res.download(result.path, result.name, error => error ? reject(error) : resolve());
            });
        } catch (error) {
            await cleanup();
            if (!res.headersSent && !res.destroyed) {
                if (error instanceof LogError) {
                    res.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.file ? { file: error.file } : {}) } });
                } else {
                    console.error('[Log decrypt]', error.code || error.name);
                    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '日志处理失败，请稍后重试或联系管理员。' } });
                }
            }
        } finally {
            await cleanup();
        }
    });
    return router;
}

module.exports = { createLogRouter };
