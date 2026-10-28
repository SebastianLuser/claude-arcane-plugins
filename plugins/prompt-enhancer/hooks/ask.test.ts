import { expect, test } from 'claude-code/testing'

import { cleanReply, enhanceAsk } from './ask'

test('arma el pedido y limpia la respuesta', async () => {
  const ask = enhanceAsk('agregá un login')
  expect(ask).toContain('Before writing any code, confirm with me:')
  expect(ask.endsWith('agregá un login')).toBe(true)
  expect(cleanReply('```markdown\nHacé el login.\n```')).toBe('Hacé el login.')
  expect(cleanReply('  Hacé el login.  ')).toBe('Hacé el login.')
})
