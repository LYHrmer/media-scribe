import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, escapeHtml } from '../src/lib/markdown-lite.js';

test('headings render at the right level with inline markup', () => {
  assert.equal(renderMarkdown('# 标题'), '<h1>标题</h1>');
  assert.equal(renderMarkdown('### **加粗**'), '<h3><strong>加粗</strong></h3>');
  assert.equal(renderMarkdown('####### 不是标题'), '<p>####### 不是标题</p>');
});

test('bold, italic and inline code', () => {
  assert.equal(renderMarkdown('**b** *i* `c`'), '<p><strong>b</strong> <em>i</em> <code>c</code></p>');
});

test('user HTML is escaped everywhere, including code spans', () => {
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(renderMarkdown('`<img onerror=x>`'), '<p><code>&lt;img onerror=x&gt;</code></p>');
});

test('links are scheme-allowlisted, images too', () => {
  assert.equal(
    renderMarkdown('[ok](https://a.b/c) [bad](javascript:alert(1))'),
    '<p><a href="https://a.b/c" target="_blank" rel="noopener noreferrer">ok</a> <a href="#" target="_blank" rel="noopener noreferrer">bad</a></p>',
  );
  assert.equal(renderMarkdown('![猫](https://x/y.png)'), '<p><img src="https://x/y.png" alt="猫"></p>');
  assert.equal(renderMarkdown('![x](data:text/html;base64,PHN2Zz4=)'), '<p><img src="#" alt="x"></p>');
  // parens inside the URL must not eat the closing paren; trailing punctuation stays outside
  assert.equal(
    renderMarkdown('[a](https://wiki/Foo_(bar)), next'),
    '<p><a href="https://wiki/Foo_(bar)" target="_blank" rel="noopener noreferrer">a</a>, next</p>',
  );
});

test('code fences take raw text with no inline processing', () => {
  assert.equal(renderMarkdown('```\n**x** <b>\n```'), '<pre><code>**x** &lt;b&gt;</code></pre>');
  // unterminated fence still renders to EOF
  assert.equal(renderMarkdown('```\ncode'), '<pre><code>code</code></pre>');
});

test('lists group consecutive items, ul and ol', () => {
  assert.equal(renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(renderMarkdown('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
});

test('blockquote joins lines with <br>', () => {
  assert.equal(renderMarkdown('> a\n> b'), '<blockquote>a<br>b</blockquote>');
});

test('horizontal rule variants', () => {
  assert.equal(renderMarkdown('---'), '<hr>');
  assert.equal(renderMarkdown('* * *'), '<hr>');
});

test('paragraphs split on blank lines, soft breaks become <br>', () => {
  assert.equal(renderMarkdown('a\nb'), '<p>a<br>b</p>');
  assert.equal(renderMarkdown('a\n\nb'), '<p>a</p>\n<p>b</p>');
});

test('empty input renders empty', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(escapeHtml('a&b'), 'a&amp;b');
});
