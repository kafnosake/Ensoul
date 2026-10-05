#!/bin/sh
# 把 git 历史压成一条新提交 —— 让仓库彻底瘦下来，旧版本（连同旧版本里的
# node_modules / 备份 / 出图产物）永远从历史里消失。
#
# 为什么要这么干：.gitignore 只能挡住**以后**的提交。历史里那 5600 个临时文件
# 是**已经提交过**的，它们还压在每一次 push 要传的包里（实测：本地 .git 420MB，
# 远端 ~96MB），而且每次跨机器同步都在这些老版本上打架。
#
# ⚠ 会改掉**所有提交的 hash**：
#   - 远端强推后，另一台机器上的旧 clone 无法再 pull/push，必须**重新 clone**
#   - 提交历史被压成一条（这个项目的旧历史只有几天的"上传/更新"，没有价值）
#   - 不可逆。跑之前先确认本地没有别的机器独有的、还没推的提交
#
# 用法： sh scripts/slim-repo.sh            # 只重写本地，不推
#        sh scripts/slim-repo.sh --push     # 重写 + 强推远端

set -e
cd "$(dirname "$0")/.."

say() { printf '\033[36m[瘦身]\033[0m %s\n' "$1"; }

if [ -n "$(git status --porcelain)" ]; then
  say "工作区不干净，先提交或丢弃改动："
  git status -s
  exit 1
fi

say "重写前：$(git rev-list --count HEAD) 个提交，.git $(du -sh .git | cut -f1)"

# 用一个孤儿提交把当前工作区快照成唯一的历史。
# 不碰工作区文件，只重建历史 —— node_modules 之类此刻已在 .gitignore 里，
# 所以不会被新提交收进去。
BRANCH="$(git symbolic-ref --short HEAD)"
say "把 $BRANCH 压成一条新提交…"
git checkout --orphan __slim__
git add -A
git commit -q -m "ensoul: 当前状态（历史已压缩，只留源码）"
git branch -D "$BRANCH"
git branch -m "$BRANCH"

# 顺序很讲究（踩过，别再改回去）：**先强推，后 gc**。
# 理由：push 之前 refs/remotes/origin/main 还指着旧历史，那些旧对象全都"可达"，
# gc 一个都不敢删 —— 实测那次 gc 完 .git 还是 389MB，看着像没生效；
# push 完引用全指向新提交了，再 gc 才降到 739KB。
if [ "$1" = "--push" ]; then
  say "强推远端（会覆盖远端历史）…"
  git push --force -u origin "$BRANCH"
  say "远端引用已换成新历史。注意 Gitea 那边旧对象不会自己释放，"
  say "要让管理员去仓库设置里执行一次垃圾回收，磁盘才真的省下来。"
else
  say "这次只重写本地。要推：sh scripts/slim-repo.sh --push"
fi

say "回收旧对象（把不可达的旧版本删掉）…"
git reflog expire --expire=now --expire-unreachable=now --all
git gc --prune=now

say "重写后：$(git rev-list --count HEAD) 个提交，.git $(du -sh .git | cut -f1)"
say "跟踪文件：$(git ls-files | wc -l | tr -d ' ') 个"
say "另一台机器对不上新历史了 —— 在那边把 .git 删掉重新拉，别 pull。"
