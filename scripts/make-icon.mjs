// Draws Epistle's icon: a letter, since that is what an epistle is.
//
// Written by hand rather than pulled from an image library — it is a few shapes, and a
// generated icon is one fewer opaque binary to take on trust in a repo people install from.

import {deflateSync} from 'node:zlib'
import {writeFileSync} from 'node:fs'

const SIZE = 512
const BG = [26, 42, 68]        // deep navy
const INK = [245, 243, 238]    // warm off-white

const crc_table = Array.from({length: 256}, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    return c >>> 0
})

function crc32(buf) {
    let c = 0xffffffff
    for (const byte of buf) {
        c = crc_table[(c ^ byte) & 0xff] ^ (c >>> 8)
    }
    return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, crc])
}

/** Distance from a point to a line segment, for strokes that end where they should. */
function dist_to_segment(px, py, ax, ay, bx, by) {
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Signed distance to a rounded rectangle: negative inside, positive outside. */
function dist_to_round_rect(px, py, x0, y0, x1, y1, r) {
    const cx = Math.max(x0 + r, Math.min(px, x1 - r))
    const cy = Math.max(y0 + r, Math.min(py, y1 - r))
    const inside = px >= x0 && px <= x1 && py >= y0 && py <= y1
    const d = Math.hypot(px - cx, py - cy) - r
    return inside && d < 0 ? d : Math.max(d, inside ? d : Math.abs(d))
}

/** Coverage of a shape at a pixel, from its signed distance — one pixel of antialiasing. */
function coverage(signed_distance) {
    return Math.max(0, Math.min(1, 0.5 - signed_distance))
}

function blend(dst, i, colour, alpha) {
    for (let c = 0; c < 3; c++) {
        dst[i + c] = Math.round(dst[i + c] * (1 - alpha) + colour[c] * alpha)
    }
    dst[i + 3] = Math.round(dst[i + 3] * (1 - alpha) + 255 * alpha)
}

const px = Buffer.alloc(SIZE * SIZE * 4, 0)

// Envelope geometry, centred with a little optical lift.
const k = SIZE / 256
const [ex0, ey0, ex1, ey1] = [52, 84, 204, 178].map(v => v * k)
const stroke = 9 * k
const apex_y = ey0 + 58 * k

for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
        const i = (y * SIZE + x) * 4
        const cx = x + 0.5
        const cy = y + 0.5

        const bg = coverage(dist_to_round_rect(cx, cy, 8 * k, 8 * k, SIZE - 8 * k, SIZE - 8 * k, 56 * k))
        if (bg > 0) {
            blend(px, i, BG, bg)
        }

        // Envelope body, drawn as an outline: inside the outer edge but not the inner one.
        const outer = dist_to_round_rect(cx, cy, ex0, ey0, ex1, ey1, 10 * k)
        const inner = dist_to_round_rect(cx, cy, ex0 + stroke, ey0 + stroke,
            ex1 - stroke, ey1 - stroke, 6 * k)
        const body = Math.min(coverage(outer), coverage(-inner))

        // The flap, as two strokes meeting at the fold.
        const flap = Math.min(
            coverage(Math.min(
                dist_to_segment(cx, cy, ex0 + 4 * k, ey0 + 4 * k, (ex0 + ex1) / 2, apex_y),
                dist_to_segment(cx, cy, (ex0 + ex1) / 2, apex_y, ex1 - 4 * k, ey0 + 4 * k),
            ) - stroke / 2),
            coverage(outer),
        )

        const ink = Math.max(body, flap)
        if (ink > 0) {
            blend(px, i, INK, ink)
        }
    }
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0
    px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8   // bit depth
ihdr[9] = 6   // RGBA

writeFileSync('icon.png', Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, {level: 9})),
    chunk('IEND', Buffer.alloc(0)),
]))
console.log(`icon.png written (${SIZE}x${SIZE})`)
