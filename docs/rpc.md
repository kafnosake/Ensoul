# 后端直连（脱离 Electron 调用）

后端启动后会在两个地方各留一份凭据（`%APPDATA%\ensoul\`）：

| 文件 | 内容 |
|---|---|
| `rpc-channels.json` | 全部能力清单（名字 + 条数） |
| `rpc-endpoint.json` | 端口 + 一次性令牌 + 条数 |

## 调一次

```bash
PORT=$(node -p "require(require('os').homedir()+'/AppData/Roaming/ensoul/rpc-endpoint.json').port")
TOKEN=$(node -p "require(require('os').homedir()+'/AppData/Roaming/ensoul/rpc-endpoint.json').token")

curl -s -X POST "http://127.0.0.1:$PORT/rpc" \
  -H "content-type: application/json" \
  -H "x-ensoul-token: $TOKEN" \
  -d '{"channel":"ws:state","args":[]}'
```

## 三个口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 探活：端口、能力条数 |
| GET | `/channels` | 列全部能力名 |
| POST | `/rpc` | `{channel, args}` → `{ok, result}` |

## 规矩

- 只绑 `127.0.0.1`，局域网连不上
- 每次启动换一枚新令牌，本机别的程序也调不动
- 12 条窗口硬件能力（拖动/撕窗/浮窗）拒绝远程调用
