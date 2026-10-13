# SUD 日志解密工具

`sud-log-parser-arm64` 由项目使用方提供，为 macOS arm64 可执行文件。

调用方式：`./sud-log-parser-arm64 /absolute/path/to/log.txt`。工具在当前工作目录生成 `decrypt_log.txt`。服务使用每个日志独立的工作目录，通过参数数组启动，不执行 shell 命令。

工具可能在解码错误后仍返回退出码 0；服务同时检查诊断信息与非空输出，不将部分解密结果作为成功返回。
