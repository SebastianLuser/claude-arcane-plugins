import { expect, test } from 'claude-code/testing'

import { cleanReply, enhanceAsk } from './ask'

test('builds the ask and cleans the reply', async () => {
  const ask = enhanceAsk('add a login')
  expect(ask).toContain('Before writing any code, confirm with me:')
  expect(ask.endsWith('add a login')).toBe(true)
  expect(cleanReply('```markdown\nBuild the login.\n```')).toBe('Build the login.')
  expect(cleanReply('  Build the login.  ')).toBe('Build the login.')
})
