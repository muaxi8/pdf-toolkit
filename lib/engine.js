/**
 * engine.js — PDF 编辑引擎（pdf-lib + fontkit + pdfjs 文本定位）。
 *
 * 能力：编辑（ops 序列）、拆分、合并、签名（位图/打字/矢量手写）。
 * 坐标单位 pt，原点左下角；颜色 '#RRGGBB'。
 */
import { PDFDocument, StandardFonts, LineCapStyle, rgb, degrees } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { locateText } from './pdftext.js'
import {
  clamp01, defaultOut, fail, fmtBytes, isWinAnsi, nonAnsiChars,
  pageIndex, parseColor, parsePagesArray, parsePagesExpr, readBytes,
  requireFile, toInt, toNum, toStr, writeOut,
} from './util.js'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 标准字体名（大小写不敏感）→ pdf-lib StandardFonts。 */
const STANDARD_FONTS = {
  'helvetica': StandardFonts.Helvetica,
  'helvetica-bold': StandardFonts.HelveticaBold,
  'helvetica-oblique': StandardFonts.HelveticaOblique,
  'helvetica-boldoblique': StandardFonts.HelveticaBoldOblique,
  'timesroman': StandardFonts.TimesRoman,
  'timesroman-bold': StandardFonts.TimesRomanBold,
  'timesroman-italic': StandardFonts.TimesRomanItalic,
  'timesroman-bolditalic': StandardFonts.TimesRomanBoldItalic,
  'courier': StandardFonts.Courier,
  'courier-bold': StandardFonts.CourierBold,
  'courier-oblique': StandardFonts.CourierOblique,
  'courier-boldoblique': StandardFonts.CourierBoldOblique,
  'symbol': StandardFonts.Symbol,
  'zapfdingbats': StandardFonts.ZapfDingbats,
}

/** 自动探测中文所需字体的候选（单字体 .ttf，避免 .ttc 集合）。 */
export const CJK_FONT_CANDIDATES = [
  'C:/Windows/Fonts/simhei.ttf', // 黑体
  'C:/Windows/Fonts/simfang.ttf', // 仿宋
  'C:/Windows/Fonts/simkai.ttf', // 楷体
  'C:/Windows/Fonts/Deng.ttf', // 等线
]

function findCjkFont() {
  for (const p of CJK_FONT_CANDIDATES) {
    if (existsSync(p) && p.toUpperCase().endsWith('.TTF')) return p
  }
  return null
}

const A4 = [595.28, 841.89]

/** 每个文档的字体缓存（同一路径只内嵌一次）+ fontkit 注册标记。 */
function fontClerk() {
  return { fonts: new Map(), kit: false }
}

async function embedCustomFont(doc, clerk, path) {
  if (clerk.fonts.has(path)) return clerk.fonts.get(path)
  if (!clerk.kit) {
    doc.registerFontkit(fontkit)
    clerk.kit = true
  }
  const bytes = readBytes(path)
  let font
  try {
    font = await doc.embedFont(bytes, { subset: true })
  } catch {
    // 少数字体触发 fontkit 子集化 bug，回退为整体内嵌
    font = await doc.embedFont(bytes.slice(), { subset: false })
  }
  clerk.fonts.set(path, font)
  return font
}

/**
 * 为一段文字选字体：
 *  - font 是标准字体名（如 Helvetica-Bold）→ 直用（WinAnsi 限制已校验）；
 *  - font 是文件路径 → 内嵌自定义字体；
 *  - 未给 → WinAnsi 文字用 Helvetica，否则尝试系统常见中文字体，再没有报错。
 */
