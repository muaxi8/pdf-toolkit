/**
 * studio.js — 内嵌「在线 PDF 编辑器」的 loopback HTTP 服务（v0.3）。
 *
 * 编辑器采用「重放式」编辑：前端维护一个 ops 列表（每条 = 一次用户动作），
 * 每次改动把完整 ops 列表 POST 到 /api/render，服务端从 **源文件 base**
 * 重放重建工作稿。因此签名/涂鸦/文字等对象都能被选中、移动、删除——
 * 移动 = 改该 op 的坐标后重放；删除 = 从 ops 列表移除后重放。
 *
 * 文件只在本机流动，服务只绑 127.0.0.1。中间稿留在临时目录，
 * 只有「另存」（/api/save）会写出正式文件（默认 <原名>-edited.pdf，不覆盖源文件）。
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { editPdf, mergePdf, splitEvery, splitPdf } from './engine.js'
import { defaultOut } from './util.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PREFERRED_PORT = 48731
const MAX_JSON = 8 * 1024 * 1024
const MAX_UPLOAD = 64 * 1024 * 1024

const sessions = new Map() // sid -> { base }

function sessionDir(sid) {
  const dir = join(tmpdir(), 'dsh-pdf-studio', String(sid).slice(0, 16))
  mkdirSync(dir, { recursive: true })
  return dir
}

function nextRevOut(sid, base) {
  const s = sessions.get(sid) ?? { base, rev: 0 }
  sessions.set(sid, { base: s.base ?? base, rev: s.rev + 1 })
  return join(sessionDir(sid), `rev${s.rev + 1}.pdf`)
}

/* ---------- 静态资源 ---------- */

function pdfjsAsset(name) {
  let url = null
  try {
    url = import.meta.resolve(`pdfjs-dist/legacy/build/${name}`)
  } catch {}
  if (url && url.startsWith('file:')) return fileURLToPath(url)
  return join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', name)
}

let editorCache = null
function editorHtml() {
  if (editorCache === null) editorCache = readFileSync(join(__dirname, 'editor.html'), 'utf8')
  return editorCache
}

/* ---------- HTTP 工具 ---------- */

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj))
}

function sendText(res, code, text) {
  send(res, code, text, 'text/plain; charset=utf-8')
}

function readJsonBody(req) {
  return readRawBody(req, MAX_JSON).then((buf) => JSON.parse(buf.toString('utf8')))
}

function readRawBody(req, limit) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        rejectBody(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', rejectBody)
  })
}

