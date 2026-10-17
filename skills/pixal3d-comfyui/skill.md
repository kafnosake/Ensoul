---
name: pixal3d-comfyui
description: 用 ComfyUI 把一张图转成 3D 模型（.glb）—— Pixal3D / Trellis2 图转 3D 的完整链路：可用工作流、必需模型、避坑与实测耗时。用户说「建模 / 图转 3D / 生成 3D 模型 / pixal3d / trellis / 转 glb」时用它。
---

# Pixal3D 图转 3D（ComfyUI **内置**链路）

> **一句话：ComfyUI 0.37+ 核心自带整条 Pixal3D / Trellis2 链路，不需要编译任何 CUDA 扩展。**
> 去官方仓库编 `natten` / `cumesh` / `flex_gemm` / `o_voxel` 是**死路**，别再走。

## 为什么"没装那些包"也能跑（先看这条，能省一整晚）

ComfyUI 核心已用**纯 PyTorch** 重写了全部底层：

| 官方仓库里要编译的东西 | ComfyUI 核心的替代实现 |
|---|---|
| `natten`（NAF 的邻域注意力） | `comfy/image_encoders/naf.py` |
| `flex_gemm`（稀疏卷积） | `comfy/ldm/trellis2/flexgemm.py` |
| `cumesh`（remesh / xatlas 展开） | `comfy_extras/nodes_mesh_postprocess.py` |
| `o_voxel`（体素编解码） | `comfy/ldm/trellis2/vae.py`、`nodes_mesh_postprocess.py` |

所以 `pip list` 里查不到 `natten` / `cumesh` / `flex_gemm` / `o_voxel` —— **这是正常的**。

**`natten` 官方根本没有 Windows 轮子**：`https://whl.natten.org` 全量索引里 `win_amd64` 条目数为 **0**，
只有 `linux_x86_64` / `linux_aarch64`。在 Windows 上它只能源码编译，而它内嵌的 cutlass 在 MSVC 下编不过
（`cutlass/exmy_base.h(404): error: namespace "cutlass::platform" has no member "is_unsigned_v"`）。
**这条路没有出口，别试。**

---

## 环境事实（本机）

| 项 | 值 |
|---|---|
| ComfyUI 版本 | 0.37.2（**必须 ≥ 0.37**，更早的没有这几个节点） |
| 启动方式 | ComfyUI Desktop，`--base-directory D:\ComfyUI` |
| 代码目录 | `C:\Users\KATU\AppData\Local\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI` |
| Python | `C:\Users\KATU\Documents\ComfyUI\.venv\Scripts\python.exe`（3.12.11 + torch 2.9.1+cu130） |
| 模型目录 | `D:\ComfyUI\models` |
| 输出目录 | `D:\ComfyUI\output` |
| 日志 | `D:\ComfyUI\user\comfyui_8000.log` |
| 服务端口 | 8000（`http://127.0.0.1:8000`） |

**核心实现文件（要改/要看时去这儿）：**
- 节点：`comfy_extras/nodes_trellis2.py`（`Pixal3DConditioning`、`Trellis2ShapeStage`…）
- 网格后处理：`comfy_extras/nodes_mesh_postprocess.py`（`DecimateMesh`、`UnwrapMesh`、`BakeTextureFromVoxel`…）
- 模型：`comfy/ldm/trellis2/`（`model.py`、`vae.py`、`flexgemm.py`）、`comfy/image_encoders/naf.py`、`comfy/image_encoders/dino3.py`、`comfy/ldm/moge/`

路径都相对上面那个「代码目录」。

---

## 工作流：用官方模板，别自己拼

ComfyUI 自带两个官方模板（模板包在 venv 里）：

```
C:\Users\KATU\Documents\ComfyUI\.venv\Lib\site-packages\comfyui_workflow_templates_json\templates\
    3d_pixal3d_trellis2_image_to_model.json     ← 单图转模型（主用这个，66 节点）
    3d_pixal3d_multi_views.json                 ← 多视角（front/left/back/right）
```

**在 ComfyUI 界面里**：`模板 / Templates` → 分类 `3D` → `Pixal3D`。
> ⚠ 这两份都是**界面用的 UI 格式**，直接拿去提交会被 400 拒 —— 要出图必须先「导出（API）」，见下一节。

