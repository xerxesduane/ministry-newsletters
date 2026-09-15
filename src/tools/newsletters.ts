// Tools for writing a newsletter: create it, build up its sections, review it.

import {writeFileSync} from 'node:fs'
import {z} from 'zod'
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'

import {generate_token} from '../stello/ids.js'
import {markdown_to_stello_html, sanitize_stello_html, html_to_text, TEMPLATE_VARIABLES}
    from '../stello/html.js'
import {render_page, render_text} from '../stello/preview.js'
import {add_image} from '../stello/blobstore.js'
import {text, data, fail, guard_sync} from './helpers.js'
import type {Store} from '../store.js'
import type {Newsletter, Section} from '../types.js'

/** Youtube/Vimeo accept a bare id or a full URL; pull the id out either way. */
function parse_video(url_or_id: string): {format: 'iframe_youtube' | 'iframe_vimeo', id: string} {
    const trimmed = url_or_id.trim()
    const youtube = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/
        .exec(trimmed)
    if (youtube) {
        return {format: 'iframe_youtube', id: youtube[1]!}
    }
    const vimeo = /vimeo\.com\/(?:video\/)?(\d+)/.exec(trimmed)
    if (vimeo) {
        return {format: 'iframe_vimeo', id: vimeo[1]!}
    }
    // A bare numeric id is Vimeo; anything else is treated as a YouTube id.
    if (/^\d+$/.test(trimmed)) {
        return {format: 'iframe_vimeo', id: trimmed}
    }
    if (/^[\w-]{6,}$/.test(trimmed)) {
        return {format: 'iframe_youtube', id: trimmed}
    }
    throw new Error(`Could not read a YouTube or Vimeo video from "${url_or_id}".`)
}

/** One-line summary of a section, for listings. */
function describe(section: Section): string {
    if (section.kind === 'text') {
        const preview = html_to_text(section.html).replace(/\s+/g, ' ').slice(0, 70)
        const flag = section.standout ? ` [${section.standout}]` : ''
        return `text${flag}: ${preview}${preview.length >= 70 ? '…' : ''}`
    }
    if (section.kind === 'images') {
        const pending = section.images.filter(i => !i.blobstore_name).length
        return `images: ${section.images.length} image(s)`
            + (section.hero ? ', hero' : '')
            + (pending ? `, ${pending} not yet in Stello's folder` : '')
    }
    if (section.kind === 'video') {
        return `video: ${section.format === 'iframe_youtube' ? 'YouTube' : 'Vimeo'} `
            + `${section.video_id}${section.caption ? ` — ${section.caption}` : ''}`
    }
    return `chart (${section.chart}): ${section.title} — ${section.data.length} value(s)`
}

/** Full readable rendering of a newsletter, used by several tools. */
export function summarise(store: Store, newsletter: Newsletter): string {
    const audience = store.resolve_audience(newsletter)
    const lines = [
        `# ${newsletter.title || '(untitled)'}`,
        `id: ${newsletter.id}   status: ${newsletter.status}   modified: ${newsletter.modified}`,
        '',
        'Sections:',
        newsletter.sections.length
            ? newsletter.sections.map((s, i) => `  ${i + 1}. [${s.id}] ${describe(s)}`).join('\n')
            : '  (none yet)',
        '',
        `Audience: ${audience.length} partner(s)`,
    ]
    if (audience.length) {
        const shown = audience.slice(0, 10)
            .map(p => `  - ${p.name} <${p.address}>`).join('\n')
        lines.push(shown)
        if (audience.length > 10) {
            lines.push(`  …and ${audience.length - 10} more`)
        }
    }
    if (newsletter.last_export) {
        lines.push('', `Last Stello handoff file: ${newsletter.last_export.path}`
            + ` (${newsletter.last_export.at})`)
    }
    if (newsletter.last_direct_send) {
        lines.push('', `Last direct email send: ${newsletter.last_direct_send.at}`
            + ` to ${newsletter.last_direct_send.recipients} recipient(s)`)
    }
    return lines.join('\n')
}

/** Look a newsletter up, or throw a message naming what is available. */
export function require_newsletter(store: Store, id: string): Newsletter {
    const newsletter = store.newsletter(id)
    if (newsletter) {
        return newsletter
    }
    const available = store.newsletters()
        .map(n => `${n.id} (${n.title || 'untitled'})`).join(', ')
    throw new Error(`No newsletter with id "${id}".`
        + (available ? ` Available: ${available}` : ' There are no newsletters yet.'))
}