function servePdfFile(res, raw) {
  const file = resolve(String(raw ?? ''))
  if (!/\.pdf$/i.test(file)) return sendText(res, 400, '只允许 .pdf 文件')
  let st
  try {
    st = statSync(file)
  } catch {
    return sendText(res, 404, `文件不存在：${file}`)
  }
  if (!st.isFile()) return sendText(res, 400, '路径不是普通文件')
  const bytes = readFileSync(file)
  res.writeHead(200, {
    'content-type': 'application/pdf',
    'content-length': bytes.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(bytes)
}

/* ---------- 服务 ---------- */

let serverInstance = null
let serverUrl = null

async function handle(req, res) {
  const u = new URL(req.url ?? '/', 'http://127.0.0.1')
  const pathname = decodeURIComponent(u.pathname)
  try {
    if (req.method === 'GET') {
      if (pathname === '/' || pathname === '/index.html') {
        return send(res, 200, editorHtml(), 'text/html; charset=utf-8')
      }
      if (pathname === '/assets/pdf.mjs') {
        return send(res, 200, readFileSync(pdfjsAsset('pdf.mjs')), 'text/javascript; charset=utf-8')
      }
      if (pathname === '/assets/pdf.worker.mjs') {
        return send(res, 200, readFileSync(pdfjsAsset('pdf.worker.mjs')), 'text/javascript; charset=utf-8')
      }
      if (pathname === '/api/health') return sendJson(res, 200, { ok: true, name: 'dsh-pdf-toolkit studio', version: '0.3.0' })
      if (pathname === '/pdf') return servePdfFile(res, u.searchParams.get('f'))
      return sendText(res, 404, 'not found')
    }

    if (req.method === 'POST' && pathname === '/api/render') {
      const body = await readJsonBody(req)
      const base = resolve(String(body?.base ?? ''))
      if (!existsSync(base)) return sendJson(res, 400, { error: `源文件不存在：${base}` })
      const ops = Array.isArray(body?.ops) ? body.ops : null
      if (!ops) return sendJson(res, 400, { error: 'ops 应为数组' })
      const sid = String(body?.sid ?? '').slice(0, 48) || randomUUID()
      const out = nextRevOut(sid, base)
      if (ops.length === 0) {
        copyFileSync(base, out)
        return sendJson(res, 200, { ok: true, out })
      }
      const summary = await editPdf(base, ops, out)
      return sendJson(res, 200, { ok: true, out, summary })
    }

    if (req.method === 'POST' && pathname === '/api/split') {
      const body = await readJsonBody(req)
      const file = resolve(String(body?.file ?? ''))
      if (!existsSync(file)) return sendJson(res, 400, { error: `文件不存在：${file}` })
      const outDir = body?.out_dir && String(body.out_dir) !== '' ? resolve(String(body.out_dir)) : undefined
      if (body?.mode === 'ranges') {
        const ranges = Array.isArray(body.ranges) && body.ranges.length > 0 ? body.ranges : null
        if (!ranges) return sendJson(res, 400, { error: 'ranges 至少一项 {pages}' })
        return sendJson(res, 200, { ok: true, summary: await splitPdf(file, ranges, outDir) })
      }
      const every = Number.isInteger(body?.every) && body.every >= 1 ? body.every : 1
      return sendJson(res, 200, { ok: true, every, summary: await splitEvery(file, every, outDir) })
    }

    if (req.method === 'POST' && pathname === '/api/merge') {
      const body = await readJsonBody(req)
      const files = Array.isArray(body?.files) ? body.files.map((f) => resolve(String(f))) : []
      if (files.length < 2) return sendJson(res, 400, { error: 'files 至少两个 PDF 路径' })
      const out = body?.out && String(body.out) !== '' ? resolve(String(body.out)) : defaultOut(files[0], 'merged')
      const summary = await mergePdf(files, out)
      return sendJson(res, 200, { ok: true, out, summary })
    }

    if (req.method === 'POST' && pathname === '/api/save') {
      const body = await readJsonBody(req)
      const file = resolve(String(body?.file ?? ''))
      if (!existsSync(file)) return sendJson(res, 400, { error: `工作稿不存在：${file}` })
      const base = body?.base && String(body.base) !== '' ? resolve(String(body.base)) : file
      const saved = body?.out && String(body.out) !== '' ? resolve(String(body.out)) : defaultOut(base, 'edited')
      copyFileSync(file, saved)
      return sendJson(res, 200, { ok: true, saved })
    }

    if (req.method === 'POST' && pathname === '/api/upload') {
      const nameRaw = String(u.searchParams.get('name') ?? 'upload.pdf')
      const safe = basename(resolve(nameRaw))
      if (!/\.pdf$/i.test(safe)) return sendJson(res, 400, { error: '只允许上传 .pdf 文件' })
      const sid = String(u.searchParams.get('sid') ?? '').slice(0, 48) || 'anon'
      const dir = join(sessionDir(sid), 'uploads')
      mkdirSync(dir, { recursive: true })
      const bytes = await readRawBody(req, MAX_UPLOAD)
      const dest = join(dir, `${Date.now()}-${safe}`)
      writeFileSync(dest, bytes)
      return sendJson(res, 200, { ok: true, path: dest })
    }

    return sendText(res, 404, 'not found')
  } catch (err) {
    return sendJson(res, 500, { error: err?.message ?? String(err) })
  }
}

/**
 * 启动（或复用）编辑器服务，返回编辑器首页 URL。
 * file 可省略：编辑器打开后可在页面里手动输入路径、上传或拖入 PDF。
 */
export async function ensureStudio(file) {
  if (!serverInstance) {
    serverInstance = createServer(handle)
    serverInstance.on('error', () => {}) // 端口被占时切换随机端口用
    try {
      await new Promise((ok, no) => {
        serverInstance.once('error', no)
        serverInstance.listen(PREFERRED_PORT, '127.0.0.1', ok)
      })
      serverUrl = `http://127.0.0.1:${PREFERRED_PORT}`
    } catch {
      await new Promise((ok, no) => {
        serverInstance.once('error', no)
        serverInstance.listen(0, '127.0.0.1', ok)
      })
      serverUrl = `http://127.0.0.1:${serverInstance.address().port}`
    }
  }
  const f = file && String(file).trim() !== '' ? String(file).trim() : null
  return f ? `${serverUrl}/?f=${encodeURIComponent(f)}` : `${serverUrl}/`
}

/** 测试辅助：返回服务是否已启动（供冒烟脚本用）。 */
export function studioReady() {
  return serverUrl
}