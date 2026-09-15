// Tests that the handoff file is genuinely importable by Stello.
//
// The centrepiece is `replay_stello_import`, which reimplements Stello's own `import_database()`
// (app/src/services/backup/database.ts) — the same per-table converters and the same `db.add()`
// semantics, where adding an existing key fails and is counted as skipped. Running our output
// through it proves the file does what we claim, including that an import can only ever ADD.

import test from 'node:test'
import assert from 'node:assert/strict'

import {build_export} from '../src/stello/export.js'
import {newsletter_to_draft, partner_to_contact, group_to_record, new_partner}
    from '../src/stello/convert.js'
import {generate_token} from '../src/stello/ids.js'
import {markdown_to_stello_html} from '../src/stello/html.js'
import type {ExportedDatabase} from '../src/stello/records.js'
import type {Newsletter, Partner, PartnerGroup, Section} from '../src/types.js'

// A stand-in for Stello's IndexedDB: object stores keyed on `id`.
type FakeDb = Record<string, Map<string, unknown>>

function empty_db(): FakeDb {
    return {contacts: new Map(), groups: new Map(), drafts: new Map(), sections: new Map()}
}

/**
 * Replay Stello's `import_database()` over a backup envelope.
 *
 * Mirrors upstream exactly: each table has a converter, every record goes through `db.add()`,
 * and an add onto an existing key throws and is counted as skipped rather than overwriting.
 */
function replay_stello_import(db: FakeDb, exported: ExportedDatabase)
        : {added: number, skipped: number} {
    const converters: Record<string, (record: any) => any> = {
        contacts: r => ({...r, created: new Date(r.created)}),
        groups: r => r,
        drafts: r => ({...r, modified: new Date(r.modified)}),
        sections: r => r,
    }
    let added = 0
    let skipped = 0
    for (const [store, convert] of Object.entries(converters)) {
        for (const raw of exported.tables[store] ?? []) {
            const record = convert(raw) as {id: string}
            const target = db[store]!
            // IndexedDB `add()` rejects when the key already exists.
            if (target.has(record.id)) {
                skipped += 1
                continue
            }
            target.set(record.id, record)
            added += 1
        }
    }
    return {added, skipped}
}

function text_section(markdown: string): Section {
    return {
        kind: 'text',
        id: generate_token(),
        markdown,
        html: markdown_to_stello_html(markdown),
        standout: null,
    }
}

function sample_newsletter(overrides: Partial<Newsletter> = {}): Newsletter {
    const now = new Date().toISOString()
    return {
        id: generate_token(),
        title: 'October Ministry Update',
        status: 'draft',
        created: now,
        modified: now,
        sections: [text_section('## Hello\n\nThank you for partnering with us.')],
        audience: {
            include_groups: [], include_partners: [],
            exclude_groups: [], exclude_partners: [],
        },
        options: {sender_name: 'Pastor', invite_button: '', lifespan_days: null, max_reads: null},
        last_export: null,
        last_direct_send: null,
        ...overrides,
    }
}

test('the envelope has the shape Stello reads', () => {
    const {database} = build_export(sample_newsletter(), [], [])
    assert.equal(database.version, 1)
    assert.equal(typeof database.dbid, 'string')
    assert.ok(database.tables.drafts)
    assert.ok(database.tables.sections)
})

test('the whole envelope survives a JSON round trip', () => {
    const {database} = build_export(sample_newsletter(), [], [])
    const round_tripped = JSON.parse(JSON.stringify(database)) as ExportedDatabase
    assert.deepEqual(round_tripped, database)
})

test('Stello\'s import accepts the file and adds the draft and its sections', () => {
    const newsletter = sample_newsletter({
        sections: [text_section('one'), text_section('two'), text_section('three')],
    })
    const {database} = build_export(newsletter, [], [])
    const db = empty_db()
    const result = replay_stello_import(db, database)

    assert.equal(result.added, 4)  // one draft + three sections
    assert.equal(result.skipped, 0)
    assert.equal(db.drafts!.size, 1)
    assert.equal(db.sections!.size, 3)
})

