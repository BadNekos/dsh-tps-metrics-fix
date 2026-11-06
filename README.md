# 端到端 TPS 计量修正

面向当前 DSH `0.2.1-rc.5` 的持久化插件。修正原生会话统计、owo 圆环内的统计，以及轨迹中请求/消息的计时面板；不限定一个“合理 TPS”上界，不估算 token，不修改已记录的会话事件。

## 指标

单次有效响应：`API outputTokens / ((assistant/message.time - step/start.time) / 1000)`。

会话累计：`同一批有效响应的 sum(outputTokens) / (sum(完整响应耗时) / 1000)`，不是各次 TPS 的简单平均。输出采用最终有效响应的 API 用量；如果 API 将隐藏推理计入输出，它们包含在分子内。步骤内失败尝试不重复加算 token，但其等待/重试耗时包含在逻辑步骤的端到端耗时中。后续工具执行不包含在请求分母内。

紧凑读数只保留 `tok/s`，不显示额外 E2E 英文标志；详情明确标为 **端到端 TPS**，并保留计算说明。它包含请求准备、首输出前等待与推理以及响应记录收尾，不能解释成服务端内部解码速度。原有 TTFT 和首 delta 后的区间保留为观测指标，不再作为 TPS 分母。

缺失、非法或矛盾用量，中断响应，不完整开始边界，倒退/零时长，以及短于 `minDurationMs` 的样本明确不可测并排除。时长与速率均不钳值；缺数据不沿用旧速度。历史会话由官方投影框架重放现有日志，分页/刷新不会把会话累计变成仅加载窗口的速度。

## 扩展方式和兼容边界

- Host 通过官方 `sessionProjections.register()` 注册独立的 `dshTpsMetrics` JSON 投影；配置阈值编码进 `stateVersion`，不会重用另一阈值的旧 checkpoint。
- 原生 `conversation.composer.dock/activity` 和 owo `conversation.input.right/dsh-owo.client-ui-composer-usage` 使用官方同 id、较低 priority 的 Slot 替代，复用原控件，仅适配其速率输入与标签。上下文圆环、缓存/用量、计数、权限、发送、其他插件和留白保持原有功能。owo 的空白原生统计替代仍优先于未显示的原生控件，不新增重复速度。
- 原始轨迹的计时子面板没有独立公开 Slot，其视图又拥有图片子 Slot，不可重复声明。只有这里使用限定版本的兼容层：包装现有 trajectory 注册的 Component 引用，在 React 返回树中只穿过已有请求/记录计时路径，替换包含明确 `AssistantMetricDetail` 字段的计时面板。不改 React 全局、组件原型、DOM、Session 数据、provider 或时间戳；保留原视图的注册、图片授权、注入、工具详情、搜索与时间线。卸载仅在仍拥有该引用时恢复，检测到后来的竞争写入则不覆盖。

包通过 `engines.dsh` 设置最低版本 `0.2.1-rc.5`，不再锁定单一版本；已核对版本仍为 `0.2.1-rc.5`，放宽声明不代表所有后续版本都经过验证。组件/注册 API 不匹配会在输入框下方给出兼容提示，不把未知结构当作已修正。安装后建议在原 GUI URL 刷新一次；没有启动替代服务器。

## 配置与安装

`enabled` 默认 `true`；`minDurationMs` 默认 `100`，允许 `1`–`60000`。低于阈值的样本不显示速率，并非把分母补到阈值。

新源码目录首次安装前，需仅在插件源码目录运行 `pnpm install --ignore-scripts`，补齐本地链接包的运行时依赖；不要在 profile 目录运行此命令。本次依赖已补齐。然后由 DSH Plugin Manager 安装此目录，或通过 agent 的 `plugin_manager install_bundle` 安装。只改当前 profile，影响该 profile 的所有会话；不手写 profile 的配置文件。禁用该 bundle 可恢复原统计与轨迹视图。

## 验证

纯数学、事件折叠和 UI 数据适配的回归测试在 `tests/`，运行 `node --test tests/*.test.mjs`。覆盖隐藏推理/缓冲、重试、加权累计、缺失与异常数据、引用稳定、去重、JSON 重放和 fork 历史。测试不用 React/DOM 模拟，也不启动真实模型请求。

构建出的 `client.js` 只请求已有 React 模块；其余本地纯函数构建时内联，不导入其他 Harness Client 功能包。Host 和 Client 的实际注册需另外在已连接的 GUI 上检查。语法、单元测试、安装成功或 Slot 注册不等于视觉、点击与卸载交互验证；无法控制浏览器时应明确保留此验证限制。

本次执行结果：89 项测试通过；Plugin Manager 启用结果为 `applied` 且无激活警告；已连接页面的统计替代注册为 active。用户已确认会话和轨迹两处显示了新指标。额外 E2E 英文标志随后移除，并通过官方 `clientModules.rebuilt()` 发布重构后的前端文件；临时构建通知插件已撤回。明暗主题、图标实际绘制和真实卸载交互未进行完整浏览器验收。

图标为本插件原创 SVG，代码及图标使用 MIT 许可证。
