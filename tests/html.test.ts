// Tests for the HTML layer.
//
// These matter more than most: Stello's displayer renders section HTML with `v-html` and no
// sanitisation, so anything this module lets through reaches recipients' browsers intact.

import test from 'node:test'
import assert from 'node:assert/strict'

import {markdown_to_stello_html, sanitize_stello_html, html_to_text, render_variable,
    safe_url, escape_html} from '../src/stello/html.js'

test('markdown: headings always become h2, matching Stello\'s only heading level', () => {
    assert.equal(markdown_to_stello_html('# Big'), '<h2>Big</h2>')
    assert.equal(markdown_to_stello_html('### Small'), '<h2>Small</h2>')
})

test('markdown: paragraphs, bold, italic and highlight', () => {
    assert.equal(
        markdown_to_stello_html('Hello **world** and *friends* and ==this==.'),
        '<p>Hello <strong>world</strong> and <em>friends</em> and <mark>this</mark>.</p>')
})

test('markdown: consecutive lines join into one paragraph, blank lines split them', () => {
    assert.equal(
        markdown_to_stello_html('one\ntwo\n\nthree'),
        '<p>one two</p><p>three</p>')
})

test('markdown: bullet and numbered lists wrap items in paragraphs like TipTap does', () => {
    assert.equal(
        markdown_to_stello_html('- first\n- second'),
        '<ul><li><p>first</p></li><li><p>second</p></li></ul>')
    assert.equal(
        markdown_to_stello_html('1. first\n2. second'),
        '<ol><li><p>first</p></li><li><p>second</p></li></ol>')
})

test('markdown: blockquote content is a paragraph, as TipTap requires', () => {
    assert.equal(
        markdown_to_stello_html('> a quote'),
        '<blockquote><p>a quote</p></blockquote>')
})

test('markdown: horizontal rule and small note', () => {
    assert.equal(markdown_to_stello_html('---'), '<hr>')
    assert.equal(
        markdown_to_stello_html('^ a footnote'),
        '<div class="small"><small>a footnote</small></div>')
})

test('markdown: links become anchors with a safe target', () => {
    assert.equal(
        markdown_to_stello_html('[give](https://example.org/give)'),
        '<p><a href="https://example.org/give" target="_blank" rel="noopener noreferrer">give</a></p>')
})

test('markdown: a bare domain link is upgraded to https', () => {
    const html = markdown_to_stello_html('[give](therockcitychurch.com/give)')
    assert.match(html, /href="https:\/\/therockcitychurch\.com\/give"/)
})

test('markdown: a javascript: link keeps its label but loses the link', () => {
    const html = markdown_to_stello_html('[click](javascript:alert(1))')
    assert.equal(html, '<p>click</p>')
    assert.ok(!html.includes('javascript'))
})

test('markdown: template variables become the mention spans Stello substitutes', () => {
    assert.equal(
        markdown_to_stello_html('Hi {{contact_hello}},'),
        `<p>Hi <span data-mention data-id="contact_hello">Contact&#39;s name</span>,</p>`)
})

test('markdown: an unknown variable is left as literal text rather than guessed at', () => {
    assert.equal(markdown_to_stello_html('{{nope}}'), '<p>{{nope}}</p>')
})

test('markdown: user text is escaped, so it cannot inject markup', () => {
    assert.equal(
        markdown_to_stello_html('5 < 6 & "quoted" <script>x</script>'),
        '<p>5 &lt; 6 &amp; &quot;quoted&quot; &lt;script&gt;x&lt;/script&gt;</p>')
})

test('sanitize: script elements are dropped along with their contents', () => {
    assert.equal(
        sanitize_stello_html('<p>before</p><script>alert(1)</script><p>after</p>'),
        '<p>before</p><p>after</p>')
})

test('sanitize: style elements are dropped along with their contents', () => {
    assert.equal(
        sanitize_stello_html('<style>body{display:none}</style><p>kept</p>'),
        '<p>kept</p>')
})

