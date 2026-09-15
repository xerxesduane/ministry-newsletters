// Assemble the Epistle MCP server.

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'

import {Store} from './store.js'
import {register_newsletter_tools} from './tools/newsletters.js'
import {register_partner_tools} from './tools/partners.js'
import {register_stello_tools} from './tools/stello.js'
import {register_email_tools} from './tools/email.js'

/** Guidance the client shows the model alongside the tool list. */
const INSTRUCTIONS = `
Write and deliver ministry newsletters to partners.

A typical flow:
  1. stello_status — see what is set up on this machine
  2. partners_import_from_stello or partners_import_csv — bring in the partner list
  3. newsletter_create, then newsletter_add_text / _add_images / _add_video / _add_chart
  4. newsletter_set_audience — choose who receives it
  5. newsletter_preview — render it and show the user before anything goes out
  6. Deliver it, one of two ways:
       stello_export — writes a file the user imports into Stello, reviews, and sends. Encrypted
         end to end, can expire and be retracted. Prefer this when Stello is set up.
       email_send — sends it directly as ordinary email. Run it with dry_run first, show the
         user the recipient list, and only send for real once they approve.

Two rules worth keeping:
  - Never send to real partners without showing the user the content and the recipient list first.
  - A newsletter carries someone's ministry voice. Write in the user's own words and tone; ask
    them for the facts rather than inventing ministry details, numbers or testimonies.
`.trim()

export function build_server(store: Store = new Store()): McpServer {
    const server = new McpServer({
        name: 'epistle',
        version: '0.1.0',
    }, {
        instructions: INSTRUCTIONS,
    })

    register_newsletter_tools(server, store)
    register_partner_tools(server, store)
    register_stello_tools(server, store)
    register_email_tools(server, store)

    return server
}
