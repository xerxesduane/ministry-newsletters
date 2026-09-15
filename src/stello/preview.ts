// Render a newsletter to a standalone HTML page.
//
// Two uses, both important: the user sees what partners will see BEFORE anything is sent, and the
// same renderer produces the body for the direct-email path. The styling is a deliberately plain,
// email-client-safe approximation of Stello's theme rather than a copy of its displayer CSS.

import {escape_html, html_to_text} from './html.js'
import type {Newsletter, Section} from '../types.js'

/** Render one section to HTML. */
function section_html(section: Section): string {
    if (section.kind === 'text') {
        const standout = section.standout
            ? ` class="standout standout-${escape_html(section.standout)}"`
            : ''
        return `<section${standout}>${section.html}</section>`
    }

    if (section.kind === 'images') {
        const images = section.images.map(image => {
            const caption = image.caption
                ? `<div class="cap">${escape_html(image.caption)}</div>`
                : ''
            // Referenced by file path so a local preview shows the real image.
            const src = image.blobstore_name
                ? escape_html(image.source_path)
                : escape_html(image.source_path)
            return `<figure><img src="${src}" alt="${escape_html(image.caption)}">${caption}</figure>`
        }).join('')
        return `<section class="images${section.hero ? ' hero' : ''}">${images}</section>`
    }

    if (section.kind === 'video') {
        const url = section.format === 'iframe_youtube'
            ? `https://www.youtube.com/watch?v=${encodeURIComponent(section.video_id)}`
            : `https://vimeo.com/${encodeURIComponent(section.video_id)}`
        const thumb = section.format === 'iframe_youtube'
            ? `<img src="https://img.youtube.com/vi/${encodeURIComponent(section.video_id)}/hqdefault.jpg" alt="">`
            : ''
        const caption = section.caption
            ? `<div class="cap">${escape_html(section.caption)}</div>`
            : ''
        return `<section class="video"><a href="${escape_html(url)}">${thumb || escape_html(url)}</a>${caption}</section>`
    }

    // Chart: rendered as a labelled bar list, which reads correctly in every email client.
    const values = section.data.map(item => {
        const numeric = Number(item.number.replace(/[^0-9.-]/g, '')) || 0
        return {...item, numeric}
    })
    const max = Math.max(...values.map(v => Math.abs(v.numeric)), 1)
    const rows = values.map(item => {
        const width = Math.round((Math.abs(item.numeric) / max) * 100)
        return `<div class="bar-row">
            <div class="bar-label">${escape_html(item.label)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${width}%;background:hsl(${item.hue},60%,50%)"></div></div>
            <div class="bar-value">${escape_html(item.number)}</div>
        </div>`
    }).join('')
    const threshold = section.threshold
        ? `<div class="cap">Goal: ${escape_html(section.threshold)}</div>`
        : ''
    const caption = section.caption ? `<div class="cap">${escape_html(section.caption)}</div>` : ''
    return `<section class="chart">
        <h2>${escape_html(section.title)}</h2>
        ${rows}${threshold}${caption}
    </section>`
}

const STYLES = `
    body {margin:0; padding:0; background:#f4f4f5; color:#18181b;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
        line-height:1.6;}
    .wrap {max-width:640px; margin:0 auto; padding:24px 16px;}
    .card {background:#ffffff; border-radius:12px; padding:24px;}
    h1 {font-size:24px; margin:0 0 4px; text-align:center;}
    h2 {font-size:19px; margin:24px 0 8px;}
    p {margin:0 0 14px;}
    a {color:#2563eb;}
    ul, ol {margin:0 0 14px; padding-left:22px;}
    li p {margin:0 0 6px;}
    blockquote {margin:0 0 14px; padding:8px 0 8px 16px; border-left:3px solid #d4d4d8; color:#52525b;}
    hr {border:0; border-top:1px solid #e4e4e7; margin:24px 0;}
    mark {background:#fef08a; padding:0 2px;}
    img {max-width:100%; height:auto; border-radius:8px; display:block;}
    figure {margin:0 0 14px;}
    .cap {font-size:13px; color:#71717a; margin-top:6px;}
    .small, small {font-size:13px; color:#71717a;}
    section {margin-bottom:8px;}
    .standout {padding:14px 16px; border-radius:8px; margin:16px 0;}
    .standout-distinct {background:#f4f4f5;}
    .standout-notice {background:#eff6ff; border:1px solid #bfdbfe;}
    .standout-important {background:#fef2f2; border:1px solid #fecaca;}
    .hero img {border-radius:0;}
    .meta {text-align:center; color:#71717a; font-size:13px; margin-bottom:20px;}
    .bar-row {display:flex; align-items:center; gap:10px; margin-bottom:8px; font-size:14px;}
    .bar-label {flex:0 0 34%;}
    .bar-track {flex:1; background:#e4e4e7; border-radius:4px; height:14px; overflow:hidden;}
    .bar-fill {height:100%;}
    .bar-value {flex:0 0 auto; color:#52525b; font-variant-numeric:tabular-nums;}
    .footer {text-align:center; color:#a1a1aa; font-size:12px; margin-top:20px;}
`

