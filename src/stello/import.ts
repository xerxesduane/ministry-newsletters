// Read an existing Stello backup so the connector can line up with the user's real account.
//
// Stello writes `Stello Files/Backups [<dbid>]/database.json` (app/src/services/backup/generic.ts
// -> run_database_backup). Reading it lets us reuse the user's real contact ids and profile id,
// so a handoff file adds a draft to their existing account instead of duplicating their contacts.
//
// This is read-only. The connector never writes to Stello's database or its backup folders.

import {readFileSync, existsSync, readdirSync, statSync} from 'node:fs'
import {join} from 'node:path'

import {find_stello_files, env_value} from '../config.js'
import type {Partner, PartnerGroup} from '../types.js'

interface RawBackup {
    version?: number
    dbid?: string
    tables?: {
        contacts?: {id: string, created: string, name: string, name_hello: string, address: string,
            notes: string, service_account: string | null, multiple: boolean}[]
        groups?: {id: string, name: string, contacts: string[], service_account: string | null}[]
        profiles?: {id: string, email: string, msg_options_identity?: {sender_name?: string}}[]
    }
}

export interface StelloSnapshot {
    /** Where the backup file was read from. */
    source: string
    dbid: string | null
    /** Sending accounts configured in Stello. The first is used as the default. */
    profiles: {id: string, email: string, sender_name: string}[]
    contacts: Partner[]
    groups: PartnerGroup[]
}

/** Find Stello's most recent database backup, if the user has one. */
export function find_backup_file(): string | null {
    const explicit = env_value('STELLO_BACKUP_FILE')
    if (explicit) {
        return existsSync(explicit) ? explicit : null
    }
    const files_dir = find_stello_files()
    if (!files_dir || !existsSync(files_dir)) {
        return null
    }
    // Backup folders are named `Backups [<dbid>]`; there may be several if the database was reset.
    const candidates = readdirSync(files_dir, {withFileTypes: true})
        .filter(entry => entry.isDirectory() && entry.name.startsWith('Backups ['))
        .map(entry => join(files_dir, entry.name, 'database.json'))
        .filter(path => existsSync(path))
    if (!candidates.length) {
        return null
    }
    // Most recently written wins.
    return candidates
        .map(path => ({path, mtime: mtime_of(path)}))
        .sort((a, b) => b.mtime - a.mtime)[0]!.path
}

/** Modification time, or 0 when the file cannot be stat'd. */
function mtime_of(path: string): number {
    try {
        return statSync(path).mtimeMs
    } catch {
        return 0
    }
}

/**
 * Read a Stello backup into a snapshot.
 *
 * Contacts synced from Google or Microsoft are included but flagged by Stello with a
 * `service_account`; we keep their ids so we never re-add them, but we do not claim ownership.
 */
export function read_backup(path: string): StelloSnapshot {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as RawBackup
    const tables = raw.tables ?? {}

    const contacts: Partner[] = (tables.contacts ?? []).map(contact => ({
        id: contact.id,
        name: contact.name,
        address: contact.address,
        name_hello: contact.name_hello,
        notes: contact.notes ?? '',
        multiple: contact.multiple ?? false,
        created: contact.created,
    }))

    const groups: PartnerGroup[] = (tables.groups ?? []).map(group => ({
        id: group.id,
        name: group.name,
        partners: group.contacts ?? [],
    }))

    const profiles = (tables.profiles ?? []).map(profile => ({
        id: profile.id,
        email: profile.email,
        sender_name: profile.msg_options_identity?.sender_name ?? '',
    }))

    return {source: path, dbid: raw.dbid ?? null, profiles, contacts, groups}
}

/** Read Stello's latest backup if one exists on this machine. */
export function load_snapshot(): StelloSnapshot | null {
    const path = find_backup_file()
    return path ? read_backup(path) : null
}
