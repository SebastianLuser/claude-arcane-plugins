// The instruction the model gets to turn a rough prompt into a complete one.
export const enhanceAsk = (draft: string): string =>
  [
    'Rewrite the rough prompt below into a complete prompt the person will send to you (Claude Code) in this project.',
    'Use what you know of this project: its instructions (CLAUDE.md), its files and the skills and commands installed here.',
    'Write it in the same language as the rough prompt, in this shape:',
    '1. One or two sentences stating the goal clearly.',
    '2. Which installed skills or slash commands to use, by their exact /name, and what each is for. Name only ones that exist here.',
    '3. "Before writing any code, confirm with me:" followed by a bullet list of the big choices that are the person\'s to make.',
    '4. "Scope:" one line of what is in and out.',
    '5. "Done looks like:" a bullet list of how the finished result is checked.',
    'Do not invent requirements the person did not imply. Answer with the rewritten prompt only, no preamble, no code fences.',
    '',
    'Rough prompt:',
    draft,
  ].join('\n')

// A reply sometimes comes wrapped in a fence or with a lead-in line; keep the prompt itself.
export const cleanReply = (text: string): string =>
  text
    .trim()
    .replace(/^```[a-z]*\n([\s\S]*?)\n```$/i, '$1')
    .trim()
