# dsh-pdf-toolkit

DeepSeek Harness PDF 工具箱插件：**打开阅读、编辑内容、拆分、合并、手写签名**，
外加一个跑在 **DSH 右侧栏「浏览器」里的可视化在线编辑器（pdf_studio）**。
除编辑器外全部以工具形式交给模型调用，输出为文本。

## 安装

三种方式任选其一（前提：本机已有 DSH Desktop 及其 `dsh` CLI）。

**方式一：插件市场输入 GitHub 地址**

在 DSH 的插件市场直接填入本仓库地址（市场交由 pnpm 拉取安装）：

```
https://github.com/muaxi8/pdf-toolkit
```

等价的 CLI 安装（市场背后走的就是这条 pnpm 链路）：

```powershell
# 简写形式
dsh plugin --profile desktop add github:muaxi8/pdf-toolkit
# 完整 URL 形式
dsh plugin --profile desktop add https://github.com/muaxi8/pdf-toolkit.git
```

**方式二：本地 tarball**

```powershell
# 在插件目录里打包（需要 pnpm）
pnpm pack --pack-destination dist
# 装进某个 profile（dsh CLI 转发给该 profile 的 pnpm）
dsh plugin --profile desktop add file:<绝对路径>\dsh-pdf-toolkit-0.3.0.tgz
```

**方式三：本地源码目录（开发迭代用）**

```powershell
dsh plugin --profile desktop add file:D:\path\to\dsh-pdf-toolkit
```

装好后 `dsh.profile.bundles` 会自动登记本包（若未自动登记，手动在 profile 的
`package.json` → `dsh.profile.bundles` 数组末尾加入 `"dsh-pdf-toolkit"`）。
**彻底重启 DSH Desktop / 新建会话**后即可看到 6 个 `pdf_*` 工具。

验证注册：`dsh --profile desktop --dump-config | Select-String tool-pdf`

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `pdf_open` | 打开阅读：页数/尺寸/元数据/书签 + 指定页文本（可读口令 PDF，密码参数） |
| `pdf_edit` | 编辑：改元数据、删页/旋页（绝对+相对）/插空白页、写文字、放图片、查找替换文本、遮盖、画框画线、水印、矢量签名对象（add_signature，可重放移动/删除） |
| `pdf_split` | 拆分：按页码范围（ranges）或每 N 页（every）拆成多个 PDF |
| `pdf_merge` | 合并：多文件按顺序拼成一个 PDF |
| `pdf_sign` | 签名：矢量手写笔迹 / 签名图（透明 PNG）/ 姓名+日期+事由，三种元素自由组合 |
| `pdf_studio` | 在线编辑器：在右侧栏「浏览器」打开本机 loopback 可视化编辑页（见下节） |

### 在线编辑器（pdf_studio，右侧栏浏览器）

适合「看着页面改」的场景。用法：

1. 在会话里让模型调用 `pdf_studio`（**file 可省略**；带路径则直接载入那个文件）；
2. 工具返回一个 `http://127.0.0.1:<端口>/` 地址；
3. 打开它（二选一）：
   - 点右侧栏「浏览器」图标，把地址粘进地址栏回车；或
   - 在 **设置 → 链接偏好** 选「应用内侧边栏」后，直接点击回复里的链接。
4. 编辑器能力：
   - **打不开文件也能用**：顶部输入 PDF 路径回车、点「上传 PDF」选文件、或直接把
     PDF 拖进窗口，三种方式随意加文件；
   - **文字**：点击页面定位 → 右侧填内容/字号/颜色 → 应用到本页；
   - **手写签名**：页面上按住鼠标写连笔 → 姓名/事由**可选**、**笔迹颜色与文字颜色
     都能选**、日期自动当天 → 应用后可随时**移动**（浏览模式拖动）或**删除**
     （选中后 Delete/按钮）；画错可**撤销上一笔**；
   - **涂鸦**：彩笔在页面上随手画（圈注、打箭头）；
   - **旋转 / 删页**：立即生效；
   - **拆分**（右侧边栏）：每 N 页一份，或按范围表达式 `1-3 | 4-6 | 7-`，拆出的
     每个文件都能一键在编辑器里打开；
   - **合并**（右侧边栏）：每行一个 PDF 路径，按顺序合并成一个新文件，可立即打开；
   - **另存为新文件**：默认存成 `<原名>-edited.pdf` 到源文件旁，**绝不覆盖源文件**。

实现说明：编辑器是插件自带的 loopback HTTP 服务（默认 48731，被占时自动换随机端口），
页面用 pdfjs 渲染；所有改动以「操作清单重放」方式由 pdf-lib 引擎从源文件重建工作稿
（因此签名/涂鸦/文字都是可移动、可删除的对象）。文件全程不出本机，中间稿在系统
临时目录，只有「另存」会写出正式文件。

### 坐标与约定

- 坐标单位 **pt**（1pt = 1/72 英寸），原点 **左下角**；
- 颜色 `#RRGGBB`；
- 改动类工具默认"另存新文件"（`<原名>-edited.pdf` / `-signed.pdf` / `-split/` / `<原名>-partNN.pdf` / `merged.pdf`），
  **绝不覆盖源文件**；也可用 `out` 参数指定输出路径；
