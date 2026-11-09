/**
 * studio.js — 内嵌「在线 PDF 编辑器」的 loopback HTTP 服务。
 *
 * 供 DSH 桌面版右侧栏「浏览器」tab 使用（sidebar-browser 接受 http/https 含
 * loopback 目标）。编辑器页面（editor.html）在浏览器里用 pdfjs 渲染页面、
 * 收发鼠标操作，真正落盘的重活全部 POST 回本服务、复用 lib/engine.js 的
 * pdf-lib 引擎。文件只在本机流动，服务只绑 127.0.0.1。
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { editPdf, signPdf } from './engine.js'
import { defaultOut } from './util.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PREFERRED_PORT = 48731
const MAX_BODY = 4 * 1024 * 1024

const sessions = new Map() // sid -> { base, rev }

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
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        rejectBody(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        rejectBody(new Error('请求体不是合法 JSON'))
      }
    })
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
      if (pathname === '/api/health') return sendJson(res, 200, { ok: true, name: 'dsh-pdf-toolkit studio' })
      if (pathname === '/pdf') return servePdfFile(res, u.searchParams.get('f'))
      return sendText(res, 404, 'not found')
    }

    if (req.method === 'POST' && pathname === '/api/apply') {
      const body = await readJsonBody(req)
      const file = resolve(String(body?.file ?? ''))
      const ops = body?.ops
      if (!existsSync(file)) return sendJson(res, 400, { error: `文件不存在：${file}` })
      if (!Array.isArray(ops) || ops.length !== 1) return sendJson(res, 400, { error: '一次只允许一个操作' })
      const sid = String(body?.sid ?? '').slice(0, 48) || randomUUID()
      const out = nextRevOut(sid, body?.base || file)
      const summary = await editPdf(file, ops, out)
      return sendJson(res, 200, { ok: true, out, summary })
    }

    if (req.method === 'POST' && pathname === '/api/sign') {
      const body = await readJsonBody(req)
      const file = resolve(String(body?.file ?? ''))
      if (!existsSync(file)) return sendJson(res, 400, { error: `文件不存在：${file}` })
      const sid = String(body?.sid ?? '').slice(0, 48) || randomUUID()
      const out = nextRevOut(sid, body?.base || file)
      const summary = await signPdf(file, {
        page: body?.page,
        ink: body?.ink,
        text: body?.text ?? {},
        out,
      })
      return sendJson(res, 200, { ok: true, out, summary })
    }

    if (req.method === 'POST' && pathname === '/api/save') {
      const body = await readJsonBody(req)
      const file = resolve(String(body?.file ?? ''))
      if (!existsSync(file)) return sendJson(res, 400, { error: `文件不存在：${file}` })
      const base = body?.base ? resolve(String(body.base)) : file
      const outRaw = typeof body?.out === 'string' && body.out.trim() !== '' ? resolve(body.out) : null
      const saved = outRaw ?? defaultOut(base, 'edited')
      copyFileSync(file, saved)
      return sendJson(res, 200, { ok: true, saved })
    }

    return sendText(res, 404, 'not found')
  } catch (err) {
    sendJson(res, 500, { error: String(err?.message ?? err) })
  }
}

function listen(port) {
  return new Promise((ok, no) => {
    const srv = createServer(handle)
    srv.once('error', no)
    srv.listen(port, '127.0.0.1', () => {
      srv.removeListener('error', no)
      ok(srv)
    })
  })
}

/** 启动（幂等）并返回编辑器地址。 */
export async function ensureStudio(file) {
  if (serverInstance && serverUrl) {
    return `${serverUrl}/?f=${encodeURIComponent(file)}`
  }
  let srv = null
  try {
    srv = await listen(PREFERRED_PORT)
  } catch {
    srv = await listen(0)
  }
  const port = srv.address().port
  serverInstance = srv
  serverUrl = `http://127.0.0.1:${port}`
  return `${serverUrl}/?f=${encodeURIComponent(file)}`
}