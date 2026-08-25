# EmberProbe

EmberProbe 是一款面向 Cortex-M 开发的 VS Code 扩展。它基于 OpenOCD，提供固件烧录、目标自动识别与实时变量观测。

> [English documentation](README_EN.md)

## 功能特性

- 自动检测工作区中最新的 ELF 文件。
- 通过 `.ioc`、CMake 和链接脚本推断 MCU 目标。
- 在侧边栏检测 OpenOCD 环境并展示其状态；Windows x64 支持一键离线安装，也可指向已有的 OpenOCD 可执行文件。
- Linux/macOS 无预置包：请用系统包管理器安装（如 `sudo apt install openocd`、`brew install openocd`），再通过“选择 OpenOCD”指定路径；Linux 访问 USB 探针还需 udev 规则或相应用户组权限（详见 [OpenOCD udev 规则](https://github.com/openocd-org/openocd/blob/master/contrib/60-openocd.rules)）。
- 芯片信息读取：通过 OpenOCD 非侵入式读取芯片内核、Device ID、Flash 容量、UID、调试链路与运行状态。
- 实时变量观测：在目标运行时非侵入式读取 Cortex-M 内存；侧边栏提供独立数值列表，可同时打开多个拥有独立观察列表和历史缓冲的实时图表面板。
- Cortex-Debug 联动：调试始终使用内存配置，不读写 `launch.json`；目标运行时等待暂停，暂停后通过同一 DAP 会话自动读写，调试结束后按用户原本的采样意图恢复。
- 官方 SVD 管理：根据工程和芯片信息从 Open-CMSIS-Pack 官方 DFP 下载，显示进度并校验；SVD 以哈希去重保存在扩展全局库，可按工作区绑定和共用。
- 可选安装八个 Agent Skills，覆盖固件下载与校验、实时变量读写、芯片和故障信息读取、ELF 分析，以及配置同步。

## 环境要求

- Visual Studio Code 1.85 或更高版本
- OpenOCD

## 实时变量观测

侧边栏列出当前 ELF 的所有全局/静态变量；点击变量可将其加入独立数值列表。

- 类型支持：标量优先使用 DWARF 类型信息，支持 `u8/i8/u16/i16/u32/i32/f32/u64/i64/f64`；结构体、联合体和数组可展开并选择标量叶子成员。
- 64 位精度：`u64/i64` 图表在 ±2^53 外使用 Number 近似值；侧边栏、CSV 和 Agent 结果优先使用精确十进制 `valueText`。
- CSV 导出：可选择包含已隐藏曲线在内的任意有数据系列；剪辑轨道式双端时间轴始终可见，非自定义模式时置灰，自定义模式默认全选且右端为打开导出对话框的时刻。
- 实时写入：侧边栏可把具有可靠 DWARF 类型且位于 ELF 可写段的标量加入写入列表；写入只在采样会话运行时启用，并在每次写入后回读校验。
- 限制：仅支持 Cortex-M 及固定地址的全局/静态变量；采样带宽有限（约 10–50 Hz）。多面板共享采样启停和间隔，内存占用随面板数线性增长，每个面板分别受 `maxSamples` 限制。
- 相关设置：`emberprobe.tclPort`、`emberprobe.sampleIntervalMs`、`emberprobe.maxSamples`。

调试期间，“开始”代表保留采样意图：芯片运行时仅显示“等待暂停”，不会主动发送 pause；芯片暂停后以不低于 250 ms 的周期通过 DAP 采样，并允许经安全检查的写入。侧边栏的 SVD 区域可选择已有文件或下载官方 SVD；新绑定从下一次调试开始生效。

## Agent Skills

- `mcu-download`：检测并下载最新 ELF，预检和执行结果包含 ELF SHA-256 指纹。
- `mcu-live-watch`：单次读取、分析趋势，或按面板/曲线/时间区间读取与导出真实图表历史 CSV。临时趋势采样的启动、进度与关闭会同步到侧边栏和图表。添加到图表时优先使用最近聚焦的面板，无已打开面板时保存到图表 #1。
- `mcu-chip-info`：按 `identity`、`debug`、`runtime` 分组或指定字段读取芯片信息。
- `mcu-config`：读取或修改 ELF、调试器、MCU、SVD、OpenOCD 和采样参数。
- `mcu-var-write`：按变量名安全写入标量或复合变量叶子成员，使用两阶段确认、ELF 指纹绑定和写后回读校验。
- `mcu-fault-analyzer`：读取并解码 Cortex-M 故障寄存器，并使用当前 ELF 对 PC/LR 进行符号化。
- `mcu-elf-analyze`：离线分析当前 ELF 的 Flash/RAM 占用、段布局和大符号，不占用调试探针。
- `mcu-flash-verify`：读取目标 Flash 并与当前 ELF 的可加载内容进行校验。

扩展通过只监听本机的 Agent Bridge 处理配置和界面联动，并继续统一管理探针互斥。ELF 每次读取都会重新计算内容指纹和解析符号；采样期间 ELF 改变时会中止，避免继续使用旧变量地址。

只有当前项目安装了 EmberProbe Agent Skills 时，扩展才会启动 Bridge，并在项目 Skills 共享运行时目录的 `.agents/skills/_emberprobe/agent-bridge.json` 写入一个不含令牌的临时指针。项目根目录不再创建 `.emberprobe`；全局安装 Skills、打开侧边栏以及使用烧录、调试、实时变量等普通功能也不会写入该指针。卸载项目级 Skills 时，指针会随 `_emberprobe` 运行时目录一起删除。

## 开发与构建

```powershell
npm install
npm run check
npm run quality
npm run test:e2e
npm run package
```

准备新版本时运行 `npm run release:prepare -- <version> --date YYYY-MM-DD`，脚本会同步版本元数据、README 和 Changelog。推送匹配版本的 `vX.Y.Z` 标签后，Release 工作流会自动创建 GitHub Release 并上传 VSIX；发布及重试方式见 [docs/RELEASING.md](docs/RELEASING.md)。真机测试接入方式见 [test/hil/README.md](test/hil/README.md)。当前扩展版本为 `0.6.3`。

## 项目结构

```text
src/       扩展实现
resources/ Windows x64 OpenOCD 包及其自带的许可证
media/     商城与活动栏图标
skills/    自带的 Agent Skills
test/      单元测试与 OpenOCD Tcl-RPC 集成测试
esbuild.js 单文件 VSIX 打包构建配置
```

## 许可证与归属

扩展代码采用 MIT 许可证。npm 运行时依赖与自带 xPack OpenOCD 的许可证及来源信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
