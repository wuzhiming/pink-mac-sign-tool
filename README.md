# PinK 开发工具：macOS 签名、公证与 SUD 日志解密

这是一个基于 Web 的自动化工具，用于对 macOS 二进制文件或应用包进行 **签名 (Signing)** 和 **公证 (Notarization)**。它简化了复杂的命令行操作，提供了实时的处理进度反馈。

## 🚀 功能特性

- **自动识别**：自动扫描上传文件中的 Mach-O 二进制文件（如 `.dylib`, `.node`, 可执行文件等）。
- **批量签名**：调用 `codesign` 对识别出的所有二进制文件进行强制签名。
- **自动化公证**：集成 Apple `notarytool`，自动打包并上传至 Apple 服务器进行公证。
- **实时反馈**：通过 Socket.io 在网页端同步显示详细的处理日志。
- **一键下载**：处理完成后自动生成压缩包供用户下载。
- **SUD 日志解密**：上传单个加密日志返回文本；上传 ZIP 批量解密，返回保留目录和文件名的 ZIP。
- **AI / 脚本调用**：通过 HTTP 上传并直接下载签名或解密结果，网页提供可复制给 AI 的完整说明。

## 📋 环境要求

- **操作系统**：必须在 **macOS** 运行（签名工具链依赖 `codesign` 和 `xcrun`）。
- **开发工具**：需安装 **Xcode命令行工具** (`xcode-select --install`)。
- **Runtime**：Node.js 22.12+（现有签名模块通过 `require` 加载 ESM 依赖）。
- **日志解密工具**：项目内置 `bin/sud-log-parser-arm64`，适用于 Apple Silicon macOS。其他架构需自行提供兼容的解密工具，并通过 `SUD_LOG_PARSER_PATH` 设置绝对路径。

## 🛠️ 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

在根目录下创建 `.env` 文件，并填写您的 Apple 开发者信息：

```env
# 签名标识符 (例如 "Developer ID Application: Your Name (TeamID)")
APPLE_DEVELOPER_ID=Developer ID Application: XXX (YYY)

# 公证相关
APPLE_ID=your-apple-id@email.com
APPLE_PASSWORD=your-app-specific-password
APPLE_TEAM_ID=YourTeamID
```

