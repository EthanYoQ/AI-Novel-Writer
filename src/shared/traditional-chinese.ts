import { Converter } from 'opencc-js'

// Convert built-in copy before interpolating user data, so names and manuscripts
// remain exactly as entered. Taiwan phrases cover UI terms as well as glyphs.
const convert = Converter({ from: 'cn', to: 'twp' })

export function toTraditionalChinese(text: string): string {
  return convert(text)
}
