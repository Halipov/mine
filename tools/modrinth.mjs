const API = 'https://api.modrinth.com/v2'
const UA = 'mine-launcher/tools'

async function api(pathname) {
  const res = await fetch(`${API}${pathname}`, { headers: { 'user-agent': UA } })
  if (res.status === 404) throw new Error(`Modrinth: не найдено — ${pathname}`)
  if (!res.ok) throw new Error(`Modrinth ответил ${res.status} на ${pathname}`)
  return res.json()
}

/**
 * Разрешает список модов в конкретные файлы с хешами.
 *
 * Один список на клиент и сервер — намеренно. Версии модов у них обязаны
 * совпадать, иначе игрока выкинет при заходе; два отдельных списка разъедутся
 * на второй же неделе. Разница между сторонами берётся из самих метаданных
 * Modrinth, а не поддерживается руками.
 *
 * Элемент списка — либо слаг строкой, либо объект:
 *   { "slug": "sodium", "version": "mc1.21.1-0.6.0", "side": "client" }
 */
export async function resolveMods({ minecraft, loader = 'fabric', entries = [] }) {
  const byProject = new Map()
  const overrides = new Map()
  const autoAdded = []
  const queue = entries.map((ref) => ({ ref, requiredBy: null }))

  while (queue.length > 0) {
    const { ref, requiredBy } = queue.shift()
    const idOrSlug = typeof ref === 'string' ? ref : ref.slug
    const pinned = typeof ref === 'string' ? null : ref.version
    const side = typeof ref === 'string' ? null : ref.side

    const query = new URLSearchParams({
      loaders: JSON.stringify([loader]),
      game_versions: JSON.stringify([minecraft])
    })
    const versions = await api(`/project/${idOrSlug}/version?${query}`)

    if (versions.length === 0) {
      throw new Error(
        `"${idOrSlug}" не поддерживает ${loader} ${minecraft}` +
          (requiredBy ? ` (запрошен как зависимость ${requiredBy})` : '')
      )
    }

    const picked = pinned
      ? versions.find((v) => v.version_number === pinned || v.id === pinned)
      : (versions.find((v) => v.version_type === 'release') ?? versions[0])
    if (!picked) throw new Error(`У "${idOrSlug}" нет версии "${pinned}"`)

    if (byProject.has(picked.project_id)) continue

    const file = picked.files.find((f) => f.primary) ?? picked.files[0]
    byProject.set(picked.project_id, {
      name: file.filename,
      project: picked.project_id,
      url: file.url,
      sha1: file.hashes.sha1,
      size: file.size,
      title: `${picked.name} (${picked.version_number})`,
      slug: typeof ref === 'string' ? ref : ref.slug,
      versionNumber: picked.version_number
    })
    if (side) overrides.set(picked.project_id, side)

    if (requiredBy) autoAdded.push(`${file.filename} — нужен для ${requiredBy}`)

    // Обязательные зависимости тянем сами. Забытый fabric-api иначе
    // оборачивается «у меня игра не запускается» в личке — и узнаёшь об этом
    // уже после того, как все обновились.
    for (const dep of picked.dependencies ?? []) {
      if (dep.dependency_type !== 'required' || !dep.project_id) continue
      if (byProject.has(dep.project_id)) continue
      queue.push({ ref: dep.project_id, requiredBy: file.filename })
    }
  }

  await annotateSides(byProject, overrides)
  return { mods: [...byProject.values()], autoAdded }
}

/**
 * Где мод должен стоять. Sodium клиентский и уронит сервер, Lithium
 * серверный и на клиенте бесполезен, контент-моды нужны обеим сторонам —
 * всё это Modrinth знает про каждый проект, спрашивать не нужно.
 */
async function annotateSides(byProject, overrides) {
  const ids = [...byProject.keys()]
  if (ids.length === 0) return

  const projects = await api(`/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`)
  const meta = new Map(projects.map((p) => [p.id, p]))

  for (const [id, mod] of byProject) {
    const project = meta.get(id)
    const override = overrides.get(id)

    if (override) {
      mod.client = override === 'client' || override === 'both'
      mod.server = override === 'server' || override === 'both'
    } else {
      // Неизвестный проект считаем нужным обеим сторонам: пропустить мод
      // хуже, чем положить лишний.
      mod.client = project ? project.client_side !== 'unsupported' : true
      mod.server = project ? project.server_side !== 'unsupported' : true
    }
    // Зависимости приходят по идентификатору проекта, а не по слагу —
    // подставляем человекочитаемое имя, чтобы в выводе не было "eXts2L7r".
    if (project?.slug) mod.slug = project.slug
  }
}

/** Красивая пометка стороны для вывода в консоль. */
export function sideLabel(mod) {
  if (mod.client && mod.server) return 'обе'
  if (mod.client) return 'клиент'
  if (mod.server) return 'сервер'
  return 'нигде'
}
