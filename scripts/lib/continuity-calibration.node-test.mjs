// Run explicitly with node --test; .node-test avoids Vitest's automatic suite discovery.
import test from "node:test"
import assert from "node:assert/strict"

import {
  buildFocusedReviewMessages,
  parseFocusedReviewOutput,
  summarizeCalibrationResults,
} from "./continuity-calibration.mjs"

const packet = {
  authorRequirements: "本章让林岚确认钥匙已交给周宁；若证据不足可以保持未知。",
  sources: [
    { id: "chapter-2", text: "雨停后，林岚把铜钥匙放进周宁掌心。" },
    { id: "state", text: "当前记录：铜钥匙由周宁保管。" },
  ],
  chapter: {
    id: "chapter-3",
    text: "周宁隔着口袋摸到铜钥匙，没有向旁人解释来处。",
  },
  originalChapter: {
    id: "chapter-3-original",
    text: "周宁确认钥匙仍在自己手里。",
  },
}

test("构造有限中文检查消息并保留全部资料", () => {
  const messages = buildFocusedReviewMessages(packet)

  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, "system")
  assert.match(messages[0].content, /允许合理省略/)
  assert.match(messages[0].content, /转交/)
  assert.match(messages[0].content, /延期/)
  assert.match(messages[0].content, /不可靠叙述/)
  assert.match(messages[0].content, /不检查字数、文风/)
  assert.match(messages[0].content, /clear 只表示/)
  assert.match(messages[1].content, /chapter-3-original/)
  assert.match(messages[1].content, /若证据不足可以保持未知/)
})

test("拒绝重复资料 id", () => {
  assert.throws(
    () => buildFocusedReviewMessages({
      ...packet,
      sources: [{ id: "chapter-3", text: "重复 id。" }],
    }),
    /资料 id 重复/,
  )
})

test("解析 clear 且不把它解释为事实已证明", () => {
  const result = parseFocusedReviewOutput('{"conclusion":"clear","findings":[]}', packet)

  assert.deepEqual(result, {
    valid: true,
    conclusion: "clear",
    findings: [],
    errors: [],
  })
})

test("定位来自不同资料的冲突引文", () => {
  const raw = JSON.stringify({
    conclusion: "conflict",
    findings: [{
      category: "state",
      description: "当前章若让其他人无依据持有钥匙，会与已交付状态冲突。",
      evidence: [
        { sourceId: "chapter-2", quote: "林岚把铜钥匙放进周宁掌心" },
        { sourceId: "chapter-3", quote: "周宁隔着口袋摸到铜钥匙" },
      ],
      severity: "critical",
    }],
  })

  const result = parseFocusedReviewOutput(raw, packet)

  assert.equal(result.valid, true)
  assert.equal(result.findings[0].evidence.length, 2)
  assert.equal(result.findings[0].evidence[0].sourceId, "chapter-2")
  assert.equal(
    packet.sources[0].text.slice(
      result.findings[0].evidence[0].start,
      result.findings[0].evidence[0].end,
    ),
    "林岚把铜钥匙放进周宁掌心",
  )
})

test("引文位置对应未裁剪的原始资料", () => {
  const paddedPacket = {
    ...packet,
    sources: [{ id: "带缩进资料", text: "  开头保留空格，随后出现线索。  " }],
  }
  const result = parseFocusedReviewOutput(JSON.stringify({
    conclusion: "unknown",
    findings: [{
      category: "state",
      description: "这条线索是否改变状态仍不明确。",
      evidence: [{ sourceId: "带缩进资料", quote: "开头保留空格" }],
      severity: "warning",
    }],
  }), paddedPacket)

  assert.equal(result.valid, true)
  assert.equal(result.findings[0].evidence[0].start, 2)
})

