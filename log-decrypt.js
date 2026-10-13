const path = require('node:path');
const fs = require('fs-extra');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const AdmZip = require('adm-zip');
const archiver = require('archiver');

const execute = promisify(execFile);
const LIMITS = Object.freeze({ uploadBytes: 100 * 1024 * 1024, expandedBytes: 256 * 1024 * 1024, files: 200 });

const { RequestError: LogError } = require('./upload');

function checkName(name) {
    const parts = name.split('/');
    if (!name || name.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(name) ||
        parts.some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 220)) {
        throw new LogError(400, 'UNSAFE_NAME', '文件名或 ZIP 路径无效。');
    }
    return name;
}

function isMetadata(name) {
    return name.split('/').some(part => part === '__MACOSX' || part === '.DS_Store' || part.startsWith('._'));
}

function readArchive(input) {
    try {
        const zip = new AdmZip(input);
        const entries = zip.getEntries();
        if (entries.length > 1000) throw new LogError(413, 'ZIP_LIMIT', 'ZIP 目录项过多。');
        const files = [];
        const names = new Set();
        let size = 0;
        for (const entry of entries) {
            const name = checkName(entry.entryName.replace(/\/$/, ''));
            const kind = (entry.attr >>> 16) & 0xf000;
            if (kind && kind !== 0x8000 && kind !== 0x4000) {
                throw new LogError(400, 'UNSAFE_ZIP', 'ZIP 不支持符号链接或特殊文件。', name);
            }
            if (entry.isDirectory || isMetadata(name)) continue;
            const key = name.normalize('NFC').toLowerCase();
            if (names.has(key)) throw new LogError(400, 'DUPLICATE_PATH', 'ZIP 中存在重复文件路径。', name);
            names.add(key);
            if (entry.header.encrypted) throw new LogError(400, 'ENCRYPTED_ZIP', '请上传未设置密码的 ZIP。', name);
            if (path.extname(name).toLowerCase() === '.zip') {
                throw new LogError(400, 'NESTED_ZIP', '请将日志直接放入 ZIP，不支持嵌套 ZIP。', name);
            }
            if (!entry.header.size) throw new LogError(422, 'EMPTY_LOG', 'ZIP 中包含空日志。', name);
            size += entry.header.size;
            if (entry.header.size > LIMITS.uploadBytes || size > LIMITS.expandedBytes || files.length >= LIMITS.files) {
                throw new LogError(413, 'ZIP_LIMIT', 'ZIP 最多 200 个日志，单个 100 MiB，解压后合计不超过 256 MiB。');
            }
            files.push({ name, entry });
        }
        if (!files.length) throw new LogError(400, 'EMPTY_ZIP', 'ZIP 内没有可处理的日志。');
        for (const { name } of files) {
            const parts = name.normalize('NFC').toLowerCase().split('/');
            parts.pop();
            while (parts.length) {
                if (names.has(parts.join('/'))) throw new LogError(400, 'DUPLICATE_PATH', 'ZIP 文件路径与目录冲突。', name);
                parts.pop();
            }
        }
        return files;
    } catch (error) {
        if (error instanceof LogError) throw error;
        throw new LogError(400, 'INVALID_ZIP', '无法读取 ZIP，请检查文件是否损坏。');
    }
}

