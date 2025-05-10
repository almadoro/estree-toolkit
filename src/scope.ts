import { Identifier, JSXIdentifier, Pattern } from 'estree-jsx'
import { Node, assertNever, PossibleKeysInParent, NodeMap, NodeT, ParentsOf } from './helpers'
import { NodePath, NodePathT } from './nodepath'
import { Traverser, ExpandedVisitor, ExpandedVisitors } from './traverse'
import { Binding, BindingKind, BindingPathT, GlobalBinding } from './binding'
import { is } from './is'
import { builders as b } from './builders'
import { AliasMap } from './aliases'

type CrawlerState = {
  references: NodePath<Identifier | JSXIdentifier>[];
  constantViolations: NodePath<Identifier>[];
  labelReferences: NodePath<Identifier, NodeT<'BreakStatement' | 'ContinueStatement'>>[];
  scope: Scope;
  childScopedPaths: NodePathT<ScopedNode>[];
}

const scopedNodeTypes = [
  'ArrowFunctionExpression',
  'BlockStatement',
  'CatchClause',
  'ClassDeclaration',
  'ClassExpression',
  'DoWhileStatement',
  'ForInStatement',
  'ForOfStatement',
  'ForStatement',
  'FunctionDeclaration',
  'FunctionExpression',
  'Program',
  'SwitchStatement',
  'WhileStatement'
] as const
type ScopedNode = typeof scopedNodeTypes[number]

const scopedNodesTypesSet = new Set<Node['type']>(scopedNodeTypes)

const shouldBlockStatementMakeScope = (parent: Node | null) => {
  /*
    Don't create a new scope if `BlockStatement` is placed in these places
      - for (let x in f) {}    -- ForInStatement -> BlockStatement
      - () => {}               -- ArrowFunctionExpression -> BlockStatement
      - function () {}         -- FunctionExpression -> BlockStatement
      - while (x) {}           -- WhileStatement -> BlockStatement
      - ...
    But not in these cases
      - { let x; { let x; } }  -- BlockStatement -> BlockStatement
      - { }                    -- Program -> BlockStatement
  */

  if (
    parent != null &&
    parent.type !== 'BlockStatement' &&
    parent.type !== 'Program' &&
    scopedNodesTypesSet.has(parent.type)
  ) {
    return false
  }

  return true
}

const shouldMakeScope = (path: NodePath): boolean => {
  if (path.node == null) return false

  if (
    path.node.type === 'BlockStatement' &&
    !shouldBlockStatementMakeScope(path.parent)
  ) {
    return false
  }

  return scopedNodesTypesSet.has(path.node.type)
}

const isIdentifierJSX = (name: string) => !(/^[a-z]/.test(name))

