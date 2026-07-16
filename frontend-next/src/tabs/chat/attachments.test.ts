import { expect, test } from 'vitest'
import { beginUploads, failUploads, resolveUploads, sendableAttach, uploadGate } from './attachments'

test('upload lifecycle preserves existing files and batch positions', () => {
  let id = 0
  const begun = beginUploads([{ id: 'done', name: 'done.pdf' }], ['a.png', 'b.txt'], () => `tmp-${id++}`)
  expect(begun.ids).toEqual(['tmp-0', 'tmp-1'])
  expect(begun.list.map((item) => item.status)).toEqual([undefined, 'uploading', 'uploading'])

  const resolved = resolveUploads(begun.list.filter((item) => item.id !== 'tmp-0'), begun.ids, [
    { id: 'a', name: 'a.png', url: '/a' }, { id: 'b', name: 'b.txt', url: '/b' },
  ])
  expect(resolved.map((item) => item.id)).toEqual(['done', 'b'])
})

test('missing saves and failed batches stay visible but are not sendable', () => {
  const pending = [{ id: 'a', name: 'a', status: 'uploading' as const }, { id: 'b', name: 'b' }]
  expect(resolveUploads(pending, ['a'], [])[0].status).toBe('failed')
  expect(failUploads(pending, ['a'])[0].status).toBe('failed')
  expect(sendableAttach(pending).map((item) => item.id)).toEqual(['b'])
  expect(uploadGate([{ ...pending[0], status: 'failed' }, { id: 'c', name: 'c', status: 'uploading' }])).toBe('uploading')
  expect(uploadGate([{ ...pending[0], status: 'failed' }])).toBe('failed')
  expect(uploadGate([])).toBe('ok')
})