async function runParser(parserPath, input, cwd, { signal, timeoutMs }) {
    let diagnostics;
    try {
        const result = await execute(parserPath, [input], {
            cwd, signal, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
            env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: cwd }
        });
        diagnostics = result.stdout + result.stderr;
    } catch (error) {
        if (signal?.aborted) throw new LogError(408, 'CANCELLED', '请求已取消或超过处理时限。');
        if (['ENOENT', 'EACCES', 'ENOEXEC', 'UNKNOWN'].includes(error.code)) {
            throw new LogError(503, 'PARSER_UNAVAILABLE', '解密工具无法运行，请管理员检查路径、执行权限和系统架构。');
        }
        if (error.killed) throw new LogError(504, 'PARSER_TIMEOUT', '日志处理超时，请拆分日志后重试。');
        throw new LogError(422, 'DECRYPT_FAILED', '日志解密失败，请确认日志格式和完整性。');
    }
    // This parser may exit 0 even after a decoding error. Do not return partial output.
    if (/\b(?:err|error|failed|failure|panic|invalid)\b/i.test(diagnostics)) {
        throw new LogError(422, 'DECRYPT_FAILED', '日志包含无法解密的数据，请确认日志格式和完整性。');
    }
    const output = path.join(cwd, 'decrypt_source.txt');
    const stat = await fs.stat(output).catch(() => null);
    if (!stat?.isFile() || !stat.size) throw new LogError(422, 'EMPTY_RESULT', '未生成有效解密日志，请检查输入文件。');
    if (stat.size > LIMITS.expandedBytes) throw new LogError(413, 'OUTPUT_LIMIT', '解密结果过大，请拆分日志后重试。');
    return output;
}

async function packageResults(directory, target) {
    const stream = fs.createWriteStream(target);
    const archive = archiver('zip', { zlib: { level: 6 } });
    await new Promise((resolve, reject) => {
        stream.on('close', resolve);
        const fail = error => { archive.abort(); stream.destroy(); reject(error); };
        stream.on('error', fail);
        archive.on('error', fail);
        archive.on('warning', fail);
        archive.pipe(stream);
        archive.directory(directory, false);
        archive.finalize().catch(fail);
    });
}

async function decryptUpload({ input, originalName, workDir, parserPath, signal, timeoutMs = 120000 }) {
    checkName(originalName);
    const isZip = path.extname(originalName).toLowerCase() === '.zip';
    const files = isZip ? readArchive(input) : [{ name: originalName }];
    const results = path.join(workDir, 'results');
    await fs.ensureDir(results);
    let outputBytes = 0;
    for (const [index, file] of files.entries()) {
        if (signal?.aborted) throw new LogError(408, 'CANCELLED', '请求已取消或超过处理时限。');
        // Separate working directories prevent collisions between equal basenames.
        const cwd = path.join(workDir, `item-${index}`);
        await fs.ensureDir(cwd);
        const source = path.join(cwd, 'source.txt');
        if (file.entry) {
            try {
                const data = file.entry.getData();
                if (data.length !== file.entry.header.size) throw new Error('Size mismatch');
                await fs.writeFile(source, data);
            } catch {
                throw new LogError(400, 'INVALID_ZIP', 'ZIP 内的日志损坏或无法解压。', file.name);
            }
        } else {
            await fs.copy(input, source);
        }
        let output;
        try {
            output = await runParser(parserPath, source, cwd, { signal, timeoutMs });
        } catch (error) {
            if (error instanceof LogError) error.file = file.name;
            throw error;
        }
        outputBytes += (await fs.stat(output)).size;
        if (outputBytes > LIMITS.expandedBytes) throw new LogError(413, 'OUTPUT_LIMIT', '解密结果合计超过 256 MiB，请拆分 ZIP。');
        const resultName = isZip ? file.name : `decrypt_${file.name}`;
        await fs.move(output, path.join(results, resultName));
        await fs.remove(cwd);
    }
    if (signal?.aborted) throw new LogError(408, 'CANCELLED', '请求已取消或超过处理时限。');
    if (isZip) {
        const target = path.join(workDir, 'result.zip');
        await packageResults(results, target);
        return { path: target, name: `${originalName.slice(0, -4)}_decrypted.zip`, type: 'application/zip', count: files.length };
    }
    return { path: path.join(results, `decrypt_${originalName}`), name: `decrypt_${originalName}`, type: 'text/plain; charset=utf-8', count: 1 };
}

module.exports = { decryptUpload, LogError, LIMITS };
