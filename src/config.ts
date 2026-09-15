// Where the connector keeps its data, and how it finds Stello on this machine.

import {homedir, platform} from 'node:os'
import {join} from 'node:path'
import {existsSync} from 'node:fs'

/**
 * Read an environment variable, treating blank and unsubstituted values as absent.
 *
 * A .mcpb bundle declares settings the user fills in through Claude Desktop's own form, and
 * leaves `${user_config.x}` in the environment for any the user skipped. Taken literally that
 * placeholder is a non-empty string, so an unconfigured SMTP host would read as configured and
 * fail at send time instead of reporting itself as unset.
 */
export function env_value(name: string): string | undefined {
    const raw = process.env[name]?.trim()
    if (!raw || raw.startsWith('${')) {
        return undefined
    }
    return raw
}

/** Root for this connector's own data (newsletters, partners, exports). */
export function data_dir(): string {
    const override = env_value('EPISTLE_DIR')
    if (override) {
        return override
    }
    return join(homedir(), '.epistle')
}

export function store_path(): string {
    return join(data_dir(), 'store.json')
}

/** Where handoff files for Stello and rendered previews are written. */
export function exports_dir(): string {
    return join(data_dir(), 'exports')
}

/**
 * Candidate locations for the "Stello Files" folder, in the order Stello itself prefers them.
 *
 * Source of truth: gracious-tech/stello -> electron/src/utils/paths.ts, which resolves
 * `<documents>/Stello Files` by default and remembers a moved folder in an immobile config.
 */
export function stello_files_candidates(): string[] {
    const override = env_value('STELLO_FILES_DIR')
    if (override) {
        return [override]
    }
    const home = homedir()
    const candidates = [
        join(home, 'Documents', 'Stello Files'),
        join(home, 'Stello Files'),
    ]
    if (platform() === 'win32') {
        const appdata = process.env['APPDATA']
        if (appdata) {
            candidates.push(join(appdata, 'Stello Files'))
        }
    }
    if (platform() === 'darwin') {
        candidates.push(join(home, 'Library', 'Application Support', 'Stello Files'))
    }
    return candidates
}

/** The Stello Files folder if one exists on this machine, else null. */
export function find_stello_files(): string | null {
    return stello_files_candidates().find(path => existsSync(path)) ?? null
}

/** Stello's blobstore folder — where image files referenced by a section must live. */
export function stello_internal_files(): string | null {
    const files = find_stello_files()
    return files ? join(files, 'Internal Files') : null
}

/** SMTP settings for the direct-email fallback, read from the environment. */
export interface SmtpConfig {
    host: string
    port: number
    /** Upgrade a plaintext connection with STARTTLS (port 587); false means implicit TLS (465). */
    starttls: boolean
    user: string
    pass: string
    from_address: string
    from_name: string
    reply_to: string | null
}

/**
 * Read SMTP config from the environment.
 *
 * Credentials are never stored in this connector's own files — they stay in the MCP client's
 * server config, which is where the user already keeps other secrets.
 */
export function smtp_config(): SmtpConfig | null {
    const host = env_value('EPISTLE_SMTP_HOST')
    const user = env_value('EPISTLE_SMTP_USER')
    const pass = env_value('EPISTLE_SMTP_PASS')
    const from_address = env_value('EPISTLE_SMTP_FROM') || user
    if (!host || !user || !pass || !from_address) {
        return null
    }
    const port = Number(env_value('EPISTLE_SMTP_PORT') || 587)
    return {
        host,
        port,
        starttls: port !== 465,
        user,
        pass,
        from_address,
        from_name: env_value('EPISTLE_SMTP_FROM_NAME') || '',
        reply_to: env_value('EPISTLE_SMTP_REPLY_TO') || null,
    }
}

/** Which SMTP settings are missing, for an actionable error message. */
export function smtp_missing_vars(): string[] {
    const required = ['EPISTLE_SMTP_HOST', 'EPISTLE_SMTP_USER', 'EPISTLE_SMTP_PASS']
    const missing = required.filter(name => !env_value(name))
    if (!env_value('EPISTLE_SMTP_FROM') && !env_value('EPISTLE_SMTP_USER')) {
        missing.push('EPISTLE_SMTP_FROM')
    }
    return missing
}
