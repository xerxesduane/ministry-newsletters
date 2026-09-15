#!/usr/bin/env node
// Entry point: serve the Epistle MCP server over stdio.

import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'

import {build_server} from './server.js'

async function main(): Promise<void> {
    const server = build_server()
    const transport = new StdioServerTransport()
    await server.connect(transport)
    // stdout carries the protocol, so any diagnostics must go to stderr.
    console.error('Epistle MCP server ready')
}

main().catch((error: unknown) => {
    console.error('Failed to start:', error)
    process.exit(1)
})
