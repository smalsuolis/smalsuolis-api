const { commonFields } = require('./20230420182712_setup');

exports.up = function (knex) {
  return knex.schema
    .createTable('categories', (table) => {
      table.increments('id');
      table.string('code', 64).notNullable();
      table.string('name', 255).notNullable();
      table.integer('parentId').unsigned().nullable();
      table.string('appType', 64).notNullable();
      table.integer('sort').notNullable().defaultTo(0);
      table.boolean('hidden').notNullable().defaultTo(false);
      commonFields(table);
      table.unique(['appType', 'code']);
      table.index('parentId');
    })
    .alterTable('events', (table) => {
      table.integer('categoryId').unsigned().nullable();
      table.index('categoryId');
    });
};

exports.down = function (knex) {
  return knex.schema
    .alterTable('events', (table) => {
      table.dropIndex('categoryId');
      table.dropColumn('categoryId');
    })
    .dropTable('categories');
};
