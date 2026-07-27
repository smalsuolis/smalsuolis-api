// Assign each event to a municipality (nullable — an event's geom may fall
// outside every polygon, in which case it is simply omitted from municipality
// stats, matching how byCategory/byTag exclude unmatched events).
exports.up = function (knex) {
  return knex.schema.alterTable('events', (table) => {
    table.integer('municipalityId').unsigned().nullable();
    table.index('municipalityId');
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable('events', (table) => {
    table.dropIndex('municipalityId');
    table.dropColumn('municipalityId');
  });
};