export async function pickFont(doc, clerk, text, fontParam) {
  if (typeof fontParam === 'string' && fontParam.trim() !== '') {
    const key = fontParam.trim().toLowerCase()
    if (key in STANDARD_FONTS) {
      const nearNonAnsi = nonAnsiChars(text).slice(0, 8).join('')
      if (nearNonAnsi) {
        fail(`标准字体 ${fontParam} 是 WinAnsi 编码，无法写出字符：${nearNonAnsi}；请为中文等字符改用 .ttf/.otf 文件路径，或省略 font 自动选字体`)
      }
      return await doc.embedFont(STANDARD_FONTS[key])
    }
    const path = fontParam.trim()
    if (!existsSync(path)) {
      fail(`字体文件不存在：${path}。可用的替代（若装了简体中文支持）：${CJK_FONT_CANDIDATES.filter(existsSync).join('、') || '无自动候选，请给出 .ttf/.otf 路径'}`)
    }
    return await embedCustomFont(doc, clerk, path)
  }
  if (isWinAnsi(text)) return await doc.embedFont(StandardFonts.Helvetica)
  const sys = findCjkFont()
  if (!sys) {
    fail(`文字含中文字符，需要内嵌字体：请用 font 参数给一个 .ttf 文件路径（Windows 下常见：C:/Windows/Fonts/simhei.ttf、simfang.ttf、simkai.ttf）。系统未自动找到可用字体。`)
  }
  return await embedCustomFont(doc, clerk, sys)
}

async function loadForEdit(file) {
  const bytes = readBytes(file)
  let doc
  try {
    doc = await PDFDocument.load(bytes)
  } catch (err) {
    const msg = String(err?.message ?? err)
    if (/encrypt/i.test(msg)) {
      fail(`源 PDF 有打开口令，PDF 库无法解密：请先提供无口令副本再编辑/拆分/合并/签名（pdf_open 可带 password 读取内容）`)
    }
    fail(`无法打开 PDF（${file}）：${msg}`)
  }
  return doc
}

/** 把 ops 逐条应用到同一文档（按顺序，页面编号按当前文档状态）。 */
export async function editPdf(file, ops, out) {
  requireFile(file, '源文件')
  if (!Array.isArray(ops) || ops.length === 0) fail('ops 必填：至少一个操作')
  const doc = await loadForEdit(file)
  const clerk = fontClerk()
  const notes = []
  const outPath = out && String(out).trim() !== '' ? String(out).trim() : defaultOut(file, 'edited')

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] ?? {}
    const label = op.op ?? '(缺 op)'
    try {
      const note = await applyOp(doc, clerk, file, op)
      notes.push(`ops[${i}] ${note}`)
    } catch (err) {
      const msg = err?.message ?? String(err)
      throw new Error(`ops[${i}]（${label}）执行失败：${msg}`)
    }
  }

  const saved = await doc.save()
  writeOut(outPath, saved)
  notes.push(`已保存：${outPath}（${doc.getPageCount()} 页，${fmtBytes(saved.length)}）`)
  return notes.join('\n')
}

