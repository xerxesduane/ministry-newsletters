// Tools for the direct-email delivery path.
//
// This bypasses Stello entirely and sends the newsletter as an ordinary HTML email. It exists so
// the connector is useful before Stello is set up, and for newsletters that do not need Stello's
// encryption or interactivity. Because it reaches real people irreversibly, every send is guarded:
// a dry run by default, and a recipient count the caller must state and that must still match.

import {z} from 'zod'
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'

import {send_newsletter, verify_transport, RecipientCountMismatch} from '../email/send.js'
import {smtp_config, smtp_missing_vars} from '../config.js'
import {text, data, fail, guard} from './helpers.js'
import {require_newsletter} from './newsletters.js'
import type {Store} from '../store.js'

/** The setup instructions shown whenever SMTP is not ready. */
function smtp_help(): string {
    return [
        'Direct email is not configured. Add these to this MCP server\'s "env" in your Claude',
        'config, then restart it:',
        '',
        '  MINISTRY_SMTP_HOST      e.g. smtp.gmail.com',
        '  MINISTRY_SMTP_PORT      587 for STARTTLS, 465 for TLS (default 587)',
        '  MINISTRY_SMTP_USER      the mailbox to send from',
        '  MINISTRY_SMTP_PASS      an app password, not the account password',
        '  MINISTRY_SMTP_FROM      address partners see (defaults to the user above)',
        '  MINISTRY_SMTP_FROM_NAME e.g. "The Rock City Church"',
        '  MINISTRY_SMTP_REPLY_TO  where replies should go (optional)',
        '',
        `Currently missing: ${smtp_missing_vars().join(', ') || 'nothing'}`,
        '',
        'Alternatively, send through Stello instead — see stello_export, which needs no',
        'credentials here because Stello sends from your own email account.',
    ].join('\n')
}

