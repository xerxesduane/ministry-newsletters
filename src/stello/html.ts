// Build and sanitise the HTML that goes inside a Stello text section.
//
// WHY THIS IS STRICT: Stello's displayer renders section HTML with `v-html` and performs no
// sanitisation of its own (displayer/src/components/MessageSection.vue). Whatever we put in a
// text section is injected into the recipient's page verbatim. So this module never passes
// caller-supplied HTML through — it either builds HTML from Markdown, or rebuilds it from a
// whitelist, dropping everything it does not explicitly understand.
//
// The whitelist matches Stello's TipTap editor schema (app/src/components/global/AppHtml.vue),
// so anything we produce also round-trips cleanly if the user later edits it in Stello.

/** Inline marks TipTap allows inside a text section. */
const INLINE_TAGS = new Set(['strong', 'em', 'mark', 'a', 'br', 'span', 'small'])

/** Block nodes TipTap allows. Only h2 — Stello sets `Heading.configure({levels:[2]})`. */
const BLOCK_TAGS = new Set(['p', 'h2', 'ul', 'ol', 'li', 'blockquote', 'hr', 'div'])

const ALLOWED_TAGS = new Set([...INLINE_TAGS, ...BLOCK_TAGS])

/** Tags that never have a closing tag. */
const VOID_TAGS = new Set(['br', 'hr'])

/**
 * Block tags that cannot sit inside a paragraph.
 *
 * A real HTML parser closes an open `<p>` when one of these starts. Ours has to as well, or
 * `<p>one<p>two` nests instead of splitting and the output stops matching TipTap's schema.
 */
const CLOSES_PARAGRAPH = new Set(['p', 'h2', 'ul', 'ol', 'blockquote', 'hr', 'div'])

/** Template variables Stello substitutes per recipient at send time. */
export const TEMPLATE_VARIABLES: Record<string, string> = {
    contact_hello: "Contact's name",
    contact_name: "Contact's full name",
    sender_name: "Sender's name",
    msg_title: 'Subject',
    msg_published_date: 'Date sent',
    msg_published_time: 'Time sent',
    msg_max_reads: 'Max opens',
    msg_lifespan: 'Time till expires',
    msg_expires_date: 'Date expires',
}

/** Characters that are only ever used to smuggle a scheme past a URL check. */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

/** Escape text for safe inclusion in HTML. */
export function escape_html(text: string): string {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
}

/** Decode the handful of entities we emit, so URLs can be re-validated after decoding. */
function decode_entities(text: string): string {
    return text
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .replaceAll('&amp;', '&')
}

/**
 * Render a template variable as the mention span Stello looks for.
 *
 * Stello's `update_template_values()` finds `[data-mention]` nodes and replaces their text content
 * with the per-recipient value, so the placeholder text here is only what the sender sees.
 */
export function render_variable(key: string): string {
    const label = TEMPLATE_VARIABLES[key]
    if (!label) {
        throw new Error(`Unknown template variable "${key}". `
            + `Available: ${Object.keys(TEMPLATE_VARIABLES).join(', ')}`)
    }
    return `<span data-mention data-id="${escape_html(key)}">${escape_html(label)}</span>`
}

/** Allow only URL schemes that are safe to hand to a mail client and a browser. */
export function safe_url(url: string): string | null {
    const trimmed = url.trim()
    if (CONTROL_CHARS.test(trimmed)) {
        return null
    }
    if (/^(https?:|mailto:)/i.test(trimmed)) {
        return trimmed
    }
    // Protocol-relative URLs are treated as https.
    if (trimmed.startsWith('//')) {
        return 'https:' + trimmed
    }
    // A bare domain such as "therockcitychurch.com/give" is treated as https.
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed)) {
        return 'https://' + trimmed
    }
    return null
}

