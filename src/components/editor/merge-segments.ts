import { useCallback, useMemo, useState } from 'react'

// ===== 类型定义 =====
export interface Hunk {
  index: number
  originalLines: string[]
  modifiedLines: string[]
}

export interface DiffSegment {
  type: 'same' | 'hunk'
  lines?: string[]
  hunk?: Hunk
}


// ===== 文本工具 =====

/** 去除 YAML frontmatter */
function stripFrontmatter(text: string): string {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return m ? text.slice(m[0].length) : text
}

/**
 * 提取段落列表（非空文本块，空行是分隔符）
 * 返回格式：每个元素是一个段落的完整文本（可能包含多行）
 */
function extractParagraphs(text: string): string[] {
  const lines = text.split('\n')
  const paras: string[] = []
  let buf: string[] = []
  for (const line of lines) {
    if (line.trim() === '') {
      if (buf.length > 0) { paras.push(buf.join('\n')); buf = [] }
    } else {
      buf.push(line)
    }
  }
  if (buf.length > 0) paras.push(buf.join('\n'))
  return paras
}

/** 字符频率 map */
type CharFreq = Map<string, number>

function buildCharFreq(text: string): CharFreq {
  const freq: CharFreq = new Map()
  for (const c of text) freq.set(c, (freq.get(c) || 0) + 1)
  return freq
}

/** 合并多个频率 map */
function mergeFreqs(...maps: CharFreq[]): CharFreq {
  const merged: CharFreq = new Map()
  for (const m of maps) for (const [c, n] of m) merged.set(c, (merged.get(c) || 0) + n)
  return merged
}

/** 从预计算的频率 map 计算相似度（避免重复创建 Map） */
function simFromFreqs(fa: CharFreq, lenA: number, fb: CharFreq, lenB: number): number {
  if (lenA === 0 && lenB === 0) return 1
  if (lenA === 0 || lenB === 0) return 0
  // 长度比 >5 直接判定不相似（快速拒绝）
  if (lenA > lenB * 5 || lenB > lenA * 5) return 0
  let common = 0
  // 遍历较小的 map 提高效率
  const [smaller, larger] = fa.size <= fb.size ? [fa, fb] : [fb, fa]
  for (const [c, n] of smaller) common += Math.min(n, larger.get(c) || 0)
  return (2 * common) / (lenA + lenB)
}

// ===== DP 段落对齐算法 =====

/** 对齐操作类型 */
const enum AlignOp {
  MATCH, DELETE, INSERT, SPLIT_1_2, SPLIT_1_3, MERGE_2_1, MERGE_3_1,
}

interface AlignPair {
  origIdx: number[]
  modIdx: number[]
}

/**
 * 基于相似度的 DP 段落对齐（性能优化版）
 * 预计算所有频率 map，避免 DP 循环中重复创建
 */
