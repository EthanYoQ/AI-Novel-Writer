/** 英文里数量后的名词：1 用单数，其余（含 0）用复数。复数默认加 s，不规则的（entry → entries）显式传入。 */
export const pluralEn = (count: number, noun: string, plural = `${noun}s`) => (count === 1 ? noun : plural)
