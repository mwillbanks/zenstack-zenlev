import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSkills, skillDirectory } from '../scripts/skills'

test('stages valid skills and bundled scripts at the package version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zenlev-skills-'))
  const skill = join(root, skillDirectory, 'zenlev-example')

  try {
    await mkdir(join(skill, 'scripts'), { recursive: true })
    const script = join(skill, 'scripts/example.ts')
    await Bun.write(script, 'console.log(1)\n')
    const markdown = join(skill, 'SKILL.md')
    await Bun.write(
      markdown,
      [
        '---',
        'name: zenlev-example',
        'description: Use when checking the fixture.',
        'metadata:',
        '  library: "@mwillbanks/zenstack-zenlev"',
        '  type: core',
        '---',
        '# Example',
        '',
      ].join('\n'),
    )
    await Bun.write(join(root, 'package.json'), '{"version":"1.2.3"}')

    const valid = await Bun.file(markdown).text()
    for (const [invalid, message] of [
      [
        valid.replace('metadata:', 'sources: [guide.md]\nmetadata:'),
        'unsupported Agent Skills frontmatter',
      ],
      [valid.replace('description: Use when checking the fixture.\n', ''), 'needs a description'],
      [valid.replace('  type: core', '  type: [core]'), 'string-valued metadata'],
    ] as const) {
      await Bun.write(markdown, invalid)
      await expect(prepareSkills(root)).rejects.toThrow(message)
    }
    await Bun.write(markdown, valid)
    await prepareSkills(root)
    const staged = Bun.file(join(root, 'skills/zenlev-example/SKILL.md'))
    expect(await staged.text()).toContain('library_version: "1.2.3"')
    expect(await Bun.file(join(root, 'skills/zenlev-example/scripts/example.ts')).text()).toBe(
      'console.log(1)\n',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
