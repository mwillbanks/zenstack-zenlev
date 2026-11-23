import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSkills, recordReview, reviewPath, skillDirectory } from '../scripts/skills'

test('stages reviewed skills at the package version and detects source drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zenlev-skill-review-'))
  const skill = join(root, skillDirectory, 'zenlev-example')
  const writeReview = async (reason: string) => {
    const review = await recordReview(root, 'zenlev-example', reason)
    await Bun.write(join(root, reviewPath), JSON.stringify(review))
  }

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
        '  zenlev_sources: guide.md',
        '---',
        '# Example',
        '',
      ].join('\n'),
    )
    await Bun.write(join(root, 'guide.md'), '# Guide\n')
    await Bun.write(join(root, 'package.json'), '{"version":"1.2.3"}')

    const valid = await Bun.file(markdown).text()
    for (const [invalid, message] of [
      [
        valid.replace('metadata:', 'sources: [guide.md]\nmetadata:'),
        'unsupported Agent Skills frontmatter',
      ],
      [valid.replace('description: Use when checking the fixture.\n', ''), 'needs a description'],
      [
        valid.replace('zenlev_sources: guide.md', 'zenlev_sources: [guide.md]'),
        'string-valued metadata',
      ],
    ] as const) {
      await Bun.write(markdown, invalid)
      await expect(prepareSkills(root)).rejects.toThrow(message)
    }
    await Bun.write(markdown, valid)
    await expect(prepareSkills(root)).rejects.toThrow('no recorded review')
    await writeReview('Checked the skill against the guide.')
    await prepareSkills(root)
    const staged = Bun.file(join(root, 'skills/zenlev-example/SKILL.md'))
    expect(await staged.text()).toContain('library_version: "1.2.3"')
    expect(await Bun.file(join(root, 'skills/zenlev-example/scripts/example.ts')).text()).toBe(
      'console.log(1)\n',
    )

    await Bun.write(script, 'console.log(2)\n')
    await expect(prepareSkills(root)).rejects.toThrow(
      'review ' + skillDirectory + '/zenlev-example/scripts/example.ts',
    )
    await writeReview('Checked the updated script output.')
    await prepareSkills(root)

    await Bun.write(join(root, 'unrelated.md'), '# Unrelated\n')
    await Bun.write(join(root, 'package.json'), '{"version":"1.2.4"}')
    await prepareSkills(root)
    expect(await staged.text()).toContain('library_version: "1.2.4"')

    await Bun.write(join(root, 'guide.md'), '# Edited guide\n')
    await expect(prepareSkills(root)).rejects.toThrow('zenlev-example: review guide.md')
    expect(await staged.text()).toContain('library_version: "1.2.4"')
    await writeReview('The heading changed. The instructions still apply.')
    await prepareSkills(root)

    await rm(join(root, 'guide.md'))
    await expect(prepareSkills(root)).rejects.toThrow(
      'zenlev-example: Missing skill source: guide.md',
    )
    await expect(recordReview(root, 'zenlev-example', 'Unsourced')).rejects.toThrow(
      'Missing skill source',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
