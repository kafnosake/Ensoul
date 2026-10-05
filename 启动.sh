#!/bin/sh
# Ensoul launcher (macOS / Linux) —— 和 启动.cmd / 启动.command 是同一份逻辑。
#
# 为什么这里只有一行：平台判断和 electron 的路径全在 scripts/launch.js 里，
# 三个入口各写一遍就会出现三种行为（这个文件以前就写死过
# `node_modules/electron/dist/Electron.app/...`，在 Intel Mac 和 Apple 芯片上
# 还对，但换台机器就错）。
#
# 这里**绝对不能出现 npm install**：以前它用"dist 在不在"判断依赖装没装，
# 结果一个 electron.exe 不见了就重装整个 node_modules —— 断网那次直接把
# 构建工具链删了，连 vite build 都跑不起来。缺什么补什么，别重装。
cd "$(dirname "$0")" || exit 1
node scripts/launch.js
