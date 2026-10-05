# ensoul 设计素材

选定方向：浅色纸雕底板，两片不对称火焰环抱四角星。SVG 使用独立矢量路径、渐变、裁切与轻阴影，不嵌入 PNG；轮廓从选定图片提取并平滑，叠层明暗重新设计。原图保存在 `source/selected-reference.png`。

## 按场景选素材

| 场景 | 素材 | 建议尺寸 |
|---|---|---|
| 桌面、Dock、启动入口 | `svg/app-icon-light.svg` / `app-icon-dark.svg` | 48px 以上 |
| 小应用图标、网站 favicon | `svg/app-icon-micro.svg` / `app-icon-dark-micro.svg` | 16–32px |
| 透明底品牌标志，浅色背景 | `svg/mark-layered-light.svg` | 48px 以上 |
| 透明底品牌标志，深色背景 | `svg/mark-layered-dark.svg` | 48px 以上 |
| 顶栏、按钮、密集 UI | `svg/mark-micro.svg` | 16–32px |
| 单色打印、遮罩、模板托盘 | `svg/mark-mono-dark.svg` / `mark-mono-light.svg` | 任意 |
| 当前文字颜色的内联图标 | `svg/mark-current-color.svg` | 32px 以上 |
| 小型品牌装饰、加载状态 | `svg/core.svg` | 12px 以上 |
| 品牌文字 | `svg/wordmark-dark.svg` / `wordmark-light.svg` | 根据布局 |
| 标志与文字组合 | `svg/lockup-horizontal-*.svg` / `lockup-stacked-*.svg` | 欢迎页、文档、展示页 |
| Windows 应用与快捷方式 | `platform/ensoul.ico` | 内含 16–256px |
| macOS 应用包 | `platform/ensoul.icns` | 内含 16–1024px |

`png/` 提供透明 PNG：应用图标 16、20、22、24、32、48、64、128、256、512、1024px；标志 24–512px；字标和组合标志 1200px 宽。PNG 的图标外围透明，没有黑色截图背景。

小尺寸不是直接缩小大图：micro 版去掉渐变与阴影，并加宽叠层切口。复杂标志优先用在 48px 以上；繁忙背景用单色版或带底板应用图标。四周至少保留约四分之一标志宽度的空白，保持比例，不横向拉伸。

## UI 用法

普通图片直接使用 SVG：

```html
<img src="assets/brand/svg/app-icon-light.svg" width="64" height="64" alt="ensoul">
```

随主题文字颜色变化的图标用 CSS mask；外部 `<img>` 的 SVG 不会继承父元素的 `color`：

```css
.ensoul-mark {
  width: 24px;
  height: 24px;
  background: currentColor;
  mask: url('assets/brand/svg/mark-micro.svg') center / contain no-repeat;
  -webkit-mask: url('assets/brand/svg/mark-micro.svg') center / contain no-repeat;
}
```

`ui/tokens.css` 提供颜色与遮罩示例；`ui/sprite.svg` 提供 `ensoul-mark` / `ensoul-core` 两个 symbol。实际 URL 按页面或构建器位置调整。字标已经转换为路径，不要求用户安装字体，也不附带字体文件。

## 维护

`source/geometry.json` 是轮廓、叠层与字标的源数据。`scripts/export-brand-assets.cjs` 从它生成全部 SVG / PNG / ICO / ICNS，并更新 `assets/icon.png`、`tray.png`、`trayTemplate.png` 与 Retina 模板图。项目依赖准备好后运行 `npm run brand:assets`。不要修改导出文件后再运行生成器；需要持久调整时修改源数据或生成器。

顶栏只显示标志。macOS 托盘使用黑色透明模板图，由系统适配菜单栏深浅；Windows 托盘使用带底板的小尺寸版。
