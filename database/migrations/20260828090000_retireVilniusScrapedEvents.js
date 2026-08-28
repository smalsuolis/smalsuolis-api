// The Vilnius scraper is gone: the central portal carries the same notices and
// more of them. Measured over 317 paired notices, the titles matched 99%, all
// 277 shared comment deadlines matched exactly, and the portal additionally
// held 57 parcels and three further years of history that the site's news
// category never showed.
//
// Its events have to go with it. They are identified by the article path, so
// every one starts `/naujienos/`, while the portal writes `portal:<slug>:<hash>`.
// The portal re-collects the same notices under its own ids, so leaving these
// in place would show every Vilnius notice twice — once from each source, a day
// apart, since the portal publishes a day after the municipality's own site.
//
// They are soft-deleted rather than removed: `deleted_at` is how this codebase
// retires an event everywhere else, it keeps the rows available if this has to
// be reconsidered, and it leaves foreign keys alone.
//
// Note for the first run after this: the portal's copies are new rows, so the
// handful of notices published within the last 30 days get a fresh created_at
// and can reach subscribers a second time. Everything older is stamped with its
// own publication date by the integration mixin and stays silent.
const APP_KEY = 'savivaldybesZemetvarka';
const SCRAPER_PREFIX = '/naujienos/%';

exports.up = async (knex) => {
  const { rows } = await knex.raw(
    `UPDATE events e
        SET deleted_at = now()
       FROM apps a
      WHERE a.id = e.app_id
        AND a.key = ?
        AND e.external_id LIKE ?
        AND e.deleted_at IS NULL
      RETURNING e.id`,
    [APP_KEY, SCRAPER_PREFIX],
  );
  // eslint-disable-next-line no-console
  console.log(`retired ${rows.length} events scraped from vilnius.lt`);
};

// Restores them, which is only correct while the portal has not yet written its
// own copies — otherwise both sets are present and the duplicates are back.
exports.down = async (knex) => {
  await knex.raw(
    `UPDATE events e
        SET deleted_at = NULL
       FROM apps a
      WHERE a.id = e.app_id
        AND a.key = ?
        AND e.external_id LIKE ?`,
    [APP_KEY, SCRAPER_PREFIX],
  );
};
