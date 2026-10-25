import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'
import {
  HighlightStyle,
  LanguageDescription,
  bracketMatching,
  foldGutter,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language'
import type { LanguageSupport } from '@codemirror/language'
import {
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from '@codemirror/search'
import { languages } from '@codemirror/language-data'
import { tags as t } from '@lezer/highlight'

export interface CodeMirrorSurfaceHandle {
  openSearch: () => void
  focus: () => void
}

interface CodeMirrorSurfaceProps {
  tabId: string
  fileName: string
  content: string
  wrap: boolean
  onChange: (content: string) => void
  onSave: () => void
  onCursorChange: (line: number, column: number) => void
}

interface TabEditorEntry {
  tabId: string
  state: EditorState
  language: Compartment
  wrap: Compartment
  languageRequested: boolean
  languageLoaded: boolean
  scrollTop: number
}

const remoteHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: 'var(--tf-terminal-magenta)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--tf-terminal-green)' },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: 'var(--tf-color-text-muted)',
    fontStyle: 'italic',
  },
  { tag: [t.number, t.bool, t.null], color: 'var(--tf-terminal-yellow)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--tf-terminal-cyan)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--tf-terminal-blue)' },
  { tag: [t.propertyName], color: 'var(--tf-terminal-white)' },
  { tag: [t.variableName, t.definition(t.variableName)], color: 'var(--tf-terminal-foreground)' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--tf-color-text-secondary)' },
  { tag: [t.tagName], color: 'var(--tf-terminal-red)' },
  { tag: [t.attributeName], color: 'var(--tf-terminal-yellow)' },
  { tag: [t.heading], color: 'var(--tf-terminal-blue)', fontWeight: '600' },
  { tag: [t.link, t.url], color: 'var(--tf-terminal-cyan)', textDecoration: 'underline' },
  { tag: [t.invalid], color: 'var(--tf-color-danger)' },
])

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--tf-color-text-primary)',
    backgroundColor: 'var(--tf-color-terminal)',
    fontSize: '13px',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: 'var(--tf-font-terminal)',
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-content': {
    caretColor: 'var(--tf-terminal-cursor)',
    padding: '8px 0',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--tf-terminal-cursor)',
    borderLeftWidth: '2px',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--tf-terminal-selection)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--tf-color-input)',
    color: 'var(--tf-color-text-muted)',
    borderRight: '1px solid var(--tf-border-subtle)',
    fontSize: '12px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--tf-active-overlay)',
    color: 'var(--tf-color-text-secondary)',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--tf-hover-overlay)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--tf-color-elevated)',
    border: '1px solid var(--tf-border-default)',
    color: 'var(--tf-color-text-secondary)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--tf-color-elevated)',
    color: 'var(--tf-color-text-secondary)',
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: '1px solid var(--tf-border-default)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--tf-color-warning-soft)',
    outline: '1px solid var(--tf-color-warning)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--tf-color-primary-soft)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'var(--tf-color-info-soft)',
  },
  '.cm-textfield': {
    backgroundColor: 'var(--tf-color-input)',
    border: '1px solid var(--tf-border-default)',
    borderRadius: '4px',
    color: 'var(--tf-color-text-primary)',
    fontSize: '12px',
    padding: '2px 6px',
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--tf-color-panel)',
    border: '1px solid var(--tf-border-default)',
    borderRadius: '4px',
    color: 'var(--tf-color-text-secondary)',
    fontSize: '12px',
    padding: '2px 8px',
  },
  '.cm-panel.cm-search label': {
    fontSize: '12px',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--tf-color-elevated)',
    border: '1px solid var(--tf-border-default)',
    color: 'var(--tf-color-text-primary)',
  },
})

