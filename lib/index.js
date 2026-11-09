/**
 * dsh-pdf-toolkit — PDF 工具箱插件（打开阅读 / 编辑 / 拆分 / 合并 / 手写签名）。
 *
 * 5 个工具全部返回文本；改动类工具默认"另存新文件"，绝不覆盖源 PDF。
 * 依赖：pdf-lib（编辑/拆分/合并/绘制）+ @pdf-lib/fontkit（中文字体内嵌）+
 * pdfjs-dist（文本抽取/定位）。全部属于本项目 dependencies，随插件一起安装。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync } from 'node:fs'
import { TOOL_PARAMETERS } from './schemas.js'
import { readPdf } from './pdftext.js'
import { editPdf, mergePdf, signPdf, splitEvery, splitPdf } from './engine.js'
import { ensureStudio } from './studio.js'
import { fmtBytes, requireFile } from './util.js'

/** Cordis 插件名；cordis.patch.yml 的行 id 是 tool-pdf。 */
export const name = 'dsh-pdf-toolkit'
/** 本插件只贡献工具。 */
export const inject = ['tools']

/** 输出契约：一个文本块（与 boardwise-dsh 一致的 renderer）。 */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

const PDF_OPEN_TIMEOUT_MS = 240_000
const PDF_EDIT_TIMEOUT_MS = 240_000
const PDF_SPLIT_TIMEOUT_MS = 240_000
const PDF_MERGE_TIMEOUT_MS = 240_000
const PDF_SIGN_TIMEOUT_MS = 120_000

