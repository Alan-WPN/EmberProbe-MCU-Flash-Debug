# EmberProbe 技术债优化计划

> 状态:已完成(2026-08-24)。本计划只做**行为不变的结构重构**,不混入 ROADMAP 新功能。
> 原则:每个阶段独立可交付、可独立回滚;全程保持 `npm run quality` 绿色;
> 每阶段先补"锁定当前行为"的测试,再动代码(先钉地板、再拆墙)。

## 实际完成记录

| 阶段 | 结果 |
|------|------|
| P0 | 基线 `npm run check` / `npm run quality` 绿色；c8 基线为 83.57% statements/lines、74.12% branches、93.02% functions；新增可确定性生成大规模 DWARF 的 `test/perf/parse-bench.js`。 |
| P1 | DWARF 聚合入口、单次解析缓存、统一 ELF32 格式层、统一类型/标量解码器与死分支回归测试全部完成。593 KiB `.debug_info` 冒烟中旧双解析 279.2 ms，聚合入口 110.4 ms，结果项一致。 |
| P2 | `services/openocdExec.js` 统一 spawn、ANSI/拆行、超时、ENOENT 与日志尾；chip/fault 业务文件已无独立 spawn/settled/pending 脚手架。 |
| P3 | `extension.js` 由 1794 行收敛为 62 行激活/注册入口；Provider 与 ELF、OpenOCD 状态、Skills、Agent、LiveWatch、芯片信息服务边界落地，状态单实例注入。 |
| P4 | 侧边栏/图表 CSS 与 renderer 抽到 `src/webview/`，esbuild 新增两个 Webview 目标；CSP/内容寻址流程保持，资产与纯函数测试通过。 |
| P5 | i18n 拆为 `i18n/index.js`、`zh.js`、`en.js`，原 `i18n.js` 只保留兼容导出。 |

最终验证:`npm run check`、`npm run quality`、`npm run bundle`、`npm run test:e2e` 全部通过。最终 c8 为 85.54% statements/lines、69.42% branches、93.5% functions。e2e 在容器内需使用可写 `XDG_RUNTIME_DIR` 并强制 X11。

## 技术债清单(按危害排序)

| # | 问题 | 位置 | 危害 |
|---|------|------|------|
| D1 | DWARF 同一 ELF 全量解析两遍 | `dwarf.js:286,482` 两个入口各自调用 `_parseDwarfInternal`;`extension.js` 的 `readElfSymbols` 连续调用两者 | 大 ELF 解析时间翻倍,用户可感知 |
| D2 | ELF 节头解析三份拷贝 | `elfSymbols.js`(parseElfSymbols / parseElfSections)、`dwarf.js`(readSections) 各自重写 ELF 头校验+节表遍历 | 改格式支持要改三处,易漏 |
| D3 | chipInfo / faultInfo 重复 OpenOCD 脚手架 | `chipInfo.js` 与 `faultInfo.js` 重复 spawn/超时/finish/ANSI 清洗/拆行,ENOENT 特判 4 份,拆行算法两种写法 | 每修一个 bug 要改两处;也是 0.6 ProbeSession 的拦路石 |
| D4 | extension.js 上帝文件 | 1794 行混杂 Webview Provider、ELF 缓存、Agent 编排、技能管理、芯片信息、OpenOCD 状态 | 改一处动全身;新功能只能继续堆 |
| D5 | Webview 单行压缩模板 | `modernView.js` / `liveWatchView.js` 的 CSS/JS 整段压在一行模板字符串里 | 图表逻辑不可单测、不可读,阻碍 0.6 图表交互(游标/缩放/统计) |
| D6 | dwarf.js 两套类型解析器 | `resolveType`(≈290-319)与 `_resolveTypeInfo`(≈337-380) 近乎相同 | 维护时极易改漏一处 |
| D7 | decodeValue / decodeScalar 重复 | `elfSymbols.js` 的 decodeValue 与 decodeComposite 内部 decodeScalar 是同一个类型 switch | 同上 |
| D8 | 死代码 | `elfSymbols.js` expandCompositeLeaves 中嵌套复合数组分支(循环体只有注释,随后无条件 return) | 误导维护者 |
| D9 | i18n.js 平铺大字典 | 702 行单文件,每个键要 zh/en 两处分散维护 | 加文案心智负担;仅中度优先 |

## 阶段划分

```
P0 基线 ──> P1 解析层(D1/D2/D6/D7/D8) ──> P2 进程层(D3) ──> P3 extension.js 拆分(D4) ──> P4 Webview(D5) ──> P5 收尾(D9)
        低风险纯函数,先行                为 ProbeSession 铺路      风险最高,放在解析层稳定后     可与 0.6 功能开发并行
```

顺序理由:
- P1/P2 是纯函数与独立模块,风险低、收益立竿见影(性能、去重),先做。
- P3 依赖 P1/P2 的产出(ELF 解析、OpenOCD 执行器已模块化,extension.js 才拆得动)。
- P5 放最后,且可无限期推迟,不阻塞任何事。