> [!TIP]
> `APPLE_PASSWORD` 必须是 **App专用密码**，可以在 [appleid.apple.com](https://appleid.apple.com/) 生成。

### 3. 运行服务

```bash
# 开发模式 (配合 nodemon)
npm run dev

# 生产运行
npm start
```

访问地址：`http://localhost:3000`

两个工具有独立路由，支持直接访问、刷新和浏览器前进后退：

- `/sign`：macOS 签名与公证。
- `/logs`：SUD 日志解密及 AI 接口说明。
- `/`：默认跳转到 `/sign`。

## 📖 使用指南

1. **上传文件**：将包含 macOS 二进制文件的 `.zip` 压缩包或单个二进制文件上传。
2. **选择选项**：勾选“签名”和“公证”选项（建议两者都选以确保最佳兼容性）。
3. **开始处理**：点击“处理并生成 ZIP 下载文件”，在页面下方的日志窗口观察进度。
4. **下载结果**：看到“Process completed successfully!”提示后，点击下载链接获取处理后的文件。

## 签名 HTTP 接口（供 AI 和脚本使用）

`POST /api/sign` 接收一个 `multipart/form-data` 文件字段 `file`。单个二进制直接上传，多个文件或 `.app` 目录先打包为 ZIP。接口复用网页使用的 `processBinaries`、解压和打包逻辑，直接等待处理结束并返回 ZIP，不需要 Socket.io。原有网页的实时日志流程仍使用 `/upload` 和 Socket.io，保留兼容。

三个可选 **URL 查询参数**：`sign`、`notarize`、`addExecPermission`，均只接受 `true` 或 `false`，省略时默认 `true`。公证必须同时开启签名。参数不能作为 multipart 表单字段传入。

```bash
# 仅签名，不公证；部署新版服务后可使用内网地址
curl --fail-with-body --max-time 7200 \
  -F 'file=@/path/to/input.zip' \
  'http://192.168.60.64:3000/api/sign?sign=true&notarize=false&addExecPermission=true' \
  -o processed.zip
```

成功返回 `200 application/zip`，响应体就是结果 ZIP，下载文件名在 `Content-Disposition`。失败返回非 2xx 和 `{"error":{"code":"...","message":"..."}}`。先检查 curl 退出码，失败输出可能是错误 JSON。未发现二进制、签名/公证失败或签名验证警告都会返回 `422`，不返回成功 ZIP。

上传最多 1 GiB，ZIP 解压后最多 2 GiB、目录项最多 100000 个。签名 HTTP 接口同时处理一个请求，忙时返回 `503 BUSY` 和 `Retry-After: 30`。上传超时为 10 分钟，公证可能长时间等待；反向代理需放宽请求体大小和响应超时。断线会取消后续处理并终止正在执行的签名/公证命令，不支持任务恢复，不应自动重复提交。

签名证书、Apple 账号和凭据在服务器配置，调用方无需传入。开启公证会将待公证内容提交 Apple。输入与输出在系统临时目录 `web-sign-api-*` 内隔离，请求结束后清理；进程强制退出的遗留目录可在停服后清理。

`/sign` 页面提供「让 AI 直接调用 · 签名接口说明」，按当前访问地址和勾选项生成请求示例，可直接复制给 AI。调用方需要能访问服务所在内网。

## SUD 日志解密

打开 `/logs`（或点击「SUD 日志解密」），拖入或多选日志/ZIP 文件。列表支持继续添加和移除文件，点击解密按钮后逐个处理，每个文件都有独立的下载链接。失败文件可重试，已成功的文件不会重复处理。下载链接仅在当前页面有效，请在离开或刷新前保存结果。解密无需配置 Apple 签名凭据。

- 单日志：返回 `decrypt_原文件名` 的 UTF-8 文本。
- ZIP：返回 `原压缩包名_decrypted.zip`，内部保留原目录和文件名，仅包含解密后的日志。不同目录下同名日志分别处理。
- ZIP 中的 `.DS_Store`、`__MACOSX`、`._*` 会忽略；其余普通文件均作为日志处理。
- 拖入多个文件时，各自发起独立请求，单个失败不影响其余文件。一个 ZIP 内任意日志解密失败则该 ZIP 失败，错误中标明文件路径，不会返回部分成功的 ZIP。工具即使退出码为 0，若报告解码错误或生成空结果，也视为失败。

上传最多 **100 MiB**；ZIP 最多 **200 个日志 / 1000 个目录项**，单个日志最多 **100 MiB**，解压后合计与解密结果合计各最多 **256 MiB**。不接受嵌套 ZIP、密码 ZIP、符号链接和不安全路径。

同时最多处理 2 个请求；单个日志最多处理 2 分钟，整个请求最多 5 分钟。输入、输出存放于独立系统临时目录，请求完成、失败或连接中断后清理，不创建公开下载链接。进程被强制终止时可能遗留系统临时目录下的 `web-sign-log-*`，停服后可清理。服务仅供可信内网使用；API 沿用站点的访问方式，未新增身份认证。

### HTTP 接口（供 AI 和脚本使用）

`POST /api/logs/decrypt`

请求体为 `multipart/form-data`，每次只提供一个名为 `file` 的文件字段。多个日志需要独立结果时逐个发起请求；需要一个批量结果包时先打成 ZIP。网页多文件拖拽也使用逐个请求的方式。无需 Socket.io、会话 ID 或轮询；客户端应自动生成 `Content-Type` 的 boundary。

下面以现有内网地址为例，**部署新版服务后**可用：

```bash
# 单个日志
curl --fail-with-body --max-time 360 \
  -F 'file=@/path/to/input.txt' \
  'http://192.168.60.64:3000/api/logs/decrypt' \
  -o decrypted.txt

# 多个日志先打成 ZIP，再上传
curl --fail-with-body --max-time 360 \
  -F 'file=@/path/to/logs.zip' \
  'http://192.168.60.64:3000/api/logs/decrypt' \
  -o decrypted-logs.zip
```

检查 curl 退出码，只有为 0 才将输出当作解密结果；失败时输出文件可能保存了错误 JSON。调用方需要能访问服务所在内网，云端 AI 无法访问时应由用户在可访问的机器执行命令。

成功返回 `200`，响应体就是文件：单日志 `text/plain; charset=utf-8`，ZIP 为 `application/zip`。`Content-Disposition` 提供下载文件名，`X-Log-Count` 提供日志数量，响应禁止缓存。

失败返回非 2xx 和 JSON，例如：

```json
{
  "error": {
    "code": "DECRYPT_FAILED",
    "message": "日志包含无法解密的数据，请确认日志格式和完整性。",
    "file": "device-a/session.txt"
  }
}
```

`file` 为可选字段。常见状态：`400` 请求或 ZIP 格式错误，`413` 超限，`422` 无效日志/解密失败，`503` 忙碌或工具不可用，`408/504` 取消或超时。`503 BUSY` 带 `Retry-After: 10`；上传途中超时或断线可能直接关闭连接。

网页中的「让 AI 直接调用」会按当前访问地址生成说明，并支持 HTTP 内网页面上的复制操作。

### 部署与验证

部署时需一并更新源码、`public/`、依赖锁文件和 `bin/sud-log-parser-arm64`，运行 `npm ci` 后重启 Node 服务。确保二进制有执行权限：

```bash
chmod +x bin/sud-log-parser-arm64
# 可选：在 .env 指向另一份兼容工具
# SUD_LOG_PARSER_PATH=/absolute/path/to/sud-log-parser-arm64
npm start
```

若经过反向代理，需允许 100 MiB 的文件加 multipart 开销，并将读取超时设置为至少 360 秒。

```bash
# 接口回归（使用可控的模拟解密器，无需私有日志）
npm test

# 额外验证真实二进制：只读取指定日志前 64 KiB 中的前 20 行
SUD_LOG_TEST_FILE=/absolute/path/to/sample.txt npm test
```

真实测试比较单文件、双日志 ZIP 与命令行直接解密的结果，原始日志与解密内容不写入仓库。其余测试覆盖中文文件名、格式错误、无效日志、超时、上传限制、ZIP 路径校验和断线清理。

## ⚠️ 注意事项

- **网络环境**：公证过程需要与 Apple 服务器通信，请确保服务器网络畅通。
- **权限**：确保运行进程的用户有权限访问相关的钥匙串 (Keychain)。
- **文件夹说明**：
    - `uploads/`: 存放上传的原始文件（处理后可手动清理）。
    - `output/`: 存放签名/公证后的 ZIP 包。

## 📄 开源协议

MIT
