// Direct email delivery — the fallback path when the user is not routing through Stello.
//
// This path sends the newsletter as an ordinary HTML email from the user's own mail account. It
// gives up what Stello provides (end-to-end encryption, expiry, read tracking, reactions and
// replies) in exchange for needing no extra step. It is deliberately guarded: a send only happens
// when the caller states the recipient count it expects, so an audience that changed under it
// fails closed rather than mailing the wrong list.

import nodemailer, {type Transporter} from 'nodemailer'

import {render_page, render_text} from '../stello/preview.js'
import {escape_html} from '../stello/html.js'
import type {SmtpConfig} from '../config.js'
import type {Newsletter, Partner} from '../types.js'

export interface SendOutcome {
    address: string
    name: string
    ok: boolean
    error?: string
}

export interface SendReport {
    dry_run: boolean
    attempted: number
    sent: number
    failed: number
    outcomes: SendOutcome[]
    message_id: string
}

/** Build the transport. Kept separate so tests can inject a fake. */
export function build_transport(config: SmtpConfig): Transporter {
    return nodemailer.createTransport({
        host: config.host,
        port: config.port,
        // Implicit TLS on 465; STARTTLS upgrade on everything else.
        secure: !config.starttls,
        auth: {user: config.user, pass: config.pass},
    })
}

/** Verify the SMTP settings actually work, without sending a newsletter. */
export async function verify_transport(config: SmtpConfig): Promise<{ok: boolean, error?: string}> {
    const transport = build_transport(config)
    try {
        await transport.verify()
        return {ok: true}
    } catch (error) {
        return {ok: false, error: error instanceof Error ? error.message : String(error)}
    } finally {
        transport.close()
    }
}

/** A footer telling recipients how to stop receiving these — expected of any bulk send. */
function footer_html(config: SmtpConfig): string {
    const address = escape_html(config.reply_to ?? config.from_address)
    return `<div class="footer">You are receiving this because you partner with this ministry.`
        + ` To stop, reply to <a href="mailto:${address}">${address}</a> and ask to be removed.</div>`
}

export interface SendOptions {
    /** When true, render and report but send nothing. */
    dry_run: boolean
    /**
     * The recipient count the caller believes it is sending to.
     *
     * If the resolved audience does not match, nothing is sent. This is what stops a newsletter
     * going to a list that changed between being reviewed and being sent.
     */
    expected_recipients: number
    /** Milliseconds to pause between messages, to stay inside a provider's rate limits. */
    delay_ms?: number
}

export class RecipientCountMismatch extends Error {
    constructor(readonly expected: number, readonly actual: number) {
        super(`Refusing to send: you confirmed ${expected} recipient(s) but the audience now `
            + `resolves to ${actual}. Re-check the audience and confirm the new count.`)
        this.name = 'RecipientCountMismatch'
    }
}

/** Send a newsletter to each partner individually, personalised. */
export async function send_newsletter(newsletter: Newsletter, partners: Partner[],
        config: SmtpConfig, options: SendOptions): Promise<SendReport> {

    if (options.expected_recipients !== partners.length) {
        throw new RecipientCountMismatch(options.expected_recipients, partners.length)
    }

    // A stable id ties every copy of this send together in the user's sent folder and our store.
    const message_id = `${newsletter.id}-${Date.now().toString(36)}`
    const outcomes: SendOutcome[] = []

    if (options.dry_run) {
        return {
            dry_run: true,
            attempted: partners.length,
            sent: 0,
            failed: 0,
            outcomes: partners.map(partner => ({
                address: partner.address, name: partner.name, ok: true,
            })),
            message_id,
        }
    }

    const transport = build_transport(config)
    const delay = options.delay_ms ?? 250

    try {
        for (const partner of partners) {
            // Each recipient gets their own copy, so greetings are personal and addresses are
            // never exposed to each other (no CC/BCC pile-up).
            const context = {
                recipient: {name: partner.name, name_hello: partner.name_hello},
                sender_name: newsletter.options.sender_name || config.from_name,
                footer_html: footer_html(config),
            }
            try {
                await transport.sendMail({
                    from: {name: config.from_name, address: config.from_address},
                    to: {name: partner.name, address: partner.address},
                    ...(config.reply_to ? {replyTo: config.reply_to} : {}),
                    subject: newsletter.title,
                    html: render_page(newsletter, context),
                    text: render_text(newsletter, context),
                    headers: {
                        // Lets mail clients offer a one-click unsubscribe.
                        'List-Unsubscribe':
                            `<mailto:${config.reply_to ?? config.from_address}?subject=unsubscribe>`,
                    },
                })
                outcomes.push({address: partner.address, name: partner.name, ok: true})
            } catch (error) {
                outcomes.push({
                    address: partner.address,
                    name: partner.name,
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                })
            }
            if (delay > 0) {
                await new Promise(resolve => setTimeout(resolve, delay))
            }
        }
    } finally {
        transport.close()
    }

    return {
        dry_run: false,
        attempted: partners.length,
        sent: outcomes.filter(o => o.ok).length,
        failed: outcomes.filter(o => !o.ok).length,
        outcomes,
        message_id,
    }
}
