/** A run of text in a diff row; `hl` marks the words that changed. */
export type Seg = { t: string; hl?: true }

/** One diff row: context, deleted, added, or a gap of unchanged lines. */
export type Row =
  | { k: 'c' | 'd' | 'a'; o?: number; n?: number; s: Seg[] }
  | { k: 'gap'; skipped: number }

declare module 'claude-code' {
  interface PluginState {
    'diff-view': {
      /** tool_use_ids whose diff the person expanded. */
      expanded: string[]
    }
  }
}