test('sanitize: event handlers and inline styles never survive', () => {
    const html = sanitize_stello_html(
        '<p onclick="steal()" style="position:fixed" class="x">text</p>')
    assert.equal(html, '<p>text</p>')
})

test('sanitize: an img is dropped — images belong in an image section, not inline HTML', () => {
    assert.equal(
        sanitize_stello_html('<p>a<img src=x onerror=alert(1)>b</p>'),
        '<p>ab</p>')
})

test('sanitize: unknown tags are dropped but their text is kept', () => {
    assert.equal(
        sanitize_stello_html('<article><p>kept</p><footer>also kept</footer></article>'),
        '<p>kept</p>also kept')
})

test('sanitize: headings above h2 are dropped rather than silently promoted', () => {
    // h1/h3 are not in the whitelist, so their text survives without a heading wrapper.
    assert.equal(sanitize_stello_html('<h1>Title</h1>'), 'Title')
    assert.equal(sanitize_stello_html('<h2>Title</h2>'), '<h2>Title</h2>')
})

test('sanitize: a dangerous href is removed but the link text stays', () => {
    assert.equal(
        sanitize_stello_html(`<a href="javascript:alert(1)">click</a>`),
        'click')
    assert.equal(
        sanitize_stello_html(`<a href="data:text/html,<script>">click</a>`),
        'click')
})

test('sanitize: a safe href is kept and hardened', () => {
    assert.equal(
        sanitize_stello_html('<a href="https://example.org">go</a>'),
        '<a href="https://example.org" target="_blank" rel="noopener noreferrer">go</a>')
})

test('sanitize: mailto links are allowed', () => {
    assert.match(
        sanitize_stello_html('<a href="mailto:pastor@example.org">email</a>'),
        /href="mailto:pastor@example\.org"/)
})

test('sanitize: only mention spans naming a known variable survive', () => {
    assert.equal(
        sanitize_stello_html('<span data-mention data-id="contact_hello">Name</span>'),
        '<span data-mention data-id="contact_hello">Name</span>')
    // A mention naming an unknown key would never be substituted, so it is dropped.
    assert.equal(
        sanitize_stello_html('<span data-mention data-id="evil">Name</span>'),
        'Name')
    assert.equal(sanitize_stello_html('<span class="tracking">Name</span>'), 'Name')
})

test('sanitize: only the note div survives; other divs are unwrapped', () => {
    assert.equal(
        sanitize_stello_html('<div class="small"><small>note</small></div>'),
        '<div class="small"><small>note</small></div>')
    assert.equal(sanitize_stello_html('<div class="wrapper">text</div>'), 'text')
})

test('sanitize: unbalanced markup is closed rather than left open', () => {
    assert.equal(sanitize_stello_html('<p>one<p>two'), '<p>one</p><p>two</p>')
    assert.equal(sanitize_stello_html('<strong>bold'), '<strong>bold</strong>')
})

test('sanitize: a stray closing tag is ignored', () => {
    assert.equal(sanitize_stello_html('</p>text'), 'text')
})

test('sanitize: output is idempotent — re-cleaning changes nothing', () => {
    const inputs = [
        '<p>Hello <strong>world</strong></p>',
        '<ul><li><p>one</p></li></ul>',
        '<a href="https://example.org">go</a>',
        '<div class="small"><small>note</small></div>',
        '<span data-mention data-id="contact_name">X</span>',
    ]
    for (const input of inputs) {
        const once = sanitize_stello_html(input)
        assert.equal(sanitize_stello_html(once), once, `not idempotent: ${input}`)
    }
})

