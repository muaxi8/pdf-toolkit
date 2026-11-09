/**
 * schemas.js — PDF 工具的「作者侧」参数 schema（dsh-tools enforced subset）。
 *
 * 支持的关键字：type / description / title / default / examples / required(true)
 * / enum / const / oneOf / items / properties / additionalProperties(bool)。
 * 不支持：minimum / maximum / pattern 等，别写。
 *
 * 坐标约定：单位 pt，原点 **左下角**。
 */

/** 颜色：'#RRGGBB'。 */
const colorSchema = {
  type: 'string',
  description: "颜色 '#RRGGBB'（可省略 #）。",
}
/** 页码：从 1 起。 */
const pageSchema = (what) => ({
  type: 'integer',
  description: `${what}页码（从 1 起；按 ops 执行后的当前文档状态编号）。`,
})
/** 1 起页码数组。 */
const pagesArraySchema = (what) => ({
  type: 'array',
  description: `${what}页码数组（从 1 起）。`,
  items: { type: 'integer' },
})
/** 页码表达式。 */
const pagesExprSchema = {
  type: 'string',
  description: "页码表达式，如 '1-3,5,8-'（8- 指到最后一页）或 'all'。",
}

export const pdf_open_parameters = {
  file: {
    type: 'string',
    required: true,
    description: '要打开的 PDF 文件路径。',
  },
  pages: {
    ...pagesExprSchema,
    description: '只读取这些页的文本；缺省 = 所有页。',
  },
  max_chars: {
    type: 'integer',
    description: '每页文本最多返回的字符数（默认 4000），很大的文档可以调低。',
  },
  password: {
    type: 'string',
    description: '打开口令（pdf_open 支持带口令的 PDF；编辑工具要求无口令源文件）。',
  },
}

