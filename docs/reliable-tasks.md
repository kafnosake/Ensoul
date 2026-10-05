# 持久任务：使用与实现

本批将分身和员工派单接到同一个任务服务。面板、模型、工具管线和 outbox 沿用现有实现，没有另造 agent 执行循环。

## 使用

- `subagent_run` 和 `dispatch` 登记后立即返回 `taskId`，不等待另一面板整轮执行。
- `task_status({taskId})` 或 `/tasks task-…` 查询结果；不填编号列出当前面板相关的最近 100 项，不需要模型循环轮询。
- 聊天区任务列表通过事件更新，可以打开实际执行会话、取消任务、确认验收。
- `task_cancel({taskId})` 取消该项及后代。停止父会话也取消本轮派出的后代，包括经理已结束而员工仍在执行的情况。
- 调度面板撤单接到真实取消；验收需会话及后代成功结束、提交完整文件。打回重做登记新任务编号。已取消任务不通过“恢复”重放，重新派单使用新请求编号。

派单 `ok:true` 只表示已登记。`completed` 是会话成功结束；`delivery` 是文件交付；`acceptance` 是发起面板确认验收。文件存在不能证明代码正确，验收前仍按任务范围验证。

## 请求与恢复

`requestId` 在“工作区 + 发起面板”内去重。重试沿用原编号；正文或目标变化使用新编号。默认编号根据本轮 run/task 与内容生成；跨轮同义自然语言不会自动去重。分身重试先查记录，避免新建第二块面板。

`.ensoul/state/tasks.json` 由主进程独占写入，临时文件写完再替换。先记任务再补 outbox；开始前先记 running 与 runId，再移除队列。工作区切换要求执行收尾，队列项保存所属工作区。

```text
queued → running → completed / failed
   └→ cancelled    └→ cancelling → cancelled
running ──进程退出──→ interrupted
```

启动补齐 queued 的 outbox；running 标记 interrupted，不自动重做；cancelling 标记 cancelled；停止或中断任务的未结束后代取消。避免重启后盲目再次执行，但不承诺外部副作用的 exactly-once。中断任务先检查文件、命令或外部服务实际效果，再决定新请求。

每面板由 runId 租约串行执行，忙时排队。普通队列原有“失败或停止后暂停接力”保留；修好原因后显式继续发送，或重启恢复尚未开始的任务。取消任务不恢复。没有新增全局模型并发额度或依赖调度器。

派单 token 关联任务链，按当前 taskId 选择令牌，避免多单排队拿错号；重复文件交付不再次发送图片。插件恢复根据任务日志补齐尚未写入的持有人，并同步停止状态；日志变化才解析任务索引。旧收件箱、历史会话和分身记录保留。

## 入口与边界

| 职责 | 入口 |
|---|---|
| 登记、状态、恢复、取消树、验收 | `src/main/task-service.ts` |
| 类型 | `src/shared/types.ts` 的 TaskApi / TaskRecord |
| outbox、doSend、IPC、父 run 停止 | `src/main/index.ts` |
| 宿主桥 | `src/main/plugins.ts` 的 api.tasks |
| 派单、分身、查询 | `plugins/dispatch`、`plugins/subagent`、`plugins/tasks` |
| 列表 | `src/renderer/panel/ChatDock.tsx` |

插件工具接入时直接传入当前 ctx，保存父任务与 run 的关系：

```js
const result = api.tasks.submit({
  panelId: target.id, title: '调查问题', text: '范围与验收条件', requestId: '稳定编号',
}, ctx);
// result.task.id 查询；result.ok 只表示登记，不是完成。
```

`api.tasks` 还提供 get、request（按发起面板与请求编号）、list、cancel、cancelCorrelation、delivered、accept。工具 handler 的 ctx 包含 panelId、runId、可选 taskId 和 signal。只在仍有效的父 run 中新增子任务；已登记请求可以查询与复用。

第三方插件仍是受信任 Node 代码，能直接写文件或忽略取消。任务服务不撤销已写文件，也不是权限沙箱。后续生命周期、状态写入和长任务执行器继续复用此服务。

## 验证

`npm run test:runtime` 编译后执行两组测试，全部写随机系统临时目录，模型使用替身。覆盖去重、日志/outbox 中断、恢复、迟到结果、父子取消、写盘失败、工作区隔离、验收，以及真实派单插件的多令牌、转派、撤单、验收、重做和重复交付。不会加载全部插件、访问付费模型或改真实工作区状态。

可靠性判断：已覆盖行为把握较高；真实模型完成质量、全部界面交互和长期日志性能需继续验证，没有测得可承诺的提速或成功率百分比。

本批完整构建通过；类型门禁仍为 29 条存量、无新增，未改基线。Node 与本机 Electron 的 Node 模式各通过 28 项（运行时 15 + 持久任务 13）；插件语法与 diff 空白检查通过。

应用状态：产物已构建，主进程仍是上一版（本机 RPC 116 项能力）。自动审批拒绝了 taskkill 强制重启，未执行退出或启动新实例；使用托盘菜单“退出”后重新启动才能应用本批 main/preload。渲染层兼容旧 preload，待重启后启用新任务列表。新版本完整启动与真实模型端到端验收尚未完成。
