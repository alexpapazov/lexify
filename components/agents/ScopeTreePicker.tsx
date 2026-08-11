'use client'

/**
 * components/agents/ScopeTreePicker.tsx — "which part of my library may this agent touch".
 *
 * Extracted from the card-editor page so every agent picks scope the same way; the tree itself comes
 * from `lib/scopeTree.ts`, which the practice-mode picker also uses. Pairs and folders expand and
 * select all their descendants at once; decks are leaves.
 *
 * Selection state lives with the CALLER (a `Set<string>` of deck ids) — the picker is presentational
 * so a page can drive it from a URL, a preset, or its own reducer.
 */

import type { DeckNode, FolderNode, PairNode } from '@/lib/scopeTree'
import { langFlag } from '@/lib/languages'

export function ScopeTreePicker({ tree, selState, expanded, onToggleSel, onToggleExpand }: {
  tree: PairNode[]
  selState: (ids: string[]) => 'none' | 'some' | 'all'
  expanded: Set<string>
  onToggleSel: (ids: string[]) => void
  onToggleExpand: (id: string) => void
}) {
  return (
    <div className="border border-line/10 rounded-lg max-h-72 overflow-y-auto py-1">
      {tree.length === 0 && <p className="px-3 py-3 text-sm text-ink-faint">No decks yet.</p>}
      {tree.map(pair => (
        <ScopeRow key={pair.key} node={pair} depth={0}
          selState={selState} expanded={expanded} onToggleSel={onToggleSel} onToggleExpand={onToggleExpand} />
      ))}
    </div>
  )
}

export function TriCheckbox({ state, onChange }: { state: 'none' | 'some' | 'all'; onChange: () => void }) {
  return (
    <input
      type="checkbox"
      className="accent-accent shrink-0"
      checked={state === 'all'}
      ref={el => { if (el) el.indeterminate = state === 'some' }}
      onChange={onChange}
      onClick={e => e.stopPropagation()}
    />
  )
}

function ScopeRow({ node, depth, selState, expanded, onToggleSel, onToggleExpand }: {
  node: PairNode | FolderNode | DeckNode
  depth: number
  selState: (ids: string[]) => 'none' | 'some' | 'all'
  expanded: Set<string>
  onToggleSel: (ids: string[]) => void
  onToggleExpand: (id: string) => void
}) {
  const pad = { paddingLeft: `${8 + depth * 16}px` }
  if (node.kind === 'deck') {
    return (
      <label className="flex items-center gap-2 pr-3 py-1.5 cursor-pointer hover:bg-surface/40" style={pad}>
        <span className="w-3.5 shrink-0" />
        <TriCheckbox state={selState([node.id])} onChange={() => onToggleSel([node.id])} />
        <span className="text-sm text-ink truncate">📄 {node.name}</span>
      </label>
    )
  }
  const id = node.kind === 'pair' ? `pair:${node.key}` : node.id
  const open = expanded.has(id)
  return (
    <>
      <div className="flex items-center gap-2 pr-3 py-1.5 hover:bg-surface/40" style={pad}>
        <button type="button" onClick={() => onToggleExpand(id)} className="w-3.5 shrink-0 text-ink-faint hover:text-ink text-xs">{open ? '▾' : '▸'}</button>
        <TriCheckbox state={selState(node.deckIds)} onChange={() => onToggleSel(node.deckIds)} />
        <div className="cursor-pointer min-w-0 flex-1" onClick={() => onToggleExpand(id)}>
          {node.kind === 'pair'
            ? <span className="text-sm text-ink font-medium">{langFlag(node.source)} {node.source} → {node.target}</span>
            : <span className="text-sm text-ink truncate">📁 {node.name}</span>}
        </div>
      </div>
      {open && node.children.map(c => (
        <ScopeRow key={c.kind === 'deck' ? `d:${c.id}` : `f:${c.id}`} node={c} depth={depth + 1}
          selState={selState} expanded={expanded} onToggleSel={onToggleSel} onToggleExpand={onToggleExpand} />
      ))}
    </>
  )
}