/** Attributes kept per tag. Everything else is dropped, including event handlers and styles. */
function clean_attributes(tag: string, raw: string): string {
    if (tag === 'a') {
        const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(raw)
        const value = href?.[2] ?? href?.[3] ?? href?.[4]
        const url = value ? safe_url(decode_entities(value)) : null
        if (!url) {
            return ''
        }
        // Stello's own invites open links in a new tab; noopener protects the opener reference.
        return ` href="${escape_html(url)}" target="_blank" rel="noopener noreferrer"`
    }
    if (tag === 'span') {
        // Only mention spans survive, and a mention must name a variable Stello knows.
        if (!/\bdata-mention\b/i.test(raw)) {
            return ''
        }
        const id = /\bdata-id\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(raw)
        const key = id?.[2] ?? id?.[3] ?? id?.[4]
        if (!key || !(key in TEMPLATE_VARIABLES)) {
            return ''
        }
        return ` data-mention data-id="${escape_html(key)}"`
    }
    if (tag === 'div') {
        // The only div Stello's schema produces is the "note" wrapper.
        return /\bclass\s*=\s*("[^"]*\bsmall\b[^"]*"|'[^']*\bsmall\b[^']*')/i.test(raw)
            ? ' class="small"'
            : ''
    }
    return ''
}

/**
 * Rebuild HTML from a strict whitelist.
 *
 * Unknown tags are dropped but their text content is kept, so pasting a full web page yields its
 * prose rather than nothing. Script and style elements are dropped along with their contents,
 * since their text is code rather than prose.
 */
export function sanitize_stello_html(html: string): string {
    let out = ''
    const open_stack: string[] = []
    // Matches a comment, a tag, or a run of text.
    const token_re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|([^<]+)/g

    let skip_until: string | null = null
    let match: RegExpExecArray | null

    /** Close open tags down to and including the innermost `tag`. No-op when it is not open. */
    const close_through = (tag: string): void => {
        const index = open_stack.lastIndexOf(tag)
        if (index === -1) {
            return
        }
        while (open_stack.length > index) {
            out += `</${open_stack.pop()!}>`
        }
    }

    /** Apply the implicit closes a browser would apply before opening `tag`. */
    const auto_close_before = (tag: string): void => {
        if (CLOSES_PARAGRAPH.has(tag)) {
            close_through('p')
        }
        if (tag === 'li') {
            // A new item closes the previous one, but only within the same list. Walking the
            // stack outwards, a `ul`/`ol` reached before any `li` means this is the first item of
            // a nested list, whose parent `li` must stay open to contain it.
            for (let i = open_stack.length - 1; i >= 0; i--) {
                const open = open_stack[i]!
                if (open === 'ul' || open === 'ol') {
                    break
                }
                if (open === 'li') {
                    close_through('li')
                    break
                }
            }
        }
    }

    while ((match = token_re.exec(html)) !== null) {
        const [whole, raw_tag, attrs, text] = match

        // Inside script/style, discard everything until the matching close tag.
        if (skip_until) {
            if (raw_tag && raw_tag.toLowerCase() === skip_until && whole.startsWith('</')) {
                skip_until = null
            }
            continue
        }

        if (text !== undefined) {
            out += escape_html(decode_entities(text))
            continue
        }
        if (!raw_tag) {
            continue  // An HTML comment — drop it.
        }

        const tag = raw_tag.toLowerCase()
        if (tag === 'script' || tag === 'style') {
            if (!whole.startsWith('</')) {
                skip_until = tag
            }
            continue
        }

        const is_close = whole.startsWith('</')

        if (!ALLOWED_TAGS.has(tag)) {
            continue  // Drop the tag, keep whatever text it wrapped.
        }

        if (VOID_TAGS.has(tag)) {
            if (!is_close) {
                auto_close_before(tag)
                out += `<${tag}>`
            }
            continue
        }

        if (is_close) {
            // Only close a tag we actually opened, so output stays balanced. Anything still open
            // inside it is closed first.
            close_through(tag)
            continue
        }

        const cleaned = clean_attributes(tag, attrs ?? '')
        // A tag that lost the attribute giving it meaning is dropped rather than emitted bare:
        // an anchor with no href is dead markup, and an unrecognised span or div is just a wrapper.
        if ((tag === 'a' || tag === 'span' || tag === 'div') && !cleaned) {
            continue
        }
        auto_close_before(tag)
        out += `<${tag}${cleaned}>`
        open_stack.push(tag)
    }

    // Close anything still open.
    while (open_stack.length) {
        out += `</${open_stack.pop()!}>`
    }

    return out.trim()
}

/** Escape text and apply the character-level marks TipTap supports. */
function escape_inline(text: string): string {
    let out = escape_html(text)
    // Template variables: {{contact_hello}}
    out = out.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) =>
        key in TEMPLATE_VARIABLES ? render_variable(key) : whole)
    // Bold before italic, so `**` is not eaten by the single-`*` rule.
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    out = out.replace(/==([^=]+)==/g, '<mark>$1</mark>')
    return out
}

