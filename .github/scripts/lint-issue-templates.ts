import assert from 'node:assert/strict'

const directory = '.github/ISSUE_TEMPLATE'
const files = Array.from(new Bun.Glob('*.{yml,yaml}').scanSync({ cwd: directory })).sort()
assert(files.includes('config.yml'), 'The issue template chooser needs config.yml')

const names = new Set<string>()
for (const file of files) {
  const path = `${directory}/${file}`
  const document = Bun.YAML.parse(await Bun.file(path).text())
  assert(record(document), `${path}: expected a YAML mapping`)

  if (file === 'config.yml') {
    assert(
      typeof document.blank_issues_enabled === 'boolean',
      `${path}: invalid blank issue setting`,
    )
    assert(Array.isArray(document.contact_links), `${path}: expected contact links`)
    for (const link of document.contact_links) {
      assert(
        record(link) && filled(link.name) && filled(link.about),
        `${path}: invalid contact link`,
      )
      assert(filled(link.url) && URL.canParse(link.url), `${path}: invalid contact URL`)
      assert(new URL(link.url).protocol === 'https:', `${path}: contact URLs must use HTTPS`)
    }
    continue
  }

  const name = document.name
  assert(filled(name) && name.length > 3 && !names.has(name), `${path}: invalid or duplicate name`)
  assert(filled(document.description), `${path}: missing description`)
  assert(Array.isArray(document.body) && document.body.length > 0, `${path}: expected form fields`)
  names.add(name)

  const ids = new Set<string>()
  for (const field of document.body) {
    assert(record(field) && record(field.attributes), `${path}: invalid form field`)
    if (field.type === 'markdown') {
      assert(filled(field.attributes.value), `${path}: empty markdown field`)
      continue
    }

    assert(
      ['input', 'textarea', 'dropdown', 'checkboxes', 'upload'].includes(String(field.type)),
      `${path}: unknown field type ${field.type}`,
    )
    const id = field.id
    assert(
      filled(id) && /^[a-zA-Z0-9_-]+$/.test(id) && !ids.has(id),
      `${path}: invalid or duplicate field ID`,
    )
    assert(filled(field.attributes.label), `${path}: missing label for ${id}`)
    ids.add(id)

    if (field.type === 'dropdown' || field.type === 'checkboxes') {
      assert(
        Array.isArray(field.attributes.options) && field.attributes.options.length > 0,
        `${path}: missing options for ${id}`,
      )
    }
    if (field.validations !== undefined) {
      assert(
        record(field.validations) && typeof field.validations.required === 'boolean',
        `${path}: expected a Boolean required setting for ${id}`,
      )
    }
  }
}

assert(names.size > 0, 'Expected at least one issue form')

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function filled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
