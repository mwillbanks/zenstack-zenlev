import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowUpRight, GitBranch, Layers3, Terminal } from 'lucide-react'
import { HomeLayout } from 'fumadocs-ui/layouts/home'
import { baseOptions } from '@/lib/layout.shared'
import { DeploymentGraph } from '@/components/deployment-graph'

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
              <Link className="primary-link" to="/docs/$" params={{ _splat: 'guides/quick-start' }}>
                Start building <ArrowUpRight size={18} />
              </Link>
              <Link className="secondary-link" to="/docs/$" params={{ _splat: 'guides/graph' }}>
                Explore the graph <GitBranch size={18} />
              </Link>
            </div>
            <div className="install">
              <Terminal size={17} aria-hidden="true" />
              <code>bun add -d @mwillbanks/zenstack-zenlev</code>
            </div>
          </div>
          <DeploymentGraph />
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
          <Link className="primary-link" to="/docs/$" params={{ _splat: 'reference/commands' }}>
            Read the command reference <ArrowUpRight size={18} />
          </Link>
        </section>
      </main>
    </HomeLayout>
  )
}