---

## P0 基线与安全网(0.5 天)

1. 跑通并记录 `npm run check` / `npm run quality` 基线,记录当前 c8 覆盖率数字。
2. 准备 2-3 个**真实规模的 Debug ELF**(如 STM32F4 带 `-g` 的固件,>10MB)放入 `test/fixtures/`(或用脚本生成合成 DWARF),新增一个解析性能冒烟脚本 `test/perf/parse-bench.js`(不进 CI,手动跑,记录耗时作为 D1 的对照基线)。
3. 约定:每个阶段一个 PR/commit 序列,动完即全量跑 quality。

**验收**:基线数据落档,fixtures 就位。

## P1 解析层重构(2-3 天,风险:低)

### P1.1 消除 DWARF 双解析(D1)
- `dwarf.js` 增加模块级缓存:`parseDwarfVariableTypes` 与 `parseCompositeLayout` 共享一次 `_parseDwarfInternal(buffer)` 的结果,键为 buffer 的内容指纹(或由调用方传入已算好的 ELF sha256,复用 extension.js 已有的指纹,避免再哈希一次大 buffer)。
- 注意:不要用 WeakMap 键控 buffer 后仍重复解析——目标是"一次解析、两个视图"。最直接的做法是把两个入口改为接受同一个 `{ dies, childrenMap }` 内部结构:
  ```js
  const parsed = _parseDwarfInternal(buffer);
  const types = buildVariableTypes(parsed);
  const layouts = buildCompositeLayouts(parsed);
  ```
- `extension.js` 的 `readElfSymbols` 改为调用新的聚合入口 `parseDwarf(buffer, sha256)`。
- 现有的 sha256 缓存(extension.js)继续作为外层缓存,两层缓存职责写进注释。

### P1.2 合并三份 ELF 节表解析(D2)
- 新建 `src/elfFormat.js`(或并入 elfSymbols.js 导出):`readElfHeader(buffer)` + `readSectionHeaders(buffer)` 单一实现,包含 ELF 魔数/class/data/32 位校验(三份拷贝里的判断合并为一份错误语义)。
- `elfSymbols.parseElfSymbols` / `parseElfSections` / `dwarf.readSections` 全部改为消费它。
- 顺手:把 `dwarf.js:59` readAddr 只读低 32 位的地方加上显式断言(ELF32 下恒真,防未来 ELF64 时静默截断)。

### P1.3 合并两套 DWARF 类型解析器(D6)与 decodeValue/decodeScalar(D7)
- `resolveType` 与 `_resolveTypeInfo` 抽出公共的 DIE→类型描述函数,两个入口只保留各自的输出形状转换。
- `elfSymbols.js` 的 decodeValue 与 decodeComposite 内部 decodeScalar 合并为一个 `decodeScalarBytes(bytes, offset, type)`。
- 现有 `test/dwarf-composite.test.js`、`test/composite-decode.test.js`、`test/elf-symbols.test.js` 是行为锁;如两套解析器存在微妙差异(很可能有),以"变量类型视图"为准、把差异写成显式测试用例后再合。

### P1.4 删除死代码(D8)
- 删除 `expandCompositeLeaves` 中嵌套复合数组带剩余路径段的空循环分支,并在原处补一条注释说明该场景(复合数组元素缺成员布局)为何返回空,避免后人再"补"出错误实现。
- 补一个针对该输入形状的单测锁定"返回空数组"的现状。

**验收**:perf 基线脚本显示大 ELF 解析耗时约减半;全部既有测试绿色;`grep` 确认 ELF 头校验/类型 switch 各只剩一份。

## P2 OpenOCD 共享执行器(1-2 天,风险:中低)

- 新建 `src/services/openocdExec.js`:封装 chipInfo/faultInfo 共用的"一次性 spawn → 行解析 → 超时 → close 对账"脚手架:
  ```js
  runOpenOcdOnce({ executable, probe, target, cwd, timeoutMs, buildCommands(), onLine(line) })
  ```
  统一:ENOENT 特判、15s 超时、ANSI 清洗、pending 拆行(采用 chipInfo 的正则版)、日志尾部留存(`openocdTail`,diagnostic 用)。
- `chipInfo.readChipInfo` 与 `faultInfo.readFaultInfo` 改为只保留各自的命令构造与行处理回调,spawn 部分全部收敛到执行器。chipInfo 的 278 行大函数预计减掉 ~100 行。
- 现有 `test/chip-info.test.js`、`test/fault-info.test.js` + `test/helpers/fake-openocd-server.js` 是行为锁;为执行器本身补单元测试(超时、ENOENT、异常退出)。
- **不为 ProbeSession 预做过度设计**:执行器只做"一次性运行",长生命周期会话属于 ROADMAP 0.6 的功能开发,届时让 LiveWatchSession 也复用其中的 spawn/日志解析工具函数即可。

