import type { Plugin } from 'vite'

function replaceUnique(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error('Unsupported Excalidraw image export implementation; verify clipboard result handling before building')
  return source.replace(before, after)
}

/** Excalidraw export errors must not resolve as successful clipboard copies. */
export function transformExcalidrawClipboard(source: string, development: boolean): string {
  if (development) {
    source = replaceUnique(source,
      'this.setState({ errorMessage: error.message });\n      });\n      if (this.state.exportEmbedScene && fileHandle && isImageFileHandle(fileHandle))',
      'this.setState({ errorMessage: error.message });\n        return false;\n      });\n      if (this.state.exportEmbedScene && fileHandle && isImageFileHandle(fileHandle))')
    source = replaceUnique(source,
      'this.setState({ fileHandle });\n      }\n    });\n    __publicField(this, "magicGenerations"',
      'this.setState({ fileHandle });\n      }\n      return fileHandle !== false;\n    });\n    __publicField(this, "magicGenerations"')
    source = replaceUnique(source, 'onClick: async () => {\n              await onExportImage(',
      'onClick: async () => {\n              resetCopyStatus();\n              const copied = await onExportImage(')
    return replaceUnique(source, '              onCopy();\n            },\n            icon: copyIcon,',
      '              if (copied) onCopy();\n            },\n            icon: copyIcon,')
  }
  source = replaceUnique(source,
    'this.setState({errorMessage:a.message})});this.state.exportEmbedScene&&i&&xs(i)&&this.setState({fileHandle:i})});C(this,"magicGenerations"',
    'this.setState({errorMessage:a.message});return false});this.state.exportEmbedScene&&i&&xs(i)&&this.setState({fileHandle:i});return i!==false});C(this,"magicGenerations"')
  return replaceUnique(source, 'onClick:async()=>{await n(wl.clipboard,R,{exportingFrame:M}),I()},icon:ei,',
    'onClick:async()=>{k();const copied=await n(wl.clipboard,R,{exportingFrame:M});if(copied)I()},icon:ei,')
}

export function excalidrawClipboardFeedback(): Plugin {
  return { name: 'excalidraw-clipboard-feedback', enforce: 'pre', transform(source, id) {
    const file = id.replaceAll('\\', '/').split('?')[0]
    if (!/\/@excalidraw\/excalidraw\/dist\/(dev|prod)\/index\.js$/.test(file)) return null
    return { code: transformExcalidrawClipboard(source, file.includes('/dist/dev/')), map: null }
  } }
}
