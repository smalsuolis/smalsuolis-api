exports.up = async (knex) => {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS events_appid_updatedat_deletedat_idx
    ON events (app_id, updated_at, deleted_at)
  `);
};

exports.down = async (knex) => {
  await knex.raw(`DROP INDEX IF EXISTS events_appid_updatedat_deletedat_idx`);
};
