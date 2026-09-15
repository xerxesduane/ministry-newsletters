// HTTP transport, so agents other than Claude Desktop can use Epistle.
//
// Claude Desktop and Claude Code speak MCP over stdio, which only works for a program running on
// the same machine. Other agents — ChatGPT among them — connect to MCP servers over HTTP instead.
// This serves the same tools over MCP's Streamable HTTP transport so both kinds of client work.
//
// Runs stateless: each request gets a fresh transport and server sharing one Store, so there are
// no sessions to track or leak. The Store is shared deliberately — two instances would each hold
// their own copy of the newsletters in memory and overwrite each other on save.

import {createServer, type IncomingMessage, type ServerResponse, type Server} from 'node:http'
import {timingSafeEqual} from 'node:crypto'
import {isIP} from 'node:net'

import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import {build_server} from './server.js'
import {Store} from './store.js'

export interface HttpOptions {
    host: string
    port: number
    /** Required in the Authorization header as `Bearer <token>`. */
    token: string | null
    store?: Store
}

/** Loopback addresses reachable only from this machine. */
export function is_loopback(host: string): boolean {
    const normalised = host.toLowerCase().replace(/^\[|\]$/g, '')
    if (normalised === 'localhost') {
        return true
    }
    if (isIP(normalised) === 4) {
        return normalised.startsWith('127.')
    }
    if (isIP(normalised) === 6) {
        return normalised === '::1' || normalised === '::ffff:127.0.0.1'
    }
    return false
}

/** Compare secrets without leaking their contents through timing. */
function token_matches(provided: string, expected: string): boolean {
    const a = Buffer.from(provided)
    const b = Buffer.from(expected)
    if (a.length !== b.length) {
        return false
    }
    return timingSafeEqual(a, b)
}

/** Read and parse a JSON request body, with a cap so a bad client cannot exhaust memory. */
async function read_json_body(req: IncomingMessage): Promise<unknown> {
    const MAX_BYTES = 8 * 1024 * 1024
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > MAX_BYTES) {
            throw new Error('Request body too large')
        }
        chunks.push(chunk as Buffer)
    }
    if (!size) {
        return undefined
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function send_json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body)
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text),
    })
    res.end(text)
}

/** A JSON-RPC shaped error, so MCP clients surface it properly rather than as a transport fault. */
function send_rpc_error(res: ServerResponse, status: number, code: number, message: string): void {
    send_json(res, status, {jsonrpc: '2.0', error: {code, message}, id: null})
}

/**
 * Start the HTTP server.
 *
 * Refuses to start when bound to a non-loopback address without a token: an open port serving
 * these tools would let anyone who can reach it read the partner list and send email.
 */
export async function start_http(options: HttpOptions): Promise<{server: Server, url: string}> {
    const {host, port, token} = options

    if (!is_loopback(host) && !token) {
        throw new Error(
            `Refusing to listen on ${host} without a token. Anyone able to reach that address `
            + 'could read your partner list and send email as you. Pass --token <secret>, or bind '
            + 'to 127.0.0.1 (the default) so only this computer can connect.')
    }

    const store = options.store ?? new Store()

    /**
     * Host headers we accept, which is what stops a web page in the user's browser reaching a
     * localhost server through a rebound DNS name.
     *
     * Computed per request rather than up front, because port 0 asks the OS to choose a port and
     * the real one is only known once the server is listening.
     */
    const allowed_hosts = (): string[] => {
        const address = http_server.address()
        const bound = typeof address === 'object' && address ? address.port : port
        return [
            `${host}:${bound}`,
            ...(is_loopback(host)
                ? [`localhost:${bound}`, `127.0.0.1:${bound}`, `[::1]:${bound}`]
                : []),
        ]
    }

    const http_server = createServer((req, res) => {
        void handle(req, res).catch((error: unknown) => {
            if (!res.headersSent) {
                send_rpc_error(res, 500, -32603,
                    error instanceof Error ? error.message : 'Internal error')
            } else {
                res.end()
            }
        })
    })

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

        // Unauthenticated liveness check, so a user can confirm the server is up.
        if (url.pathname === '/health') {
            send_json(res, 200, {status: 'ok', name: 'epistle'})
            return
        }

        if (url.pathname !== '/mcp') {
            send_rpc_error(res, 404, -32601, 'Not found. The MCP endpoint is /mcp')
            return
        }

        if (token) {
            const header = req.headers.authorization ?? ''
            const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
            if (!provided || !token_matches(provided, token)) {
                res.writeHead(401, {
                    'Content-Type': 'application/json',
                    'WWW-Authenticate': 'Bearer',
                })
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    error: {code: -32001, message: 'Unauthorized'},
                    id: null,
                }))
                return
            }
        }

        // Stateless: a fresh server and transport per request, sharing the one Store.
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
            enableDnsRebindingProtection: true,
            allowedHosts: allowed_hosts(),
        })
        const mcp = build_server(store)

        res.on('close', () => {
            void transport.close()
            void mcp.close()
        })

        await mcp.connect(transport)

        const body = req.method === 'POST' ? await read_json_body(req) : undefined
        await transport.handleRequest(req, res, body)
    }

    return new Promise((resolve, reject) => {
        http_server.once('error', reject)
        http_server.listen(port, host, () => {
            http_server.removeListener('error', reject)
            const shown = host.includes(':') ? `[${host}]` : host
            resolve({server: http_server, url: `http://${shown}:${port}/mcp`})
        })
    })
}
