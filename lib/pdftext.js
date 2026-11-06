/**
 * pdftext.js — 基于 pdfjs-dist（legacy 构建）的文本抽取与定位。
 *
 * pdf-lib 不会解析文本内容，所以「打开 PDF 读文本」与「replace_text 找原文
 * 位置」都走 pdfjs。pdfjs 的页坐标是「左上角原点、y 向下」，这里统一换算
 * 成 pdf-lib 的「左下角原点」再返回。
 */
import { fail } from './util.js'

let _pdfjs = null
async function loadPdfjs() {
  if (_pdfjs) return _pdfjs
  _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  return _pdfjs
}

/** 打开 pdfjs 文档；带口令的报错被翻译成中文。 */
async function openDoc(bytes, password) {
  const { getDocument } = await loadPdfjs()
  const load = {
    data: bytes.slice(),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
    ...(password ? { password } : {}),
  }
  let task
  try {
    task = getDocument(load)
    return await task.promise
  } catch (err) {
    const msg = String(err?.message ?? err)
    if (/password/i.test(msg)) {
      fail(`PDF 受口令保护：请通过 password 参数提供打开口令（pdf_open 支持；编辑/拆分/合并/签名要求源文件无口令，请先另存一份无口令副本）`)
    }
    fail(`PDF 解析失败：${msg}`)
  }
}

