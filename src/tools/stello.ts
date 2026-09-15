// Tools for handing a finished newsletter to Stello.
//
// The handoff works through Stello's own restore-from-backup feature. Stello's `import_database()`
// adds records with IndexedDB `add()`, which rejects on an existing key — so importing this file
// can only ADD a draft and its sections. It never modifies or deletes anything already in Stello.
// That property is why this connector writes a file instead of touching Stello's database.

import {z} from 'zod'
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'

import {write_export} from '../stello/export.js'
import {load_snapshot, find_backup_file} from '../stello/import.js'
import {blobstore_available} from '../stello/blobstore.js'
import {find_stello_files, stello_internal_files, smtp_config} from '../config.js'
import {text, data, fail, guard_sync} from './helpers.js'
import {require_newsletter} from './newsletters.js'
import type {Store} from '../store.js'

export function register_stello_tools(server: McpServer, store: Store): void {

    server.registerTool('stello_status', {
        title: 'Check the Stello setup',
        description: 'Report whether Stello is installed and reachable on this machine, whether '
            + 'its contacts have been imported, and whether direct email is configured. Run this '
            + 'first when something is not working.',
        inputSchema: {},
        annotations: {readOnlyHint: true},
    }, guard_sync(() => {
        const files_dir = find_stello_files()
        const internal = stello_internal_files()
        const backup = find_backup_file()
        const snapshot = backup ? load_snapshot() : null
        const smtp = smtp_config()
        const locations = store.location()

        const lines = [
            'Workspace',
            `  data:    ${locations.data_dir}`,
            `  exports: ${locations.exports}`,
            `  ${store.newsletters().length} newsletter(s), ${store.partners().length} partner(s), `
                + `${store.groups().length} group(s)`,
            '',
            'Stello',
            files_dir
                ? `  Stello Files: ${files_dir}`
                : '  Stello Files: not found — install and open Stello once, or set '
                    + 'STELLO_FILES_DIR.',
            `  Image support: ${blobstore_available()
                ? `available (${internal})`
                : 'unavailable until Stello Files exists'}`,
            backup
                ? `  Backup found: ${backup}`
                : '  Backup: none found. In Stello open Settings -> Backup and choose '
                    + '"Back up database now" to let this connector see your contacts and '
                    + 'sending account.',
        ]

        if (snapshot) {
            lines.push(`  Contacts in Stello: ${snapshot.contacts.length}, `
                + `groups: ${snapshot.groups.length}`)
            if (snapshot.profiles.length) {
                lines.push('  Sending accounts:')
                lines.push(...snapshot.profiles.map(p =>
                    `    - ${p.email}${p.sender_name ? ` (${p.sender_name})` : ''}  id: ${p.id}`))
            }
        }

        lines.push('', 'Direct email (fallback path)',
            smtp
                ? `  Configured: ${smtp.user} via ${smtp.host}:${smtp.port}`
                : '  Not configured. Set EPISTLE_SMTP_HOST, EPISTLE_SMTP_USER and '
                    + 'EPISTLE_SMTP_PASS to enable it.')

        return data(lines.join('\n'), {
            stello_files: files_dir,
            images_available: blobstore_available(),
            backup_found: Boolean(backup),
            smtp_configured: Boolean(smtp),
        })
    }))

    server.registerTool('stello_export', {
        title: 'Hand a newsletter to Stello',
        description: 'Write a file that Stello imports to create this newsletter as a real draft, '
            + 'ready for review and sending from Stello. This is the recommended way to send: '
            + 'Stello encrypts each copy end to end, sends the invitations from the user\'s own '
            + 'email account, and supports expiry, read counts, reactions and replies. '
            + 'Importing only ADDS records — it cannot change or delete anything already in '
            + 'Stello. The user still reviews the draft and presses Send themselves.',
        inputSchema: {
            id: z.string().describe('Newsletter id'),
            profile_id: z.string().optional()
                .describe('Stello sending account to attach the draft to. Get it from '
                    + 'stello_status. Omit to let Stello use the default account.'),
            include_partners: z.boolean().default(false)
                .describe('Also add this workspace\'s partners to Stello as contacts. Leave false '
                    + 'when contacts are already managed in Stello.'),
            include_groups: z.boolean().default(false)
                .describe('Also add this workspace\'s groups. Requires include_partners.'),
        },
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false},
    }, guard_sync(({id, profile_id, include_partners, include_groups}) => {
        const newsletter = require_newsletter(store, id)

        if (!newsletter.sections.length) {
            return fail('This newsletter has no content yet. Add at least one section first.')
        }

        const audience = store.resolve_audience(newsletter)
        // Reading Stello's backup lets us skip contacts it already has, so the import does not
        // pile up duplicates of people the user already manages there.
        const snapshot = load_snapshot()
        const existing_ids = snapshot
            ? {
                contacts: snapshot.contacts.map(c => c.id),
                groups: snapshot.groups.map(g => g.id),
            }
            : undefined

        const filename = `stello-import-${newsletter.id}.json`
        const path = store.export_path(filename)
        const result = write_export(path, newsletter, store.partners(), store.groups(), {
            profile_id: profile_id ?? null,
            include_partners,
            include_groups,
            ...(existing_ids ? {existing_ids} : {}),
        })

        newsletter.last_export = {path: result.path, at: new Date().toISOString()}
        newsletter.status = 'exported'
        store.touch(newsletter)
        store.save()

        const lines = [
            `Wrote the Stello import file for "${newsletter.title}":`,
            `  ${result.path}`,
            '',
            `Contains: 1 draft, ${result.counts.sections} section(s)`
                + (result.counts.contacts ? `, ${result.counts.contacts} contact(s)` : '')
                + (result.counts.groups ? `, ${result.counts.groups} group(s)` : ''),
        ]

        if (result.skipped.contacts || result.skipped.groups) {
            lines.push(`Left out because Stello already has them: `
                + `${result.skipped.contacts} contact(s), ${result.skipped.groups} group(s)`)
        }

        lines.push('',
            'To bring it into Stello:',
            '  1. Open Stello',
            '  2. Go to Settings -> Backup',
            '  3. Under "Restore", choose "Import database" and pick the file above',
            '  4. The draft appears under Drafts — open it, check it over, and press Send',
            '',
            'Importing only adds records. Anything already in Stello is left untouched.')

        if (!audience.length) {
            lines.push('',
                'Note: no recipients are set on this newsletter, so you will need to choose who '
                + 'it goes to in Stello before sending. Use newsletter_set_audience to set them '
                + 'here instead.')
        } else if (!include_partners && !snapshot) {
            lines.push('',
                `Note: this draft names ${audience.length} recipient(s) by id. Stello could not be `
                + 'read to confirm it already has those contacts, so if the draft opens with no '
                + 'recipients, re-run with include_partners: true.')
        }

        if (result.warnings.length) {
            lines.push('', 'Warnings:')
            lines.push(...result.warnings.map(w => `  - ${w.field}: ${w.detail}`))
        }

        return data(lines.join('\n'), {
            path: result.path,
            counts: result.counts,
            recipients: audience.length,
            warnings: result.warnings,
        })
    }))

    server.registerTool('stello_how_it_works', {
        title: 'Explain the two delivery routes',
        description: 'Explain how a newsletter reaches partners, and what the Stello route gives '
            + 'up or gains over plain email. Use this when the user asks how sending works or '
            + 'which route to choose.',
        inputSchema: {},
        annotations: {readOnlyHint: true},
    }, guard_sync(() => text([
        'There are two ways a newsletter written here reaches your partners.',
        '',
        '1. Through Stello (recommended)',
        '   stello_export writes a file; you import it in Stello and press Send.',
        '   Stello encrypts a separate copy of the newsletter for each partner, uploads the',
        '   encrypted copies to your storage, then emails each partner a short invitation with a',
        '   private link. The decryption key travels in the part of the link browsers never send',
        '   to a server, so the host storing your newsletter cannot read it.',
        '   You get: end-to-end encryption, messages that expire, read counts, reactions,',
        '   replies and per-section comments, and the ability to retract a message after sending.',
        '   Costs you: one manual import step, and pressing Send yourself.',
        '',
        '2. Direct email (fallback)',
        '   email_send delivers the newsletter as an ordinary HTML email from your own mail',
        '   account, one personalised copy per partner.',
        '   You get: no extra steps, and it works without Stello installed.',
        '   You give up: encryption, expiry, read tracking, reactions and replies, and any way',
        '   to retract. It is a normal email and lives in inboxes forever.',
        '',
        'Either way you see the newsletter before it goes out — use newsletter_preview.',
        'Direct sending additionally refuses to run unless you confirm the exact recipient count.',
    ].join('\n'))))
}