function alignParagraphs(origParas: string[], modParas: string[]): AlignPair[] {
  const n = origParas.length, m = modParas.length
  const SIM_THRESH = 0.15, GAP = -0.05

  // ===== 预计算频率 map =====
  const oFreqs = origParas.map(buildCharFreq)
  const mFreqs = modParas.map(buildCharFreq)
  const oLens = origParas.map(p => p.length)
  const mLens = modParas.map(p => p.length)

  // 预计算相邻 2/3 段落的合并频率（用于 split/merge）
  const mPairFreqs: CharFreq[] = new Array(m)
  const mPairLens: number[] = new Array(m)
  for (let j = 1; j < m; j++) {
    mPairFreqs[j] = mergeFreqs(mFreqs[j - 1], mFreqs[j])
    mPairLens[j] = mLens[j - 1] + mLens[j]
  }
  const mTriFreqs: CharFreq[] = new Array(m)
  const mTriLens: number[] = new Array(m)
  for (let j = 2; j < m; j++) {
    mTriFreqs[j] = mergeFreqs(mFreqs[j - 2], mFreqs[j - 1], mFreqs[j])
    mTriLens[j] = mLens[j - 2] + mLens[j - 1] + mLens[j]
  }
  const oPairFreqs: CharFreq[] = new Array(n)
  const oPairLens: number[] = new Array(n)
  for (let i = 1; i < n; i++) {
    oPairFreqs[i] = mergeFreqs(oFreqs[i - 1], oFreqs[i])
    oPairLens[i] = oLens[i - 1] + oLens[i]
  }
  const oTriFreqs: CharFreq[] = new Array(n)
  const oTriLens: number[] = new Array(n)
  for (let i = 2; i < n; i++) {
    oTriFreqs[i] = mergeFreqs(oFreqs[i - 2], oFreqs[i - 1], oFreqs[i])
    oTriLens[i] = oLens[i - 2] + oLens[i - 1] + oLens[i]
  }

  // ===== DP =====
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(-1e9))
  const op: AlignOp[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(AlignOp.MATCH))
  dp[0][0] = 0
  for (let i = 1; i <= n; i++) { dp[i][0] = i * GAP; op[i][0] = AlignOp.DELETE }
  for (let j = 1; j <= m; j++) { dp[0][j] = j * GAP; op[0][j] = AlignOp.INSERT }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let best = -1e9, bestOp = AlignOp.MATCH

      // 1:1
      const s11 = simFromFreqs(oFreqs[i - 1], oLens[i - 1], mFreqs[j - 1], mLens[j - 1])
      const v11 = dp[i - 1][j - 1] + (s11 >= SIM_THRESH ? s11 : s11 - 0.5)
      if (v11 > best) { best = v11; bestOp = AlignOp.MATCH }

      // 删除 / 插入
      if (dp[i - 1][j] + GAP > best) { best = dp[i - 1][j] + GAP; bestOp = AlignOp.DELETE }
      if (dp[i][j - 1] + GAP > best) { best = dp[i][j - 1] + GAP; bestOp = AlignOp.INSERT }

      // 1:2 拆分
      if (j >= 2) {
        const s = simFromFreqs(oFreqs[i - 1], oLens[i - 1], mPairFreqs[j - 1], mPairLens[j - 1])
        if (s >= SIM_THRESH) { const v = dp[i - 1][j - 2] + s * 0.95; if (v > best) { best = v; bestOp = AlignOp.SPLIT_1_2 } }
      }
      // 1:3 拆分
      if (j >= 3) {
        const s = simFromFreqs(oFreqs[i - 1], oLens[i - 1], mTriFreqs[j - 1], mTriLens[j - 1])
        if (s >= SIM_THRESH) { const v = dp[i - 1][j - 3] + s * 0.9; if (v > best) { best = v; bestOp = AlignOp.SPLIT_1_3 } }
      }
      // 2:1 合并
      if (i >= 2) {
        const s = simFromFreqs(oPairFreqs[i - 1], oPairLens[i - 1], mFreqs[j - 1], mLens[j - 1])
        if (s >= SIM_THRESH) { const v = dp[i - 2][j - 1] + s * 0.95; if (v > best) { best = v; bestOp = AlignOp.MERGE_2_1 } }
      }
      // 3:1 合并
      if (i >= 3) {
        const s = simFromFreqs(oTriFreqs[i - 1], oTriLens[i - 1], mFreqs[j - 1], mLens[j - 1])
        if (s >= SIM_THRESH) { const v = dp[i - 3][j - 1] + s * 0.9; if (v > best) { best = v; bestOp = AlignOp.MERGE_3_1 } }
      }

      dp[i][j] = best; op[i][j] = bestOp
    }
  }

  // 回溯构建对齐结果
  const pairs: AlignPair[] = []
  let ci = n, cj = m
  while (ci > 0 || cj > 0) {
    if (ci === 0) { pairs.unshift({ origIdx: [], modIdx: [--cj] }); continue }
    if (cj === 0) { pairs.unshift({ origIdx: [--ci], modIdx: [] }); continue }
    switch (op[ci][cj]) {
      case AlignOp.MATCH:
        pairs.unshift({ origIdx: [ci - 1], modIdx: [cj - 1] }); ci--; cj--; break
      case AlignOp.DELETE:
        pairs.unshift({ origIdx: [ci - 1], modIdx: [] }); ci--; break
      case AlignOp.INSERT:
        pairs.unshift({ origIdx: [], modIdx: [cj - 1] }); cj--; break
      case AlignOp.SPLIT_1_2:
        pairs.unshift({ origIdx: [ci - 1], modIdx: [cj - 2, cj - 1] }); ci--; cj -= 2; break
      case AlignOp.SPLIT_1_3:
        pairs.unshift({ origIdx: [ci - 1], modIdx: [cj - 3, cj - 2, cj - 1] }); ci--; cj -= 3; break
      case AlignOp.MERGE_2_1:
        pairs.unshift({ origIdx: [ci - 2, ci - 1], modIdx: [cj - 1] }); ci -= 2; cj--; break
      case AlignOp.MERGE_3_1:
        pairs.unshift({ origIdx: [ci - 3, ci - 2, ci - 1], modIdx: [cj - 1] }); ci -= 3; cj--; break
    }
  }
  return pairs
}

// ===== 从对齐结果生成 DiffSegment =====