- 编辑/拆分/合并/签名要求源文件**无打开口令**（`pdf_open` 可带 `password` 读取）；
- 一个 `pdf_edit` 调用里的 `ops` **按顺序执行**，先删页会影响后续页码。

### 常用示例

`pdf_edit` 的例子：

```json
{
  "file": "C:/work/合同.pdf",
  "ops": [
    { "op": "add_text", "page": 1, "x": 100, "y": 700, "text": "盖章有效", "size": 14, "color": "#CC0000" },
    { "op": "replace_text", "page": 2, "from": "壹万元", "to": "壹万贰仟元" },
    { "op": "add_signature", "page": 3, "color": "#123A8C", "width": 1.3,
      "ink": [{ "points": [[90, 100], [120, 130], [160, 90], [200, 120]] }],
      "text": { "name": "张三", "reason": "本人确认" }, "textColor": "#123A8C", "textX": 90, "textY": 60 },
    { "op": "redact", "page": 2, "x": 90, "y": 300, "w": 220, "h": 18 },
    { "op": "watermark", "text": "内部资料", "opacity": 0.3 },
    { "op": "rotate_page_by", "page": 6, "delta": -90 },
    { "op": "remove_page", "pages": [8, 9] }
  ],
  "out": "C:/work/合同-修改稿.pdf"
}
```

`pdf_split` 的例子：

```json
{
  "file": "C:/work/大包.pdf",
  "ranges": [
    { "pages": "1-3", "out": "C:/work/封面目录.pdf" },
    { "pages": [4, 5, 6], "out": "C:/work/正文.pdf" },
    { "pages": "7-", "out": "C:/work/附录.pdf" }
  ]
}
```

`pdf_sign` 的例子（矢量手写 + 姓名日期）：

```json
{
  "file": "C:/work/协议.pdf",
  "page": 3,
  "out": "C:/work/协议-已签署.pdf",
  "ink": [
    { "points": [[90, 120], [105, 138], [130, 108], [165, 132], [200, 112]], "width": 1.5 },
    { "points": [[240, 118], [255, 128], [270, 122], [285, 126]], "width": 1.2 }
  ],
  "text": { "name": "张三", "reason": "本人确认" }
}
```

`text.date` 留空 = 当天日期；`text.font` 可传一个手写体 `.ttf`（如
`C:/Windows/Fonts/` 下的字体、或自备的"静蕾简体"类字体）让姓名更贴近亲笔。

## 能力边界（诚实清单）

- **replace_text 只对"有文本层"的 PDF 有效**：Office/WPS 导出的 PDF 一般有；
  扫描件、文字已转曲线的（常说"文字不可选中"）找不到原文，这类文档请用
  `redact`（涂掉）+ `add_text`（重写）组合。
- 替换是"盖白底重写"，不做段落重排：新文本明显长于原文会溢出原位置。
- 编辑是**内容层**操作：不修改字体嵌入以外的渲染细节，打印/屏幕查看正常。
- 中文文字：自动尝试系统字体（simhei/simfang/simkai/Deng）；都没有时请用
  `font` 参数显式给一个 `.ttf/.otf` 路径，报错信息会列出可用候选。
- 口令加密的 PDF：只能 `pdf_open` 读（给 password）；编辑类工具要求先另存为
  无口令副本。
- 在线编辑器不提供"下载到浏览器"（嵌入环境不允许下载），保存通过「另存」写回
  本机文件；编辑器的对象模型是「重放式」的，编辑大文档时操作越多重放越久
  （百页级文档建议改用 pdf_edit 工具批处理）。

## 开发

- 零构建：`lib/*.js` 是纯 ESM 源码，`lib/editor.html` 是编辑器页面，直接发布。
- git 工作流：

  ```powershell
  git clone https://github.com/muaxi8/pdf-toolkit.git
  cd pdf-toolkit
  pnpm install              # .npmrc 是本机专属配置（store 路径），已 gitignore
  node scripts/smoke.mjs    # 引擎级冒烟，改完代码先跑它
  node scripts/schema-check.mjs
  ```

  维护建议：小步提交、一次提交只改一件事；版本号遵循 semver，发版前跑一遍
  smoke + schema-check，再 `pnpm pack --pack-destination dist` 产出安装包。

- 本地冒烟（引擎级，不依赖 DSH 上下文）：`node scripts/smoke.mjs`
- schema 校验（用已装 DSH 的 dsh-tools 编译器预检每个工具参数）：
  `node scripts/schema-check.mjs`——找不到 DSH 安装时会跳过；也可用环境变量
  `DSH_DSH_TOOLS_PATH` 直接指向 dsh-tools 的 `lib/index.js`。
- 依赖：`pdf-lib`（编辑/拆分/合并/绘制）、`@pdf-lib/fontkit`（自定义字体）、
  `pdfjs-dist`（文本抽取/定位/编辑器渲染）。

DSH peer 依赖（`@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`）标记为
**optional**，由宿主提供；版本门槛由 `dsh.engines.dsh` 表达。

## 许可证

Apache-2.0（运行时依赖的许可证：pdf-lib MIT、@pdf-lib/fontkit MIT、pdfjs-dist Apache-2.0）。