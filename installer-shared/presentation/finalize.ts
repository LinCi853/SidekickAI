export interface Finalization {
  save?: () => Promise<boolean | void>
  prepareLaunch?: () => Promise<boolean | void>
  close: () => Promise<boolean | void>
}

export async function finalizeWizard(actions: Finalization): Promise<void> {
  if (actions.save && await actions.save() === false) throw new Error('设置写入未完成')
  if (actions.prepareLaunch && await actions.prepareLaunch() === false) throw new Error('启动选项未能确认')
  if (await actions.close() === false) throw new Error('当前操作仍在进行，请等待完成后再关闭')
}
