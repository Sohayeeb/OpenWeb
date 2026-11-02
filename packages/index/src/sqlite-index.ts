/**
 * The on-disk index.
 *
 * SQLite is the whole point: a query reads the posting lists it needs instead
 * of deserializing every document on every open. Memory use is a few small
 * caches, an Int32Array of document lengths, and one row per cursor — not the
 * whole corpus. A 100,000-page index still fits comfortably on a laptop.
 *
 * The schema is intentionally boring and readable:
 *
 *   terms(term, df)                    vocabulary + document frequency
 *   postings(term, doc, tf, positions) positional inverted index
 *   title_postings(term, doc)          title terms, for title:
 *   documents(id, address, path, ...)  only fetched for the top results
 *
 * Positions are stored as JSON. They are small, and keeping the file format
 * inspectable with any SQLite client matters more than a few bytes here.
 */

import { mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { analyze } from './extract.js'
import {
  expandGroups,
  parseQuery,
  prefixRange,
  rankSuggestions,
  type Clause,
  type TermLookup,
  type TermSuggestion,
} from './query.js'
import {
  B,
  K1,
  PHRASE_BOOST,
  TopScores,
  hasPhrase,
  makeSnippet,
  scoreTerm,
} from './ranking.js'
import type { Document, SearchResponse, SearchResult } from './index-file.js'

export const INDEX_SCHEMA_VERSION = 3
export const INDEX_FILE_NAME = 'index.db'

export interface IndexStats {
  documents: number
  terms: number
  built: number
  bytes: number
}

export interface SiteSummary {
  address: string
  pages: number
  title: string
  path: string
}

export interface PageSummary {
  title: string
  path: string
}

interface DocumentRow {
  id: number
  address: string
  path: string
  title: string
  text: string
  length: number
}

interface PostingRow {
  doc: number
  tf: number
  /** Raw JSON, decoded only for phrase queries. */
  positions: string
}

type Row = Record<string, unknown>

export function indexFileFor(dir: string): string {
  return join(dir, INDEX_FILE_NAME)
}

export function sqliteIndexExists(file: string): boolean {
  try {
    return statSync(file).size > 0
  } catch {
    return false
  }
}

export class SqliteIndex {
  readonly filePath: string
  readonly readOnly: boolean
  private readonly db: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()
  private lengthCache: Int32Array | null = null
  private normCache: Float64Array | null = null
  private countCache: number | null = null
  /** Cursors opened by the current search; released even when a query stops early. */
  private activeCursors: SqlTermCursor[] = []

  private constructor(filePath: string, db: DatabaseSync, readOnly: boolean) {
    this.filePath = filePath
    this.db = db
    this.readOnly = readOnly
    if (!readOnly) this.initialize()
    this.refreshMeta()
  }

  /** Open an existing index, creating an empty one when writable. */
  static open(filePath: string, options: { readOnly?: boolean } = {}): SqliteIndex {
    const readOnly = options.readOnly === true
    if (!readOnly) mkdirSync(dirname(filePath), { recursive: true })
    const db = new DatabaseSync(filePath, { readOnly })
    return new SqliteIndex(filePath, db, readOnly)
  }

  static openOrCreate(filePath: string): SqliteIndex {
    return SqliteIndex.open(filePath)
  }

  /**
   * Build an index from scratch. `fresh` removes the old file first; without
   * it, the documents are merged into whatever is already there.
   */
  static build(
    filePath: string,
    documents: Document[],
    options: { fresh?: boolean } = {},
  ): SqliteIndex {
    if (options.fresh !== false) {
      removeDatabaseFiles(filePath)
    }
    const index = SqliteIndex.open(filePath)
    index.addDocuments(documents)
    return index
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -8192;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY,
        address TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        length INTEGER NOT NULL,
        UNIQUE(address, path)
      );
      CREATE TABLE IF NOT EXISTS terms (
        term TEXT PRIMARY KEY,
        df INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS postings (
        term TEXT NOT NULL,
        doc INTEGER NOT NULL,
        tf INTEGER NOT NULL,
        positions TEXT NOT NULL,
        PRIMARY KEY (term, doc)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS postings_doc ON postings(doc);
      CREATE TABLE IF NOT EXISTS title_postings (
        term TEXT NOT NULL,
        doc INTEGER NOT NULL,
        PRIMARY KEY (term, doc)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS title_postings_doc ON title_postings(doc);
      INSERT OR IGNORE INTO meta(key, value) VALUES ('schema', '${INDEX_SCHEMA_VERSION}');
      INSERT OR IGNORE INTO meta(key, value) VALUES ('built', '0');
      INSERT OR IGNORE INTO meta(key, value) VALUES ('avgLength', '0');
    `)
  }

  private stmt(sql: string): StatementSync {
    const cached = this.statements.get(sql)
    if (cached) return cached
    const statement = this.db.prepare(sql)
    this.statements.set(sql, statement)
    return statement
  }

  private getMeta(key: string): string | null {
    const row = this.stmt('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined
    return row ? String(row['value']) : null
  }

  private setMeta(key: string, value: string): void {
    this.stmt(
      'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value)
  }

  private refreshMeta(): void {
    this.lengthCache = null
    this.normCache = null
    this.countCache = null
  }

  get documentCount(): number {
    if (this.countCache !== null) return this.countCache
    const row = this.stmt('SELECT COUNT(*) AS n FROM documents').get() as Row
    this.countCache = Number(row['n'] ?? 0)
    return this.countCache
  }

  get builtAt(): number {
    return Number(this.getMeta('built') ?? 0)
  }

  get avgLength(): number {
    return Number(this.getMeta('avgLength') ?? 0)
  }

  get termCount(): number {
    const row = this.stmt('SELECT COUNT(*) AS n FROM terms').get() as Row
    return Number(row['n'] ?? 0)
  }

  stats(): IndexStats {
    // A bulk write leaves the committed pages in the WAL. Fold them back into
    // the database first, or the reported size is roughly double the truth.
    if (!this.readOnly) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        // A concurrent reader can hold the checkpoint; the numbers are still real.
      }
    }
    return {
      documents: this.documentCount,
      terms: this.termCount,
      built: this.builtAt,
      bytes: fileSize(this.filePath) + fileSize(`${this.filePath}-wal`),
    }
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /**
   * Delete every document, posting, and term while keeping the file. This is
   * what `--fresh` uses: deleting the file would fail on Windows while the
   * gateway still has it open.
   */
  reset(): void {
    if (this.readOnly) throw new Error('cannot reset a read-only index')
    this.db.exec(`
      BEGIN IMMEDIATE;
      DELETE FROM postings;
      DELETE FROM title_postings;
      DELETE FROM documents;
      DELETE FROM terms;
      COMMIT;
    `)
    this.setMeta('avgLength', '0')
    this.setMeta('built', String(Date.now()))
    this.refreshMeta()
  }

  /**
   * Add or replace documents. Replacing a document removes its old postings
   * first, so editing a page does not leave stale terms behind.
   */
  addDocuments(documents: Document[]): number {
    if (this.readOnly) throw new Error('cannot write a read-only index')
    if (documents.length === 0) return 0

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const deltas = new Map<string, number>()
      for (const document of documents) this.upsertDocument(document, deltas)
      this.applyTermDeltas(deltas)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    const totals = this.stmt(
      'SELECT COUNT(*) AS n, COALESCE(SUM(length), 0) AS total FROM documents',
    ).get() as Row
    const count = Number(totals['n'] ?? 0)
    const total = Number(totals['total'] ?? 0)
    this.setMeta('avgLength', String(count === 0 ? 0 : total / count))
    this.setMeta('built', String(Date.now()))
    this.setMeta('schema', String(INDEX_SCHEMA_VERSION))
    this.refreshMeta()
    return documents.length
  }

  private upsertDocument(document: Document, deltas: Map<string, number>): void {
    const body = analyze(document.text)
    const titleTerms = [...new Set(analyze(document.title).map((token) => token.term))]

    const existing = this.stmt(
      'SELECT id, length FROM documents WHERE address = ? AND path = ?',
    ).get(document.address, document.path) as Row | undefined

    let id: number
    if (existing) {
      id = Number(existing['id'])
      this.removeDocumentPostings(id, deltas)
      this.stmt('UPDATE documents SET title = ?, text = ?, length = ? WHERE id = ?').run(
        document.title,
        document.text,
        body.length,
        id,
      )
    } else {
      const result = this.stmt(
        'INSERT INTO documents(address, path, title, text, length) VALUES (?, ?, ?, ?, ?)',
      ).run(document.address, document.path, document.title, document.text, body.length)
      id = Number(result.lastInsertRowid)
    }

    const bodyTerms = new Map<string, number[]>()
    for (const token of body) {
      const positions = bodyTerms.get(token.term)
      if (positions) positions.push(token.position)
      else bodyTerms.set(token.term, [token.position])
    }

    const insertPosting = this.stmt(
      'INSERT INTO postings(term, doc, tf, positions) VALUES (?, ?, ?, ?)',
    )
    for (const [term, positions] of bodyTerms) {
      insertPosting.run(term, id, positions.length, JSON.stringify(positions))
      deltas.set(term, (deltas.get(term) ?? 0) + 1)
    }

    const insertTitle = this.stmt(
      'INSERT INTO title_postings(term, doc) VALUES (?, ?)',
    )
    for (const term of titleTerms) insertTitle.run(term, id)
  }

  private removeDocumentPostings(id: number, deltas: Map<string, number>): void {
    const terms = this.stmt('SELECT term FROM postings WHERE doc = ?').all(id) as Row[]
    for (const row of terms) {
      const term = String(row['term'])
      deltas.set(term, (deltas.get(term) ?? 0) - 1)
    }
    this.stmt('DELETE FROM postings WHERE doc = ?').run(id)
    this.stmt('DELETE FROM title_postings WHERE doc = ?').run(id)
  }

  /**
   * Apply every document frequency change in one pass. Doing this per term per
   * document turns a 20,000-page build into millions of tiny statements; a
   * single upsert per distinct term in the batch keeps it linear.
   */
  private applyTermDeltas(deltas: Map<string, number>): void {
    if (deltas.size === 0) return
    const upsert = this.stmt(
      'INSERT INTO terms(term, df) VALUES (?, ?) ON CONFLICT(term) DO UPDATE SET df = df + excluded.df',
    )
    for (const [term, delta] of deltas) {
      if (delta !== 0) upsert.run(term, delta)
    }
    this.stmt('DELETE FROM terms WHERE df <= 0').run()
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  private lengths(): Int32Array {
    if (this.lengthCache) return this.lengthCache
    const maxRow = this.stmt('SELECT COALESCE(MAX(id), 0) AS max FROM documents').get() as Row
    const max = Number(maxRow['max'] ?? 0)
    const lengths = new Int32Array(max + 1)
    const rows = this.stmt('SELECT id, length FROM documents ORDER BY id').iterate()
    for (const row of rows) {
      lengths[Number((row as Row)['id'])] = Number((row as Row)['length'])
    }
    this.lengthCache = lengths
    return lengths
  }

  private norms(): Float64Array {
    if (this.normCache) return this.normCache
    const lengths = this.lengths()
    const average = this.avgLength || 1
    const norms = new Float64Array(lengths.length)
    for (let doc = 0; doc < lengths.length; doc++) {
      norms[doc] = K1 * (1 - B + (B * (lengths[doc] ?? 1)) / average)
    }
    this.normCache = norms
    return norms
  }

  private lookup(): TermLookup {
    const dfCache = new Map<string, number>()

    const dfOf = (term: string): number => {
      const cached = dfCache.get(term)
      if (cached !== undefined) return cached
      const row = this.stmt('SELECT df FROM terms WHERE term = ?').get(term) as Row | undefined
      const df = row ? Number(row['df']) : 0
      dfCache.set(term, df)
      return df
    }

    return {
      has: (term) => dfOf(term) > 0,
      df: dfOf,
      suggest: (term: string, limit: number): TermSuggestion[] => {
        const prefixes =
          term.length > 2 ? [term.slice(0, 2), term.slice(0, 1)] : [term.slice(0, 1)]
        const seen = new Set<string>()
        const candidates: Array<{ term: string; df: number }> = []

        for (const prefix of prefixes) {
          const [start, end] = prefixRange(prefix)
          const rows = this.stmt(
            'SELECT term, df FROM terms WHERE term >= ? AND term < ? ORDER BY term LIMIT 500',
          ).all(start, end) as Row[]
          for (const row of rows) {
            const candidate = String(row['term'])
            if (seen.has(candidate)) continue
            seen.add(candidate)
            candidates.push({ term: candidate, df: Number(row['df']) })
          }
          if (candidates.length >= limit * 12) break
        }

        return rankSuggestions(candidates, term, limit)
      },
    }
  }

  search(query: string, limit = 10): SearchResponse {
    try {
      return this.runSearch(query, limit)
    } finally {
      // An iterator that was not read to the end still holds a SQLite read
      // transaction. Left alone, those pile up and block WAL checkpoints.
      for (const cursor of this.activeCursors) {
        cursor.iterator.return?.()
        cursor.titleIterator.return?.()
      }
      this.activeCursors = []
    }
  }

  private runSearch(query: string, limit: number): SearchResponse {
    const parsed = parseQuery(query)
    if (parsed.length === 0 || this.documentCount === 0) {
      return { results: [], total: 0, matchedTerms: [] }
    }

    const groups = expandGroups(parsed, this.lookup())
    const top = new TopScores(limit)
    const matchedTerms = new Set<string>()
    let total = 0

    if (groups.length === 1) {
      const group = groups[0]!
      this.executeGroup(group, (doc, score) => {
        total++
        top.add(doc, score)
      })
      collectTerms(group, matchedTerms)
    } else {
      const combined = new Map<number, number>()
      for (const group of groups) {
        this.executeGroup(group, (doc, score) => {
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

    const ranked = top.values()
    const documents = this.documentsById(ranked.map(([doc]) => doc))

    ranked.sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]
      const left = documents.get(a[0])
      const right = documents.get(b[0])
      return `${left?.title}${left?.path}`.localeCompare(`${right?.title}${right?.path}`)
    })

    const results: SearchResult[] = []
    for (const [doc, score] of ranked) {
      const document = documents.get(doc)
      if (!document) continue
      results.push({
        document,
        score,
        snippet: makeSnippet(document.text, query),
      })
    }

    return { results, total, matchedTerms: [...matchedTerms] }
  }

  private documentsById(ids: number[]): Map<number, Document> {
    const map = new Map<number, Document>()
    if (ids.length === 0) return map

    // Keep the parameter list bounded; top-K is already small, but a caller
    // can ask for hundreds of results.
    for (let start = 0; start < ids.length; start += 200) {
      const slice = ids.slice(start, start + 200)
      const placeholders = slice.map(() => '?').join(', ')
      const rows = this.stmt(
        `SELECT id, address, path, title, text FROM documents WHERE id IN (${placeholders})`,
      ).all(...slice) as Row[]

      for (const row of rows) {
        map.set(Number(row['id']), {
          address: String(row['address']),
          path: String(row['path']),
          title: String(row['title']),
          text: String(row['text']),
        })
      }
    }
    return map
  }

  private executeGroup(group: Clause[], onMatch: (doc: number, score: number) => void): void {
    const positive = group.filter((clause) => !clause.negated)
    const negative = group.filter((clause) => clause.negated)
    const positivePlans = this.prepareClauses(positive)
    if (positivePlans === null) return
    const negativePlans = this.prepareNegative(negative)

    if (positivePlans.length === 0) {
      const rows = this.stmt('SELECT id FROM documents ORDER BY id').iterate()
      for (const row of rows) {
        const doc = Number((row as Row)['id'])
        if (!this.isExcluded(negativePlans, doc)) onMatch(doc, 0)
      }
      return
    }

    const driver = rarestToken(positivePlans)
    if (!driver) return

    for (const doc of this.driverDocuments(driver)) {
      let score = 0
      let ok = true
      for (const plan of positivePlans) {
        const clauseScore = this.scoreClause(plan, doc)
        if (clauseScore === null) {
          ok = false
          break
        }
        score += clauseScore
      }
      if (!ok || this.isExcluded(negativePlans, doc)) continue
      onMatch(doc, score)
    }
  }

  private prepareClauses(clauses: Clause[]): SqlClausePlan[] | null {
    const plans: SqlClausePlan[] = []
    for (const clause of clauses) {
      const plan = this.prepareClause(clause)
      if (!plan) return null
      plans.push(plan)
    }
    return plans
  }

  private prepareNegative(clauses: Clause[]): SqlClausePlan[] {
    const plans: SqlClausePlan[] = []
    for (const clause of clauses) {
      const plan = this.prepareClause(clause)
      if (plan) plans.push(plan)
    }
    return plans
  }

  private prepareClause(clause: Clause): SqlClausePlan | null {
    const tokens: SqlTokenPlan[] = []
    const total = this.documentCount

    for (let i = 0; i < clause.terms.length; i++) {
      const candidates = clause.phrase
        ? [clause.terms[i]!]
        : (clause.alternatives?.[i] ?? [clause.terms[i]!])
      const weights = clause.phrase ? [1] : (clause.weights?.[i] ?? candidates.map(() => 1))
      const alternatives: SqlAlternative[] = []

      for (let j = 0; j < candidates.length; j++) {
        const term = candidates[j]!
        const dfRow = this.stmt('SELECT df FROM terms WHERE term = ?').get(term) as Row | undefined
        if (!dfRow) continue
        const df = Number(dfRow['df'])

        alternatives.push({
          cursor: this.makeCursor(term, df, total),
          weight: weights[j] ?? 1,
        })
      }

      if (alternatives.length === 0) return null
      tokens.push({ alternatives })
    }

    return { clause, tokens }
  }

  private makeCursor(term: string, df: number, total: number): SqlTermCursor {
    const iterator = this.db
      .prepare('SELECT doc, tf, positions FROM postings WHERE term = ? ORDER BY doc')
      .iterate(term)
    const titleIterator = this.db
      .prepare('SELECT doc FROM title_postings WHERE term = ? ORDER BY doc')
      .iterate(term)

    const cursor: SqlTermCursor = {
      term,
      df,
      iterator,
      current: null,
      idf: Math.log(1 + (total - df + 0.5) / (df + 0.5)),
      titleIterator,
      titleCurrent: null,
    }
    this.activeCursors.push(cursor)
    this.advance(cursor, -1)
    this.advanceTitle(cursor, -1)
    return cursor
  }

  private advance(cursor: SqlTermCursor, target: number): void {
    while (cursor.current === null || cursor.current.doc < target) {
      const next = cursor.iterator.next()
      if (next.done) {
        cursor.current = null
        return
      }
      const row = next.value as Row
      cursor.current = {
        doc: Number(row['doc']),
        tf: Number(row['tf']),
        positions: String(row['positions']),
      }
      if (cursor.current.doc >= target) return
    }
  }

  private advanceTitle(cursor: SqlTermCursor, target: number): void {
    while (cursor.titleCurrent === null || cursor.titleCurrent < target) {
      const next = cursor.titleIterator.next()
      if (next.done) {
        cursor.titleCurrent = null
        return
      }
      cursor.titleCurrent = Number((next.value as Row)['doc'])
      if (cursor.titleCurrent >= target) return
    }
  }

  private postingAt(cursor: SqlTermCursor, doc: number): PostingRow | null {
    if (cursor.current === null || cursor.current.doc < doc) this.advance(cursor, doc)
    return cursor.current && cursor.current.doc === doc ? cursor.current : null
  }

  private titleAt(cursor: SqlTermCursor, doc: number): boolean {
    if (cursor.titleCurrent === null || cursor.titleCurrent < doc) this.advanceTitle(cursor, doc)
    return cursor.titleCurrent === doc
  }

  private scoreClause(plan: SqlClausePlan, doc: number): number | null {
    const { clause, tokens } = plan
    const norm = this.norms()[doc] ?? K1

    if (clause.phrase) {
      const positions: number[][] = []
      let score = 0

      for (const token of tokens) {
        const cursor = token.alternatives[0]!.cursor
        if (clause.titleOnly && !this.titleAt(cursor, doc)) return null
        const posting = this.postingAt(cursor, doc)
        if (!posting) return null
        positions.push(JSON.parse(posting.positions) as number[])
        score += scoreTerm(posting.tf, cursor.idf, norm, this.titleAt(cursor, doc))
      }

      if (!hasPhrase(positions)) return null
      return score * PHRASE_BOOST
    }

    let score = 0
    for (const token of tokens) {
      let best: number | null = null
      for (const alternative of token.alternatives) {
        const cursor = alternative.cursor
        if (clause.titleOnly && !this.titleAt(cursor, doc)) continue
        const posting = this.postingAt(cursor, doc)
        if (!posting) continue
        const value =
          scoreTerm(posting.tf, cursor.idf, norm, this.titleAt(cursor, doc)) * alternative.weight
        if (best === null || value > best) best = value
      }
      if (best === null) return null
      score += best
    }
    return score
  }

  private isExcluded(plans: SqlClausePlan[], doc: number): boolean {
    for (const plan of plans) {
      if (this.scoreClause(plan, doc) !== null) return true
    }
    return false
  }

  /**
   * The driver uses fresh iterators, separate from the scoring cursors:
   * scoring advances its cursors past the current document, which would make
   * them unusable as a driver.
   */
  private *driverDocuments(token: SqlTokenPlan): Generator<number> {
    const cursors: Array<Iterator<Row>> = token.alternatives.map((alternative) => {
      return this.db
        .prepare('SELECT doc FROM postings WHERE term = ? ORDER BY doc')
        .iterate(alternative.cursor.term) as unknown as Iterator<Row>
    })

    try {
      const current: Array<number | null> = cursors.map((cursor) => {
        const next = cursor.next()
        return next.done ? null : Number(next.value['doc'])
      })

      for (;;) {
        let next = Infinity
        for (const doc of current) {
          if (doc !== null && doc < next) next = doc
        }
        if (next === Infinity) return

        for (let i = 0; i < cursors.length; i++) {
          if (current[i] !== next) continue
          const step = cursors[i]!.next()
          current[i] = step.done ? null : Number(step.value['doc'])
        }
        yield next
      }
    } finally {
      for (const cursor of cursors) cursor.return?.()
    }
  }

  // -------------------------------------------------------------------------
  // Site views, export, snapshots
  // -------------------------------------------------------------------------

  /** One row per site, without loading every page into memory. */
  listSites(limit = 200): SiteSummary[] {
    const rows = this.stmt(`
      SELECT d.address AS address,
             COUNT(*) AS pages,
             (SELECT d2.title FROM documents d2 WHERE d2.address = d.address ORDER BY d2.id LIMIT 1) AS title,
             (SELECT d2.path FROM documents d2 WHERE d2.address = d.address ORDER BY d2.id LIMIT 1) AS path
      FROM documents d
      GROUP BY d.address
      ORDER BY pages DESC, d.address
      LIMIT ?
    `).all(limit) as Row[]

    return rows.map((row) => ({
      address: String(row['address']),
      pages: Number(row['pages']),
      title: String(row['title'] ?? row['address']),
      path: String(row['path'] ?? '/'),
    }))
  }

  pagesFor(address: string, limit = 500): PageSummary[] {
    const rows = this.stmt(
      'SELECT title, path FROM documents WHERE address = ? ORDER BY path LIMIT ?',
    ).all(address, limit) as Row[]
    return rows.map((row) => ({
      title: String(row['title']),
      path: String(row['path']),
    }))
  }

  /** Stream documents in batches, for importing another index. */
  *iterateDocuments(batchSize = 500): Generator<Document> {
    let last = 0
    for (;;) {
      const rows = this.stmt(
        'SELECT id, address, path, title, text FROM documents WHERE id > ? ORDER BY id LIMIT ?',
      ).all(last, batchSize) as Row[]
      if (rows.length === 0) return
      for (const row of rows) {
        last = Number(row['id'])
        yield {
          address: String(row['address']),
          path: String(row['path']),
          title: String(row['title']),
          text: String(row['text']),
        }
      }
    }
  }

  /** A consistent single-file copy, suitable for publishing on a drive. */
  snapshot(output: string): void {
    if (this.readOnly) throw new Error('cannot snapshot a read-only index')
    rmSync(output, { force: true })
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // A concurrent reader can block a checkpoint; VACUUM INTO is still safe.
    }
    const escaped = output.replace(/'/g, "''")
    this.db.exec(`VACUUM INTO '${escaped}'`)
  }

  close(): void {
    this.statements.clear()
    try {
      this.db.close()
    } catch {
      // Closing twice is harmless.
    }
  }
}

interface SqlAlternative {
  cursor: SqlTermCursor
  weight: number
}

interface SqlTokenPlan {
  alternatives: SqlAlternative[]
}

interface SqlClausePlan {
  clause: Clause
  tokens: SqlTokenPlan[]
}

interface SqlTermCursor {
  term: string
  df: number
  iterator: Iterator<Row>
  current: PostingRow | null
  idf: number
  titleIterator: Iterator<Row>
  titleCurrent: number | null
}

function rarestToken(plans: SqlClausePlan[]): SqlTokenPlan | null {
  let best: SqlTokenPlan | null = null
  let bestLength = Infinity

  for (const plan of plans) {
    for (const token of plan.tokens) {
      let length = 0
      for (const alternative of token.alternatives) length += alternative.cursor.df
      if (length < bestLength) {
        bestLength = length
        best = token
      }
    }
  }
  return best
}

function collectTerms(group: Clause[], into: Set<string>): void {
  for (const clause of group) {
    if (clause.negated) continue
    for (let i = 0; i < clause.terms.length; i++) {
      for (const term of clause.alternatives?.[i] ?? [clause.terms[i]!]) into.add(term)
    }
  }
}

function fileSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

export function removeDatabaseFiles(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true })
}
