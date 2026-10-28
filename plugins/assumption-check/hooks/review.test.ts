import { expect, test } from 'claude-code/testing'

import { addAssumption, correction, pending, setVerdict } from './review'

test('anota, marca y arma la corrección', async () => {
  let list = addAssumption([], 'Categorías fijas', 'categorías')
  list = addAssumption(list, '  ', 'x')
  list = addAssumption(list, 'Datos de ejemplo al inicio', 'estado inicial')
  expect(list.map(a => a.n)).toEqual([1, 2])
  list = setVerdict(list, 1, 'wrong', ' que sean editables ')
  list = setVerdict(list, 2, 'right')
  expect(pending(list).length).toBe(0)
  expect(correction(list[0]!)).toContain('Lo correcto: que sean editables.')
})
