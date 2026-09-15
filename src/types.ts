// Domain types for the connector's own store.
//
// These are deliberately simpler than Stello's records: an author works in ordered sections, not
// in Stello's rows-of-one-or-two-ids structure. `src/stello/convert.ts` maps between the two.

/** A partner or supporter who receives newsletters. */
export interface Partner {
    /** Stello-compatible id, so the same id survives into Stello's contacts table. */
    id: string
    name: string
    address: string
    /** How to greet them, e.g. "Bob" for "Robert Smith". Defaults to the first name. */
    name_hello: string
    notes: string
    /** True when the address reaches several people (a shared or family inbox). */
    multiple: boolean
    created: string
}

/** A named set of partners, e.g. "Monthly Supporters" or "Prayer Team". */
export interface PartnerGroup {
    id: string
    name: string
    /** Partner ids. */
    partners: string[]
}

export interface TextSection {
    kind: 'text'
    id: string
    /** Markdown source, kept so the section stays editable here after conversion. */
    markdown: string
    /** Rendered, sanitised HTML — what Stello actually stores. */
    html: string
    standout: null | 'distinct' | 'notice' | 'important'
}

export interface ImageSection {
    kind: 'images'
    id: string
    images: {id: string, source_path: string, blobstore_name: string | null, caption: string}[]
    /** Crop to a uniform aspect ratio. */
    crop: boolean
    /** Render edge-to-edge as a banner. */
    hero: boolean
}

export interface VideoSection {
    kind: 'video'
    id: string
    format: 'iframe_youtube' | 'iframe_vimeo'
    /** The platform's video id, not the full URL. */
    video_id: string
    caption: string
    start: number | null
    end: number | null
}

export interface ChartSection {
    kind: 'chart'
    id: string
    chart: 'bar' | 'line' | 'doughnut'
    /** `number` is a display string such as "$5,000" or "42%". */
    data: {id: string, number: string, label: string, hue: number}[]
    /** A target line, e.g. a fundraising goal. Empty string for none. */
    threshold: string
    title: string
    caption: string
}

export type Section = TextSection | ImageSection | VideoSection | ChartSection

export type SectionKind = Section['kind']

/** Who a newsletter goes to, expressed over this connector's partners and groups. */
export interface Audience {
    /** Group ids, or the special value 'all' for every partner. */
    include_groups: string[]
    include_partners: string[]
    exclude_groups: string[]
    exclude_partners: string[]
}

export type NewsletterStatus = 'draft' | 'exported' | 'sent'

export interface Newsletter {
    /** Stello-compatible id, reused as the Stello draft id on export. */
    id: string
    title: string
    status: NewsletterStatus
    created: string
    modified: string
    sections: Section[]
    audience: Audience
    /** Overrides for the Stello profile defaults. Null or empty means "inherit". */
    options: {
        sender_name: string
        invite_button: string
        /** Days until the message expires. null inherits; 'never' maps to Infinity. */
        lifespan_days: number | 'never' | null
        max_reads: number | 'unlimited' | null
    }
    /** Set once exported, so the tool can report where the handoff file went. */
    last_export: {path: string, at: string} | null
    /** Set once delivered by direct email, to make repeat sends visible. */
    last_direct_send: {at: string, recipients: number, message_id: string} | null
}

/** Everything the connector persists. */
export interface StoreData {
    version: number
    partners: Partner[]
    groups: PartnerGroup[]
    newsletters: Newsletter[]
}

export const STORE_VERSION = 1