test('sanitize: everything markdown produces passes back through unchanged', () => {
    const markdown = [
        '## Heading',
        '',
        'Text with **bold**, *italic*, ==mark== and a [link](https://example.org).',
        '',
        '- bullet one',
        '- bullet two',
        '',
        '1. first',
        '',
        '> quoted',
        '',
        '---',
        '',
        '^ small note',
        '',
        'Hi {{contact_hello}}',
    ].join('\n')
    const html = markdown_to_stello_html(markdown)
    assert.equal(sanitize_stello_html(html), html)
})

test('safe_url accepts http, https and mailto, and rejects the rest', () => {
    assert.equal(safe_url('https://a.org'), 'https://a.org')
    assert.equal(safe_url('http://a.org'), 'http://a.org')
    assert.equal(safe_url('mailto:a@b.org'), 'mailto:a@b.org')
    assert.equal(safe_url('//a.org'), 'https://a.org')
    assert.equal(safe_url('a.org/x'), 'https://a.org/x')
    assert.equal(safe_url('javascript:alert(1)'), null)
    assert.equal(safe_url('data:text/html,x'), null)
    assert.equal(safe_url('vbscript:x'), null)
    assert.equal(safe_url('file:///etc/passwd'), null)
})

test('safe_url rejects a scheme hidden behind control characters', () => {
    assert.equal(safe_url('java\tscript:alert(1)'), null)
    assert.equal(safe_url('java\nscript:alert(1)'), null)
    assert.equal(safe_url(' javascript:alert(1)'), null)
})

test('escape_html covers every character that could break out of markup', () => {
    assert.equal(escape_html(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;')
})

test('render_variable refuses an unknown key', () => {
    assert.throws(() => render_variable('not_a_variable'), /Unknown template variable/)
})

test('html_to_text turns blocks into line breaks and drops tags', () => {
    assert.equal(
        html_to_text('<h2>Title</h2><p>One</p><p>Two</p>'),
        'Title\nOne\nTwo')
})

test('html_to_text decodes the entities we emit', () => {
    assert.equal(html_to_text('<p>5 &lt; 6 &amp; 7</p>'), '5 < 6 & 7')
})

// Regressions

test('markdown: a URL containing parentheses is matched in full', () => {
    const html = markdown_to_stello_html('[wiki](https://en.wikipedia.org/wiki/Grace_(theology))')
    assert.equal(html,
        '<p><a href="https://en.wikipedia.org/wiki/Grace_(theology)" target="_blank"'
        + ' rel="noopener noreferrer">wiki</a></p>')
    // No stray bracket left behind by a regex that stopped at the first ")".
    assert.ok(!html.includes(')</p>'))
})

test('sanitize: an anchor stripped of its href is removed, not left as empty markup', () => {
    assert.equal(sanitize_stello_html('<a>bare</a>'), 'bare')
    assert.equal(sanitize_stello_html('<a name="anchor">named</a>'), 'named')
})

test('sanitize: a new block auto-closes an open paragraph, as a browser would', () => {
    assert.equal(sanitize_stello_html('<p>one<p>two'), '<p>one</p><p>two</p>')
    assert.equal(sanitize_stello_html('<p>text<h2>heading</h2>'),
        '<p>text</p><h2>heading</h2>')
    assert.equal(sanitize_stello_html('<p>text<hr>'), '<p>text</p><hr>')
})

test('sanitize: auto-closing a paragraph also closes marks left open inside it', () => {
    assert.equal(sanitize_stello_html('<p>one<strong>bold<p>two'),
        '<p>one<strong>bold</strong></p><p>two</p>')
})

test('sanitize: a new list item closes the previous one', () => {
    assert.equal(sanitize_stello_html('<ul><li>one<li>two</ul>'),
        '<ul><li>one</li><li>two</li></ul>')
})

test('sanitize: nested lists still nest, since a list does not close a list item', () => {
    assert.equal(
        sanitize_stello_html('<ul><li>outer<ul><li>inner</li></ul></li></ul>'),
        '<ul><li>outer<ul><li>inner</li></ul></li></ul>')
})
