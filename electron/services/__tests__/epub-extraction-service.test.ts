import { describe, expect, it } from 'vitest'

import { extractEpubChapters } from '../epub-extraction-service'
import { storedZip } from './epub-test-fixture'

function utf16Le(value: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')])
}

describe('EPUB chapter extraction', () => {
  it('follows an EPUB 2 package spine and preserves Unicode novel text', async () => {
    const archive = storedZip({
      'META-INF/container.xml': `<?xml version="1.0"?>
        <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
          <rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
        </container>`,
      'OPS/content.opf': `<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="2.0">
          <manifest>
            <item id="second" href="chapters/第二章.xhtml" media-type="application/xhtml+xml"/>
            <item id="first" href="chapters/chapter-1.xhtml" media-type="application/xhtml+xml"/>
          </manifest>
          <spine><itemref idref="first"/><itemref idref="second"/></spine>
        </package>`,
      'OPS/chapters/chapter-1.xhtml': `<?xml version="1.0"?>
        <html xmlns="http://www.w3.org/1999/xhtml"><head><title>初遇</title></head>
          <body><h1>第一章 初遇</h1><p>雨落在长安城。她说：“你好，世界。”</p></body></html>`,
      'OPS/chapters/第二章.xhtml': `<?xml version="1.0"?>
        <html xmlns="http://www.w3.org/1999/xhtml"><head><title>重逢</title></head>
          <body><h1>第二章 重逢</h1><p>Café 灯火未熄，陆云飞回来了。</p></body></html>`,
    })

    await expect(extractEpubChapters(archive)).resolves.toEqual([
      { title: '第一章 初遇', content: '第一章 初遇\n\n雨落在长安城。她说：“你好，世界。”' },
      { title: '第二章 重逢', content: '第二章 重逢\n\nCafé 灯火未熄，陆云飞回来了。' },
    ])
  })

  it('extracts EPUB 3 HTML in spine order while skipping navigation and non-linear resources', async () => {
    const archive = storedZip({
      'META-INF/container.xml': '<container><rootfiles><rootfile full-path="book/package.opf"/></rootfiles></container>',
      'book/package.opf': `<package version="3.0"><manifest>
          <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
          <item id="one" href="text/part%201.html" media-type="text/html"/>
          <item id="two" href="text/part-2.xhtml" media-type="application/xhtml+xml"/>
          <item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/>
        </manifest><spine>
          <itemref idref="nav"/><itemref idref="two"/><itemref idref="one"/>
          <itemref idref="notes" linear="no"/>
        </spine></package>`,
      'book/nav.xhtml': '<html><body><nav><a href="text/part%201.html">目录</a></nav></body></html>',
      'book/text/part 1.html': '<html><head><title>First &amp; Last</title></head><body><p>你好&#x4E16;&#30028;。</p></body></html>',
      'book/text/part-2.xhtml': '<html><body><h2>第二幕</h2><p>élan &amp; courage</p></body></html>',
      'book/text/notes.xhtml': '<html><body><h2>注释</h2><p>不应导入</p></body></html>',
    })

    await expect(extractEpubChapters(archive)).resolves.toEqual([
      { title: '第二幕', content: '第二幕\n\nélan & courage' },
      { title: 'First & Last', content: '你好世界。' },
    ])
  })

  it('decodes UTF-16 XML and XHTML entries', async () => {
    const archive = storedZip({
      'META-INF/container.xml': utf16Le('<?xml version="1.0" encoding="UTF-16"?><container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),
      'book.opf': utf16Le('<?xml version="1.0" encoding="UTF-16"?><package><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>'),
      'one.xhtml': utf16Le('<?xml version="1.0" encoding="UTF-16"?><html><head><title>Arrival</title></head><body><p>夜色降临，café 仍亮着灯。</p></body></html>'),
    })

    await expect(extractEpubChapters(archive)).resolves.toEqual([
      { title: 'Arrival', content: '夜色降临，café 仍亮着灯。' },
    ])
  })

  it.each([
    { name: 'corrupt ZIP data', archive: Buffer.from('not a zip archive') },
    { name: 'a missing container.xml', archive: storedZip({ 'book/content.opf': '<package/>' }) },
    { name: 'a zip-slip entry', archive: storedZip({ '../META-INF/container.xml': '<container/>' }) },
  ])('rejects $name as an invalid EPUB', async ({ archive }) => {
    await expect(extractEpubChapters(archive)).rejects.toMatchObject({
      code: 'EPUB_INVALID_ARCHIVE',
    })
  })

  it('rejects encrypted EPUB content with an explicit DRM error', async () => {
    const archive = storedZip({
      'META-INF/encryption.xml': '<encryption/>',
      'META-INF/container.xml': '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      'book.opf': '<package><manifest/><spine/></package>',
    })

    await expect(extractEpubChapters(archive)).rejects.toMatchObject({
      code: 'EPUB_DRM_UNSUPPORTED',
    })
  })

  it('bounds archive entry count before extracting content', async () => {
    const archive = storedZip({
      'META-INF/container.xml': '<container/>',
      'book.opf': '<package/>',
      'text/chapter.xhtml': '<html/>',
    })

    await expect(extractEpubChapters(archive, { maxEntries: 2 })).rejects.toMatchObject({
      code: 'EPUB_EXPANSION_LIMIT',
    })
  })

  it('bounds both one expanded entry and cumulative extracted bytes', async () => {
    const container = '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'
    const opf = `<package><manifest>
      <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
      </manifest><spine><itemref idref="chapter"/></spine></package>`
    const archive = storedZip({
      'META-INF/container.xml': container,
      'book.opf': opf,
      'chapter.xhtml': '<html><body><p>正文</p></body></html>',
    })

    await expect(extractEpubChapters(archive, { maxEntryBytes: container.length - 1 }))
      .rejects.toMatchObject({ code: 'EPUB_EXPANSION_LIMIT' })
    await expect(extractEpubChapters(archive, {
      maxEntryBytes: 1_000,
      maxExtractedBytes: Buffer.byteLength(container) + Buffer.byteLength(opf) - 1,
    })).rejects.toMatchObject({ code: 'EPUB_EXPANSION_LIMIT' })
  })
})
