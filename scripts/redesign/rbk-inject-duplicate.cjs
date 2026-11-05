const { createHash, randomUUID } = require('node:crypto')
const Database = require('better-sqlite3')

const [databasePath, chapterArg] = process.argv.slice(2)
const chapter = Number(chapterArg)
const db = new Database(databasePath, { fileMustExist: true })
try {
  db.transaction(() => {
    const old = db.prepare(`
      SELECT drafts_all.id, finalization_outbox_all.chapter_title FROM drafts_all
      JOIN finalization_outbox_all ON finalization_outbox_all.draft_id = drafts_all.id
      WHERE drafts_all.chapter_number = ? AND drafts_all.status = 'finalized'
    `).get(chapter)
    if (!old) throw new Error(`第 ${chapter} 章没有定稿`)
    db.prepare("UPDATE finalization_outbox_all SET knowledge_document_id = ? WHERE draft_id = ? AND knowledge_document_id = ''")
      .run(`legacy-kb-${chapter}-old`, old.id)
    const body = `第 ${chapter} 章旧版本回退后再定稿的正文：潮水退得比往常早。`
    const version = db.prepare('SELECT MAX(version) FROM drafts_all WHERE chapter_number = ?').pluck().get(chapter) + 1
    const contentId = Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(body).lastInsertRowid)
    const draftId = Number(db.prepare(`
      INSERT INTO drafts_all(chapter_number, version, status, source, content_id, word_count) VALUES(?, ?, 'finalized', 'rewrite', ?, ?)
    `).run(chapter, version, contentId, body.length).lastInsertRowid)
    db.prepare(`
      INSERT INTO finalization_outbox_all(finalization_id, draft_id, chapter_number, chapter_title, content_hash, content_revision,
        content_snapshot, target_file_name, knowledge_document_id, publication_status)
      VALUES(?, ?, ?, ?, ?, 1, ?, ?, ?, 'published')
    `).run(randomUUID(), draftId, chapter, old.chapter_title, createHash('sha256').update(body).digest('hex'), body,
      `第${chapter}章 ${old.chapter_title}-重复.txt`, `legacy-kb-${chapter}`)
  })()
  const finalized = db.prepare("SELECT COUNT(*) FROM drafts_all WHERE chapter_number = ? AND status = 'finalized'").pluck().get(chapter)
  process.stdout.write(JSON.stringify({ chapter, finalized }))
} finally { db.close() }
