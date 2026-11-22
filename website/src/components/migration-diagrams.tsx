import { useId } from 'react'

const card = 'rounded-lg border border-fd-border bg-fd-card p-4 text-fd-card-foreground'
const arrow = 'self-center text-center text-2xl text-fd-muted-foreground rotate-90 xl:rotate-0'

export function MigrationGraph() {
  const id = useId()
  return (
    <figure className="not-prose my-8" aria-labelledby={id}>
      <div className="rounded-xl border border-fd-border bg-fd-muted/30 p-5">
        <div className="grid items-center gap-4 xl:grid-cols-[1fr_auto_1.2fr_auto_1fr]">
          <div className={card}>
            <strong className="block">Add replacement column</strong>
            <span className="mt-2 block text-sm text-fd-muted-foreground">predeploy</span>
          </div>
          <span className={arrow} aria-hidden="true">
            →
          </span>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <div className={card}>
              <strong className="block">Backfill existing rows</strong>
              <span className="mt-2 block text-sm text-fd-muted-foreground">deploy</span>
            </div>
            <div className={card}>
              <strong className="block">Create supporting index</strong>
              <span className="mt-2 block text-sm text-fd-muted-foreground">predeploy</span>
            </div>
          </div>
          <span className={arrow} aria-hidden="true">
            →
          </span>
          <div className={card}>
            <strong className="block">Retire old column</strong>
            <span className="mt-2 block text-sm text-fd-muted-foreground">postdeploy</span>
          </div>
        </div>
      </div>
      <figcaption id={id} className="mt-3 text-sm leading-relaxed text-fd-muted-foreground">
        The new column precedes both backfill and index creation. Cleanup depends on both. Backfill
        and indexing have no dependency between them. Zenlev runs the selected migrations
        sequentially, using lexical ID order for independent migrations.
      </figcaption>
    </figure>
  )
}

export function DeploymentTimeline() {
  const id = useId()
  return (
    <figure className="not-prose my-8" aria-labelledby={id}>
      <ol className="m-0 grid list-none gap-3 p-0 md:grid-cols-3">
        <li className={card}>
          <strong className="block text-fd-primary">Before deployment</strong>
          <p className="mb-0 mt-2 text-sm leading-relaxed">
            Add compatible schema. Inspect and apply the predeploy namespace.
          </p>
        </li>
        <li className={card}>
          <strong className="block text-fd-primary">During deployment</strong>
          <p className="mb-0 mt-2 text-sm leading-relaxed">
            Deploy compatible application code. Run backfills after its readiness checkpoint.
          </p>
        </li>
        <li className={card}>
          <strong className="block text-fd-primary">After deployment</strong>
          <p className="mb-0 mt-2 text-sm leading-relaxed">
            Verify traffic and data. Retire old schema when the previous application has stopped.
          </p>
        </li>
      </ol>
      <figcaption id={id} className="mt-3 text-sm leading-relaxed text-fd-muted-foreground">
        Your release pipeline owns application deployment and readiness checks. Invoke Zenlev at
        each chosen checkpoint. Namespace names label migration groups, and dependsOn declares their
        database prerequisites.
      </figcaption>
    </figure>
  )
}
