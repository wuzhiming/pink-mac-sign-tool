(() => {
    const instructions = document.getElementById('sign-ai-instructions');
    const feedback = document.getElementById('sign-copy-status');
    const fields = ['sign-checkbox', 'notarize-checkbox', 'add-exec-checkbox'].map(id => document.getElementById(id));
    function updateInstructions() {
        const [sign, notarize, addExecPermission] = fields.map(field => field.checked);
        const url = `${location.origin}/api/sign?sign=${sign}&notarize=${notarize}&addExecPermission=${addExecPermission}`;
        instructions.value = `请使用以下 HTTP 接口处理我提供的 macOS 二进制文件：

POST ${url}
请求：multipart/form-data，仅一个名为 file 的文件字段。单个二进制直接上传；多个文件或 .app 目录先打包为 ZIP。不要手动设置 Content-Type，让客户端生成 boundary。
当前选项：代码签名 ${sign ? '开启' : '关闭'}；苹果公证 ${notarize ? '开启' : '关闭'}；增加可执行权限 ${addExecPermission ? '开启' : '关闭'}。
三个参数都是 URL 查询参数，值只能是 true 或 false，省略时默认 true；notarize=true 必须同时 sign=true。不要把这些参数放到 multipart 字段中。
接口复用网页签名处理逻辑，但直接等待并返回 ZIP，无需 Socket.io、会话 ID 或轮询。

调用示例（替换本地文件路径）：
curl --fail-with-body --max-time 7200 -F 'file=@/path/to/input.zip' '${url}' -o processed.zip

成功：HTTP 200，Content-Type 为 application/zip，响应体就是处理后的 ZIP，文件名见 Content-Disposition。
失败：非 2xx，JSON 格式 {"error":{"code":"...","message":"..."}}。先检查 curl 退出码，仅为 0 时将输出当成 ZIP；失败时输出文件可能保存错误 JSON。
常见状态：400 请求/参数/ZIP 错误；413 超限；422 签名、公证、验证失败或未找到二进制；503 BUSY 表示接口忙，可按 Retry-After 稍后重试。
每次只上传一个文件或 ZIP。上传最多 1 GiB，ZIP 解压后最多 2 GiB。多个独立结果请逐次请求。签名接口一次处理一个任务。
公证可能耗时较长，请保持连接。上传上限 10 分钟；代理需允许长时间等待响应。断线或超时不代表可恢复任务，不要自动重复提交。
签名证书及 Apple 凭据由服务器配置，调用方无需上传或提供。开启公证会将待公证内容提交给 Apple。
输入和输出使用临时目录，请求结束后清理；结果随响应下载，不提供持久下载地址。
调用方必须能访问此内网地址；无法访问时请让用户在能访问的机器执行命令。`;
        feedback.textContent = '';
    }
    fields.forEach(field => field.addEventListener('change', updateInstructions));
    updateInstructions();
    document.getElementById('copy-sign-api').addEventListener('click', async () => {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(instructions.value);
            } else {
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
