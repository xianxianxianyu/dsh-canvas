/**
 * A strict JSON parser (RFC 8259: no comments, no trailing commas) that remembers where every
 * value sits in the text, so a board can be validated with `line:column` and rewritten one
 * element at a time. Offsets are UTF-16 indexes into the string, end exclusive.
 */

interface Span {
  readonly start: number
  readonly end: number
}

export interface JsonMember {
  readonly key: string
  /** The key's quoted text, `"x"`. */
  readonly keySpan: Span
  readonly value: JsonNode
}

export type JsonNode = Span & (
  | { readonly kind: 'object'; readonly members: readonly JsonMember[] }
  | { readonly kind: 'array'; readonly items: readonly JsonNode[] }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
)

export type JsonParse =
  | { readonly ok: true; readonly root: JsonNode }
  | { readonly ok: false; readonly offset: number; readonly message: string }

class SyntaxProblem {
  readonly offset: number
  readonly message: string

  constructor(offset: number, message: string) {
    this.offset = offset
    this.message = message
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const LITERALS = [['true', true], ['false', false], ['null', null]] as const

/** The comma just before `at` (whitespace between), so a trailing comma is reported where it is. */
function commaBefore(text: string, at: number): number {
  let index = at - 1
  while (index > 0 && text[index] !== ',') index--
  return index
}

/**
 * Parse `text` as one JSON value.
 * @param text - the whole file.
 * @returns the value tree with spans, or the first syntax problem and its offset.
 */
export function parseJson(text: string): JsonParse {
  let at = 0
  const fail = (message: string, offset = at): never => { throw new SyntaxProblem(offset, `JSON 语法错误：${message}`) }
  const space = (): void => {
    while (at < text.length && (text[at] === ' ' || text[at] === '\t' || text[at] === '\n' || text[at] === '\r')) at++
  }

  const string = (): JsonNode & { readonly kind: 'string' } => {
    const start = at++
    for (;;) {
      if (at >= text.length) fail('字符串没有结束', start)
      const code = text.charCodeAt(at)
      if (code === 0x22) break
      if (code === 0x0a || code === 0x0d) fail('字符串里不能直接换行（写成 \\n）')
      if (code < 0x20) fail('字符串里不能有控制字符')
      if (code === 0x5c) {
        const escape = text[at + 1]
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(at + 2, at + 6))) fail('\\u 后面要跟 4 位十六进制数')
          at += 6
        } else if (escape !== undefined && '"\\/bfnrt'.includes(escape)) at += 2
        else fail('无效的转义')
      } else at++
    }
    at++
    return { kind: 'string', start, end: at, value: JSON.parse(text.slice(start, at)) as string }
  }

  const value = (): JsonNode => {
    space()
    const start = at
    const char = text[at]
    if (char === '{') {
      at++
      const members: JsonMember[] = []
      space()
      if (text[at] === '}') return { kind: 'object', start, end: ++at, members }
      for (;;) {
        space()
        if (text[at] !== '"') {
          if (members.length && text[at] === '}') fail('最后一项后面多了 ,', commaBefore(text, at))
          fail('这里应该是用双引号括起来的键')
        }
        const key = string()
        space()
        if (text[at] !== ':') fail('键后面应该是 :')
        at++
        members.push({ key: key.value, keySpan: { start: key.start, end: key.end }, value: value() })
        space()
        if (text[at] === ',') { at++; continue }
        if (text[at] === '}') return { kind: 'object', start, end: ++at, members }
        fail('这里应该是 , 或 }')
      }
    }
    if (char === '[') {
      at++
      const items: JsonNode[] = []
      space()
      if (text[at] === ']') return { kind: 'array', start, end: ++at, items }
      for (;;) {
        space()
        if (items.length && text[at] === ']') fail('最后一项后面多了 ,', commaBefore(text, at))
        items.push(value())
        space()
        if (text[at] === ',') { at++; continue }
        if (text[at] === ']') return { kind: 'array', start, end: ++at, items }
        fail('这里应该是 , 或 ]')
      }
    }
    if (char === '"') return string()
    NUMBER.lastIndex = at
    const number = NUMBER.exec(text)
    if (number) {
      at += number[0].length
      return { kind: 'number', start, end: at, value: Number(number[0]) }
    }
    for (const [word, literal] of LITERALS) {
      if (text.startsWith(word, at)) {
        at += word.length
        return literal === null ? { kind: 'null', start, end: at } : { kind: 'boolean', start, end: at, value: literal }
      }
    }
    return fail('这里应该是一个值')
  }

  try {
    const root = value()
    space()
    if (at < text.length) fail('画板对象结束后还有多余的内容')
    return { ok: true, root }
  } catch (error) {
    if (!(error instanceof SyntaxProblem)) throw error
    return { ok: false, offset: error.offset, message: error.message }
  }
}

/** The plain value of a node, as `JSON.parse` would give it (a repeated key keeps its last value). */
export function plainOf(node: JsonNode): unknown {
  switch (node.kind) {
    case 'object': return Object.fromEntries(node.members.map(member => [member.key, plainOf(member.value)]))
    case 'array': return node.items.map(plainOf)
    case 'null': return null
    default: return node.value
  }
}

/**
 * 1-based line and column of an offset, and the line itself with a caret under the column (tabs
 * shown as one space, long lines cut to a window around the column).
 */
export function locate(text: string, offset: number): { readonly line: number; readonly column: number; readonly snippet: string } {
  const lineStart = offset === 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1
  const newline = text.indexOf('\n', offset)
  const source = text.slice(lineStart, newline === -1 ? text.length : newline).replace(/\r$/u, '').replaceAll('\t', ' ')
  const line = text.slice(0, lineStart).split('\n').length
  const column = offset - lineStart + 1
  const from = Math.max(0, column - 61)
  const shown = `${from > 0 ? '…' : ''}${source.slice(from, column + 59)}${column + 59 < source.length ? '…' : ''}`
  return { line, column, snippet: `${shown}\n${'-'.repeat(column - 1 - from + (from > 0 ? 1 : 0))}^` }
}
