import type { QueryResult, QueryResultRow } from 'pg'

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[]
  ): Promise<QueryResult<R>>
}
