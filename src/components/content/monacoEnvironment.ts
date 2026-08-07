import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import typescriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

declare global {
  var MonacoEnvironment: {
    getWorker: (_moduleId: string, label: string) => Worker
  } | undefined
}

globalThis.MonacoEnvironment = {
  getWorker: (_moduleId, label) => {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new typescriptWorker()
    return new editorWorker()
  },
}

