// Reads a Word (.docx) file into plain text in the browser, so the AI can understand it.
// A .docx is a zip of XML files. We unzip just the parts with text, then walk the XML.
// Tables become "cell | cell | cell" lines so schedules keep their rows and columns.

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Minimal zip reader: finds files through the central directory at the end of the archive.
async function unzip(buf, wanted) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 70000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('That file isn\'t a valid .docx. If it\'s an older .doc file, open it in Word and save it as .docx or PDF.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder(), out = {};
  for (let n = 0; n < count && p + 46 <= buf.byteLength; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = u8.subarray(start, start + size);
    if (method === 0) out[name] = dec.decode(data);
    else if (method === 8) out[name] = dec.decode(await inflate(data));
  }
  return out;
}

function paragraphText(p) {
  let s = '';
  const walk = node => {
    for (const ch of node.childNodes) {
      if (ch.nodeType !== 1) continue;
      if (ch.namespaceURI === W) {
        if (ch.localName === 't') { s += ch.textContent; continue; }
        if (ch.localName === 'tab') { s += '\t'; continue; }
        if (ch.localName === 'br' || ch.localName === 'cr') { s += '\n'; continue; }
        if (ch.localName === 'delText') continue;            // tracked deletions aren't real text
      }
      walk(ch);
    }
  };
  walk(p);
  return s.replace(/[ \t]+$/g, '');
}

function blockText(container) {
  const lines = [];
  for (const el of container.childNodes) {
    if (el.nodeType !== 1 || el.namespaceURI !== W) continue;
    if (el.localName === 'p') { const t = paragraphText(el); if (t.trim()) lines.push(t); }
    else if (el.localName === 'tbl') {
      for (const tr of el.getElementsByTagNameNS(W, 'tr')) {
        if (tr.parentNode !== el) continue;                   // skip rows of nested tables here
        const cells = [...tr.childNodes].filter(c => c.nodeType === 1 && c.localName === 'tc')
          .map(tc => blockText(tc).replace(/\n+/g, ' ').trim());
        if (cells.some(Boolean)) lines.push(cells.join(' | '));
      }
      lines.push('');
    } else if (el.localName === 'sdt') {                     // content controls wrap normal text
      const content = el.getElementsByTagNameNS(W, 'sdtContent')[0];
      if (content) { const t = blockText(content); if (t.trim()) lines.push(t); }
    }
  }
  return lines.join('\n');
}

export async function docxToText(file) {
  const buf = await file.arrayBuffer();
  const parts = await unzip(buf, n => n === 'word/document.xml' || /^word\/(header|footer)\d*\.xml$/.test(n) || n === 'word/footnotes.xml');
  if (!parts['word/document.xml']) throw new Error('I couldn\'t find any text in that Word file.');
  const parse = xml => new DOMParser().parseFromString(xml, 'application/xml');
  const bodyOf = doc => doc.getElementsByTagNameNS(W, 'body')[0] || doc.documentElement;
  const headers = Object.keys(parts).filter(n => /header/.test(n)).sort().map(n => blockText(parse(parts[n]).documentElement)).filter(t => t.trim());
  const footers = Object.keys(parts).filter(n => /footer|footnotes/.test(n)).sort().map(n => blockText(parse(parts[n]).documentElement)).filter(t => t.trim());
  const body = blockText(bodyOf(parse(parts['word/document.xml'])));
  const text = [...new Set(headers)].join('\n') + (headers.length ? '\n\n' : '') + body + (footers.length ? '\n\n' + [...new Set(footers)].join('\n') : '');
  if (!text.trim()) throw new Error('That Word file looks empty.');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export const isDocx = file => /\.docx$/i.test(file?.name || '') || file?.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// PowerPoint (.pptx) is also a zip of XML. Each slide's text, plus its speaker notes, becomes a block of text.
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
function drawingText(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return [...doc.getElementsByTagNameNS(A, 'p')].map(p => [...p.getElementsByTagNameNS(A, 't')].map(t => t.textContent).join('')).filter(t => t.trim()).join('\n');
}
export async function pptxToText(file) {
  const parts = await unzip(await file.arrayBuffer(), n => /^ppt\/slides\/slide\d+\.xml$/.test(n) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
  const num = n => +(n.match(/(\d+)\.xml$/) || [0, 0])[1];
  const slides = Object.keys(parts).filter(n => /slides\/slide/.test(n)).sort((a, b) => num(a) - num(b));
  if (!slides.length) throw new Error('I couldn\'t find any slides in that file. If it\'s an older .ppt, save it as .pptx or PDF first.');
  const out = slides.map(n => {
    const body = drawingText(parts[n]), notes = parts[`ppt/notesSlides/notesSlide${num(n)}.xml`];
    const noteText = notes ? drawingText(notes).replace(/^\d+$/gm, '').trim() : '';
    return `Slide ${num(n)}:\n${body}${noteText ? `\nSpeaker notes: ${noteText}` : ''}`;
  });
  return out.join('\n\n').trim();
}
export const isPptx = file => /\.pptx$/i.test(file?.name || '') || file?.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
