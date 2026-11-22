import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowUpRight, GitBranch, Layers3, Terminal } from 'lucide-react'
import { HomeLayout } from 'fumadocs-ui/layouts/home'
import { baseOptions } from '@/lib/layout.shared'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <HomeLayout {...baseOptions()}>
      <main>
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">TypeScript migrations for ZenStack V3</p>
            <h1>
              Migrations with
              <br />
              <span>a direction.</span>
            </h1>
            <p className="hero-description">
              Shape your database with code. Connect changes through explicit dependencies, plan
              each deployment, and run with the client you already use.
            </p>
            <div className="hero-actions">
              <Link className="primary-link" to="/docs/$" params={{ _splat: 'quick-start' }}>
                Start building <ArrowUpRight size={18} />
              </Link>
              <Link className="secondary-link" to="/docs/$" params={{ _splat: 'graph' }}>
                Explore the graph <GitBranch size={18} />
              </Link>
            </div>
            <div className="install">
              <Terminal size={17} aria-hidden="true" />
              <code>bun add -d @mwillbanks/zenstack-zenlev</code>
            </div>
          </div>
          <div className="hero-graph">
            <svg viewBox="0 0 520 420" role="img" aria-labelledby="graph-title graph-desc">
              <title id="graph-title">A migration graph rising through deployment stages</title>
              <desc id="graph-desc">
                Independent migrations join before a final deployment step.
              </desc>
              <defs>
                <linearGradient
                  id="edge"
                  x1="90"
                  y1="340"
                  x2="420"
                  y2="80"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop stopColor="#7757EA" />
                  <stop offset=".55" stopColor="#FF4002" />
                  <stop offset="1" stopColor="#FF996B" />
                </linearGradient>
              </defs>
              <g fill="none" stroke="url(#edge)" strokeWidth="3">
                <path d="M90 335V275Q90 260 105 260H190Q205 260 205 245V180Q205 165 220 165H340Q355 165 355 150V90" />
                <path d="M90 335H315Q330 335 330 320V275Q330 260 345 260H410Q425 260 425 245V180Q425 165 410 165H355" />
              </g>
              <g className="graph-node">
                <circle cx="90" cy="335" r="15" />
                <circle cx="205" cy="260" r="15" />
                <circle cx="330" cy="335" r="15" />
                <circle cx="425" cy="260" r="15" />
                <circle cx="355" cy="165" r="15" />
              </g>
              <circle cx="355" cy="90" r="24" fill="#FF4002" />
              <path
                d="m345 92 7 7 14-17"
                stroke="#fff"
                fill="none"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <g className="graph-label">
                <text x="65" y="380">
                  prepare
                </text>
                <text x="180" y="224">
                  schema
                </text>
                <text x="301" y="380">
                  backfill
                </text>
                <text x="395" y="225">
                  index
                </text>
                <text x="382" y="98">
                  deploy
                </text>
              </g>
            </svg>
            <div className="graph-caption">
              <span className="status-dot" /> Dependencies first. Deployment on your terms.
            </div>
          </div>
        </section>
        <section className="principles">
          <article>
            <GitBranch />
            <h2>Plan the dependency graph</h2>
            <p>
              Connect migrations across namespaces. Inspect the exact order and unresolved
              prerequisites before execution.
            </p>
          </article>
          <article>
            <Layers3 />
            <h2>Keep your configured client</h2>
            <p>
              Use ZenStack ORM and Kysely in one migration context, with transactional execution
              where the database supports it.
            </p>
          </article>
          <article>
            <Terminal />
            <h2>Write migrations as code</h2>
            <p>
              Use TypeScript for schema changes and data work. Review hashes, rollback compensation,
              and recovery decisions explicitly.
            </p>
          </article>
        </section>
        <section className="next-step">
          <h2>From schema change to deliberate rollout.</h2>
          <p>
            Start with a migration, inspect its plan, then apply the stages your deployment needs.
          </p>
          <Link className="primary-link" to="/docs/$" params={{ _splat: 'commands' }}>
            Read the command reference <ArrowUpRight size={18} />
          </Link>
        </section>
      </main>
    </HomeLayout>
  )
}