test('the draft references exactly the sections included, in order', () => {
    const newsletter = sample_newsletter({
        sections: [text_section('first'), text_section('second')],
    })
    const {database} = build_export(newsletter, [], [])
    const draft = database.tables.drafts![0]!
    const section_ids = database.tables.sections!.map(s => s.id)

    // SectionIds is a list of rows; we emit one section per row.
    assert.deepEqual(draft.sections, section_ids.map(id => [id]))
    assert.deepEqual(section_ids, newsletter.sections.map(s => s.id))
})

test('importing the same file twice adds nothing the second time', () => {
    const {database} = build_export(sample_newsletter(), [], [])
    const db = empty_db()

    const first = replay_stello_import(db, database)
    const second = replay_stello_import(db, database)

    assert.equal(first.skipped, 0)
    assert.equal(second.added, 0)
    assert.equal(second.skipped, first.added)
    assert.equal(db.drafts!.size, 1)
})

test('an import can never overwrite a record Stello already has', () => {
    const newsletter = sample_newsletter()
    const {database} = build_export(newsletter, [], [])

    const db = empty_db()
    // Stello already holds a draft with this id, with content the user cares about.
    db.drafts!.set(newsletter.id, {id: newsletter.id, title: 'The user\'s own work'})

    const result = replay_stello_import(db, database)

    assert.equal((db.drafts!.get(newsletter.id) as {title: string}).title, 'The user\'s own work')
    assert.ok(result.skipped >= 1)
})

test('an import never deletes anything', () => {
    const db = empty_db()
    db.contacts!.set('existing-contact', {id: 'existing-contact', name: 'Long-time partner'})
    db.drafts!.set('existing-draft', {id: 'existing-draft', title: 'Half-written'})

    const {database} = build_export(sample_newsletter(), [], [])
    replay_stello_import(db, database)

    assert.ok(db.contacts!.has('existing-contact'))
    assert.ok(db.drafts!.has('existing-draft'))
})

test('partners are only included when asked for', () => {
    const partners = [new_partner('Robert Smith', 'bob@example.org')]

    const without = build_export(sample_newsletter(), partners, [])
    assert.equal(without.database.tables.contacts, undefined)

    const with_them = build_export(sample_newsletter(), partners, [], {include_partners: true})
    assert.equal(with_them.database.tables.contacts!.length, 1)
})

test('partners Stello already has are left out of the file', () => {
    const existing = new_partner('Robert Smith', 'bob@example.org')
    const fresh = new_partner('Jane Doe', 'jane@example.org')

    const {database, result} = build_export(sample_newsletter(), [existing, fresh], [], {
        include_partners: true,
        existing_ids: {contacts: [existing.id]},
    })

    assert.equal(database.tables.contacts!.length, 1)
    assert.equal(database.tables.contacts![0]!.id, fresh.id)
    assert.equal(result.skipped.contacts, 1)
})

test('groups without partners are refused, with a warning saying why', () => {
    const group: PartnerGroup = {id: generate_token(), name: 'Prayer Team', partners: []}
    const {database, result} = build_export(sample_newsletter(), [], [group], {
        include_groups: true,
        include_partners: false,
    })
    assert.equal(database.tables.groups, undefined)
    assert.ok(result.warnings.some(w => w.field === 'include_groups'))
})

test('a contact carries no service account, so Stello will not treat it as synced', () => {
    const partner = new_partner('Robert Smith', 'bob@example.org')
    const contact = partner_to_contact(partner)
    assert.equal(contact.service_account, null)
    assert.equal(contact.service_id, null)
})

