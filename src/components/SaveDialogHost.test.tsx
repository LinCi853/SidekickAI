import { describe, expect, it } from 'vitest'
import { buildSaveReply } from './SaveDialogHost'

describe('save dialog reply', () => {
  it('builds a save reply from the dialog draft', () => {
    expect(
      buildSaveReply({ fileName: ' report.txt ', directory: ' E:/downloads ', remember: true }),
    ).toEqual({
      action: 'save',
      fileName: 'report.txt',
      directory: 'E:/downloads',
      remember: true,
    })
  })

  it('does not reply while the file name is empty', () => {
    expect(
      buildSaveReply({ fileName: '  ', directory: 'E:/downloads', remember: false }),
    ).toBeNull()
  })

  it('does not reply while the directory is empty', () => {
    expect(buildSaveReply({ fileName: 'report.txt', directory: '', remember: false })).toBeNull()
  })
})
