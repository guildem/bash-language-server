import * as TurndownService from 'turndown'
import * as LSP from 'vscode-languageserver'

import Analyzer from './analyser'
import * as Builtins from './builtins'
import * as config from './config'
import Executables from './executables'
import { initializeParser } from './parser'
import * as ReservedWords from './reservedWords'
import { BashCompletionItem, CompletionItemDataType } from './types'

/**
 * The BashServer glues together the separate components to implement
 * the various parts of the Language Server Protocol.
 */
export default class BashServer {
  /**
   * Initialize the server based on a connection to the client and the protocols
   * initialization parameters.
   */
  public static async initialize(
    connection: LSP.Connection,
    { rootPath }: LSP.InitializeParams,
  ): Promise<BashServer> {
    const parser = await initializeParser()

    return Promise.all([
      Executables.fromPath(process.env.PATH),
      Analyzer.fromRoot({ connection, rootPath, parser }),
    ]).then(xs => {
      const executables = xs[0]
      const analyzer = xs[1]
      return new BashServer(connection, executables, analyzer)
    })
  }

  private executables: Executables
  private analyzer: Analyzer

  private documents: LSP.TextDocuments = new LSP.TextDocuments()
  private connection: LSP.Connection

  private constructor(
    connection: LSP.Connection,
    executables: Executables,
    analyzer: Analyzer,
  ) {
    this.connection = connection
    this.executables = executables
    this.analyzer = analyzer
  }

  /**
   * Register handlers for the events from the Language Server Protocol that we
   * care about.
   */
  public register(connection: LSP.Connection): void {
    // The content of a text document has changed. This event is emitted
    // when the text document first opened or when its content has changed.
    this.documents.listen(this.connection)
    this.documents.onDidChangeContent(change => {
      const { uri } = change.document
      const diagnostics = this.analyzer.analyze(uri, change.document)
      if (config.getHighlightParsingError()) {
        connection.sendDiagnostics({
          uri: change.document.uri,
          diagnostics,
        })
      }
    })

    // Register all the handlers for the LSP events.
    connection.onHover(this.onHover.bind(this))
    connection.onDefinition(this.onDefinition.bind(this))
    connection.onDocumentSymbol(this.onDocumentSymbol.bind(this))
    connection.onWorkspaceSymbol(this.onWorkspaceSymbol.bind(this))
    connection.onDocumentHighlight(this.onDocumentHighlight.bind(this))
    connection.onReferences(this.onReferences.bind(this))
    connection.onCompletion(this.onCompletion.bind(this))
    connection.onCompletionResolve(this.onCompletionResolve.bind(this))
  }

  /**
   * The parts of the Language Server Protocol that we are currently supporting.
   */
  public capabilities(): LSP.ServerCapabilities {
    return {
      // For now we're using full-sync even though tree-sitter has great support
      // for partial updates.
      textDocumentSync: this.documents.syncKind,
      completionProvider: {
        resolveProvider: true,
      },
      hoverProvider: true,
      documentHighlightProvider: true,
      definitionProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      referencesProvider: true,
    }
  }

  private getWordAtPoint(
    params: LSP.ReferenceParams | LSP.TextDocumentPositionParams,
  ): string | null {
    return this.analyzer.wordAtPoint(
      params.textDocument.uri,
      params.position.line,
      params.position.character,
    )
  }

  private logRequest({
    request,
    params,
    word,
  }: {
    request: string
    params: LSP.ReferenceParams | LSP.TextDocumentPositionParams
    word?: string | null
  }) {
    const wordLog = word ? `"${word}"` : ''
    this.connection.console.log(
      `${request} ${params.position.line}:${params.position.character} ${wordLog}`,
    )
  }

  private async onHover(params: LSP.TextDocumentPositionParams): Promise<LSP.Hover> {
    const word = this.getWordAtPoint(params)

    this.logRequest({ request: 'onHover', params, word })

    const explainshellEndpoint = config.getExplainshellEndpoint()
    if (explainshellEndpoint) {
      this.connection.console.log(`Query ${explainshellEndpoint}`)
      const response = await this.analyzer.getExplainshellDocumentation({
        params,
        endpoint: explainshellEndpoint,
      })

      if (response.status === 'error') {
        this.connection.console.log(
          `getExplainshellDocumentation returned: ${JSON.stringify(response, null, 4)}`,
        )
      } else {
        return {
          contents: {
            kind: 'markdown',
            value: new TurndownService().turndown(response.helpHTML),
          },
        }
      }
    }

    const getMarkdownHoverItem = (doc: string) => ({
      // LSP.MarkupContent
      value: ['``` man', doc, '```'].join('\n'),
      // Passed as markdown for syntax highlighting
      kind: 'markdown' as const,
    })

    if (Builtins.isBuiltin(word)) {
      return Builtins.documentation(word).then(doc => ({
        contents: getMarkdownHoverItem(doc),
      }))
    }

    if (ReservedWords.isReservedWord(word)) {
      return ReservedWords.documentation(word).then(doc => ({
        contents: getMarkdownHoverItem(doc),
      }))
    }

    if (this.executables.isExecutableOnPATH(word)) {
      return this.executables.documentation(word).then(doc => ({
        contents: getMarkdownHoverItem(doc),
      }))
    }

    return null
  }

