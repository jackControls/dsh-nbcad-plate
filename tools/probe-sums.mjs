#!/usr/bin/env node
// bin/SHA256SUMS: the digests of the packed print-probe binaries. The host refuses a packed
// binary that is not listed or does not match (lib/host-utils.js verifyPackedProbe).
//   node tools/probe-sums.mjs          rewrite the manifest from the binaries in bin/
//   node tools/probe-sums.mjs --check  verify the binaries against the manifest (exit 1 on a mismatch)
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileSha256, readProbeManifest } from '../lib/host-utils.js'

const binDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin')
const entries = []
for (const platform of readdirSync(binDir).sort()) {
  const name = platform.startsWith('win32') ? 'print-probe.exe' : 'print-probe'
  const file = join(binDir, platform, name)
  try { if (!statSync(file).isFile()) continue } catch { continue }
  entries.push({ key: `${platform}/${name}`, sha256: fileSha256(file), size: statSync(file).size })
}
if (process.argv.includes('--check')) {
  const manifest = readProbeManifest(binDir) ?? new Map()
  let bad = 0
  for (const entry of entries) {
    const listed = manifest.get(entry.key)
    const ok = listed === entry.sha256
    if (!ok) bad += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${entry.key} ${entry.sha256.slice(0, 16)}… ${listed ? '' : '(not listed)'}`)
  }
  for (const key of manifest.keys()) if (!entries.some((e) => e.key === key)) { bad += 1; console.log(`FAIL ${key} listed but missing`) }
  process.exit(bad ? 1 : 0)
}
const lines = ['# sha256 of the packed print-probe binaries, one per bin/<platform>/. Rewrite with', '# `node tools/probe-sums.mjs` after copying a CI build into bin/; check with `--check`.', ...entries.map((e) => `${e.sha256}  ${e.key}`)]
writeFileSync(join(binDir, 'SHA256SUMS'), lines.join('\n') + '\n')
console.log(`wrote bin/SHA256SUMS with ${entries.length} entries`)