function buildSegments(origParas: string[], modParas: string[], pairs: AlignPair[]): DiffSegment[] {
  const segments: DiffSegment[] = []
  let hunkIdx = 0

  /** 段落文本 → 行数组 */
  const paraToLines = (para: string) => para.split('\n')

  /** 多个段落 → 行数组（段落间插入空行） */
  const parasToLines = (paras: string[], indices: number[]) => {
    const lines: string[] = []
    indices.forEach((idx, i) => {
      if (i > 0) lines.push('') // 段落间空行
      lines.push(...paraToLines(paras[idx]))
    })
    return lines
  }

  for (let p = 0; p < pairs.length; p++) {
    const pair = pairs[p]
    const origLines = pair.origIdx.length > 0 ? parasToLines(origParas, pair.origIdx) : []
    const modLines = pair.modIdx.length > 0 ? parasToLines(modParas, pair.modIdx) : []

    // 判断是否完全相同
    const isSame = origLines.length > 0 && modLines.length > 0 &&
      origLines.length === modLines.length &&
      origLines.every((l, i) => l === modLines[i])

    if (isSame) {
      segments.push({ type: 'same', lines: origLines })
    } else {
      segments.push({
        type: 'hunk',
        hunk: { index: hunkIdx++, originalLines: origLines, modifiedLines: modLines },
      })
    }

    // 段落之间插入空行同步锚点（最后一组不加）
    if (p < pairs.length - 1) {
      segments.push({ type: 'same', lines: [''] })
    }
  }
  return segments
}

/** 入口：计算 diff segments */
export function computeSegments(original: string, modified: string): DiffSegment[] {
  const cleanOrig = stripFrontmatter(original)
  const cleanMod = stripFrontmatter(modified)
  const origParas = extractParagraphs(cleanOrig)
  const modParas = extractParagraphs(cleanMod)
  const pairs = alignParagraphs(origParas, modParas)
  return buildSegments(origParas, modParas, pairs)
}

/** 一处改动用哪一版：原稿、修稿，或作者手动改过的文字。 */
export type HunkPick = 'original' | 'revised' | 'edit'

/**
 * 修稿合并的数据：段落对齐后的片段、每处改动的选择与每段的合并文字。
 * 单章视图的合并视图用它；合并结果就是各段文字按顺序以换行连接。
 */
export function useMergeSegments(originalContent: string, modifiedContent: string) {
  const segments = useMemo(() => computeSegments(originalContent, modifiedContent), [originalContent, modifiedContent])
  const hunks = useMemo(() => segments.filter(s => s.type === 'hunk').map(s => s.hunk!), [segments])
  const [picks, setPicks] = useState<Record<number, HunkPick>>({})
  const [segTexts, setSegTexts] = useState<Record<number, string>>(() => {
    const init: Record<number, string> = {}
    segments.forEach((s, i) => {
      if (s.type === 'same') init[i] = (s.lines || []).join('\n')
      else if (s.hunk) init[i] = s.hunk.originalLines.join('\n')
    })
    return init
  })

  const hunkSegIdx = useMemo(() => {
    const m: Record<number, number> = {}
    segments.forEach((s, i) => { if (s.hunk) m[s.hunk.index] = i })
    return m
  }, [segments])

  /** 选原稿或修稿时这一段换成那一版的文字；选手动编辑时保留当前文字，等作者改。 */
  const choose = useCallback((hunkIndex: number, pick: HunkPick) => {
    setPicks(prev => ({ ...prev, [hunkIndex]: pick }))
    const hunk = hunks.find(h => h.index === hunkIndex)
    const si = hunkSegIdx[hunkIndex]
    if (!hunk || si === undefined || pick === 'edit') return
    setSegTexts(p => ({ ...p, [si]: (pick === 'revised' ? hunk.modifiedLines : hunk.originalLines).join('\n') }))
  }, [hunks, hunkSegIdx])

  const editSegment = useCallback((segIndex: number, value: string) => {
    setSegTexts(p => ({ ...p, [segIndex]: value }))
  }, [])

  const chooseAll = useCallback((pick: 'original' | 'revised') => {
    const next: Record<number, HunkPick> = {}
    const texts: Record<number, string> = {}
    hunks.forEach(h => {
      next[h.index] = pick
      texts[hunkSegIdx[h.index]] = (pick === 'revised' ? h.modifiedLines : h.originalLines).join('\n')
    })
    setPicks(next)
    setSegTexts(p => ({ ...p, ...texts }))
  }, [hunks, hunkSegIdx])

  const mergedText = useCallback(() => segments.map((_, i) => segTexts[i] ?? '').join('\n'), [segments, segTexts])

  return { segments, hunks, picks, segTexts, choose, editSegment, chooseAll, mergedText }
}
