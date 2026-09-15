// Id generation matching Stello's `generate_token()`.
//
// Source of truth: gracious-tech/stello -> app/src/services/utils/crypt.ts + utils/coding.ts
// Stello ids are url-safe base64 of random bytes, with '=' padding replaced by '~'.

import {randomBytes} from 'node:crypto'

/** Encode bytes the way Stello's `buffer_to_url64()` does. */
export function buffer_to_url64(buffer: Uint8Array): string {
    return Buffer.from(buffer).toString('base64')
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '~')
}

/**
 * Generate a Stello-compatible id.
 *
 * Defaults to 15 bytes, matching Stello, which yields a 20-character token with no padding.
 */
export function generate_token(bytes = 15): string {
    return buffer_to_url64(randomBytes(bytes))
}

/**
 * Generate a blobstore filename the way Stello's `blobstore_new()` does: `YYYY_MM_DD_<id>.<ext>`.
 *
 * `now` is injectable so tests stay deterministic.
 */
export function blobstore_filename(ext: string, now: Date = new Date()): string {
    const date = now.toISOString().slice(0, 10).replaceAll('-', '_')
    const short_id = generate_token(6)
    return `${date}_${short_id}.${ext}`
}
