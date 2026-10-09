import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

describe('renderer capability exposure', () => {
  it('retains named interfaces without exposing arbitrary IPC forwarding', () => {
    const source = ts.createSourceFile('preload.ts', readFileSync(new URL('../preload.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
    const context: Record<string, unknown> = { ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue
      const bindings = statement.importClause?.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) continue
      for (const binding of bindings.elements) {
        const name = binding.name.text
        if (!(name in context)) context[name] = name.endsWith('Api') ? { [name]: { fixedMethod: true } } : {}
      }
    }
    const declaration = source.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations]).find(item => item.name.getText(source) === 'api')
    if (!declaration) throw new Error('Renderer API declaration was not found')
    const compiled = ts.transpile(`const ${declaration.getText(source)}; api`, { target: ts.ScriptTarget.ES2022 })
    const api = runInNewContext(compiled, context)
    expect(api).not.toHaveProperty('plugins')
    expect(api).toHaveProperty('updates.check')
    expect(api).toHaveProperty('appSettingsApi.fixedMethod', true)
    expect(api).toHaveProperty('browserApi.fixedMethod', true)
  })

  it('loads the initial theme as an external script under a strict script policy', () => {
    const html = readFileSync(new URL('../../src/index.html', import.meta.url), 'utf8')
    const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1]
    expect(policy).toBeDefined()
    const scripts = policy!.split(';').find(directive => directive.trim().startsWith('script-src '))!
    expect(scripts).not.toContain("'unsafe-inline'")
    expect(html.match(/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g)).toBeNull()
    expect(html.indexOf('theme-startup.js')).toBeGreaterThan(html.indexOf('Content-Security-Policy'))
    expect(html.indexOf('theme-startup.js')).toBeLessThan(html.indexOf('rel="stylesheet"'))
  })
})
