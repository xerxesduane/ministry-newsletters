// Tools for managing ministry partners and the groups a newsletter is addressed to.

import {readFileSync, writeFileSync} from 'node:fs'
import {z} from 'zod'
import Papa from 'papaparse'
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'

import {generate_token} from '../stello/ids.js'
import {new_partner, default_hello} from '../stello/convert.js'
import {load_snapshot} from '../stello/import.js'
import {text, data, fail, guard_sync} from './helpers.js'
import {require_newsletter, summarise} from './newsletters.js'
import type {Store} from '../store.js'
import type {Partner} from '../types.js'

/** Reject obviously unusable addresses early, rather than at send time. */
function valid_address(address: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.trim())
}

/** Resolve a group by id or by name, since a user will say the name. */
function find_group(store: Store, id_or_name: string) {
    return store.group(id_or_name) ?? store.group_by_name(id_or_name)
}

/** Resolve a partner by id or email address. */
function find_partner(store: Store, id_or_address: string) {
    return store.partner(id_or_address) ?? store.partner_by_address(id_or_address)
}

export function register_partner_tools(server: McpServer, store: Store): void {

    server.registerTool('partners_add', {
        title: 'Add ministry partners',
        description: 'Add one or more partners who receive newsletters. Existing partners are '
            + 'matched by email address and skipped rather than duplicated.',
        inputSchema: {
            partners: z.array(z.object({
                name: z.string().min(1).describe('Full name, e.g. "Robert Smith"'),
                address: z.string().describe('Email address'),
                name_hello: z.string().optional()
                    .describe('How to greet them, e.g. "Bob". Defaults to their first name.'),
                notes: z.string().optional().describe('Private notes — never shown to them'),
                multiple: z.boolean().optional()
                    .describe('True when the address reaches several people, such as a family or '
                        + 'shared inbox. Greetings are written for a group instead of a person.'),
            })).min(1),
            group: z.string().optional()
                .describe('Also put them in this group, by name or id. Created if it does not '
                    + 'exist.'),
        },
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false},
    }, guard_sync(({partners, group}) => {
        const added: Partner[] = []
        const skipped: string[] = []
        const invalid: string[] = []

        for (const input of partners) {
            if (!valid_address(input.address)) {
                invalid.push(`${input.name} <${input.address}>`)
                continue
            }
            if (store.partner_by_address(input.address)) {
                skipped.push(input.address)
                continue
            }
            const partner = new_partner(input.name, input.address, {
                ...(input.name_hello !== undefined ? {name_hello: input.name_hello} : {}),
                ...(input.notes !== undefined ? {notes: input.notes} : {}),
                ...(input.multiple !== undefined ? {multiple: input.multiple} : {}),
            })
            store.add_partner(partner)
            added.push(partner)
        }

        let group_name: string | null = null
        if (group && added.length) {
            let target = find_group(store, group)
            if (!target) {
                target = {id: generate_token(), name: group, partners: []}
                store.add_group(target)
            }
            target.partners.push(...added.map(p => p.id))
            group_name = target.name
        }

        store.save()

        const lines = [`Added ${added.length} partner(s)`
            + (group_name ? ` to group "${group_name}"` : '') + '.']
        if (added.length) {
            lines.push(...added.map(p => `  - ${p.name} <${p.address}> (id ${p.id})`))
        }
        if (skipped.length) {
            lines.push(`Skipped ${skipped.length} already on the list: ${skipped.join(', ')}`)
        }
        if (invalid.length) {
            lines.push(`Not a valid email address, so not added: ${invalid.join(', ')}`)
        }
        return data(lines.join('\n'),
            {added: added.length, skipped: skipped.length, invalid: invalid.length})
    }))

    server.registerTool('partners_list', {
        title: 'List ministry partners',
        description: 'List partners, optionally only those in one group.',
        inputSchema: {
            group: z.string().optional().describe('Limit to this group, by name or id'),
            search: z.string().optional().describe('Match against name, address or notes'),
        },
        annotations: {readOnlyHint: true},
    }, guard_sync(({group, search}) => {
        let partners = store.partners()
        if (group) {
            const target = find_group(store, group)
            if (!target) {
                return fail(`No group "${group}". Groups: `
                    + (store.groups().map(g => g.name).join(', ') || '(none)'))
            }
            partners = partners.filter(p => target.partners.includes(p.id))
        }
        if (search) {
            const needle = search.toLowerCase()
            partners = partners.filter(p =>
                p.name.toLowerCase().includes(needle)
                || p.address.toLowerCase().includes(needle)
                || p.notes.toLowerCase().includes(needle))
        }
        if (!partners.length) {
            return text('No matching partners.')
        }
        const body = partners.map(p =>
            `- ${p.name} <${p.address}>`
            + (p.name_hello && p.name_hello !== default_hello(p.name) ? ` (greet: ${p.name_hello})` : '')
            + (p.multiple ? ' [group address]' : '')
            + (p.notes ? `\n    ${p.notes}` : '')
            + `\n    id: ${p.id}`).join('\n')
        return data(`${partners.length} partner(s):\n${body}`, {count: partners.length})
    }))

    server.registerTool('partners_update', {
        title: 'Update a partner',
        description: 'Change a partner\'s details.',
        inputSchema: {
            partner: z.string().describe('Partner id or current email address'),
            name: z.string().optional(),
            address: z.string().optional(),
            name_hello: z.string().optional(),
            notes: z.string().optional(),
            multiple: z.boolean().optional(),
        },
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true},
    }, guard_sync(({partner, name, address, name_hello, notes, multiple}) => {
        const found = find_partner(store, partner)
        if (!found) {
            return fail(`No partner matching "${partner}".`)
        }
        if (address !== undefined) {
            if (!valid_address(address)) {
                return fail(`"${address}" is not a valid email address.`)
            }
            const clash = store.partner_by_address(address)
            if (clash && clash.id !== found.id) {
                return fail(`${clash.name} already uses ${address}.`)
            }
            found.address = address.trim()
        }
        if (name !== undefined) {
            found.name = name.trim()
        }
        if (name_hello !== undefined) {
            found.name_hello = name_hello.trim()
        }
        if (notes !== undefined) {
            found.notes = notes
        }
        if (multiple !== undefined) {
            found.multiple = multiple
        }
        store.save()
        return text(`Updated ${found.name} <${found.address}>.`)
    }))

    server.registerTool('partners_remove', {
        title: 'Remove a partner',
        description: 'Remove a partner from this workspace, and from every group and audience '
            + 'that referenced them. Does not remove them from Stello.',
        inputSchema: {partner: z.string().describe('Partner id or email address')},
        annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true},
    }, guard_sync(({partner}) => {
        const found = find_partner(store, partner)
        if (!found) {
            return fail(`No partner matching "${partner}".`)
        }
        store.remove_partner(found.id)
        store.save()
        return text(`Removed ${found.name} <${found.address}>.`)
    }))

    server.registerTool('partners_import_csv', {
        title: 'Import partners from a CSV',
        description: 'Import partners from a CSV file. Recognises the column names Stello itself '
            + 'exports (Name, Email, Notes, Greet as, Is mailing list) as well as common '
            + 'variations such as "Email Address" or "First Name"/"Last Name". Partners already '
            + 'on the list, matched by email, are skipped.',
        inputSchema: {
            path: z.string().describe('Absolute path to the CSV file'),
            group: z.string().optional().describe('Put everyone imported into this group'),
        },
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false},
    }, guard_sync(({path, group}) => {
        const csv = readFileSync(path, 'utf8')
        const parsed = Papa.parse<Record<string, string>>(csv, {
            header: true,
            skipEmptyLines: true,
            transformHeader: header => header.trim().toLowerCase(),
        })
        if (!parsed.data.length) {
            return fail(`No rows found in ${path}.`)
        }

        const pick = (row: Record<string, string>, ...names: string[]): string => {
            for (const name of names) {
                const value = row[name]
                if (value?.trim()) {
                    return value.trim()
                }
            }
            return ''
        }

        const added: Partner[] = []
        const skipped: string[] = []
        const invalid: string[] = []

        for (const row of parsed.data) {
            const address = pick(row, 'email', 'email address', 'e-mail', 'address', 'mail')
            const first = pick(row, 'first name', 'firstname', 'given name')
            const last = pick(row, 'last name', 'lastname', 'surname', 'family name')
            const name = pick(row, 'name', 'full name', 'display name')
                || [first, last].filter(Boolean).join(' ')

            if (!address || !valid_address(address)) {
                invalid.push(`${name || '(no name)'} <${address || 'no address'}>`)
                continue
            }
            if (store.partner_by_address(address)) {
                skipped.push(address)
                continue
            }
            const is_list = pick(row, 'is mailing list', 'multiple', 'mailing list')
            const partner = new_partner(name || address, address, {
                name_hello: pick(row, 'greet as', 'greeting', 'nickname', 'hello') || first,
                notes: pick(row, 'notes', 'note', 'comment'),
                multiple: /^(true|yes|y|1)$/i.test(is_list),
            })
            store.add_partner(partner)
            added.push(partner)
        }

        let group_name: string | null = null
        if (group && added.length) {
            let target = find_group(store, group)
            if (!target) {
                target = {id: generate_token(), name: group, partners: []}
                store.add_group(target)
            }
            target.partners.push(...added.map(p => p.id))
            group_name = target.name
        }

        store.save()

        const lines = [`Imported ${added.length} partner(s) from ${path}`
            + (group_name ? ` into group "${group_name}"` : '') + '.']
        if (skipped.length) {
            lines.push(`${skipped.length} already on the list.`)
        }
        if (invalid.length) {
            lines.push(`${invalid.length} row(s) had no usable email address:`)
            lines.push(...invalid.slice(0, 10).map(r => `  - ${r}`))
            if (invalid.length > 10) {
                lines.push(`  …and ${invalid.length - 10} more`)
            }
        }
        return data(lines.join('\n'),
            {added: added.length, skipped: skipped.length, invalid: invalid.length})
    }))

    server.registerTool('partners_export_csv', {
        title: 'Export partners to a CSV',
        description: 'Write partners to a CSV file using the same columns Stello exports, so the '
            + 'file can be opened in a spreadsheet or imported into Stello.',
        inputSchema: {
            group: z.string().optional().describe('Export only this group'),
        },
        annotations: {readOnlyHint: true},
    }, guard_sync(({group}) => {
        let partners = store.partners()
        let label = 'all-partners'
        if (group) {
            const target = find_group(store, group)
            if (!target) {
                return fail(`No group "${group}".`)
            }
            partners = partners.filter(p => target.partners.includes(p.id))
            label = target.name.replace(/[^\w-]+/g, '-').toLowerCase()
        }
        const rows = [['Name', 'Email', 'Notes', 'Greet as', 'Is mailing list']]
        rows.push(...partners.map(p =>
            [p.name, p.address, p.notes, p.name_hello, p.multiple ? 'True' : '']))
        const path = store.export_path(`${label}.csv`)
        writeFileSync(path, Papa.unparse(rows), 'utf8')
        return data(`Wrote ${partners.length} partner(s) to:\n${path}`,
            {path, count: partners.length})
    }))

    server.registerTool('partners_import_from_stello', {
        title: 'Import partners from Stello',
        description: 'Read the contacts and groups already in Stello, from its own backup file, '
            + 'and bring them into this workspace keeping their Stello ids. Do this before '
            + 'writing a newsletter if partners are already managed in Stello — it means a '
            + 'handoff file will address the contacts Stello already has instead of duplicating '
            + 'them. Read-only: nothing is written to Stello.',
        inputSchema: {},
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true},
    }, guard_sync(() => {
        const snapshot = load_snapshot()
        if (!snapshot) {
            return fail('No Stello backup found. In Stello, open Settings -> Backup and use '
                + '"Back up database now", then run this again. If Stello keeps its files '
                + 'somewhere unusual, set STELLO_FILES_DIR or STELLO_BACKUP_FILE.')
        }

        let contacts_added = 0
        for (const contact of snapshot.contacts) {
            if (store.partner(contact.id) || store.partner_by_address(contact.address)) {
                continue
            }
            store.add_partner(contact)
            contacts_added += 1
        }

        let groups_added = 0
        for (const group of snapshot.groups) {
            if (store.group(group.id) || store.group_by_name(group.name)) {
                continue
            }
            store.add_group(group)
            groups_added += 1
        }

        store.save()

        const lines = [
            `Read ${snapshot.source}`,
            `Added ${contacts_added} partner(s) and ${groups_added} group(s).`,
        ]
        if (snapshot.profiles.length) {
            lines.push('', 'Stello sending accounts found:')
            lines.push(...snapshot.profiles.map(p =>
                `  - ${p.email}${p.sender_name ? ` (${p.sender_name})` : ''}  id: ${p.id}`))
            lines.push('', 'Pass one of these ids as profile_id to stello_export so the draft '
                + 'attaches to that account.')
        }
        return data(lines.join('\n'), {
            contacts_added, groups_added, profiles: snapshot.profiles,
        })
    }))

    // Groups

    server.registerTool('group_create', {
        title: 'Create a partner group',
        description: 'Create a named group, such as "Monthly Supporters" or "Prayer Team", so a '
            + 'newsletter can be addressed to them as a set.',
        inputSchema: {
            name: z.string().min(1),
            partners: z.array(z.string()).optional()
                .describe('Partner ids or email addresses to start with'),
        },
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false},
    }, guard_sync(({name, partners}) => {
        if (store.group_by_name(name)) {
            return fail(`A group called "${name}" already exists.`)
        }
        const ids: string[] = []
        const unknown: string[] = []
        for (const ref of partners ?? []) {
            const found = find_partner(store, ref)
            if (found) {
                ids.push(found.id)
            } else {
                unknown.push(ref)
            }
        }
        const group = {id: generate_token(), name, partners: ids}
        store.add_group(group)
        store.save()
        return data(`Created group "${name}" with ${ids.length} partner(s).\nid: ${group.id}`
            + (unknown.length ? `\nNot found, so not added: ${unknown.join(', ')}` : ''),
            {id: group.id, count: ids.length})
    }))

    server.registerTool('group_list', {
        title: 'List partner groups',
        description: 'List every group and how many partners it holds.',
        inputSchema: {},
        annotations: {readOnlyHint: true},
    }, guard_sync(() => {
        const groups = store.groups()
        if (!groups.length) {
            return text('No groups yet. Use group_create to make one.')
        }
        return data(groups.map(g =>
            `- "${g.name}"  ${g.partners.length} partner(s)  id: ${g.id}`).join('\n'),
            {count: groups.length})
    }))

    server.registerTool('group_set_members', {
        title: 'Change who is in a group',
        description: 'Add partners to a group or take them out.',
        inputSchema: {
            group: z.string().describe('Group name or id'),
            add: z.array(z.string()).optional().describe('Partner ids or email addresses to add'),
            remove: z.array(z.string()).optional().describe('Partner ids or addresses to remove'),
        },
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true},
    }, guard_sync(({group, add, remove}) => {
        const target = find_group(store, group)
        if (!target) {
            return fail(`No group "${group}".`)
        }
        const unknown: string[] = []
        for (const ref of add ?? []) {
            const found = find_partner(store, ref)
            if (!found) {
                unknown.push(ref)
            } else if (!target.partners.includes(found.id)) {
                target.partners.push(found.id)
            }
        }
        for (const ref of remove ?? []) {
            const found = find_partner(store, ref)
            if (!found) {
                unknown.push(ref)
                continue
            }
            target.partners = target.partners.filter(id => id !== found.id)
        }
        store.save()
        return text(`"${target.name}" now has ${target.partners.length} partner(s).`
            + (unknown.length ? `\nNot found: ${unknown.join(', ')}` : ''))
    }))

    server.registerTool('group_delete', {
        title: 'Delete a group',
        description: 'Delete a group. The partners in it are kept.',
        inputSchema: {group: z.string().describe('Group name or id')},
        annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true},
    }, guard_sync(({group}) => {
        const target = find_group(store, group)
        if (!target) {
            return fail(`No group "${group}".`)
        }
        store.remove_group(target.id)
        store.save()
        return text(`Deleted group "${target.name}". Its ${target.partners.length} partner(s) `
            + 'are still on the partner list.')
    }))

    // Audience

    server.registerTool('newsletter_set_audience', {
        title: 'Set who receives a newsletter',
        description: 'Choose the groups and partners a newsletter goes to. Use "all" as a group '
            + 'to reach every partner. A directly included partner is sent to even if one of '
            + 'their groups is excluded; a directly excluded partner is never sent to.',
        inputSchema: {
            id: z.string().describe('Newsletter id'),
            include_groups: z.array(z.string()).optional()
                .describe('Group names or ids, or "all" for every partner'),
            include_partners: z.array(z.string()).optional()
                .describe('Partner ids or email addresses to add individually'),
            exclude_groups: z.array(z.string()).optional(),
            exclude_partners: z.array(z.string()).optional(),
        },
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true},
    }, guard_sync(({id, include_groups, include_partners, exclude_groups, exclude_partners}) => {
        const newsletter = require_newsletter(store, id)
        const unknown: string[] = []

        const resolve_groups = (refs: string[] | undefined): string[] | undefined => {
            if (refs === undefined) {
                return undefined
            }
            return refs.map(ref => {
                if (ref === 'all') {
                    return 'all'
                }
                const found = find_group(store, ref)
                if (!found) {
                    unknown.push(ref)
                    return null
                }
                return found.id
            }).filter((value): value is string => value !== null)
        }

        const resolve_partners = (refs: string[] | undefined): string[] | undefined => {
            if (refs === undefined) {
                return undefined
            }
            return refs.map(ref => {
                const found = find_partner(store, ref)
                if (!found) {
                    unknown.push(ref)
                    return null
                }
                return found.id
            }).filter((value): value is string => value !== null)
        }

        const groups_in = resolve_groups(include_groups)
        const partners_in = resolve_partners(include_partners)
        const groups_out = resolve_groups(exclude_groups)
        const partners_out = resolve_partners(exclude_partners)

        if (groups_in !== undefined) {
            newsletter.audience.include_groups = groups_in
        }
        if (partners_in !== undefined) {
            newsletter.audience.include_partners = partners_in
        }
        if (groups_out !== undefined) {
            newsletter.audience.exclude_groups = groups_out
        }
        if (partners_out !== undefined) {
            newsletter.audience.exclude_partners = partners_out
        }

        store.touch(newsletter)
        store.save()

        const body = summarise(store, newsletter)
        return unknown.length
            ? text(`${body}\n\nNot found, so ignored: ${unknown.join(', ')}`)
            : text(body)
    }))
}
