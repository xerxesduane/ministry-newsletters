// End-to-end test: start the real server over stdio and drive it as a client would.
//
// Everything else tests modules in isolation. This exercises the actual wire protocol — tool
// registration, argument validation, and the full path from "create a newsletter" to a handoff
// file on disk — so a broken tool schema or a bad registration is caught here rather than by the
// user. It writes to a temp directory, never the real workspace.

import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync, existsSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'

import type {ExportedDatabase} from '../src/stello/records.js'

const SERVER = fileURLToPath(new URL('../src/index.js', import.meta.url))

/** Start the server against a throwaway workspace, and hand back a connected client. */
async function connect(): Promise<{client: Client, dir: string, close: () => Promise<void>}> {
    const dir = mkdtempSync(join(tmpdir(), 'mn-e2e-'))
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER],
        env: {
            ...process.env as Record<string, string>,
            EPISTLE_DIR: dir,
            // Point Stello discovery at a folder that does not exist, so the test never reads or
            // writes a real Stello installation on the machine running it.
            STELLO_FILES_DIR: join(dir, 'no-stello-here'),
        },
    })
    const client = new Client({name: 'test', version: '0'})
    await client.connect(transport)
    return {
        client,
        dir,
        close: async () => {
            await client.close()
            rmSync(dir, {recursive: true, force: true})
        },
    }
}

/** Call a tool and return its text, failing the test if the tool reported an error. */
async function call(client: Client, name: string, args: Record<string, unknown> = {})
        : Promise<string> {
    const result = await client.callTool({name, arguments: args})
    const body = (result.content as {type: string, text?: string}[])
        .map(part => part.text ?? '').join('\n')
    assert.ok(!result.isError, `${name} failed: ${body}`)
    return body
}

/** Call a tool expecting it to refuse, and return the refusal text. */
async function call_expecting_error(client: Client, name: string,
        args: Record<string, unknown> = {}): Promise<string> {
    const result = await client.callTool({name, arguments: args})
    const body = (result.content as {type: string, text?: string}[])
        .map(part => part.text ?? '').join('\n')
    assert.ok(result.isError, `${name} was expected to refuse but succeeded: ${body}`)
    return body
}

test('the server starts and advertises its tools', async () => {
    const {client, close} = await connect()
    try {
        const {tools} = await client.listTools()
        const names = tools.map(t => t.name)

        for (const expected of ['newsletter_create', 'newsletter_add_text', 'newsletter_preview',
                'partners_add', 'newsletter_set_audience', 'stello_export', 'stello_status',
                'email_send']) {
            assert.ok(names.includes(expected), `missing tool: ${expected}`)
        }
        // Every tool needs a description, or the model cannot choose between them.
        for (const tool of tools) {
            assert.ok(tool.description && tool.description.length > 20,
                `${tool.name} needs a real description`)
        }
    } finally {
        await close()
    }
})

test('the irreversible tools are marked as such', async () => {
    const {client, close} = await connect()
    try {
        const {tools} = await client.listTools()
        const by_name = Object.fromEntries(tools.map(t => [t.name, t]))

        assert.equal(by_name['email_send']!.annotations?.destructiveHint, true)
        assert.equal(by_name['email_send']!.annotations?.openWorldHint, true)
        assert.equal(by_name['newsletter_delete']!.annotations?.destructiveHint, true)
        // Reading tools must not be flagged as destructive, or clients over-prompt.
        assert.equal(by_name['newsletter_list']!.annotations?.readOnlyHint, true)
        assert.equal(by_name['stello_status']!.annotations?.readOnlyHint, true)
    } finally {
        await close()
    }
})

