#!/usr/bin/env bash
#
# Applies the migrations to a throwaway Postgres database and runs the SQL
# test suites against it. Needs a local Postgres 15+ on $PGPORT (default 5433).
#
#   ./supabase/tests/run.sh
#
# The auth stub stands in for the pieces of Supabase's auth schema the
# migrations reference. It is never applied to a real project.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
DB="${DB:-neomed_test}"

export PGHOST PGPORT PGUSER

psql_q() { psql -v ON_ERROR_STOP=1 -q "$@"; }

echo "==> rebuilding $DB"
dropdb --if-exists "$DB"
createdb "$DB"

echo "==> applying migrations"
psql_q -d "$DB" -f "$HERE/_local_auth_stub.sql" >/dev/null
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "    $(basename "$f")"
  psql_q -d "$DB" -f "$f" >/dev/null
done

echo "==> applying migrations a second time (they must be idempotent)"
for f in "$ROOT"/supabase/migrations/*.sql; do
  psql_q -d "$DB" -f "$f" >/dev/null
done

echo "==> ageing + priority"
psql_q -d "$DB" -f "$HERE/ageing_priority_test.sql"

echo "==> row level security"
psql_q -d "$DB" -f "$HERE/rls_test.sql"

echo "==> all SQL tests passed"