async function applyOp(doc, clerk, sourceFile, op) {
  const pageCount = doc.getPageCount()
  const t = op.op
  switch (t) {
    case 'set_metadata': {
      const set = (v) => (typeof v === 'string' ? v : undefined)
      const changed = []
      const title = set(op.title)
      if (title !== undefined) { doc.setTitle(title); changed.push(`标题=${title || '(已清除)'}`) }
      const author = set(op.author)
      if (author !== undefined) { doc.setAuthor(author); changed.push(`作者=${author || '(已清除)'}`) }
      const subject = set(op.subject)
      if (subject !== undefined) { doc.setSubject(subject); changed.push(`主题=${subject || '(已清除)'}`) }
      const keywords = set(op.keywords)
      if (keywords !== undefined) { doc.setKeywords(keywords.split(',').map((s) => s.trim()).filter(Boolean)); changed.push(`关键词=${keywords}`) }
      const producer = set(op.producer)
      if (producer !== undefined) { doc.setProducer(producer); changed.push(`生成工具=${producer || '(已清除)'}`) }
      const creator = set(op.creator)
      if (creator !== undefined) { doc.setCreator(creator); changed.push(`创建程序=${creator || '(已清除)'}`) }
      if (changed.length === 0) return `set_metadata：未提供任何要修改的字段`
      return `set_metadata：${changed.join('，')}`
    }

    case 'remove_page': {
      const pages = parsePagesArray(op.pages, pageCount)
      const list = [...pages].sort((a, b) => b - a)
      if (list.length >= pageCount) fail(`remove_page：不能删除全部页面（至少保留 1 页）`)
      for (const idx of list) doc.removePage(idx)
      return `remove_page：删除 ${list.length} 页（当前 ${doc.getPageCount()} 页）`
    }

    case 'rotate_page': {
      const idx = pageIndex(op.page, pageCount)
      const deg = toInt(op.degrees, NaN)
      if (![90, 180, 270].includes(deg)) fail(`rotate_page：degrees 只支持 90/180/270，收到 ${op.degrees}`)
      const page = doc.getPage(idx)
      page.setRotation(degrees(deg))
      return `rotate_page：第 ${idx + 1} 页旋转为 ${deg} 度`
    }

    case 'add_text': {
      const idx = pageIndex(op.page, pageCount)
      const text = toStr(op.text)
      if (text === '') fail('add_text：text 为空')
      const page = doc.getPage(idx)
      const size = toNum(op.size, 12)
      const font = await pickFont(doc, clerk, text, op.font)
      const color = parseColor(op.color, { r: 0, g: 0, b: 0 })
      page.drawText(text, {
        x: toNum(op.x, 0),
        y: toNum(op.y, 0),
        size,
        font,
        color: rgb(color.r, color.g, color.b),
        opacity: clamp01(op.opacity),
        ...(toNum(op.rotate, 0) !== 0 ? { rotate: degrees(degreesSafe(op.rotate)) } : {}),
      })
      return `add_text：第 ${idx + 1} 页 (${op.x}, ${op.y}) 写入 ${JSON.stringify(text.length > 40 ? text.slice(0, 40) + '…' : text)}`
    }

    case 'add_image': {
      const idx = pageIndex(op.page, pageCount)
      const imgPath = requireFile(op.image, '图片')
      const page = doc.getPage(idx)
      const img = await embedImage(doc, imgPath)
      const natural = { w: img.width, h: img.height }
      const w = toNum(op.width, natural.w)
      const h = toNum(op.height, natural.h)
      page.drawImage(img, {
        x: toNum(op.x, 0),
        y: toNum(op.y, 0),
        width: w,
        height: h,
        opacity: clamp01(op.opacity),
        ...(toNum(op.rotate, 0) !== 0 ? { rotate: degrees(degreesSafe(op.rotate)) } : {}),
      })
      return `add_image：第 ${idx + 1} 页 (${op.x}, ${op.y}) 放置图片 ${op.image}（${w}×${h} pt）`
    }

    case 'replace_text': {
      const idx = pageIndex(op.page, pageCount)
      const from = toStr(op.from)
      const to = toStr(op.to)
      if (from === '') fail('replace_text：from 必填（要替换的原文）')
      const fileBytes = readBytes(sourceFile)
      const box = await locateText(fileBytes, idx + 1, from, op.password)
      if (!box) {
        fail(`replace_text：在第 ${idx + 1} 页找不到文本 ${JSON.stringify(from)}。可能原因：该页是扫描件/文字已转曲线（无文本层），或原文拼写与空白不完全一致`)
      }
      const page = doc.getPage(idx)
      const padX = 1.5
      const padY = 1.2
      const cover = parseColor(op.cover, { r: 1, g: 1, b: 1 })
      page.drawRectangle({
        x: box.x - padX,
        y: box.y - padY,
        width: box.w + padX * 2,
        height: box.h + padY * 2,
        color: rgb(cover.r, cover.g, cover.b),
        borderColor: undefined,
        opacity: 1,
      })
      if (to !== '') {
        const wantSize = toNum(op.size, box.size * 0.9)
        const size = Math.max(3, Math.min(wantSize, Math.max(box.h * 1.2, 6)))
        const font = await pickFont(doc, clerk, to, op.font)
        const color = parseColor(op.color, { r: 0, g: 0, b: 0 })
        const yBase = box.y + Math.max(0, (box.h - size) / 2) + size * 0.21
        page.drawText(to, {
          x: box.x,
          y: yBase,
          size,
          font,
          color: rgb(color.r, color.g, color.b),
          opacity: clamp01(op.opacity),
        })
      }
      const replaceNote = to === '' ? '删除' : `替换为 ${JSON.stringify(to)}`
      return `replace_text：第 ${idx + 1} 页 ${JSON.stringify(from)} → ${replaceNote}（位于 (${box.x.toFixed(1)}, ${box.y.toFixed(1)})）`
    }

    case 'redact': {
      const idx = pageIndex(op.page, pageCount)
      const page = doc.getPage(idx)
      const w = toNum(op.w, NaN)
      const h = toNum(op.h, NaN)
      if (!Number.isFinite(w) || !Number.isFinite(h)) fail('redact：w/h 必填')
      const cover = parseColor(op.color, { r: 1, g: 1, b: 1 })
      page.drawRectangle({
        x: toNum(op.x, 0),
        y: toNum(op.y, 0),
        width: w,
        height: h,
        color: rgb(cover.r, cover.g, cover.b),
        borderColor: undefined,
        opacity: clamp01(op.opacity),
      })
      return `redact：第 ${idx + 1} 页遮盖 (${op.x}, ${op.y}) ${w}×${h} pt`
    }

    case 'add_rect': {
      const idx = pageIndex(op.page, pageCount)
      const page = doc.getPage(idx)
      const w = toNum(op.w, NaN)
      const h = toNum(op.h, NaN)
      if (!Number.isFinite(w) || !Number.isFinite(h)) fail('add_rect：w/h 必填')
      const border = parseColor(op.color, { r: 0, g: 0, b: 0 })
      const fillS = toStr(op.fill)
      page.drawRectangle({
        x: toNum(op.x, 0),
        y: toNum(op.y, 0),
        width: w,
        height: h,
        borderColor: rgb(border.r, border.g, border.b),
        borderWidth: toNum(op.borderWidth, 1),
        ...(fillS !== '' ? { color: rgbObject(fillS) } : {}),
        opacity: clamp01(op.opacity),
      })
      return `add_rect：第 ${idx + 1} 页 (${op.x}, ${op.y}) ${w}×${h} pt 矩形框`
    }

    case 'add_line': {
      const idx = pageIndex(op.page, pageCount)
      const page = doc.getPage(idx)
      const color = parseColor(op.color, { r: 0, g: 0, b: 0 })
      page.drawLine({
        start: { x: toNum(op.x1, NaN), y: toNum(op.y1, NaN) },
        end: { x: toNum(op.x2, NaN), y: toNum(op.y2, NaN) },
        thickness: toNum(op.thickness, 1),
        color: rgb(color.r, color.g, color.b),
        opacity: clamp01(op.opacity),
      })
      return `add_line：第 ${idx + 1} 页 (${op.x1},${op.y1}) → (${op.x2},${op.y2}) 直线`
    }

    case 'add_blank_page': {
      const w = toNum(op.width, A4[0])
      const h = toNum(op.height, A4[1])
      const after = toInt(op.after, NaN)
      if (Number.isInteger(after)) {
        if (after < 0 || after > doc.getPageCount()) fail(`add_blank_page：after 越界（0=最前，当前页数 ${doc.getPageCount()} 表示末尾）`)
        doc.insertPage(after, [w, h])
      } else {
        doc.addPage([w, h])
      }
      return `add_blank_page：插入空白页 ${w}×${h} pt（当前 ${doc.getPageCount()} 页）`
    }

    case 'watermark': {
      const text = toStr(op.text)
      if (text === '') fail('watermark：text 为空')
      const size = toNum(op.size, 46)
      const angle = toNum(op.angle, 45)
      const color = parseColor(op.color, { r: 179 / 255, g: 179 / 255, b: 179 / 255 })
      const opacity = clamp01(op.opacity === undefined ? 0.35 : op.opacity)
      const font = await pickFont(doc, clerk, text, op.font)
      const target = toInt(op.page, 0)
      const indexes = Number.isInteger(target) && target > 0 ? [pageIndex(target, pageCount)] : [...Array(pageCount).keys()]
      for (const idx of indexes) {
        const page = doc.getPage(idx)
        const { width, height } = page.getSize()
        page.drawText(text, {
          x: width / 2,
          y: height / 2,
          size,
          font,
          color: rgb(color.r, color.g, color.b),
          opacity,
          rotate: degrees(degreesSafe(angle)),
        })
      }
      return `watermark：${indexes.length} 页写入水印 ${JSON.stringify(text.length > 30 ? text.slice(0, 30) + '…' : text)}`
    }

    default:
      fail(`未知操作 '${t}'，支持：set_metadata / remove_page / rotate_page / add_text / add_image / replace_text / redact / add_rect / add_line / add_blank_page / watermark`)
  }
}

