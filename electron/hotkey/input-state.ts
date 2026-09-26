export type Modifier = 'alt' | 'ctrl' | 'shift' | 'meta'
export type Modifiers = Record<Modifier, boolean>
export type KeyObservation = { keycode: number; altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }
export type KeyBinding = Modifiers & { keycode: number | null }
const modifiers: Modifier[] = ['alt', 'ctrl', 'shift', 'meta']

export function modifierKeyCodes(keys: Record<string, number>): Record<Modifier, Set<number>> {
  const codes = { alt: new Set<number>(), ctrl: new Set<number>(), shift: new Set<number>(), meta: new Set<number>() }
  for (const [name, code] of Object.entries(keys)) {
    const normalized = name.toUpperCase().replace(/^(LEFT|RIGHT)|(?:LEFT|RIGHT)$/g, '')
    const modifier = ({ ALT: 'alt', CTRL: 'ctrl', CONTROL: 'ctrl', SHIFT: 'shift', META: 'meta', SUPER: 'meta', COMMAND: 'meta' } as Record<string, Modifier>)[normalized]
    if (modifier && typeof code === 'number') codes[modifier].add(code)
  }
  return codes
}

/** Only an observed, unreleased modifier press can authorize a hook chord. */
export class HotkeyInputState {
  readonly codes: Record<Modifier, Set<number>>
  private readonly held = new Set<number>()
  private readonly consumed = new Set<number>()
  private readonly authorized = new Set<number>()
  private observation: KeyObservation | null = null
  freshPress = false

  constructor(private readonly keys: Record<string, number>) {
    this.codes = modifierKeyCodes(keys)
  }

  observe(event: KeyObservation, down: boolean): void {
    this.observation = event
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
      } else if (!event[(modifier + 'Key') as keyof KeyObservation]) {
        for (const code of codes) {
          this.authorized.delete(code)
          this.held.delete(code)
        }
      }
    }
    const switchesWindow = (event.keycode === this.keys.Tab || event.keycode === this.keys.Escape) && (event.altKey || event.metaKey)
    const closesWindow = event.keycode === this.keys.F4 && event.altKey
    if (down && (switchesWindow || closesWindow)) {
      this.authorized.clear()
    }
  }

  get modifiers(): Modifiers {
    return Object.fromEntries(modifiers.map(modifier => [modifier, [...this.codes[modifier]].some(code => this.authorized.has(code))])) as Modifiers
  }

  matches(binding: KeyBinding): boolean {
    const event = this.observation
    if (!event || event.keycode !== binding.keycode || !this.held.has(event.keycode) || this.consumed.has(event.keycode)) return false
    const observed = this.modifiers
    return modifiers.every(modifier => observed[modifier] === binding[modifier] && Boolean(event[(modifier + 'Key') as keyof KeyObservation]) === binding[modifier])
  }

  claim(binding: KeyBinding): boolean {
    if (!this.matches(binding)) return false
    this.consumed.add(binding.keycode!)
    return true
  }

  suspend(): void {
    this.authorized.clear()
    for (const key of this.held) this.consumed.add(key)
  }

  reset(): void {
    this.held.clear()
    this.authorized.clear()
    this.consumed.clear()
    this.observation = null
  }
}
