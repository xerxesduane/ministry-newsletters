// Command line for Epistle.
//
// Two ways to run, because agents connect in two different ways:
//   epistle           stdio  — Claude Desktop, Claude Code, and anything else that launches a
//                              local MCP server as a child process
//   epistle --http    HTTP   — ChatGPT and other agents that connect to an MCP server by URL

import {randomBytes} from 'node:crypto'

export interface ParsedArgs {
    mode: 'stdio' | 'http' | 'help' | 'version' | 'error'
    host: string
    port: number
    token: string | null
    /** Set when the token was generated rather than supplied, so it can be printed once. */
    token_generated: boolean
    message?: string
}

const DEFAULT_PORT = 8765
const DEFAULT_HOST = '127.0.0.1'

/**
 * The path a client should launch, with separators JSON can carry unescaped.
 *
 * Windows hands us backslashes, which have to be doubled inside JSON — a quiet way to end up
 * with a config that never starts. Printing forward slashes sidesteps it; node accepts both.
 */
function entry_path(): string {
    return (process.argv[1] ?? 'dist/src/index.js').replace(/\\/g, '/')
}

export function help_text(): string {
    const entry = entry_path()
    return `
Epistle — write ministry newsletters and deliver them to partners.

USAGE
  epistle                      Run for Claude Desktop or Claude Code (stdio).
  epistle --http               Run for ChatGPT and other agents that connect by URL.
  epistle --help               Show this.
  epistle --version            Show the version.

HTTP OPTIONS
  --port <number>              Port to listen on (default ${DEFAULT_PORT}).
  --host <address>             Address to bind (default ${DEFAULT_HOST}, this computer only).
  --token <secret>             Require this token in the Authorization header.
                               Generated automatically when binding beyond this computer.

CONNECTING
  Claude Desktop — Settings > Developer > Edit Config, add this, then quit
  Claude Desktop completely and reopen it:

    {"mcpServers": {"epistle": {
       "command": "node",
       "args": ["${entry}"]
    }}}

  Claude Code:

    claude mcp add epistle -- node ${entry}

  ChatGPT and other URL-based agents — run this, then give the printed URL
  to the client as a custom MCP connector:

    node ${entry} --http

ENVIRONMENT
  EPISTLE_DIR                  Where newsletters and partners are kept
                               (default ~/.epistle).
  EPISTLE_SMTP_HOST            Mail server, e.g. smtp.gmail.com. With USER,
  EPISTLE_SMTP_PORT            PASS and the rest, enables sending email
  EPISTLE_SMTP_USER            directly instead of through Stello.
  EPISTLE_SMTP_PASS            Use an app password, never your account password.
  EPISTLE_SMTP_FROM            Address partners see.
  EPISTLE_SMTP_FROM_NAME       Name partners see.
  EPISTLE_SMTP_REPLY_TO        Where replies go.
  STELLO_FILES_DIR             Your "Stello Files" folder, if it is somewhere
                               this cannot find on its own.

Your newsletters, partners and credentials stay on this computer.
`.trim()
}

/** Parse argv (without node and script path). */
export function parse_args(argv: string[]): ParsedArgs {
    const result: ParsedArgs = {
        mode: 'stdio',
        host: DEFAULT_HOST,
        port: DEFAULT_PORT,
        token: process.env['EPISTLE_TOKEN'] ?? null,
        token_generated: false,
    }

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!
        const next = (): string | undefined => argv[++i]

        if (arg === '--help' || arg === '-h') {
            return {...result, mode: 'help'}
        }
        if (arg === '--version' || arg === '-v') {
            return {...result, mode: 'version'}
        }
        if (arg === '--http') {
            result.mode = 'http'
            continue
        }
        if (arg === '--port' || arg === '-p') {
            const value = Number(next())
            if (!Number.isInteger(value) || value < 1 || value > 65535) {
                return {...result, mode: 'error', message: `--port needs a number from 1 to 65535.`}
            }
            result.port = value
            continue
        }
        if (arg === '--host') {
            const value = next()
            if (!value) {
                return {...result, mode: 'error', message: '--host needs an address.'}
            }
            result.host = value
            continue
        }
        if (arg === '--token') {
            const value = next()
            if (!value) {
                return {...result, mode: 'error', message: '--token needs a value.'}
            }
            result.token = value
            continue
        }
        return {...result, mode: 'error', message: `Unknown option "${arg}". Try --help.`}
    }

    return result
}

/**
 * Decide the final token for an HTTP run.
 *
 * Binding beyond this computer without one would leave the partner list and the ability to send
 * email open to anyone who can reach the port, so a token is generated rather than left unset.
 */
export function resolve_token(parsed: ParsedArgs, loopback: boolean): ParsedArgs {
    if (parsed.token || loopback) {
        return parsed
    }
    return {...parsed, token: randomBytes(24).toString('base64url'), token_generated: true}
}
