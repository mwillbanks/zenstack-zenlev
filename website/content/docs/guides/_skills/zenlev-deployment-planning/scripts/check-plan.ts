export {}

type Item = { message: string }
type Migration = { id: string }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isMessage(value: unknown): value is Item {
  return isObject(value) && typeof value.message === 'string'
}

function isMigration(value: unknown): value is Migration {
  return isObject(value) && typeof value.id === 'string'
}

const [argument, extra] = Bun.argv.slice(2)
if (argument === '--help' && extra === undefined) {
  console.log('Usage: bun check-plan.ts [PLAN_JSON|-]')
  console.log(
    'Read a Zenlev plan-only JSON response. Exit 0 for clear, 1 for blockers, 2 for invalid input.',
  )
} else {
  try {
    if (extra !== undefined || (argument?.startsWith('--') ?? false)) {
      throw new Error('Expected a JSON file or stdin. Use --help for usage.')
    }
    const input =
      argument && argument !== '-' ? await Bun.file(argument).text() : await Bun.stdin.text()
    const envelope: unknown = JSON.parse(input)
    const result = isObject(envelope) ? envelope.result : undefined
    const plan = isObject(result) ? result.plan : undefined
    if (
      !isObject(envelope) ||
      !isObject(result) ||
      result.status !== 'planned' ||
      !isObject(plan) ||
      !Array.isArray(plan.migrations) ||
      !plan.migrations.every(isMigration) ||
      !Array.isArray(plan.blockers) ||
      !plan.blockers.every(isMessage) ||
      !Array.isArray(plan.warnings) ||
      !plan.warnings.every(isMessage) ||
      envelope.status !== (plan.blockers.length ? 'error' : 'ok')
    ) {
      throw new Error('Expected a Zenlev migrate apply --plan-only --json response.')
    }

    console.log(
      JSON.stringify(
        {
          selected: plan.migrations.map(({ id }: Migration) => id),
          blockers: plan.blockers,
          warnings: plan.warnings,
        },
        null,
        2,
      ),
    )
    process.exitCode = plan.blockers.length ? 1 : 0
  } catch (error) {
    console.error(
      'Cannot inspect plan: ' + (error instanceof Error ? error.message : String(error)),
    )
    process.exitCode = 2
  }
}
