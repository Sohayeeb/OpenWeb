/**
 * Porter stemmer (1980), the classic one. No dependencies, no model, no
 * training data. It turns "tomatoes" into "tomato" and "searching" into
 * "search" so a query matches the words people actually wrote.
 *
 * This is the algorithm from Porter's paper, ported to TypeScript.
 */

const STEP2: Readonly<Record<string, string>> = {
  ational: 'ate',
  tional: 'tion',
  enci: 'ence',
  anci: 'ance',
  izer: 'ize',
  bli: 'ble',
  alli: 'al',
  entli: 'ent',
  eli: 'e',
  ousli: 'ous',
  ization: 'ize',
  ation: 'ate',
  ator: 'ate',
  alism: 'al',
  iveness: 'ive',
  fulness: 'ful',
  ousness: 'ous',
  aliti: 'al',
  iviti: 'ive',
  biliti: 'ble',
  logi: 'log',
}

const STEP3: Readonly<Record<string, string>> = {
  icate: 'ic',
  ative: '',
  alize: 'al',
  iciti: 'ic',
  ical: 'ic',
  ful: '',
  ness: '',
}

const c = '[^aeiou]'
const v = '[aeiouy]'
const C = c + '[^aeiouy]*'
const V = v + '[aeiou]*'
const MGR0 = new RegExp(`^(${C})?${V}${C}`)
const MEQ1 = new RegExp(`^(${C})?${V}${C}(${V})?$`)
const MGR1 = new RegExp(`^(${C})?${V}${C}${V}${C}`)
const S_V = new RegExp(`^(${C})?${v}`)

const STEP2_RE =
  /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/
const STEP3_RE = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/
const STEP4_RE =
  /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/
const STEP4_ION_RE = /^(.+?)(s|t)(ion)$/
const STEP5_RE = /^(.+?)e$/
const DOUBLE_CONSONANT_RE = /([^aeiouylsz])\1$/
const CVC_RE = new RegExp(`^${C}${v}[^aeiouwxy]$`)

export function stem(word: string): string {
  if (word.length < 3) return word
  let w = word

  if (w.charAt(0) === 'y') w = 'Y' + w.slice(1)

  // Step 1a
  if (/^(.+?)(ss|i)es$/.test(w)) {
    w = w.replace(/^(.+?)(ss|i)es$/, '$1$2')
  } else if (/^(.+?)([^s])s$/.test(w)) {
    w = w.replace(/^(.+?)([^s])s$/, '$1$2')
  }

  // Step 1b
  if (/^(.+?)eed$/.test(w)) {
    const match = /^(.+?)eed$/.exec(w)
    if (match?.[1] && MGR0.test(match[1])) w = w.slice(0, -1)
  } else if (/^(.+?)(ed|ing)$/.test(w)) {
    const match = /^(.+?)(ed|ing)$/.exec(w)
    const base = match?.[1]
    if (base && S_V.test(base)) {
      w = base
      if (/(at|bl|iz)$/.test(w)) {
        w += 'e'
      } else if (DOUBLE_CONSONANT_RE.test(w)) {
        w = w.slice(0, -1)
      } else if (CVC_RE.test(w)) {
        w += 'e'
      }
    }
  }

  // Step 1c
  if (/^(.+?)y$/.test(w)) {
    const base = /^(.+?)y$/.exec(w)?.[1]
    if (base && S_V.test(base)) w = base + 'i'
  }

  // Step 2
  const step2 = STEP2_RE.exec(w)
  if (step2?.[1] && step2[2] && MGR0.test(step2[1])) {
    w = step2[1] + STEP2[step2[2]]
  }

  // Step 3
  const step3 = STEP3_RE.exec(w)
  if (step3?.[1] && step3[2] && MGR0.test(step3[1])) {
    w = step3[1] + STEP3[step3[2]]
  }

  // Step 4
  const step4 = STEP4_RE.exec(w)
  if (step4?.[1] && MGR1.test(step4[1])) {
    w = step4[1]
  } else {
    const ion = STEP4_ION_RE.exec(w)
    if (ion?.[1] && ion[2] && MGR1.test(ion[1] + ion[2])) {
      w = ion[1] + ion[2]
    }
  }

  // Step 5
  const step5 = STEP5_RE.exec(w)
  if (step5?.[1]) {
    const base = step5[1]
    if (MGR1.test(base) || (MEQ1.test(base) && !CVC_RE.test(base))) {
      w = base
    }
  }

  if (/ll$/.test(w) && MGR1.test(w)) w = w.slice(0, -1)
  if (w.charAt(0) === 'Y') w = 'y' + w.slice(1)

  return w
}
