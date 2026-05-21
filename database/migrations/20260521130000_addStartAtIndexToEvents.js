exports.config = { transaction: false };

exports.up = async (knex) => {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS events_startat_active_idx
    ON events (start_at)
    WHERE deleted_at IS NULL
  `);
};

exports.down = async (knex) => {
  await knex.raw(`DROP INDEX IF EXISTS events_startat_active_idx`);
};