export interface PreviewOptions {
    /** Substitute template variables with this recipient's details. */
    recipient?: {name: string, name_hello: string} | undefined
    sender_name?: string | undefined
    /** Appended below the content, e.g. an unsubscribe line for the direct-email path. */
    footer_html?: string | undefined
}

/**
 * Replace `[data-mention]` spans with real values, the way Stello does at send time.
 *
 * Stello parses the DOM for this; we match the exact span shape our own builder emits, and fall
 * back to leaving unknown mentions untouched rather than blanking them.
 */
export function fill_variables(html: string, values: Record<string, string>): string {
    return html.replace(
        /<span data-mention data-id="([^"]+)">.*?<\/span>/g,
        (whole, key: string) => key in values ? escape_html(values[key]!) : whole)
}

/** Render the newsletter body (no page chrome) — used as the email body. */
export function render_body(newsletter: Newsletter, options: PreviewOptions = {}): string {
    const published = new Date()
    const values: Record<string, string> = {
        contact_hello: options.recipient?.name_hello ?? 'Friend',
        contact_name: options.recipient?.name ?? 'Friend',
        sender_name: options.sender_name || newsletter.options.sender_name || '',
        msg_title: newsletter.title,
        msg_published_date: published.toLocaleDateString(),
        msg_published_time: published.toLocaleTimeString('en', {timeStyle: 'short'}),
        msg_max_reads: '[unlimited]',
        msg_lifespan: '[no expiry]',
        msg_expires_date: '[no expiry]',
    }
    const body = newsletter.sections.map(section_html).join('\n')
    return fill_variables(body, values)
}

/** Render a full standalone HTML page. */
export function render_page(newsletter: Newsletter, options: PreviewOptions = {}): string {
    const body = render_body(newsletter, options)
    const sender = options.sender_name || newsletter.options.sender_name
    const meta = sender ? `<div class="meta">from ${escape_html(sender)}</div>` : ''
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape_html(newsletter.title || 'Newsletter')}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
    <div class="card">
        <h1>${escape_html(newsletter.title || 'Untitled')}</h1>
        ${meta}
        ${body}
    </div>
    ${options.footer_html ?? ''}
</div>
</body>
</html>`
}

/** Plain-text alternative, so direct emails are not HTML-only. */
export function render_text(newsletter: Newsletter, options: PreviewOptions = {}): string {
    const parts = [newsletter.title, '']
    for (const section of newsletter.sections) {
        if (section.kind === 'text') {
            parts.push(html_to_text(fill_variables(section.html, {
                contact_hello: options.recipient?.name_hello ?? 'Friend',
                contact_name: options.recipient?.name ?? 'Friend',
                sender_name: options.sender_name || newsletter.options.sender_name || '',
                msg_title: newsletter.title,
            })))
        } else if (section.kind === 'video') {
            const url = section.format === 'iframe_youtube'
                ? `https://www.youtube.com/watch?v=${section.video_id}`
                : `https://vimeo.com/${section.video_id}`
            parts.push(`${section.caption || 'Video'}: ${url}`)
        } else if (section.kind === 'chart') {
            parts.push(section.title)
            parts.push(...section.data.map(item => `  ${item.label}: ${item.number}`))
            if (section.caption) {
                parts.push(section.caption)
            }
        } else if (section.kind === 'images') {
            parts.push(...section.images
                .filter(image => image.caption)
                .map(image => `[image: ${image.caption}]`))
        }
        parts.push('')
    }
    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
