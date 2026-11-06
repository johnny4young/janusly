/**
 * Production-only pruning of GoTrueClient methods Janusly cannot reach.
 *
 * The class is one tree-shaking unit, so MFA, passkey, OAuth-server, Web3, SSO
 * and admin code would ship unused. Reachability starts at the public methods
 * `src/auth.ts` calls; a reached reference to a removed cluster fails the build.
 */

import { parseSync } from 'oxc-parser'

const AUTH_MODULE = /\/@supabase\/auth-js\/dist\/module\/(GoTrueClient|GoTrueAdminApi)\.js$/
const TARGETS = {
  GoTrueClient: {
    roots: ['getSession', 'onAuthStateChange', 'resetPasswordForEmail', 'setSession', 'signInWithPassword', 'signOut', 'signUp', 'updateUser'],
    clusters: ['mfa', 'oauth', 'passkey'],
    delegates: { admin: ['signOut'] },
  },
  GoTrueAdminApi: {
    roots: ['signOut'],
    clusters: ['mfa', 'oauth', 'customProviders', 'passkey'],
    delegates: {},
  },
}

export const AUTH_CLIENT_ROOTS = TARGETS.GoTrueClient.roots

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  if (typeof node.type === 'string') visit(node)
  for (const key of Object.keys(node)) {
    if (key !== 'parent') walk(node[key], visit)
  }
}

const isNamedMethod = (member) => (
  member.type === 'MethodDefinition' && !member.static && !member.computed && Boolean(member.key.name)
)
const isThis = (node) => node?.type === 'ThisExpression' || node?.name === '_this'
const isThisMember = (node) => node?.type === 'MemberExpression' && !node.computed && isThis(node.object)

/**
 * The `this.x` names a member reads. Any other use of `this`, or of a delegate
 * beyond its kept methods, could reach a removed method unseen, so it fails the build.
 */
function collectReferences(owner, node, delegates, skipped) {
  const references = new Set()
  const understood = new Set()
  const isSkipped = (child) => skipped.some(([start, end]) => child.start >= start && child.end <= end)
  walk(node, (child) => {
    if (isSkipped(child)) return
    if (child.type === 'CallExpression' && child.callee.property?.name === 'bind' && isThisMember(child.callee.object)) {
      for (const argument of child.arguments) if (isThis(argument)) understood.add(argument)
    }
    if (child.type === 'ReturnStatement' && isThis(child.argument)) understood.add(child.argument)
    if (child.type === 'MemberExpression' && isThisMember(child.object) && delegates[child.object.property.name]) {
      if (child.computed || !delegates[child.object.property.name].includes(child.property.name)) {
        throw new Error(`${owner} needs this.${child.object.property.name}.${child.property.name}`)
      }
      understood.add(child.object)
    }
    if (child.type === 'AssignmentExpression' && isThisMember(child.left) && delegates[child.left.property.name]) {
      understood.add(child.left)
    }
    if (isThisMember(child)) {
      references.add(child.property.name)
      understood.add(child.object)
      if (delegates[child.property.name] && !understood.has(child)) {
        throw new Error(`${owner} uses this.${child.property.name} directly`)
      }
    } else if (isThis(child) && !understood.has(child)) {
      throw new Error(`${owner} uses this indirectly`)
    }
  })
  return references
}

export function pruneAuthClass(code, className) {
  const { roots, clusters, delegates } = TARGETS[className]
  const removedClusters = new Set(clusters)
  const { program } = parseSync(`${className}.js`, code, { sourceType: 'module' })
  let body = null
  walk(program, (node) => {
    if (node.type === 'ClassDeclaration' && node.id?.name === className) body = node.body.body
  })
  if (!body) throw new Error(`${className} class not found`)

  const methods = new Map()
  for (const member of body) {
    if (!isNamedMethod(member)) continue
    methods.set(member.key.name, [...(methods.get(member.key.name) ?? []), member])
  }
  const [ctor] = methods.get('constructor')
  const removals = []
  for (const statement of ctor.value.body.body) {
    const target = statement.expression?.left
    if (
      statement.type === 'ExpressionStatement'
      && target?.type === 'MemberExpression'
      && target.object.type === 'ThisExpression'
      && removedClusters.has(target.property.name)
    ) removals.push([statement.start, statement.end])
  }

  const kept = new Set(['constructor', ...roots])
  const queue = [...kept]
  const enqueue = (owner, node, skipped) => {
    for (const reference of collectReferences(owner, node, delegates, skipped)) {
      if (removedClusters.has(reference)) throw new Error(`${owner} needs this.${reference}`)
      if (methods.has(reference) && !kept.has(reference)) {
        kept.add(reference)
        queue.push(reference)
      }
    }
  }
  // Fields, statics and computed methods stay in the output, so whatever they reach must too.
  enqueue(`${className} field`, body.filter((member) => !isNamedMethod(member)), [])
  while (queue.length > 0) {
    const name = queue.pop()
    const definitions = methods.get(name)
    if (!definitions) throw new Error(`${className} has no method ${name}`)
    enqueue(`${className}.${name}`, definitions, name === 'constructor' ? removals : [])
  }

  for (const [name, definitions] of methods) {
    if (kept.has(name)) continue
    for (const { start, end } of definitions) removals.push([start, end])
  }
  let result = ''
  let cursor = 0
  for (const [start, end] of removals.sort((a, b) => a[0] - b[0])) {
    result += code.slice(cursor, start)
    cursor = end
  }
  return { code: result + code.slice(cursor), kept: [...kept].sort(), removed: [...methods.keys()].filter((name) => !kept.has(name)).sort() }
}

export function pruneAuthClient() {
  return {
    name: 'janusly-prune-auth-client',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      const match = AUTH_MODULE.exec(id)
      if (!match) return null
      return { code: pruneAuthClass(code, match[1]).code, map: null }
    },
  }
}