本技能目录下两份，**看清楚是哪一份**：

- `workflow-image-to-model.json` —— 官方模板原件，**UI 格式**（顶层是 `nodes` 数组 + `links`）。这份是给 ComfyUI 界面打开的，**不能直接提交给出图工具**。
- `workflow-image-to-model-api.json` —— **API 格式，出图就用这份**。已注入 `{{image}}`（LoadImage）和 `{{prompt}}`（Save3DAdvanced 的 filename_prefix）。

### 硬规矩：工作流一律走「导出（API）」，不许手写转换器

官方模板是 UI 格式，`/prompt` 只吃 API 格式（顶层是「节点 id → {class_type, inputs}」的对象）。
两者**不是改改字段名的事** —— 下面这几处的格式猜不出来，手写转换器必挂在这里：

| 字段 | 正确写法 |
|---|---|
| `RemeshMesh.sign_mode` | 字符串 `"udf"`，子项写成**扁平的带点键**：`"sign_mode.qef"`、`"sign_mode.drop_inverted_components"`、`"sign_mode.drop_enclosed_components"`。三个都得给，缺一个报 `RemeshMesh.execute() missing 1 required positional argument: 'sign_mode'` |
| `DecimateMesh.placement_mode` | 同样扁平：`"placement_mode": "midpoint"` |
| `Save3DAdvanced.viewport_state` | **内嵌对象** `{image, mask, normal, camera_info:{position,target,zoom,cameraType,quaternion}}`。这是界面里的画布状态，命令行本来就没有；漏了报 `Required input is missing: viewport_state` |

最容易漏的两处：`RemeshMesh` 的 `sign_mode` 子项，和 `ImageCropToMask` 的 `masks`（它必填 `images + masks + width + height + pad_factor + grow_mask + background`，`masks` 那一路接 `MaskPreview`）。
这两处被 400 拒过，也别指望靠 `node_errors` 猜出来 —— 它一次只报一部分，补一个又冒一个。

拿 API 格式只有两条路：

1. ComfyUI 界面 → 打开模板 → `工作流 → 导出（API）`；
2. 直接用本技能目录的 `workflow-image-to-model-api.json`（就是按 ① 导出来的，已带占位符，换掉源图路径即可）。

**服务端没有 UI→API 的转换接口**：`/api/workflows/convert`、`/api/convert` 一律 405，别去找。

### 跑一次约 6 分钟，出图工具一定先超时

实测 `Prompt executed in 341.75 seconds`（5 分 42 秒：加载 5.3 GB int8 权重 + 条件 + 形状采样 12 步 + 上采样 + 贴图烘焙）。