test("允许引用作者要求和原稿而非只引用新章", () => {
  const raw = JSON.stringify({
    conclusion: "unknown",
    findings: [{
      category: "goal",
      description: "新章没有明说是否完成确认，但合理省略仍可能成立。",
      evidence: [
        { sourceId: "authorRequirements", quote: "本章让林岚确认钥匙已交给周宁" },
        { sourceId: "chapter-3-original", quote: "周宁确认钥匙仍在自己手里" },
      ],
      severity: "warning",
    }],
  })

  const result = parseFocusedReviewOutput(raw, packet)

  assert.equal(result.valid, true)
  assert.equal(result.conclusion, "unknown")
  assert.deepEqual(result.findings[0].evidence.map(({ sourceId }) => sourceId), [
    "authorRequirements",
    "chapter-3-original",
  ])
})

test("引文无法定位时返回 invalid unknown", () => {
  const raw = JSON.stringify({
    conclusion: "conflict",
    findings: [{
      category: "time",
      description: "时间条件冲突。",
      evidence: [{ sourceId: "chapter-3", quote: "昨夜已经响过三次钟" }],
      severity: "critical",
    }],
  })

  const result = parseFocusedReviewOutput(raw, packet)

  assert.equal(result.valid, false)
  assert.equal(result.conclusion, "unknown")
  assert.match(result.errors[0], /无法.*定位/)
})

test("格式错误、空冲突和 clear 带 finding 均无效", () => {
  assert.equal(parseFocusedReviewOutput("不是 JSON", packet).valid, false)
  assert.equal(parseFocusedReviewOutput('{"conclusion":"conflict","findings":[]}', packet).valid, false)
  assert.equal(parseFocusedReviewOutput(JSON.stringify({
    conclusion: "clear",
    findings: [{
      category: "knowledge",
      description: "不一致的空结论。",
      evidence: [{ sourceId: "chapter-3", quote: "没有向旁人解释来处" }],
      severity: "warning",
    }],
  }), packet).valid, false)
})

test("finding 说明必须使用中文", () => {
  const result = parseFocusedReviewOutput(JSON.stringify({
    conclusion: "unknown",
    findings: [{
      category: "knowledge",
      description: "123",
      evidence: [{ sourceId: "chapter-3", quote: "没有向旁人解释来处" }],
      severity: "warning",
    }],
  }), packet)

  assert.equal(result.valid, false)
  assert.equal(result.conclusion, "unknown")
})

test("拒绝重复 finding 和重复 evidence", () => {
  const finding = {
    category: "state",
    description: "同一问题。",
    evidence: [{ sourceId: "state", quote: "铜钥匙由周宁保管" }],
    severity: "warning",
  }
  const duplicateFinding = parseFocusedReviewOutput(JSON.stringify({
    conclusion: "unknown",
    findings: [finding, finding],
  }), packet)
  const duplicateEvidence = parseFocusedReviewOutput(JSON.stringify({
    conclusion: "unknown",
    findings: [{ ...finding, evidence: [finding.evidence[0], finding.evidence[0]] }],
  }), packet)

  assert.equal(duplicateFinding.valid, false)
  assert.equal(duplicateEvidence.valid, false)
})

test("汇总只报告机械有效性和结构计数", () => {
  const clear = parseFocusedReviewOutput('{"conclusion":"clear","findings":[]}', packet)
  const unknown = parseFocusedReviewOutput(JSON.stringify({
    conclusion: "unknown",
    findings: [{
      category: "knowledge",
      description: "没有足够证据确认旁人是否知情。",
      evidence: [{ sourceId: "chapter-3", quote: "没有向旁人解释来处" }],
      severity: "warning",
    }],
  }), packet)
  const invalid = parseFocusedReviewOutput("无法解析", packet)

  assert.deepEqual(summarizeCalibrationResults([clear, unknown, invalid]), {
    total: 3,
    valid: 2,
    invalid: 1,
    conclusions: { clear: 1, conflict: 0, unknown: 1 },
    findings: { total: 1, critical: 0, warning: 1 },
    evidenceCount: 1,
  })
})
