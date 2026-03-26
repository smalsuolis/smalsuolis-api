exports.up = function (knex) {
  return knex.schema.raw(
    `CREATE INDEX events_deleted_at_idx ON events (deleted_at) WHERE deleted_at IS NULL`,
  );
};

exports.down = function (knex) {
  return knex.schema.raw(`DROP INDEX IF EXISTS events_deleted_at_idx`);
};
