/**
 * The website builder.
 *
 * It is a function, not a framework: a small spec in, one static HTML file out.
 * The output has no scripts, no external fonts, no analytics, and no build step
 * after the fact. That is what makes it publishable on OpenWeb.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SiteSection {
  heading: string
  body: string
}

export interface SiteLink {
  label: string
  url: string
}

export interface SiteSpec {
  title: string
  tagline: string
  description?: string
  author?: string
  sections?: SiteSection[]
  links?: SiteLink[]
  theme?: 'forest' | 'paper'
}

export interface BuiltSite {
  html: string
  files: Record<string, string>
}

export function defaultSpec(): SiteSpec {
  return {
    title: 'A small page',
    tagline: 'Written by a person, served from a computer.',
    description:
      'This page was made with the OpenWeb builder. Replace these words with your own, then publish the folder.',
    author: '',
    sections: [
      {
        heading: 'What this is',
        body: 'A static page on a peer-to-peer web. No account, no tracking, no build pipeline waiting to break.',
      },
      {
        heading: 'How to publish it',
        body: 'Save the folder, then run: openweb serve ./my-site',
      },
    ],
    links: [],
    theme: 'forest',
  }
}

export function renderSite(spec: SiteSpec): BuiltSite {
  const title = spec.title.trim() || 'Untitled'
  const tagline = spec.tagline.trim() || 'A page on the peer-to-peer web.'
  const description = spec.description?.trim() ?? ''
  const sections = (spec.sections ?? []).filter(
    (section) => section.heading.trim() !== '' || section.body.trim() !== '',
  )
  const links = (spec.links ?? []).filter((link) => link.label.trim() && link.url.trim())
  const theme = spec.theme === 'paper' ? 'paper' : 'forest'

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="openweb:browser" content="on" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description || tagline)}" />
    <style>${theme === 'paper' ? PAPER_CSS : FOREST_CSS}</style>
  </head>
  <body>
    <main>
      <header class="top">
        <p class="mark">${escapeHtml(spec.author?.trim() || 'OpenWeb')}</p>
        <h1>${escapeHtml(title)}</h1>
        <p class="tagline">${escapeHtml(tagline)}</p>
        ${description ? `<div class="intro">${paragraphs(description)}</div>` : ''}
      </header>
${sections
  .map(
    (section) => `      <section>
        ${section.heading.trim() ? `<h2>${escapeHtml(section.heading.trim())}</h2>` : ''}
        ${paragraphs(section.body)}
      </section>`,
  )
  .join('\n')}
${links.length > 0 ? `      <nav class="links">\n${links
    .map(
      (link) =>
        `        <a href="${escapeAttribute(link.url.trim())}">${escapeHtml(link.label.trim())}</a>`,
    )
    .join('\n')}\n      </nav>` : ''}
      <footer>
        <p>${escapeHtml(spec.author?.trim() || title)} · published on <a href="https://github.com/Sohayeeb/OpenWeb">OpenWeb</a></p>
      </footer>
    </main>
  </body>
</html>
`

  return { html, files: { 'index.html': html } }
}

/** Write a publishable folder. Only `index.html` is needed; one file is enough. */
export function writeSite(dir: string, spec: SiteSpec): BuiltSite {
  const built = renderSite(spec)
  mkdirSync(dir, { recursive: true })
  for (const [path, contents] of Object.entries(built.files)) {
    writeFileSync(join(dir, path), contents)
  }
  return built
}

export function specFromFields(fields: Record<string, string>): SiteSpec {
  const sections: SiteSection[] = []
  for (let i = 1; i <= 6; i++) {
    const heading = fields[`section${i}Heading`] ?? ''
    const body = fields[`section${i}Body`] ?? ''
    if (heading.trim() === '' && body.trim() === '') continue
    sections.push({ heading, body })
  }

  const links: SiteLink[] = []
  for (let i = 1; i <= 4; i++) {
    const label = fields[`link${i}Label`] ?? ''
    const url = fields[`link${i}Url`] ?? ''
    if (label.trim() === '' || url.trim() === '') continue
    links.push({ label, url })
  }

  return {
    title: fields['title'] ?? '',
    tagline: fields['tagline'] ?? '',
    description: fields['description'] ?? '',
    author: fields['author'] ?? '',
    sections,
    links,
    theme: fields['theme'] === 'paper' ? 'paper' : 'forest',
  }
}

function paragraphs(text: string): string {
  return text
    .trim()
    .split(/\n\s*\n/)
    .filter((block) => block.trim() !== '')
    .map((block) => `<p>${escapeHtml(block.trim()).replace(/\n/g, '<br />')}</p>`)
    .join('\n        ')
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeAttribute(input: string): string {
  return /^\s*javascript:/i.test(input) ? '#' : escapeHtml(input)
}

const BASE_CSS = `*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(55rem 28rem at 50% -10%,#152018 0%,transparent 60%),#0a0a0b;color:#ece9e2;font:16px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;-webkit-font-smoothing:antialiased}
main{width:min(44rem,100% - 2.5rem);margin:0 auto;padding:5rem 0 5rem}
a{color:#9ae6b4;text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:3px}
::selection{background:#9ae6b4;color:#07130c}
.mark{margin:0;color:#9ae6b4;font-size:.72rem;letter-spacing:.2em;text-transform:uppercase}
h1{margin:.5rem 0 .8rem;font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;font-size:clamp(2.4rem,7vw,4.4rem);font-weight:400;letter-spacing:-.03em;line-height:1.02}
.tagline{margin:0;color:#9a968d;font-size:1.05rem}
.intro{margin:2rem 0 0;color:#9a968d}
section{margin-top:3.5rem;padding-top:1.6rem;border-top:1px solid #26262a}
h2{margin:0 0 .8rem;font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;font-size:1.8rem;font-weight:400;letter-spacing:-.015em}
section p{margin:0 0 1rem;color:#9a968d}
.links{display:flex;flex-wrap:wrap;gap:.6rem 1.2rem;margin-top:3.5rem;padding-top:1.6rem;border-top:1px solid #26262a;font-size:.82rem}
footer{margin-top:4.5rem;padding-top:1.4rem;border-top:1px solid #26262a;color:#6d6a64;font-size:.72rem}
footer p{margin:0}`

const FOREST_CSS = BASE_CSS

const PAPER_CSS = BASE_CSS.replace(
  'background:radial-gradient(55rem 28rem at 50% -10%,#152018 0%,transparent 60%),#0a0a0b;color:#ece9e2',
  'background:radial-gradient(55rem 28rem at 50% -10%,#f4efe4 0%,transparent 60%),#f8f5ee;color:#1b1a17',
)
  .replace('color:#9ae6b4;font-size:.72rem', 'color:#3f6b4f;font-size:.72rem')
  .replace(/color:#9ae6b4/g, 'color:#2f6b43')
  .replace(/color:#9a968d/g, 'color:#5f5b52')
  .replace(/color:#6d6a64/g, 'color:#767168')
  .replace(/border-top:1px solid #26262a/g, 'border-top:1px solid #ddd5c6')
  .replace('::selection{background:#9ae6b4;color:#07130c}', '::selection{background:#2f6b43;color:#f8f5ee}')
