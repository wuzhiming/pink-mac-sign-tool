(() => {
    const signTab = document.getElementById('sign-tab');
    const decryptTab = document.getElementById('decrypt-tab');
    const signPanel = document.getElementById('sign-panel');
    const decryptPanel = document.getElementById('decrypt-panel');
    function selectTool(decrypt) {
        signPanel.classList.toggle('hidden', decrypt);
        decryptPanel.classList.toggle('hidden', !decrypt);
        signTab.classList.toggle('active', !decrypt);
        decryptTab.classList.toggle('active', decrypt);
        const activeTab = decrypt ? decryptTab : signTab;
        const inactiveTab = decrypt ? signTab : decryptTab;
        activeTab.setAttribute('aria-current', 'page');
        inactiveTab.removeAttribute('aria-current');
        document.title = decrypt ? 'SUD 日志解密 · PinK 开发工具' : 'macOS 签名与公证 · PinK 开发工具';
    }
    selectTool(/^\/logs\/?$/.test(location.pathname));

    const form = document.getElementById('decrypt-form');
    const input = document.getElementById('log-file');
    const button = document.getElementById('decrypt-btn');
    const status = document.getElementById('decrypt-status');
    const dropZone = document.getElementById('log-drop-zone');
    const queueSection = document.getElementById('log-queue-section');
    const queueList = document.getElementById('log-queue');
    const queueCount = document.getElementById('log-queue-count');
    const clearButton = document.getElementById('clear-logs');
    let items = [];
    let busy = false;
    let dragDepth = 0;

    function updateControls() {
        const pending = items.filter(item => item.state !== 'done');
        button.disabled = busy || !pending.length;
        button.textContent = busy ? '正在解密…' : (pending.length ? `解密 ${pending.length} 个文件` : '解密并生成下载文件');
        input.disabled = busy;
        dropZone.disabled = busy;
        clearButton.disabled = busy;
        queueSection.classList.toggle('hidden', !items.length);
        queueCount.textContent = `共 ${items.length} 个文件`;
        for (const item of items) item.remove.disabled = busy;
    }

    function release(item) {
        if (item.url) URL.revokeObjectURL(item.url);
    }

    function addFiles(files) {
        if (busy) return;
        let added = 0;
        for (const file of files) {
            if (items.some(item => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) continue;
            const row = document.createElement('li');
            row.className = 'log-queue-item';
            const info = document.createElement('div');
            info.className = 'log-item-info';
            const name = document.createElement('p');
            name.className = 'log-item-name';
            name.textContent = file.name;
            const message = document.createElement('p');
            message.className = 'log-item-status';
            message.textContent = `等待解密 · ${(file.size / 1024).toFixed(1)} KiB`;
            info.append(name, message);
            const actions = document.createElement('div');
            actions.className = 'log-item-actions';
            const download = document.createElement('a');
            download.className = 'download-btn hidden';
            download.textContent = '下载';
            download.setAttribute('aria-label', `下载 ${file.name} 的解密结果`);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'btn-icon';
            remove.textContent = '×';
            remove.setAttribute('aria-label', `移除 ${file.name}`);
            actions.append(download, remove);
            row.append(info, actions);
            queueList.append(row);
            const item = { file, state: 'queued', row, message, download, remove, url: null };
            items.push(item);
            remove.addEventListener('click', () => {
                if (busy) return;
                release(item);
                items = items.filter(entry => entry !== item);
                row.remove();
                status.textContent = '';
                updateControls();
            });
            added++;
        }
        status.classList.remove('error');
        status.textContent = added ? `已添加 ${added} 个文件，点击解密按钮开始处理。` : '这些文件已在列表中。';
        updateControls();
    }

    dropZone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
        addFiles(input.files);
        input.value = '';
    });
    dropZone.addEventListener('dragenter', event => {
        event.preventDefault();
        if (!busy && ++dragDepth) dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragover', event => {
        event.preventDefault();
        event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
    });
    dropZone.addEventListener('dragleave', event => {
        event.preventDefault();
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) dropZone.classList.remove('drag-over');
    });
    dropZone.addEventListener('drop', event => {
        event.preventDefault();
        dragDepth = 0;
        dropZone.classList.remove('drag-over');
        addFiles(event.dataTransfer.files);
    });
    // Avoid navigating away from results if files miss the drop target.
    if (/^\/logs\/?$/.test(location.pathname)) {
        for (const type of ['dragover', 'drop']) {
            window.addEventListener(type, event => {
                if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
            });
        }
    }
    clearButton.addEventListener('click', () => {
        if (busy) return;
        items.forEach(release);
        items = [];
        queueList.replaceChildren();
        status.textContent = '';
        updateControls();
    });

    async function decryptItem(item) {
        const { file, message, download } = item;
        message.className = 'log-item-status';
        item.state = 'processing';
        message.textContent = '正在上传并解密…';
        try {
            if (!file.size) throw new Error('文件为空，或拖入的是目录；请上传日志或 ZIP。');
            if (file.size > 100 * 1024 * 1024) throw new Error('文件超过 100 MiB，请拆分后重试。');
            const body = new FormData();
            body.append('file', file);
            const response = await fetch('/api/logs/decrypt', { method: 'POST', body });
            if (!response.ok) {
                const result = await response.json().catch(() => null);
                const error = result?.error;
                throw new Error(error ? `${error.message}${error.file ? `（${error.file}）` : ''}` : `请求失败（HTTP ${response.status}）`);
            }
            const blob = await response.blob();
            const disposition = response.headers.get('Content-Disposition') || '';
            const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i);
            const plainName = disposition.match(/filename="([^"]+)"/i);
            const fallback = /\.zip$/i.test(file.name) ? `${file.name.slice(0, -4)}_decrypted.zip` : `decrypt_${file.name}`;
            download.download = encodedName ? decodeURIComponent(encodedName[1]) : (plainName?.[1] || fallback);
            item.url = URL.createObjectURL(blob);
            download.href = item.url;
            download.classList.remove('hidden');
            message.classList.add('success');
            message.textContent = `解密完成 · ${response.headers.get('X-Log-Count') || 1} 个日志`;
            item.state = 'done';
        } catch (error) {
            item.state = 'failed';
            message.classList.add('error');
            message.textContent = error.message === 'Failed to fetch' ? '连接中断，请确认服务可访问后重试。' : error.message;
        }
    }

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy) return;
        const pending = items.filter(item => item.state !== 'done');
        if (!pending.length) return;
        busy = true;
        status.classList.remove('error');
        updateControls();
        // One HTTP request per file keeps results independent and avoids flooding the service.
        for (const [index, item] of pending.entries()) {
            status.textContent = `正在处理 ${index + 1} / ${pending.length}：${item.file.name}`;
            await decryptItem(item);
        }
        const failed = pending.filter(item => item.state === 'failed').length;
        status.textContent = `本次处理完成：${pending.length - failed} 个成功${failed ? `，${failed} 个失败，可重试失败文件` : ''}。请在列表中分别下载结果。`;
        status.classList.toggle('error', !!failed);
        busy = false;
        updateControls();
    });
    window.addEventListener('pagehide', event => {
        if (!event.persisted) items.forEach(release);
    });

    const instructions = document.getElementById('ai-instructions');
    instructions.value = `请使用以下 HTTP 接口解密我提供的 SUD 日志：

POST ${location.origin}/api/logs/decrypt
请求：multipart/form-data，仅一个文件字段 file。不要手动设置 Content-Type，客户端需自动生成 boundary。
每次请求上传一个日志或 ZIP。多个日志需要独立结果时，请逐个发起请求；需要一个批量结果包时，先将日志打包为 ZIP。网页多文件拖拽也是逐个调用此接口。接口同步处理，无需 Socket.io 或轮询。
成功：HTTP 200，响应体就是解密文件。单文件返回 UTF-8 文本；ZIP 返回 application/zip，保留原目录和日志文件名。文件名见 Content-Disposition，日志数量见 X-Log-Count。
失败：非 2xx，JSON 格式 {"error":{"code":"...","message":"...","file":"可选，出错的日志路径"}}。不要将错误 JSON 当成解密结果。

单文件示例（替换本地路径）：
curl --fail-with-body --max-time 360 -F 'file=@/path/to/input.txt' '${location.origin}/api/logs/decrypt' -o decrypted.txt

批量示例（先将日志打成 ZIP）：
curl --fail-with-body --max-time 360 -F 'file=@/path/to/logs.zip' '${location.origin}/api/logs/decrypt' -o decrypted-logs.zip

先检查 curl 退出码；只有为 0 才读取输出为日志或 ZIP。失败时输出文件可能是错误 JSON。
限制：上传最多 100 MiB；ZIP 最多 200 个日志，单个最多 100 MiB，解压后合计和解密结果合计各最多 256 MiB。不支持嵌套 ZIP、符号链接或带密码的 ZIP。忽略 macOS 元数据文件；ZIP 内任一日志失败则该 ZIP 失败，不返回部分结果。
常见状态：400 请求或 ZIP 格式错误；413 超限；422 解密失败；503 服务繁忙或解密工具不可用；408/504 请求取消或超时。
处理上限 5 分钟（单个日志 2 分钟）。输入和输出在请求结束后从服务端临时目录清理。
调用方必须能访问该内网地址；无法联网访问此地址的 AI 需让用户在可访问的机器执行命令。`;

    document.getElementById('copy-api').addEventListener('click', async () => {
        const feedback = document.getElementById('copy-status');
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(instructions.value);
            } else {
                // The intranet is served over HTTP, where Clipboard API is unavailable.
                instructions.focus();
                instructions.select();
                if (!document.execCommand('copy')) throw new Error('copy');
            }
            feedback.textContent = '已复制，可粘贴给 AI';
        } catch {
            instructions.focus();
            instructions.select();
            feedback.textContent = '已选中说明，请按 Ctrl+C / ⌘C 复制';
        }
    });
})();
