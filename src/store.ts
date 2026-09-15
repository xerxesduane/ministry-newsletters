// Persistence for newsletters, partners and groups.
//
// A single JSON file, written atomically via a temp file and rename so an interrupted write can
// never truncate the user's partner list.

import {mkdirSync, readFileSync, writeFileSync, renameSync, existsSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {data_dir, store_path, exports_dir} from './config.js'
import {STORE_VERSION, type StoreData, type Newsletter, type Partner, type PartnerGroup}
    from './types.js'

function empty_store(): StoreData {
    return {version: STORE_VERSION, partners: [], groups: [], newsletters: []}
}

export class Store {

    private data: StoreData
    private readonly path: string

    constructor(path: string = store_path()) {
        this.path = path
        this.data = Store.read(path)
    }

    /** Read the store from disk, falling back to an empty one when absent. */
    private static read(path: string): StoreData {
        if (!existsSync(path)) {
            return empty_store()
        }
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoreData>
        return {
            version: parsed.version ?? STORE_VERSION,
            partners: parsed.partners ?? [],
            groups: parsed.groups ?? [],
            newsletters: parsed.newsletters ?? [],
        }
    }

    /** Write the store back to disk atomically. */
    save(): void {
        mkdirSync(dirname(this.path), {recursive: true})
        const tmp = this.path + '.tmp'
        writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
        renameSync(tmp, this.path)
    }

    // Partners

    partners(): Partner[] {
        return this.data.partners
    }

    partner(id: string): Partner | undefined {
        return this.data.partners.find(p => p.id === id)
    }

    /** Find a partner by email address, case-insensitively. */
    partner_by_address(address: string): Partner | undefined {
        const needle = address.trim().toLowerCase()
        return this.data.partners.find(p => p.address.toLowerCase() === needle)
    }

    add_partner(partner: Partner): void {
        this.data.partners.push(partner)
    }

    remove_partner(id: string): boolean {
        const index = this.data.partners.findIndex(p => p.id === id)
        if (index === -1) {
            return false
        }
        this.data.partners.splice(index, 1)
        // Drop them from every group too, so groups never reference a deleted partner.
        for (const group of this.data.groups) {
            group.partners = group.partners.filter(p => p !== id)
        }
        // And from any newsletter audience that named them directly.
        for (const newsletter of this.data.newsletters) {
            newsletter.audience.include_partners =
                newsletter.audience.include_partners.filter(p => p !== id)
            newsletter.audience.exclude_partners =
                newsletter.audience.exclude_partners.filter(p => p !== id)
        }
        return true
    }

    // Groups

    groups(): PartnerGroup[] {
        return this.data.groups
    }

    group(id: string): PartnerGroup | undefined {
        return this.data.groups.find(g => g.id === id)
    }

    /** Find a group by name, case-insensitively — how a user will refer to it. */
    group_by_name(name: string): PartnerGroup | undefined {
        const needle = name.trim().toLowerCase()
        return this.data.groups.find(g => g.name.toLowerCase() === needle)
    }

    add_group(group: PartnerGroup): void {
        this.data.groups.push(group)
    }

    remove_group(id: string): boolean {
        const index = this.data.groups.findIndex(g => g.id === id)
        if (index === -1) {
            return false
        }
        this.data.groups.splice(index, 1)
        for (const newsletter of this.data.newsletters) {
            newsletter.audience.include_groups =
                newsletter.audience.include_groups.filter(g => g !== id)
            newsletter.audience.exclude_groups =
                newsletter.audience.exclude_groups.filter(g => g !== id)
        }
        return true
    }

    // Newsletters

    newsletters(): Newsletter[] {
        return this.data.newsletters
    }

    newsletter(id: string): Newsletter | undefined {
        return this.data.newsletters.find(n => n.id === id)
    }

    add_newsletter(newsletter: Newsletter): void {
        this.data.newsletters.push(newsletter)
    }

    remove_newsletter(id: string): boolean {
        const index = this.data.newsletters.findIndex(n => n.id === id)
        if (index === -1) {
            return false
        }
        this.data.newsletters.splice(index, 1)
        return true
    }

    /** Stamp a newsletter as changed. Call after any edit so `modified` stays meaningful. */
    touch(newsletter: Newsletter): void {
        newsletter.modified = new Date().toISOString()
    }

    /** Resolve a newsletter's audience to the partners that will actually receive it. */
    resolve_audience(newsletter: Newsletter): Partner[] {
        const groups_dict: Record<string, string[]> = {
            all: this.data.partners.map(p => p.id),
        }
        for (const group of this.data.groups) {
            groups_dict[group.id] = group.partners
        }

        const ids: string[] = []
        for (const group_id of newsletter.audience.include_groups) {
            ids.push(...(groups_dict[group_id] ?? []))
        }
        for (const group_id of newsletter.audience.exclude_groups) {
            for (const partner_id of groups_dict[group_id] ?? []) {
                let at = ids.indexOf(partner_id)
                while (at !== -1) {
                    ids.splice(at, 1)
                    at = ids.indexOf(partner_id)
                }
            }
        }
        // Direct includes win over a group exclusion, matching Stello's own ordering.
        ids.push(...newsletter.audience.include_partners)
        for (const partner_id of newsletter.audience.exclude_partners) {
            let at = ids.indexOf(partner_id)
            while (at !== -1) {
                ids.splice(at, 1)
                at = ids.indexOf(partner_id)
            }
        }

        const seen = new Set<string>()
        const out: Partner[] = []
        for (const id of ids) {
            if (seen.has(id)) {
                continue
            }
            seen.add(id)
            const partner = this.partner(id)
            if (partner) {
                out.push(partner)
            }
        }
        return out
    }

    /** Directory for generated files, created on demand. */
    exports_dir(): string {
        const dir = exports_dir()
        mkdirSync(dir, {recursive: true})
        return dir
    }

    /** Absolute path for a generated file. */
    export_path(filename: string): string {
        return join(this.exports_dir(), filename)
    }

    /** Where this store lives, for reporting back to the user. */
    location(): {store: string, data_dir: string, exports: string} {
        return {store: this.path, data_dir: data_dir(), exports: exports_dir()}
    }
}
