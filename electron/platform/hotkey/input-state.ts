export type Modifier = 'alt' | 'ctrl' | 'shift' | 'meta'
export type Modifiers = Record<Modifier, boolean>
export type KeyObservation = {
  keycode: number
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  metaKey: boolean
}
export type KeyBinding = Modifiers & { keycode: number | null }
const modifiers: Modifier[] = ['alt', 'ctrl', 'shift', 'meta']

export function modifierKeyCodes(keys: Record<string, number>): Record<Modifier, Set<number>> {
  const codes = {
    alt: new Set<number>(),
    ctrl: new Set<number>(),
    shift: new Set<number>(),
    meta: new Set<number>(),
  }
  for (const [name, code] of Object.entries(keys)) {
    const normalized = name.toUpperCase().replace(/^(LEFT|RIGHT)|(?:LEFT|RIGHT)$/g, '')
    const modifier = (
      {
        ALT: 'alt',
        CTRL: 'ctrl',
        CONTROL: 'ctrl',
        SHIFT: 'shift',
        META: 'meta',
        SUPER: 'meta',
        COMMAND: 'meta',
      } as Record<string, Modifier>
    )[normalized]
    if (modifier && typeof code === 'number') codes[modifier].add(code)
  }
  return codes
}

/** 修饰键授权静默上限：超过该时长没有任何自身事件，视为 keyup 丢失并撤销授权 */
export const MODIFIER_SILENCE_HEAL_MS = 1500

/** Only an observed, unreleased modifier press can authorize a hook chord. */
export class HotkeyInputState {
  readonly codes: Record<Modifier, Set<number>>
  private readonly held = new Set<number>()
  private readonly consumed = new Set<number>()
  private readonly authorized = new Set<number>()
  /** 各按键最近一次事件时刻，供「keyup 丢失」自愈判定 */
  private readonly lastEventAt = new Map<number, number>()
  private observation: KeyObservation | null = null
  freshPress = false

  constructor(private readonly keys: Record<string, number>) {
    this.codes = modifierKeyCodes(keys)
  }

  observe(event: KeyObservation, down: boolean, now: number = Date.now()): void {
    this.healStaleModifiers(now)
    this.observation = event
    this.lastEventAt.set(event.keycode, now)
    const wasHeld = this.held.has(event.keycode)
    this.freshPress = down && !wasHeld
    if (down) this.held.add(event.keycode)
    else {
      this.held.delete(event.keycode)
      this.authorized.delete(event.keycode)
      this.consumed.delete(event.keycode)
    }
    for (const modifier of modifiers) {
      const codes = this.codes[modifier]
      if (codes.has(event.keycode)) {
        if (down && !wasHeld) this.authorized.add(event.keycode)
      }
      // 不再依据事件 mask 撤销授权：uiohook 的 mask 不可靠（注入输入恒 false、
      // 焦点切换后失真），会造成连按中途整段失灵；授权以按键事件流为准，
      // 丢 keyup 的残留授权由 healStaleModifiers 按静默时长自愈。
    }
    const switchesWindow =
      (event.keycode === this.keys.Tab || event.keycode === this.keys.Escape) &&
      (this.modifiers.alt || this.modifiers.meta)
    const closesWindow = event.keycode === this.keys.F4 && this.modifiers.alt
    if (down && (switchesWindow || closesWindow)) {
      this.authorized.clear()
    }
  }

  /**
   * 自愈：授权中的修饰键若超过 MODIFIER_SILENCE_HEAL_MS 没有任何自身事件
   *（长按时系统 auto-repeat 会持续转发 keydown），视为 keyup 已丢失，撤销授权。
   * 防止残留授权使后续单键误匹配组合键。
   */
  private healStaleModifiers(now: number): void {
    for (const code of [...this.authorized]) {
      const at = this.lastEventAt.get(code)
      if (at != null && now - at >= MODIFIER_SILENCE_HEAL_MS) {
        this.authorized.delete(code)
        this.held.delete(code)
      }
    }
  }

  get modifiers(): Modifiers {
    return Object.fromEntries(
      modifiers.map((modifier) => [
        modifier,
        [...this.codes[modifier]].some((code) => this.authorized.has(code)),
      ]),
    ) as Modifiers
  }

  matches(binding: KeyBinding): boolean {
    const event = this.observation
    if (
      !event ||
      event.keycode !== binding.keycode ||
      !this.held.has(event.keycode) ||
      this.consumed.has(event.keycode)
    )
      return false
    const observed = this.modifiers
    return modifiers.every((modifier) => {
      if (observed[modifier] !== binding[modifier]) return false
      // mask 只作反向否决：mask 声称存在事件流未观察到的修饰键按下时拒绝
      //（漏 keydown 的场景防误触发）；mask 为 false 不否决——uiohook 的 mask
      // 不可靠，组合键成立与否以按键事件流为准。
      if (Boolean(event[(modifier + 'Key') as keyof KeyObservation]) && !observed[modifier]) {
        return false
      }
      return true
    })
  }

  claim(binding: KeyBinding): boolean {
    if (!this.matches(binding)) return false
    this.consumed.add(binding.keycode!)
    return true
  }

  /** 该键当前是否被钩子观察到处于按下状态（供系统通路做长按连切仲裁的证据） */
  isKeyHeld(keycode: number): boolean {
    return this.held.has(keycode)
  }

  suspend(): void {
    this.authorized.clear()
    for (const key of this.held) this.consumed.add(key)
  }

  reset(): void {
    this.held.clear()
    this.authorized.clear()
    this.consumed.clear()
    this.lastEventAt.clear()
    this.observation = null
  }
}
