 *
 * @returns {{ path: string, loaded: string[] }}
 */
export function loadEnvironment (file = CONFIG_FILE, env = process.env) {
  const path = resolve(dirname(file), ENVIRONMENT_FILE)
  const loaded = []
  if (!existsSync(path)) return { path, loaded }
  const lines = readFileSync(path, 'utf8').split('\n')
  for (const [i, line] of lines.entries()) {
    const text = line.trim()
    if (!text || text.startsWith('#') || text.startsWith(';')) continue
    const found = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(text)
    if (!found) {
      throw new SporeError(`${path}:${i + 1} is not KEY=value`, {
        type: 'ENVIRONMENT_INVALID',
        detail: 'one variable per line, as systemd reads it — no export, no spaces around ='
      })
    }
    const [, key, raw] = found
    const quoted = /^(["'])(.*)\1$/.exec(raw)
    if (env[key] !== undefined) continue
    env[key] = quoted ? quoted[2] : raw
    loaded.push(key)
  }
  return { path, loaded }
}

function validate (raw, file) {
  const known = [...KEYS, 'plugins', 'replyTo']
  const unknown = isRecord(raw) ? Object.keys(raw).filter(key => !known.includes(key)) : []
  if (!isRecord(raw) || unknown.length) {
    throw new SporeError(isRecord(raw) ? `${file} has ${unknown.join(', ')}, which spore does not read` : `${file} is not a JSON object`, {
      type: 'CONFIG_INVALID',
      detail: `it takes ${known.join(', ')} — remove anything else`
    })
  }
  if (raw.workspaces !== undefined && !Array.isArray(raw.workspaces)) {
    throw new SporeError(`${file} has a workspaces that is not a list`, {
      type: 'CONFIG_INVALID',
      detail: 'workspaces names the ones living outside home, as an array of paths'
    })
  }
  if (raw.home !== undefined && typeof raw.home !== 'string') {
    throw new SporeError(`${file} has a home that is not a path`, {
      type: 'CONFIG_INVALID',
      detail: 'home is the one directory workspaces are made in, as a single path'
    })
  }
  if (raw.gate !== undefined && typeof raw.gate !== 'string') {
    throw new SporeError(`${file} has a gate that is not a path`, {
      type: 'CONFIG_INVALID',
      detail: 'gate is the data socket of the mohdel gate every turn calls its models through, as a single path'
    })
  }
  if (raw.turns !== undefined && !(Number.isInteger(raw.turns) && raw.turns >= 1)) {
    throw new SporeError(`${file} has a turns that is not a count`, {
      type: 'CONFIG_INVALID',
      detail: 'turns is how many of your turns may run at once, a whole number from 1'
    })
  }
  if (raw.modelSessions !== undefined && !(Number.isInteger(raw.modelSessions) && raw.modelSessions >= 1)) {
    throw new SporeError(`${file} has a modelSessions that is not a count`, {
      type: 'CONFIG_INVALID',
      detail: 'modelSessions is how many model calls one running turn and its cells may have going at once, a whole number from 1'
    })
  }
  if (raw.homeSplit !== undefined && !(Number.isInteger(raw.homeSplit) && raw.homeSplit >= 1 && raw.homeSplit <= 8)) {
    throw new SporeError(`${file} has a homeSplit that is not a count from 1 to 8`, {
      type: 'CONFIG_INVALID',
      detail: 'homeSplit is how many of a spore\'s last characters name the directory it sits in under home, a whole number from 1 to 8'
    })
  }
  if (raw.hereSnapshots !== undefined && !(Number.isInteger(raw.hereSnapshots) && raw.hereSnapshots >= 1)) {
    throw new SporeError(`${file} has a hereSnapshots that is not a count`, {
      type: 'CONFIG_INVALID',
      detail: 'hereSnapshots is how many sessions spore here keeps a snapshot of, per spore, a whole number from 1'
    })
  }
  const allowed = (entry) => isRecord(entry) && isRecord(entry.settings) && typeof entry.version === 'string' && typeof entry.dir === 'string'
  if (raw.plugins !== undefined && !(isRecord(raw.plugins) && Object.values(raw.plugins).every(allowed))) {
    throw new SporeError(`${file} has a plugins that is not what spore plugin allow writes`, {
      type: 'CONFIG_INVALID',
      detail: 'plugins maps each allowed plugin to its settings and the copy allowed, as { "browser": { "settings": { "cdp": 9222 }, "version", "dir" } } — remove "plugins" from it, then spore plugin allow each one again'
    })
  }
  if (raw.replyTo !== undefined && !isRecord(raw.replyTo)) {
    throw new SporeError(`${file} has a replyTo that is not a map`, {
      type: 'CONFIG_INVALID',
      detail: 'replyTo maps a spore to where its answers go when what it read asked from nowhere, as { "triage": "discord:ops/1234" }'
    })
  }
  for (const [spore, place] of Object.entries(raw.replyTo ?? {})) {
    const problem = typeof place === 'string' ? native.replyToProblem(place) : `got ${JSON.stringify(place)}`
    if (problem) {
      throw new SporeError(`${file} has a replyTo for ${spore} that is not a place`, {
        type: 'CONFIG_INVALID',
        detail: problem
      })
    }
  }
  if (raw.contain !== undefined && typeof raw.contain !== 'boolean') {
    throw new SporeError(`${file} has a contain that is not true or false`, {
      type: 'CONFIG_INVALID',
      detail: 'contain says whether every turn, job and router runs in namespaces of its own, seeing only its own processes — spore config set contain on|off'
    })
  }
  if (raw.docs !== undefined && !DOCS.includes(raw.docs)) {
    throw new SporeError(`${file} has a docs that is not follow or kept`, {
      type: 'CONFIG_INVALID',
      detail: DOCS_DETAIL
    })
  }
  for (const key of DOLLARS) {
    if (raw[key] !== undefined && !(typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] > 0)) {
      throw new SporeError(`${file} has a ${key} that is not an amount`, {
        type: 'CONFIG_INVALID',
        detail: `${key} is how many dollars your spores may spend ${key === 'spendPerDay' ? 'in a day' : 'in a month'}, above zero — spore config rm ${key} for no limit`
      })
    }
  }
  for (const key of SIZES) {
