import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Document } from './index-file.js'
import { SqliteIndex, removeDatabaseFiles } from './sqlite-index.js'

const ADDRESS = 'ow1' + 'a'.repeat(52)
const OTHER = 'ow1' + 'b'.repeat(52)

const DOCS: Document[] = [
  {
    address: ADDRESS,
    path: '/index.html',
    title: 'The slow garden',
    text: 'Tomatoes grow in compost. A slow garden is a good garden. The soil is clay.',
  },
  {
    address: ADDRESS,
    path: '/coffee.html',
    title: 'Coffee without a machine',
    text: 'Grind the beans coarse. The coffee is slow. No equipment.',
  },
  {
    address: OTHER,
    path: '/index.html',
    title: 'Fast notes',
    text: 'Fast growth, no compost, no patience. A quick garden is a loud garden.',
  },
]

function withIndex(run: (index: SqliteIndex, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'openweb-sqlite-'))
  const file = join(dir, 'index.db')
  const index = SqliteIndex.build(file, DOCS, { fresh: true })
  try {
    run(index, dir)
  } finally {
    index.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('sqlite index stems, matches phrases, and survives reopen', () => {
  withIndex((index, dir) => {
    assert.equal(index.documentCount, 3)
    assert.equal(index.search('tomatoes', 10).total, 1)
    assert.equal(index.search('tomato', 10).total, 1)
    assert.equal(index.search('"slow garden"', 10).total, 1)
    assert.equal(index.search('compost', 10).total, 2)
    assert.equal(index.search('compost -fast', 10).total, 1)
    assert.equal(index.search('title:garden', 10).total, 1)
    assert.equal(index.search('coffee OR tomatoes', 10).total, 2)

    index.close()
    const reopened = SqliteIndex.open(join(dir, 'index.db'), { readOnly: true })
    try {
      assert.equal(reopened.documentCount, 3)
      assert.equal(reopened.search('coffee', 10).total, 1)
      assert.equal(reopened.stats().documents, 3)
    } finally {
      reopened.close()
    }

    // Reopen the writable handle for the caller's finally block.
    const again = SqliteIndex.open(join(dir, 'index.db'))
    try {
      assert.equal(again.search('garden', 10).total, 2)
    } finally {
      again.close()
    }
  })
})

test('fuzzy terms and synonyms rescue a misspelled query', () => {
  withIndex((index) => {
    // Porter stems tomatoes -> tomato, so this is an exact stem hit.
    assert.equal(index.search('tomatoe', 10).total, 1)
    // "yard" is not in the corpus; the synonym table maps it to garden.
    assert.equal(index.search('yard', 10).total, 2)
    assert.equal(index.search('compst', 10).total, 2)
    // A word with no near neighbour must return nothing, not everything.
    assert.equal(index.search('xylophone', 10).total, 0)
  })
})

test('replacing a document removes its old postings and terms', () => {
  withIndex((index) => {
    const before = index.termCount
    index.addDocuments([
      {
        address: ADDRESS,
        path: '/index.html',
        title: 'The slow garden',
        text: 'Potatoes grow in sand. A slow garden is a good garden.',
      },
    ])

    assert.equal(index.documentCount, 3)
    assert.equal(index.search('tomatoes', 10).total, 0)
    assert.equal(index.search('potatoes', 10).total, 1)
    assert.equal(index.search('compost', 10).total, 1)
    assert.ok(index.termCount <= before + 2)
  })
})

test('sites and pages are listed without a full scan', () => {
  withIndex((index) => {
    const sites = index.listSites()
    assert.equal(sites.length, 2)

    const garden = sites.find((site) => site.address === ADDRESS)
    assert.ok(garden)
    assert.equal(garden.pages, 2)
    assert.equal(garden.title, 'The slow garden')

    const pages = index.pagesFor(ADDRESS)
    assert.deepEqual(
      pages.map((page) => page.path),
      ['/coffee.html', '/index.html'],
    )
  })
})

test('reset empties the index without deleting the file', () => {
  withIndex((index) => {
    index.reset()
    assert.equal(index.documentCount, 0)
    assert.equal(index.termCount, 0)
    assert.equal(index.search('garden', 10).total, 0)

    index.addDocuments([DOCS[1]!])
    assert.equal(index.search('coffee', 10).total, 1)
  })
})

test('iterateDocuments streams every document once', () => {
  withIndex((index) => {
    const seen: string[] = []
    for (const document of index.iterateDocuments(2)) seen.push(document.path)
    assert.equal(seen.length, 3)
    assert.deepEqual(new Set(seen), new Set(['/index.html', '/coffee.html']))
  })
})

test('snapshot is a consistent copy that can be queried read-only', () => {
  withIndex((index, dir) => {
    const copy = join(dir, 'snapshot.db')
    index.snapshot(copy)

    const snapshot = SqliteIndex.open(copy, { readOnly: true })
    try {
      assert.equal(snapshot.documentCount, 3)
      assert.equal(snapshot.search('tomatoes', 10).total, 1)
    } finally {
      snapshot.close()
    }
  })
})

test('removeDatabaseFiles clears the database and its WAL sidecars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openweb-clean-'))
  try {
    const file = join(dir, 'index.db')
    const index = SqliteIndex.build(file, DOCS, { fresh: true })
    index.close()
    removeDatabaseFiles(file)
    assert.throws(() => SqliteIndex.open(file, { readOnly: true }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
