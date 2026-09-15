// Put image files where Stello expects to find them.
//
// Since Stello's blobstore migration, an image section stores a FILENAME, not the image bytes
// (app/src/services/database/blobstore.ts). The file itself lives in `Stello Files/Internal Files/`.
// So to hand Stello a newsletter with images, the image file must be copied there under a name
// matching Stello's convention, and the section must reference that name.
//
// Files in that folder are written once under a unique name and never overwritten — cloud backup
// relies on that — so copying a new file in is additive and safe.

import {copyFileSync, existsSync, mkdirSync, statSync} from 'node:fs'
import {extname, join} from 'node:path'

import {blobstore_filename} from './ids.js'
import {stello_internal_files} from '../config.js'

/** Image types Stello's displayer renders. */
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'])

/** Stello resizes images on send, but a huge source file is still worth rejecting early. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

export interface BlobstoreResult {
    filename: string
    destination: string
}

export class BlobstoreUnavailable extends Error {
    constructor() {
        super("Stello's \"Internal Files\" folder was not found on this machine. "
            + 'Install and open Stello once so it creates its "Stello Files" folder, or set '
            + 'STELLO_FILES_DIR to point at it.')
        this.name = 'BlobstoreUnavailable'
    }
}

/**
 * Copy an image into Stello's blobstore and return the filename to store in the section.
 *
 * `now` is injectable so tests can assert the filename shape.
 */
export function add_image(source_path: string, now: Date = new Date()): BlobstoreResult {
    if (!existsSync(source_path)) {
        throw new Error(`Image not found: ${source_path}`)
    }

    const ext = extname(source_path).slice(1).toLowerCase()
    if (!IMAGE_EXTENSIONS.has(ext)) {
        throw new Error(`Unsupported image type ".${ext}". `
            + `Stello displays: ${[...IMAGE_EXTENSIONS].join(', ')}.`)
    }

    const size = statSync(source_path).size
    if (size > MAX_IMAGE_BYTES) {
        throw new Error(`Image is ${Math.round(size / 1024 / 1024)}MB, over the `
            + `${MAX_IMAGE_BYTES / 1024 / 1024}MB limit. Resize it before adding.`)
    }

    const internal = stello_internal_files()
    if (!internal) {
        throw new BlobstoreUnavailable()
    }

    mkdirSync(internal, {recursive: true})
    const filename = blobstore_filename(ext, now)
    const destination = join(internal, filename)
    // Stello never reuses a blobstore name, so a collision would mean our token repeated.
    if (existsSync(destination)) {
        throw new Error(`Blobstore name collision on ${filename} — retry.`)
    }
    copyFileSync(source_path, destination)
    return {filename, destination}
}

/** Whether Stello's blobstore is reachable, for reporting setup state. */
export function blobstore_available(): boolean {
    const internal = stello_internal_files()
    return Boolean(internal && existsSync(internal))
}
