exports.up = function (knex) {
  return knex.schema.alterTable('subscriptions', (table) => {
    table.jsonb('categories');
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable('subscriptions', (table) => {
    table.dropColumn('categories');
  });
};