test('a newsletter can be written, addressed and handed to Stello', async () => {
    const {client, dir, close} = await connect()
    try {
        // Write it.
        const created = await call(client, 'newsletter_create', {
            title: 'October Ministry Update',
            sender_name: 'Pastor Adona',
        })
        const id = /id: (\S+)/.exec(created)![1]!

        await call(client, 'newsletter_add_text', {
            id,
            markdown: '## Thank you\n\nDear {{contact_hello}}, thank you for your partnership.',
        })
        await call(client, 'newsletter_add_chart', {
            id,
            title: 'Building fund',
            values: [
                {label: 'September', number: '$4,250'},
                {label: 'October', number: '$6,100'},
            ],
            threshold: '$10,000',
        })
        await call(client, 'newsletter_add_video', {
            id,
            video: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            caption: 'Our vision for the year',
        })

        // Add partners and a group.
        await call(client, 'partners_add', {
            partners: [
                {name: 'Robert Smith', address: 'bob@example.org', name_hello: 'Bob'},
                {name: 'Jane Doe', address: 'jane@example.org'},
            ],
            group: 'Monthly Supporters',
        })

        // Address it.
        const addressed = await call(client, 'newsletter_set_audience', {
            id,
            include_groups: ['Monthly Supporters'],
        })
        assert.match(addressed, /Audience: 2 partner\(s\)/)

        // Preview it.
        const preview = await call(client, 'newsletter_preview', {id})
        const preview_path = /(\S*preview-\S+\.html)/.exec(preview)![1]!
        assert.ok(existsSync(preview_path))
        const page = readFileSync(preview_path, 'utf8')
        assert.match(page, /October Ministry Update/)
        assert.match(page, /Building fund/)

        // Hand it to Stello.
        const exported = await call(client, 'stello_export', {id, include_partners: true,
            include_groups: true})
        assert.match(exported, /Settings -> Backup/)
        const export_path = /(\S*stello-import-\S+\.json)/.exec(exported)![1]!
        assert.ok(existsSync(export_path))

        const database = JSON.parse(readFileSync(export_path, 'utf8')) as ExportedDatabase
        assert.equal(database.version, 1)
        assert.equal(database.tables.drafts!.length, 1)
        assert.equal(database.tables.sections!.length, 3)
        assert.equal(database.tables.contacts!.length, 2)
        assert.equal(database.tables.groups!.length, 1)
        assert.equal(database.tables.drafts![0]!.title, 'October Ministry Update')

        // The draft's recipients resolve against the group shipped alongside it.
        const group_id = database.tables.groups![0]!.id
        assert.deepEqual(database.tables.drafts![0]!.recipients.include_groups, [group_id])

        // State survives a restart, since it is on disk rather than in memory.
        assert.ok(existsSync(join(dir, 'store.json')))
    } finally {
        await close()
    }
})

test('the store persists across server restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mn-e2e-'))
    const spawn = async () => {
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [SERVER],
            env: {
                ...process.env as Record<string, string>,
                EPISTLE_DIR: dir,
                STELLO_FILES_DIR: join(dir, 'no-stello-here'),
            },
        })
        const client = new Client({name: 'test', version: '0'})
        await client.connect(transport)
        return client
    }
    try {
        const first = await spawn()
        await call(first, 'newsletter_create', {title: 'Persisted'})
        await first.close()

        const second = await spawn()
        const listed = await call(second, 'newsletter_list')
        assert.match(listed, /Persisted/)
        await second.close()
    } finally {
        rmSync(dir, {recursive: true, force: true})
    }
})

test('a bad newsletter id gives a message naming what does exist', async () => {
    const {client, close} = await connect()
    try {
        await call(client, 'newsletter_create', {title: 'Real One'})
        const error = await call_expecting_error(client, 'newsletter_get', {id: 'not-an-id'})
        assert.match(error, /No newsletter with id/)
        assert.match(error, /Real One/)
    } finally {
        await close()
    }
})

test('exporting an empty newsletter is refused', async () => {
    const {client, close} = await connect()
    try {
        const created = await call(client, 'newsletter_create', {title: 'Empty'})
        const id = /id: (\S+)/.exec(created)![1]!
        const error = await call_expecting_error(client, 'stello_export', {id})
        assert.match(error, /no content yet/)
    } finally {
        await close()
    }
})

