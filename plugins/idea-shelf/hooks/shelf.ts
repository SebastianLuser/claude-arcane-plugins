import type { Idea } from '../types'

// One shelf per project folder: the store key is the folder, lowercased on Windows paths.
export const shelfKey = (cwd: string): string => 'ideas:' + cwd.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()

export const addIdea = (ideas: Idea[], text: string, at: number): Idea[] => {
  const clean = text.trim()
  if (!clean) return ideas
  return [...ideas, { id: `${at}-${ideas.length}`, text: clean, at }]
}

export const removeIdea = (ideas: Idea[], id: string): Idea[] => ideas.filter(i => i.id !== id)

export const asIdeas = (v: unknown): Idea[] =>
  Array.isArray(v) ? v.filter((i): i is Idea => !!i && typeof i.id === 'string' && typeof i.text === 'string' && typeof i.at === 'number') : []
