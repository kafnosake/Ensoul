---
name: design/comfyui-flux
description: Flux.1 与高阶 SDXL 生图提示词组织、正向自然语言描述与采样参数指引
whenToUse: 使用 Flux 或大模型画质模型进行高质量出图、角色立绘或场景设计时
---
# Flux 高阶生图 SOP

## 提示词策略
- Flux 模型优先使用**富有细节的英文自然语言长句**（Rich descriptive sentences），而非单纯以逗号隔开的 Danbooru 标签。
- 构图结构：[主体] + [服装与神态] + [光影与环境氛围] + [艺术风格与材质质感]。

## 参数标准
- 推荐分辨率：1024x1024, 896x1152, 1152x896。
- 引导系数 (Guidance Scale / CFG)：3.5 左右（Flux 架构通常适配低 CFG）。