const STANDOUT = z.enum(['distinct', 'notice', 'important'])

export function register_newsletter_tools(server: McpServer, store: Store): void {

    server.registerTool('newsletter_create', {
        title: 'Start a newsletter',
        description: 'Create a new ministry newsletter draft. Returns its id, which every other '
            + 'newsletter tool takes. Content is added afterwards with newsletter_add_text and '
            + 'the other section tools.',
        inputSchema: {
            title: z.string().min(1).describe('Subject line partners will see, e.g. '
                + '"October Ministry Update"'),
            sender_name: z.string().optional().describe('Name the newsletter comes from. Leave '
                + 'unset to inherit the sending account default configured in Stello.'),
        },
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false},
    }, guard_sync(({title, sender_name}) => {
        const now = new Date().toISOString()
        const newsletter: Newsletter = {
            id: generate_token(),
            title,
            status: 'draft',
            created: now,
            modified: now,
            sections: [],
            audience: {
                include_groups: [], include_partners: [],
                exclude_groups: [], exclude_partners: [],
            },
            options: {
                sender_name: sender_name ?? '',
                invite_button: '',
                lifespan_days: null,
                max_reads: null,
            },
            last_export: null,
            last_direct_send: null,
        }
        store.add_newsletter(newsletter)
        store.save()
        return data(`Created newsletter "${title}".\nid: ${newsletter.id}\n\n`
            + 'Next: add content with newsletter_add_text, then set who receives it with '
            + 'newsletter_set_audience.', {id: newsletter.id, title})
    }))

    server.registerTool('newsletter_list', {
        title: 'List newsletters',
        description: 'List every newsletter in this workspace with its status and audience size.',
        inputSchema: {},
        annotations: {readOnlyHint: true},
    }, guard_sync(() => {
        const all = store.newsletters()
        if (!all.length) {
            return text('No newsletters yet. Use newsletter_create to start one.')
        }
        const body = all.map(n => {
            const count = store.resolve_audience(n).length
            return `- ${n.id}  [${n.status}]  "${n.title || 'untitled'}"  `
                + `${n.sections.length} section(s), ${count} recipient(s)`
        }).join('\n')
        return data(body, {count: all.length})
    }))

    server.registerTool('newsletter_get', {
        title: 'Read a newsletter',
        description: 'Show a newsletter in full: its sections, its resolved audience, and where '
            + 'it has been exported or sent.',
        inputSchema: {id: z.string().describe('Newsletter id')},
        annotations: {readOnlyHint: true},
    }, guard_sync(({id}) => text(summarise(store, require_newsletter(store, id)))))

    server.registerTool('newsletter_add_text', {
        title: 'Add a text section',
        description: 'Append a block of writing to a newsletter. Write in Markdown: "## Heading", '
            + '**bold**, *italic*, ==highlight==, [links](url), "- " bullets, "1. " numbers, '
            + '"> " quotes, "---" for a divider, and "^ " for a small note line. Insert '
            + 'per-recipient values with {{contact_hello}} (their first name), {{sender_name}}, '
            + '{{msg_title}} — these are personalised for each partner at send time.',
        inputSchema: {
            id: z.string().describe('Newsletter id'),
            markdown: z.string().min(1).describe('Section content in Markdown'),
            standout: STANDOUT.optional().describe('Visually set this block apart: "distinct" for '
                + 'a subtle panel, "notice" for information, "important" for emphasis'),
            position: z.number().int().min(1).optional()
                .describe('1-based position to insert at. Appends to the end when omitted.'),
        },
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false},
    }, guard_sync(({id, markdown, standout, position}) => {
        const newsletter = require_newsletter(store, id)
        const section: Section = {
            kind: 'text',
            id: generate_token(),
            markdown,
            html: markdown_to_stello_html(markdown),
            standout: standout ?? null,
        }
        insert(newsletter, section, position)
        store.touch(newsletter)
        store.save()
        return data(`Added text section to "${newsletter.title}" `
            + `(now ${newsletter.sections.length} section(s)).\nsection id: ${section.id}`,
            {section_id: section.id, sections: newsletter.sections.length})
    }))

    server.registerTool('newsletter_add_html', {
        title: 'Add a text section from HTML',
        description: 'Append a text section from existing HTML — for content copied from a '
            + 'website or an old newsletter. The HTML is rebuilt against the tags Stello supports '
            + '(headings, bold, italic, links, lists, quotes, rules); anything else, including '
            + 'scripts, styles and inline event handlers, is stripped. Prefer newsletter_add_text '
            + 'when writing new content.',
        inputSchema: {
            id: z.string().describe('Newsletter id'),
            html: z.string().min(1).describe('Existing HTML to bring in'),
            standout: STANDOUT.optional(),
            position: z.number().int().min(1).optional(),
        },
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false},
    }, guard_sync(({id, html, standout, position}) => {
        const newsletter = require_newsletter(store, id)
        const clean = sanitize_stello_html(html)
        if (!clean) {
            return fail('Nothing usable was left after cleaning that HTML. Pass the text content '
                + 'to newsletter_add_text instead.')
        }
        const section: Section = {
            kind: 'text',
            id: generate_token(),
            markdown: '',
            html: clean,
            standout: standout ?? null,
        }
        insert(newsletter, section, position)
        store.touch(newsletter)
        store.save()
        const removed = html.length - clean.length
        return data(`Added text section from HTML (${removed > 0 ? `${removed} characters of `
            + 'unsupported markup removed' : 'no changes needed'}).\nsection id: ${section.id}`,
            {section_id: section.id})
    }))

    server.registerTool('newsletter_add_images', {
        title: 'Add an image section',
        description: 'Append photos to a newsletter. Each image file is copied into Stello\'s '
            + '"Internal Files" folder, which is where Stello reads image data from — so this '
            + 'requires Stello to be installed. Use stello_status to check first.',
        inputSchema: {
            id: z.string().describe('Newsletter id'),
            images: z.array(z.object({
                path: z.string().describe('Absolute path to a jpg, png, webp, gif or avif file'),
                caption: z.string().default('').describe('Caption shown under the image. Also '
                    + 'serves as the description for partners using a screen reader.'),
            })).min(1),
            hero: z.boolean().default(false)
                .describe('Show edge-to-edge as a banner, typical for the top of a newsletter'),
            crop: z.boolean().default(true)
                .describe('Crop images to a shared aspect ratio so they line up'),
            position: z.number().int().min(1).optional(),
        },
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false},
    }, guard_sync(({id, images, hero, crop, position}) => {
        const newsletter = require_newsletter(store, id)
        const added: Section = {
            kind: 'images',
            id: generate_token(),
            images: images.map(image => {
                const {filename} = add_image(image.path)
                return {
                    id: generate_token(),
                    source_path: image.path,
                    blobstore_name: filename,
                    caption: image.caption,
                }
            }),
            crop,
            hero,
        }
        insert(newsletter, added, position)
        store.touch(newsletter)
        store.save()
        return data(`Added ${images.length} image(s) to "${newsletter.title}".`
            + `\nsection id: ${added.id}`, {section_id: added.id})
    }))

    server.registerTool('newsletter_add_video', {
        title: 'Add a video section',
        description: 'Append a YouTube or Vimeo video. Accepts a full URL or a bare video id.',
        inputSchema: {
            id: z.string().describe('Newsletter id'),
            video: z.string().describe('YouTube or Vimeo URL, or the video id'),
            caption: z.string().default('').describe('Caption shown under the video'),
            start: z.number().int().min(0).optional().describe('Start the video at this second'),
            end: z.number().int().min(0).optional().describe('Stop the video at this second'),
            position: z.number().int().min(1).optional(),
        },
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false},
    }, guard_sync(({id, video, caption, start, end, position}) => {
        const newsletter = require_newsletter(store, id)
        const {format, id: video_id} = parse_video(video)
        const section: Section = {
            kind: 'video',
            id: generate_token(),
            format,
            video_id,
            caption,
            start: start ?? null,
            end: end ?? null,
        }
        insert(newsletter, section, position)
        store.touch(newsletter)
        store.save()
        return data(`Added ${format === 'iframe_youtube' ? 'YouTube' : 'Vimeo'} video `
            + `${video_id}.\nsection id: ${section.id}`, {section_id: section.id, video_id})
    }))

    server.registerTool('newsletter_add_chart', {
        title: 'Add a chart section',
        description: 'Append a chart — useful for giving totals, attendance, or progress toward a '
            + 'goal. Values are display strings ("$4,250", "38%", "120"), so they read exactly as '
            + 'written; Stello strips the formatting when sizing the bars.',
        inputSchema: {
            id: z.string().describe('Newsletter id'),
            title: z.string().describe('Chart heading, e.g. "Giving toward the building fund"'),
            chart: z.enum(['bar', 'line', 'doughnut']).default('bar'),
            values: z.array(z.object({
                label: z.string().describe('What this value is, e.g. "September"'),
                number: z.string().describe('Value as it should read, e.g. "$4,250"'),
                hue: z.number().min(0).max(360).optional()
                    .describe('Colour hue 0-360. Spread automatically when omitted.'),
            })).min(1),
            threshold: z.string().default('')
                .describe('A goal line, e.g. "$10,000". Empty for none.'),
            caption: z.string().default(''),
            position: z.number().int().min(1).optional(),
        },
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false},
    }, guard_sync(({id, title, chart, values, threshold, caption, position}) => {
        const newsletter = require_newsletter(store, id)
        const section: Section = {
            kind: 'chart',
            id: generate_token(),
            chart,
            data: values.map((value, index) => ({
                id: generate_token(),
                number: value.number,
                label: value.label,
                // Spread unspecified hues around the wheel so bars stay distinguishable.
                hue: value.hue ?? Math.round((index * 360) / Math.max(values.length, 1)),
            })),
            threshold,
            title,
            caption,
        }
        insert(newsletter, section, position)
        store.touch(newsletter)
        store.save()
        return data(`Added ${chart} chart "${title}" with ${values.length} value(s).`
            + `\nsection id: ${section.id}`, {section_id: section.id})
    }))

    server.registerTool('newsletter_edit_text', {
        title: 'Rewrite a text section',
        description: 'Replace the Markdown of an existing text section, keeping its position.',
        inputSchema: {
            id: z.string().describe('Newsletter id'),
            section_id: z.string().describe('Section id, from newsletter_get'),
            markdown: z.string().min(1).describe('Replacement content in Markdown'),
            standout: STANDOUT.nullable().optional()
                .describe('Change the standout style. Pass null to clear it.'),
        },
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true},
    }, guard_sync(({id, section_id, markdown, standout}) => {
        const newsletter = require_newsletter(store, id)
        const section = newsletter.sections.find(s => s.id === section_id)
        if (!section) {
            return fail(`No section "${section_id}" in this newsletter.`)
        }
        if (section.kind !== 'text') {
            return fail(`Section "${section_id}" is a ${section.kind} section, not text. `
                + 'Remove it and add a replacement instead.')
        }
        section.markdown = markdown
        section.html = markdown_to_stello_html(markdown)
        if (standout !== undefined) {
            section.standout = standout
        }
        store.touch(newsletter)
        store.save()
        return text(`Rewrote section ${section_id}.`)
    }))

    server.registerTool('newsletter_move_section', {
        title: 'Reorder a section',
        description: 'Move a section to a different position in the newsletter.',
        inputSchema: {
            id: z.string().describe('Newsletter id'),
            section_id: z.string(),
            position: z.number().int().min(1).describe('New 1-based position'),
        },
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true},
    }, guard_sync(({id, section_id, position}) => {
        const newsletter = require_newsletter(store, id)
        const from = newsletter.sections.findIndex(s => s.id === section_id)
        if (from === -1) {
            return fail(`No section "${section_id}" in this newsletter.`)
        }
        const [section] = newsletter.sections.splice(from, 1)
        const to = Math.min(position - 1, newsletter.sections.length)
        newsletter.sections.splice(to, 0, section!)
        store.touch(newsletter)
        store.save()
        return text(`Moved section to position ${to + 1} of ${newsletter.sections.length}.`)
    }))

    server.registerTool('newsletter_remove_section', {
        title: 'Remove a section',
        description: 'Delete a section from a newsletter.',
        inputSchema: {
            id: z.string().describe('Newsletter id'),
            section_id: z.string(),
        },
        annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true},
    }, guard_sync(({id, section_id}) => {
        const newsletter = require_newsletter(store, id)
        const index = newsletter.sections.findIndex(s => s.id === section_id)
        if (index === -1) {
            return fail(`No section "${section_id}" in this newsletter.`)
        }
        newsletter.sections.splice(index, 1)
        store.touch(newsletter)
        store.save()
        return text(`Removed section. ${newsletter.sections.length} left.`)
    }))

    server.registerTool('newsletter_set_options', {
        title: 'Set newsletter options',
        description: 'Change the sender name, the invitation button wording, and how long the '
            + 'message stays readable. Expiry and read limits apply to the Stello path only.',
        inputSchema: {
            id: z.string().describe('Newsletter id'),
            title: z.string().optional().describe('New subject line'),
            sender_name: z.string().optional(),
            invite_button: z.string().optional()
                .describe('Text on the button in the invitation email, e.g. "Read the update"'),
            lifespan_days: z.union([z.number().int().min(1), z.literal('never')]).nullable()
                .optional().describe('Days until the message expires. null inherits the account '
                    + 'default. Note "never" cannot travel in the handoff file — set it in Stello.'),
            max_reads: z.union([z.number().int().min(1), z.literal('unlimited')]).nullable()
                .optional().describe('How many times each partner can open it.'),
        },
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true},
    }, guard_sync(({id, title, sender_name, invite_button, lifespan_days, max_reads}) => {
        const newsletter = require_newsletter(store, id)
        if (title !== undefined) {
            newsletter.title = title
        }
        if (sender_name !== undefined) {
            newsletter.options.sender_name = sender_name
        }
        if (invite_button !== undefined) {
            newsletter.options.invite_button = invite_button
        }
        if (lifespan_days !== undefined) {
            newsletter.options.lifespan_days = lifespan_days
        }
        if (max_reads !== undefined) {
            newsletter.options.max_reads = max_reads
        }
        store.touch(newsletter)
        store.save()
        return text(summarise(store, newsletter))
    }))

    server.registerTool('newsletter_preview', {
        title: 'Preview a newsletter',
        description: 'Render the newsletter to a standalone HTML file so it can be opened and '
            + 'read exactly as a partner would see it. Always preview before sending.',
        inputSchema: {
            id: z.string().describe('Newsletter id'),
            as_partner_id: z.string().optional()
                .describe('Fill personalised values using this partner, to check how greetings '
                    + 'read. Uses "Friend" when omitted.'),
        },
        annotations: {readOnlyHint: true},
    }, guard_sync(({id, as_partner_id}) => {
        const newsletter = require_newsletter(store, id)
        const partner = as_partner_id ? store.partner(as_partner_id) : undefined
        if (as_partner_id && !partner) {
            return fail(`No partner with id "${as_partner_id}".`)
        }
        const html = render_page(newsletter, {
            recipient: partner
                ? {name: partner.name, name_hello: partner.name_hello}
                : undefined,
        })
        const path = store.export_path(`preview-${newsletter.id}.html`)
        writeFileSync(path, html, 'utf8')
        return data(`Preview written to:\n${path}\n\nOpen it in a browser to read it.\n\n`
            + `Plain-text version:\n\n${render_text(newsletter).slice(0, 1200)}`,
            {path, sections: newsletter.sections.length})
    }))

    server.registerTool('newsletter_delete', {
        title: 'Delete a newsletter',
        description: 'Permanently delete a newsletter from this workspace. Does not affect '
            + 'anything already imported into Stello or already sent.',
        inputSchema: {id: z.string()},
        annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true},
    }, guard_sync(({id}) => {
        const newsletter = require_newsletter(store, id)
        store.remove_newsletter(id)
        store.save()
        return text(`Deleted "${newsletter.title}".`)
    }))

    server.registerTool('newsletter_variables', {
        title: 'List personalisation variables',
        description: 'List the {{variables}} that can be placed in newsletter text and are '
            + 'filled in per recipient when the newsletter is sent.',
        inputSchema: {},
        annotations: {readOnlyHint: true},
    }, guard_sync(() => text(Object.entries(TEMPLATE_VARIABLES)
        .map(([key, label]) => `{{${key}}} — ${label}`).join('\n'))))
}

/** Insert a section at a 1-based position, or append when no position is given. */
function insert(newsletter: Newsletter, section: Section, position?: number): void {
    if (position === undefined) {
        newsletter.sections.push(section)
        return
    }
    const index = Math.min(Math.max(position - 1, 0), newsletter.sections.length)
    newsletter.sections.splice(index, 0, section)
}
