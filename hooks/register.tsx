import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Row, Seg } from '../types'
import { fit, rowsFromPatch } from './diff'
import type { Hunk } from './diff'

/** Terminal columns from which old and new are drawn side by side; inline below. */
const SPLIT_FROM = 120
/** Diff lines shown before "Show all"; a diff at most a few longer is shown whole. */
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

    const body: any[] = []
    if (split) {
      const sideW = Math.floor((width - 1) / 2)
      const textW = Math.max(4, sideW - digits - 1)
      const cell = (r: LineRow | undefined, side: 'o' | 'n') =>
        r
          ? [<Text dimColor>{num(side === 'o' ? r.o : r.n)} </Text>, ...paint(fit(r.s, textW), r.k)]
          : [<Text dimColor>{' '.repeat(digits)} </Text>, ...paint(fit([{ t: '' }], textW), 'blank')]
      const line = (l: LineRow | undefined, r: LineRow | undefined) => (
        <Text wrap="truncate-end">
          {cell(l, 'o')}
          <Text dimColor>│</Text>
          {cell(r, 'n')}
        </Text>
      )

      let i = 0
      while (i < rows.length) {
        const r = rows[i]!
        if (r.k === 'gap') {
          body.push(gapLine(r.skipped))
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
          body.push(gapLine(r.skipped))
          continue
        }
        const bg = r.k === 'd' ? 'diffRemoved' : r.k === 'a' ? 'diffAdded' : undefined
        body.push(
          <Text wrap="truncate-end">
            <Text dimColor>
              {num(r.o)} {num(r.n)}{' '}
            </Text>
            <Text backgroundColor={bg}>{r.k === 'd' ? '- ' : r.k === 'a' ? '+ ' : '  '}</Text>
            {paint(fit(r.s, textW), r.k)}
          </Text>,
        )
      }
    }

    const id = p.tool_use_id
    const isOpen = p.isExpanded === true || (await read($, expanded)).includes(id)
    const foldable = body.length > PREVIEW + SLACK
    const shown = foldable && !isOpen ? body.slice(0, PREVIEW) : body
    const hidden = body.length - shown.length

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
