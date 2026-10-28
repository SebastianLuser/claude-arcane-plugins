import { expect, test } from 'claude-code/testing'

import { addIdea, asIdeas, removeIdea, shelfKey } from './shelf'

test('adds, removes and keeps one shelf per project', async () => {
  const a = addIdea([], '  dark mode ', 1)
  expect(a.map(i => i.text)).toEqual(['dark mode'])
  expect(addIdea(a, '   ', 2)).toBe(a)
  const b = addIdea(a, 'navbar tests', 3)
  expect(removeIdea(b, a[0]!.id).map(i => i.text)).toEqual(['navbar tests'])
  expect(shelfKey('C:\\Users\\sebas\\Desktop\\3AM\\')).toBe(shelfKey('c:/users/sebas/desktop/3am'))
  expect(asIdeas([{ id: 'x', text: 'ok', at: 1 }, { nope: 1 }, null]).length).toBe(1)
})