test('a partner\'s greeting name defaults to their first name', () => {
    assert.equal(new_partner('Robert Smith', 'b@e.org').name_hello, 'Robert')
    assert.equal(new_partner('Robert Smith', 'b@e.org', {name_hello: 'Bob'}).name_hello, 'Bob')
})

test('the audience is carried over to the draft under Stello\'s field names', () => {
    const newsletter = sample_newsletter({
        audience: {
            include_groups: ['all'],
            include_partners: ['p1'],
            exclude_groups: ['g2'],
            exclude_partners: ['p3'],
        },
    })
    const {database} = build_export(newsletter, [], [])
    assert.deepEqual(database.tables.drafts![0]!.recipients, {
        include_groups: ['all'],
        include_contacts: ['p1'],
        exclude_groups: ['g2'],
        exclude_contacts: ['p3'],
    })
})

test('"never" expiry is reported rather than silently turned into something else', () => {
    const newsletter = sample_newsletter()
    newsletter.options.lifespan_days = 'never'
    const warnings: Parameters<typeof newsletter_to_draft>[2] = []
    const {draft} = newsletter_to_draft(newsletter, null, warnings)

    // Stello stores "never" as Infinity, which JSON cannot hold, so it has to inherit instead.
    assert.equal(draft.options_security.lifespan, null)
    assert.ok(warnings.some(w => w.field === 'lifespan_days'))
})

test('a numeric expiry passes through untouched', () => {
    const newsletter = sample_newsletter()
    newsletter.options.lifespan_days = 30
    newsletter.options.max_reads = 5
    const warnings: Parameters<typeof newsletter_to_draft>[2] = []
    const {draft} = newsletter_to_draft(newsletter, null, warnings)

    assert.equal(draft.options_security.lifespan, 30)
    assert.equal(draft.options_security.max_reads, 5)
    assert.equal(warnings.length, 0)
})

test('an image with no file in Stello\'s folder is dropped, with a warning', () => {
    const newsletter = sample_newsletter({
        sections: [{
            kind: 'images',
            id: generate_token(),
            images: [
                {id: 'a', source_path: '/tmp/a.jpg', blobstore_name: '2026_01_01_abc.jpg',
                    caption: 'kept'},
                {id: 'b', source_path: '/tmp/b.jpg', blobstore_name: null, caption: 'dropped'},
            ],
            crop: true,
            hero: false,
        }],
    })
    const {database, result} = build_export(newsletter, [], [])
    const content = database.tables.sections![0]!.content as {images: unknown[]}

    assert.equal(content.images.length, 1)
    assert.ok(result.warnings.some(w => w.detail.includes('Internal Files')))
})

test('a video section keeps the platform id Stello expects', () => {
    const newsletter = sample_newsletter({
        sections: [{
            kind: 'video',
            id: generate_token(),
            format: 'iframe_youtube',
            video_id: 'dQw4w9WgXcQ',
            caption: 'Our vision',
            start: null,
            end: null,
        }],
    })
    const {database} = build_export(newsletter, [], [])
    assert.deepEqual(database.tables.sections![0]!.content, {
        type: 'video',
        format: 'iframe_youtube',
        id: 'dQw4w9WgXcQ',
        caption: 'Our vision',
        start: null,
        end: null,
    })
})

test('a chart section keeps values as display strings', () => {
    const newsletter = sample_newsletter({
        sections: [{
            kind: 'chart',
            id: generate_token(),
            chart: 'bar',
            data: [{id: 'a', number: '$4,250', label: 'September', hue: 200}],
            threshold: '$10,000',
            title: 'Building fund',
            caption: '',
        }],
    })
    const {database} = build_export(newsletter, [], [])
    const content = database.tables.sections![0]!.content as {data: {number: string}[]}
    assert.equal(content.data[0]!.number, '$4,250')
})

