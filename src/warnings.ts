import type { KyselyPlugin, OperationNode } from 'kysely'
import type { Warning } from './types'

const codes: Readonly<Record<string, [Warning['code'], string]>> = {
  DropTableNode: ['DROP_TABLE', 'Kysely is dropping a table'],
  DropColumnNode: ['DROP_COLUMN', 'Kysely is dropping a column'],
  TruncateTableNode: ['DESTRUCTIVE_DATA', 'Kysely is truncating a table'],
  UniqueConstraintNode: ['UNIQUE_CONSTRAINT', 'Kysely is adding a unique constraint'],
}

export function operationWarnings(
  migrationId: string,
  notify: (warning: Warning) => void,
): KyselyPlugin {
  function inspect(node: OperationNode): void {
    if (node.kind === 'ValueNode' || node.kind === 'PrimitiveValueListNode') return
    let warning = codes[node.kind]
    if (node.kind === 'DeleteQueryNode' && !('where' in node && node.where)) {
      warning = ['DESTRUCTIVE_DATA', 'Kysely is deleting all rows matching an unfiltered query']
    } else if (node.kind === 'AlterColumnNode' && 'dataType' in node && node.dataType) {
      warning = [
        'TYPE_NARROWING',
        'Kysely is changing a column type; verify it preserves existing data',
      ]
    } else if (
      (node.kind === 'CreateIndexNode' || node.kind === 'ColumnDefinitionNode') &&
      'unique' in node &&
      node.unique
    ) {
      warning = ['UNIQUE_CONSTRAINT', 'Kysely is enforcing uniqueness']
    }
    if (warning) notify({ code: warning[0], message: warning[1], migrationId })
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) visit(item)
      else visit(value)
    }
  }
  function visit(value: unknown): void {
    if (
      typeof value === 'object' &&
      value !== null &&
      'kind' in value &&
      typeof value.kind === 'string'
    ) {
      inspect(value as OperationNode)
    }
  }
  return {
    transformQuery({ node }) {
      inspect(node)
      return node
    },
    async transformResult({ result }) {
      return result
    },
  }
}
