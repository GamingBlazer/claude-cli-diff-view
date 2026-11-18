import type { Row, Seg } from '../types'

const MAX_ROWS = 800
const MAX_TOKEN_CELLS = 40_000

/** A hunk as Claude Code's Edit and Write results carry it (`structuredPatch`). */
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

const clean = (s: string): string => s.replace(/\r$/, '').replace(/\t/g, '    ')

const tokenize = (s: string): string[] => s.match(/\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/gu) ?? []

const merge = (parts: Seg[]): Seg[] => {
  const out: Seg[] = []
  for (const p of parts) {
    const last = out[out.length - 1]
    if (last && !!last.hl === !!p.hl) last.t += p.t
    else out.push(p.hl ? { t: p.t, hl: true } : { t: p.t })
  }
  return out
}

/** Word-level segments for a removed line and the added line paired with it. */
export const wordDiff = (oldLine: string, newLine: string): [Seg[], Seg[]] => {
  const x = tokenize(oldLine)
  const y = tokenize(newLine)
  const plain: [Seg[], Seg[]] = [[{ t: oldLine }], [{ t: newLine }]]
  if (x.length === 0 || y.length === 0 || (x.length + 1) * (y.length + 1) > MAX_TOKEN_CELLS) return plain

  const w = y.length + 1
  const L = new Int32Array((x.length + 1) * w)
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      L[i * w + j] = x[i]! === y[j]! ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!)
    }
  }

  const left: Seg[] = []
  const right: Seg[] = []
  let shared = 0
  let i = 0
  let j = 0
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i]! === y[j]!) {
      if (/\S/.test(x[i]!)) shared += x[i]!.length
      left.push({ t: x[i++]! })
      right.push({ t: y[j++]! })
    } else if (i < x.length && (j >= y.length || L[(i + 1) * w + j]! >= L[i * w + j + 1]!)) {
      left.push({ t: x[i++]!, hl: true })
    } else {
      right.push({ t: y[j++]!, hl: true })
    }
  }

  // Lines with almost nothing in common read better without word marks.
  const size = Math.max(oldLine.replace(/\s/g, '').length, newLine.replace(/\s/g, '').length)
  if (size === 0 || shared / size < 0.25) return plain

  return [merge(left), merge(right)]
}

/** Display rows from a structured patch: context, paired deletes and adds with word marks, gaps between hunks. */
export const rowsFromPatch = (hunks: readonly Hunk[]): { rows: Row[]; added: number; removed: number; clipped: number } => {
  const rows: Row[] = []
  let added = 0
  let removed = 0
  let prevEnd = -1

  for (const h of hunks) {
    if (prevEnd >= 0 && h.oldStart > prevEnd) rows.push({ k: 'gap', skipped: h.oldStart - prevEnd })
    prevEnd = h.oldStart + h.oldLines
    let o = h.oldStart
    let n = h.newStart
    const lines = h.lines
    let i = 0
    while (i < lines.length) {
      const line = lines[i]!
      const mark = line[0]
      if (mark === '-' || mark === '+') {
        const dels: { o: number; t: string }[] = []
        const adds: { n: number; t: string }[] = []
        while (i < lines.length && (lines[i]![0] === '-' || lines[i]![0] === '\\')) {
          if (lines[i]![0] === '-') dels.push({ o: o++, t: clean(lines[i]!.slice(1)) })
          i++
        }
        while (i < lines.length && (lines[i]![0] === '+' || lines[i]![0] === '\\')) {
          if (lines[i]![0] === '+') adds.push({ n: n++, t: clean(lines[i]!.slice(1)) })
          i++
        }
        removed += dels.length
        added += adds.length
        const pairs = Math.min(dels.length, adds.length)
        const words = Array.from({ length: pairs }, (_, p) => wordDiff(dels[p]!.t, adds[p]!.t))
        dels.forEach((d, p) => rows.push({ k: 'd', o: d.o, s: p < pairs ? words[p]![0] : [{ t: d.t }] }))
        adds.forEach((a, p) => rows.push({ k: 'a', n: a.n, s: p < pairs ? words[p]![1] : [{ t: a.t }] }))
      } else if (mark === '\\') {
        i++
      } else {
        rows.push({ k: 'c', o: o++, n: n++, s: [{ t: clean(line.slice(1)) }] })
        i++
      }
    }
  }

  const clipped = Math.max(0, rows.length - MAX_ROWS)

  return { rows: clipped ? rows.slice(0, MAX_ROWS) : rows, added, removed, clipped }
}

