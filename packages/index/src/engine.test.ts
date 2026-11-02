import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalPath } from './crawl.js'
import { analyze, analyzeQuery, resolveLink } from './extract.js'
import {
  buildIndex,
  mergeDocuments,
  parseQuery,
  search,
  type Document,
} from './index-file.js'
import { stem } from './stem.js'

const ADDRESS = 'ow1' + 'a'.repeat(52)

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
    address: ADDRESS,
    path: '/fast.html',
    title: 'Garden notes',
    text: 'Garden garden garden. Fast growth, no compost, no patience.',
  },
]

test('porter stemmer handles the classic pairs', () => {
  const pairs: Array<[string, string]> = [
    ['caresses', 'caress'],
    ['ponies', 'poni'],
    ['cats', 'cat'],
    ['agreed', 'agre'],
    ['disabled', 'disabl'],
    ['matting', 'mat'],
    ['mating', 'mate'],
    ['meetings', 'meet'],
    ['relational', 'relat'],
    ['conditional', 'condit'],
    ['vietnamization', 'vietnam'],
    ['predication', 'predic'],
    ['operator', 'oper'],
    ['feudalism', 'feudal'],
    ['decisiveness', 'decis'],
    ['hopefulness', 'hope'],
    ['formaliti', 'formal'],
    ['sensibiliti', 'sensibl'],
    ['triplicate', 'triplic'],
    ['formative', 'form'],
    ['formalize', 'formal'],
    ['electriciti', 'electr'],
    ['hopeful', 'hope'],
    ['goodness', 'good'],
    ['revival', 'reviv'],
    ['allowance', 'allow'],
    ['inference', 'infer'],
    ['airliner', 'airlin'],
    ['adjustable', 'adjust'],
    ['defensible', 'defens'],
    ['irritant', 'irrit'],
    ['replacement', 'replac'],
    ['adjustment', 'adjust'],
    ['dependent', 'depend'],
    ['adoption', 'adopt'],
    ['communism', 'commun'],
    ['activate', 'activ'],
    ['effective', 'effect'],
    ['bowdlerize', 'bowdler'],
    ['probate', 'probat'],
    ['cease', 'ceas'],
    ['controll', 'control'],
    ['roll', 'roll'],
  ]

  for (const [input, expected] of pairs) {
    assert.equal(stem(input), expected, `${input} -> ${stem(input)}`)
  }
})

test('analyze stems, drops stopwords, and records positions', () => {
  const tokens = analyze('The tomatoes are growing')
  assert.deepEqual(tokens, [
    { term: 'tomato', position: 0 },
    { term: 'grow', position: 1 },
  ])
})

test('contractions and hyphens normalize to plain words', () => {
  assert.deepEqual(analyzeQuery("don't"), ['dont'])
  assert.deepEqual(analyzeQuery('slow-growing'), [stem('slowgrowing')])
})

test('query words match stemmed page words', () => {
  const index = buildIndex(DOCS)
  const found = search(index, 'tomato')
  assert.equal(found.total, 1)
  assert.equal(found.results[0]?.document.path, '/index.html')
})

test('phrase queries require consecutive words', () => {
  const index = buildIndex(DOCS)
  const found = search(index, '"slow garden"')
  assert.equal(found.total, 1)
  assert.equal(found.results[0]?.document.path, '/index.html')
})

test('negation excludes documents', () => {
  const index = buildIndex(DOCS)
  const found = search(index, 'garden -coffee')
  assert.ok(found.total >= 1)
  assert.ok(
    found.results.every((result) => !result.document.text.toLowerCase().includes('coffee')),
  )
})

test('a negative-only query returns everything else', () => {
  const index = buildIndex(DOCS)
  const found = search(index, '-coffee')
  assert.equal(found.total, 2)
  assert.ok(
    found.results.every((result) => !result.document.text.toLowerCase().includes('coffee')),
  )
})

test('title: restricts to title terms', () => {
  const index = buildIndex(DOCS)
  const found = search(index, 'title:garden')
  assert.equal(found.total, 2)
  assert.ok(
    found.results.every((result) =>
      result.document.title.toLowerCase().includes('garden'),
    ),
  )
})

test('OR combines groups', () => {
  const index = buildIndex(DOCS)
  const found = search(index, 'compost OR beans')
  assert.equal(found.total, 3)
})

test('empty query returns nothing, not everything', () => {
  const index = buildIndex(DOCS)
  assert.equal(search(index, '   ').total, 0)
  assert.equal(search(index, 'the and of').total, 0)
})

test('parseQuery respects quotes and flags', () => {
  const groups = parseQuery('-garden "slow coffee" title:beans')
  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.length, 3)
  assert.equal(groups[0]?.[0]?.negated, true)
  assert.equal(groups[0]?.[1]?.phrase, true)
  assert.equal(groups[0]?.[2]?.titleOnly, true)
})

test('mergeDocuments replaces by address+path', () => {
  const previous = buildIndex(DOCS)
  const merged = mergeDocuments(previous, [
    { ...DOCS[0]!, title: 'A newer title' },
    { ...DOCS[1]!, path: '/new.html' },
  ])
  assert.equal(merged.length, 4)
  assert.equal(merged.find((doc) => doc.path === '/index.html')?.title, 'A newer title')
})

test('resolveLink resolves relative links against the page', () => {
  assert.deepEqual(resolveLink('other.html', ADDRESS, '/sub/page.html'), {
    address: ADDRESS,
    path: '/sub/other.html',
  })
  assert.deepEqual(resolveLink('/style.css', ADDRESS, '/sub/page.html'), {
    address: ADDRESS,
    path: '/style.css',
  })
  assert.equal(resolveLink('https://example.com', ADDRESS, '/'), null)
  assert.equal(resolveLink('#top', ADDRESS, '/'), null)
})

test('canonicalPath indexes a directory once, as its index.html', () => {
  assert.equal(canonicalPath('/'), '/index.html')
  assert.equal(canonicalPath('/sub/'), '/sub/index.html')
  assert.equal(canonicalPath('/sub/index.html?x=1#top'), '/sub/index.html')
})

test('a leading + is accepted as an explicit must clause', () => {
  const groups = parseQuery('+garden')
  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.[0]?.negated, false)
  assert.deepEqual(groups[0]?.[0]?.terms, ['garden'])
})

test('length normalization stops long pages from winning on length alone', () => {
  const long: Document = {
    address: ADDRESS,
    path: '/long.html',
    title: 'Long',
    text: `${Array(500).fill('filler').join(' ')} coffee`,
  }
  const short: Document = {
    address: ADDRESS,
    path: '/short.html',
    title: 'Short',
    text: 'coffee',
  }
  const index = buildIndex([long, short])
  const found = search(index, 'coffee')
  assert.equal(found.results[0]?.document.path, '/short.html')
})
