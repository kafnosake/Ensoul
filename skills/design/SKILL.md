---
name: design
description: 美术设计与视觉管线套件，涵盖 ComfyUI 工作流出图、视觉资产切片与风格控制
whenToUse: 用户需要美术出图、设计界面样式规范或处理多媒体图片资产时
---
# 美术视觉技能套件 (Design Suite)

## 包含的细分子技能
1. **design/comfyui-flux**：Flux / SDXL 高品质提示词与生图工作流选型。
2. **comfyui-draw**：ComfyUI 进程探活与标准调用流。

## 工作流规则
- 出图前先确认模型在服务器中实际存在，避免无效等待。
- 只有成功拿到图像文件后才向用户确认交付，严禁幻觉交付。
