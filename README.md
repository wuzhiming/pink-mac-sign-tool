# macOS 网页签名与公证工具 (Web-Based macOS Signing Tool)

这是一个基于 Web 的自动化工具，用于对 macOS 二进制文件或应用包进行 **签名 (Signing)** 和 **公证 (Notarization)**。它简化了复杂的命令行操作，提供了实时的处理进度反馈。

## 🚀 功能特性

- **自动识别**：自动扫描上传文件中的 Mach-O 二进制文件（如 `.dylib`, `.node`, 可执行文件等）。
- **批量签名**：调用 `codesign` 对识别出的所有二进制文件进行强制签名。
- **自动化公证**：集成 Apple `notarytool`，自动打包并上传至 Apple 服务器进行公证。
- **实时反馈**：通过 Socket.io 在网页端同步显示详细的处理日志。
- **一键下载**：处理完成后自动生成压缩包供用户下载。

## 📋 环境要求

- **操作系统**：必须在 **macOS** 运行（签名工具链依赖 `codesign` 和 `xcrun`）。
- **开发工具**：需安装 **Xcode命令行工具** (`xcode-select --install`)。
- **Runtime**：Node.js 16+。

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

## 📖 使用指南

1. **上传文件**：将包含 macOS 二进制文件的 `.zip` 压缩包或单个二进制文件上传。
2. **选择选项**：勾选“签名”和“公证”选项（建议两者都选以确保最佳兼容性）。
3. **开始处理**：点击“开始处理”，在页面下方的日志窗口观察进度。
4. **下载结果**：看到“Process completed successfully!”提示后，点击下载链接获取处理后的文件。

## ⚠️ 注意事项

- **网络环境**：公证过程需要与 Apple 服务器通信，请确保服务器网络畅通。
- **权限**：确保运行进程的用户有权限访问相关的钥匙串 (Keychain)。
- **文件夹说明**：
    - `uploads/`: 存放上传的原始文件（处理后可手动清理）。
    - `output/`: 存放签名/公证后的 ZIP 包。

## 📄 开源协议

MIT
