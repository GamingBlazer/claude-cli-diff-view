import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Row, Seg } from '../types'
import { rowsFromPatch, wrap } from './diff'
import type { Hunk } from './diff'

/** Terminal columns from which old and new are drawn side by side; inline below. */
const SPLIT_FROM = 120
/** Screen lines shown before "Show all"; a diff at most a few longer is shown whole. */
const PREVIEW = 12
const SLACK = 3

const expanded = atom({ plugin: 'diff-view', key: 'expanded' } as const, [] as string[])

/** The fields of Claude Code's Edit and Write results this mod reads. */
type PatchOutput = { structuredPatch?: Hunk[]; type?: string; staged?: boolean }

type LineRow = Extract<Row, { k: 'c' | 'd' | 'a' }>

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export const register: Register = on => {
  // The diff under an Edit or Write row: side by side when wide, inline when narrow, folded to a preview.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const p = e.props
    if ((p.tool !== 'Edit' && p.tool !== 'Write') || p.isErrored || e.surface !== 'terminal') return next(e)
    const out = p.output as PatchOutput | undefined
    const hunks = out?.structuredPatch
    if (!hunks || hunks.length === 0 || out?.type === 'create' || out?.staged) return next(e)

    const cols = e.viewport?.columns ?? 0
    if (cols < 40) return next(e)

    const { rows, added, removed, clipped } = rowsFromPatch(hunks)
    // Pure additions have nothing on the left: inline reads better.
    const split = removed > 0 && cols >= SPLIT_FROM

    const { Box, Text, Button } = $.ui.resolve(e)
    const width = cols - 1
    const digits = String(
      rows.reduce((max, r) => (r.k === 'gap' ? max : Math.max(max, r.o ?? 0, r.n ?? 0)), 1),
    ).length
    const num = (n?: number) => (n === undefined ? ' '.repeat(digits) : String(n).padStart(digits))

    const paint = (segs: Seg[], kind: 'c' | 'd' | 'a' | 'blank') => {
      const bg = kind === 'd' ? 'diffRemoved' : kind === 'a' ? 'diffAdded' : undefined
      const word = kind === 'd' ? 'diffRemovedWord' : 'diffAddedWord'

      return segs.map(s =>
        s.hl && bg ? (
          <Text backgroundColor={word}>{s.t}</Text>
        ) : bg ? (
          <Text backgroundColor={bg}>{s.t}</Text>
        ) : (
          <Text dimColor={kind === 'blank'}>{s.t}</Text>
        ),
      )
    }

    const gapLine = (skipped: number) => (
      <Text dimColor wrap="truncate-end">
        {' '.repeat(digits)} ⋯ {plural(skipped, 'unchanged line')}
      </Text>
    )

    // One entry per diff line: the screen lines it wraps to.
    const body: any[][] = []
    if (split) {
      const sideW = Math.floor((width - 1) / 2)
      const textW = Math.max(4, sideW - digits - 1)
      const blank = (kind: 'c' | 'd' | 'a' | 'blank') => paint([{ t: ' '.repeat(textW) }], kind)
      const line = (l: LineRow | undefined, r: LineRow | undefined) => {
        const left = l ? wrap(l.s, textW) : []
        const right = r ? wrap(r.s, textW) : []
        const cell = (row: LineRow | undefined, wrapped: Seg[][], side: 'o' | 'n', q: number) => [
          <Text dimColor>{q === 0 && row ? num(side === 'o' ? row.o : row.n) : ' '.repeat(digits)} </Text>,
          ...(q < wrapped.length ? paint(wrapped[q]!, row!.k) : blank(row ? row.k : 'blank')),
        ]

        return Array.from({ length: Math.max(1, left.length, right.length) }, (_, q) => (
          <Text wrap="truncate-end">
            {cell(l, left, 'o', q)}
            <Text dimColor>│</Text>
            {cell(r, right, 'n', q)}
          </Text>
        ))
      }

      let i = 0
      while (i < rows.length) {
        const r = rows[i]!
        if (r.k === 'gap') {
          body.push([gapLine(r.skipped)])
          i++
        } else if (r.k === 'c') {
          body.push(line(r, r))
          i++
        } else {
          const dels: LineRow[] = []
          const adds: LineRow[] = []
          while (i < rows.length && rows[i]!.k === 'd') dels.push(rows[i++] as LineRow)
          while (i < rows.length && rows[i]!.k === 'a') adds.push(rows[i++] as LineRow)
          for (let q = 0; q < Math.max(dels.length, adds.length); q++) body.push(line(dels[q], adds[q]))
        }
      }
    } else {
      const textW = Math.max(4, width - (digits * 2 + 4))
      for (const r of rows) {
        if (r.k === 'gap') {
          body.push([gapLine(r.skipped)])
          continue
        }
        const bg = r.k === 'd' ? 'diffRemoved' : r.k === 'a' ? 'diffAdded' : undefined
        const sign = r.k === 'd' ? '- ' : r.k === 'a' ? '+ ' : '  '
        body.push(
          wrap(r.s, textW).map((segs, q) => (
            <Text wrap="truncate-end">
              <Text dimColor>{q === 0 ? `${num(r.o)} ${num(r.n)} ` : ' '.repeat(digits * 2 + 2)}</Text>
              <Text backgroundColor={bg}>{q === 0 ? sign : '  '}</Text>
              {paint(segs, r.k)}
            </Text>
          )),
        )
      }
    }

    const id = p.tool_use_id
    const isOpen = p.isExpanded === true || (await read($, expanded)).includes(id)
    // Fold by screen lines, so a few long wrapped lines also fold; never cut a diff line in half.
    const height = body.reduce((n, b) => n + b.length, 0)
    const foldable = height > PREVIEW + SLACK
    let take = body.length
    if (foldable && !isOpen) {
      let used = 0
      take = 0
      while (take < body.length && (take === 0 || used + body[take]!.length <= PREVIEW)) used += body[take++]!.length
    }
    const shown = body.slice(0, take).flat()
    const hidden = body.length - take

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          Added {plural(added, 'line')}, removed {plural(removed, 'line')}
        </Text>
        {shown}
        {clipped > 0 && isOpen && <Text dimColor>… {plural(clipped, 'more row')} not shown</Text>}
        {foldable && !isOpen && (
          <Box flexDirection="row" gap={2} marginTop={1}>
            <Button
              key="show-all"
              variant="primary"
              label={`▸ Show all ${body.length} lines`}
              onPress={() => update($, expanded, ids => [...ids.filter(x => x !== id), id].slice(-200))}
            />
            <Text dimColor>{plural(hidden, 'more line')} hidden · click to expand</Text>
          </Box>
        )}
        {foldable && isOpen && p.isExpanded !== true && (
          <Box flexDirection="row" gap={2} marginTop={1}>
            <Button
              key="collapse"
              variant="primary"
              label="▾ Collapse"
              onPress={() => update($, expanded, ids => ids.filter(x => x !== id))}
            />
            <Text dimColor>showing all {body.length} lines</Text>
          </Box>
        )}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
