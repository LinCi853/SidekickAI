/** Matches complete interface fragments rather than words in real discussions. */
export function classifyCapturedNoise(content: string): string | undefined {
  const text = content.replace(/\s+/g, ' ').trim()
  if (!text) return 'empty-capture'
  if (/[?？]|(?:如何|怎么|解释|总结|翻译|实现|编写|代码|讨论|问题|请帮|帮我)|```|[“”"<>]/.test(text)) return undefined
  if (text.length < 600 && /^(?:登录|注册|Sign in|Log in)/i.test(text)
    && /(?:验证码|手机号|扫码|密码|Google)/i.test(text)
    && /(?:隐私政策|用户协议|忘记密码|继续即代表|privacy policy|terms of)/i.test(text)) return 'login-interface'
  const menu = ['我的订单', '下载应用', '更多设置', '退出登录', '升级会员', '主题外观', '积分']
  if (menu.filter(label => text.includes(label)).length >= 4 && text.length < 1200) return 'account-menu'
  if (/^[^\n]{1,40}\s+积分\s*\d+(?:\.\d+)?$/.test(text)) return 'account-summary'
  return undefined
}
