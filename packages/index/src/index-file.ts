/**
 * A search index is just a file: documents plus a term -> postings map.
 *
 * What makes it a real engine rather than a filter:
 *
 *   - stemming, so "tomatoes" and "tomato" are the same term
 *   - positions, so "slow garden" can be a phrase, not two loose words
 *   - BM25, so long pages don't win just by being long
 *   - boolean clauses: +must, -must-not, title:word, "exact phrase", a OR b
 *
 * It is small because OpenWeb is small. No personalization, no click tracking,
 * no ranking model you can't read in one sitting.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { analyze, type Token } from './extract.js'

export interface Document {
  address: string
  path: string
  title: string
  text: string
}

/** [document index, term frequency, positions in the body] */
export type Posting = [doc: number, tf: number, positions: number[]]

export interface IndexFile {
  version: 2
  built: number
  documents: Document[]
  /** Body token count per document, for BM25 length normalization. */
  lengths: number[]
  avgLength: number
  /** Stemmed title terms per document. */
  titles: string[][]
  postings: Record<string, Posting[]>
}

export interface SearchResult {
  document: Document
  score: number
  snippet: string
}

export interface SearchResponse {
  results: SearchResult[]
  total: number
  matchedTerms: string[]
}

const K1 = 1.2
const B = 0.75
const TITLE_BOOST = 2.2
const PHRASE_BOOST = 1.4

export function buildIndex(documents: Document[]): IndexFile {
  const postings: Record<string, Posting[]> = {}
  const lengths: number[] = []
  const titles: string[][] = []
  let totalLength = 0

  documents.forEach((document, docIndex) => {
    const body = analyze(document.text)
    const titleTokens = analyze(document.title)

    lengths.push(body.length)
    totalLength += body.length

    const titleTerms = [...new Set(titleTokens.map((token) => token.term))]
    titles.push(titleTerms)

    const bodyTerms = new Map<string, number[]>()
    for (const token of body) {
      const positions = bodyTerms.get(token.term)
      if (positions) positions.push(token.position)
      else bodyTerms.set(token.term, [token.position])
    }

    for (const [term, positions] of bodyTerms) {
      ;(postings[term] ??= []).push([docIndex, positions.length, positions])
    }

    // Title-only terms still have to be findable by a normal query.
    const titleCounts = new Map<string, number>()
    for (const token of titleTokens) {
      titleCounts.set(token.term, (titleCounts.get(token.term) ?? 0) + 1)
    }
    for (const [term, count] of titleCounts) {
      if (bodyTerms.has(term)) continue
      ;(postings[term] ??= []).push([docIndex, count, []])
    }
  })

  return {
    version: 2,
    built: Date.now(),
    documents,
    lengths,
    avgLength: documents.length === 0 ? 0 : totalLength / documents.length,
    titles,
    postings,
  }
}

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

interface Clause {
  terms: string[]
  phrase: boolean
  negated: boolean
  titleOnly: boolean
}

export function parseQuery(input: string): Clause[][] {
  const groups: Clause[][] = [[]]

  for (const piece of splitClauses(input)) {
    if (piece.toUpperCase() === 'OR') {
      if (groups[groups.length - 1]?.length) groups.push([])
      continue
    }

    let raw = piece
    if (raw.startsWith('+')) raw = raw.slice(1)
    const negated = raw.startsWith('-')
    if (negated) raw = raw.slice(1)

    let titleOnly = false
    if (/^title:/i.test(raw)) {
      titleOnly = true
      raw = raw.slice(6)
    }

    const phrase = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2
    const body = phrase ? raw.slice(1, -1) : raw

    const terms = analyze(body).map((token) => token.term)
    if (terms.length === 0) continue

    groups[groups.length - 1]?.push({
      terms,
      phrase: phrase && terms.length > 1,
      negated,
      titleOnly,
    })
  }

  return groups.filter((group) => group.length > 0)
}

