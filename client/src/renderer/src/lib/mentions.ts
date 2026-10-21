// Menções com @apelido. Apelidos podem ter espaço, então o texto é comparado com os apelidos
// conhecidos (o mais longo primeiro: "@joão pedro" ganha de "@joão").

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// antes do @ não pode vir letra/número (e-mail não é menção) e depois do apelido também não
// (senão "@lu" marcaria "@luis")
const START = '(?<![\\p{L}\\p{N}_])@'
const END = '(?![\\p{L}\\p{N}_])'

export function mentionRegex(nicknames: Iterable<string>): RegExp | null {
  const list = [...new Set([...nicknames].filter(Boolean))].sort((a, b) => b.length - a.length)
  if (!list.length) return null
  return new RegExp(`${START}(${list.map(escapeRe).join('|')})${END}`, 'giu')
}

/** A mensagem menciona este apelido? */
export function mentions(text: string, nickname: string): boolean {
  return new RegExp(`${START}${escapeRe(nickname)}${END}`, 'iu').test(text)
}

/** "@que" logo antes do cursor (o que a pessoa está digitando para mencionar), ou null. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)@([^\s@]{0,32})$/.exec(text.slice(0, caret))
  if (!match) return null
  return { start: caret - match[2].length - 1, query: match[2] }
}
