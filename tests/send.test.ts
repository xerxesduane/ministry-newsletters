// Tests for the guards on the direct-email path and for preview rendering.
//
// The send guards are the only thing standing between a drafted newsletter and a real inbox, so
// they are tested for what they refuse as much as for what they allow.

import test from 'node:test'
import assert from 'node:assert/strict'

import {send_newsletter, RecipientCountMismatch} from '../src/email/send.js'
import {render_page, render_text, render_body, fill_variables} from '../src/stello/preview.js'
import {markdown_to_stello_html} from '../src/stello/html.js'
import {generate_token} from '../src/stello/ids.js'
import {new_partner} from '../src/stello/convert.js'
import type {SmtpConfig} from '../src/config.js'
import type {Newsletter} from '../src/types.js'

const CONFIG: SmtpConfig = {
    host: 'smtp.invalid',
    port: 587,
    starttls: true,
    user: 'sender@example.org',
    pass: 'unused-in-these-tests',
    from_address: 'sender@example.org',
    from_name: 'The Rock City Church',
    reply_to: null,
}

function newsletter(markdown = 'Hello {{contact_hello}}, thank you.'): Newsletter {
    const now = new Date().toISOString()
    return {
        id: generate_token(),
        title: 'October Update',
        status: 'draft',
        created: now,
        modified: now,
        sections: [{
            kind: 'text',
            id: generate_token(),
            markdown,
            html: markdown_to_stello_html(markdown),
            standout: null,
        }],
        audience: {
            include_groups: [], include_partners: [],
            exclude_groups: [], exclude_partners: [],
        },
        options: {sender_name: 'Pastor', invite_button: '', lifespan_days: null, max_reads: null},
        last_export: null,
        last_direct_send: null,
    }
}

test('a dry run reports the recipients and sends nothing', async () => {
    const partners = [
        new_partner('Robert Smith', 'bob@example.org'),
        new_partner('Jane Doe', 'jane@example.org'),
    ]
    const report = await send_newsletter(newsletter(), partners, CONFIG, {
        dry_run: true,
        expected_recipients: 2,
    })

    assert.equal(report.dry_run, true)
    assert.equal(report.attempted, 2)
    assert.equal(report.sent, 0)
    assert.equal(report.outcomes.length, 2)
})

test('a send is refused when the confirmed count is too low', async () => {
    const partners = [
        new_partner('A', 'a@example.org'),
        new_partner('B', 'b@example.org'),
        new_partner('C', 'c@example.org'),
    ]
    await assert.rejects(
        send_newsletter(newsletter(), partners, CONFIG,
            {dry_run: false, expected_recipients: 2}),
        RecipientCountMismatch)
})

test('a send is refused when the confirmed count is too high', async () => {
    await assert.rejects(
        send_newsletter(newsletter(), [new_partner('A', 'a@example.org')], CONFIG,
            {dry_run: false, expected_recipients: 5}),
        RecipientCountMismatch)
})

test('the count is checked even on a dry run, so a mismatch is caught early', async () => {
    await assert.rejects(
        send_newsletter(newsletter(), [new_partner('A', 'a@example.org')], CONFIG,
            {dry_run: true, expected_recipients: 99}),
        RecipientCountMismatch)
})

test('the mismatch error states both numbers, so it can be acted on', async () => {
    try {
        await send_newsletter(newsletter(), [new_partner('A', 'a@example.org')], CONFIG,
            {dry_run: false, expected_recipients: 4})
        assert.fail('should have refused')
    } catch (error) {
        assert.ok(error instanceof RecipientCountMismatch)
        assert.equal(error.expected, 4)
        assert.equal(error.actual, 1)
        assert.match(error.message, /4/)
        assert.match(error.message, /1/)
    }
})

