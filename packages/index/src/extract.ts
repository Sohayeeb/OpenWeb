/**
 * Turning HTML into something searchable. Deliberately dumb: no DOM, no parser,
 * no ML. Regex over tags worked for the first search engines and it is enough
 * for a web where pages are hand-written.
 */

import { isAddress, parseGatewayPath, parseOpenWebUrl } from '@openweb/core'
import { stem } from './stem.js'

export interface Link {
  address: string
  path: string
}

export interface Token {
  term: string
  position: number
}

export interface ExtractedPage {
  title: string
  text: string
  links: Link[]
}

export function extractPage(
  html: string,
  baseAddress: string,
  basePath = '/',
): ExtractedPage {
  const title = decodeEntities(
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '',
  ).trim()

  const body = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')

  const text = decodeEntities(body.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()

  return { title, text, links: extractLinks(html, baseAddress, basePath) }
}

export function extractLinks(
  html: string,
  baseAddress: string,
  basePath = '/',
): Link[] {
  const links: Link[] = []
  const pattern = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi

  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    const href = match[1] ?? match[2] ?? match[3] ?? ''
    const link = resolveLink(href, baseAddress, basePath)
    if (link) links.push(link)
  }
  return links
}

/**
 * Relative links are resolved against the page they appear on, not the site
 * root — `/sub/page.html` + `other.html` is `/sub/other.html`, not `/other.html`.
 */
export function resolveLink(
  href: string,
  baseAddress: string,
  basePath = '/',
): Link | null {
  const value = href.trim()
  if (value === '' || value.startsWith('#')) return null
  if (/^(mailto|javascript|data|tel):/i.test(value)) return null

  const openweb = parseOpenWebUrl(value)
  if (openweb) return openweb

  const gateway = parseGatewayPath(value)
  if (gateway) return gateway

  if (/^https?:\/\//i.test(value) || value.startsWith('//')) return null

  try {
    const url = new URL(value, `openweb://${baseAddress}${basePath}`)
    if (url.protocol !== 'openweb:') return null
    if (!isAddress(url.hostname)) return null
    return { address: url.hostname, path: url.pathname || '/' }
  } catch {
    return null
  }
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code.startsWith('#')) {
      const hex = code[1] === 'x' || code[1] === 'X'
      const value = Number.parseInt(hex ? code.slice(2) : code.slice(1), hex ? 16 : 10)
      try {
        return String.fromCodePoint(value)
      } catch {
        return whole
      }
    }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}

const STOPWORDS = new Set(
  `a an and are as at be but by can do does for from had has have how i if in into is it
   its just me my no not of on or our so than that the their them then there these they
   this to too up was we were what when where which who why will with you your`
    .split(/\s+/)
    .filter(Boolean),
)

/**
 * Tokens, stemmed, with their position in the surviving stream. Positions are
 * what make phrase queries ("slow garden") possible.
 */
export function analyze(text: string): Token[] {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []
  const tokens: Token[] = []
  let position = 0

  for (const raw of words) {
    // "don't" and "slow-growing" should be findable as dont / slowgrowing.
    const word = raw.replace(/'s$/, '').replace(/['-]/g, '')
    if (word.length <= 1 || STOPWORDS.has(word)) continue
    tokens.push({ term: stem(word), position })
    position++
  }

  return tokens
}

export function analyzeQuery(text: string): string[] {
  return analyze(text).map((token) => token.term)
}
