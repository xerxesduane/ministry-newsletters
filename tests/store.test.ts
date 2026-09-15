// Tests for id generation, persistence, and audience resolution.
//
// Audience resolution has to agree with Stello's `get_final_recipients()`
// (app/src/services/misc/recipients.ts), because the same audience is evaluated twice — here for
// the preview and the direct-email path, and again inside Stello after an import. If the two
// disagree, the user reviews one recipient list and Stello sends to another.

import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync, existsSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {Store} from '../src/store.js'
import {generate_token, buffer_to_url64, blobstore_filename} from '../src/stello/ids.js'
import {new_partner} from '../src/stello/convert.js'
import type {Newsletter} from '../src/types.js'

function temp_store(): {store: Store, dir: string} {
    const dir = mkdtempSync(join(tmpdir(), 'mn-test-'))
    return {store: new Store(join(dir, 'store.json')), dir}
}

function blank_newsletter(): Newsletter {
    const now = new Date().toISOString()
    return {
        id: generate_token(),
        title: 'Test',
        status: 'draft',
        created: now,
        modified: now,
        sections: [],
        audience: {
            include_groups: [], include_partners: [],
            exclude_groups: [], exclude_partners: [],
        },
        options: {sender_name: '', invite_button: '', lifespan_days: null, max_reads: null},
        last_export: null,
        last_direct_send: null,
    }
}

// Ids

test('a generated id matches Stello\'s token format', () => {
    const token = generate_token()
    // 15 random bytes base64-encode to exactly 20 characters with no padding.
    assert.equal(token.length, 20)
    assert.match(token, /^[A-Za-z0-9_-]{20}$/)
})

test('ids do not repeat', () => {
    const tokens = new Set(Array.from({length: 2000}, () => generate_token()))
    assert.equal(tokens.size, 2000)
})

test('url64 encoding replaces the characters Stello replaces', () => {
    // 0xff 0xff produces '//8=' in standard base64 — every substituted character at once.
    assert.equal(buffer_to_url64(new Uint8Array([0xff, 0xff])), '__8~')
    assert.equal(buffer_to_url64(new Uint8Array([0xfb, 0xff])), '-_8~')
})

test('a blobstore filename matches the shape Stello generates', () => {
    const name = blobstore_filename('webp', new Date('2026-03-09T12:00:00Z'))
    assert.match(name, /^2026_03_09_[A-Za-z0-9_-]{8}\.webp$/)
})

// Persistence

test('the store round-trips through disk', () => {
    const {store, dir} = temp_store()
    try {
        const partner = new_partner('Robert Smith', 'bob@example.org')
        store.add_partner(partner)
        store.add_newsletter(blank_newsletter())
        store.save()

        const reopened = new Store(join(dir, 'store.json'))
        assert.equal(reopened.partners().length, 1)
        assert.equal(reopened.newsletters().length, 1)
        assert.equal(reopened.partners()[0]!.address, 'bob@example.org')
    } finally {
        rmSync(dir, {recursive: true, force: true})
    }
})

test('a missing store file opens as an empty store rather than failing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mn-test-'))
    try {
        const store = new Store(join(dir, 'does-not-exist.json'))
        assert.deepEqual(store.partners(), [])
        assert.deepEqual(store.newsletters(), [])
    } finally {
        rmSync(dir, {recursive: true, force: true})
    }
})

test('saving leaves no temp file behind', () => {
    const {store, dir} = temp_store()
    try {
        store.add_partner(new_partner('A', 'a@example.org'))
        store.save()
        assert.ok(existsSync(join(dir, 'store.json')))
        assert.ok(!existsSync(join(dir, 'store.json.tmp')))
        // Readable JSON, so a user can inspect or repair it by hand.
        JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8'))
    } finally {
        rmSync(dir, {recursive: true, force: true})
    }
})

test('a partner is matched by address regardless of case', () => {
    const {store, dir} = temp_store()
    try {
        store.add_partner(new_partner('Robert Smith', 'Bob@Example.org'))
        assert.ok(store.partner_by_address('bob@example.ORG'))
    } finally {
        rmSync(dir, {recursive: true, force: true})
    }
})

test('removing a partner clears them from groups and audiences too', () => {
    const {store, dir} = temp_store()
    try {
        const partner = new_partner('Robert Smith', 'bob@example.org')
        store.add_partner(partner)
        store.add_group({id: 'g1', name: 'Team', partners: [partner.id]})

        const newsletter = blank_newsletter()
        newsletter.audience.include_partners = [partner.id]
        newsletter.audience.exclude_partners = [partner.id]
        store.add_newsletter(newsletter)

        store.remove_partner(partner.id)

        assert.deepEqual(store.group('g1')!.partners, [])
        assert.deepEqual(newsletter.audience.include_partners, [])
        assert.deepEqual(newsletter.audience.exclude_partners, [])
    } finally {
        rmSync(dir, {recursive: true, force: true})
    }
})

