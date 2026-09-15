// Build the handoff file that Stello's "restore from backup" reads.
//
// Stello's `import_database()` (app/src/services/backup/database.ts) adds every record with
// IndexedDB `add()`. An `add()` on an existing key rejects, and Stello counts that as "skipped" —
// so importing this file can only ever ADD records. It cannot modify or delete anything the user
// already has, which is what makes this a safe way to hand Claude's work to Stello.

import {writeFileSync, mkdirSync} from 'node:fs'
import {dirname} from 'node:path'

import {generate_token} from './ids.js'
import {newsletter_to_draft, partner_to_contact, group_to_record, type ConversionWarning}
    from './convert.js'
import {STELLO_BACKUP_VERSION, type ExportedDatabase} from './records.js'
import type {Newsletter, Partner, PartnerGroup} from '../types.js'

export interface ExportOptions {
    /**
     * The Stello profile (sending account) id to attach the draft to.
     *
     * null leaves the draft unattached; Stello then uses the user's default account when they
     * open it. That is the right default when we cannot read the user's Stello database.
     */
    profile_id?: string | null
    /** Include partners as Stello contacts. Off when the user already manages contacts in Stello. */
    include_partners?: boolean
    /** Include groups. Requires `include_partners` for the group members to exist. */
    include_groups?: boolean
    /** Existing Stello contact/group ids, so records the user already has are not duplicated. */
    existing_ids?: {contacts?: string[], groups?: string[]}
}

export interface ExportResult {
    path: string
    counts: {drafts: number, sections: number, contacts: number, groups: number}
    warnings: ConversionWarning[]
    /** Ids already present in Stello that we deliberately left out. */
    skipped: {contacts: number, groups: number}
}

/**
 * Build the backup envelope for one newsletter.
 *
 * Only the tables we actually populate are included. Stello iterates a fixed list of stores and
 * treats a missing one as empty, so omitting `profiles`, `messages` and the response tables is
 * both valid and much safer than shipping placeholder rows.
 */
export function build_export(newsletter: Newsletter, partners: Partner[], groups: PartnerGroup[],
        options: ExportOptions = {}): {database: ExportedDatabase, result: Omit<ExportResult, 'path'>} {

    const warnings: ConversionWarning[] = []
    const {draft, sections} = newsletter_to_draft(
        newsletter, options.profile_id ?? null, warnings)

    const existing_contacts = new Set(options.existing_ids?.contacts ?? [])
    const existing_groups = new Set(options.existing_ids?.groups ?? [])

    const contacts = options.include_partners
        ? partners.filter(p => !existing_contacts.has(p.id)).map(partner_to_contact)
        : []
    const group_records = options.include_groups && options.include_partners
        ? groups.filter(g => !existing_groups.has(g.id)).map(group_to_record)
        : []

    if (options.include_groups && !options.include_partners) {
        warnings.push({
            field: 'include_groups',
            detail: 'Groups were skipped because partners were not included — a group in Stello'
                + ' would point at contacts that do not exist there.',
        })
    }

    const database: ExportedDatabase = {
        version: STELLO_BACKUP_VERSION,
        // Stello reads only `tables` on import, but its own exports carry a database id, so we
        // write one too rather than emit a file that differs in shape from what it produces.
        dbid: generate_token(),
        tables: {
            ...(contacts.length ? {contacts} : {}),
            ...(group_records.length ? {groups: group_records} : {}),
            drafts: [draft],
            sections,
        },
    }

    return {
        database,
        result: {
            counts: {
                drafts: 1,
                sections: sections.length,
                contacts: contacts.length,
                groups: group_records.length,
            },
            warnings,
            skipped: {
                contacts: options.include_partners
                    ? partners.length - contacts.length
                    : 0,
                groups: options.include_groups && options.include_partners
                    ? groups.length - group_records.length
                    : 0,
            },
        },
    }
}

/** Build the handoff file and write it to disk. */
export function write_export(path: string, newsletter: Newsletter, partners: Partner[],
        groups: PartnerGroup[], options: ExportOptions = {}): ExportResult {
    const {database, result} = build_export(newsletter, partners, groups, options)
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, JSON.stringify(database, null, 2), 'utf8')
    return {path, ...result}
}