/** Most screen lines one diff line wraps to; the last one ends in an ellipsis when cut. */
const MAX_WRAP = 40

/** The first `n` cells of segments, no padding. */
const cut = (segs: Seg[], n: number): Seg[] => {
  const out: Seg[] = []
  let left = n
  for (const s of segs) {
    if (left <= 0) break
    const chars = Array.from(s.t)
    out.push({ ...s, t: chars.slice(0, left).join('') })
    left -= chars.length
  }

  return out
}

/**
 * Segments word-wrapped to lines of `width` cells, each padded with spaces. Breaks at spaces,
 * splits words longer than a line, and drops the space a line breaks at. Word marks carry over.
 */
export const wrap = (segs: Seg[], width: number): Seg[][] => {
  const w = Math.max(2, width)
  const lines: Seg[][] = []
  let line: Seg[] = []
  let used = 0
  const push = (t: string, hl?: true) => {
    const last = line[line.length - 1]
    if (last && !!last.hl === !!hl) last.t += t
    else line.push(hl ? { t, hl } : { t })
    used += Array.from(t).length
  }
  const breakLine = () => {
    lines.push(line)
    line = []
    used = 0
  }

  // Words and runs of spaces; a word can span segments (a marked part next to an unmarked one).
  const words: { space: boolean; n: number; parts: Seg[] }[] = []
  for (const s of segs) {
    for (const t of s.t.match(/\s+|\S+/gu) ?? []) {
      const space = /^\s/.test(t)
      const part: Seg = s.hl ? { t, hl: true } : { t }
      const last = words[words.length - 1]
      if (last && last.space === space) last.parts.push(part)
      else words.push({ space, n: 0, parts: [part] })
      words[words.length - 1]!.n += Array.from(t).length
    }
  }

  for (const word of words) {
    if (word.space) {
      // A space that would end a line is where it breaks; a continuation line never starts with one.
      if (used + word.n > w) {
        if (used > 0) breakLine()
      } else if (used > 0 || lines.length === 0) {
        for (const p of word.parts) push(p.t, p.hl)
      }
      continue
    }
    if (used > 0 && used + word.n > w && word.n <= w) breakLine()
    for (const p of word.parts) {
      let chars = Array.from(p.t)
      while (chars.length > 0) {
        if (used === w) breakLine()
        const room = w - used
        push(chars.slice(0, room).join(''), p.hl)
        chars = chars.slice(room)
      }
    }
  }
  if (line.length > 0 || lines.length === 0) lines.push(line)

  if (lines.length > MAX_WRAP) {
    lines.length = MAX_WRAP
    lines[MAX_WRAP - 1] = [...cut(lines[MAX_WRAP - 1]!, w - 1), { t: '…' }]
  }

  return lines.map(l => {
    const used = l.reduce((n, s) => n + Array.from(s.t).length, 0)

    return used < w ? [...l, { t: ' '.repeat(w - used) }] : l
  })
}

/** Segments cut to `width` cells (an ellipsis where cut) and padded with spaces. */
export const fit = (segs: Seg[], width: number): Seg[] => {
  const out: Seg[] = []
  let used = 0
  for (const s of segs) {
    const chars = Array.from(s.t)
    if (used + chars.length > width) {
      const room = Math.max(0, width - used - 1)
      if (room > 0) out.push({ ...s, t: chars.slice(0, room).join('') })
      if (width - used >= 1) out.push({ t: '…' })
      return out
    }
    out.push(s)
    used += chars.length
  }
  if (used < width) out.push({ t: ' '.repeat(width - used) })

  return out
}
