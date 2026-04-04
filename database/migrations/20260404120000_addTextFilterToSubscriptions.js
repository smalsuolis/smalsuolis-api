exports.up = function (knex) {
  return knex.schema.table('subscriptions', function (table) {
    table.string('text_filter', 255).nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.table('subscriptions', function (table) {
    table.dropColumn('text_filter');
  });
};