  private onDefinition(params: LSP.TextDocumentPositionParams): LSP.Definition {
    const word = this.getWordAtPoint(params)
    this.logRequest({ request: 'onDefinition', params, word })
    return this.analyzer.findDefinition(word)
  }

  private onDocumentSymbol(params: LSP.DocumentSymbolParams): LSP.SymbolInformation[] {
    this.connection.console.log(`onDocumentSymbol`)
    return this.analyzer.findSymbols(params.textDocument.uri)
  }

  private onWorkspaceSymbol(params: LSP.WorkspaceSymbolParams): LSP.SymbolInformation[] {
    this.connection.console.log('onWorkspaceSymbol')
    return this.analyzer.search(params.query)
  }

  private onDocumentHighlight(
    params: LSP.TextDocumentPositionParams,
  ): LSP.DocumentHighlight[] {
    const word = this.getWordAtPoint(params)
    this.logRequest({ request: 'onDocumentHighlight', params, word })
    return this.analyzer
      .findOccurrences(params.textDocument.uri, word)
      .map(n => ({ range: n.range }))
  }

  private onReferences(params: LSP.ReferenceParams): LSP.Location[] {
    const word = this.getWordAtPoint(params)
    this.logRequest({ request: 'onReferences', params, word })
    return this.analyzer.findReferences(word)
  }

  private onCompletion(params: LSP.TextDocumentPositionParams): BashCompletionItem[] {
    const word = this.getWordAtPoint(params)
    this.logRequest({ request: 'onCompletion', params, word })

    const symbolCompletions = this.analyzer.findSymbolCompletions(params.textDocument.uri)

    // TODO: we could do some caching here...

    const reservedWordsCompletions = ReservedWords.LIST.map(reservedWord => ({
      label: reservedWord,
      kind: LSP.SymbolKind.Interface, // ??
      data: {
        name: reservedWord,
        type: CompletionItemDataType.ReservedWord,
      },
    }))

    const programCompletions = this.executables.list().map((s: string) => {
      return {
        label: s,
        kind: LSP.SymbolKind.Function,
        data: {
          name: s,
          type: CompletionItemDataType.Executable,
        },
      }
    })

    const builtinsCompletions = Builtins.LIST.map(builtin => ({
      label: builtin,
      kind: LSP.SymbolKind.Interface, // ??
      data: {
        name: builtin,
        type: CompletionItemDataType.Builtin,
      },
    }))

    // TODO: we have duplicates here (e.g. echo is both a builtin AND have a man page)
    const allCompletions = [
      ...reservedWordsCompletions,
      ...symbolCompletions,
      ...programCompletions,
      ...builtinsCompletions,
    ]

    if (word) {
      if (word.startsWith('#')) {
        // Inside a comment block
        return []
      }

      // Filter to only return suffixes of the current word
      return allCompletions.filter(item => item.label.startsWith(word))
    }

    return allCompletions
  }

  private async onCompletionResolve(
    item: BashCompletionItem,
  ): Promise<LSP.CompletionItem> {
    const {
      data: { name, type },
    } = item

    this.connection.console.log(`onCompletionResolve name=${name} type=${type}`)

    const getMarkdownCompletionItem = (doc: string) => ({
      ...item,
      // LSP.MarkupContent
      documentation: {
        value: ['``` man', doc, '```'].join('\n'),
        // Passed as markdown for syntax highlighting
        kind: 'markdown' as const,
      },
    })

    try {
      if (type === CompletionItemDataType.Executable) {
        const doc = await this.executables.documentation(name)
        return getMarkdownCompletionItem(doc)
      } else if (type === CompletionItemDataType.Builtin) {
        const doc = await Builtins.documentation(name)
        return getMarkdownCompletionItem(doc)
      } else if (type === CompletionItemDataType.ReservedWord) {
        const doc = await ReservedWords.documentation(name)
        return getMarkdownCompletionItem(doc)
      } else {
        return item
      }
    } catch (error) {
      return item
    }
  }
}
