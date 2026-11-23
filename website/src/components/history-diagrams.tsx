const panel = 'rounded-lg border border-fd-border bg-fd-card p-4 text-fd-card-foreground'

export function SupersedesGraph() {
  return (
    <figure className="not-prose my-8">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className={panel}>
          <strong>Original dependency</strong>
          <p className="mb-0 mt-2 text-sm">Backfill v1 → Retire old column</p>
        </div>
        <div className={panel}>
          <strong>Effective dependency</strong>
          <p className="mb-0 mt-2 text-sm">Backfill v2 → Retire old column</p>
          <p className="mb-0 mt-2 text-sm text-fd-muted-foreground">
            Backfill v2 supersedes Backfill v1.
          </p>
        </div>
      </div>
      <figcaption className="mt-3 text-sm text-fd-muted-foreground">
        The cleanup file keeps its original dependency ID. Zenlev follows that ID to Backfill v2
        when planning cleanup. Any execution of Backfill v1 stays in the ledger.
      </figcaption>
    </figure>
  )
}

export function RollbackGraph() {
  return (
    <figure className="not-prose my-8">
      <div className={panel}>
        <strong>Applied graph</strong>
        <p className="mb-0 mt-2 text-sm">Add column → Backfill rows → Retire old column</p>
        <p className="mb-0 mt-2 text-sm">Add column → Create index</p>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className={panel}>
          <strong className="text-fd-primary">Cascade Backfill rows</strong>
          <ol className="mb-0 mt-2 list-decimal space-y-1 pl-5 text-sm">
            <li>Undo Retire old column.</li>
            <li>Undo Backfill rows.</li>
          </ol>
          <p className="mb-0 mt-3 text-sm">The added column and index stay applied.</p>
        </div>
        <div className={panel}>
          <strong className="text-fd-primary">Compensate Backfill rows</strong>
          <ol className="mb-0 mt-2 list-decimal space-y-1 pl-5 text-sm">
            <li>Undo Backfill rows.</li>
          </ol>
          <p className="mb-0 mt-3 text-sm">
            Retire old column stays applied. Review whether the backfill reversal is safe in that
            state.
          </p>
        </div>
      </div>
      <figcaption className="mt-3 text-sm text-fd-muted-foreground">
        Both modes generate a new migration. Arrows point from prerequisite to dependent. A cascade
        walks the affected chain in reverse.
      </figcaption>
    </figure>
  )
}
