# EmberProbe

EmberProbe 是一款面向 Cortex-M 开发的 VS Code 扩展。它基于 OpenOCD，提供固件烧录、目标自动识别与实时变量观测。

> [English documentation](README_EN.md)

## 功能特性

- 自动检测工作区中最新的 ELF 文件与 MCU 目标。
- 芯片信息读取：通过 OpenOCD 非侵入式读取芯片内核、Device ID、Flash 容量、UID、调试链路与运行状态。
- ELF文件烧录：一键烧录ELF文件并运行。
- 实时变量观测：在目标运行时非侵入式读取 Cortex-M 内存；侧边栏提供独立数值列表，可同时打开多个拥有独立观察列表和历史缓冲的实时图表面板。
- 实时变量写入：在目标运行时实时更改内存，提供滑条、输入框、鼠标滚轮多种值更改方式，更改后自动回读。
- Cortex-Debug 联动：启动断点调试。
- 可选安装十个 Agent Skills，覆盖固件下载与校验、实时变量读写、SVD 外设调试、Cortex-Debug 会话/断点控制、芯片和故障信息读取、ELF 分析，以及配置同步。

## 环境要求

- Visual Studio Code 1.85 或更高版本
- OpenOCD
- Cortex-Debug 插件(可选)

## 实时变量观测

侧边栏列出当前 ELF 的所有全局/静态变量；点击变量可将其加入独立数值列表。

- 类型支持：标量优先使用 DWARF 类型信息，支持 `u8/i8/u16/i16/u32/i32/f32/u64/i64/f64`；结构体、联合体和数组可展开并选择标量叶子成员。
- 64 位精度：`u64/i64` 图表在 ±2^53 外使用 Number 近似值；侧边栏、CSV 和 Agent 结果优先使用精确十进制 `valueText`。
- CSV 导出：可选择包含已隐藏曲线在内的任意有数据系列；剪辑轨道式双端时间轴始终可见，非自定义模式时置灰，自定义模式默认全选且右端为打开导出对话框的时刻。
- 实时写入：侧边栏可把具有可靠 DWARF 类型且位于 ELF 可写段的标量加入写入列表；写入只在采样会话运行时启用，并在每次写入后回读校验。
- 限制：仅支持 Cortex-M 及固定地址的全局/静态变量；采样带宽有限（约 10–50 Hz）。多面板共享采样启停和间隔，内存占用随面板数线性增长，每个面板分别受 `maxSamples` 限制。
- 相关设置：`emberprobe.tclPort`、`emberprobe.sampleIntervalMs`、`emberprobe.maxSamples`。

## Agent Skills

- `mcu-download`：检测并下载最新 ELF，预检和执行结果包含 ELF SHA-256 指纹。
- `mcu-live-watch`：单次读取、分析趋势，或按面板/曲线/时间区间读取与导出真实图表历史 CSV。
- `mcu-chip-info`：按 `identity`、`debug`、`runtime` 分组或指定字段读取芯片信息。
- `mcu-config`：读取或修改 ELF、调试器、MCU、SVD、OpenOCD 和采样参数。
- `mcu-var-write`：按变量名安全写入标量或复合变量叶子成员，使用两阶段确认、ELF 指纹绑定和写后回读校验。
- `mcu-fault-analyzer`：读取并解码 Cortex-M 故障寄存器，并使用当前 ELF 对 PC/LR 进行符号化。
- `mcu-elf-analyze`：离线分析当前 ELF 的 Flash/RAM 占用、段布局和大符号，不占用调试探针。
- `mcu-flash-verify`：读取目标 Flash 并与当前 ELF 的可加载内容进行校验。
- `mcu-peripheral-debug`：解析工作区 SVD，查询、读取和解码外设寄存器/位域，并通过每次一次性确认执行暂停态安全写入。
- `mcu-debug-control`：启动、停止和控制 Cortex-Debug 会话，支持暂停/继续/单步/重启以及源码行和函数断点管理。

## 开发与构建

```powershell
npm install
npm run check
npm run quality
npm run test:e2e
npm run package
```

准备新版本时运行 `npm run release:prepare -- <version> --date YYYY-MM-DD`，脚本会同步版本元数据、README 和 Changelog。推送匹配版本的 `vX.Y.Z` 标签后，Release 工作流会自动创建 GitHub Release 并上传 VSIX；发布及重试方式见 [docs/RELEASING.md](docs/RELEASING.md)。真机测试接入方式见 [test/hil/README.md](test/hil/README.md)。当前扩展版本为 `0.7.1`。

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