function rgbObject(s) {
  const c = parseColor(s, { r: 0, g: 0, b: 0 })
  return rgb(c.r, c.g, c.b)
}

/** 把任意角度归一到 0~359 的数字（再包 degrees() 传给 pdf-lib）。 */
function degreesSafe(v) {
  const d = ((Number(v) || 0) % 360 + 360) % 360
  return d
}

async function embedImage(doc, path) {
  const lower = path.toLowerCase()
  try {
    if (lower.endsWith('.png')) return await doc.embedPng(readBytes(path))
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return await doc.embedJpg(readBytes(path))
  } catch (err) {
    fail(`无法嵌入图片（${path}）：${err?.message ?? err}。手写签名建议用透明 PNG`)
  }
  fail(`图片格式不支持：${path}（只支持 .png / .jpg）`)
}

/* ------------------------------------------------------------------ */
/* 拆分                                                              */
/* ------------------------------------------------------------------ */

/**
 * ranges: [{pages: '1-3'|'all'|[1,2,3], out?: 路径}]；
 * 不给 ranges 时按 every 页一组输出到 out_dir。
 */
export async function splitPdf(file, ranges, outDir) {
  requireFile(file, '源文件')
  const doc = await loadForEdit(file)
  const pageCount = doc.getPageCount()

  const jobs = []
  if (Array.isArray(ranges) && ranges.length > 0) {
    for (const r of ranges) {
      if (!r || typeof r !== 'object') fail('ranges 每项应为 {pages, out?}')
      const idx = Array.isArray(r.pages)
        ? [...parsePagesArray(r.pages, pageCount)].sort((a, b) => a - b)
        : [...parsePagesExpr(r.pages, pageCount)].sort((a, b) => a - b)
      if (idx.length === 0) fail('每个拆分范围的 pages 至少一页')
      jobs.push({ idx, out: r.out })
    }
  } else {
    fail('ranges 必填（按页范围拆分）。若想每 N 页一份，请用 every 参数')
  }

  const written = []
  for (let j = 0; j < jobs.length; j++) {
    const { idx } = jobs[j]
    const base = file.replace(/\.pdf$/i, '')
    const dest = jobs[j].out && String(jobs[j].out).trim() !== ''
      ? String(jobs[j].out).trim()
      : `${base}-p${idx[0] + 1}${idx.length > 1 ? '-' + (idx[idx.length - 1] + 1) : ''}.pdf`
    const sub = await PDFDocument.create()
    const copied = await sub.copyPages(doc, idx)
    for (const p of copied) sub.addPage(p)
    const bytes = await sub.save()
    writeOut(dest, bytes)
    written.push(`${dest}（${idx.length} 页，${fmtBytes(bytes.length)}）`)
  }
  return written.join('\n')
}

