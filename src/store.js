import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Pond capacity: fish plus unhatched eggs. The shell build hard-codes 16. */
export const POND_CAPACITY = 16

/** Initial residents, one per pattern, alternating sex. */
export const INITIAL_NAMES = ['丹枫', '墨雪', '小金', '浅葱']
export const INITIAL_PATTERNS = ['kohaku', 'sanke', 'ogon', 'shusui']

/** A new clutch needs five further dialogues after the pairing dialogue. */
export const EGG_DIALOGUES = 5

/** Pairing threshold, and the level at which the body reaches its visual cap. */
export const BREEDING_LEVEL = 500

/** How many message de-dup keys are retained in the save. */
export const RECENT_ID_LIMIT = 4096

export const PATTERNS = INITIAL_PATTERNS

function initialState(capacity) {
  return {
    version: 1,
    dialogues: 0,
    eggs: [],
    recentIds: [],
    fish: INITIAL_PATTERNS.slice(0, Math.min(4, capacity)).map((pattern, index) => ({
      id: randomUUID(),
      name: INITIAL_NAMES[index],
      sex: index % 2 === 0 ? 'female' : 'male',
      pattern,
      level: 0,
      bred: false,
      generation: 1,
    })),
  }
}

const integer = (value, minimum) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
const shortId = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const pattern = value => PATTERNS.includes(value)

function validState(value, capacity) {
  if (!value || typeof value !== 'object') return false
  const s = value
  if (s.version !== 1 || !integer(s.dialogues, 0) || !Array.isArray(s.fish)
    || s.fish.length < 1 || !Array.isArray(s.eggs) || s.fish.length + s.eggs.length > capacity
    || !Array.isArray(s.recentIds) || s.recentIds.length > RECENT_ID_LIMIT
    || !s.recentIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 1600)) return false
  if (!s.fish.every(f => f && shortId(f.id) && typeof f.name === 'string' && f.name.trim().length > 0
    && Array.from(f.name).length <= 16 && (f.sex === 'female' || f.sex === 'male') && pattern(f.pattern)
    && integer(f.level, 0) && typeof f.bred === 'boolean' && integer(f.generation, 1))) return false
  const ids = new Set(s.fish.map(f => f.id))
  return ids.size === s.fish.length && s.eggs.every(e => e && shortId(e.id)
    && Array.isArray(e.parents) && e.parents.length === 2 && e.parents[0] !== e.parents[1]
    && e.parents.every(id => ids.has(id)) && integer(e.remaining, 1) && e.remaining <= EGG_DIALOGUES
    && pattern(e.pattern) && integer(e.generation, 2))
    && new Set([...ids, ...s.eggs.map(e => e.id)]).size === s.fish.length + s.eggs.length
}

/**
 * Pond ledger: the shell build's `koi-pond-store.ts` without Electron.
 *
 * Every mutation is serialized through one queue and only published to memory
 * after the atomic file replacement succeeds, so a failed write never consumes a
 * message de-dup key and never desynchronises memory from disk.
 */
export class PondStore {
  constructor(path, options = {}) {
    this.path = path
    this.capacity = Number.isSafeInteger(options.capacity) && options.capacity > 0
      ? Math.min(options.capacity, POND_CAPACITY)
      : POND_CAPACITY
    this.state = initialState(this.capacity)
    this.queue = Promise.resolve()
    this.ready = this.load()
    // A rejected load must not surface as an unhandled rejection before a caller awaits it.
    this.ready.catch(() => {})
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'))
      if (!validState(saved, this.capacity)) throw new Error('鱼塘存档格式不匹配；已保留原文件')
      this.state = saved
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await this.save(this.state)
    }
  }

  async save(state) {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path + '.tmp', JSON.stringify(state, null, 2), 'utf8')
    await rename(this.path + '.tmp', this.path)
  }

  /** Public projection: the de-dup keys never leave the host. */
  async view() {
    await this.ready
    await this.queue
    const { recentIds, ...view } = this.state
    return structuredClone(view)
  }

  mutate(update) {
    const operation = this.queue.then(async () => {
      await this.ready
      const next = structuredClone(this.state)
      if (!update(next)) return false
      await this.save(next)
      this.state = next
      return true
    })
    this.queue = operation.catch(() => {})
    return operation
  }

  /**
   * One successful main-conversation send: every koi gains a level, existing eggs
   * advance, and matured unbred opposite-sex pairs lay one egg each.
   *
   * The de-dup key is the (sessionId, requestId) pair the shell build uses, so a
   * replayed notification cannot grow the pond twice.
   */
  recordDialogue(sessionId, requestId) {
    if (!shortId(sessionId) || sessionId.length > 128 || !shortId(requestId) || requestId.length > 128) {
      return Promise.resolve(false)
    }
    const key = JSON.stringify([sessionId, requestId])
    return this.mutate(next => {
      if (next.recentIds.includes(key)) return false
      next.recentIds = [...next.recentIds, key].slice(-RECENT_ID_LIMIT)
      next.dialogues++
      for (const fish of next.fish) fish.level++
      for (const egg of next.eggs) {
        egg.remaining--
        if (egg.remaining === 0) next.fish.push({
          id: egg.id,
          name: `锦鲤 ${next.fish.length + 1}`,
          sex: Math.random() < 0.5 ? 'female' : 'male',
          pattern: egg.pattern,
          level: 0,
          bred: false,
          generation: egg.generation,
        })
      }
      next.eggs = next.eggs.filter(egg => egg.remaining > 0)
      for (const mother of next.fish.filter(f => f.sex === 'female' && f.level >= BREEDING_LEVEL && !f.bred)) {
        if (next.fish.length + next.eggs.length >= this.capacity) break
        const father = next.fish.find(f => f.sex === 'male' && f.level >= BREEDING_LEVEL && !f.bred)
        if (!father) break
        mother.bred = father.bred = true
        next.eggs.push({
          id: randomUUID(),
          parents: [mother.id, father.id],
          remaining: EGG_DIALOGUES,
          pattern: Math.random() < 0.5 ? mother.pattern : father.pattern,
          generation: Math.max(mother.generation, father.generation) + 1,
        })
      }
      return true
    })
  }

  renameFish(id, name) {
    if (typeof id !== 'string' || typeof name !== 'string' || name.trim().length === 0
      || Array.from(name.trim()).length > 16 || /[\u0000-\u001f]/u.test(name)) return Promise.resolve(false)
    return this.mutate(next => {
      const fish = next.fish.find(f => f.id === id)
      if (!fish || fish.name === name.trim()) return false
      fish.name = name.trim()
      return true
    })
  }

  async flush() {
    await this.ready
    await this.queue
  }
}
