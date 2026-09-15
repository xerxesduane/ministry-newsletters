// Tests for the HTTP transport and the command line.
//
// The security behaviour here is the part that matters: this endpoint can read the partner list
// and send email, so the tests cover what it refuses as much as what it serves.

import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {Server} from 'node:http'

import {start_http, is_loopback} from '../src/http.js'
import {parse_args, resolve_token} from '../src/cli.js'
import {Store} from '../src/store.js'

/** Start a server on an ephemeral port against a throwaway workspace. */
async function serve(options: {token?: string | null, host?: string} = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'ep-http-'))
    const {server, url} = await start_http({
        host: options.host ?? '127.0.0.1',
        port: 0,
        token: options.token ?? null,
        store: new Store(join(dir, 'store.json')),
    })
    const port = (server.address() as {port: number}).port
    return {
        server,
        base: `http://127.0.0.1:${port}`,
        url,
        close: () => {
            server.close()
            rmSync(dir, {recursive: true, force: true})
        },
    }
}

/** Send a JSON-RPC request the way an MCP client would. */
async function rpc(base: string, body: unknown, token?: string): Promise<Response> {
    return fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            // MCP's Streamable HTTP requires the client to accept both.
            'Accept': 'application/json, text/event-stream',
            ...(token ? {Authorization: `Bearer ${token}`} : {}),
        },
        body: JSON.stringify(body),
    })
}

const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: {name: 'test', version: '0'},
    },
}

test('an agent can initialize over HTTP and reach the tools', async () => {
    const s = await serve()
    try {
        const res = await rpc(s.base, INITIALIZE)
        assert.equal(res.status, 200)
        const body = await res.json() as {result: {serverInfo: {name: string}}}
        assert.equal(body.result.serverInfo.name, 'epistle')
    } finally {
        s.close()
    }
})

test('tools/list returns the same surface as the stdio transport', async () => {
    const s = await serve()
    try {
        await rpc(s.base, INITIALIZE)
        const res = await rpc(s.base, {jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}})
        const body = await res.json() as {result: {tools: {name: string}[]}}
        const names = body.result.tools.map(t => t.name)

        assert.ok(names.includes('newsletter_create'))
        assert.ok(names.includes('stello_export'))
        assert.ok(names.includes('email_send'))
        assert.ok(names.length > 20)
    } finally {
        s.close()
    }
})

test('a tool call works end to end over HTTP', async () => {
    const s = await serve()
    try {
        await rpc(s.base, INITIALIZE)
        const res = await rpc(s.base, {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {name: 'newsletter_create', arguments: {title: 'Over HTTP'}},
        })
        const body = await res.json() as {result: {content: {text: string}[]}}
        assert.match(body.result.content[0]!.text, /Created newsletter "Over HTTP"/)
    } finally {
        s.close()
    }
})

test('state persists across requests, so one workspace is shared', async () => {
    const s = await serve()
    try {
        await rpc(s.base, INITIALIZE)
        await rpc(s.base, {
            jsonrpc: '2.0', id: 3, method: 'tools/call',
            params: {name: 'newsletter_create', arguments: {title: 'Remembered'}},
        })
        const res = await rpc(s.base, {
            jsonrpc: '2.0', id: 4, method: 'tools/call',
            params: {name: 'newsletter_list', arguments: {}},
        })
        const body = await res.json() as {result: {content: {text: string}[]}}
        assert.match(body.result.content[0]!.text, /Remembered/)
    } finally {
        s.close()
    }
})

test('the health endpoint answers without a token', async () => {
    const s = await serve({token: 'secret-value'})
    try {
        const res = await fetch(`${s.base}/health`)
        assert.equal(res.status, 200)
        assert.deepEqual(await res.json(), {status: 'ok', name: 'epistle'})
    } finally {
        s.close()
    }
})