/* ------------------------------------------------------------------ */
/* pdf_open — 打开并阅读 PDF                                           */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'pdf_open',
      description:
        '打开并阅读一个 PDF：返回页数、页面尺寸、元数据、书签目录，以及指定页面的文本内容' +
        '（按阅读顺序排列，每页可截断）。用于编辑/拆分/合并前先弄清文档结构和内容。' +
        '支持 password 打开口令保护的 PDF。',
      parameters: TOOL_PARAMETERS.pdf_open,
      output: TEXT_OUTPUT,
      timeoutMs: PDF_OPEN_TIMEOUT_MS,
      async execute(args) {
        const file = requireFile(args.file, 'PDF 文件')
        const bytes = new Uint8Array(readFileSync(file))
        const maxChars = Number.isInteger(args.max_chars) && args.max_chars > 0 ? args.max_chars : 4000
        const result = await readPdf(bytes, {
          pagesExpr: args.pages,
          maxChars,
          password: args.password,
        })
        const lines = []
        lines.push(`文件：${file}（${fmtBytes(bytes.length)}）`)
        lines.push(`页数：${result.pageCount}；PDF 版本：${result.info.pdfVersion ?? '未知'}`)
        if (args.password) lines.push('（已使用 password 打开）')
        const meta = []
        for (const key of ['title', 'author', 'subject', 'keywords', 'creator', 'producer', 'creationDate', 'modificationDate']) {
          const v = result.info?.[key]
          if (v !== null && v !== undefined && String(v) !== '') meta.push(`${key}=${v}`)
        }
        if (meta.length) lines.push(`元数据：${meta.join(' | ')}`)
        if (result.outline.length) {
          lines.push(`书签目录（${result.outline.length} 条）：`)
          for (const o of result.outline.slice(0, 60)) {
            lines.push(`${'  '.repeat(o.depth + 1)}- ${o.title}`)
          }
          if (result.outline.length > 60) lines.push(`  …（仅显示前 60 条）`)
        }
        for (const p of result.pages) {
          lines.push('')
          lines.push(`════ 第 ${p.index} 页 ════（${p.width}×${p.height} pt，旋转 ${p.rotation}°，文本 ${p.chars} 字符）${p.chars === 0 ? ' — 无文本层（扫描件或文字已转曲线，replace_text 不可用）' : ''}`)
          lines.push(p.text.trimEnd())
        }
        return lines.join('\n')
      },
    }),

    /* ------------------------------------------------------------------ */
    /* pdf_edit                                                           */
    /* ------------------------------------------------------------------ */
    defineTool({
      name: 'pdf_edit',
      description:
        '编辑（修改）一个 PDF 并保存为新文件：按顺序执行 ops 操作列表，支持改元数据、删页、旋页、' +
        '写文字、放图片、查找替换文本、涂掉内容、画框画线、插空白页、加水印。' +
        '目标 PDF 必须是无口令的。坐标单位 pt、原点左下角。输出到 out（缺省 <原名>-edited.pdf），不覆盖源文件。',
      parameters: TOOL_PARAMETERS.pdf_edit,
      output: TEXT_OUTPUT,
      timeoutMs: PDF_EDIT_TIMEOUT_MS,
      async execute(args) {
        return await editPdf(args.file, args.ops, args.out)
      },
    }),

    /* ------------------------------------------------------------------ */
    /* pdf_split                                                          */
    /* ------------------------------------------------------------------ */
    defineTool({
      name: 'pdf_split',
      description:
        '把一个 PDF 拆成多个 PDF：按页码范围（ranges）或每 N 页一份（every）。' +
        'ranges 每项 {pages, out?}，pages 可写 "1-3,5,8-" 或 [1,2,3]（从 1 起）。' +
        'every 模式的输出目录为 out_dir（缺省与源文件同目录的 <原名>-split/）。',
      parameters: TOOL_PARAMETERS.pdf_split,
      output: TEXT_OUTPUT,
      timeoutMs: PDF_SPLIT_TIMEOUT_MS,
      async execute(args) {
        if (Array.isArray(args.ranges) && args.ranges.length > 0) {
          return await splitPdf(args.file, args.ranges, args.out_dir)
        }
        const every = Number.isInteger(args.every) && args.every >= 1 ? args.every : 1
        return await splitEvery(args.file, every, args.out_dir)
      },
    }),

    /* ------------------------------------------------------------------ */
    /* pdf_merge                                                          */
    /* ------------------------------------------------------------------ */
    defineTool({
      name: 'pdf_merge',
      description:
        '把多个 PDF 按给定顺序合并成一个 PDF（页面原样拼接，不改内容）。' +
        '输出到 out，缺省保存在第一个文件旁。源文件必须无口令。',
      parameters: TOOL_PARAMETERS.pdf_merge,
      output: TEXT_OUTPUT,
      timeoutMs: PDF_MERGE_TIMEOUT_MS,
      async execute(args) {
        return await mergePdf(args.files, args.out)
      },
    }),

    /* ------------------------------------------------------------------ */
    /* pdf_sign                                                           */
    /* ------------------------------------------------------------------ */
    defineTool({
      name: 'pdf_sign',
      description:
        '给 PDF 的某一页加"手写签名"，可三种元素自由组合（至少给一种）：\n' +
        '1) ink 矢量笔迹：给出多段 [x,y] 控制点（pt，左下原点），自动平滑成连笔手写效果；\n' +
        '2) image 签名图/图章：透明 PNG 最佳，可放缩、定位、调透明度；\n' +
        '3) text 印刷签名：姓名 + 日期（留空=今天）+ 事由；可用 font 传一个手写体 .ttf 让名字像亲笔。\n' +
        '输出到 out（缺省 <原名>-signed.pdf），不覆盖源文件。',
      parameters: TOOL_PARAMETERS.pdf_sign,
      output: TEXT_OUTPUT,
      timeoutMs: PDF_SIGN_TIMEOUT_MS,
      async execute(args) {
        return await signPdf(args.file, args)
      },
    }),

    /* -------------------------------------------------------------------- */
    /* pdf_studio — 右侧栏浏览器里的在线 PDF 编辑器                        */
    /* -------------------------------------------------------------------- */
    defineTool({
      name: 'pdf_studio',
      description:
        '在 DSH 右侧栏的「浏览器」面板里打开一个本机 PDF 在线编辑器（可视化操作：写文字、' +
        '涂白遮盖、鼠标手写签名、旋转/删除页面、另存为新文件）。它运行在本机 127.0.0.1 服务，' +
        '文件不出本机。返回一个 http://127.0.0.1 的编辑器网址：请让用户点开或在右侧栏浏览器粘贴该地址。',
      parameters: TOOL_PARAMETERS.pdf_studio,
      output: TEXT_OUTPUT,
      timeoutMs: 60_000,
      async execute(args) {
        const file = requireFile(args.file, 'PDF 文件')
        const url = await ensureStudio(file)
        return [
          'PDF 在线编辑器已就绪（本机 loopback 服务，文件不出本机）。',
          `编辑器地址：${url}`,
          '在右侧栏打开（三选一）：',
          '1) 点右侧栏「浏览器」图标，把地址贴进地址栏；',
          `2) 在聊天区点击：[在右侧浏览器打开 PDF 编辑器](${url})（需 设置→链接偏好 = 应用内侧边栏）；`,
          '3) 手动把地址交给用户。',
          '',
          '编辑器操作：文字（点击页面写入）/ 涂白（拖框遮盖）/ 签名（鼠标画 + 姓名）/ 旋转·删页立即生效；',
          '最后「另存为新文件」生成 <原名>-edited.pdf，绝不覆盖源文件。',
        ].join('\n')
      },
    }),
  )
}