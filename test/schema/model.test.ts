import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { loadSchemaModel, resolveSchemaPath } from '../../src/schema/model'

let cwd: string
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'zenlev-schema-'))
})
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})
function write(path: string, content: string | object) {
  return Bun.write(join(cwd, path), typeof content === 'string' ? content : JSON.stringify(content))
}
function schema(provider: string, models: string) {
  return 'datasource db {\n provider = "' + provider + '"\n}\n' + models
}

describe('schema discovery', () => {
  test('prefers an explicit path, then package setting, then root and nested defaults', async () => {
    await expect(resolveSchemaPath(cwd)).rejects.toThrow('Schema file not found')
    await write('zenstack/schema.zmodel', schema('sqlite', 'model A { id Int @id }'))
    expect(await resolveSchemaPath(cwd)).toBe(join(cwd, 'zenstack/schema.zmodel'))
    await write('schema.zmodel', schema('sqlite', 'model B { id Int @id }'))
    expect(await resolveSchemaPath(cwd)).toBe(join(cwd, 'schema.zmodel'))
    await write('other/schema.zmodel', schema('sqlite', 'model C { id Int @id }'))
    await write('package.json', { zenstack: { schema: 'other' } })
    expect(await resolveSchemaPath(cwd)).toBe(join(cwd, 'other/schema.zmodel'))
    expect(await resolveSchemaPath(cwd, 'schema.zmodel')).toBe(join(cwd, 'schema.zmodel'))
    await expect(resolveSchemaPath(cwd, 'missing.zmodel')).rejects.toThrow('not found')
    await write('package.json', { zenstack: { schema: 'missing.zmodel' } })
    await expect(resolveSchemaPath(cwd)).rejects.toThrow('not found')
    await write('package.json', { zenstack: { schema: 15 } })
    await expect(resolveSchemaPath(cwd)).rejects.toThrow('nonempty path')
  })

  test('supports a configured schema file', async () => {
    await write('custom.zmodel', schema('sqlite', 'model A { id Int @id }'))
    await write('package.json', { zenstack: { schema: './custom.zmodel' } })
    expect(await resolveSchemaPath(cwd)).toBe(join(cwd, 'custom.zmodel'))
  })

  test('fails invalid source with diagnostics before projecting', async () => {
    await write('schema.zmodel', 'model NoId { nope NotAType }')
    await expect(loadSchemaModel({ cwd })).rejects.toThrow('Invalid ZModel schema')
    await write('custom.txt', 'invalid')
    await expect(loadSchemaModel({ cwd, schema: 'custom.txt' })).rejects.toThrow(
      'invalid schema file extension',
    )
  })
})