export const pdf_edit_parameters = {
  file: { type: 'string', required: true, description: '要编辑的 PDF 文件路径（不会被覆盖）。' },
  ops: {
    type: 'array',
    required: true,
    description:
      '按顺序执行的操作列表。所有坐标单位 pt、原点左下角；颜色默认 #000000。' +
      '操作按顺序作用于同一文档：先删页/旋转会影响后续操作看到的页码。支持的操作：\n' +
      '• set_metadata：改元数据（title/author/subject/keywords/producer/creator，空字符串=清除，不传=不动）\n' +
      '• remove_page：pages:[页码数组] 删除页面（至少留 1 页）\n' +
      '• rotate_page：page+degrees(90/180/270) 设定绝对旋转\n' +
      '• add_text：page+x+y+text+size+color+font+opacity+rotate，写入文字（支持 "\\n" 多行）\n' +
      '• add_image：page+x+y+image(路径)+width/height+opacity+rotate，放置 png/jpg 图片\n' +
      '• replace_text：page+from+to+cover+size+color+font，找到首处原文用底色盖住再写新文本（仅对有文本层的 PDF 有效）\n' +
      '• redact：page+x+y+w+h+color，画一块不透明遮盖（默认白）\n' +
      '• add_rect：page+x+y+w+h+color(边框)+borderWidth+fill(填充)+opacity\n' +
      '• add_line：x1+y1+x2+y2+thickness+color+opacity，画直线\n' +
      '• add_blank_page：after(0=最前,缺省=末尾)+width+height（默认 A4）\n' +
      '• watermark：text+page(缺省=全部页)+size+angle+color+opacity+font，斜向水印',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        op: {
          type: 'string',
          required: true,
          enum: [
            'set_metadata', 'remove_page', 'rotate_page', 'rotate_page_by', 'add_text', 'add_image',
            'replace_text', 'redact', 'add_rect', 'add_line', 'add_blank_page', 'watermark',
          ],
        },
        // ——— 页面定位 ———
        page: pageSchema('目标'),
        pages: pagesArraySchema('要删除的'),
        after: { type: 'integer', description: 'add_blank_page：插到第几页之后（0=最前，缺省=末尾）。' },
        delta: { type: 'integer', enum: [-270, -180, -90, 90, 180, 270], description: 'rotate_page_by：相对旋转增量（±90/±180/±270）。' },
        // ——— 坐标/尺寸 ———
        x: { type: 'number', description: 'X 坐标 pt（左下原点，缺省 0）。' },
        y: { type: 'number', description: 'Y 坐标 pt（缺省 0）。' },
        x1: { type: 'number', description: 'add_line 起点 X。' },
        y1: { type: 'number', description: 'add_line 起点 Y。' },
        x2: { type: 'number', description: 'add_line 终点 X。' },
        y2: { type: 'number', description: 'add_line 终点 Y。' },
        w: { type: 'number', description: '宽度 pt（add_rect / redact）。' },
        h: { type: 'number', description: '高度 pt（add_rect / redact）。' },
        width: { type: 'number', description: '宽 pt（add_image / add_blank_page）。' },
        height: { type: 'number', description: '高 pt（add_image / add_blank_page）。' },
        // ——— 文字 ———
        text: { type: 'string', description: 'add_text / watermark 的文本；replace_text 的新文本。支持换行。' },
        from: { type: 'string', description: 'replace_text：要查找并替换的原文（精确子串，首处匹配）。' },
        size: { type: 'number', description: '字号 pt（add_text 默认 12；watermark 默认 46）。' },
        font: {
          type: 'string',
          description: '字体：标准字体名（如 Helvetica / TimesRoman / Courier 及其 Bold/Oblique）或 .ttf/.otf 文件路径。缺省自动选择（ASCII→Helvetica，中文→系统 simhei/simfang/simkai）。',
        },
        // ——— 样式 ———
        color: { ...colorSchema, description: '文字/线/边框颜色（watermark 默认灰 #B3B3B3）。' },
        fill: { ...colorSchema, description: 'add_rect 填充色（缺省不填充）。' },
        cover: { ...colorSchema, description: 'replace_text 的遮盖色（默认白 #FFFFFF）。' },
        borderWidth: { type: 'number', description: 'add_rect 边框粗细 pt（默认 1）。' },
        thickness: { type: 'number', description: 'add_line 线粗 pt（默认 1）。' },
        opacity: { type: 'number', description: '不透明度 0~1（add_text/add_image 默认 1；watermark 默认 0.35）。' },
        rotate: { type: 'number', description: 'add_text / add_image 顺时针旋转角度（0~359）。' },
        angle: { type: 'number', description: 'watermark 倾斜角（默认 45）。' },
        degrees: { type: 'integer', enum: [90, 180, 270], description: 'rotate_page 绝对旋转角度。' },
        // ——— 资源 ———
        image: { type: 'string', description: 'add_image 的图片路径（.png/.jpg）。' },
        password: { type: 'string', description: '（保留：编辑不支持口令加密源文件，请先另存无口令副本）' },
      },
    },
  },
  out: {
    type: 'string',
    description: '输出 PDF 路径；缺省 = 源文件旁生成 <原名>-edited.pdf（绝不覆盖源文件）。',
  },
}

export const pdf_split_parameters = {
  file: { type: 'string', required: true, description: '要拆分的 PDF 文件路径。' },
  ranges: {
    type: 'array',
    description:
      '按页码范围拆分：每项 {pages, out?}。pages 可为表达式字符串（1-3,5,8-）或页码数组（1 起）。' +
      '与 every 二选一；不给 ranges 就按 every 拆。',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pages: {
          oneOf: [
            { ...pagesExprSchema },
            pagesArraySchema(''),
          ],
          required: true,
        },
        out: { type: 'string', description: '该范围的输出路径；缺省 = 源文件旁 <原名>-p<起>-<止>.pdf。' },
      },
    },
  },
  every: {
    type: 'integer',
    description: '每 N 页拆成一份（与 ranges 互斥，两者都不给时按每页一份输出到 out_dir）。',
  },
  out_dir: {
    type: 'string',
    description: 'every 模式的输出目录；缺省 = 源文件旁 <原名>-split/。',
  },
}

