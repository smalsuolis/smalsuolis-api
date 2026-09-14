// The land-use-change app was seeded for Vilnius alone, as
// `savivaldybesZemetvarka-vilnius`. It now collects the whole country, so the
// key loses its municipality suffix and the name stops naming one city. The
// municipality of an event is already carried by events.municipality_id, which
// is derived from the geometry.
//
// This is an UPDATE of the existing row, not a new row: events.app_id and the
// integer ids inside subscriptions.apps both point at apps.id, so the rename is
// invisible to every event already stored and every live subscription.
//
// The unique index guards apps.key against two rows ever sharing one key —
// seed.run() executes on every broker start and reconciles apps BY KEY,
// calling apps.create for any key it cannot find, so a concurrent or repeated
// seed on an unmigrated row could otherwise duplicate one.
//
// What it does NOT guard, and no in-database constraint can: redeploying an
// image built BEFORE this migration against a database where it has already
// run. That image looks up the OLD key, finds nothing, and creates a row under
// the old key — a different value, so a uniqueness rule on `key` never fires.
// New events would then flow to that fresh id while every existing
// subscription still points at the original one, silently.
//
// OPS NOTE: do not roll back to a pre-rename image once this has run. If it
// happens, the repair is to delete the stray `savivaldybesZemetvarka-vilnius`
// row and re-point its events at the original app id — not to keep both.
const OLD_KEY = 'savivaldybesZemetvarka-vilnius';
const NEW_KEY = 'savivaldybesZemetvarka';

const NEW_NAME = 'Žemės paskirties keitimas';
const NEW_DESCRIPTION =
  'Savivaldybių skelbiami prašymai ir sprendimai dėl žemės sklypo pagrindinės ' +
  'žemės naudojimo paskirties ar naudojimo būdo keitimo';

const OLD_NAME = 'Žemės paskirties keitimas (Vilnius)';
const OLD_DESCRIPTION =
  'Vilniaus miesto savivaldybės skelbiami prašymai keisti žemės sklypo paskirtį (viešo aptarimo etape)';

const INDEX = 'apps_key_unique_idx';

async function assertNoDuplicateKeys(knex) {
  const { rows } = await knex.raw(
    `SELECT key, count(*)::int AS count
       FROM apps
      WHERE deleted_at IS NULL
      GROUP BY key
     HAVING count(*) > 1`,
  );
  if (rows.length) {
    const detail = rows.map((r) => `${r.key} (${r.count})`).join(', ');
    throw new Error(
      `apps already holds duplicate keys: ${detail}. ` +
        'Merge them by hand before applying this migration — picking a winner ' +
        'automatically would silently orphan whichever subscriptions point at the loser.',
    );
  }
}

exports.up = async (knex) => {
  await knex('apps').where({ key: OLD_KEY }).update({
    key: NEW_KEY,
    name: NEW_NAME,
    description: NEW_DESCRIPTION,
  });

  await assertNoDuplicateKeys(knex);
  await knex.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX} ON apps (key) WHERE deleted_at IS NULL`,
  );
};

exports.down = async (knex) => {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX}`);
  await knex('apps').where({ key: NEW_KEY }).update({
    key: OLD_KEY,
    name: OLD_NAME,
    description: OLD_DESCRIPTION,
  });
};
