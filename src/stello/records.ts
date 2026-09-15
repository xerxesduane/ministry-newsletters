// Stello database record types, mirrored from upstream so we can emit a valid backup file.
//
// Source of truth: gracious-tech/stello -> app/src/services/database/types.ts
// The JSON-safe "Exported*" variants mirror app/src/services/backup/database.ts, which is what
// Stello's `import_database()` consumes. Keep both in sync when Stello changes.

/** A row of the message body: one section id, or two side-by-side. */
export type SectionIds = ([string] | [string, string])[]

export interface ContentText {
    type: 'text'
    html: string
    standout: null | 'distinct' | 'notice' | 'important'
}

export interface ContentImageItem {
    id: string
    /** Blobstore filename (a file in `Stello Files/Internal Files/`), not raw bytes. */
    data: string
    caption: string
}

export interface ContentImages {
    type: 'images'
    images: ContentImageItem[]
    crop: boolean
    hero: boolean
}

export interface ContentVideo {
    type: 'video'
    format: 'iframe_youtube' | 'iframe_vimeo' | null
    id: string | null
    caption: string
    start: number | null
    end: number | null
}

export interface ContentChart {
    type: 'chart'
    chart: 'bar' | 'line' | 'doughnut'
    /** `number` is a display string (e.g. "$5,000", "42%"); Stello strips non-digits for maths. */
    data: {id: string, number: string, label: string, hue: number}[]
    threshold: string
    title: string
    caption: string
}

export interface ContentPage {
    type: 'page'
    button: boolean
    headline: string
    desc: string
    image: string | null
    sections: SectionIds
}

export interface ContentFiles {
    type: 'files'
    files: {data: string, name: string, ext: string}[]
    label: string
}

export type RecordSectionContent =
    ContentText | ContentImages | ContentVideo | ContentChart | ContentFiles | ContentPage

export interface RecordSection {
    id: string
    /** null lets Stello decide whether recipients can comment on this section. */
    respondable: boolean | null
    content: RecordSectionContent
}

export interface RecordDraftRecipients {
    /** 'all' is a special group id meaning every contact. */
    include_groups: string[]
    include_contacts: string[]
    exclude_groups: string[]
    exclude_contacts: string[]
}

export interface RecordDraft {
    id: string
    template: boolean
    reply_to: string | null
    modified: Date
    title: string
    sections: SectionIds
    profile: string | null
    options_identity: {
        /** Empty string (not null) triggers inheritance from the profile. */
        sender_name: string
        invite_image: string | null
        invite_tmpl_email: string | null
        invite_tmpl_clipboard: null
        invite_button: string
    }
    options_security: {
        /** Days until expiry. null inherits from profile; may be Infinity for never. */
        lifespan: number | null
        max_reads: number | null
    }
    recipients: RecordDraftRecipients
}

export interface RecordContact {
    id: string
    created: Date
    name: string
    /** How to greet them, e.g. "Bob" for a contact named "Robert Smith". */
    name_hello: string
    address: string
    notes: string
    service_account: string | null
    service_id: string | null
    /** True when the address reaches several people (a mailing list). */
    multiple: boolean
}

export interface RecordGroup {
    id: string
    name: string
    contacts: string[]
    service_account: string | null
    service_id: string | null
}

// JSON-safe shapes actually written to the backup file.
// Only fields that cannot round-trip through JSON differ from the records above.

export interface ExportedDraft extends Omit<RecordDraft, 'modified'> {
    modified: string
}

export interface ExportedContact extends Omit<RecordContact, 'created'> {
    created: string
}

/**
 * The full backup envelope consumed by Stello's `import_database()`.
 *
 * Stello reads only `tables`, and adds each record with IndexedDB `add()` — so a record whose id
 * already exists is skipped, never overwritten. `version` and `dbid` are written for forward
 * compatibility and to match what Stello's own export produces.
 */
export interface ExportedDatabase {
    version: number
    dbid: string
    tables: {
        contacts?: ExportedContact[]
        groups?: RecordGroup[]
        drafts?: ExportedDraft[]
        sections?: RecordSection[]
        [store: string]: unknown[] | undefined
    }
}

/** Backup format version Stello writes and expects. */
export const STELLO_BACKUP_VERSION = 1
