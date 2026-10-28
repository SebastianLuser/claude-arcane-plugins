import { expect, test } from 'claude-code/testing'

import { addAssumption, correction, pending, setVerdict } from './review'

test('logs, marks and builds the correction', async () => {
  let list = addAssumption([], 'Fixed categories', 'categories')
  list = addAssumption(list, '  ', 'x')
  list = addAssumption(list, 'Sample data on first run', 'initial state')
  expect(list.map(a => a.n)).toEqual([1, 2])
  list = setVerdict(list, 1, 'wrong', ' make them editable ')
  list = setVerdict(list, 2, 'right')
  expect(pending(list).length).toBe(0)
  expect(correction(list[0]!)).toContain('It should be: make them editable.')
})
