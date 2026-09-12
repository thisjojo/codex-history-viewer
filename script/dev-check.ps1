<#
.SYNOPSIS
  本机（Windows）开发/验证入口：统一补齐 Rust 与 MSVC 环境后执行上游检查。

.DESCRIPTION
  本机有两个环境坑，脚本统一处理：
  1. `%USERPROFILE%\.cargo\bin` 不在 PATH；
  2. vcvars64.bat 未注册 WindowsSDKVersion，cargo 链接会 LNK1181，
     因此需要显式 LIB/INCLUDE（值与 .cargo/config.toml 保持一致）。

  另外 Windows 默认没有 HOME，上游 `parse_real_session_does_not_panic`
  测试硬编码读取 HOME，需要指向 USERPROFILE。

.EXAMPLE
  pwsh -File script/dev-check.ps1 check          # cargo check
  pwsh -File script/dev-check.ps1 test           # cargo test
  pwsh -File script/dev-check.ps1 all            # 上游 npm run check 等价物
#>
param(
  [ValidateSet("check", "test", "clippy", "fmt", "frontend", "all")]
  [string]$Task = "check"
)

$ErrorActionPreference = "Continue"

$repo = Split-Path -Parent $PSScriptRoot
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $cargoBin) { $env:Path = "$cargoBin;" + $env:Path }
if (-not $env:HOME) { $env:HOME = $env:USERPROFILE }

# 与本仓库 .cargo/config.toml 保持一致（脚本外运行时也能工作）
if (-not $env:LIB) {
  $env:LIB = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\lib\x64;" +
             "C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\ucrt\x64;" +
             "C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\um\x64;" +
             "C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\shared\x64"
}
if (-not $env:INCLUDE) {
  $env:INCLUDE = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\include;" +
                 "C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\ucrt;" +
                 "C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\um;" +
                 "C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\shared;" +
                 "C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\winrt"
}

$manifest = Join-Path $repo "src-tauri\Cargo.toml"

function Invoke-Step([string]$Name, [scriptblock]$Body) {
  Write-Host "== $Name ==" -ForegroundColor Cyan
  & $Body
  $code = $LASTEXITCODE
  Write-Host ("{0} exit={1}" -f $Name, $code) -ForegroundColor $(if ($code -eq 0) { "Green" } else { "Red" })
  return $code
}

$failed = 0
switch ($Task) {
  "check" { $failed += Invoke-Step "cargo check" { cargo check --manifest-path $manifest } }
  "test" { $failed += Invoke-Step "cargo test" { cargo test --manifest-path $manifest } }
  "clippy" { $failed += Invoke-Step "cargo clippy" { cargo clippy --manifest-path $manifest } }
  "fmt" { $failed += Invoke-Step "cargo fmt --check" { cargo fmt --manifest-path $manifest --check } }
  "frontend" {
    Push-Location $repo
    $failed += Invoke-Step "tsc" { npx tsc --noEmit }
    $failed += Invoke-Step "oxlint" { npx oxlint }
    $failed += Invoke-Step "oxfmt --check" { npx oxfmt --check }
    $failed += Invoke-Step "vitest" { npx vitest run }
    Pop-Location
  }
  "all" {
    Push-Location $repo
    $failed += Invoke-Step "tsc" { npx tsc --noEmit }
    $failed += Invoke-Step "oxlint" { npx oxlint }
    $failed += Invoke-Step "vitest" { npx vitest run }
    Pop-Location
    $failed += Invoke-Step "cargo clippy" { cargo clippy --manifest-path $manifest }
    $failed += Invoke-Step "cargo fmt --check" { cargo fmt --manifest-path $manifest --check }
    $failed += Invoke-Step "cargo test" { cargo test --manifest-path $manifest }
  }
}

if ($failed -gt 0) { Write-Host "FAILED ($failed step(s))" -ForegroundColor Red; exit 1 }
Write-Host "OK" -ForegroundColor Green
