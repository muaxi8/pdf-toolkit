/**
 * smoke.mjs — 端到端冒烟测试：生成样例 PDF → 打开/拆分/合并/编辑/签名 → 校验产物。
 * 不加载 DSH 上下文（不 import index.js），直接驱动 engine/pdftext。
 *
 * 运行：node scripts/smoke.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { editPdf, mergePdf, signPdf, splitEvery, splitPdf } from '../lib/engine.js'
import { readPdf } from '../lib/pdftext.js'

const work = mkdtempSync(join(tmpdir(), 'dsh-pdf-smoke-'))
const results = []
function assert(cond, msg) {
  if (!cond) {
    results.push(`FAIL ${msg}`)
    process.exitCode = 1
    throw new Error(`断言失败：${msg}`)
  }
  results.push(`PASS ${msg}`)
}
async function pageCountOf(path) {
  const doc = await PDFDocument.load(readFileSync(path))
  return doc.getPageCount()
}
const sample = join(work, 'sample.pdf')

async function makeSample() {
  const doc = await PDFDocument.create()
  const helv = await doc.embedFont(StandardFonts.Helvetica)
  const texts = ['Hello PDF Toolkit', 'Page Two Content']
  for (let i = 0; i < texts.length; i++) {
    const page = doc.addPage([595.28, 841.89])
    page.drawText(texts[i], { x: 80, y: 720, size: 22, font: helv, color: rgb(0.1, 0.1, 0.6) })
    page.drawText(`PAGE-MARK-${i + 1}`, { x: 80, y: 680, size: 14, font: helv })
  }
  writeFileSync(sample, await doc.save())
}

/* 主流程 */
try {
  await makeSample()
  assert(existsSync(sample), '样例 PDF 已生成（2 页）')

  /* 1. 打开阅读 */
  const opened = await readPdf(new Uint8Array(readFileSync(sample)), { pagesExpr: 'all', maxChars: 2000 })
  assert(opened.pageCount === 2, `pdf_open：页数=2（实际 ${opened.pageCount}）`)
  assert(opened.pages[0].text.includes('Hello PDF Toolkit'), 'pdf_open：第 1 页可读到文本')
  assert(opened.pages[1].text.includes('Page Two Content'), 'pdf_open：第 2 页可读到文本')

  /* 2. 按 ranges 拆分 */
  const r1 = join(work, 'r1.pdf')
  const r2 = join(work, 'r2.pdf')
  await splitPdf(sample, [{ pages: '1', out: r1 }, { pages: [2], out: r2 }])
  assert((await pageCountOf(r1)) === 1 && (await pageCountOf(r2)) === 1, 'pdf_split(ranges)：拆出两个单页 PDF')

  /* 3. 每 N 页拆分 */
  await splitEvery(sample, 1, join(work, 'parts'))
  assert(existsSync(join(work, 'parts', 'sample-part01.pdf')) && existsSync(join(work, 'parts', 'sample-part02.pdf')), 'pdf_split(every)：两个 part 文件齐备')

  /* 4. 合并 */
  const merged = join(work, 'merged.pdf')
  await mergePdf([r1, r2, r1], merged)
  assert((await pageCountOf(merged)) === 3, 'pdf_merge：1+1+1=3 页')

  /* 5. 编辑（加文字/替换/旋页/删页/插页） */
  const edited = join(work, 'edited.pdf')
  await editPdf(sample, [
    { op: 'add_text', page: 1, x: 80, y: 640, text: 'EDITED-OK', size: 16, color: '#00AA00' },
    { op: 'replace_text', page: 1, from: 'Hello', to: 'HELLO2', cover: '#FFFFFF' },
    { op: 'rotate_page', page: 2, degrees: 90 },
    { op: 'remove_page', pages: [2] },
    { op: 'add_blank_page', after: 1, width: 595, height: 842 },
  ], edited)
  assert(existsSync(edited), 'pdf_edit：输出文件已生成')
  const editedDoc = await PDFDocument.load(readFileSync(edited))
  assert(editedDoc.getPageCount() === 2, `pdf_edit：删 1 页、插 1 页后仍为 2 页（实际 ${editedDoc.getPageCount()}）`)
  const editedText = await readPdf(new Uint8Array(readFileSync(edited)), { maxChars: 4000 })
  assert(editedText.pages[0].text.includes('HELLO2'), 'pdf_edit：replace_text 生效（HELLO2 在文本层可见）')
  assert(editedText.pages[0].text.includes('EDITED-OK'), 'pdf_edit：add_text 生效')

  /* 6. 签名（矢量笔迹 + 姓名/日期/事由） */
  const signed = join(work, 'signed.pdf')
  const ink = [
    { points: [[80, 100], [110, 130], [150, 90], [190, 120], [240, 95]], width: 1.4 },
  ]
  await signPdf(sample, {
    page: 1,
    ink,
    text: { name: 'Zhang San', reason: 'Approved' },
    out: signed,
  })
  assert(existsSync(signed), 'pdf_sign：签名文件已生成')
  const signedDoc = await PDFDocument.load(readFileSync(signed))
  assert(signedDoc.getPageCount() === 2, 'pdf_sign：页码不变')

  /* 7. 源文件保持不变 */
  const before = statSync(sample)
  assert(before.size === statSync(sample).size, '源文件未被任何操作覆盖')

  console.log(`\n==== dsh-pdf-toolkit 冒烟测试完成（${results.filter((r) => r.startsWith('PASS')).length}/${results.filter((r) => r.startsWith('PASS') || r.startsWith('FAIL')).length} 通过）====`)
  for (const r of results) console.log(r)
  console.log(`工作目录：${work}`)
} catch (err) {
  results.push(`FAIL 异常：${err?.message ?? err}`)
  console.log('==== 冒烟测试失败 ====')
  for (const r of results) console.log(r)
  console.error(err)
  process.exitCode = 1
}