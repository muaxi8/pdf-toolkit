/**
 * schema-check.mjs — 用已安装 DSH 里的 dsh-tools 校验每个工具的 parameter/output schema。
 *
 * 直接以 file:// URL 导入宿主（DSH Desktop）自带 dsh-tools 的
 * parameterSchemaSpecToJsonSchema / valueSchemaSpecToJsonSchema，在安装插件之前
 * 把"作者 schema 写错"这一类问题挡在本机。
 *
 * 运行：node scripts/schema-check.mjs
 */
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { TOOL_PARAMETERS } from '../lib/schemas.js'

const candidates = [
  process.env.DSH_DSH_TOOLS_PATH ?? '',
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
]
const entry = candidates.find((p) => p !== '' && existsSync(p))

if (!entry) {
  console.log('SKIP 未找到 DSH Desktop 安装（schema 编译器不可用）；跳过 schema 校验。')
  process.exit(0)
}

const { parameterSchemaSpecToJsonSchema, valueSchemaSpecToJsonSchema } = await import(pathToFileURL(entry).href)

let failed = 0
for (const [name, spec] of Object.entries(TOOL_PARAMETERS)) {
  try {
    const s = parameterSchemaSpecToJsonSchema(spec)
    const keyCount = Object.keys(s.properties ?? {}).length
    console.log(`PASS ${name}：参数 schema 编译通过（${keyCount} 个参数${s.required?.length ? '，必填 ' + s.required.join('/') : ''}）`)
  } catch (err) {
    failed++
    console.log(`FAIL ${name}：${err?.message ?? err}`)
  }
}
try {
  const out = valueSchemaSpecToJsonSchema({ type: 'string' })
  console.log(`PASS 输出 schema ${JSON.stringify(out)} 编译通过`)
} catch (err) {
  failed++
  console.log(`FAIL 输出 schema：${err?.message ?? err}`)
}

if (failed > 0) {
  console.log(`\n${failed} 个 schema 未通过，修复后再安装。`)
  process.exit(1)
}
console.log('\n全部 schema 通过。')