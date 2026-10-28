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
  `Assumption correction (#${a.n}${a.topic ? ', ' + a.topic : ''}): you assumed "${a.text}", and that is wrong. ` +
  `It should be: ${a.fix}. Fix only that part and keep the rest.`
