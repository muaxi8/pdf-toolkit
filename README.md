# dsh-pdf-toolkit

DeepSeek Harness PDF 工具箱插件：**打开阅读、编辑内容、拆分、合并、手写签名**，全部以工具形式交给模型调用，输出为文本。

## 安装

三种方式任选其一（前提：本机已有 DSH Desktop 及其 `dsh` CLI）。

**方式一：插件市场输入 GitHub 地址（仓库公开后）**

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
dsh plugin --profile desktop add file:<绝对路径>\dsh-pdf-toolkit-0.1.0.tgz
```

**方式三：本地源码目录（开发迭代用）**

```powershell
dsh plugin --profile desktop add file:D:\path\to\dsh-pdf-toolkit
```

装好后 `dsh.profile.bundles` 会自动登记本包（若未自动登记，手动在 profile 的
`package.json` → `dsh.profile.bundles` 数组末尾加入 `"dsh-pdf-toolkit"`）。
**重启 DSH Desktop / 新建会话**后即可看到 5 个 `pdf_*` 工具。

验证注册：`dsh --profile desktop --dump-config | Select-String tool-pdf`

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `pdf_open` | 打开阅读：页数/尺寸/元数据/书签 + 指定页文本（可读口令 PDF，密码参数） |
| `pdf_edit` | 编辑：改元数据、删页/旋页/插空白页、写文字、放图片、查找替换文本、遮盖、画框画线、水印 |
| `pdf_split` | 拆分：按页码范围（ranges）或每 N 页（every）拆成多个 PDF |
| `pdf_merge` | 合并：多文件按顺序拼成一个 PDF |
| `pdf_sign` | 签名：矢量手写笔迹 / 签名图（透明 PNG）/ 姓名+日期+事由，三种元素自由组合 |

### 坐标与约定

- 坐标单位 **pt**（1pt = 1/72 英寸），原点 **左下角**；
- 颜色 `#RRGGBB`；
- 改动类工具默认"另存新文件"（`<原名>-edited.pdf` / `-signed.pdf` / `-split/` / `merged.pdf`），
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
    { "op": "redact", "page": 2, "x": 90, "y": 300, "w": 220, "h": 18 },
    { "op": "watermark", "text": "内部资料", "opacity": 0.3 },
    { "op": "rotate_page", "page": 5, "degrees": 90 },
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

## 开发

- 零构建：`lib/*.js` 是纯 ESM 源码，直接发布。
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
  `pdfjs-dist`（文本抽取与定位）。
- DSH peer 依赖（`@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`）标记为
  **optional**，由宿主提供；版本门槛由 `dsh.engines.dsh` 表达——这是
  `@copylee/dsh-office` 同款做法，避免 pnpm 解析 peer 闭包。

## 许可证

Apache-2.0（运行时依赖的许可证：pdf-lib MIT、@pdf-lib/fontkit MIT、pdfjs-dist Apache-2.0）。