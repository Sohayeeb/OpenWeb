import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderSite, specFromFields } from './index.js'

test('the builder emits one self-contained HTML file', () => {
  const built = renderSite({
    title: 'A small page',
    tagline: 'Written by a person',
    description: 'First paragraph.\n\nSecond paragraph.',
    author: 'Ada',
    sections: [{ heading: 'Notes', body: 'Compost and patience.' }],
    links: [{ label: 'Garden', url: '/garden.html' }],
  })

  assert.deepEqual(Object.keys(built.files), ['index.html'])
  assert.equal(built.html, built.files['index.html'])
  assert.match(built.html, /<title>A small page<\/title>/)
  assert.match(built.html, /<style>/)
  assert.match(built.html, /<p>First paragraph.<\/p>/)
  assert.match(built.html, /<p>Second paragraph.<\/p>/)
  assert.match(built.html, /href="\/garden.html"/)
  assert.doesNotMatch(built.html, /<script/i)
  assert.doesNotMatch(built.html, /<link[^>]+stylesheet/i)
})

test('user text cannot inject markup or javascript links', () => {
  const built = renderSite({
    title: '<script>alert(1)</script>',
    tagline: '"quoted" & <tagged>',
    description: '<img src=x onerror=alert(1)>',
    sections: [{ heading: '<b>Heading</b>', body: '</p><script>x</script>' }],
    links: [{ label: 'click', url: 'javascript:alert(1)' }],
  })

  assert.doesNotMatch(built.html, /<script>alert/)
  assert.match(built.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(built.html, /&quot;quoted&quot; &amp; &lt;tagged&gt;/)
  assert.match(built.html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(built.html, /href="javascript:/)
  assert.match(built.html, /href="#"/)
})

test('paper and forest themes use different palettes', () => {
  const forest = renderSite({ title: 'T', tagline: 'S', theme: 'forest' })
  const paper = renderSite({ title: 'T', tagline: 'S', theme: 'paper' })

  assert.match(forest.html, /#0a0a0b/)
  assert.match(paper.html, /#f8f5ee/)
  assert.notEqual(forest.html, paper.html)
})

test('form fields become a site spec and blank sections are dropped', () => {
  const spec = specFromFields({
    title: 'My page',
    tagline: 'A test',
    description: 'Intro',
    author: 'Ada',
    theme: 'paper',
    section1Heading: 'One',
    section1Body: 'First body',
    section2Heading: '',
    section2Body: '',
    link1Label: 'Garden',
    link1Url: '/garden.html',
    link2Label: 'Only a label',
    link2Url: '',
  })

  assert.equal(spec.title, 'My page')
  assert.equal(spec.theme, 'paper')
  assert.deepEqual(spec.sections, [{ heading: 'One', body: 'First body' }])
  assert.deepEqual(spec.links, [{ label: 'Garden', url: '/garden.html' }])
})