describe('schema projection', () => {
  test('projects SQLite scalar types, mapped tables and fields, compound constraints and defaults', async () => {
    await write(
      'schema.zmodel',
      schema(
        'sqlite',
        `
model User {
  id Int @id @default(autoincrement())
  email String @unique(map: "users_email_key") @map("email_address")
  enabled Boolean @default(true)
  score Float @default(1.25)
  created DateTime @default(now())
  token String @default(cuid())
  value Json?
  binary Bytes?
  total Decimal?
  count BigInt?
  ignored String? @ignore
  @@map("users")
  @@index([created, email], map: "users_created_email")
}
model Pair {
  first Int
  second Int
  @@id([first, second], map: "pair_pkey")
  @@unique([first, second], map: "pair_unique")
}
`,
      ),
    )
    const result = await loadSchemaModel({ cwd })
    expect(result.dialect).toBe('sqlite')
    expect(result.unsupported).toEqual([])
    expect(result.namespaces).toEqual([])
    const user = result.tables.find((item) => item.model === 'User')!
    expect(user.name).toBe('users')
    expect(user.primaryKey).toEqual(['id'])
    expect(user.columns).toEqual(
      expect.arrayContaining([
        {
          name: 'id',
          field: 'id',
          type: 'integer',
          nullable: false,
          autoIncrement: true,
          array: false,
        },
        {
          name: 'email_address',
          field: 'email',
          type: 'text',
          nullable: false,
          autoIncrement: false,
          array: false,
        },
        {
          name: 'enabled',
          field: 'enabled',
          type: 'boolean',
          nullable: false,
          autoIncrement: false,
          array: false,
          default: { kind: 'literal', value: true },
        },
        {
          name: 'created',
          field: 'created',
          type: 'datetime',
          nullable: false,
          autoIncrement: false,
          array: false,
          default: { kind: 'sql', sql: 'CURRENT_TIMESTAMP' },
        },
        {
          name: 'token',
          field: 'token',
          type: 'text',
          nullable: false,
          autoIncrement: false,
          array: false,
        },
      ]),
    )
    expect(user.columns.some((item) => item.field === 'ignored')).toBe(true)
    expect(user.indexes).toEqual([
      { name: 'users_created_email', columns: ['created', 'email_address'], unique: false },
      { name: 'users_email_key', columns: ['email_address'], unique: true },
    ])
    expect(result.tables.find((item) => item.name === 'Pair')).toMatchObject({
      primaryKey: ['first', 'second'],
      primaryKeyName: 'pair_pkey',
      indexes: [{ name: 'pair_unique', columns: ['first', 'second'], unique: true }],
    })
  })

  test('resolves imported models and physical foreign key names', async () => {
    await write(
      'shared.zmodel',
      `
model Owner {
  id Int @id @map("owner_id")
  entries Entry[]
  @@map("owners")
}
model Entry {
  id Int @id
  ownerId Int @map("owner_id")
  owner Owner @relation(fields: [ownerId], references: [id], onDelete: Cascade, onUpdate: Restrict, map: "entry_owner")
  @@map("entries")
}
`,
    )
    await write(
      'schema.zmodel',
      'import "./shared"\n' + schema('sqlite', 'model Marker { id Int @id }'),
    )
    const result = await loadSchemaModel({ cwd })
    expect(result.unsupported).toEqual([])
    const entry = result.tables.find((table) => table.model === 'Entry')!
    expect(entry.columns.map((item) => item.name)).toEqual(['id', 'owner_id'])
    expect(entry.foreignKeys).toEqual([
      {
        name: 'entry_owner',
        columns: ['owner_id'],
        targetTable: 'owners',
        targetColumns: ['owner_id'],
        onDelete: 'Cascade',
        onUpdate: 'Restrict',
      },
    ])
  })

  test('projects PostgreSQL native types, arrays, mapped enums and enum defaults', async () => {
    await write(
      'schema.zmodel',
      schema(
        'postgresql',
        `
enum State {
  ACTIVE @map("active")
  INACTIVE @map("inactive")
  @@map("states")
}
model Item {
  id String @id @db.Uuid
  state State @default(ACTIVE)
  label String @db.VarChar(80)
  amount Decimal @db.Decimal(12, 2)
  flags Int[]
  generated Int @default(dbgenerated("42"))
}
`,
      ),
    )
    const result = await loadSchemaModel({ cwd })
    expect(result.unsupported).toEqual([])
    expect(result.namespaces).toEqual(['public'])
    expect(result.enums).toEqual([
      { name: 'states', namespace: 'public', values: ['active', 'inactive'] },
    ])
    expect(result.tables[0]).toMatchObject({
      namespace: 'public',
      columns: expect.arrayContaining([
        expect.objectContaining({ name: 'id', type: 'uuid' }),
        expect.objectContaining({
          name: 'state',
          type: 'states',
          enumName: 'states',
          default: { kind: 'literal', value: 'active' },
        }),
        expect.objectContaining({ name: 'label', type: 'varchar(80)' }),
        expect.objectContaining({ name: 'amount', type: 'decimal(12,2)' }),
        expect.objectContaining({ name: 'flags', array: true }),
        expect.objectContaining({ name: 'generated', default: { kind: 'sql', sql: '42' } }),
      ]),
    })
  })

  test('projects MySQL enums and nullable default referential actions', async () => {
    await write(
      'schema.zmodel',
      schema(
        'mysql',
        `
enum State {
  ACTIVE @map("a'b")
  INACTIVE
}
model Parent {
  id Int @id
  children Child[]
}
model Child {
  id Int @id @default(autoincrement())
  state State
  parentId Int?
  parent Parent? @relation(fields: [parentId], references: [id])
}
`,
      ),
    )
    const result = await loadSchemaModel({ cwd })
    expect(result.unsupported).toEqual([])
    expect(result.tables.find((item) => item.model === 'Child')).toMatchObject({
      columns: expect.arrayContaining([
        expect.objectContaining({ name: 'state', type: "enum('a''b','INACTIVE')" }),
      ]),
      foreignKeys: [
        {
          columns: ['parentId'],
          targetTable: 'Parent',
          targetColumns: ['id'],
          onDelete: 'SetNull',
          onUpdate: 'Cascade',
        },
      ],
    })
  })

  test('excludes views and reports a view requiring SQL when inclusion is requested', async () => {
    await write(
      'schema.zmodel',
      schema(
        'sqlite',
        `
model User { id Int @id }
view UserView { id Int @unique }
`,
      ),
    )
    expect((await loadSchemaModel({ cwd })).tables.map((table) => table.model)).toEqual(['User'])
    const included = await loadSchemaModel({ cwd, excludeViews: false })
    expect(included.unsupported).toMatchObject([{ code: 'VIEW_DEFINITION', source: { line: 6 } }])
    expect(relative(cwd, included.unsupported[0]!.source.path)).toBe('schema.zmodel')
  })

  test('projects explicit PostgreSQL namespaces for tables, enums, and foreign keys', async () => {
    await write(
      'schema.zmodel',
      `
datasource db {
  provider = "postgresql"
  schemas = ["app", "catalog"]
}
enum State {
  ACTIVE
  @@schema("catalog")
}
model Parent {
  id Int @id
  children Child[]
  @@schema("catalog")
}
model Child {
  id Int @id
  state State
  parentId Int
  parent Parent @relation(fields: [parentId], references: [id])
  projected String @computed
  @@schema("app")
}
`,
    )
    const result = await loadSchemaModel({ cwd })
    expect(result.unsupported).toEqual([])
    expect(result.namespaces).toEqual(['app', 'catalog'])
    expect(result.enums[0]?.namespace).toBe('catalog')
    const child = result.tables.find((table) => table.model === 'Child')!
    expect(child.namespace).toBe('app')
    expect(child.columns.some((column) => column.field === 'projected')).toBe(false)
    expect(child.foreignKeys[0]).toMatchObject({ targetNamespace: 'catalog', onDelete: 'Restrict' })
  })

  test('reports index features and polymorphic storage requiring manual SQL', async () => {
    await write(
      'schema.zmodel',
      schema(
        'postgresql',
        `
model Asset {
  id Int @id
  kind String
  @@delegate(kind)
}
model Video extends Asset {
  duration Int
}
model Item {
  id Int @id
  label String
  @@index([label(sort: Desc)], map: "ordered_label")
  @@fulltext([label])
}
`,
      ),
    )
    const result = await loadSchemaModel({ cwd })
    expect(result.unsupported.map((item) => item.code)).toEqual(
      expect.arrayContaining(['POLYMORPHIC_MODEL', 'INDEX_OPTIONS', 'FULLTEXT_INDEX']),
    )
    expect(result.tables.map((table) => table.model)).toEqual(['Item'])
  })

  test('reports uninterpretable database defaults', async () => {
    await write(
      'schema.zmodel',
      schema(
        'postgresql',
        `
model Item {
  id Int @id
  generated Int @default(dbgenerated())
}
`,
      ),
    )
    const result = await loadSchemaModel({ cwd })
    expect(result.unsupported.map((item) => item.code)).toEqual(['DEFAULT_EXPRESSION'])
    expect(
      result.tables[0]?.columns.find((column) => column.name === 'generated')?.default,
    ).toBeUndefined()
  })

  test('reports context-dependent defaults through the manual migration path', async () => {
    await write(
      'schema.zmodel',
      schema(
        'postgresql',
        `
model User {
  id String @id
  @@auth
}
model Account {
  id Int @id
  creator String @default(auth().id)
}
`,
      ),
    )
    const result = await loadSchemaModel({ cwd })
    expect(result.unsupported).toMatchObject([{ code: 'DEFAULT_EXPRESSION' }])
  })

  test('reports implicit join tables and unsupported database types with source positions', async () => {
    await write(
      'shared.zmodel',
      `
model Role {
  id Int @id
  users User[]
}
model User {
  id Int @id
  roles Role[]
  vector Unsupported("vector")?
}
`,
    )
    await write(
      'schema.zmodel',
      'import "./shared"\n' + schema('postgresql', 'model Marker { id Int @id }'),
    )
    const result = await loadSchemaModel({ cwd })
    expect(result.unsupported.map((item) => item.code)).toEqual(
      expect.arrayContaining(['IMPLICIT_MANY_TO_MANY', 'COLUMN_TYPE']),
    )
    for (const diagnostic of result.unsupported) {
      expect(diagnostic.source.line).toBeGreaterThan(0)
      expect(diagnostic.source.column).toBeGreaterThan(0)
      expect(diagnostic.message).toContain('explicit migration')
    }
    expect(
      result.unsupported.find((item) => item.source.path.endsWith('shared.zmodel')),
    ).toBeDefined()
  })
})
