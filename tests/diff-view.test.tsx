import { expect, test } from 'claude-code/testing'

import { fit, rowsFromPatch } from '../hooks/diff'

const PATCH = [
  {
    oldStart: 1,
    oldLines: 5,
    newStart: 1,
    newLines: 6,
    lines: [
      ' // demo',
      '-export function total(price: number, qty: number): number {',
      '-  return price * qty',
      '+export function total(price: number, quantity: number, taxRate = 0.18): number {',
      '+  const subtotal = price * quantity',
      '+  return subtotal * (1 + taxRate)',
      ' }',
    ],
  },
  { oldStart: 20, oldLines: 1, newStart: 21, newLines: 1, lines: ['-const a = 1', '+const a = 2'] },
]

/** One hunk replacing 30 lines: 30 side-by-side rows, 60 inline. */
const LONG = [
  {
    oldStart: 1,
    oldLines: 30,
    newStart: 1,
    newLines: 30,
    lines: [
      ...Array.from({ length: 30 }, (_, i) => `-const v${i + 1} = ${i}`),
      ...Array.from({ length: 30 }, (_, i) => `+const v${i + 1} = ${i * 2}`),
    ],
  },
]

const row = (columns: number, output: unknown, tool = 'Edit', surface: 'terminal' | 'desktop' = 'terminal') =>
  ({
    plugin: 'diff-view',
    component: 'ToolResult',
    requestId: 'toolu_1',
    surface,
    viewport: { columns, rows: 40 },
    props: { tool_use_id: 'toolu_1', tool, output, isErrored: false },
  }) as const

const engineDraws = (on: any) =>
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine diff</Text>
  })

const has = async (ui: any, text: RegExp) => (await ui.find({ type: 'Text', text })) !== undefined

test('rows from a patch: pairs, word marks, numbers and a gap between hunks', async () => {
  const { rows, added, removed } = rowsFromPatch(PATCH)
  expect(added).toBe(4)
  expect(removed).toBe(3)
  const firstAdd = rows.find(r => r.k === 'a')
  const marked = firstAdd && firstAdd.k === 'a' ? firstAdd.s.filter(s => s.hl).map(s => s.t).join('') : ''
  expect(marked).toBe('quantity, taxRate = 0.18')
  const gap = rows.find(r => r.k === 'gap')
  expect(gap && gap.k === 'gap' ? gap.skipped : 0).toBe(14)
  const last = rows[rows.length - 1]
  expect(last && last.k === 'a' ? last.n : 0).toBe(21)
  expect(fit([{ t: 'abcdef' }], 4).map(s => s.t).join('')).toBe('abc…')
})

test('wide: side by side in place of the engine diff; narrow: our own inline rows', async ($, on) => {
  engineDraws(on)
  let ui = await $.ui.mount(row(160, { structuredPatch: PATCH }))
  expect(await has(ui, /engine diff/)).toBe(false)
  expect(await has(ui, /^Added 4 lines, removed 3 lines$/)).toBe(true)
  expect(await has(ui, /price \* qty.*│.*const subtotal = price \* quantity/)).toBe(true)
  expect(await has(ui, /⋯ 14 unchanged lines/)).toBe(true)
  await ui.unmount()

  ui = await $.ui.mount(row(80, { structuredPatch: PATCH }))
  expect(await has(ui, /engine diff/)).toBe(false)
  expect(await has(ui, /│/)).toBe(false)
  expect(await has(ui, /^ ?2 +- export function total\(price: number, qty/)).toBe(true)
  await ui.unmount()
})

test('a long diff shows a preview, expands on Show all, folds on Collapse', async ($, on) => {
  engineDraws(on)
  const ui = await $.ui.mount(row(160, { structuredPatch: LONG }))
  expect(await has(ui, /v12 = 11.*│/)).toBe(true)
  expect(await has(ui, /v13 = 12.*│/)).toBe(false)
  expect((await ui.find({ type: 'Button', text: /Show all 30 lines/ })) !== undefined).toBe(true)
  expect(await has(ui, /18 more lines hidden/)).toBe(true)

  await ui.press({ key: 'show-all' })
  expect(await has(ui, /v30 = 29.*│/)).toBe(true)
  await ui.press({ key: 'collapse' })
  expect(await has(ui, /v30 = 29.*│/)).toBe(false)
  await ui.unmount()
})

test('ctrl+o (expanded transcript) shows every row with no button', async ($, on) => {
  engineDraws(on)
  const target = row(160, { structuredPatch: LONG })
  const ui = await $.ui.mount({ ...target, props: { ...target.props, isExpanded: true } })
  expect(await has(ui, /v30 = 29.*│/)).toBe(true)
  expect((await ui.find({ type: 'Button' })) === undefined).toBe(true)
  await ui.unmount()
})

test('a new file, other tools and other surfaces keep the engine diff', async ($, on) => {
  engineDraws(on)
  const cases = [
    row(160, { type: 'create', structuredPatch: [] }, 'Write'),
    row(160, { stdout: 'x' }, 'Bash'),
    row(160, { structuredPatch: PATCH }, 'Edit', 'desktop'),
  ]
  for (const c of cases) {
    const ui = await $.ui.mount(c)
    expect(await has(ui, /engine diff/)).toBe(true)
    await ui.unmount()
  }
})
