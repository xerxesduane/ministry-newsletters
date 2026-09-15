// Convert this connector's newsletters into Stello database records.

import {generate_token} from './ids.js'
import type {ExportedContact, ExportedDraft, RecordGroup, RecordSection, SectionIds}
    from './records.js'
import type {Newsletter, Partner, PartnerGroup, Section} from '../types.js'

/** Anything lossy about a conversion, surfaced to the user rather than silently applied. */
export interface ConversionWarning {
    field: string
    detail: string
}

/**
 * Map a security option to Stello's representation.
 *
 * Stello stores "never expires" as `Infinity`, which JSON cannot hold — `JSON.stringify` turns it
 * into `null`, and `null` means "inherit from the profile" in a draft. So "never"/"unlimited"
 * cannot survive the handoff file and is reported as a warning instead of being faked.
 */
function security_value(value: number | 'never' | 'unlimited' | null, field: string,
        warnings: ConversionWarning[]): number | null {
    if (value === 'never' || value === 'unlimited') {
        warnings.push({
            field,
            detail: `"${value}" cannot be written to a Stello backup file, because Stello stores it`
                + ` as Infinity and JSON has no such value. The draft will inherit your Stello`
                + ` account default instead — change it on the draft in Stello if you need it.`,
        })
        return null
    }
    return value
}

/** Convert one authored section into a Stello section record. */
export function section_to_record(section: Section, warnings: ConversionWarning[]): RecordSection {
    if (section.kind === 'text') {
        return {
            id: section.id,
            respondable: null,
            content: {type: 'text', html: section.html, standout: section.standout},
        }
    }
    if (section.kind === 'images') {
        // An image only renders in Stello if its file is in the blobstore; drop any that is not.
        const usable = section.images.filter(image => image.blobstore_name)
        if (usable.length !== section.images.length) {
            warnings.push({
                field: `section ${section.id}`,
                detail: `${section.images.length - usable.length} image(s) were left out because`
                    + ` they were not copied into Stello's "Internal Files" folder.`,
            })
        }
        return {
            id: section.id,
            respondable: null,
            content: {
                type: 'images',
                images: usable.map(image => ({
                    id: image.id,
                    data: image.blobstore_name!,
                    caption: image.caption,
                })),
                crop: section.crop,
                hero: section.hero,
            },
        }
    }
    if (section.kind === 'video') {
        return {
            id: section.id,
            respondable: null,
            content: {
                type: 'video',
                format: section.format,
                id: section.video_id,
                caption: section.caption,
                start: section.start,
                end: section.end,
            },
        }
    }
    return {
        id: section.id,
        respondable: null,
        content: {
            type: 'chart',
            chart: section.chart,
            data: section.data,
            threshold: section.threshold,
            title: section.title,
            caption: section.caption,
        },
    }
}

/**
 * Convert a newsletter into a Stello draft plus its sections.
 *
 * Every section becomes its own full-width row. Stello's `SectionIds` allows two ids per row for
 * a side-by-side layout; the user can pair them up by dragging in Stello, which is easier there
 * than expressing it here.
 */
export function newsletter_to_draft(newsletter: Newsletter, profile_id: string | null,
        warnings: ConversionWarning[]): {draft: ExportedDraft, sections: RecordSection[]} {

    const sections = newsletter.sections.map(section => section_to_record(section, warnings))
    const section_ids: SectionIds = sections.map(section => [section.id])

    const draft: ExportedDraft = {
        id: newsletter.id,
        template: false,
        reply_to: null,
        modified: newsletter.modified,
        title: newsletter.title,
        sections: section_ids,
        profile: profile_id,
        options_identity: {
            sender_name: newsletter.options.sender_name,
            invite_image: null,
            // null inherits the account's invitation email template.
            invite_tmpl_email: null,
            invite_tmpl_clipboard: null,
            invite_button: newsletter.options.invite_button,
        },
        options_security: {
            lifespan: security_value(
                newsletter.options.lifespan_days, 'lifespan_days', warnings),
            max_reads: security_value(newsletter.options.max_reads, 'max_reads', warnings),
        },
        recipients: {
            include_groups: newsletter.audience.include_groups,
            include_contacts: newsletter.audience.include_partners,
            exclude_groups: newsletter.audience.exclude_groups,
            exclude_contacts: newsletter.audience.exclude_partners,
        },
    }

    return {draft, sections}
}

/** Convert a partner into a Stello contact record. */
export function partner_to_contact(partner: Partner): ExportedContact {
    return {
        id: partner.id,
        created: partner.created,
        name: partner.name,
        name_hello: partner.name_hello,
        address: partner.address,
        notes: partner.notes,
        // null marks the contact as locally owned rather than synced from Google/Microsoft,
        // so Stello will not overwrite or delete it during a contacts sync.
        service_account: null,
        service_id: null,
        multiple: partner.multiple,
    }
}

/** Convert a group into a Stello group record. */
export function group_to_record(group: PartnerGroup): RecordGroup {
    return {
        id: group.id,
        name: group.name,
        contacts: group.partners,
        service_account: null,
        service_id: null,
    }
}

/** Derive a greeting name from a full name, the way a sender naturally would. */
export function default_hello(name: string): string {
    return name.trim().split(/\s+/)[0] ?? ''
}

/** Make a new partner record with connector-managed fields filled in. */
export function new_partner(name: string, address: string, options: {
    name_hello?: string, notes?: string, multiple?: boolean,
} = {}): Partner {
    return {
        id: generate_token(),
        name: name.trim(),
        address: address.trim(),
        name_hello: options.name_hello?.trim() || default_hello(name),
        notes: options.notes ?? '',
        multiple: options.multiple ?? false,
        created: new Date().toISOString(),
    }
}
