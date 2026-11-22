import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { resolve } from 'node:path'
import { createCommandService } from '../src/engine'
import { createZenlev, defineConfig } from '../src'

beforeEach(() => {
  spyOn(performance, 'now').mockReturnValue(0)
})
afterEach(() => {
  mock.restore()
})

test('constructs the programmatic API with a resolved, immutable environment', async () => {
  const config = defineConfig({ cwd: '.', env: 'preview' })
  const zenlev = await createZenlev(config)
  expect(zenlev.environment).toEqual({ cwd: resolve('.'), name: 'preview' })
  expect(Object.isFrozen(zenlev.environment)).toBe(true)
  await zenlev.close()
})

test('closes after commands settle and refuses new commands once closing starts', async () => {
  const service = await createCommandService({})
  const gate = Promise.withResolvers<void>()
  const fail = Promise.withResolvers<void>()
  const run = mock(async () => {
    await gate.promise
    return 'done'
  })
  const completed = service.run(run)
  const failed = service.run(() => fail.promise)
  const close = service.close()
  expect(service.close()).toBe(close)
  await expect(service.run(run)).rejects.toThrow('Zenlev is closed')
  let closed = false
  void close.then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(closed).toBe(false)
  gate.resolve()
  fail.reject(new Error('command failed'))
  await expect(completed).resolves.toBe('done')
  await expect(failed).rejects.toThrow('command failed')
  await close
  expect(closed).toBe(true)
  expect(run).toHaveBeenCalledTimes(1)
})