**验收**:两处业务文件中不再有各自的 spawn/settled/拆行代码;全部测试绿色。

## P3 extension.js 拆分(3-5 天,风险:高,需小步提交)

目标形态(按现有 `src/services/` 惯例):

```
src/
  extension.js              # 仅 activate/deactivate + 注册 (~150 行)
  mainViewProvider.js       # WebviewView 生命周期、消息路由、updateView
  services/
    elfService.js           # readElfSymbols + 符号缓存 + 指纹失效(P1.1 后是纯编排)
    liveWatchService.js     # startLiveWatch/stop/采样回调分发/消费者状态
    agentOrchestrator.js    # _withAgentProbe/_runAgentSamples/agent 写入计划与执行
    chipInfoService.js      # readChipInfoAction + 芯片诊断写入侧栏
    skillStatusService.js   # refreshSkillStatus/管理入口/篡改告警
    openocdStatusService.js # refreshOpenOcdStatus/_resolveOpenOcdPath/安装动作
```

步骤(每步一个 commit,quality 绿后再下一步):
1. **先抽无状态纯逻辑**:ELF 符号缓存与解析(`elfService`)——它只依赖 context/workspaceState,最容易。
2. **抽 OpenOCD 状态/路径解析**(依赖 vscode,但接口窄:getConfiguration/window)。
3. **抽技能管理**(skillInstaller 已经独立,这步主要是搬方法)。
4. **抽 Agent 编排**(最大块;依赖前几步的产出与 WriteAuthorization、ProbeCoordinator)。
5. **抽 liveWatch 编排**;`mainViewProvider` 收敛为消息路由 + webview 装配。
6. `extension.js` 最终只留 activate/deactivate 与命令注册(现有 activate 里的订阅逻辑保留)。

依赖注入约定:各 service 构造函数收 `{ vscode, context, deps }`,沿用 `AgentService`/`ConfigurationStore` 现有风格;MainViewProvider 持有并转发。**不做事件总线、不做 DI 框架**——过度设计比重构本身更危险。

风险控制:
- 状态字段(`_liveSession`、`_probeCoordinator`、`_lastSkillStatus` 等)归属必须在动手前列清单,避免两处持有导致状态漂移;ProbeCoordinator 保持单实例注入。
- 拆分期间 webview 消息协议(`onDidReceiveMessage` 的 type 集合)一个都不改名,`test/webview.test.js` 作为锁。
- e2e 冒烟(`npm run test:e2e`)在每个里程碑跑一次。

**验收**:extension.js < 200 行;每个新 service 有对应单测(把原上帝文件里不可测的分支顺带补测);全部测试绿色。

## P4 Webview 模块化(2-3 天,风险:中,可与 0.6 功能开发并行)

- 把 `modernView.js` / `liveWatchView.js` 的内联 JS/CSS 拆为真实文件:
  ```
  src/webview/{sidebar,liveWatch}/index.js  app.css  renderer.js(chart)
  ```
- 构建路径:esbuild 已在,给 webview JS 加一个 bundle 目标(无 npm 依赖,纯手写 JS,bundle 只是拼接);`externalizeWebviewHtml` 的机制不变——改为把构建产物直接作为资产写入(内容寻址逻辑复用)。
- **可测性是首要目标**:把 `buildCsv` 已验证的模式推广——状态渲染、数组范围选择、写入节流等纯函数抽到可 require 的模块,补单测(写入节流 10Hz、shiftSliderBounds 等已有先例)。
- CSP/nonce/内容寻址机制不动;`test/webview-assets.test.js` 扩展为校验新构建产物。
- 注意:这一步动静大,单独开分支做,做完跑一次真实手工冒烟(侧栏 + 图表面板)。

**验收**:webview 渲染逻辑有单测覆盖;modernView/liveWatchView 不再含单行巨段 JS;手工冒烟通过。

## P5 收尾(0.5 天,可无限期推迟)

- D9:i18n 拆分为 `src/i18n/{index,zh,en}.js` 或引入按 key 分组的结构,纯机械移动,行为不变。

## 明确不做的事

- 不引入 TypeScript/打包框架迁移/Prettier 范围调整等工程链变更(与重构无关)。
- 不在重构分支混入任何 ROADMAP 功能(u64/位域/游标等在干净基线上开发)。
- 不做 ProbeSession 长生命周期会话(是功能设计,需要单独评审,本计划只消除它的结构性障碍)。

## 交付节奏建议

| 阶段 | 工作量 | 建议时机 |
|------|--------|----------|
| P0+P1 | ~3 天 | 立即(性能收益用户可感知) |
| P2 | 1-2 天 | P1 后紧接着 |
| P3 | 3-5 天 | 0.6 功能开发开始前完成最好;否则与功能开发交替会很痛 |
| P4 | 2-3 天 | 与 0.6 图表交互功能合并规划(先拆再加水到渠成) |
| P5 | 0.5 天 | 空闲时 |