/** every：每 n 页拆一份 → out_dir（默认与源同目录 <stem>-split/）。 */
export async function splitEvery(file, every, outDir) {
  requireFile(file, '源文件')
  if (!Number.isInteger(every) || every < 1) fail('every 需要 ≥1 的整数')
  const doc = await loadForEdit(file)
  const pageCount = doc.getPageCount()
  const stem = file.replace(/\.pdf$/i, '').split(/[\\/]/).pop()
  const dir = outDir && String(outDir).trim() !== ''
    ? String(outDir).trim()
    : join(dirname(resolve(file)), `${stem}-split`)
  const written = []
  let chunk = 1
  for (let start = 0; start < pageCount; start += every) {
    const count = Math.min(every, pageCount - start)
    const idx = [...Array(count)].map((_, k) => start + k)
    const sub = await PDFDocument.create()
    const copied = await sub.copyPages(doc, idx)
    for (const p of copied) sub.addPage(p)
    const bytes = await sub.save()
    const dest = join(dir, `${stem}-part${String(chunk).padStart(2, '0')}.pdf`)
    writeOut(dest, bytes)
    written.push(`${dest}（第 ${start + 1}-${start + count} 页，${fmtBytes(bytes.length)}）`)
    chunk++
  }
  return written.join('\n')
}

