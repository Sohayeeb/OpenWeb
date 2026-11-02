/**
 * Query parsing and expansion.
 *
 * Parsing is deliberately tiny: words, "phrases", -negation, title: and OR.
 * Expansion is what makes a human query survive human spelling:
 *
 *   - Porter stems are the first pass, so tomatoes already finds tomato
 *   - a small synonym table bridges words that stem differently
 *   - when a term is not in the index at all, nearby vocabulary words are
 *     offered as lower-weighted alternatives
 *
 * Fuzzy candidates are only generated for a term that missed outright. A common
 * word never fans out into twenty noisy matches.
 */

import { analyze } from './extract.js'
import { stem } from './stem.js'

export interface Clause {
  /** Exact stemmed terms, one per analyzed word. */
  terms: string[]
  phrase: boolean
  negated: boolean
  titleOnly: boolean
  /** Candidate terms per token. Undefined means "terms". */
  alternatives?: string[][]
  /** Candidate weights per token, parallel to alternatives. */
  weights?: number[][]
}

export interface TermSuggestion {
  term: string
  distance: number
  df: number
}

export interface TermLookup {
  has(term: string): boolean
  df(term: string): number
  suggest(term: string, limit: number): TermSuggestion[]
}

export interface ExpandOptions {
  synonyms?: boolean
  fuzzy?: boolean
  /** Maximum candidates per query token, including the exact term. */
  maxCandidates?: number
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
// Synonyms
// ---------------------------------------------------------------------------

/**
 * A tiny, readable table. Bigger synonym graphs make search worse, not better:
 * every added edge is a chance to match something the writer did not mean.
 */
const SYNONYM_GROUPS: string[][] = [
  ['tomato', 'tomatoes'],
  ['coffee', 'cafe', 'espresso'],
  ['garden', 'yard', 'backyard'],
  ['fast', 'quick', 'rapid', 'speedy'],
  ['slow', 'gradual', 'leisurely'],
  ['big', 'large', 'huge'],
  ['small', 'tiny', 'little'],
  ['buy', 'purchase'],
  ['start', 'begin', 'launch'],
  ['website', 'site', 'webpage'],
  ['picture', 'photo', 'image'],
  ['doctor', 'physician'],
  ['car', 'automobile', 'vehicle'],
  ['kid', 'child'],
  ['happy', 'glad', 'joyful'],
  ['sad', 'unhappy'],
  ['make', 'create', 'build'],
  ['use', 'utilize'],
  ['help', 'assist'],
  ['show', 'display'],
  ['find', 'search', 'lookup'],
  ['write', 'author'],
  ['publish', 'release'],
  ['index', 'catalog'],
  ['directory', 'catalog', 'list'],
  ['computer', 'pc', 'machine'],
  ['internet', 'web'],
  ['friend', 'pal'],
  ['money', 'cash'],
]

const SYNONYMS = buildSynonyms()

function buildSynonyms(): Map<string, string[]> {
  const map = new Map<string, Set<string>>()
  for (const group of SYNONYM_GROUPS) {
    const stems = [...new Set(group.map((word) => stem(word.toLowerCase())))]
    for (const term of stems) {
      let set = map.get(term)
      if (!set) {
        set = new Set<string>()
        map.set(term, set)
      }
      for (const other of stems) {
        if (other !== term) set.add(other)
      }
    }
  }
  return new Map([...map].map(([term, set]) => [term, [...set]]))
}

export function synonymTerms(term: string): string[] {
  return SYNONYMS.get(term) ?? []
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/**
 * Adds candidate terms to a parsed query. Exact terms always come first and
 * always carry full weight; everything else is a fallback.
 */
export function expandGroups(
  groups: Clause[][],
  lookup: TermLookup,
  options: ExpandOptions = {},
): Clause[][] {
  const useSynonyms = options.synonyms !== false
  const useFuzzy = options.fuzzy !== false
  const maxCandidates = Math.max(1, options.maxCandidates ?? 5)

  return groups.map((group) =>
    group.map((clause) => {
      // Phrases must stay exact or they stop being phrases. Negation also stays
      // exact: a fuzzy exclusion silently swallows pages.
      if (clause.phrase || clause.negated) return clause

      const alternatives: string[][] = []
      const weights: number[][] = []
      let expanded = false

      for (const term of clause.terms) {
        const candidates = new Map<string, number>()
        candidates.set(term, 1)

        if (useSynonyms) {
          for (const synonym of synonymTerms(term)) {
            if (!lookup.has(synonym)) continue
            // If the writer's word exists, a synonym is a bonus match, not a
            // replacement. If it does not, the synonym carries most of the
            // weight but still ranks below an exact hit.
            candidates.set(synonym, Math.max(candidates.get(synonym) ?? 0, lookup.has(term) ? 0.55 : 0.9))
          }
        }

        const hasExact = lookup.has(term)
        if (!hasExact && useFuzzy) {
          const threshold = fuzzyThreshold(term)
          const suggestions = lookup.suggest(term, maxCandidates - 1)
          for (const suggestion of suggestions) {
            if (suggestion.distance > threshold) continue
            const weight = Math.max(0.42, 1 - suggestion.distance * 0.16)
            const existing = candidates.get(suggestion.term)
            if (existing === undefined || weight > existing) {
              candidates.set(suggestion.term, weight)
            }
          }
        }

        const ranked = [...candidates.entries()]
          .filter(([candidate]) => lookup.has(candidate))
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, maxCandidates)

        if (ranked.length === 0) {
          // Nothing in the vocabulary. Keep the exact term so the query
          // correctly returns zero instead of accidentally matching everything.
          alternatives.push([term])
          weights.push([1])
          continue
        }

        alternatives.push(ranked.map(([candidate]) => candidate))
        weights.push(ranked.map(([, weight]) => weight))
        if (ranked.length > 1 || ranked[0]![0] !== term) expanded = true
      }

      if (!expanded) return clause
      return { ...clause, alternatives, weights }
    }),
  )
}

/** Short words tolerate one edit; longer words tolerate two. */
export function fuzzyThreshold(term: string): number {
  if (term.length <= 4) return 1
  if (term.length <= 8) return 2
  return 3
}

/** Shared ranking for fuzzy candidates; both index backends feed this. */
export function rankSuggestions(
  candidates: Iterable<{ term: string; df: number }>,
  term: string,
  limit: number,
): TermSuggestion[] {
  const threshold = fuzzyThreshold(term)
  const scored: TermSuggestion[] = []

  for (const candidate of candidates) {
    if (candidate.term === term) continue
    if (Math.abs(candidate.term.length - term.length) > threshold) continue
    const distance = editDistance(term, candidate.term, threshold)
    if (distance > threshold) continue
    scored.push({ term: candidate.term, distance, df: candidate.df })
  }

  scored.sort(
    (a, b) => a.distance - b.distance || b.df - a.df || a.term.localeCompare(b.term),
  )
  return scored.slice(0, Math.max(0, limit))
}

/**
 * Bounded Levenshtein. Returns `max + 1` as soon as the distance cannot fit,
 * which is what keeps fuzzy suggestions cheap on a large vocabulary.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let previous = new Array<number>(b.length + 1)
  let current = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) previous[j] = j

  for (let i = 1; i <= a.length; i++) {
    current[0] = i
    let rowMin = current[0]!

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      )
      if (current[j]! < rowMin) rowMin = current[j]!
    }

    if (rowMin > max) return max + 1
    const swap = previous
    previous = current
    current = swap
  }

  return previous[b.length]!
}

/** Shared prefix-range helper used by both index backends. */
export function prefixRange(prefix: string): [string, string] {
  const start = prefix
  // U+10FFFF is above any character SQLite or JS will see in a term.
  const end = prefix.slice(0, -1) + String.fromCodePoint((prefix.codePointAt(prefix.length - 1) ?? 0) + 1)
  return [start, end]
}
