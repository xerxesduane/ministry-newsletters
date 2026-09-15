#!/usr/bin/env node
// Entry point: run Epistle over stdio, or over HTTP for agents that connect by URL.

import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'

import {build_server} from './server.js'
import {parse_args, resolve_token, help_text} from './cli.js'
import {start_http, is_loopback} from './http.js'
import {VERSION} from './version.js'

async function main(): Promise<void> {
    const parsed = parse_args(process.argv.slice(2))

    if (parsed.mode === 'help') {
        console.log(help_text())
        return
    }
    if (parsed.mode === 'version') {
        console.log(VERSION)
        return
    }
    if (parsed.mode === 'error') {
        console.error(parsed.message)
        process.exitCode = 1
        return
    }

    if (parsed.mode === 'http') {
        const options = resolve_token(parsed, is_loopback(parsed.host))
        const {url} = await start_http({
            host: options.host,
            port: options.port,
            token: options.token,
        })

        console.log(`Epistle ${VERSION} is running.`)
        console.log('')
        console.log(`  MCP endpoint   ${url}`)
        if (options.token) {
            console.log(`  Access token   ${options.token}`)
            if (options.token_generated) {
                console.log('')
                console.log('  This token was generated because you bound an address beyond this')
                console.log('  computer. Give it to your agent as a Bearer token. It changes every')
                console.log('  restart — pass --token to set your own.')
            }
        } else {
            console.log('  Access         this computer only')
        }
        console.log('')
        console.log('Add that URL to your agent as a custom MCP connector. Press Ctrl+C to stop.')

        // Keep running until interrupted.
        process.on('SIGINT', () => process.exit(0))
        process.on('SIGTERM', () => process.exit(0))
        return
    }

    // stdio: the protocol owns stdout, so anything we say must go to stderr.
    const server = build_server()
    await server.connect(new StdioServerTransport())
    console.error(`Epistle ${VERSION} ready`)
}

main().catch((error: unknown) => {
    console.error('Epistle failed to start:', error instanceof Error ? error.message : error)
    process.exit(1)
})
