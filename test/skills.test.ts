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
    await mkdir(skill, { recursive: true })
    await Bun.write(
      join(skill, 'SKILL.md'),
      [
        '---',
        'name: zenlev-example',
        'metadata:',
        '  library: "@mwillbanks/zenstack-zenlev"',
        'sources:',
        '  - guide.md',
        '---',
        '# Example',
        '',
      ].join('\n'),
    )
    await Bun.write(join(root, 'guide.md'), '# Guide\n')
    await Bun.write(join(root, 'package.json'), '{"version":"1.2.3"}')

    await expect(prepareSkills(root)).rejects.toThrow('no recorded review')
    await writeReview('Checked the skill against the guide.')
    await prepareSkills(root)
    const staged = Bun.file(join(root, 'skills/zenlev-example/SKILL.md'))
    expect(await staged.text()).toContain('library_version: "1.2.3"')

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