/*
```
[PARENT_TYPE]: {
  key: KEY,
  path: PATH,
  state: CRAWLER_STATE
}
```
- PARENT_TYPE: Parent type of the identifier 
- KEY: The identifier's key in the parent
- PATH: The NodePath of the identifier
- CRAWLER_STATE: The state object of crawler
*/
const identifierCrawlers: {
  [Parent in ParentsOf<Identifier> as `${Parent['type']}`]: (
    key: PossibleKeysInParent<Identifier, Parent>,
    path: NodePath<Identifier, Parent>,
    state: CrawlerState
  ) => void;
} = {
  ArrowFunctionExpression(key, path, state) {
    switch (key) {
      case 'body':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  AssignmentExpression(key, path, state) {
    switch (key) {
      /* istanbul ignore next */
      case 'left':
        throw new Error('This should be handled by `crawlerVisitor.AssignmentExpression`')
      case 'right':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  AssignmentPattern(key, path, state) {
    switch (key) {
      /* istanbul ignore next */
      case 'left':
        // TODO
        // ? IDK what to do
        // Appears in
        // - const { a = 0 } = x;
        // - function fn(a = 0) {}
        // - ...
        //
        // `a = 0` is AssignmentPattern
        // I don't think this would ever get called
        throw new Error('`identifierCrawlers.AssignmentPattern` is not implemented')
      case 'right':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  AwaitExpression(key, path, state) {
    switch (key) {
      case 'argument':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  /* istanbul ignore next */
  FunctionDeclaration(key) {
    switch (key) {
      case 'id':
        // Handled by `crawlerVisitor.ClassDeclaration`
        // Do nothing
        break
      default: assertNever(key)
    }
  },
  /* istanbul ignore next */
  FunctionExpression(key) {
    switch (key) {
      case 'id':
        throw new Error('This should be handled by `scopePathCrawlers.FunctionExpression`')
      default: assertNever(key)
    }
  },
  SwitchCase(key, path, state) {
    switch (key) {
      case 'test':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  /* istanbul ignore next */
  CatchClause(key) {
    switch (key) {
      case 'param':
        throw new Error('This should be handled by `scopePathCrawlers.CatchClause`')
      default: assertNever(key)
    }
  },
  VariableDeclarator(key, path, state) {
    switch (key) {
      /* istanbul ignore next */
      case 'id':
        throw new Error('This should be handled by `scopePathCrawlers.VariableDeclarator`')
      case 'init':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  ExpressionStatement(key, path, state) {
    switch (key) {
      case 'expression':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  /* istanbul ignore next */
  WithStatement(key, path, state) {
    switch (key) {
      case 'object':
        state.references.push(path)
        break
      default: assertNever(key)
    }
  },
  ReturnStatement(key, path, state) {
    switch (key) {
      case 'argument':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  LabeledStatement() {
    // Do nothing as it is handled by
    // `scopePathCrawlers.{BlockStatement,ForStatement,ForInStatement,ForOfStatement}`
  },
  BreakStatement(key, path, state) {
    switch (key) {
      case 'label':
        state.labelReferences.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  ContinueStatement(key, path, state) {
    switch (key) {
      case 'label':
        state.labelReferences.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  IfStatement(key, path, state) {
    switch (key) {
      case 'test':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  SwitchStatement(key, path, state) {
    switch (key) {
      case 'discriminant':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  ThrowStatement(key, path, state) {
    switch (key) {
      case 'argument':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  WhileStatement(key, path, state) {
    switch (key) {
      case 'test':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  DoWhileStatement(key, path, state) {
    switch (key) {
      case 'test':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  ForStatement(key, path, state) {
    switch (key) {
      case 'init':
      case 'test':
      case 'update':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  ForInStatement(key, path, state) {
    switch (key) {
      /* istanbul ignore next */
      case 'left':
        throw new Error('This should be handled by `scopePathCrawlers.ForInStatement`')
      case 'right':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  ForOfStatement(key, path, state) {
    switch (key) {
      /* istanbul ignore next */
      case 'left':
        throw new Error('This should be handled by `scopePathCrawlers.ForOfStatement`')
      case 'right':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  ClassDeclaration(key, path, state) {
    switch (key) {
      /* istanbul ignore next */
      case 'id':
        // Handled by `crawlerVisitor.ClassDeclaration`
        // Do nothing
        break
      case 'superClass':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  YieldExpression(key, path, state) {
    switch (key) {
      case 'argument':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  UnaryExpression(key, path, state) {
    switch (key) {
      case 'argument':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  UpdateExpression(key, path, state) {
    switch (key) {
      case 'argument':
        state.constantViolations.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  BinaryExpression(key, path, state) {
    switch (key) {
      case 'left':
      case 'right':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  LogicalExpression(key, path, state) {
    switch (key) {
      case 'left':
      case 'right':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  MemberExpression(key, path, state) {
    switch (key) {
      case 'object':
        state.references.push(path)
        break
      case 'property':
        if (path.parent!.computed) {
          state.references.push(path)
        }
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  ConditionalExpression(key, path, state) {
    switch (key) {
      case 'test':
      case 'consequent':
      case 'alternate':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  CallExpression(key, path, state) {
    switch (key) {
      case 'callee':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  NewExpression(key, path, state) {
    switch (key) {
      case 'callee':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  TaggedTemplateExpression(key, path, state) {
    switch (key) {
      case 'tag':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  ClassExpression(key, path, state) {
    switch (key) {
      /* istanbul ignore next */
      case 'id':
        throw new Error('This should be handled by `scopePathCrawlers.ClassExpression`')
      case 'superClass':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  MetaProperty(key) {
    switch (key) {
      case 'meta':
      case 'property': break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  ImportExpression(key, path, state) {
    switch (key) {
      case 'source':
        state.references.push(path)
        break
      case 'options':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  Property(key, path, state) {
    switch (key) {
      case 'key':
        if (path.parent!.computed) {
          state.references.push(path)
        }
        break
      case 'value':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  SpreadElement(key, path, state) {
    switch (key) {
      case 'argument':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  /* istanbul ignore next */
  RestElement(key) {
    switch (key) {
      case 'argument':
        throw new Error('This should be handled by `findVisiblePathsInPattern`')
      default: assertNever(key)
    }
  },
  MethodDefinition(key, path, state) {
    switch (key) {
      case 'key':
        if (path.parent!.computed) {
          state.references.push(path)
        }
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  ExportDefaultDeclaration(key, path, state) {
    switch (key) {
      case 'declaration':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  ImportSpecifier(key, path, state) {
    switch (key) {
      case 'imported':
        /* istanbul ignore next */
        if (path.parent!.local == null) {
          state.scope.registerBinding('module', path, path.parentPath!)
        }
        // Sometimes parsers set imported and local to the same node
        // (ImportSpecifier.imported === ImportSpecifier.local)
        // in that case the `local` part would not get traversed
        // because the traverser thinks that it has already traversed the `local`
        // but it has just traversed the `imported`
        if (path.parent!.local === path.parent!.imported) {
          const ctx = path.ctx
          let parentPath = path.parentPath!
          const parentNode = parentPath.node!
          type T = NodeT<'ImportSpecifier'>
          ctx.newQueue()
          parentPath = parentPath.replaceWith(Object.assign<any, T, Partial<T>>({}, parentNode, {
            local: Object.assign({}, parentNode.local),
            imported: Object.assign({}, parentNode.imported)
          }))
          ctx.popQueue()
          state.scope.registerBinding('module', parentPath.get('local'), parentPath)
        }
        break
      case 'local':
        state.scope.registerBinding('module', path, path.parentPath!)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  ImportDefaultSpecifier(key, path, state) {
    switch (key) {
      case 'local':
        state.scope.registerBinding('module', path, path.parentPath!)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  ImportNamespaceSpecifier(key, path, state) {
    switch (key) {
      case 'local':
        state.scope.registerBinding('module', path, path.parentPath!)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  ExportSpecifier(key, path, state) {
    switch (key) {
      case 'local':
        // Sometimes parsers set exported and local to the same node
        // (ExportSpecifier.exported === ExportSpecifier.local)
        // It messes up the renaming process, here is a workaround
        // so that these two object does not reference each other
        if (path.parent!.local === path.parent!.exported) {
          const ctx = path.ctx
          let parentPath = path.parentPath!
          const parentNode = parentPath.node!
          type T = NodeT<'ExportSpecifier'>
          ctx.newQueue()
          parentPath = parentPath.replaceWith(Object.assign<any, T, Partial<T>>({}, parentNode, {
            local: Object.assign({}, parentNode.local),
            exported: Object.assign({}, parentNode.exported)
          }))
          ctx.popQueue()
          state.references.push(parentPath.get('local') as NodePath<Identifier, NodeT<'ExportSpecifier'>>)
        } else {
          state.references.push(path)
        }
        break
      case 'exported': break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  ExportAllDeclaration(key) {
    switch (key) {
      case 'exported': break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  PropertyDefinition(key, path, state) {
    switch (key) {
      case 'key':
        if (path.parent!.computed) {
          state.references.push(path)
        }
        break
      case 'value':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  ImportAttribute(key) {
    switch (key) {
      case 'key': break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },


  /// JSX
  JSXExpressionContainer(key, path, state) {
    switch (key) {
      case 'expression':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  JSXSpreadAttribute(key, path, state) {
    switch (key) {
      case 'argument':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  JSXSpreadChild(key, path, state) {
    switch (key) {
      case 'expression':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  }
}

const jsxIdentifierCrawlers: {
  [Parent in ParentsOf<JSXIdentifier> as `${Parent['type']}`]: (
    key: PossibleKeysInParent<JSXIdentifier, Parent>,
    path: NodePath<JSXIdentifier, Parent>,
    state: CrawlerState
  ) => void;
} = {
  JSXNamespacedName(key, path, state) {
    switch (key) {
      case 'namespace':
        if (isIdentifierJSX(path.node!.name)) {
          state.references.push(path)
        }
        break
      case 'name': break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  JSXAttribute(key) {
    switch (key) {
      case 'name': break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  JSXClosingElement(key, path, state) {
    switch (key) {
      case 'name':
        if (isIdentifierJSX(path.node!.name)) {
          state.references.push(path)
        }
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  JSXMemberExpression(key, path, state) {
    switch (key) {
      case 'object':
        state.references.push(path)
        break
      case 'property': break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  },
  JSXOpeningElement(key, path, state) {
    switch (key) {
      case 'name':
        if (isIdentifierJSX(path.node!.name)) {
          state.references.push(path)
        }
        break
      /* istanbul ignore next */
      default: assertNever(key)
    }
  }
}

/*
```
[PARENT_TYPE]: {
  listKey: LIST_KEY,
  path: PATH,
  state: CRAWLER_STATE
}
```
- PARENT_TYPE: Parent type of the identifier
- LIST_KEY: The identifier's list key in the parent
- PATH: The NodePath of the identifier
- CRAWLER_STATE: The state object of crawler
*/
const inListIdentifierCrawlers: {
  [Parent in ParentsOf<Identifier[]> as `${Parent['type']}`]: (
    listKey: PossibleKeysInParent<Identifier[], Parent>,
    path: NodePath<Identifier>,
    state: CrawlerState
  ) => void;
} = {
  ArrayExpression(listKey, path, state) {
    switch (listKey) {
      case 'elements':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(listKey)
    }
  },
  CallExpression(listKey, path, state) {
    switch (listKey) {
      case 'arguments':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(listKey)
    }
  },
  NewExpression(listKey, path, state) {
    switch (listKey) {
      case 'arguments':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(listKey)
    }
  },
  SequenceExpression(listKey, path, state) {
    switch (listKey) {
      case 'expressions':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(listKey)
    }
  },
  TemplateLiteral(listKey, path, state) {
    switch (listKey) {
      case 'expressions':
        state.references.push(path)
        break
      /* istanbul ignore next */
      default: assertNever(listKey)
    }
  },
  /* istanbul ignore next */
  ArrayPattern(listKey) {
    switch (listKey) {
      case 'elements':
        // The code should never reach this
        throw new Error('`inListIdentifierCrawler.ArrayPattern` is not implemented')
      default: assertNever(listKey)
    }
  },
  /* istanbul ignore next */
  FunctionDeclaration(listKey) {
    switch (listKey) {
      case 'params':
        throw new Error('This should be handled by `scopePathCrawlers.FunctionDeclaration`')
      default: assertNever(listKey)
    }
  },
  /* istanbul ignore next */
  FunctionExpression(listKey) {
    switch (listKey) {
      case 'params':
        throw new Error('This should be handled by `scopePathCrawlers.FunctionExpression`')
      default: assertNever(listKey)
    }
  },
  /* istanbul ignore next */
  ArrowFunctionExpression(listKey) {
    switch (listKey) {
      case 'params':
        throw new Error('This should be handled by `scopePathCrawlers.ArrowFunctionExpression`')
      default: assertNever(listKey)
    }
  }
}

const inListJSXIdentifierCrawlers: {
  [Parent in ParentsOf<JSXIdentifier[]> as `${Parent['type']}`]: (
    listKey: PossibleKeysInParent<JSXIdentifier[], Parent>,
    path: NodePath<JSXIdentifier>,
    state: CrawlerState
  ) => void;
} = {}

// From -
//  const { a, b: [c, { d }], e: f = 0, ...g } = x;
// Returns paths to
// - a, c, d, f, g
const findVisiblePathsInPattern = (
  path: NodePath<Pattern>,
  result: NodePath[]
) => {
  switch (path.node!.type) {
    case 'Identifier':
      result.push(path)
      // Already crawled, skip it
      path.skip()
      break

    case 'ObjectPattern': {
      const properties = (path as NodePathT<'ObjectPattern'>).get('properties')
      for (let i = 0; i < properties.length; i++) {
        const property = properties[i]
        const propertyNode = property.node!

        switch (propertyNode.type) {
          case 'RestElement':
            findVisiblePathsInPattern(property as NodePathT<'RestElement'>, result)
            break

          case 'Property':
            /* istanbul ignore else */
            if (propertyNode.value != null) {
              let propertyPath = property
              // Sometimes parsers set key and value to the same node
              // (Property.key === Property.value)
              // It messes up the renaming process, here is a workaround
              // so that these two object does not reference each other
              if (propertyNode.value === propertyNode.key) {
                const ctx = path.ctx
                type T = NodeT<'Property'>
                ctx.newQueue()
                propertyPath = propertyPath.replaceWith(Object.assign<any, T, Partial<T>>({}, propertyNode, {
                  key: Object.assign({}, propertyNode.key),
                  value: Object.assign({}, propertyNode.value)
                }))
                ctx.popQueue()
              }

              findVisiblePathsInPattern(
                (propertyPath as NodePathT<'Property'>).get('value') as NodePath<Pattern>,
                result
              )
            } else /* istanbul ignore if */ if (
              !propertyNode.computed &&
              propertyNode.key.type === 'Identifier'
            ) {
              const keyPath = (property as NodePathT<'Property'>).get('key')
              result.push(keyPath)
              // Already crawled, skip it
              keyPath.skip()
            }
            break
        }
      }
      break
    }

    case 'ArrayPattern': {
      const aPath = (path as NodePathT<'ArrayPattern'>)
      const elementPaths = aPath.get('elements')
      const elements = aPath.node!.elements
      for (let i = 0; i < elementPaths.length; i++) {
        if (elements[i] == null) continue
        findVisiblePathsInPattern(elementPaths[i], result)
      }
      break
    }

    case 'RestElement':
      findVisiblePathsInPattern((path as NodePathT<'RestElement'>).get('argument'), result)
      break

    case 'AssignmentPattern':
      findVisiblePathsInPattern((path as NodePathT<'AssignmentPattern'>).get('left'), result)
      break

    /* istanbul ignore next */
    case 'MemberExpression': break
    /* istanbul ignore next */
    default: assertNever(path.node)
  }
}

const registerBindingFromPattern = <T extends BindingKind>(
  path: NodePath<Pattern>,
  scope: Scope,
  kind: T,
  bindingPath: BindingPathT<T>
) => {
  const identifierPaths: NodePath<Identifier>[] = []
  findVisiblePathsInPattern(path, identifierPaths)
  for (let i = 0; i < identifierPaths.length; i++) {
    scope.registerBinding(kind, identifierPaths[i], bindingPath)
  }
}

const registerConstantViolationFromPattern = (path: NodePath<Pattern>, state: CrawlerState) => {
  const identifierPaths: NodePath<Identifier>[] = []
  findVisiblePathsInPattern(path, identifierPaths)
  for (let i = 0; i < identifierPaths.length; i++) {
    state.constantViolations.push(identifierPaths[i])
  }
}

const registerVariableDeclaration = (path: NodePathT<'VariableDeclaration'>, scope: Scope) => {
  const kind = path.node!.kind
  const declarators = path.get('declarations')
  for (let i = 0; i < declarators.length; i++) {
    const declarator = declarators[i]
    registerBindingFromPattern(declarator.get('id'), scope, kind, declarator)
  }
}

const crawlerVisitor: {
  [K in 'Identifier' | 'JSXIdentifier' | 'AssignmentExpression' | 'VariableDeclaration']: (
    ExpandedVisitor<NodeT<K>, CrawlerState>
  );
} = {
  Identifier: {
    enter(path, state) {
      const parentType = path.parentPath!.node?.type

      type CrawlerRecord = typeof inListIdentifierCrawlers
      type CrawlerType = CrawlerRecord[keyof CrawlerRecord]
      type Filter<T extends unknown[], X> = T extends [infer H, ...infer R] ?
        H extends X ? Filter<R, X> : [H, ...Filter<R, X>] : T
      type RealType = (...arg: [string, ...Filter<Parameters<CrawlerType>, string>]) => void

      if (path.listKey != null) {
        const crawler = inListIdentifierCrawlers[parentType as ParentsOf<Identifier[]>['type']]
        if (crawler != null) {
          (crawler as unknown as RealType)(path.listKey as never, path, state)
        }
      } else {
        const crawler = identifierCrawlers[parentType as ParentsOf<Identifier>['type']]
        if (crawler != null) {
          (crawler as unknown as RealType)(path.key as never, path as NodePath<Identifier, any>, state)
        }
      }
    }
  },
  JSXIdentifier: {
    enter(path, state) {
      const parentType = path.parentPath!.node?.type

      // TODO: Change this if there is any `inListJSXIdentifierCrawlers`
      /* istanbul ignore if */
      if (path.listKey != null) /* istanbul ignore next */ {
        const crawler = inListJSXIdentifierCrawlers[parentType as ParentsOf<JSXIdentifier[]>['type']]
        if (crawler != null) {
          (crawler as any)(path.listKey as never, path, state)
        }
      } else {
        const crawler = jsxIdentifierCrawlers[parentType as ParentsOf<JSXIdentifier>['type']]
        if (crawler != null) {
          crawler(path.key as never, path as NodePath<JSXIdentifier, any>, state)
        }
      }
    }
  },
  AssignmentExpression: {
    enter(path, state) {
      registerConstantViolationFromPattern(path.get('left'), state)
    }
  },
  VariableDeclaration: {
    enter(path, state) {
      registerVariableDeclaration(path, state.scope)
    }
  }
}

{
  type VisitorType = ExpandedVisitor<NodeMap[ScopedNode], CrawlerState>
  type CrawlerVisitors = {
    [K in ScopedNode]: ExpandedVisitor<NodeT<K>, CrawlerState>;
  }
  const cVisitors = crawlerVisitor as any as CrawlerVisitors
  const skipToChildNodeVisitor: VisitorType = {
    enter(path, state) {
      // Stop crawling whenever a scoped node is found
      // children will handle the further crawling
      state.childScopedPaths.push(path)
      path.skip()
    }
  }

  for (let i = 0; i < scopedNodeTypes.length; i++) {
    cVisitors[scopedNodeTypes[i]] = skipToChildNodeVisitor
  }

  // `crawlerVisitor` stops whenever it finds `FunctionDeclaration` or `ClassDeclaration`
  // so it never gets the chance to register the declaration's binding
  // We are making an exception to handle the case
  cVisitors.FunctionDeclaration =
  cVisitors.ClassDeclaration = {
    enter(path: NodePathT<'FunctionDeclaration' | 'ClassDeclaration'>, state) {
      // ? Register `unknown` binding if `id` is null
      if (path.node!.id != null) {
        const id = path.get('id')
        state.scope.registerBinding('hoisted', id, path)
        // Skip it as we have already gathered information from it
        id.skip()
      }
      skipToChildNodeVisitor.enter!.call({} as any, path, state)
    }
  }

  // But things are kind of different for `BlockStatement`
  //                - (see the comments of `shouldBlockStatementMakeScope` function)
  // This is the workaround for the case
  cVisitors.BlockStatement = {
    enter(path, state) {
      if (shouldBlockStatementMakeScope(path.parent)) {
        skipToChildNodeVisitor.enter!.call({} as any, path, state)
      }
    }
  }
}

const registerFunctionParams = (paths: NodePath<Pattern>[], scope: Scope) => {
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]
    registerBindingFromPattern(path, scope, 'param', path)
  }
}

const scopePathCrawlers: {
  [K in ScopedNode]: null | ((path: NodePathT<K>, state: CrawlerState) => void);
} & {
  ForXStatement: (path: NodePathT<'ForInStatement' | 'ForOfStatement'>, state: CrawlerState) => void;
} = {
  Program: null,
  FunctionDeclaration(path, { scope }) {
    registerFunctionParams(path.get('params'), scope)
  },
  ClassDeclaration: null,
  FunctionExpression(path, { scope }) {
    if (path.node!.id != null) {
      const id = path.get('id')
      scope.registerBinding('local', id, path)
      id.skip()
    }
    registerFunctionParams(path.get('params'), scope)
  },
  ClassExpression(path, { scope }) {
    if (path.node!.id != null) {
      const id = path.get('id')
      scope.registerBinding('local', id, path)
      id.skip()
    }
  },
  ArrowFunctionExpression(path, { scope }) {
    registerFunctionParams(path.get('params'), scope)
  },
  CatchClause(path, { scope }) {
    if (path.has('param')) {
      registerBindingFromPattern(path.get('param'), scope, 'let', path)
    }
  },
  BlockStatement(path, { scope }) {
    if (path.parent != null && path.parent.type === 'LabeledStatement') {
      scope.registerLabel((path.parentPath as NodePathT<'LabeledStatement'>).get('label'))
    }
  },
  SwitchStatement: null,
  WhileStatement: null,
  DoWhileStatement: null,
  ForStatement(path, state) {
    if (path.parent != null && path.parent.type === 'LabeledStatement') {
      state.scope.registerLabel((path.parentPath as NodePathT<'LabeledStatement'>).get('label'))
    }

    if (path.node!.init != null && path.node!.init.type === 'VariableDeclaration') {
      registerVariableDeclaration(path.get('init'), state.scope)
    }
  },
  ForXStatement(path, state) {
    if (path.parent != null && path.parent.type === 'LabeledStatement') {
      state.scope.registerLabel((path.parentPath as NodePathT<'LabeledStatement'>).get('label'))
    }

    if (path.node!.left.type === 'VariableDeclaration') {
      registerVariableDeclaration(
        path.get('left') as NodePathT<'VariableDeclaration'>,
        state.scope
      )
    } else if (is.pattern(path.node!.left)) {
      registerConstantViolationFromPattern(
        path.get('left') as NodePath<Pattern>,
        state
      )
    }
  },
  ForInStatement(path, state) {
    scopePathCrawlers.ForXStatement(path, state)
  },
  ForOfStatement(path, state) {
    scopePathCrawlers.ForXStatement(path, state)
  },
}

export type Label = {
  path: NodePath<Identifier, NodeT<'LabeledStatement'>>;
  references: NodePath<Identifier, NodeT<'BreakStatement' | 'ContinueStatement'>>[];
}

//    _|_|_|  _|          _|_|      _|_|_|    _|_|_|  
//  _|        _|        _|    _|  _|        _|        
//  _|        _|        _|_|_|_|    _|_|      _|_|    
//  _|        _|        _|    _|        _|        _|  
//    _|_|_|  _|_|_|_|  _|    _|  _|_|_|    _|_|_|   

export class Scope {
  readonly path: NodePathT<ScopedNode>
  readonly parent: Scope | null
  readonly children: Scope[] = []
  private initialized = false
  bindings: Record<string, Binding | undefined> = Object.create(null)
  globalBindings: Record<string, GlobalBinding | undefined> = Object.create(null)
  labels: Record<string, Label | undefined> = Object.create(null)
  private priv = {
    prevState: null as (Omit<CrawlerState, 'scope' | 'childScopedPaths'> | null),
    memoizedBindings: Object.create(null) as Record<string, Binding | undefined>,
    memoizedLabels: Object.create(null) as Record<string, Label | undefined>,
    idMap: Object.create(null) as Record<string, number>,
    declaration: null as (NodePathT<'VariableDeclaration'> | null)
  }

  private constructor(path: NodePath, parentScope: Scope | null) {
    this.path = path as NodePathT<ScopedNode>
    this.parent = parentScope
    if (this.parent != null) this.parent.children.push(this)
  }

  static for(path: NodePath, parentScope: Scope | null): Scope | null {
    if (shouldMakeScope(path)) {
      if (path.ctx.scopeCache.has(path)) {
        return path.ctx.scopeCache.get(path)!
      }

      const scope = new Scope(path, parentScope)
      path.ctx.scopeCache.set(path, scope)
      return scope
    }

    return parentScope
  }

  init(): void {
    if (this.initialized) return
    if (this.path.type !== 'Program') {
      this.priv.idMap = this.getProgramScope().priv.idMap
    }
    this.crawl()
  }

  // Temporarily memoize stuffs. Improves performance in deep tree
  private getMemoBinding(bindingName: string) {
    const { memoizedBindings } = this.priv
    return bindingName in memoizedBindings
      ? memoizedBindings[bindingName]
      : (memoizedBindings[bindingName] = this.getBinding(bindingName))
  }
  private getMemoLabel(labelName: string) {
    const { memoizedLabels } = this.priv
    return labelName in memoizedLabels
      ? memoizedLabels[labelName]
      : (memoizedLabels[labelName] = this.getLabel(labelName))
  }
  private clearMemo() {
    this.priv.memoizedBindings = Object.create(null)
    this.priv.memoizedLabels = Object.create(null)
  }

  getProgramScope(): Scope {
    if (this.path.type === 'Program') {
      return this
    } else {
      return this.path.findParent((p) => p.type === 'Program')!.scope!
    }
  }

  crawl(): void {
    /* istanbul ignore next */
    if (this.path.node == null) return
    /* istanbul ignore next */
    if (this.path.removed) {
      throw Error('This scope is no longer part of the AST, the containing path has been removed')
    }

    // Rollback previous registrations
    // This will be used when re-crawling
    Scope.rollbackState(this)

    this.bindings = Object.create(null)
    this.globalBindings = this.path.type === 'Program' ? Object.create(null) : this.getProgramScope().globalBindings
    this.labels = Object.create(null)

    const state: CrawlerState = {
      references: [],
      constantViolations: [],
      labelReferences: [],
      scope: this,
      childScopedPaths: []
    }

    // Disable making scope for children or it will cause an infinite loop
    this.path.ctx.makeScope = false
    // Create a new skip path stack so that it won't affect the user's skip path stack
    this.path.ctx.newSkipPathStack()

    {
      const scopePathCrawler = scopePathCrawlers[this.path.node!.type]
      if (scopePathCrawler != null) {
        scopePathCrawler(this.path as NodePath<any>, state)
      }
    }

    Traverser.traverseNode({
      node: this.path.node,
      parentPath: this.path.parentPath,
      ctx: this.path.ctx,
      state,
      visitors: crawlerVisitor as ExpandedVisitors<CrawlerState>,
      expand: false,
      visitOnlyChildren: true
    })

    this.path.ctx.makeScope = true
    this.path.ctx.restorePrevSkipPathStack()

    this.clearMemo()

    {
      for (let i = 0; i < state.references.length; i++) {
        const path = state.references[i]
        const bindingName = path.node!.name
        const binding = this.getMemoBinding(bindingName)

        if (binding != null) {
          binding.addReference(path)
        } else {
          (
            this.globalBindings[bindingName] ||= new GlobalBinding({ name: bindingName })
          ).addReference(path)
        }
      }

      for (let i = 0; i < state.constantViolations.length; i++) {
        const path = state.constantViolations[i]
        const bindingName = path.node!.name
        const binding = this.getMemoBinding(bindingName)
        
        if (binding != null) {
          binding.addConstantViolation(path)
        } else {
          (
            this.globalBindings[bindingName] ||= new GlobalBinding({ name: bindingName })
          ).addConstantViolation(path)
        }
      }

      for (let i = 0; i < state.labelReferences.length; i++) {
        const path = state.labelReferences[i]
        const labelName = path.node!.name
        const label = this.getMemoLabel(labelName)

        if (label != null) {
          label.references.push(path)
        }
      }
    }

    this.initialized = true
    this.priv.prevState = {
      references: state.references,
      constantViolations: state.constantViolations,
      labelReferences: state.labelReferences
    }
    this.clearMemo()

    for (let i = 0; i < state.childScopedPaths.length; i++) {
      // Manually pass the parent scope,
      // as `childScopedPaths` parent node's `scope` property may not be set in this phase
      state.childScopedPaths[i].init(this)
    }
  }

  /** Rollback all the changes contributed by this scope
   * @internal
   */
  static rollbackState(scope: Scope) {
    const { prevState: state } = scope.priv
    if (state == null) return

    scope.clearMemo()

    for (let i = 0; i < state.references.length; i++) {
      const path = state.references[i]
      const bindingName = path.node!.name
      const binding = scope.getMemoBinding(bindingName)

      if (binding != null) {
        binding.removeReference(path)
      } else {
        const globalBinding = scope.globalBindings[bindingName]
        if (globalBinding != null) {
          globalBinding.removeReference(path)
        }
      }
    }

    for (let i = 0; i < state.constantViolations.length; i++) {
      const path = state.constantViolations[i]
      const bindingName = path.node!.name
      const binding = scope.getMemoBinding(bindingName)

      if (binding != null) {
        binding.removeConstantViolation(path)
      } else {
        const globalBinding = scope.globalBindings[bindingName]
        if (globalBinding != null) {
          globalBinding.removeConstantViolation(path)
        }
      }
    }

    for (let i = 0; i < state.labelReferences.length; i++) {
      const path = state.labelReferences[i]
      const labelName = path.node!.name
      const label = scope.getMemoLabel(labelName)

      if (label != null) {
        const idx = label.references.findIndex((x) => x === path)
        if (idx > -1) label.references.splice(idx, 1)
      }
    }

    const globalNames = Object.keys(scope.globalBindings)
    for (let i = 0; i < globalNames.length; i++) {
      const name = globalNames[i]
      const global = scope.globalBindings[name]!
      if (global.references.length === 0 && global.constantViolations.length === 0) {
        scope.globalBindings[name] = undefined
        delete scope.globalBindings[name]
      }
    }
  }

  /** @internal */
  static recursiveRollback(scope: Scope) {
    for (let i = 0; i < scope.children.length; i++) {
      Scope.recursiveRollback(scope.children[i])
    }
    Scope.rollbackState(scope)
  }

  /** @internal */
  static handleRemoval(scope: Scope, path: NodePath) {
    if (path === scope.path) {
      Scope.recursiveRollback(scope)
      if (scope.parent != null) {
        const { children } = scope.parent
        const idx = children.indexOf(scope)
        if (idx > -1) children.splice(idx, 1)
      }
    } else {
      for (let i = 0; i < scope.children.length; i++) {
        const child = scope.children[i]
        if (child.path.isDescendantOf(path)) {
          Scope.recursiveRollback(child)
          const idx = scope.children.indexOf(child)
          if (idx > -1) scope.children.splice(idx, 1)
        }
      }
    }
  }

  /** @internal */
  registerBinding<T extends BindingKind>(
    kind: T,
    identifierPath: NodePath<Identifier>,
    bindingPath: BindingPathT<T>
  ): void
  registerBinding(
    kind: string,
    identifierPath: NodePath<Identifier>,
    bindingPath: NodePath<any>
  ): void {
    const bindingName = identifierPath.node!.name
    const binding = this.getOwnBinding(bindingName)

    if (binding != null) {
      binding.addConstantViolation(identifierPath)
      return
    }

    this.bindings[bindingName] = new Binding({
      kind: kind as Binding['kind'],
      name: bindingName,
      scope: this,
      identifierPath,
      path: bindingPath
    })
  }

  hasOwnBinding(name: string): boolean {
    return name in this.bindings
  }

  getOwnBinding(name: string): Binding | undefined {
    return this.bindings[name]
  }

  hasBinding(name: string): boolean {
    return this.getBinding(name) != null
  }

  getBinding(name: string): Binding | undefined {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let scope: Scope | null = this
    while (scope != null) {
      if (scope.hasOwnBinding(name)) {
        return scope.getOwnBinding(name)
      }
      scope = scope.parent
    }
  }

  getAllBindings(...kind: BindingKind[]): Record<string, Binding> {
    const result = Object.create(null)
    const kindLength = kind.length
    const kindSet = new Set(kind)
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let scope: Scope | null = this
    while (scope != null) {
      for (const name in scope.bindings as Record<string, any>) {
        if (!(name in result)) {
          if (kindLength === 0 || (kindLength && kindSet.has(scope.bindings[name]!.kind))) {
            result[name] = scope.bindings[name]
          }
        }
      }
      scope = scope.parent
    }
    return result
  }

  hasGlobalBinding(name: string): boolean {
    return this.getGlobalBinding(name) != null
  }

  getGlobalBinding(name: string): GlobalBinding | undefined {
    return this.getProgramScope().globalBindings[name]
  }

  /** @internal */
  registerLabel(path: NodePath<Identifier, NodeT<'LabeledStatement'>>): void {
    const labelName = path.node!.name

    /* istanbul ignore next */
    if (this.hasLabel(labelName)) {
      // Label has already been declared
      // The parser should already inform the user about this
      // there's nothing to do in our side
      return
    }

    this.labels[labelName] = {
      path,
      references: []
    }
  }

  hasLabel(name: string): boolean {
    return this.getLabel(name) != null
  }

  getLabel(name: string): Label | undefined {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let scope: Scope | null = this
    while (scope != null) {
      if (scope.labels[name] != null) {
        return scope.labels[name]
      }
      scope = scope.parent
    }
  }

  generateUid(name = '_tmp') {
    const allIDs = Object.keys(this.getAllBindings())
      .concat(Object.keys(this.globalBindings))
      .concat(Object.keys(this.priv.idMap))
    this.priv.idMap[name] ||= 1
    let fName = name = name.replace(/[^a-zA-Z_]+/g, '')
    while (allIDs.includes(fName)) {
      fName = name + ++this.priv.idMap[name]
    }
    return fName
  }

  generateUidIdentifier(name?: string) {
    return b.identifier(this.generateUid(name))
  }

  generateDeclaredUidIdentifier(name?: string): NodeT<'Identifier'> {
    let declaratorPath: NodePathT<'VariableDeclarator'>
    const { ctx } = this.path

    ctx.newSkipPathStack()
    ctx.newQueue()

    if (this.priv.declaration == null) {
      // Get the closest block statement
      let block: NodePath | null = null

      switch (this.path.type) {
        case 'ArrowFunctionExpression':
          {
            const path = this.path as NodePathT<'ArrowFunctionExpression'>
            const body = path.get('body')
            if (body.type === 'BlockStatement') {
              block = body
            } else {
              const bodyNode = Object.assign({}, body.node) as AliasMap['Expression']
              block = body.replaceWith(b.blockStatement([b.returnStatement(bodyNode)]))
            }
          }
          break

        case 'Program':
        case 'BlockStatement':
          block = this.path
          break

        case 'SwitchStatement':
        case 'ClassDeclaration':
        case 'ClassExpression':
          ctx.restorePrevSkipPathStack()
          ctx.popQueue()
          return this.parent!.generateDeclaredUidIdentifier(name)

        case 'DoWhileStatement':
        case 'ForInStatement':
        case 'ForOfStatement':
        case 'ForStatement':
        case 'WhileStatement':
          {
            const path = this.path as NodePath<AliasMap['Loop']>
            const body = path.get('body')
            if (body.type === 'BlockStatement') {
              block = body
            } else {
              const bodyNode = Object.assign({}, body.node) as AliasMap['Statement']
              block = body.replaceWith(b.blockStatement([bodyNode]))
            }
          }
          break
        
        case 'CatchClause':
        case 'FunctionDeclaration':
        case 'FunctionExpression':
          block = (this.path as NodePath<AliasMap['Function'] | NodeT<'CatchClause'>>).get('body')
          break
        
        /* istanbul ignore next */
        case null: break
        /* istanbul ignore next */
        default: assertNever(this.path.type)
      }

      const declarationNode = b.variableDeclaration('var', [b.variableDeclarator(this.generateUidIdentifier(name))])
      const [declarationPath] = ((block as NodePathT<'BlockStatement'>)
        .unshiftContainer('body', [declarationNode]) as [NodePathT<'VariableDeclaration'>])
      this.priv.declaration = declarationPath
      declaratorPath = declarationPath.get('declarations')[0]
    } else {
      [declaratorPath] = this.priv.declaration.pushContainer('declarations', [b.variableDeclarator(this.generateUidIdentifier(name))])
    }

    const identifier = declaratorPath.get('id') as NodePathT<'Identifier'>

    this.registerBinding('var', identifier, declaratorPath)

    ctx.restorePrevSkipPathStack()
    ctx.popQueue()

    return Object.assign({}, identifier.node)
  }

  /** @internal */
  private renameConsideringParent(path: NodePath<Identifier>, newName: string) {
    const parent = path.parent!
    if (
      parent!.type === 'Property' &&
      path.parentPath?.parent?.type === 'ObjectPattern'
    ) {
      (parent.value as Identifier).name = newName
      parent.shorthand = (parent.value as Identifier).name === (parent.key as Identifier).name
    } else if (
      parent.type === 'AssignmentPattern' &&
      path.parentPath?.parent?.type === 'Property' &&
      path.parentPath.parentPath?.parent?.type === 'ObjectPattern'
    ) {
      const property = path.parentPath.parent
      parent.left = b.identifier(newName)
      property.shorthand = parent.left.name === (property.key as Identifier).name
    } else {
      path.node!.name = newName
    }
  }

  renameBinding(oldName: string, newName: string) {
    if (this.bindings[oldName] != null) {
      const binding = this.bindings[oldName]!

      this.renameConsideringParent(binding.identifierPath, newName)

      for (let i = 0; i < binding.references.length; i++) {
        binding.references[i].node!.name = newName
      }
      for (let i = 0; i < binding.constantViolations.length; i++) {
        this.renameConsideringParent(binding.constantViolations[i], newName)
      }

      this.bindings[oldName] = undefined
      delete this.bindings[oldName]
      this.bindings[newName] = binding
    } else {
      this.parent?.renameBinding(oldName, newName)
    }
  }
}