/** Splits on whitespace but keeps quoted strings together. */
function splitClauses(input: string): string[] {
  const pieces: string[] = []
  let current = ''
  let quoted = false

  for (const char of input.trim()) {
    if (char === '"') {
      quoted = !quoted
      current += char
    } else if (!quoted && /\s/.test(char)) {
      if (current !== '') {
        pieces.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }
  if (current !== '') pieces.push(current)
  return pieces
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export function queryIndex(index: IndexFile, query: string, limit = 10): SearchResult[] {
  return search(index, query, limit).results
}

export function search(index: IndexFile, query: string, limit = 10): SearchResponse {
  const groups = parseQuery(query)
  if (groups.length === 0 || index.documents.length === 0) {
    return { results: [], total: 0, matchedTerms: [] }
  }

  const top = new TopScores(limit)
  const matchedTerms = new Set<string>()
  let total = 0

  if (groups.length === 1) {
    const group = groups[0]!
    executeGroup(index, group, (doc, score) => {
      total++
      top.add(doc, score)
    })
    collectTerms(group, matchedTerms)
  } else {
    // OR: the best score from any branch wins.
    const combined = new Map<number, number>()
    for (const group of groups) {
      executeGroup(index, group, (doc, score) => {
        const existing = combined.get(doc)
        if (existing === undefined || score > existing) combined.set(doc, score)
      })
      collectTerms(group, matchedTerms)
    }

    for (const [doc, score] of combined) {
      total++
      top.add(doc, score)
    }
  }

  // Only the top `limit` need sorting; keeping a small heap avoids sorting
  // every match when a common word hits tens of thousands of pages.
  const ranked = top.values().sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    const left = index.documents[a[0]]
    const right = index.documents[b[0]]
    return `${left?.title}${left?.path}`.localeCompare(`${right?.title}${right?.path}`)
  })

  const results = ranked.map(([doc, score]) => {
    const document = index.documents[doc]
    if (!document) throw new Error(`index references missing document ${doc}`)
    return {
      document,
      score,
      snippet: makeSnippet(document.text, query),
    }
  })

  return { results, total, matchedTerms: [...matchedTerms] }
}

function collectTerms(group: Clause[], into: Set<string>): void {
  for (const clause of group) {
    if (clause.negated) continue
    for (const term of clause.terms) into.add(term)
  }
}

/**
 * A posting list is sorted by document id because it was built in document
 * order. Query execution advances a cursor over each list instead of copying
 * it into a Map: one pass per list, no per-query hash tables.
 */
interface TermCursor {
  term: string
  list: Posting[]
  at: number
  /** Precomputed BM25 idf: same for every document in the list. */
  idf: number
  titleList: number[] | null
  titleAt: number
}

interface ClauseCursor {
  clause: Clause
  terms: TermCursor[]
}

/**
 * Walks the rarest positive term's postings once and reports every document
 * that satisfies all clauses. There are no intermediate result arrays: the
 * caller decides whether to keep a top-K heap or merge OR branches.
 */
function executeGroup(
  index: IndexFile,
  group: Clause[],
  onMatch: (doc: number, score: number) => void,
): void {
  const positive = group.filter((clause) => !clause.negated)
  const negative = group.filter((clause) => clause.negated)

  const titles = titlePostings(index)
  const positivePlans = prepareClauses(index, positive, titles)
  if (positivePlans === null) return
  const negativePlans = prepareNegative(index, negative, titles)
  const norms = lengthNorms(index)

  // Only negative clauses: every document is a candidate.
  if (positivePlans.length === 0) {
    for (let doc = 0; doc < index.documents.length; doc++) {
      if (!isExcluded(negativePlans, norms, doc)) onMatch(doc, 0)
    }
    return
  }

  // Drive the scan from the rarest term across all positive clauses. Every
  // other cursor advances monotonically against the same document ids.
  const driver = rarestTerm(positivePlans)
  if (!driver) return

  for (const posting of driver.list) {
    const doc = posting[0]
    let score = 0
    let ok = true

    for (const plan of positivePlans) {
      const clauseScore = scoreClause(norms, plan, doc)
      if (clauseScore === null) {
        ok = false
        break
      }
      score += clauseScore
    }

    if (!ok || isExcluded(negativePlans, norms, doc)) continue
    onMatch(doc, score)
  }
}

/** Resolves clause terms to posting lists, or null if a positive term is absent. */
function prepareClauses(
  index: IndexFile,
  clauses: Clause[],
  titles: Record<string, number[]>,
): ClauseCursor[] | null {
  const plans: ClauseCursor[] = []

  for (const clause of clauses) {
    const plan = prepareClause(index, clause, titles)
    if (!plan) return null
    plans.push(plan)
  }

  return plans
}

/** Negative clauses that can never match are dropped, not treated as fatal. */
function prepareNegative(
  index: IndexFile,
  clauses: Clause[],
  titles: Record<string, number[]>,
): ClauseCursor[] {
  const plans: ClauseCursor[] = []
  for (const clause of clauses) {
    const plan = prepareClause(index, clause, titles)
    if (plan) plans.push(plan)
  }
  return plans
}

function prepareClause(
  index: IndexFile,
  clause: Clause,
  titles: Record<string, number[]>,
): ClauseCursor | null {
  const terms: TermCursor[] = []
  const total = index.documents.length

  for (const term of clause.terms) {
    const list = index.postings[term]
    if (!list || list.length === 0) return null

    const df = list.length
    terms.push({
      term,
      list,
      at: 0,
      idf: Math.log(1 + (total - df + 0.5) / (df + 0.5)),
      titleList: titles[term] ?? null,
      titleAt: 0,
    })
  }

  return { clause, terms }
}

function rarestTerm(plans: ClauseCursor[]): TermCursor | null {
  let best: TermCursor | null = null
  for (const plan of plans) {
    for (const term of plan.terms) {
      if (!best || term.list.length < best.list.length) best = term
    }
  }
  return best
}

/** Advances a cursor to `doc`. Lists are sorted, and docs arrive in order. */
function postingAt(cursor: TermCursor, doc: number): Posting | null {
  const list = cursor.list
  while (cursor.at < list.length && list[cursor.at]![0] < doc) cursor.at++
  const posting = list[cursor.at]
  return posting !== undefined && posting[0] === doc ? posting : null
}

/** Score for one clause at one document, or null when the clause misses. */
function scoreClause(norms: Float64Array, plan: ClauseCursor, doc: number): number | null {
  const { clause, terms } = plan

  if (clause.titleOnly && !allTitleTerms(plan, doc)) return null

  const phrase = clause.phrase
  const positions: number[][] | null = phrase ? [] : null
  let score = 0

  for (const cursor of terms) {
    const posting = postingAt(cursor, doc)
    if (!posting) return null

    if (positions) positions.push(posting[2])
    score += scoreTerm(posting[1], cursor.idf, norms[doc] ?? K1, titleAt(cursor, doc))
  }

  if (positions) {
    if (!hasPhrase(positions)) return null
    score *= PHRASE_BOOST
  }

  return score
}

function isExcluded(plans: ClauseCursor[], norms: Float64Array, doc: number): boolean {
  for (const plan of plans) {
    if (scoreClause(norms, plan, doc) !== null) return true
  }
  return false
}

/** True when the term is in this document's title. Cursor-based, like postings. */
function titleAt(cursor: TermCursor, doc: number): boolean {
  const list = cursor.titleList
  if (!list) return false
  while (cursor.titleAt < list.length && list[cursor.titleAt]! < doc) cursor.titleAt++
  return list[cursor.titleAt] === doc
}

function allTitleTerms(plan: ClauseCursor, doc: number): boolean {
  for (const cursor of plan.terms) {
    if (!titleAt(cursor, doc)) return false
  }
  return true
}

/**
 * Title terms as sorted posting lists, built once per index. Checking a title
 * becomes a cursor advance instead of an Array.includes per candidate.
 */
const TITLE_CACHE = new WeakMap<IndexFile, Record<string, number[]>>()

function titlePostings(index: IndexFile): Record<string, number[]> {
  const cached = TITLE_CACHE.get(index)
  if (cached) return cached

  const titles: Record<string, number[]> = {}
  for (let doc = 0; doc < index.titles.length; doc++) {
    const terms = index.titles[doc]
    if (!terms) continue
    for (const term of terms) (titles[term] ??= []).push(doc)
  }

  TITLE_CACHE.set(index, titles)
  return titles
}

/**
 * BM25 length normalization depends only on the index, never on the query.
 * Cache it per index object; the gateway already caches the index by mtime.
 */
const NORM_CACHE = new WeakMap<IndexFile, Float64Array>()

function lengthNorms(index: IndexFile): Float64Array {
  const cached = NORM_CACHE.get(index)
  if (cached) return cached

  const norms = new Float64Array(index.documents.length)
  const average = index.avgLength || 1
  for (let doc = 0; doc < norms.length; doc++) {
    const length = index.lengths[doc] ?? 1
    norms[doc] = K1 * (1 - B + (B * length) / average)
  }

  NORM_CACHE.set(index, norms)
  return norms
}

function scoreTerm(tf: number, idf: number, norm: number, inTitle: boolean): number {
  const effectiveTf = tf > 0 ? tf : 0.5
  const weight = (effectiveTf * (K1 + 1)) / (effectiveTf + norm || 1)
  return idf * weight * (inTitle ? TITLE_BOOST : 1)
}

/**
 * Keeps the best `limit` scores in a binary min-heap of parallel arrays. The
 * root is the worst kept result, so a new score usually costs one comparison.
 * Parallel arrays matter: a tuple per candidate would allocate on every match.
 */
class TopScores {
  private readonly docs: number[] = []
  private readonly scores: number[] = []
  private readonly limit: number

  constructor(limit: number) {
    this.limit = Math.max(0, limit)
  }

  add(doc: number, score: number): void {
    if (this.limit === 0) return

    if (this.docs.length < this.limit) {
      this.docs.push(doc)
      this.scores.push(score)
      this.siftUp(this.docs.length - 1)
      return
    }

    if (worse(score, doc, this.scores[0]!, this.docs[0]!)) {
      this.docs[0] = doc
      this.scores[0] = score
      this.siftDown(0)
    }
  }

  values(): Array<[number, number]> {
    return this.docs.map((doc, index) => [doc, this.scores[index]!])
  }

  private siftUp(start: number): void {
    let child = start
    while (child > 0) {
      const parent = (child - 1) >> 1
      if (!worse(this.scores[child]!, this.docs[child]!, this.scores[parent]!, this.docs[parent]!)) {
        break
      }
      this.swap(child, parent)
      child = parent
    }
  }

  private siftDown(start: number): void {
    let parent = start
    for (;;) {
      const left = parent * 2 + 1
      const right = left + 1
      let worst = parent

      if (
        left < this.docs.length &&
        worse(this.scores[left]!, this.docs[left]!, this.scores[worst]!, this.docs[worst]!)
      ) {
        worst = left
      }
      if (
        right < this.docs.length &&
        worse(this.scores[right]!, this.docs[right]!, this.scores[worst]!, this.docs[worst]!)
      ) {
        worst = right
      }
      if (worst === parent) return

      this.swap(parent, worst)
      parent = worst
    }
  }

  private swap(a: number, b: number): void {
    const doc = this.docs[a]!
    const score = this.scores[a]!
    this.docs[a] = this.docs[b]!
    this.scores[a] = this.scores[b]!
    this.docs[b] = doc
    this.scores[b] = score
  }
}

function worse(
  scoreA: number,
  docA: number,
  scoreB: number,
  docB: number,
): boolean {
  if (scoreA !== scoreB) return scoreA < scoreB
  return docA > docB
}

function hasPhrase(positions: number[][]): boolean {
  const first = positions[0]
  if (!first || first.length === 0) return false

  for (const start of first) {
    let matched = true
    for (let i = 1; i < positions.length; i++) {
      if (!positions[i]?.includes(start + i)) {
        matched = false
        break
      }
    }
    if (matched) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Snippets and storage
// ---------------------------------------------------------------------------

function makeSnippet(text: string, query: string, length = 180): string {
  const lower = text.toLowerCase()
  const words = query
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((word) => word.length > 2) ?? []

  let at = -1
  for (const word of words) {
    const found = lower.indexOf(word)
    if (found !== -1 && (at === -1 || found < at)) at = found
  }

  const start = Math.max(0, (at === -1 ? 0 : at) - 60)
  const piece = text.slice(start, start + length)
  return `${start > 0 ? '…' : ''}${piece}${start + length < text.length ? '…' : ''}`
}

export function saveIndex(index: IndexFile, file: string): void {
  writeFileSync(file, JSON.stringify(index))
}

export function loadIndex(file: string): IndexFile {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as IndexFile
    if (parsed.version !== 2) return emptyIndex()
    return parsed
  } catch {
    return emptyIndex()
  }
}

export function emptyIndex(): IndexFile {
  return {
    version: 2,
    built: 0,
    documents: [],
    lengths: [],
    avgLength: 0,
    titles: [],
    postings: {},
  }
}

export function mergeDocuments(
  previous: IndexFile | null,
  documents: Document[],
): Document[] {
  const merged = new Map<string, Document>()
  for (const document of previous?.documents ?? []) {
    merged.set(`${document.address}${document.path}`, document)
  }
  for (const document of documents) {
    merged.set(`${document.address}${document.path}`, document)
  }
  return [...merged.values()]
}

export function analyzeDocument(title: string, text: string): Token[] {
  return [...analyze(title), ...analyze(text)]
}