`comfyui_run` 的等待上限默认 300 秒，**必然先于任务结束超时**。报 `TOOL_TIMEOUT` **不等于失败** ——
这时候别重跑（会白白多跑一遍 6 分钟），去 `D:\ComfyUI\output\3d\` 按修改时间捞最新那份 `.glb`，
文件头 4 字节是 `glTF` 即有效，再复制进工作区。

真想一次拿到结果，就把 `comfyui` 插件的 `timeout` 参数提到 900（`plugin_params`，
改完下一轮生效），否则每次都得超时后收尾一次。

---

## 模型清单（8 个文件，必须全部齐）

| 文件名 | 放到 | 大小 | 作用 |
|---|---|---|---|
| `pixal3d_int8_convrot.safetensors` | `models/diffusion_models/` | 5.3 GB | **Pixal3D 主模型**（单图） |
| `pixal3d_multiview_int8_convrot.safetensors` | `models/diffusion_models/` | 5.3 GB | Pixal3D 多视角 |
| `trellis_2_int8_convrot.safetensors` | `models/diffusion_models/` | 5.0 GB | Trellis2 底座（模板里的开关可切） |
| `trellis_2_texture_vae_bf16.safetensors` | `models/vae/` | 904 MB | 贴图 VAE |
| `trellis_2_shape_vae_bf16.safetensors` | `models/vae/` | 1.0 GB | 形状 VAE |
| `dino_v3_L_naf_fp32.safetensors` | `models/clip_vision/` | 1.2 GB | DINOv3 + **NAF 权重已打包在里面** |
| `moge_2_vitl_normal_fp16.safetensors` | `models/geometry_estimation/` | 631 MB | MoGe-2 相机估计 |
| `birefnet.safetensors` | `models/background_removal/` | 424 MB | 抠图 |

**这 8 个走 int8 量化（`int8_convrot`），不是官方那 46GB 全量权重。** 量化版显存友好得多。
ComfyUI 自带的模型下载器里能直接搜到这几个（用户说的"comfyui 自带的下载"）。

---

## 节点链路（单图模板，跑通实测）

```
LoadImage
  → RemoveBackground (birefnet)          ← 抠图
  → ImageCropToMask (pad_factor=1.1)
  → [ LoadMoGeModel → MoGeInference → MoGeGeometryToFOV ]   ← 相机 FOV
  → CLIPVisionLoader (dino_v3_L_naf_fp32)  ← DINOv3 + NAF
  → Pixal3DConditioning (image + clip_vision + fov)         ← Pixal3D 条件
  → EmptyTrellis2LatentStructure
  → Trellis2ShapeStage  → KSampler → VaeDecodeShapeTrellis  ← 生成几何
  → Trellis2UpsampleStage                                     ← 上采样
  → Trellis2TextureStage → KSampler → VaeDecodeTextureTrellis ← 生成贴图
  → VoxelToMesh → GetMeshInfo
  → DecimateMesh          ← QEM 简化（默认降到 200k 面）
  → UnwrapMesh            ← LSCM UV 展开
  → BakeTextureFromVoxel  ← 烘焙贴图
  → ApplyTextureToMesh
  → Save3DAdvanced / MeshToFile3D   → .glb
```

**`ComfySwitchNode` 控制 Pixal3D / Trellis2 走哪条**：`Pixal3DConditioning` 那条吃带 proj 特征的条件
（`proj_feat_pack`），输出 `model_frame = "y_up"`；换回 `Trellis2Conditioning` 就是 `z_up`。

---

## 实测结果（1024 分辨率）

| 指标 | 值 |
|---|---|
| 端到端耗时 | **约 182 秒 / 张** |
| 显存 | 16 GB（RTX 5080）够用 |
| 原始网格 | 约 653 万顶点 / 1367 万面 |
| 简化后 | `DecimateMesh` → 约 20 万面 |
| 输出 GLB | 50–58 MB |
| 输出位置 | `D:\ComfyUI\output\3d\*.glb` |

---

## 排障

0. **打不开 http://127.0.0.1:8000（首页 404，但 /api/... 全 200）** → 插件的 `frontend`（--front-end-root）指向错目录了。
   实测那次指到 `...\ComfyUI-Installs\ComfyUI\ComfyUI\web`，那里面**只有 extensions、没有 index.html**，所以首页 404。
   真正的前端在 pip 包里：
   `C:\Users\KATU\Documents\ComfyUI\.venv\Lib\site-packages\comfyui_frontend_package\static`（有 index.html）。
   修法：`plugin_params set comfyui frontend ""` 清空 → `comfyui_launch restart` → `/` 返回 200 text/html 即好。
   这件事要紧：**「工作流 → 导出（API）」是界面里的功能**，UI 打不开就没法导 API。


1. **节点里找不到 `Pixal3DConditioning`** → ComfyUI 版本 < 0.37。升级 ComfyUI 本体，不是装插件。
2. **`Model Trellis2 prepared for dynamic VRAM loading`** → 这是核心正常加载日志，不是错。
3. **显存不够** → 模板里有 `low_vram` 相关开关；或把 texture resolution / decimation 调小。
4. **别去装 `ComfyUI_RH_Pixal3D` 那类第三方插件来跑这条路**：它自带一整套外部 CUDA 扩展依赖，
   而核心内置版**不需要**。两套混着装只会互相打架。
5. **服务停了想看状态**：`netstat -ano | findstr :8000`，然后看 `D:\ComfyUI\user\comfyui_8000.log` 尾部。

---

## 一句话验收

跑完在 `D:\ComfyUI\output\3d\` 下拿到 `.glb`；文件头 4 字节是 `glTF` 即有效。
