const Busboy = require('busboy');
const { pipeline } = require('node:stream/promises');
const fs = require('fs-extra');

class RequestError extends Error {
    constructor(status, code, message, file) {
        super(message);
        Object.assign(this, { status, code, file });
    }
}

async function receiveUpload(req, target, signal, maxBytes = 100 * 1024 * 1024) {
    let parser;
    try {
        parser = Busboy({ headers: req.headers, defParamCharset: 'utf8', preservePath: true,
            limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 2 } });
    } catch {
        throw new RequestError(400, 'INVALID_MULTIPART', '请使用 multipart/form-data 上传，并提供正确的 boundary。');
    }
    let file;
    let failure;
    const writes = [];
    const fail = error => { failure ||= error; };
    const extraParts = () => fail(new RequestError(400, 'FILE_COUNT', '每次只能通过 file 字段上传一个文件；多个日志请先打包为 ZIP。'));
    parser.on('filesLimit', extraParts).on('fieldsLimit', extraParts).on('partsLimit', extraParts);
    parser.on('file', (field, stream, info) => {
        if (field !== 'file' || !info.filename) {
            extraParts();
            stream.on('error', fail);
            stream.resume();
            return;
        }
        file = { path: target, name: info.filename };
        stream.on('limit', () => fail(new RequestError(413, 'UPLOAD_LIMIT', `上传文件不能超过 ${maxBytes / 1024 / 1024} MiB。`)));
        writes.push(pipeline(stream, fs.createWriteStream(target, { flags: 'wx' }), { signal }).catch(fail));
    });
    const abort = () => {
        parser.destroy(new RequestError(408, 'CANCELLED', '上传已取消或超时。'));
        req.destroy();
    };
    const onRequestError = error => parser.destroy(error);
    req.on('error', onRequestError);
    signal.addEventListener('abort', abort, { once: true });
    try {
        await new Promise(resolve => {
            parser.on('error', fail);
            parser.on('close', resolve);
            req.pipe(parser);
            if (signal.aborted) abort();
        });
        await Promise.all(writes);
        if (failure) {
            if (failure instanceof RequestError) throw failure;
            throw new RequestError(400, 'INVALID_MULTIPART', '上传内容不完整或格式错误。');
        }
        if (!file) throw new RequestError(400, 'FILE_REQUIRED', '请通过 multipart/form-data 的 file 字段上传一个文件或 ZIP。');
        if (!(await fs.stat(target)).size) throw new RequestError(422, 'EMPTY_LOG', '上传的文件为空。');
        return file;
    } finally {
        req.unpipe(parser);
        req.removeListener('error', onRequestError);
        signal.removeEventListener('abort', abort);
    }
}

module.exports = { receiveUpload, RequestError };