function outlineToList(root) {
  const out = []
  const walk = (items, depth) => {
    if (!Array.isArray(items)) return
    for (const it of items) {
      if (!it) continue
      out.push({ depth, title: String(it.title ?? '') })
      walk(it.items, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

function truncate(text, max) {
  if (text.length <= max) return text
  return text.slice(0, max) + ` …[本页文本已截断，共 ${text.length} 字符]`
}

/**
 * 打开并读取 PDF 的结构信息与指定页面的文本。
 * @returns { {pageCount, info, outline, pages:[{index,width,height,rotation,text,chars}]} }
 */
export async function readPdf(bytes, { pagesExpr, pageCount, maxChars = 4000, password } = {}) {
  const doc = await openDoc(bytes, password)
  try {
    let metaInfo = null
    try {
      const meta = await doc.getMetadata()
      metaInfo = meta?.info ?? null
    } catch {}

    const plan =
      pageCount === undefined || pagesExpr === undefined || pagesExpr === null
        ? maybeAllPages(doc.numPages)
        : resolvePages(pagesExpr, doc.numPages)

    const pages = []
    for (const idx of plan) {
      if (idx < 0 || idx >= doc.numPages) continue
      const page = await doc.getPage(idx + 1)
      const vp = page.getViewport({ scale: 1 })
      let text = ''
      try {
        const content = await page.getTextContent()
        let chars = 0
        for (const it of content.items) {
          if (typeof it?.str !== 'string') continue
          text += it.str + (it.hasEOL ? '\n' : '')
          chars += it.str.length
        }
        pages.push({
          index: idx + 1,
          width: Math.round(vp.width * 100) / 100,
          height: Math.round(vp.height * 100) / 100,
          rotation: page.rotate ?? 0,
          chars,
          text: truncate(text, maxChars),
        })
      } catch (err) {
        pages.push({
          index: idx + 1,
          width: Math.round(vp.width * 100) / 100,
          height: Math.round(vp.height * 100) / 100,
          rotation: page.rotate ?? 0,
          chars: 0,
          text: `[无法抽取本页文本: ${err?.message ?? err}]`,
        })
      } finally {
        page.cleanup()
      }
    }

    let outline = []
    try {
      const o = await doc.getOutline()
      if (o) outline = outlineToList(o)
    } catch {}

    return {
      pageCount: doc.numPages,
      info: {
        title: metaInfo?.Title ?? null,
        author: metaInfo?.Author ?? null,
        subject: metaInfo?.Subject ?? null,
        keywords: metaInfo?.Keywords ?? null,
        creator: metaInfo?.Creator ?? null,
        producer: metaInfo?.Producer ?? null,
        creationDate: metaInfo?.CreationDate ?? null,
        modificationDate: metaInfo?.ModDate ?? null,
        pdfVersion: metaInfo?.PDFFormatVersion ?? null,
      },
      outline,
      pages,
    }
  } finally {
    try {
      await doc.destroy()
    } catch {}
  }
}

function maybeAllPages(n) {
  return [...Array(n).keys()]
}

function resolvePages(expr, n) {
  // 复用 util 的解析（避免循环依赖，这里内联一个轻量版）
  const out = new Set()
  if (typeof expr === 'string') {
    const text = expr.trim()
    if (text === '' || text === 'all') return maybeAllPages(n)
    for (const part of text.split(',')) {
      const p = part.trim()
      if (p === '') continue
      const m = /^(\d+)(?:-(\d*))?$/.exec(p)
      if (!m) fail(`pages 表达式无法解析：'${p}'（形如 1-3,5,8-）`)
      let a = parseInt(m[1], 10)
      let b = m[2] === undefined ? a : m[2] === '' ? n : parseInt(m[2], 10)
      if (a < 1 || b < 1 || a > n || b > n) fail(`页码越界：${p}（文档共 ${n} 页）`)
      if (b < a) [a, b] = [b, a]
      for (let i = a; i <= b; i++) out.add(i - 1)
    }
  } else if (Array.isArray(expr)) {
    for (const v of expr) {
      const p = Number(v)
      if (!Number.isInteger(p) || p < 1 || p > n) fail(`页码越界：${v}（文档共 ${n} 页）`)
      out.add(p - 1)
    }
  } else {
    fail('pages 应为字符串（如 "1-3,5"）或数组')
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * 在一页里定位目标文本的首处出现，返回 pdf-lib（左下原点）坐标的包围盒。
 * 找不到返回 null。找不到 = 目标页没有可抽取的文本层（扫描件/转曲文字）。
 */
export async function locateText(bytes, pageIdx1, needle, password) {
  const doc = await openDoc(bytes, password)
  try {
    if (pageIdx1 < 1 || pageIdx1 > doc.numPages) fail(`页码越界：${pageIdx1}（文档共 ${doc.numPages} 页）`)
    const page = await doc.getPage(pageIdx1)
    const vp = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()

    /** 逐 item：str + 原坐标（pdfjs: 左上原点） */
    const items = []
    for (const it of content.items) {
      if (typeof it?.str !== 'string' || it.str === '') continue
      const t = it.transform ?? [1, 0, 0, 1, 0, 0]
      const h = typeof it.height === 'number' && it.height > 0 ? it.height : Math.abs(t[3]) || 10
      const w = typeof it.width === 'number' && it.width > 0 ? it.width : h / 2
      items.push({ str: it.str, x: t[4], yTop: t[5], w, h, hasEOL: !!it.hasEOL })
    }

    const joined = items.map((i) => i.str).join('')
    const pos = joined.indexOf(needle)
    if (pos < 0 || needle === '') return null

    // 找出覆盖匹配片段的 items
    let acc = 0
    const span = []
    for (const it of items) {
      const s = acc
      const e = acc + it.str.length
      if (s < pos + needle.length && e > pos) span.push(it)
      acc = e
      if (acc >= pos + needle.length) break
    }
    if (span.length === 0) return null

    const x0 = Math.min(...span.map((i) => i.x))
    const x1 = Math.max(...span.map((i) => i.x + i.w))
    const yTopMin = Math.min(...span.map((i) => i.yTop))
    const yBotMax = Math.max(...span.map((i) => i.yTop + i.h))
    const hMax = Math.max(...span.map((i) => i.h))

    // pdfjs y 向下 → pdf-lib y 向上
    return {
      x: x0,
      y: vp.height - yBotMax,
      w: x1 - x0,
      h: yBotMax - yTopMin || hMax,
      size: hMax || 10,
      pageWidth: vp.width,
      pageHeight: vp.height,
    }
  } finally {
    try {
      await doc.destroy()
    } catch {}
  }
}