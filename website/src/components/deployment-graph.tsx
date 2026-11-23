import { useId } from 'react'

const stages = [
  { x: 16, label: 'pre-deploy' },
  { x: 182, label: 'deploy' },
  { x: 348, label: 'post-deploy' },
]

const nodes = [
  { x: 28, y: 214, label: 'Add column' },
  { x: 194, y: 242, label: 'Build index' },
  { x: 194, y: 139, label: 'Backfill v2', kind: 'replacement' },
  { x: 194, y: 326, label: 'Backfill v1', kind: 'archived' },
  { x: 360, y: 214, label: 'Retire old column' },
]

export function DeploymentGraph() {
  const title = useId()
  const description = useId()
  const arrow = useId()
  const replacement = useId()
  return (
    <figure className="hero-graph">
      <svg viewBox="0 0 520 438" role="img" aria-labelledby={title + ' ' + description}>
        <title id={title}>Cross-namespace deployment graph and a superseding backfill</title>
        <desc id={description}>
          Preview and production use separate database ledgers. Adding the column enables the new
          backfill and the index independently. Retiring the old column requires both. Backfill
          version two supersedes version one, which remains visible in history.
        </desc>
        <defs>
          <marker id={arrow} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0 0L8 4L0 8Z" fill="var(--color-fd-muted-foreground)" />
          </marker>
          <marker id={replacement} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0 0L8 4L0 8Z" fill="var(--zenlev-accent)" />
          </marker>
        </defs>
        <rect className="deployment-surface" x="1" y="1" width="518" height="436" rx="20" />
        <text className="deployment-kicker" x="20" y="29">
          ENVIRONMENT
        </text>
        <text className="deployment-label" x="20" y="56">
          Preview ledger
        </text>
        <text className="deployment-label" x="182" y="56">
          Production ledger
        </text>
        <text className="deployment-note" x="500" y="56" textAnchor="end">
          Same graph
        </text>
        {stages.map(({ x, label }) => (
          <g key={label}>
            <rect className="deployment-lane" x={x} y="78" width="156" height="305" rx="13" />
            <text className="deployment-stage" x={x + 78} y="112" textAnchor="middle">
              {label}
            </text>
          </g>
        ))}
        <g className="deployment-edge" markerEnd={`url(#${arrow})`}>
          <path d="M156 234H166Q177 234 177 223V170Q177 159 188 159H192" />
          <path d="M156 234H167Q178 234 178 245V251Q178 262 189 262H192" />
          <path d="M322 159H332Q343 159 343 170V223Q343 234 354 234H358" />
          <path d="M322 262H333Q344 262 344 251V245Q344 234 355 234H358" />
        </g>
        <path
          className="deployment-replacement"
          d="M258 179V196Q258 205 249 205H216Q184 205 184 228V333Q184 346 192 346"
          markerEnd={`url(#${replacement})`}
        />
        {nodes.map(({ x, y, label, kind }) => (
          <g className={kind ? 'deployment-node ' + kind : 'deployment-node'} key={label}>
            <rect x={x} y={y} width="132" height="40" rx="8" />
            <text x={x + 66} y={y + 25} textAnchor="middle">
              {label}
            </text>
          </g>
        ))}
        <path className="deployment-edge" d="M24 408H50" markerEnd={`url(#${arrow})`} />
        <text className="deployment-note" x="61" y="413">
          Prerequisite to dependent
        </text>
        <path
          className="deployment-replacement"
          d="M305 408H331"
          markerEnd={`url(#${replacement})`}
        />
        <text className="deployment-note" x="342" y="413">
          Supersedes
        </text>
      </svg>
      <figcaption className="graph-caption">
        The client factory chooses the ledger. Dependencies determine the order within it.
      </figcaption>
    </figure>
  )
}
