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

## 3. P1 前置项：已全部实施（合并于 `main`）

以下四项在 P0 结论为 GO 时被列为前置条件，均已实现、复验并合并进 `main`。
每个条目标注了实现位置；详细验收数据在父项目 `validation/P0-验证记录.md` 与
`validation/evidence/`。

### C1 ✔ 已实现：补 `event_msg.item_completed` 兼容层

**问题**：Codex Desktop v0.153/v0.154 的会话把工具与文件变更记录在
`event_msg.item_completed`，上游 parser 完全不读该事件族，导致：

- `item_completed.CommandExecution`（实测 28 会话样本 2,346 条）→ 解析为 `unknown`，`exit_code`/`stdout`/`stderr` 丢失
- `item_completed.FileChange`（949 条）→ **完全没有 patch 记录**，unified diff 丢失
- 现有 `custom_tool_call` 只有 JS 源码（`input_text`）与脚本包装输出，拿不到真实 diff

**实现**（`src-tauri/src/parser/toolcall.rs`、`turn.rs`）：`desktop_item_patch()` 把 item 归一化，
`fold_desktop_items()` 按**严格入口邻接**（entry index ± 1）关联到 `response_item` 工具调用
（实测 175 文件中 1510/1512 个 item 恰好相隔一行）；无邻接调用的 item 独立成条；
`Reasoning`/`AgentMessage`/`UserMessage`/`ContextCompaction`/`SubAgentActivity`/`CollabAgentToolCall`
显式跳过。`ToolCall` 增加 `desktop_item_id`、`stderr`。

**验收结果**：`patch_apply` 949（原 0）、`exec_command` 2,346（原 0），与原始事件一一对应；
exec 全部携带 `exit_code`/`command`；恢复 655 条 unified diff；上游 410 个测试原样通过。

### C6 ✔ 已实现：patch 渲染使用 `patch_changes[*].unified_diff`

**问题**：UI 先用 `input_text` 走 `parseApplyPatch()`，而 Desktop 的 `input_text` 是模型运行的
JavaScript（补丁被包在 JS 字符串里），解析失败后回退为等宽文本——即使 C1 已把 diff 数据补齐，
界面也没有红绿 diff。既有单测用的是裸补丁文本，该形态在真实 Desktop 数据里并不出现。

**实现**（`shared/patch.ts`、`src/components/ToolCallItem.tsx`）：新增 `parseUnifiedDiff()`
把标准 unified diff 解析为与 `parseApplyPatch` 相同的 `PatchFile[]`/hunks（复用 `groupRuns` +
`segmentize` 得到词级高亮）；渲染来源改为有优先级——`patch_changes` 优先，`input_text` 兜底。

**验收结果**：Desktop `FileChange` patch 渲染出 added 13 / removed 1（原 0/0）、
CLI 风格 patch added 12 / removed 12，词级高亮生效。

### C4 ✔ 已实现：dev 端口可配置

本机实测 1420/1421 落在 Windows 保留端口区间（`netsh int ipv4 show excludedportrange protocol=tcp`
列出 1353–1452），`npm run tauri dev` 的 Vite 阶段直接 `EACCES`。

**实现**（`script/dev.mjs` + `npm run dev:desktop`）：探测第一个可绑定端口 → 在该端口启动 Vite →
生成 `.tauri/dev-url.json` 配置覆盖（设 `devUrl`、清空 `beforeDevCommand`，避免 Tauri 再起一个 Vite）
→ 启动 Tauri。`--port <n>` 可指定起点。`tauri.conf.json` 未被修改。

### C5 ✔ 已实现：cwd 归一化的 Unicode Cf 策略

真实数据中 1 个 cwd 目录名含不可见 `U+200C`（116 个会话）。Windows 视其为独立目录，
但它不显示，朴素归一化要么合并两个不同项目、要么把同一项目裂成两个。

**实现**（`shared/projectKey.ts`）：`projectKeyFor()` / `compareProjectPaths()` 返回
`exact | cf | none`。`key` 保留 Cf 字符并归一化分隔符/尾部斜杠/`.`/`..`/Windows 大小写；
`displayKey` 去掉 Cf 字符供「按可见目录合并」使用；`cfStripped` 报告是否发生了这种合并。
POSIX 形态（WSL）保持大小写敏感且与 Windows 路径永不合并。

### C3 ✔ 已实现（渲染层）：远端图片点击加载 + CSP

**实现**：`MarkdownRenderer` 覆写 `img`——远端源先渲染占位按钮（显示 alt 与 URL），
点击后才设置 `src`；`data:`/`blob:` 与同源/相对路径直接渲染。新增 `urlTransform` 仅对图片放行
`data:image/*` 与 `blob:`（react-markdown 默认过滤器会把 `data:` 一并剥掉）。
`src-tauri/tauri.conf.json` 的 `csp` 由 `null` 换为显式策略。

**未独立复验**：CSP 由 Tauri 在运行时注入，无法从 `dist/index.html` 读回，其拦截行为未单独观测。
已验证的是：策略已配置、应用在策略下正常渲染、渲染层不再请求远端图片。

## 4. 本地开发命令（本机已验证）

```bash
npm run dev:desktop      # 桌面版：自动选可用端口（见上文 C4）
npm run dev:web          # web 模式
npm run check            # 上游全量检查（tsc/oxlint/oxfmt/clippy/fmt/vitest/cargo test）
pwsh -File script/dev-check.ps1 all   # 同上，但自动补齐本机 Rust/MSVC 环境
```

## 5. 本地环境要求（本机已验证）

- Node v24.19.0 / npm 11.17.0
- Rust 1.98.1（`%USERPROFILE%\.cargo`），**PATH 需手动添加** `%USERPROFILE%\.cargo\bin`
- MSVC BuildTools 2022 + Windows SDK 10.0.26100.0；本机 vcvars 未注册 `WindowsSDKVersion`，
  直接链接会 `LNK1181`，因此仓库内 `.cargo/config.toml` 固定了 `LIB`/`INCLUDE`：
  ```powershell
  $env:LIB = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\lib\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\ucrt\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\um\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\shared\x64"
  ```
- `cargo test` 需要 `$env:HOME = $env:USERPROFILE`（Windows 无 HOME，上游个别测试硬编码该变量）
- WebView2 Runtime 152.0.4191.66

## 6. 上游约定（来自上游 AGENTS.md）

改动后必须跑：

```bash
npx oxfmt && npx oxlint && npx tsc --noEmit
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

两个本机注意点：

- `oxfmt --check` 会把约 92 个**未改动**文件报为格式问题，这是 `core.autocrlf=true`
  把 checkout 转成 CRLF 导致的误报（已在父项目用 LF clone 证伪），不是代码问题。
  另外 `npx oxfmt`（不带 `--check`）会重写这些文件的行尾，提交前需 `git checkout` 排除。
- 合并 `main` 后的验证结果：`tsc`/`oxlint`（3 条既有警告）/`vite build`/`clippy`/`fmt` 全部通过，
  `vitest` 204 passed，`cargo test` 416 passed。

## 7. 许可

保留上游 MIT `LICENSE` 与版权声明（Copyright (c) 2025 Yang Liu）。
本仓库的修改历史独立维护，不修改上游许可文本。