export const pdf_merge_parameters = {
  files: {
    type: 'array',
    required: true,
    description: '要合并的 PDF 文件路径（按给定顺序，至少两个）。',
    items: { type: 'string' },
  },
  out: {
    type: 'string',
    description: '输出 PDF 路径；缺省 = 第一个文件旁 merged.pdf 或带时间戳。',
  },
}

export const pdf_sign_parameters = {
  file: { type: 'string', required: true, description: '要签名的 PDF 文件路径（不会被覆盖）。' },
  page: { type: 'integer', required: true, description: '签名所在页（从 1 起）。' },
  out: {
    type: 'string',
    description: '输出 PDF 路径；缺省 = 源文件旁 <原名>-signed.pdf。',
  },
  ink: {
    type: 'array',
    description:
      "矢量手写笔迹（推荐：模型生成多段平滑点迹，颜色默认 #123A8C、宽默认 1.3pt）。" +
      '每段 stroke：{points: [[x,y],...], color?, width?, opacity?}，点为 pt 单位（左下原点）。',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        points: {
          type: 'array',
          description: '笔迹控制点序列，至少 2 个 [x, y] 数值对。',
          items: { type: 'array', items: { type: 'number' } },
          required: true,
        },
        color: { ...colorSchema, description: '这段笔迹的颜色（默认 #123A8C）。' },
        width: { type: 'number', description: '笔迹宽度 pt（默认 1.3）。' },
        opacity: { type: 'number', description: '不透明度 0~1（默认 1）。' },
      },
    },
  },
  ink_color: {
    type: 'string',
    description: '所有笔迹的默认颜色（#RRGGBB，默认 #123A8C）。各 stroke 可单独覆盖。',
  },
  image: {
    type: 'string',
    description: '签名图/图章路径（.png 透明底最佳 / .jpg）。',
  },
  img: {
    type: 'object',
    additionalProperties: false,
    properties: {
      x: { type: 'number', description: '图章 X 坐标 pt（缺省 36）。' },
      y: { type: 'number', description: '图章 Y 坐标 pt（缺省 36）。' },
      w: { type: 'number', description: '图章宽 pt（缺省按原图大小，超过 600pt 缩为 1/4）。' },
      h: { type: 'number', description: '图章高 pt（缺省按宽等比）。' },
      opacity: { type: 'number', description: '不透明度 0~1（默认 1）。' },
      rotate: { type: 'number', description: '旋转角度（0~359，缺省 0）。' },
    },
    description: '图章摆放参数（与 image 配合）。',
  },
  text: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', description: '签名人姓名。' },
      date: { type: 'string', description: '日期文本；省略或留空 = 今天（电脑本地日期）。' },
      reason: { type: 'string', description: '签名事由（显示在姓名括号内）。' },
      x: { type: 'number', description: '手写签名文本 X（缺省：笔迹下方 / 图章右侧 / 36）。' },
      y: { type: 'number', description: '手写签名文本 Y（pt）。' },
      size: { type: 'number', description: '字号 pt（默认 11）。' },
      color: { ...colorSchema, description: '文本颜色（默认 #123A8C）。' },
      font: {
        type: 'string',
        description: '字体名或 .ttf/.otf 路径（可传一个扫描的手写体 ttf 让名字更像亲笔）。',
      },
    },
    description: '签名文本（姓名/日期/事由），可同时设置多个字段。',
  },
  font: {
    type: 'string',
    description: '签名文本的全局字体（被 text.font 覆盖）。',
  },
}

export const pdf_studio_parameters = {
  file: {
    type: 'string',
    required: true,
    description: '要在右侧栏「浏览器」里打开的 PDF 文件路径（绝对路径；编辑器只读源文件，改动全部经「另存」生成新文件，绝不覆盖源文件）。',
  },
}

/** 工具定义裸表：schema-check 与 index.js 共用。 */
export const TOOL_PARAMETERS = {
  pdf_open: pdf_open_parameters,
  pdf_edit: pdf_edit_parameters,
  pdf_split: pdf_split_parameters,
  pdf_merge: pdf_merge_parameters,
  pdf_sign: pdf_sign_parameters,
  pdf_studio: pdf_studio_parameters,
}