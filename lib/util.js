/**
 * dsh-pdf-toolkit — 公共小工具：路径/字节/颜色/页码表达式。
 *
 * 全部坐标约定：单位 pt（1pt = 1/72 英寸），原点在页面 **左下角**，
 * 与 pdf-lib 一致。颜色 '#RRGGBB'。
 */
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** 抛出一个面向使用者的错误（信息会原样回到模型/用户眼前）。 */
export function fail(message) {
  throw new Error(message)
}

/** 断言某个值是 1 起的整数页码。 */
export function pageIndex(page1, pageCount) {
  const v = toInt(page1, NaN)
  if (!Number.isInteger(v) || v < 1 || v > pageCount) {
    fail(`页码越界：${page1}（当前文档共 ${pageCount} 页，页码从 1 起）`)
  }
  return v - 1
}

/** 检查一个普通文件存在且可读（不限定扩展名，但给出明确报错）。 */
export function requireFile(path, label = '文件') {
  if (typeof path !== 'string' || path.trim() === '') fail(`${label}必填：请提供文件路径`)
  const p = resolve(path.trim())
  if (!existsSync(p)) fail(`${label}不存在：${p}`)
  if (!statSync(p).isFile()) fail(`${label}不是文件：${p}`)
  return p
}

/** 读整个文件为 Uint8Array（Buffer 即 Uint8Array 子类）。 */
export function readBytes(path) {
  return new Uint8Array(readFileSync(path))
}

/** 写文件（自动建目录），返回绝对路径。 */
export function writeOut(path, bytes) {
  const p = resolve(path)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, Buffer.from(bytes))
  return p
}

/** file.pdf → <目录>/<原名>-<suffix>.pdf；已存在则带时间戳后缀，绝不覆盖源文件。 */
export function defaultOut(source, suffix, dir = null) {
  const target = dir ?? dirname(resolve(source))
  const stem = basename(resolve(source)).replace(/\.pdf$/i, '')
  let candidate = join(target, `${stem}-${suffix}.pdf`)
  if (!existsSync(candidate)) return candidate
  const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
  candidate = join(target, `${stem}-${suffix}-${ts}.pdf`)
  return candidate
}

/** '#RRGGBB'（# 可省）→ {r,g,b} 0..1。 */
export function parseColor(s, fallback = { r: 0, g: 0, b: 0 }) {
  if (typeof s !== 'string' || s.trim() === '') return fallback
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s.trim())
  if (!m) fail(`颜色格式应为 '#RRGGBB'，收到：${s}`)
  const v = parseInt(m[1], 16)
  return { r: ((v >> 16) & 0xff) / 255, g: ((v >> 8) & 0xff) / 255, b: (v & 0xff) / 255 }
}

/**
 * 页码表达式 → 0 起页码 Set。支持 'all'、'1-3,5,8-'（8- 指到末尾）。
 * pageCount 用于越界检查和开放区间。
 */
export function parsePagesExpr(expr, pageCount) {
  if (expr === undefined || expr === null || String(expr).trim() === '' || String(expr).trim() === 'all') {
    return new Set([...Array(pageCount).keys()])
  }
  const out = new Set()
  for (const part of String(expr).split(',')) {
    const p = part.trim()
    if (p === '') continue
    const m = /^(\d+)(?:-(\d*))?$/.exec(p)
    if (!m) fail(`页码表达式无法解析：'${p}'（形如 1-3,5,8-，从 1 起）`)
    let a = parseInt(m[1], 10)
    let b = m[2] === undefined ? a : m[2] === '' ? pageCount : parseInt(m[2], 10)
    if (a < 1 || b < 1 || a > pageCount || b > pageCount) {
      fail(`页码越界：${p}（文档共 ${pageCount} 页）`)
    }
    if (b < a) [a, b] = [b, a]
    for (let i = a; i <= b; i++) out.add(i - 1)
  }
  return out
}

/** 页码数组（1 起）→ 0 起 Set。 */
export function parsePagesArray(arr, pageCount) {
  if (!Array.isArray(arr) || arr.length === 0) fail('pages 需要至少一个页码')
  const out = new Set()
  for (const v of arr) {
    const p = toInt(v, NaN)
    if (!Number.isInteger(p) || p < 1 || p > pageCount) fail(`页码越界：${v}（文档共 ${pageCount} 页）`)
    out.add(p - 1)
  }
  return out
}

export function toNum(v, def) {
  return typeof v === 'number' && Number.isFinite(v) ? v : def
}
export function toInt(v, def) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : def
}
export function toStr(v, def = '') {
  return typeof v === 'string' ? v : def
}
export function clamp01(v) {
  return Math.min(1, Math.max(0, toNum(v, 1)))
}
export function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/**
 * WinAnsi（cp1252）是否足以编码整段文字。
 * 标准字体（Helvetica 等）只有 WinAnsi 编码：不能编码中文/全角/emoji。
 */
const CP1252_EXTRA =
  '\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D' +
  '\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178'
export function nonAnsiChars(text) {
  const out = []
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code === 0x0a) continue
    if (code >= 0x20 && code <= 0x7e) continue
    if (ch === '\u00a0') continue
    if (code >= 0xa1 && code <= 0xff) continue
    if (CP1252_EXTRA.includes(ch)) continue
    out.push(ch)
  }
  return out
}
export function isWinAnsi(text) {
  return nonAnsiChars(text).length === 0
}