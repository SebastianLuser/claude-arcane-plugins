import { describe, expect, test } from 'claude-code/testing'

import type { FileNode } from '../types'
import { hereOf } from './register'
import { changedRows } from './tree'

const PANE = {
  plugin: 'file-tree',
  component: 'Pane',
  requestId: 'file-tree',
  props: { title: 'Files', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const node = (id: string, kind: FileNode['kind'] = 'file'): FileNode => ({
  id,
  parent: id.slice(0, id.lastIndexOf('/')),
  name: id.split('/').pop() ?? id,
  kind,
  hidden: false,
  mtime: 0,
  size: 0,
  loaded: true,
})

describe('changes view', () => {
  test("lists the changed files flat by path, Claude's edits first, and names each group's first row", () => {
    const files = { '/r/src/b.ts': 'mod', '/r/src/a.ts': 'new', '/r/README.md': 'mod', '/r/.env.example': 'mod', '/elsewhere/x.ts': 'mod' }
    const view = changedRows({ root: '/r', nodes: [], showHidden: false }, files, new Set(['/r/src/b.ts']))

    expect(view.rows.map(r => r.node.name)).toEqual(['src/b.ts', 'README.md', 'src/a.ts'])
    expect(view.rows.every(r => r.depth === 0 && r.node.kind === 'file')).toBe(true)
    expect(view.firstClaude).toBe('/r/src/b.ts')
    expect(view.firstOther).toBe('/r/README.md')
  })

  test('shows hidden files only when the tree does, and no group heading when Claude edited nothing', () => {
    const files = { '/r/.env.example': 'mod', '/r/a.ts': 'mod' }
    const view = changedRows({ root: '/r', nodes: [], showHidden: true }, files, new Set())

    expect(view.rows.map(r => r.node.name)).toEqual(['.env.example', 'a.ts'])
    expect(view.firstClaude).toBe('')
    expect(view.firstOther).toBe('')
  })
})

describe('work here', () => {
  test('acts on the folder under the cursor, a file\'s own folder, else the root', () => {
    const nodes = [node('/r/api', 'dir'), node('/r/api/main.go')]

    expect(hereOf({ root: '/r', nodes, cursor: '/r/api', selected: '' })).toBe('/r/api')
    expect(hereOf({ root: '/r', nodes, cursor: '/r/api/main.go', selected: '' })).toBe('/r/api')
    expect(hereOf({ root: '/r', nodes, cursor: '', selected: '' })).toBe('/r')
  })

  test('the header has its button on every surface', async ($, on) => {
    on('clock.now', () => ({ value: 0 }))
    on('env.get', () => ({ value: undefined }))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ key: 'button-here' })).toBeTruthy()
      await ui.unmount()
    }
  })
})
