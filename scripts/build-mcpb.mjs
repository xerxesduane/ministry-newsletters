// Packs Epistle as a .mcpb bundle — the file a user installs by double-clicking, with no
// Node install, no terminal and no hand-edited JSON.
//
// The bundle has to be self-contained: Claude Desktop supplies a Node runtime but not our
// dependencies, so production deps are installed into the staging directory and shipped inside
// the archive. Tests, sources and devDependencies are left out.

import {spawn} from 'node:child_process'
import {execFileSync} from 'node:child_process'
import {mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, existsSync} from 'node:fs'
import {join, dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const staging = join(root, 'build', 'mcpb')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))

const run = (cmd, args, opts = {}) =>
    execFileSync(cmd, args, {stdio: 'inherit', shell: process.platform === 'win32', ...opts})

/**
 * Ask the built server what tools it has, so the manifest's list cannot drift from reality.
 *
 * The alternative is maintaining 30-odd names by hand in a second place, which would be wrong
 * within a release or two — and this list is what the install dialog shows the user.
 */
function read_tools() {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [join(root, 'dist', 'src', 'index.js')], {
            env: {...process.env, EPISTLE_DIR: mkdtempSync(join(tmpdir(), 'epistle-manifest-'))},
            stdio: ['pipe', 'pipe', 'ignore'],
        })
        let out = ''
        const timer = setTimeout(() => {
            child.kill()
            reject(new Error('timed out asking the server for its tool list'))
        }, 30_000)

        child.stdout.on('data', buf => {
            out += buf
            for (const line of out.split('\n')) {
                if (!line.trim()) continue
                let msg
                try {
                    msg = JSON.parse(line)
                } catch {
                    continue
                }
                if (msg.id === 2 && msg.result?.tools) {
                    clearTimeout(timer)
                    child.kill()
                    resolve(msg.result.tools.map(t => ({
                        name: t.name,
                        description: (t.description ?? '').split('. ')[0].slice(0, 200),
                    })))
                }
            }
        })
        child.on('error', reject)

        const send = obj => child.stdin.write(JSON.stringify(obj) + '\n')
        send({jsonrpc: '2.0', id: 1, method: 'initialize', params: {
            protocolVersion: '2024-11-05', capabilities: {},
            clientInfo: {name: 'build-mcpb', version: pkg.version},
        }})
        send({jsonrpc: '2.0', method: 'notifications/initialized'})
        send({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}})
    })
}

console.log('building...')
run('npm', ['run', 'build'], {cwd: root})

if (!existsSync(join(root, 'icon.png'))) {
    run(process.execPath, [join(root, 'scripts', 'make-icon.mjs')], {cwd: root})
}

console.log('reading tool list from the built server...')
const tools = await read_tools()
console.log(`  ${tools.length} tools`)

rmSync(staging, {recursive: true, force: true})
mkdirSync(staging, {recursive: true})

// A minimal package.json so npm installs only what the server needs at runtime. The real one
// carries a `prepare` script that would recompile, and devDependencies we do not want shipped.
writeFileSync(join(staging, 'package.json'), JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    type: 'module',
    private: true,
    dependencies: pkg.dependencies,
}, null, 2) + '\n')

console.log('installing production dependencies into the bundle...')
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'], {cwd: staging})

cpSync(join(root, 'dist', 'src'), join(staging, 'dist', 'src'), {recursive: true})
for (const file of ['icon.png', 'README.md', 'LICENSE']) {
    cpSync(join(root, file), join(staging, file))
}

writeFileSync(join(staging, 'manifest.json'),
    JSON.stringify({...manifest, version: pkg.version, tools}, null, 2) + '\n')

const output = join(root, 'build', `epistle-${pkg.version}.mcpb`)
run('mcpb', ['pack', staging, output], {cwd: root})
console.log(`\n${output}`)
