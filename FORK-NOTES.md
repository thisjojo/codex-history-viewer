# Fork 交接说明（P0 → P1）

## 1. 这个仓库是什么

本仓库是 [PixelPaw-Labs/codex-trace](https://github.com/PixelPaw-Labs/codex-trace)（MIT）的 Fork，
用作 [Codex History Viewer](../) 的正式代码基线。

- **上游基线 commit**：`38500c2d5423b64cc066a8790230993fb87332a2`（`v0.4.0-71-g38500c2`）
- **基线锚点 tag**：`p0-baseline`
- **remote 约定**：
  - `origin` → 本 Fork（自己的改动）
  - `upstream` → `PixelPaw-Labs/codex-trace`（只读同步源，保留用于 cherry-pick 上游 parser 更新）

上游同步方式：

```bash
git fetch upstream
git log --oneline upstream/main -- src-tauri/src/parser/   # 只看 parser 相关更新
git cherry-pick <sha>       # 或 git merge upstream/main（按需）
```

## 2. P0 验证结论

P0 技术验证已完成，结论 **GO**。完整记录见父项目
`validation/P0-验证记录.md`（不在本仓库内）。

四项核心门禁全部通过：

| 门禁 | 结论 |
|---|---|
| Desktop session 兼容 | 28 个真实会话 0 解析错误，turn 数与原始 `task_started` 100% 一致 |
| Live tail | fixture 4 轮 + 真实 Desktop 会话 2 条消息 / 4 次写入，全部 1.065–1.082 s 送达 |
| 严格只读 | 静态样本 hash 全等，Codex 数据零 mutation，生产代码只写 app 自身 settings.json |
| Windows 构建与运行 | 原生窗口正常，410 Rust 测试 + 175 前端测试通过 |

## 3. P1 必须处理的前置项

### C1（阻塞 V1 验收）：补 `event_msg.item_completed` 兼容层

**问题**：Codex Desktop v0.153/v0.154 的会话把工具与文件变更记录在
`event_msg.item_completed`，上游 parser 完全不读该事件族，导致：

- `item_completed.CommandExecution`（实测 28 会话样本 2,346 条）→ 解析为 `unknown`，`exit_code`/`stdout`/`stderr` 丢失
- `item_completed.FileChange`（949 条）→ **完全没有 patch 记录**，unified diff 丢失
- 现有 `custom_tool_call` 只有 JS 源码（`input_text`）与脚本包装输出，拿不到真实 diff

**要求**：

- `CommandExecution` → exec 类 tool call，携带 `command`/`parsed_cmd`/`status`/`stdout`/`stderr`/`exit_code`
- `FileChange` → patch 类 tool call，携带 `changes[*].unified_diff`、`move_path`、文件列表
- 其余（`McpToolCall`/`WebSearch`/`ImageView`/`Extension`/`ContextCompaction`/`SubAgentActivity`/`CollabAgentToolCall`）
  补全或显式记账忽略
- **不得**改动既有 `response_item` 路径的语义；不得破坏上游 parser 测试与 fixtures

**验收**：用父项目的 `validation/scripts/p0_parser_matrix.py` 复跑真实样本，
要求解析出的 `patch_apply`/`exec` 计数与原始 `FileChange`/`CommandExecution` 计数匹配（差异需能解释）。

### C4：dev 端口可配置

本机实测 1420/1421 落在 Windows 保留端口区间（`netsh int ipv4 show excludedportrange protocol=tcp`
列出 1353–1452），`npm run tauri dev` 的 Vite 阶段直接 `EACCES`。
需要让 dev 端口可通过环境变量配置，并让 `build.devUrl` 与之保持一致。

### C5：cwd 归一化的 Unicode Cf 策略

真实数据中 1 个 cwd 目录名含不可见 `U+200C`（116 个会话）。ProjectResolver 必须明确
是否剥离 Unicode 格式控制字符（Cf），并加测试。参考数据见父项目
`validation/evidence/E-008-cwd-analysis.json`。

### C3（可推迟到 P5）：远端图片与 CSP 硬化

`![x](https://…)` 会渲染为 `<img>`，且 `src-tauri/tauri.conf.json` 中 `app.security.csp = null`，
导致查看历史即触发外部请求。改为点击后加载 + 设置 CSP。

## 4. 本地环境要求（本机已验证）

- Node v24.19.0 / npm 11.17.0
- Rust 1.98.1（`%USERPROFILE%\.cargo`），**PATH 需手动添加** `%USERPROFILE%\.cargo\bin`
- MSVC BuildTools 2022 + Windows SDK 10.0.26100.0；链接需要显式 `LIB`/`INCLUDE`：
  ```powershell
  $env:LIB = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\lib\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\ucrt\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\um\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\shared\x64"
  ```
- `cargo test` 需要 `$env:HOME = $env:USERPROFILE`（Windows 无 HOME，上游个别测试硬编码该变量）
- WebView2 Runtime 152.0.4191.66

## 5. 上游约定（来自上游 AGENTS.md）

改动后必须跑：

```bash
npx oxfmt && npx oxlint && npx tsc --noEmit
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

注意：本机 `oxfmt --check` 会把 93 个文件报为格式问题，这是 `core.autocrlf=true`
把 checkout 转成 CRLF 导致的误报（已在父项目用 LF clone 证伪），不是代码问题。

## 6. 许可

保留上游 MIT `LICENSE` 与版权声明（Copyright (c) 2025 Yang Liu）。
本仓库的修改历史独立维护，不修改上游许可文本。