/* ------------------------------------------------------------------ */
/* 合并                                                              */
/* ------------------------------------------------------------------ */

export async function mergePdf(files, out) {
  if (!Array.isArray(files) || files.length < 2) fail('files 至少两个 PDF 文件')
  const dst = await PDFDocument.create()
  const summary = []
  let total = 0
  for (const f of files) {
    const path = requireFile(f, '源文件')
    const src = await loadForEdit(path)
    const n = src.getPageCount()
    if (n === 0) fail(`${path} 没有任何页面，无法合并`)
    const copied = await dst.copyPages(src, src.getPageIndices())
    for (const p of copied) dst.addPage(p)
    summary.push(`${path}（${n} 页）`)
    total += n
  }
  const bytes = await dst.save()
  const dest = out && String(out).trim() !== '' ? String(out).trim() : defaultOut(files[0], 'merged')
  writeOut(dest, bytes)
  return `合并 ${files.length} 个文件：\n${summary.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n已保存：${dest}（共 ${total} 页，${fmtBytes(bytes.length)}）`
}

/* ------------------------------------------------------------------ */
/* 签名                                                              */
/* ------------------------------------------------------------------ */

/** Catmull-Rom → 密集折线采样点（用于平滑手写笔迹）。 */
function densify(points, density = 24) {
  if (points.length < 3) return points.map((p) => ({ ...p }))
  const out = []
  const pts = points
  out.push({ x: pts[0].x, y: pts[0].y })
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    for (let k = 1; k <= density; k++) {
      const t = k / density
      const t2 = t * t
      const t3 = t2 * t
      const x = 0.5 * (
        (2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
      )
      const y = 0.5 * (
        (2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
      )
      out.push({ x, y })
    }
  }
  return out
}

function inkBBox(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of strokes) {
    for (const [x, y] of s.points) {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  }
  return { x0, y0, x1, y1 }
}

function todayStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function validateInk(ink) {
  if (!Array.isArray(ink)) fail('ink 应为笔迹数组')
  for (const s of ink) {
    if (!s || !Array.isArray(s.points) || s.points.length < 2) fail('每段笔迹 points 至少 2 个点')
    for (const pt of s.points) {
      if (!Array.isArray(pt) || pt.length < 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
        fail(`笔迹点必须是 [x, y] 数值对，收到：${JSON.stringify(pt)}`)
      }
    }
  }
}

export async function signPdf(file, args) {
  requireFile(file, '源文件')
  const doc = await loadForEdit(file)
  const clerk = fontClerk()
  const page = doc.getPage(pageIndex(args.page, doc.getPageCount()))
  const notes = []
  const pageNum = toInt(args.page, 1)

  const ink = Array.isArray(args.ink) ? args.ink : []
  validateInk(ink)

  /* 1) 矢量手写笔迹 */
  const strokesDrawn = []
  for (const s of ink) {
    const color = s.color ?? args.ink_color ?? '#123A8C'
    const width = toNum(s.width, 1.3)
    const c = parseColor(color, { r: 0.12, g: 0.23, b: 0.55 })
    const dense = densify(s.points.map(([x, y]) => ({ x, y })))
    for (let k = 0; k < dense.length - 1; k++) {
      page.drawLine({
        start: { x: dense[k].x, y: dense[k].y },
        end: { x: dense[k + 1].x, y: dense[k + 1].y },
        thickness: width,
        color: rgb(c.r, c.g, c.b),
        opacity: clamp01(s.opacity ?? 1),
        lineCap: LineCapStyle.Round,
      })
    }
    strokesDrawn.push([color, width, s.points.length])
  }
  if (strokesDrawn.length) {
    notes.push(`手写笔迹：${strokesDrawn.length} 段（色 ${[...new Set(strokesDrawn.map((s) => s[0]))].join(',')}，宽 ${[...new Set(strokesDrawn.map((s) => s[1]))].join(',')} pt）`)
  }

  /* 2) 图章/签名图（透明 PNG 最佳） */
  if (args.image && String(args.image).trim() !== '') {
    const imgPath = requireFile(args.image, '签名图片')
    const img = await embedImage(doc, imgPath)
    const imgBox = args.img ?? {}
    const naturalW = img.width
    const naturalH = img.height
    const w = toNum(imgBox.w, naturalW > 0 && naturalW < 600 ? naturalW : naturalW / 4)
    const h = toNum(imgBox.h, (w / naturalW) * naturalH)
    page.drawImage(img, {
      x: toNum(imgBox.x, 36),
      y: toNum(imgBox.y, 36),
      width: w,
      height: h,
      opacity: clamp01(imgBox.opacity ?? 1),
      ...(toNum(imgBox.rotate, 0) !== 0 ? { rotate: degrees(degreesSafe(imgBox.rotate)) } : {}),
    })
    notes.push(`签名图：${args.image}（${w.toFixed(1)}×${h.toFixed(1)} pt @ (${imgBox.x ?? 36}, ${imgBox.y ?? 36})）`)
  }

  /* 3) 打字：姓名 + 日期 + 事由（可自定义字体） */
  const textCfg = args.text ?? {}
  const drawing =
    typeof textCfg.name === 'string' && textCfg.name !== ''
    || typeof textCfg.date === 'string'
    || typeof textCfg.reason === 'string'
  if (drawing) {
    const name = typeof textCfg.name === 'string' ? textCfg.name : ''
    const date = textCfg.date === undefined || textCfg.date === null || textCfg.date === '' ? todayStr() : String(textCfg.date)
    const reason = typeof textCfg.reason === 'string' ? textCfg.reason : null
    const size = toNum(textCfg.size, 11)
    const color = parseColor(textCfg.color, { r: 0.12, g: 0.23, b: 0.55 })
    const lineText = reason ? `${name}（${reason}）` : name
    const font = await pickFont(doc, clerk, lineText, textCfg.font || args.font)

    let tx = toNum(textCfg.x, NaN)
    let ty = toNum(textCfg.y, NaN)
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
      // 默认：笔迹包围盒下方；否则图章右侧；否则页左下
      const bbox = ink.length ? inkBBox(ink) : null
      if (bbox) {
        tx = bbox.x0
        ty = Math.max(8, bbox.y0 - 11 - size)
      } else if (args.image) {
        tx = 36 + (args.img?.w ?? 0)
        ty = 36
      } else {
        tx = 36
        ty = 36
      }
    }
    page.drawText(`${name}  ${date}`, {
      x: tx,
      y: ty,
      size,
      font,
      color: rgb(color.r, color.g, color.b),
      opacity: 1,
    })
    let note = `手写签名文本：${name || '(姓名未填)'}  ${date}`
    if (reason) {
      page.drawText(reason, { x: tx, y: ty - size * 1.6, size: size * 0.92, font, color: rgb(color.r, color.g, color.b) })
      note += ` ／ 事由：${reason}`
    }
    notes.push(`${note}（第 ${pageNum} 页 @ (${tx.toFixed(1)}, ${ty.toFixed(1)})）`)
  }

  if (notes.length === 0) fail('签名什么也没画：请至少提供 ink（笔迹）、image（签名图）或 text.name 之一')

  const saved = await doc.save()
  const outPath = args.out && String(args.out).trim() !== '' ? String(args.out).trim() : defaultOut(file, 'signed')
  writeOut(outPath, saved)
  notes.push(`已保存：${outPath}（${fmtBytes(saved.length)}）`)
  return notes.join('\n')
}