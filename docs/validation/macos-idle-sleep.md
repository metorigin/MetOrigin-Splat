# macOS 任务期间防空闲睡眠

日期：2026-10-27。MAC-14 的本地设置为 `prevent_idle_sleep`，默认 `false`。
旧 `settings.json` 缺少字段时仍为关闭；读失败也不会启用。设置仅影响之后启动的
任务，前端仅在 macOS 显示选项，并说明屏幕可以休眠、合盖/手动睡眠/低电量仍可能
中断任务。

`apps/desktop/src-tauri/src/macos_activity.rs` 使用 IOKit
`IOPMAssertionCreateWithName(PreventUserIdleSystemSleep, 255, ...)` 创建本进程断言，
RAII guard 的 `Drop` 配对 `IOPMAssertionRelease`。它不修改 `pmset` 或系统全局
偏好，不启动常驻 `caffeinate` 子进程，不创建显示器防睡眠断言。系统退出时也会
清理该进程持有的断言。能力边界来自当前 SDK 的 `IOPMLib.h`。

调用方式：在接受任务时读取一次
`commands::system::prevent_idle_sleep_enabled(&app_handle)`；在实际后台 pipeline
future 内创建并持有 `MacosActivityGuard::acquire(enabled)` 的返回值。非 macOS
返回 `Ok(None)`；关闭选项不会调用系统 API。后台任务完成、错误返回、异常展开或
future 被取消销毁时，guard 释放断言。不要在返回给前端的启动命令局部持有 guard，
否则命令返回即释放。创建失败返回明确错误，调用方应告知用户防睡眠未生效。

本模块独立验证证据位于 `target/macos-m3/activity-evidence/`：

- `unit-tests.log`：8 项测试覆盖关闭零调用、正常/错误/异常展开/挂起 future 销毁时
  释放、创建失败不释放未拥有 ID、释放失败不重复释放、guard 可跨线程持有。
- `native-smoke.log`：当前 Apple Silicon/macOS 主机真实创建一个断言，确认其属性
  存在，drop 后确认 `IOPMAssertionCopyProperties` 不再返回该断言。该测试不触发
  系统睡眠，默认 `#[ignore]`，只在显式原生验证时运行。
- 前端测试覆盖 macOS 初始关闭、用户显式保存、英文文案，以及 Windows 不展示该
  选项；设置文件测试覆盖旧 JSON 默认值和开启/关闭后的本地读写。

复现实例（已经构建的独立测试程序）：

```sh
target/macos-m3/activity-evidence/macos-activity-tests
# 仅在准备验证当前主机的短暂 activity assertion 时运行：
target/macos-m3/activity-evidence/macos-activity-tests --ignored \
  --exact tests::actual_macos_assertion_is_removed_on_drop
```

该验证不能保证合盖、主动睡眠或电量耗尽时训练继续，也没有测试或更改用户的实际
系统睡眠配置。应用后台任务的挂接与生命周期验收由对应 pipeline 集成测试记录。