/** Convert inline Markdown (and `{{variable}}` placeholders) to Stello's inline HTML. */
function inline_markdown(text: string): string {
    const parts: string[] = []
    // The URL may contain one level of balanced parentheses, as CommonMark allows — real links do
    // (a Wikipedia article ending in "_(disambiguation)"), and so does `javascript:alert(1)`,
    // which must be matched in full so safe_url gets the chance to reject it.
    const link_re = /\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g
    let last = 0
    let m: RegExpExecArray | null

    while ((m = link_re.exec(text)) !== null) {
        parts.push(escape_inline(text.slice(last, m.index)))
        const url = safe_url(m[2]!)
        const label = escape_inline(m[1]!)
        parts.push(url
            ? `<a href="${escape_html(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
            : label)
        last = m.index + m[0].length
    }
    parts.push(escape_inline(text.slice(last)))

    return parts.join('')
}

/**
 * Convert a Markdown subset to the exact HTML shape Stello's editor produces.
 *
 * Supported: `## heading`, paragraphs, `- `/`* ` bullets, `1. ` numbers, `> ` quotes, `---` rules,
 * `**bold**`, `*italic*`, `==highlight==`, `[label](url)`, `{{variable}}`, and `^ ` for a small
 * note line. Headings of any level collapse to h2, matching Stello's own NormalizeHeadings.
 */
export function markdown_to_stello_html(markdown: string): string {
    const lines = markdown.replaceAll('\r\n', '\n').split('\n')
    const out: string[] = []
    let list: 'ul' | 'ol' | null = null
    let quote: string[] = []
    let para: string[] = []

    const close_list = () => {
        if (list) {
            out.push(`</${list}>`)
            list = null
        }
    }
    const flush_para = () => {
        if (para.length) {
            out.push(`<p>${inline_markdown(para.join(' '))}</p>`)
            para = []
        }
    }
    const flush_quote = () => {
        if (quote.length) {
            // TipTap restricts blockquote content to paragraphs.
            out.push(`<blockquote><p>${inline_markdown(quote.join(' '))}</p></blockquote>`)
            quote = []
        }
    }
    const flush_all = () => {
        flush_para()
        flush_quote()
        close_list()
    }

    for (const raw of lines) {
        const line = raw.trim()

        if (!line) {
            flush_all()
            continue
        }

        // Horizontal rule
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
            flush_all()
            out.push('<hr>')
            continue
        }

        // Heading (any level collapses to h2, as Stello only keeps level 2)
        const heading = /^#{1,6}\s+(.*)$/.exec(line)
        if (heading) {
            flush_all()
            out.push(`<h2>${inline_markdown(heading[1]!)}</h2>`)
            continue
        }

        // Small note line
        if (line.startsWith('^ ')) {
            flush_all()
            out.push(`<div class="small"><small>${inline_markdown(line.slice(2))}</small></div>`)
            continue
        }

        // Blockquote
        if (line.startsWith('> ')) {
            flush_para()
            close_list()
            quote.push(line.slice(2))
            continue
        }

        // Bullet list
        const bullet = /^[-*]\s+(.*)$/.exec(line)
        if (bullet) {
            flush_para()
            flush_quote()
            if (list !== 'ul') {
                close_list()
                out.push('<ul>')
                list = 'ul'
            }
            out.push(`<li><p>${inline_markdown(bullet[1]!)}</p></li>`)
            continue
        }

        // Ordered list
        const numbered = /^\d+[.)]\s+(.*)$/.exec(line)
        if (numbered) {
            flush_para()
            flush_quote()
            if (list !== 'ol') {
                close_list()
                out.push('<ol>')
                list = 'ol'
            }
            out.push(`<li><p>${inline_markdown(numbered[1]!)}</p></li>`)
            continue
        }

        // Plain paragraph text (consecutive lines join into one paragraph)
        flush_quote()
        close_list()
        para.push(line)
    }

    flush_all()
    return out.join('')
}

/** Strip tags for a plain-text rendering, used in previews and plain-text email bodies. */
export function html_to_text(html: string): string {
    return decode_entities(
        html
            .replace(/<\/(p|h2|li|blockquote|div)>/gi, '\n')
            .replace(/<(br|hr)\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, ''))
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}