test('a token, when set, is required', async () => {
    const s = await serve({token: 'secret-value'})
    try {
        const without = await rpc(s.base, INITIALIZE)
        assert.equal(without.status, 401)

        const wrong = await rpc(s.base, INITIALIZE, 'not-the-token')
        assert.equal(wrong.status, 401)

        const right = await rpc(s.base, INITIALIZE, 'secret-value')
        assert.equal(right.status, 200)
    } finally {
        s.close()
    }
})

test('a wrong token of a different length is rejected, not crashed on', async () => {
    const s = await serve({token: 'secret-value'})
    try {
        for (const attempt of ['', 'x', 'secret-value-but-longer', 'SECRET-VALUE']) {
            const res = await rpc(s.base, INITIALIZE, attempt)
            assert.equal(res.status, 401, `should reject ${JSON.stringify(attempt)}`)
        }
    } finally {
        s.close()
    }
})

test('an unknown path is refused rather than falling through to the tools', async () => {
    const s = await serve()
    try {
        const res = await fetch(`${s.base}/admin`)
        assert.equal(res.status, 404)
    } finally {
        s.close()
    }
})

test('binding beyond this computer without a token is refused', async () => {
    await assert.rejects(
        start_http({host: '0.0.0.0', port: 0, token: null}),
        /Refusing to listen/)
})

test('binding beyond this computer is allowed once a token is set', async () => {
    let server: Server | undefined
    try {
        const started = await start_http({host: '0.0.0.0', port: 0, token: 'a-real-token'})
        server = started.server
        assert.ok(started.url.includes('0.0.0.0'))
    } finally {
        server?.close()
    }
})

test('loopback addresses are recognised, and others are not', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
        assert.equal(is_loopback(host), true, `${host} should be loopback`)
    }
    for (const host of ['0.0.0.0', '192.168.1.5', '::', 'example.org', '10.0.0.1']) {
        assert.equal(is_loopback(host), false, `${host} should not be loopback`)
    }
})

// Command line

test('no arguments means stdio, for Claude Desktop', () => {
    assert.equal(parse_args([]).mode, 'stdio')
})

test('--http switches transport, with sensible defaults', () => {
    const parsed = parse_args(['--http'])
    assert.equal(parsed.mode, 'http')
    assert.equal(parsed.host, '127.0.0.1')
    assert.equal(parsed.port, 8765)
})

test('host, port and token are read from the command line', () => {
    const parsed = parse_args(['--http', '--port', '9000', '--host', '0.0.0.0', '--token', 'abc'])
    assert.equal(parsed.port, 9000)
    assert.equal(parsed.host, '0.0.0.0')
    assert.equal(parsed.token, 'abc')
})

test('help and version short-circuit everything else', () => {
    assert.equal(parse_args(['--help']).mode, 'help')
    assert.equal(parse_args(['-h']).mode, 'help')
    assert.equal(parse_args(['--version']).mode, 'version')
    assert.equal(parse_args(['--http', '--help']).mode, 'help')
})

test('a bad port is reported rather than silently defaulted', () => {
    for (const bad of ['0', '-1', '99999', 'abc']) {
        const parsed = parse_args(['--http', '--port', bad])
        assert.equal(parsed.mode, 'error', `--port ${bad} should be an error`)
        assert.match(parsed.message!, /--port/)
    }
})

test('an unknown option is reported with a pointer to --help', () => {
    const parsed = parse_args(['--senditnow'])
    assert.equal(parsed.mode, 'error')
    assert.match(parsed.message!, /Unknown option/)
    assert.match(parsed.message!, /--help/)
})

test('a token is generated when binding beyond this computer without one', () => {
    const resolved = resolve_token(parse_args(['--http', '--host', '0.0.0.0']), false)
    assert.ok(resolved.token)
    assert.equal(resolved.token_generated, true)
    assert.ok(resolved.token!.length >= 32)
})

test('a supplied token is kept as given, and loopback needs none', () => {
    const supplied = resolve_token(parse_args(['--http', '--token', 'mine']), false)
    assert.equal(supplied.token, 'mine')
    assert.equal(supplied.token_generated, false)

    const local = resolve_token(parse_args(['--http']), true)
    assert.equal(local.token, null)
})
