const { commonFields } = require('./20230420182712_setup');

// Municipality boundary polygons, imported from boundaries.biip.lt. Used to
// derive an event's municipality via a spatial join on events.geom. Geometry is
// stored in EPSG:3346 (LKS94) to match events.geom, so ST_Intersects needs no
// on-the-fly reprojection.
exports.up = async function (knex) {
  await knex.schema.createTable('municipalities', (table) => {
    table.increments('id');
    table.string('code', 64).notNullable();
    table.string('name', 255).notNullable();
    commonFields(table);
    table.unique('code');
  });

  await knex.schema.raw(
    `ALTER TABLE municipalities ADD COLUMN geom geometry(geometry, 3346)`,
  );
  await knex.schema.raw(
    `CREATE INDEX municipalities_geom_idx ON municipalities USING gist (geom)`,
  );
};

exports.down = function (knex) {
  return knex.schema.dropTable('municipalities');
};
