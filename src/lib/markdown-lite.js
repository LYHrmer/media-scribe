// Minimal, safe-by-construction Markdown renderer for the markdown tool
// page. All user text is HTML-escaped FIRST; the renderer only ever injects
// its own tags, so the resulting string can be assigned to innerHTML without
// an XSS surface. Link/image URLs are scheme-allowlisted. This is "lite" by
// design: no nested lists, tables, or setext headings.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ESCAPES[c]);
}

function safeUrl(url) {
  return /^(https?:|mailto:)/i.test(url) ? url : '#';
}

// A link URL is non-space chars plus one level of balanced parens, so
// `javascript:alert(1)` or `wiki/Foo_(bar)` don't eat the closing paren.
const URL_PART = '((?:[^()\\s]|\\([^()\\s]*\\))+)';

// Runs on ALREADY-escaped text: every character the user typed is inert.
function renderInline(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(new RegExp(`!\\[([^\\]]*)\\]\\(${URL_PART}\\)`, 'g'), (_, alt, url) => `<img src="${safeUrl(url)}" alt="${alt}">`)
    .replace(new RegExp(`\\[([^\\]]+)\\]\\(${URL_PART}\\)`, 'g'), (_, label, url) => `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

const UL_ITEM = /^\s*[-*+]\s+(.*)$/;
const OL_ITEM = /^\s*\d+[.)]\s+(.*)$/;
const HR = /^\s*(?:([-*_])\s*\1\s*\1[\s\1]*|---+\s*)$/;

export function renderMarkdown(source) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      html.push(`<p>${renderInline(escapeHtml(paragraph.join('\n'))).replace(/\n/g, '<br>')}</p>`);
      paragraph = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flushParagraph();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence, or EOF for an unterminated block
      html.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
      i += 1;
      continue;
    }
    if (HR.test(line)) {
      flushParagraph();
      html.push('<hr>');
      i += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushParagraph();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      html.push(`<blockquote>${renderInline(escapeHtml(buf.join('\n'))).replace(/\n/g, '<br>')}</blockquote>`);
      continue;
    }
    if (UL_ITEM.test(line) || OL_ITEM.test(line)) {
      flushParagraph();
      const ordered = !UL_ITEM.test(line);
      const itemRe = ordered ? OL_ITEM : UL_ITEM;
      const items = [];
      while (i < lines.length && itemRe.test(lines[i])) {
        items.push(itemRe.exec(lines[i])[1]);
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.map(item => `<li>${renderInline(escapeHtml(item))}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      i += 1;
      continue;
    }
    paragraph.push(line);
    i += 1;
  }
  flushParagraph();
  return html.join('\n');
}
