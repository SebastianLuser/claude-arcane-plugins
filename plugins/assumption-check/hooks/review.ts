import type { Assumption, Verdict } from '../types'

export const addAssumption = (list: Assumption[], text: string, topic: string): Assumption[] => {
  const clean = text.trim()
  if (!clean) return list
  return [...list, { n: list.length + 1, text: clean, topic: topic.trim(), verdict: 'pending', fix: '' }]
}

export const setVerdict = (list: Assumption[], n: number, verdict: Verdict, fix = ''): Assumption[] =>
  list.map(a => (a.n === n ? { ...a, verdict, fix: fix.trim() } : a))

export const pending = (list: Assumption[]): Assumption[] => list.filter(a => a.verdict === 'pending')

// What Claude reads when one is marked wrong.
export const correction = (a: Assumption): string =>
  `Corrección de un supuesto (#${a.n}${a.topic ? ', ' + a.topic : ''}): asumiste "${a.text}", y es incorrecto. ` +
  `Lo correcto: ${a.fix}. Corregí solo esa parte y mantené lo demás.`
