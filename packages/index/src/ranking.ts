/**
 * Small ranking primitives shared by the in-memory and SQLite indexes.
 * Keeping them in one file means the two backends cannot drift.
 */

export const K1 = 1.2
export const B = 0.75
export const TITLE_BOOST = 2.2
export const PHRASE_BOOST = 1.4

export function scoreTerm(tf: number, idf: number, norm: number, inTitle: boolean): number {
  const effectiveTf = tf > 0 ? tf : 0.5
  const weight = (effectiveTf * (K1 + 1)) / (effectiveTf + norm || 1)
  return idf * weight * (inTitle ? TITLE_BOOST : 1)
}

export function hasPhrase(positions: number[][]): boolean {
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

export function makeSnippet(text: string, query: string, length = 180): string {
  const lower = text.toLowerCase()
  const words =
    query
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

/**
 * Keeps the best `limit` scores in a binary min-heap of parallel arrays. The
 * root is the worst kept result, so a new score usually costs one comparison.
 * Parallel arrays matter: a tuple per candidate would allocate on every match.
 */
export class TopScores {
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

export function worse(scoreA: number, docA: number, scoreB: number, docB: number): boolean {
  if (scoreA !== scoreB) return scoreA < scoreB
  return docA > docB
}