test('sending is refused when email is not configured, and says how to configure it', async () => {
    const {client, close} = await connect()
    try {
        const created = await call(client, 'newsletter_create', {title: 'Test'})
        const id = /id: (\S+)/.exec(created)![1]!
        await call(client, 'newsletter_add_text', {id, markdown: 'Hello'})

        const error = await call_expecting_error(client, 'email_send',
            {id, dry_run: true, confirm_recipients: 0})
        assert.match(error, /EPISTLE_SMTP_HOST/)
        assert.match(error, /stello_export/)
    } finally {
        await close()
    }
})

test('a duplicate partner is skipped rather than added twice', async () => {
    const {client, close} = await connect()
    try {
        await call(client, 'partners_add', {
            partners: [{name: 'Robert Smith', address: 'bob@example.org'}],
        })
        const again = await call(client, 'partners_add', {
            partners: [{name: 'Robert Smith', address: 'BOB@example.org'}],
        })
        assert.match(again, /Added 0 partner/)
        assert.match(again, /Skipped 1/)

        const listed = await call(client, 'partners_list')
        assert.match(listed, /1 partner\(s\)/)
    } finally {
        await close()
    }
})

test('an invalid email address is reported rather than stored', async () => {
    const {client, close} = await connect()
    try {
        const result = await call(client, 'partners_add', {
            partners: [
                {name: 'Good', address: 'good@example.org'},
                {name: 'Bad', address: 'not-an-email'},
            ],
        })
        assert.match(result, /Added 1 partner/)
        assert.match(result, /Not a valid email address/)
    } finally {
        await close()
    }
})

test('HTML brought in from elsewhere is stripped of anything unsafe', async () => {
    const {client, close} = await connect()
    try {
        const created = await call(client, 'newsletter_create', {title: 'Imported'})
        const id = /id: (\S+)/.exec(created)![1]!

        await call(client, 'newsletter_add_html', {
            id,
            html: '<p onclick="steal()">Hello</p><script>alert(1)</script>'
                + '<a href="javascript:alert(2)">click</a>',
        })

        await call(client, 'newsletter_set_audience', {id})
        const exported = await call(client, 'stello_export', {id})
        const path = /(\S*stello-import-\S+\.json)/.exec(exported)![1]!
        const database = JSON.parse(readFileSync(path, 'utf8')) as ExportedDatabase
        const html = (database.tables.sections![0]!.content as {html: string}).html

        assert.equal(html, '<p>Hello</p>click')
        assert.ok(!html.includes('script'))
        assert.ok(!html.includes('onclick'))
        assert.ok(!html.includes('javascript'))
    } finally {
        await close()
    }
})

test('stello_status reports honestly when Stello is not installed', async () => {
    const {client, close} = await connect()
    try {
        const status = await call(client, 'stello_status')
        assert.match(status, /Stello Files: not found/)
        assert.match(status, /Not configured/)
    } finally {
        await close()
    }
})

test('sections can be reordered and removed', async () => {
    const {client, close} = await connect()
    try {
        const created = await call(client, 'newsletter_create', {title: 'Ordering'})
        const id = /id: (\S+)/.exec(created)![1]!

        const first = await call(client, 'newsletter_add_text', {id, markdown: 'First'})
        await call(client, 'newsletter_add_text', {id, markdown: 'Second'})
        const first_id = /section id: (\S+)/.exec(first)![1]!

        await call(client, 'newsletter_move_section', {id, section_id: first_id, position: 2})
        let body = await call(client, 'newsletter_get', {id})
        assert.match(body, /1\. \[\S+\] text: Second/)

        await call(client, 'newsletter_remove_section', {id, section_id: first_id})
        body = await call(client, 'newsletter_get', {id})
        assert.ok(!body.includes(first_id))
    } finally {
        await close()
    }
})