test('removing a group clears it from audiences but keeps its partners', () => {
    const {store, dir} = temp_store()
    try {
        const partner = new_partner('Robert Smith', 'bob@example.org')
        store.add_partner(partner)
        store.add_group({id: 'g1', name: 'Team', partners: [partner.id]})

        const newsletter = blank_newsletter()
        newsletter.audience.include_groups = ['g1']
        store.add_newsletter(newsletter)

        store.remove_group('g1')

        assert.deepEqual(newsletter.audience.include_groups, [])
        assert.equal(store.partners().length, 1)
    } finally {
        rmSync(dir, {recursive: true, force: true})
    }
})

// Audience resolution — must match Stello's get_final_recipients()

test('audience resolution follows Stello\'s include/exclude ordering', () => {
    const {store, dir} = temp_store()
    try {
        const a = new_partner('A', 'a@example.org')
        const b = new_partner('B', 'b@example.org')
        const c = new_partner('C', 'c@example.org')
        for (const partner of [a, b, c]) {
            store.add_partner(partner)
        }
        store.add_group({id: 'supporters', name: 'Supporters', partners: [a.id, b.id]})
        store.add_group({id: 'staff', name: 'Staff', partners: [b.id]})

        const newsletter = blank_newsletter()
        store.add_newsletter(newsletter)

        // A group include reaches its members.
        newsletter.audience.include_groups = ['supporters']
        assert.deepEqual(store.resolve_audience(newsletter).map(p => p.id), [a.id, b.id])

        // A group exclude removes overlapping members.
        newsletter.audience.exclude_groups = ['staff']
        assert.deepEqual(store.resolve_audience(newsletter).map(p => p.id), [a.id])

        // A direct include wins over a group exclusion, as it does upstream.
        newsletter.audience.include_partners = [b.id]
        assert.deepEqual(store.resolve_audience(newsletter).map(p => p.id), [a.id, b.id])

        // A direct exclude overrides everything.
        newsletter.audience.exclude_partners = [a.id]
        assert.deepEqual(store.resolve_audience(newsletter).map(p => p.id), [b.id])
    } finally {
        rmSync(dir, {recursive: true, force: true})
    }
})

test('the "all" group reaches every partner', () => {
    const {store, dir} = temp_store()
    try {
        for (const address of ['a@example.org', 'b@example.org', 'c@example.org']) {
            store.add_partner(new_partner(address, address))
        }
        const newsletter = blank_newsletter()
        newsletter.audience.include_groups = ['all']
        store.add_newsletter(newsletter)

        assert.equal(store.resolve_audience(newsletter).length, 3)
    } finally {
        rmSync(dir, {recursive: true, force: true})
    }
})

test('a partner in two included groups is only sent to once', () => {
    const {store, dir} = temp_store()
    try {
        const a = new_partner('A', 'a@example.org')
        store.add_partner(a)
        store.add_group({id: 'g1', name: 'One', partners: [a.id]})
        store.add_group({id: 'g2', name: 'Two', partners: [a.id]})

        const newsletter = blank_newsletter()
        newsletter.audience.include_groups = ['g1', 'g2']
        store.add_newsletter(newsletter)

        assert.equal(store.resolve_audience(newsletter).length, 1)
    } finally {
        rmSync(dir, {recursive: true, force: true})
    }
})

test('excluding a group removes a member included through two groups', () => {
    // Upstream removes every occurrence, not just the first — duplicates must not survive.
    const {store, dir} = temp_store()
    try {
        const a = new_partner('A', 'a@example.org')
        store.add_partner(a)
        store.add_group({id: 'g1', name: 'One', partners: [a.id]})
        store.add_group({id: 'g2', name: 'Two', partners: [a.id]})
        store.add_group({id: 'out', name: 'Out', partners: [a.id]})

        const newsletter = blank_newsletter()
        newsletter.audience.include_groups = ['g1', 'g2']
        newsletter.audience.exclude_groups = ['out']
        store.add_newsletter(newsletter)

        assert.deepEqual(store.resolve_audience(newsletter), [])
    } finally {
        rmSync(dir, {recursive: true, force: true})
    }
})

test('a group that no longer exists is ignored rather than throwing', () => {
    const {store, dir} = temp_store()
    try {
        const newsletter = blank_newsletter()
        newsletter.audience.include_groups = ['deleted-group']
        store.add_newsletter(newsletter)
        assert.deepEqual(store.resolve_audience(newsletter), [])
    } finally {
        rmSync(dir, {recursive: true, force: true})
    }
})

test('an empty audience resolves to nobody', () => {
    const {store, dir} = temp_store()
    try {
        store.add_partner(new_partner('A', 'a@example.org'))
        const newsletter = blank_newsletter()
        store.add_newsletter(newsletter)
        assert.deepEqual(store.resolve_audience(newsletter), [])
    } finally {
        rmSync(dir, {recursive: true, force: true})
    }
})