export function register_email_tools(server: McpServer, store: Store): void {

    server.registerTool('email_check', {
        title: 'Test the email connection',
        description: 'Check that the direct-email settings work, without sending a newsletter. '
            + 'Connects to the mail server and authenticates.',
        inputSchema: {},
        annotations: {readOnlyHint: true, openWorldHint: true},
    }, guard(async () => {
        const config = smtp_config()
        if (!config) {
            return fail(smtp_help())
        }
        const result = await verify_transport(config)
        if (!result.ok) {
            return fail(`Could not connect as ${config.user} to ${config.host}:${config.port}.\n`
                + `${result.error}\n\nIf this is Gmail or Outlook, make sure you are using an app `
                + 'password rather than the account password.')
        }
        return data(`Connected to ${config.host}:${config.port} as ${config.user}.\n`
            + `Newsletters will be sent from "${config.from_name}" <${config.from_address}>`
            + `${config.reply_to ? `, replies to ${config.reply_to}` : ''}.`,
            {host: config.host, from: config.from_address})
    }))

    server.registerTool('email_send', {
        title: 'Email a newsletter to partners',
        description: 'Send a newsletter directly to its audience as an ordinary email, one '
            + 'personalised copy per partner. This is irreversible, so it is guarded: it does '
            + 'nothing unless dry_run is false AND confirm_recipients equals the exact number of '
            + 'partners the audience resolves to. Always run it once with dry_run true, show the '
            + 'user the recipient list, and get their approval before sending for real. Prefer '
            + 'stello_export when the user has Stello, since that path is encrypted and can be '
            + 'retracted.',
        inputSchema: {
            id: z.string().describe('Newsletter id'),
            dry_run: z.boolean().default(true)
                .describe('True lists exactly who would receive it and sends nothing. Set false '
                    + 'only after the user has seen that list and approved it.'),
            confirm_recipients: z.number().int().min(0)
                .describe('The number of partners you expect to receive this. Must match the '
                    + 'resolved audience exactly or nothing is sent.'),
            delay_ms: z.number().int().min(0).max(10000).optional()
                .describe('Pause between messages in milliseconds, to stay within the mail '
                    + 'provider\'s rate limit. Defaults to 250.'),
        },
        annotations: {
            readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
        },
    }, guard(async ({id, dry_run, confirm_recipients, delay_ms}) => {
        const newsletter = require_newsletter(store, id)
        const config = smtp_config()
        if (!config) {
            return fail(smtp_help())
        }
        if (!newsletter.sections.length) {
            return fail('This newsletter has no content yet.')
        }

        const audience = store.resolve_audience(newsletter)
        if (!audience.length) {
            return fail('No recipients. Use newsletter_set_audience to choose who receives this.')
        }

        try {
            const report = await send_newsletter(newsletter, audience, config, {
                dry_run,
                expected_recipients: confirm_recipients,
                ...(delay_ms !== undefined ? {delay_ms} : {}),
            })

            if (report.dry_run) {
                const listed = audience.slice(0, 30)
                    .map(p => `  - ${p.name} <${p.address}>`).join('\n')
                return data([
                    `DRY RUN — nothing was sent.`,
                    '',
                    `"${newsletter.title}" would go to ${audience.length} partner(s):`,
                    listed,
                    audience.length > 30 ? `  …and ${audience.length - 30} more` : '',
                    '',
                    `From: "${config.from_name}" <${config.from_address}>`,
                    '',
                    'Show this list to the user. Once they approve, call email_send again with '
                    + `dry_run: false and confirm_recipients: ${audience.length}.`,
                ].filter(Boolean).join('\n'), {
                    dry_run: true,
                    recipients: audience.length,
                    addresses: audience.map(p => p.address),
                })
            }

            newsletter.last_direct_send = {
                at: new Date().toISOString(),
                recipients: report.sent,
                message_id: report.message_id,
            }
            newsletter.status = 'sent'
            store.touch(newsletter)
            store.save()

            const failures = report.outcomes.filter(o => !o.ok)
            const lines = [
                `Sent "${newsletter.title}" to ${report.sent} of ${report.attempted} partner(s).`,
            ]
            if (failures.length) {
                lines.push('', `${failures.length} did not go through:`)
                lines.push(...failures.map(f => `  - ${f.name} <${f.address}>: ${f.error}`))
            }
            return data(lines.join('\n'), {
                sent: report.sent, failed: report.failed, message_id: report.message_id,
            })

        } catch (error) {
            if (error instanceof RecipientCountMismatch) {
                const listed = audience.map(p => `  - ${p.name} <${p.address}>`).join('\n')
                return fail(`${error.message}\n\nThe audience is now:\n${listed}`)
            }
            throw error
        }
    }))

    server.registerTool('email_send_test', {
        title: 'Send a test copy to yourself',
        description: 'Send one copy of the newsletter to a single address so it can be checked in '
            + 'a real inbox before going out to partners. Does not touch the audience.',
        inputSchema: {
            id: z.string().describe('Newsletter id'),
            address: z.string().describe('Where to send the test copy'),
            as_partner_id: z.string().optional()
                .describe('Personalise it as though it were going to this partner, to check how '
                    + 'the greeting reads'),
        },
        annotations: {
            readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
        },
    }, guard(async ({id, address, as_partner_id}) => {
        const newsletter = require_newsletter(store, id)
        const config = smtp_config()
        if (!config) {
            return fail(smtp_help())
        }
        const sample = as_partner_id ? store.partner(as_partner_id) : undefined
        if (as_partner_id && !sample) {
            return fail(`No partner with id "${as_partner_id}".`)
        }

        // A one-off recipient standing in for a real partner, so the same send path is exercised.
        const recipient = {
            id: 'test',
            name: sample?.name ?? 'Test Recipient',
            address,
            name_hello: sample?.name_hello ?? 'Friend',
            notes: '',
            multiple: false,
            created: new Date().toISOString(),
        }

        const report = await send_newsletter(newsletter, [recipient], config, {
            dry_run: false,
            expected_recipients: 1,
        })
        const outcome = report.outcomes[0]!
        return outcome.ok
            ? text(`Test copy of "${newsletter.title}" sent to ${address}.`)
            : fail(`Could not send to ${address}: ${outcome.error}`)
    }))
}