test('an empty audience is only allowed when zero is what was confirmed', async () => {
    const report = await send_newsletter(newsletter(), [], CONFIG,
        {dry_run: true, expected_recipients: 0})
    assert.equal(report.attempted, 0)

    await assert.rejects(
        send_newsletter(newsletter(), [], CONFIG, {dry_run: false, expected_recipients: 1}),
        RecipientCountMismatch)
})

// Preview rendering

test('variables are filled with the recipient\'s details', () => {
    const partner = new_partner('Robert Smith', 'bob@example.org')
    const body = render_body(newsletter(), {
        recipient: {name: partner.name, name_hello: partner.name_hello},
    })
    assert.match(body, /Hello Robert, thank you\./)
    assert.ok(!body.includes('data-mention'))
})

test('variables fall back to a neutral greeting with no recipient', () => {
    assert.match(render_body(newsletter()), /Hello Friend/)
})

test('a recipient\'s name is escaped when substituted', () => {
    const body = render_body(newsletter(), {
        recipient: {name: 'X', name_hello: '<script>alert(1)</script>'},
    })
    assert.ok(!body.includes('<script>'))
    assert.match(body, /&lt;script&gt;/)
})

test('an unknown mention is left alone rather than blanked', () => {
    const html = '<span data-mention data-id="unknown">placeholder</span>'
    assert.equal(fill_variables(html, {contact_hello: 'Bob'}), html)
})

test('the preview page is a complete, self-contained document', () => {
    const page = render_page(newsletter())
    assert.match(page, /^<!DOCTYPE html>/)
    assert.match(page, /<title>October Update<\/title>/)
    assert.match(page, /viewport/)
    assert.ok(page.includes('</html>'))
})

test('the page title is escaped, so a title cannot break the document', () => {
    const hostile = newsletter()
    hostile.title = '</title><script>alert(1)</script>'
    const page = render_page(hostile)
    assert.ok(!page.includes('<script>alert(1)</script>'))
})

test('a plain-text alternative is produced alongside the HTML', () => {
    const text = render_text(newsletter(), {
        recipient: {name: 'Robert Smith', name_hello: 'Robert'},
    })
    assert.match(text, /October Update/)
    assert.match(text, /Hello Robert/)
    assert.ok(!text.includes('<'))
})

test('a chart renders in both the HTML and the text version', () => {
    const with_chart = newsletter()
    with_chart.sections.push({
        kind: 'chart',
        id: generate_token(),
        chart: 'bar',
        data: [
            {id: 'a', number: '$4,250', label: 'September', hue: 200},
            {id: 'b', number: '$6,100', label: 'October', hue: 40},
        ],
        threshold: '$10,000',
        title: 'Building fund',
        caption: '',
    })

    const page = render_page(with_chart)
    assert.match(page, /Building fund/)
    assert.match(page, /\$4,250/)
    assert.match(page, /Goal: \$10,000/)

    const text = render_text(with_chart)
    assert.match(text, /September: \$4,250/)
})

test('a video renders as a link in both versions', () => {
    const with_video = newsletter()
    with_video.sections.push({
        kind: 'video',
        id: generate_token(),
        format: 'iframe_youtube',
        video_id: 'dQw4w9WgXcQ',
        caption: 'Our vision',
        start: null,
        end: null,
    })

    assert.match(render_page(with_video), /youtube\.com\/watch\?v=dQw4w9WgXcQ/)
    assert.match(render_text(with_video), /Our vision: https:\/\/www\.youtube\.com/)
})

test('a chart bar is sized relative to the largest value', () => {
    const with_chart = newsletter()
    with_chart.sections = [{
        kind: 'chart',
        id: generate_token(),
        chart: 'bar',
        data: [
            {id: 'a', number: '50', label: 'Half', hue: 0},
            {id: 'b', number: '100', label: 'Full', hue: 0},
        ],
        threshold: '',
        title: 'Progress',
        caption: '',
    }]
    const page = render_page(with_chart)
    assert.match(page, /width:50%/)
    assert.match(page, /width:100%/)
})
