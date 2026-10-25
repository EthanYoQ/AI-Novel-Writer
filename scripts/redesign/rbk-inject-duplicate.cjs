// 用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE=1，与应用同一个 better-sqlite3 ABI）直接改项目库，
// 造出旧版本「回退到此版本」再定稿留下的数据：第 chapter 章再多一行带收据的 finalized。
const { createHash, randomUUID } = require('node:crypto')
const Database = require('better-sqlite3')

const [databasePath, chapterArg] = process.argv.slice(2)
const chapter = Number(chapterArg)
const db = new Database(databasePath, { fileMustExist: true })
try {
  db.transaction(() => {
    const old = db.prepare(`
      SELECT drafts.version, finalization_outbox.chapter_title FROM drafts
      JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
      WHERE drafts.chapter_number = ? AND drafts.status = 'finalized'
    `).get(chapter)
    if (!old) throw new Error(`第 ${chapter} 章没有定稿`)
    const body = `第 ${chapter} 章旧版本回退后再定稿的正文：潮水退得比往常早。`
    const version = db.prepare('SELECT MAX(version) FROM drafts WHERE chapter_number = ?').pluck().get(chapter) + 1
    const contentId = Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(body).lastInsertRowid)
    const draftId = Number(db.prepare(`
      INSERT INTO drafts(chapter_number, version, status, source, content_id, word_count) VALUES(?, ?, 'finalized', 'rewrite', ?, ?)
    `).run(chapter, version, contentId, body.length).lastInsertRowid)
    db.prepare(`
      INSERT INTO finalization_outbox(finalization_id, draft_id, chapter_number, chapter_title, content_hash, content_revision,
        content_snapshot, target_file_name, knowledge_document_id, publication_status)
      VALUES(?, ?, ?, ?, ?, 1, ?, ?, ?, 'published')
    `).run(randomUUID(), draftId, chapter, old.chapter_title, createHash('sha256').update(body).digest('hex'), body,
      `第${chapter}章 ${old.chapter_title}-重复.txt`, `legacy-kb-${chapter}`)
  })()
  const finalized = db.prepare("SELECT COUNT(*) FROM drafts WHERE chapter_number = ? AND status = 'finalized'").pluck().get(chapter)
  process.stdout.write(JSON.stringify({ chapter, finalized }))
} finally { db.close() }
