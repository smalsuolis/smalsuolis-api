exports.up = (knex) =>
  knex.schema.alterTable('apps', (table) => {
    table.timestamp('lastRunAt').nullable();
    table.text('lastRunError').nullable();
    table.integer('lastRunDurationMs').nullable();
  });

exports.down = (knex) =>
  knex.schema.alterTable('apps', (table) => {
    table.dropColumn('lastRunAt');
    table.dropColumn('lastRunError');
    table.dropColumn('lastRunDurationMs');
  });