export const CodeMirrorSurface = forwardRef<CodeMirrorSurfaceHandle, CodeMirrorSurfaceProps>(
  function CodeMirrorSurface(
    { tabId, fileName, content, wrap, onChange, onSave, onCursorChange },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const cacheRef = useRef(new Map<string, TabEditorEntry>())
    const currentRef = useRef<TabEditorEntry | null>(null)

    const contentRef = useRef(content)
    contentRef.current = content
    const fileNameRef = useRef(fileName)
    fileNameRef.current = fileName
    const wrapRef = useRef(wrap)
    wrapRef.current = wrap
    const onChangeRef = useRef(onChange)
    onChangeRef.current = onChange
    const onSaveRef = useRef(onSave)
    onSaveRef.current = onSave
    const onCursorChangeRef = useRef(onCursorChange)
    onCursorChangeRef.current = onCursorChange

    useImperativeHandle(
      ref,
      () => ({
        openSearch: () => {
          if (viewRef.current) openSearchPanel(viewRef.current)
        },
        focus: () => viewRef.current?.focus(),
      }),
      [],
    )

    useEffect(() => {
      const host = hostRef.current
      if (!host) return
      const cache = cacheRef.current
      const view = new EditorView({ parent: host })
      viewRef.current = view
      return () => {
        const current = currentRef.current
        if (current) {
          current.state = view.state
          current.scrollTop = view.scrollDOM.scrollTop
          cache.set(current.tabId, current)
        }
        view.destroy()
        viewRef.current = null
        currentRef.current = null
      }
    }, [])

    useEffect(() => {
      const view = viewRef.current
      if (!view) return

      const previous = currentRef.current
      if (previous && previous.tabId !== tabId) {
        previous.state = view.state
        previous.scrollTop = view.scrollDOM.scrollTop
        cacheRef.current.set(previous.tabId, previous)
      }

      const reportCursor = (state: EditorState): void => {
        const head = state.selection.main.head
        const line = state.doc.lineAt(head)
        onCursorChangeRef.current(line.number, head - line.from + 1)
      }

      const buildEntry = (): TabEditorEntry => {
        const language = new Compartment()
        const wrapCompartment = new Compartment()
        const state = EditorState.create({
          doc: contentRef.current,
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightSpecialChars(),
            history(),
            foldGutter(),
            drawSelection(),
            dropCursor(),
            EditorState.allowMultipleSelections.of(true),
            rectangularSelection(),
            highlightActiveLine(),
            highlightSelectionMatches(),
            bracketMatching(),
            indentUnit.of('  '),
            search({ top: true }),
            EditorState.phrases.of({
              Find: '查找',
              Replace: '替换',
              next: '下一个',
              previous: '上一个',
              all: '全部',
              'match case': '区分大小写',
              'by word': '全词匹配',
              regexp: '正则表达式',
              replace: '替换',
              'replace all': '全部替换',
              close: '关闭',
              'current match': '当前匹配',
              'replaced $ matches': '已替换 $ 处匹配',
              'replaced match on line $': '已替换第 $ 行的匹配',
              'on line': '第 $ 行',
              'Go to line': '跳转到行',
            }),
            syntaxHighlighting(remoteHighlightStyle),
            wrapCompartment.of(wrapRef.current ? EditorView.lineWrapping : []),
            language.of([]),
            EditorView.contentAttributes.of({
              'aria-label': '远程文件内容编辑器',
              spellcheck: 'false',
              autocapitalize: 'off',
            }),
            editorTheme,
            keymap.of([
              {
                key: 'Mod-s',
                preventDefault: true,
                run: () => {
                  onSaveRef.current()
                  return true
                },
              },
              ...searchKeymap,
              ...defaultKeymap,
              ...historyKeymap,
              indentWithTab,
            ]),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                onChangeRef.current(update.state.doc.toString())
              }
              if (update.docChanged || update.selectionSet) {
                reportCursor(update.state)
              }
            }),
          ],
        })
        return {
          tabId,
          state,
          language,
          wrap: wrapCompartment,
          languageRequested: false,
          languageLoaded: false,
          scrollTop: 0,
        }
      }

      const cached = cacheRef.current.get(tabId)
      let entry: TabEditorEntry
      if (cached && cached.state.doc.toString() === contentRef.current) {
        entry = cached
        view.setState(entry.state)
      } else {
        entry = buildEntry()
        cacheRef.current.set(tabId, entry)
        view.setState(entry.state)
      }
      currentRef.current = entry
      if (wrapRef.current) {
        view.dispatch({ effects: entry.wrap.reconfigure(EditorView.lineWrapping) })
      }
      reportCursor(view.state)
      view.focus()

      const scrollTop = entry.scrollTop
      requestAnimationFrame(() => {
        if (viewRef.current !== view) return
        view.scrollDOM.scrollTop = scrollTop
      })

      if (!entry.languageRequested && !entry.languageLoaded) {
        entry.languageRequested = true
        const description = LanguageDescription.matchFilename(languages, fileNameRef.current)
        if (description) {
          void description
            .load()
            .then((support: LanguageSupport) => {
              const latest = cacheRef.current.get(tabId)
              if (!latest) return
              const active = currentRef.current?.tabId === tabId && viewRef.current ? view : null
              const baseState = active ? view.state : latest.state
              const updated = baseState.update({
                effects: latest.language.reconfigure(support),
              })
              if (active) {
                active.dispatch(updated)
                latest.state = updated.state
                if (currentRef.current?.tabId === tabId) currentRef.current = latest
              } else {
                latest.state = updated.state
              }
              latest.languageLoaded = true
              cacheRef.current.set(tabId, latest)
            })
            .catch(() => {
              const latest = cacheRef.current.get(tabId)
              if (latest) latest.languageLoaded = true
            })
        } else {
          entry.languageLoaded = true
        }
      }
      // Props other than tabId are read through refs so switching tabs never
      // tears down the EditorView or its undo history.
    }, [tabId])

    useEffect(() => {
      const view = viewRef.current
      if (!view) return
      const doc = view.state.doc.toString()
      if (doc === content) return
      view.dispatch({
        changes: { from: 0, to: doc.length, insert: content },
      })
    }, [content, tabId])

    useEffect(() => {
      const view = viewRef.current
      const entry = currentRef.current
      if (!view || !entry) return
      view.dispatch({
        effects: entry.wrap.reconfigure(wrap ? EditorView.lineWrapping : []),
      })
    }, [wrap])

    return <div className="text-editor__surface" ref={hostRef} />
  },
)