test('every section record has the fields Stello requires', () => {
    const newsletter = sample_newsletter({
        sections: [text_section('a'), {
            kind: 'video', id: generate_token(), format: 'iframe_vimeo', video_id: '123',
            caption: '', start: null, end: null,
        }],
    })
    const {database} = build_export(newsletter, [], [])
    for (const section of database.tables.sections!) {
        assert.equal(typeof section.id, 'string')
        assert.ok('respondable' in section)
        assert.ok('content' in section)
        assert.equal(typeof section.content.type, 'string')
    }
})

test('the draft record has every field Stello\'s RecordDraft declares', () => {
    const {database} = build_export(sample_newsletter(), [], [])
    const draft = database.tables.drafts![0]! as unknown as Record<string, unknown>
    // RecordDraft has no optional fields upstream, so a missing one is a real defect.
    for (const field of ['id', 'template', 'reply_to', 'modified', 'title', 'sections', 'profile',
            'options_identity', 'options_security', 'recipients']) {
        assert.ok(field in draft, `draft is missing "${field}"`)
    }
    for (const field of ['sender_name', 'invite_image', 'invite_tmpl_email',
            'invite_tmpl_clipboard', 'invite_button']) {
        assert.ok(field in (draft.options_identity as object), `options_identity lacks "${field}"`)
    }
})

test('the profile id is attached when given, and left null when not', () => {
    const attached = build_export(sample_newsletter(), [], [], {profile_id: 'profile-1'})
    assert.equal(attached.database.tables.drafts![0]!.profile, 'profile-1')

    const unattached = build_export(sample_newsletter(), [], [])
    assert.equal(unattached.database.tables.drafts![0]!.profile, null)
})

test('a group record maps partners onto Stello\'s contacts field', () => {
    const group: PartnerGroup = {id: 'g1', name: 'Prayer Team', partners: ['p1', 'p2']}
    assert.deepEqual(group_to_record(group), {
        id: 'g1', name: 'Prayer Team', contacts: ['p1', 'p2'],
        service_account: null, service_id: null,
    })
})

test('a full import with partners and groups lands every record', () => {
    const partners: Partner[] = [
        new_partner('Robert Smith', 'bob@example.org'),
        new_partner('Jane Doe', 'jane@example.org'),
    ]
    const group: PartnerGroup = {
        id: generate_token(), name: 'Monthly Supporters', partners: partners.map(p => p.id),
    }
    const newsletter = sample_newsletter({
        audience: {
            include_groups: [group.id], include_partners: [],
            exclude_groups: [], exclude_partners: [],
        },
    })

    const {database} = build_export(newsletter, partners, [group], {
        include_partners: true, include_groups: true,
    })
    const db = empty_db()
    const result = replay_stello_import(db, database)

    assert.equal(result.skipped, 0)
    assert.equal(db.contacts!.size, 2)
    assert.equal(db.groups!.size, 1)
    assert.equal(db.drafts!.size, 1)
    assert.equal(db.sections!.size, 1)

    // The draft's group id resolves against a group that was imported alongside it.
    const draft = db.drafts!.get(newsletter.id) as {recipients: {include_groups: string[]}}
    assert.ok(db.groups!.has(draft.recipients.include_groups[0]!))
})

test('dates are written as ISO strings and revive as Dates on import', () => {
    const partner = new_partner('Robert Smith', 'bob@example.org')
    const {database} = build_export(sample_newsletter(), [partner], [], {include_partners: true})

    assert.equal(typeof database.tables.drafts![0]!.modified, 'string')
    assert.equal(typeof database.tables.contacts![0]!.created, 'string')

    const db = empty_db()
    replay_stello_import(db, JSON.parse(JSON.stringify(database)) as ExportedDatabase)

    const draft = db.drafts!.values().next().value as {modified: Date}
    const contact = db.contacts!.values().next().value as {created: Date}
    assert.ok(draft.modified instanceof Date)
    assert.ok(contact.created instanceof Date)
    assert.ok(!Number.isNaN(draft.modified.getTime()))
})
