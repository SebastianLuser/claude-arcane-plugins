import { expect, test } from 'claude-code/testing'

import { addIdea, asIdeas, removeIdea, shelfKey } from './shelf'

test('agrega, borra y separa por proyecto', async () => {
  const a = addIdea([], '  modo oscuro ', 1)
  expect(a.map(i => i.text)).toEqual(['modo oscuro'])
  expect(addIdea(a, '   ', 2)).toBe(a)
  const b = addIdea(a, 'tests del navbar', 3)
  expect(removeIdea(b, a[0]!.id).map(i => i.text)).toEqual(['tests del navbar'])
  expect(shelfKey('C:\\Users\\sebas\\Desktop\\3AM\\')).toBe(shelfKey('c:/users/sebas/desktop/3am'))
  expect(asIdeas([{ id: 'x', text: 'ok', at: 1 }, { nope: 1 }, null]).length).toBe(1)
})
