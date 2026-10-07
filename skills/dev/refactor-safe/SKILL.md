---
name: dev/refactor-safe
description: 高容错安全重构规范：范围控制、局部精准替换与无损回滚策略
whenToUse: 需要对现有模块进行结构调整、提取公用逻辑或替换底层实现时
---
# 安全重构规范 (Safe Refactoring SOP)

## 核心流程
1. **锚定范围**：改动前定位所有符号引用（利用 symbol_find 或 grep），限定影响半径。
2. **局部替换**：使用 edit 精准匹配上下文行，不要盲目大面积格式化。
3. **保留格式与行尾**：严禁无意识将 CRLF 刷成 LF 或反之。
4. **验证门禁**：重构完成后立即跑 build_project 确认类型与编译通过。
