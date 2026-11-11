// Renders assets/preview.html, the README's picture of the view, with the mod's own diff code.
// Run: node tools/preview.mjs, then screenshot it at 2x with headless Edge or Chrome:
//   msedge --headless=new --hide-scrollbars --force-device-scale-factor=2 --window-size=1240,360 \n//     --screenshot=assets/preview.png file:///<repo>/assets/preview.html
// and delete assets/preview.html.
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fit, rowsFromPatch } from '../hooks/diff.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// A sample edit, as Claude Code's Edit result carries it.
const PATCH = [
  {
    oldStart: 1, oldLines: 8, newStart: 1, newLines: 9,
    lines: [
      "-import { Item } from './types'",
      "+import { Item, TAX_RATE } from './types'",
      ' ',
      '-export function total(items: Item[]): number {',
      '+export function total(items: Item[], coupon?: string): number {',
      '   let sum = 0',
      '-  for (const item of items) sum += item.price * item.qty',
      '-  return sum',
      '+  for (const item of items) sum += item.price * item.quantity',
      "+  const discount = coupon === 'SAVE10' ? 0.1 : 0",
      '+  return sum * (1 - discount) * (1 + TAX_RATE)',
      ' }',
      ' ',
    ],
  },
  {
    oldStart: 24, oldLines: 3, newStart: 25, newLines: 3,
    lines: [
      ' export function label(item: Item): string {',
      '-  return `${item.name} x${item.qty}`',
      '+  return `${item.name} × ${item.quantity}`',
      ' }',
    ],
  },
  {
    oldStart: 40, oldLines: 4, newStart: 41, newLines: 5,
    lines: [' export const SHIPPING = {', '-  standard: 4.99,', '-  express: 9.99,', '+  standard: 0,', '+  express: 7.99,', '+  overnight: 19.99,', ' }'],
  },
]

const COLS = 132
const PREVIEW = 12
// Claude Code's dark theme.
const C = {
  bg: '#0c0c0c', text: '#e6e6e6', dim: '#8a8a8a',
  added: 'rgb(34,92,43)', removed: 'rgb(122,41,54)',
  addedWord: 'rgb(56,166,96)', removedWord: 'rgb(179,89,107)',
  accent: 'rgb(177,185,249)', tool: 'rgb(255,193,7)', plus: 'rgb(78,186,101)', minus: 'rgb(255,107,128)',
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const span = (t, style = '') => (style ? `<span style="${style}">${esc(t)}</span>` : esc(t))

const { rows, added, removed } = rowsFromPatch(PATCH)
const digits = String(rows.reduce((m, r) => (r.k === 'gap' ? m : Math.max(m, r.o ?? 0, r.n ?? 0)), 1)).length
const width = COLS - 1
const sideW = Math.floor((width - 1) / 2)
const textW = sideW - digits - 1
const num = n => (n === undefined ? ' '.repeat(digits) : String(n).padStart(digits))

const paint = (segs, kind) => {
  const bg = kind === 'd' ? C.removed : kind === 'a' ? C.added : null
  const word = kind === 'd' ? C.removedWord : C.addedWord
  return segs.map(s => (s.hl && bg ? span(s.t, `background:${word}`) : bg ? span(s.t, `background:${bg}`) : span(s.t))).join('')
}
const cell = (r, side) =>
  r
    ? span(`${num(side === 'o' ? r.o : r.n)} `, `color:${C.dim}`) + paint(fit(r.s, textW), r.k)
    : span(`${' '.repeat(digits)} `, `color:${C.dim}`) + paint(fit([{ t: '' }], textW), 'blank')
const line = (l, r) => cell(l, 'o') + span('│', `color:${C.dim}`) + cell(r, 'n')

const body = []
for (let i = 0; i < rows.length; ) {
  const r = rows[i]
  if (r.k === 'gap') {
    body.push(span(`${' '.repeat(digits)} ⋯ ${r.skipped} unchanged lines`, `color:${C.dim}`))
    i++
  } else if (r.k === 'c') {
    body.push(line(r, r))
    i++
  } else {
    const dels = []
    const adds = []
    while (i < rows.length && rows[i].k === 'd') dels.push(rows[i++])
    while (i < rows.length && rows[i].k === 'a') adds.push(rows[i++])
    for (let q = 0; q < Math.max(dels.length, adds.length); q++) body.push(line(dels[q], adds[q]))
  }
}

const shown = body.slice(0, PREVIEW)
const hidden = body.length - shown.length
const title = '● ' + span('Edit', `color:${C.tool}`) + '  src/cart.ts'
const counts = span(`+${added}`, `color:${C.plus}`) + ' ' + span(`-${removed}`, `color:${C.minus}`)
const pad = COLS - 'X Edit  src/cart.ts'.length - `+${added} -${removed}`.length

const lines = [
  title + ' '.repeat(pad) + counts,
  `Added ${added} lines, removed ${removed} lines`,
  ...shown,
  '',
  span(`[ ▸ Show all ${body.length} lines ]`, `color:${C.accent};font-weight:600`) + '  ' + span(`${hidden} more lines hidden · click to expand`, `color:${C.dim}`),
]

const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:${C.bg}}
pre{margin:0;padding:18px 22px;color:${C.text};font:15px/1.32 'Cascadia Mono',Consolas,monospace;white-space:pre;display:inline-block}
</style><pre>${lines.join('\n')}</pre>`

mkdirSync(join(root, 'assets'), { recursive: true })
writeFileSync(join(root, 'assets', 'preview.html'), html)
console.log(`rows ${body.length}, shown ${shown.length}, +${added} -${removed}, ${COLS} cols`)
