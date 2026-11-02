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
import {
  expandGroups,
  parseQuery,
  rankSuggestions,
  type Clause,
  type TermLookup,
  type TermSuggestion,
} from './query.js'

export { parseQuery } from './query.js'
export type { Clause } from './query.js'

import {
  B,
  K1,
  PHRASE_BOOST,
  TITLE_BOOST,
  TopScores,
  hasPhrase,
  makeSnippet,
  scoreTerm,
} from './ranking.js'

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
// Query parsing lives in query.ts; expansion is applied below.
// ---------------------------------------------------------------------------

export function queryIndex(index: IndexFile, query: string, limit = 10): SearchResult[] {
  return search(index, query, limit).results
}

export function search(index: IndexFile, query: string, limit = 10): SearchResponse {
  const parsed = parseQuery(query)
  if (parsed.length === 0 || index.documents.length === 0) {
    return { results: [], total: 0, matchedTerms: [] }
  }

  const groups = expandGroups(parsed, memoryLookup(index))

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
    for (let i = 0; i < clause.terms.length; i++) {
      const alternatives = clause.alternatives?.[i] ?? [clause.terms[i]!]
      for (const term of alternatives) into.add(term)
    }
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

interface AlternativeCursor {
  cursor: TermCursor
  weight: number
}

interface TokenPlan {
  alternatives: AlternativeCursor[]
}

interface ClauseCursor {
  clause: Clause
  tokens: TokenPlan[]
}

/**
 * Walks the rarest positive token's alternatives once and reports every
 * document that satisfies all clauses. There are no intermediate result
 * arrays: the caller decides whether to keep a top-K heap or merge OR branches.
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

  // Drive the scan from the rarest token (counting all of its alternatives).
  // Every other cursor advances monotonically against the same document ids.
  const driver = rarestToken(positivePlans)
  if (!driver) return

  for (const doc of unionDocuments(driver)) {
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
  const tokens: TokenPlan[] = []
  const total = index.documents.length

  for (let i = 0; i < clause.terms.length; i++) {
    // Phrases stay exact; they are about adjacency, not similarity.
    const candidates = clause.phrase
      ? [clause.terms[i]!]
      : (clause.alternatives?.[i] ?? [clause.terms[i]!])
    const weights = clause.phrase ? [1] : (clause.weights?.[i] ?? candidates.map(() => 1))
    const alternatives: AlternativeCursor[] = []

    for (let j = 0; j < candidates.length; j++) {
      const term = candidates[j]!
      const list = index.postings[term]
      if (!list || list.length === 0) continue

      const df = list.length
      alternatives.push({
        cursor: {
          term,
          list,
          at: 0,
          idf: Math.log(1 + (total - df + 0.5) / (df + 0.5)),
          titleList: titles[term] ?? null,
          titleAt: 0,
        },
        weight: weights[j] ?? 1,
      })
    }

    if (alternatives.length === 0) return null
    tokens.push({ alternatives })
  }

  return { clause, tokens }
}

function rarestToken(plans: ClauseCursor[]): TokenPlan | null {
  let best: TokenPlan | null = null
  let bestLength = Infinity

  for (const plan of plans) {
    for (const token of plan.tokens) {
      let length = 0
      for (const alternative of token.alternatives) length += alternative.cursor.list.length
      if (length < bestLength) {
        bestLength = length
        best = token
      }
    }
  }
  return best
}

/**
 * Merge the sorted posting lists of one token's alternatives. Documents that
 * match any synonym or fuzzy candidate become candidates; duplicates are
 * yielded once.
 */
function* unionDocuments(token: TokenPlan): Generator<number> {
  const lists = token.alternatives.map((alternative) => alternative.cursor.list)
  const at = lists.map(() => 0)
  let previous = -1

  for (;;) {
    let next = Infinity
    for (let i = 0; i < lists.length; i++) {
      const posting = lists[i]![at[i]!]
      if (posting && posting[0] < next) next = posting[0]
    }
    if (next === Infinity) return

    for (let i = 0; i < lists.length; i++) {
      const posting = lists[i]![at[i]!]
      if (posting && posting[0] === next) at[i]!++
    }

    if (next !== previous) {
      yield next
      previous = next
    }
  }
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
  const { clause, tokens } = plan
  const norm = norms[doc] ?? K1

  if (clause.phrase) {
    const positions: number[][] = []
    let score = 0

    for (const token of tokens) {
      const cursor = token.alternatives[0]!.cursor
      if (clause.titleOnly && !titleAt(cursor, doc)) return null
      const posting = postingAt(cursor, doc)
      if (!posting) return null
      positions.push(posting[2])
      score += scoreTerm(posting[1], cursor.idf, norm, titleAt(cursor, doc))
    }

    if (!hasPhrase(positions)) return null
    return score * PHRASE_BOOST
  }

  let score = 0
  for (const token of tokens) {
    let best: number | null = null

    for (const alternative of token.alternatives) {
      const cursor = alternative.cursor
      if (clause.titleOnly && !titleAt(cursor, doc)) continue
      const posting = postingAt(cursor, doc)
      if (!posting) continue

      const value =
        scoreTerm(posting[1], cursor.idf, norm, titleAt(cursor, doc)) * alternative.weight
      if (best === null || value > best) best = value
    }

    if (best === null) return null
    score += best
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

/** Vocabulary in sorted order, built once per in-memory index. */
const TERM_CACHE = new WeakMap<IndexFile, string[]>()

function indexTerms(index: IndexFile): string[] {
  const cached = TERM_CACHE.get(index)
  if (cached) return cached
  const terms = Object.keys(index.postings).sort()
  TERM_CACHE.set(index, terms)
  return terms
}

/** Adapter that lets the shared query expander see an in-memory index. */
function memoryLookup(index: IndexFile): TermLookup {
  const terms = indexTerms(index)
  return {
    has(term: string): boolean {
      return (index.postings[term]?.length ?? 0) > 0
    },
    df(term: string): number {
      return index.postings[term]?.length ?? 0
    },
    suggest(term: string, limit: number): TermSuggestion[] {
      const prefixes = term.length > 2 ? [term.slice(0, 2), term.slice(0, 1)] : [term.slice(0, 1)]
      const seen = new Set<string>()
      const candidates: Array<{ term: string; df: number }> = []

      for (const prefix of prefixes) {
        const start = lowerBound(terms, prefix)
        for (let i = start; i < terms.length; i++) {
          const candidate = terms[i]!
          if (!candidate.startsWith(prefix)) break
          if (seen.has(candidate)) continue
          seen.add(candidate)
          candidates.push({ term: candidate, df: index.postings[candidate]?.length ?? 0 })
        }
        if (candidates.length >= limit * 4) break
      }

      return rankSuggestions(candidates, term, limit)
    },
  }
}

function lowerBound(sorted: string[], value: string): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (sorted[middle]! < value) low = middle + 1
    else high = middle
  }
  return low
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

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

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
